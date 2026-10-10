'use client';

/**
 * "מסך לקוח" in a browser (`/display`, P:/specs/customer-display.md §2, §4): the till's sale as the
 * customer sees it — the basket with its add-ons, discounts, promotions and vouchers, the total,
 * the tip, the payment's progress, the change, "תודה" — and, between sales, the shop's logo and
 * then its slideshow. Right to left in Hebrew, left to right in English; laid out for any screen
 * by its own size (side by side when wide, one column otherwise).
 *
 * `?demo=1`: a pretend till walking through a sale, never the network.
 */

import { useEffect, useMemo, useState } from 'react';
import { describeBrowser, webDeviceInfo, type FetchFn } from '@/lib/kioskWebApi';
import { openKioskStore, type StorageLike } from '@/lib/kioskWebStore';
import {
  IDLE_STATE,
  SCREEN_TEXT,
  money,
  phaseHeadline,
  screenLang,
  type CdConfig,
  type CdState,
  type PlaylistItem,
} from '@/lib/customerDisplay';
import { CustomerDisplayWebService, type DisplayWebView } from '@/lib/customerDisplayWeb';
import { WebPairing, type PairingTexts } from '@/components/kiosk-web/web-pairing';
import { isStandalone, useFullscreenOnTap, useKioskGuards, useWakeLock } from '@/components/kiosk-web/web-shell';

export const WEB_DISPLAY_VERSION = '1.0.0';

const PAIRING: PairingTexts = {
  title: 'צימוד מסך לקוח בדפדפן',
  hint: 'הזינו את קוד הצימוד מהדשבורד: מכשירים ← הוספת מכשיר ← מסך לקוח, בפלטפורמה דפדפן.',
  namePrefix: 'מסך לקוח',
  after: 'אחרי הצימוד: פתחו במסך מלא (נגיעה אחת). בחרו בדשבורד, בעמוד "מסך לקוח", איזו קופה המסך משקף.',
};

function safe<T>(get: () => T): T | null {
  try {
    return get();
  } catch {
    return null;
  }
}

/** A pretend till: idle → basket → tip → card → thanks, every few seconds. */
function demoStates(): CdState[] {
  const lines = [
    { id: '1', name: 'המבורגר קלאסי', qty: 1, unit: null, total: 5400, modifiers: ['+ גבינה', 'בלי בצל'], discount: 0, promo: null, refund: false },
    { id: '2', name: 'צ׳יפס', qty: 2, unit: null, total: 3000, modifiers: [], discount: 1500, promo: '1+1 על צ׳יפס', refund: false },
    { id: '3', name: 'לימונדה', qty: 1, unit: null, total: 1500, modifiers: ['גדול'], discount: 0, promo: null, refund: false },
  ];
  const basket: CdState = { ...IDLE_STATE, seq: 1, phase: 'basket', lines, promotions: [{ name: '1+1 על צ׳יפס', amount: 1500 }], vouchers: [{ name: 'שובר #12 — קיץ', amount: 1000 }], discount: 2500, total: 7400, itemCount: 4 };
  return [
    IDLE_STATE,
    basket,
    { ...basket, seq: 2, phase: 'tip', tip: { presets: [10, 12, 15], selectedPercent: 12, amount: 890 } },
    { ...basket, seq: 3, phase: 'paying', payment: { method: 'card', status: 'waiting_card', due: 8290, paid: 0 } },
    { ...basket, seq: 4, phase: 'thanks', thanks: { total: 8290, change: 0, tip: 890, receiptUrl: null } },
  ];
}

const DEMO_CONFIG: CdConfig = {
  enabled: true, layout: 'auto', theme: 'dark',
  show: { items: true, prices: true, modifiers: true, promotions: true, vouchers: true, totals: true, tip: true, payment: true, change: true, thanks: true },
  playlist: [], logoUrl: '', language: 'auto', idleTimeoutSec: 0, thanksSec: 6, welcomeText: '', thanksText: '',
};

export function DisplayWeb({ apiUrl }: { apiUrl: string }) {
  const [svc, setSvc] = useState<CustomerDisplayWebService | null>(null);
  const [view, setView] = useState<DisplayWebView | null>(null);
  const [demo, setDemo] = useState<number | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

  useKioskGuards();
  const live = demo !== null || view?.phase === 'ready';
  useWakeLock(live);
  useFullscreenOnTap(live);

  useEffect(() => {
    let gone = false;
    let made: CustomerDisplayWebService | null = null;
    const q = new URLSearchParams(window.location.search);
    if (q.get('demo') === '1') {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDemo(0);
      const t = setInterval(() => setDemo((d) => ((d ?? 0) + 1) % demoStates().length), 4_000);
      return () => clearInterval(t);
    }
    (async () => {
      const store = await openKioskStore(
        { indexedDB: safe(() => window.indexedDB), localStorage: safe(() => window.localStorage as StorageLike) },
        { dbName: 'r2m-display', mirrored: ['r2m.display.credentials'] },
      );
      const fetchFn: FetchFn = (input, init) => fetch(input, init);
      made = new CustomerDisplayWebService({
        store,
        fetchFn,
        defaultServer: apiUrl,
        appVersion: `web-display-${WEB_DISPLAY_VERSION}`,
        deviceInfo: () => ({
          ...webDeviceInfo(
            {
              userAgent: navigator.userAgent,
              platform: (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform,
              language: navigator.language,
              screen: { width: window.screen.width, height: window.screen.height, dpr: window.devicePixelRatio || 1 },
              standalone: isStandalone(),
              touch: navigator.maxTouchPoints ?? 0,
            },
            WEB_DISPLAY_VERSION,
          ),
          client: 'r2m-web-display',
          browser: describeBrowser(navigator.userAgent).browser,
        }),
        log: (msg) => console.info(`[display] ${msg}`),
      });
      made.onView((v) => {
        if (!gone) setView(v);
      });
      const v = await made.init();
      if (gone) {
        made.stop();
        return;
      }
      setSvc(made);
      setView(v);
    })().catch((e) => setFailed(e instanceof Error ? e.message : String(e)));
    return () => {
      gone = true;
      made?.stop();
    };
  }, [apiUrl]);

  if (failed) return <Splash title="המסך לא נפתח" body={failed} />;
  if (demo !== null) {
    return <CustomerScreen config={DEMO_CONFIG} brandName="R2M — הדגמה" logoUrl="" state={demoStates()[demo]} online />;
  }
  if (!svc || !view || view.phase === 'loading') return <Splash title="טוען…" />;
  if (view.phase === 'unpaired') {
    return <WebPairing defaultServer={apiUrl} texts={PAIRING} onPair={async (input) => svc.pair(input)} />;
  }
  if (view.wrongRole) return <Splash title="קוד של מכשיר אחר" body={view.wrongRole} />;
  return (
    <CustomerScreen
      config={view.config}
      brandName={view.branding.shopName}
      logoUrl={view.branding.logoUrl}
      primaryColor={view.branding.primaryColor}
      state={view.state}
      online={view.online}
      tillMissing={!view.tillName}
    />
  );
}

function themeOf(config: CdConfig, primary?: string | null) {
  if (config.theme === 'light') return { bg: '#f7f7f8', fg: '#111318', muted: '#6b7280', card: '#ffffff', accent: primary || '#0ea5e9' };
  if (config.theme === 'brand' && primary) return { bg: primary, fg: '#ffffff', muted: 'rgba(255,255,255,.75)', card: 'rgba(0,0,0,.18)', accent: '#ffffff' };
  return { bg: '#0d1016', fg: '#ffffff', muted: 'rgba(255,255,255,.6)', card: 'rgba(255,255,255,.06)', accent: primary || '#38bdf8' };
}

/** The idle slideshow: each slide its own duration, videos muted and played through. */
function Slideshow({ items }: { items: PlaylistItem[] }) {
  const [i, setI] = useState(0);
  const item = items[i % Math.max(items.length, 1)];
  useEffect(() => {
    if (!item) return;
    const t = setTimeout(() => setI((n) => (n + 1) % items.length), item.durationSec * 1000);
    return () => clearTimeout(t);
  }, [item, items.length]);
  if (!item) return null;
  return item.kind === 'video' ? (
    <video key={item.url} src={item.url} autoPlay muted playsInline className="h-full w-full object-contain" onError={() => setI((n) => n + 1)} />
  ) : (
    // eslint-disable-next-line @next/next/no-img-element
    <img key={item.url} src={item.url} alt="" className="h-full w-full object-contain" />
  );
}

export function CustomerScreen({
  config,
  brandName,
  logoUrl,
  primaryColor = null,
  state,
  online,
  tillMissing = false,
}: {
  config: CdConfig;
  brandName: string;
  logoUrl: string;
  primaryColor?: string | null;
  state: CdState;
  online: boolean;
  tillMissing?: boolean;
}) {
  const lang = screenLang(config.language, typeof navigator === 'undefined' ? 'he' : navigator.language);
  const t = SCREEN_TEXT[lang];
  const dir = lang === 'he' ? 'rtl' : 'ltr';
  const c = themeOf(config, primaryColor);
  const show = config.show;
  const [idleLong, setIdleLong] = useState(false);
  const idle = state.phase === 'idle';
  useEffect(() => {
    if (!idle) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setIdleLong(false);
      return;
    }
    const t2 = setTimeout(() => setIdleLong(true), Math.max(0, config.idleTimeoutSec) * 1000);
    return () => clearTimeout(t2);
  }, [idle, config.idleTimeoutSec]);
  const headline = useMemo(() => phaseHeadline(state, lang), [state, lang]);

  const wrap = (body: React.ReactNode) => (
    <div dir={dir} className="relative flex h-dvh w-full flex-col overflow-hidden" style={{ background: c.bg, color: c.fg }}>
      {body}
      {!online || tillMissing ? (
        <div className="absolute bottom-2 start-2 rounded-full px-3 py-1 text-xs" style={{ background: c.card, color: c.muted }}>
          {t.notConnected}
        </div>
      ) : null}
    </div>
  );

  if (idle) {
    if (idleLong && config.playlist.length) return wrap(<Slideshow items={config.playlist} />);
    return wrap(
      <div className="flex flex-1 flex-col items-center justify-center gap-6 p-8 text-center">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt="" className="max-h-[30vh] max-w-[60vw] object-contain" />
        ) : null}
        <div className="text-[5vmin] font-extrabold">{config.welcomeText || t.welcome}</div>
        {brandName ? <div className="text-[3vmin]" style={{ color: c.muted }}>{brandName}</div> : null}
      </div>,
    );
  }

  if (state.phase === 'thanks' && show.thanks) {
    return wrap(
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
        <div className="text-[8vmin] font-extrabold">{config.thanksText || t.thanks}</div>
        {show.totals && state.thanks ? <div className="text-[4vmin]">{t.total}: {money(state.thanks.total)}</div> : null}
        {show.change && state.thanks && state.thanks.change > 0 ? (
          <div className="text-[5vmin] font-bold" style={{ color: c.accent }}>{t.change}: {money(state.thanks.change)}</div>
        ) : null}
        {brandName ? <div className="text-[2.5vmin]" style={{ color: c.muted }}>{brandName}</div> : null}
      </div>,
    );
  }

  const panel = (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-[2vmin]">
      <div className="flex items-center justify-between gap-3">
        {logoUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={logoUrl} alt="" className="h-[6vmin] object-contain" />
        ) : (
          <span className="text-[3vmin] font-bold">{brandName}</span>
        )}
        <span className="text-[2.2vmin]" style={{ color: c.muted }}>{state.itemCount} {t.items}</span>
      </div>
      {show.items ? (
        <div className="min-h-0 flex-1 space-y-1 overflow-hidden">
          {state.lines.slice(-12).map((l) => (
            <div key={l.id} className="rounded-xl px-3 py-2" style={{ background: c.card }}>
              <div className="flex items-baseline justify-between gap-3 text-[2.8vmin] font-semibold">
                <span className="min-w-0 truncate">
                  {l.qty !== 1 ? `${l.qty}${l.unit ? ` ${l.unit}` : ''} × ` : ''}
                  {l.name}
                </span>
                {show.prices ? <span dir="ltr">{money(l.refund ? -l.total : l.total)}</span> : null}
              </div>
              {show.modifiers && l.modifiers.length ? <div className="text-[2vmin]" style={{ color: c.muted }}>{l.modifiers.join(' · ')}</div> : null}
              {show.promotions && l.promo ? <div className="text-[2vmin]" style={{ color: c.accent }}>{l.promo}</div> : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="flex-1" />
      )}
      {show.promotions && state.promotions.length ? (
        <div className="space-y-0.5 text-[2.2vmin]">
          {state.promotions.map((p, i) => (
            <div key={i} className="flex justify-between" style={{ color: c.accent }}>
              <span>{p.name}</span>
              <span dir="ltr">{money(-p.amount)}</span>
            </div>
          ))}
        </div>
      ) : null}
      {show.vouchers && state.vouchers.length ? (
        <div className="space-y-0.5 text-[2.2vmin]">
          {state.vouchers.map((p, i) => (
            <div key={i} className="flex justify-between">
              <span>{p.name}</span>
              <span dir="ltr">{money(-p.amount)}</span>
            </div>
          ))}
        </div>
      ) : null}
      {show.totals ? (
        <div className="flex items-baseline justify-between border-t pt-2 text-[5vmin] font-extrabold" style={{ borderColor: c.muted }}>
          <span>{t.total}</span>
          <span dir="ltr">{money(state.total)}</span>
        </div>
      ) : null}
    </div>
  );

  const side = (() => {
    if (state.phase === 'tip' && show.tip && state.tip) {
      return (
        <div className="flex flex-col items-center gap-4">
          <div className="text-[4vmin] font-bold">{headline}</div>
          <div className="flex flex-wrap justify-center gap-3">
            {state.tip.presets.map((p) => (
              <div
                key={p}
                className="rounded-2xl px-6 py-4 text-[4vmin] font-extrabold"
                style={{ background: state.tip?.selectedPercent === p ? c.accent : c.card, color: state.tip?.selectedPercent === p ? c.bg : c.fg }}
              >
                {p}%
              </div>
            ))}
          </div>
          {state.tip.amount ? <div className="text-[3vmin]">{t.tip}: {money(state.tip.amount)}</div> : null}
        </div>
      );
    }
    if (state.phase === 'paying' && show.payment && state.payment) {
      return (
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="text-[4.5vmin] font-extrabold">{headline}</div>
          <div className="text-[3.5vmin]">{t.due}: <span dir="ltr">{money(state.payment.due)}</span></div>
        </div>
      );
    }
    if (state.phase === 'change' && show.change && state.cash) {
      return (
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="text-[3.5vmin]">{t.tendered}: <span dir="ltr">{money(state.cash.tendered)}</span></div>
          <div className="text-[6vmin] font-extrabold" style={{ color: c.accent }}>{t.change}: <span dir="ltr">{money(state.cash.change)}</span></div>
        </div>
      );
    }
    if (config.playlist.length) return <Slideshow items={config.playlist} />;
    return logoUrl ? (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={logoUrl} alt="" className="max-h-[40vh] max-w-full object-contain" />
    ) : null;
  })();

  const wide = config.layout !== 'full' && (config.layout === 'split' || (typeof window !== 'undefined' && window.innerWidth >= 900 && window.innerWidth > window.innerHeight));
  if (config.layout === 'full' || !side) {
    return wrap(
      <>
        {panel}
        {state.phase !== 'basket' && side ? <div className="flex items-center justify-center p-4">{side}</div> : null}
      </>,
    );
  }
  return wrap(
    <div className={`flex min-h-0 flex-1 ${wide ? 'flex-row' : 'flex-col'}`}>
      <div className={`flex min-h-0 ${wide ? 'w-[55%]' : 'flex-1'} flex-col`}>{panel}</div>
      <div className={`flex min-h-0 ${wide ? 'w-[45%]' : 'h-[38%]'} items-center justify-center p-4`}>{side}</div>
    </div>,
  );
}

function Splash({ title, body }: { title: string; body?: string }) {
  return (
    <div dir="rtl" className="flex h-dvh w-full flex-col items-center justify-center gap-3 bg-[#0d1016] p-8 text-center text-white">
      <h1 className="text-xl font-extrabold">{title}</h1>
      {body ? <p className="max-w-md text-sm text-white/60">{body}</p> : null}
      <p className="text-[10px] tracking-[0.12em] text-white/40">Powered by R2M</p>
    </div>
  );
}
