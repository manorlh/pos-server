/**
 * "מסך מטבח (KDS)" — the full-screen kitchen screen of a KDS device (station / expo / manager), from
 * its host's KDS module (lib/kdsScreenEngine.ts — the Windows shell's, or the browser's at `/kds`)
 * through a RoleScreenBridge. Not a till.
 *
 * RTL, touch-first (no hover-only UI, every target ≥ 52 px): a header with the station(s) / role,
 * the device and shop, the counts, the connection, the actions waiting to be sent and the clock;
 * the orders in the screen's layout (layouts.tsx: tickets / columns / rail / list / big); a new
 * order, a change to see and an order turning late each make their own sound; the Expo's recently
 * handed over orders in a strip for "החזר". Every touch tells the host (the Windows updater waits
 * for a quiet screen); the host's own corner (the Windows technician, the browser's staff sheet)
 * comes in through `onPointerDown` / `overlay`.
 *
 * The look (docs/SPEC_KDS.md §14) is the cloud's (`view.display`, set on the dashboard's KDS page),
 * or the host's `display` (the dashboard's live preview); none = the screen as it always looked.
 */

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { ChefHat, CloudOff, Inbox, Wifi, WifiOff, X } from 'lucide-react';
import type { KdsDisplay, KdsOrder, KdsView } from '@/lib/kdsScreenTypes';
import {
  hasWork,
  newArrivals,
  openItemCount,
  orderTimer,
  orderTitle,
  pendingChanges,
  recallButton,
  roleTitle,
  screenOf,
  screenRole,
  waitingFor,
  type KdsButton,
} from '@/lib/kdsBoard';
import { DEFAULT_KDS_DISPLAY, screenThresholds } from '@/lib/screenLook';
import type { RoleScreenBridge } from '../bridge';
import { BigLayout, ColumnsLayout, ListLayout, RailLayout, TicketsLayout, type LayoutProps } from './layouts';
import { playTone, ReasonSheet, TouchButton, useNow, useSize } from './parts';
import { KdsLookContext, kdsTheme, themeVars } from './theme';

const FRESH_MS = 8_000;
const TAP_GUARD_MS = 700;
/** Any button, right after another: the second tap of a double tap on a card that just moved. */
const ANY_TAP_GUARD_MS = 350;
const FLASH_MS = 450;
const TOAST_MS = 6_000;

const STYLE = `
@keyframes r2mKdsFresh{0%,100%{box-shadow:0 0 0 0 transparent}50%{box-shadow:0 0 0 6px var(--k-accent)}}
.r2m-kds-fresh{animation:r2mKdsFresh 1.2s ease-in-out infinite}
@keyframes r2mKdsLate{0%,100%{opacity:1}50%{opacity:.55}}
.r2m-kds-late{animation:r2mKdsLate 1.6s ease-in-out infinite}
@media (prefers-reduced-motion: reduce){.r2m-kds-fresh,.r2m-kds-late{animation:none}}
`;

const LAYOUTS = { tickets: TicketsLayout, columns: ColumnsLayout, rail: RailLayout, list: ListLayout, big: BigLayout } as const;

/** When a tap happened (a handler's clock, never read while drawing). */
const tapTime = () => Date.now();

const clockText = (ms: number) => new Date(ms).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });

export interface KdsScreenProps {
  bridge: RoleScreenBridge;
  /** The host's names for the device and the shop, until the cloud's board says them. */
  machineName?: string | null;
  shopName?: string | null;
  /** Every touch on the screen (the host's hidden corner). */
  onPointerDown?: (e: ReactPointerEvent<HTMLDivElement>) => void;
  /** Drawn over the screen (the host's technician / staff sheet). */
  overlay?: ReactNode;
  /** Next to the connection in the header (the browser's "הקישו להפעלת צליל"). */
  headerExtra?: ReactNode;
  /** "הדפס" on every card: the host prints it (the browser KDS with the Windows bridge); its answer, a refusal shown. */
  onPrint?: (order: KdsOrder, device: KdsView['device']) => Promise<{ ok: boolean; message?: string }>;
  /** The look, over the cloud's (the dashboard's live preview); null = the screen's own. */
  display?: KdsDisplay | null;
  /** No sound at all (the dashboard's preview). */
  silent?: boolean;
  /** Fill the parent instead of the window (the dashboard's preview). */
  embedded?: boolean;
}

export function KdsScreen({
  bridge,
  machineName = null,
  shopName = null,
  onPointerDown,
  overlay = null,
  headerExtra = null,
  onPrint,
  display: forced = null,
  silent = false,
  embedded = false,
}: KdsScreenProps) {
  const [view, setView] = useState<KdsView | null>(null);
  const [ask, setAsk] = useState<{ button: KdsButton; order: KdsOrder } | null>(null);
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Map<string, number>>(new Map());
  const known = useRef<Set<string> | null>(null);
  const knownChanges = useRef<Set<string> | null>(null);
  const knownLate = useRef<Set<string> | null>(null);
  const lastTap = useRef(new Map<string, number>());
  const lastAnyTap = useRef(0);
  const [bodyEl, setBodyEl] = useState<HTMLElement | null>(null);
  const size = useSize(bodyEl);
  const localNow = useNow(5_000);

  const look = forced ?? view?.display ?? DEFAULT_KDS_DISPLAY;
  const theme = useMemo(() => kdsTheme(look.theme, look.accent), [look.theme, look.accent]);
  const lookCtx = useMemo(() => ({ theme, look }), [theme, look]);
  const sounds = useRef(look.sounds);
  const quiet = useRef(silent);
  useEffect(() => {
    sounds.current = look.sounds;
    quiet.current = silent;
  }, [look.sounds, silent]);

  useEffect(() => {
    let alive = true;
    void bridge.kds().then((v) => alive && v && setView(v));
    const off = bridge.on('kds', setView);
    return () => {
      alive = false;
      off();
    };
  }, [bridge]);

  // A new order (or a new cancellation / note to see) sounds and glows — never the first board.
  useEffect(() => {
    if (!view) return;
    const ids = view.orders.map((o) => o.id);
    const changeIds = view.orders.flatMap((o) => pendingChanges(o).map((c) => c.id));
    const arrived = newArrivals(known.current, view.orders);
    const newChanges = knownChanges.current ? changeIds.filter((id) => !knownChanges.current!.has(id)) : [];
    known.current = new Set(ids);
    knownChanges.current = new Set(changeIds);
    if (arrived.length > 0) {
      const until = Date.now() + FRESH_MS;
      setFresh((m) => new Map([...m, ...arrived.map((id) => [id, until] as const)]));
      if (!quiet.current) playTone(sounds.current.new);
    } else if (newChanges.length > 0 && !quiet.current) playTone(sounds.current.change);
  }, [view]);
  useEffect(() => {
    if (fresh.size === 0) return;
    const t = setTimeout(() => setFresh((m) => new Map([...m].filter(([, until]) => until > Date.now()))), 1_000);
    return () => clearTimeout(t);
  }, [fresh, localNow]);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), TOAST_MS);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (!flashKey) return;
    const t = setTimeout(() => setFlashKey(null), FLASH_MS);
    return () => clearTimeout(t);
  }, [flashKey]);

  const role = screenRole(view?.device);
  const nowMs = localNow + (view?.serverOffsetMs ?? 0);
  const { cards, recent } = useMemo(() => screenOf(view?.orders ?? [], role, nowMs), [view, role, nowMs]);
  const settings = useMemo(() => view?.stationSettings ?? {}, [view]);
  const lateIds = useMemo(() => {
    const timerLook = { thresholds: screenThresholds(look), ageColors: look.ageColors };
    return cards.filter((o) => orderTimer(o, settings, nowMs, timerLook).level === 'late').map((o) => o.id);
  }, [cards, settings, nowMs, look]);

  // An order turning late sounds once (the screen's "late" sound; off by default).
  useEffect(() => {
    const before = knownLate.current;
    knownLate.current = new Set(lateIds);
    if (before && !quiet.current && lateIds.some((id) => !before.has(id))) playTone(sounds.current.late);
  }, [lateIds]);

  const printCard = onPrint
    ? (o: KdsOrder) => {
        void onPrint(o, view?.device ?? null)
          .then((r) => setToast(r.ok ? null : (r.message ?? 'ההדפסה נכשלה')))
          .catch(() => setToast('ההדפסה נכשלה'));
      }
    : undefined;

  const send = (b: KdsButton, reason?: string) => {
    for (const a of b.actions) {
      void bridge
        .kdsAction(reason ? { ...a, reason } : a)
        .then((r) => {
          // A refusal from the cloud shows as the view's lastError; a local one (no reason…) here.
          if (!r.ok && r.message) setToast(r.message);
        })
        .catch(() => setToast('הפעולה לא נשלחה'));
    }
  };

  const press = (b: KdsButton, order: KdsOrder) => {
    const t = tapTime();
    const id = `${b.key}|${b.label}`;
    // A double tap is one tap (the button may already show its opposite: "מוכן" → "בטל מוכן", or
    // the bumped card moved and another one is under the finger now).
    if (t - lastAnyTap.current < ANY_TAP_GUARD_MS || t - (lastTap.current.get(b.key) ?? 0) < TAP_GUARD_MS) return;
    lastAnyTap.current = t;
    lastTap.current.set(b.key, t);
    setFlashKey(id);
    if (b.reason) setAsk({ button: b, order });
    else send(b);
  };

  const error = toast ?? (view?.lastError && view.lastError !== dismissed ? view.lastError : null);
  const updated = view?.updatedAt ? clockText(view.updatedAt) : null;
  const noData = !view || (view.updatedAt === null && view.orders.length === 0 && !view.device);
  const items = openItemCount(cards);
  // A station counts the orders it still works on; the Expo every order it still has to release.
  const orderCount = role === 'station' ? cards.filter(hasWork).length : cards.length;
  const scale = look.fontScale > 0 ? look.fontScale : 1;
  const Layout = LAYOUTS[look.layout] ?? TicketsLayout;
  const layoutProps: LayoutProps = {
    cards,
    role,
    settings,
    nowMs,
    offline: !!view?.offline,
    fresh: new Set(fresh.keys()),
    flashKey,
    onPress: press,
    onPrint: printCard,
    stations: view?.device?.stations ?? [],
    width: size.width / scale,
    height: size.height / scale,
  };

  return (
    <KdsLookContext.Provider value={lookCtx}>
      <div
        dir="rtl"
        style={themeVars(theme)}
        className={`relative flex ${embedded ? 'h-full' : 'h-dvh'} w-full select-none flex-col overflow-hidden bg-[var(--k-bg)] text-[var(--k-text)]`}
        onPointerDown={(e) => {
          bridge.activity();
          onPointerDown?.(e);
        }}
      >
        <style>{STYLE}</style>
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--k-line)] bg-[var(--k-panel)] px-5 py-3">
          <ChefHat className="shrink-0 text-[var(--k-accent)]" size={34} />
          <div className="min-w-0">
            <div className="truncate text-[26px] font-black leading-tight">{roleTitle(view?.device)}</div>
            <div className="truncate text-base text-[var(--k-muted)]">{[view?.device?.name ?? machineName, view?.shopName ?? shopName].filter(Boolean).join(' · ')}</div>
          </div>
          <div className="flex-1" />
          {look.counts && !noData && !view?.notConfigured ? (
            <>
              <div className="rounded-lg bg-[var(--k-chip)] px-3 py-1.5 text-lg font-bold tabular-nums">
                {orderCount} הזמנות · {items} פריטים פתוחים
              </div>
              {look.ageColors && lateIds.length > 0 ? (
                <div className="rounded-lg bg-[var(--k-late)] px-3 py-1.5 text-lg font-extrabold tabular-nums text-white">{lateIds.length} באיחור</div>
              ) : null}
            </>
          ) : null}
          {view?.offline ? (
            <div className="flex items-center gap-2 rounded-lg bg-[#dc2626] px-3 py-1.5 text-lg font-bold text-white">
              <WifiOff size={20} /> אין חיבור{updated ? ` · מוצג המידע האחרון (${updated})` : ''}
            </div>
          ) : view ? (
            <div className="flex items-center gap-2 rounded-lg bg-[var(--k-chip)] px-3 py-1.5 text-lg font-bold text-[var(--k-ready)]">
              <Wifi size={20} /> מחובר
            </div>
          ) : null}
          {view && view.pendingActions > 0 ? (
            <div className="flex items-center gap-2 rounded-lg bg-[var(--k-warn)] px-3 py-1.5 text-lg font-extrabold text-black">
              <CloudOff size={20} /> {view.pendingActions === 1 ? 'פעולה אחת ממתינה לשליחה' : `${view.pendingActions} פעולות ממתינות לשליחה`}
            </div>
          ) : null}
          {headerExtra}
          {look.clock ? <div className="text-[32px] font-black tabular-nums leading-none">{clockText(nowMs)}</div> : null}
        </header>

        {error ? (
          <button
            type="button"
            className="flex w-full items-center gap-3 bg-[#dc2626] px-5 py-3 text-start text-xl font-bold text-white"
            onClick={() => {
              setToast(null);
              setDismissed(view?.lastError ?? null);
            }}
          >
            <span className="flex-1">{error}</span>
            <X size={24} />
          </button>
        ) : null}

        {view?.notConfigured ? (
          <Centered title="המסך עוד לא הוגדר כמסך מטבח" body="בדשבורד: הוספת מכשיר מסוג &quot;מסך מטבח&quot; בסניף, או בעמוד מסכי המטבח — שיוך המכשיר לתחנה / Expo." />
        ) : noData ? (
          view?.offline ? (
            <Centered title="אין חיבור · אין עדיין נתונים" body="המסך יציג את ההזמנות ברגע שהחיבור לענן יחזור." />
          ) : (
            <div className="flex flex-1 items-center justify-center gap-3 text-2xl font-bold text-[var(--k-muted)]">
              <span className="h-8 w-8 animate-spin rounded-full border-4 border-[var(--k-line)] border-t-[var(--k-accent)]" />
              מתחבר לענן…
            </div>
          )
        ) : (
          <div ref={setBodyEl} className="relative min-h-0 flex-1 overflow-hidden">
            {cards.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-[var(--k-faint)]">
                <Inbox size={72} strokeWidth={1.4} />
                <div className="text-[32px] font-black text-[var(--k-muted)]">אין הזמנות פתוחות</div>
                <div className="text-xl">הזמנות חדשות יופיעו כאן מעצמן</div>
              </div>
            ) : size.width > 0 ? (
              <div
                className="absolute right-0 top-0"
                style={
                  scale === 1
                    ? { width: '100%', height: '100%' }
                    : { width: size.width / scale, height: size.height / scale, transform: `scale(${scale})`, transformOrigin: 'top right' }
                }
              >
                <Layout {...layoutProps} />
              </div>
            ) : null}
          </div>
        )}

        {role !== 'station' && recent.length > 0 && !view?.notConfigured ? (
          <footer className="flex items-center gap-3 overflow-x-auto border-t border-[var(--k-line)] bg-[var(--k-panel)] px-4 py-2">
            <span className="shrink-0 text-lg font-bold text-[var(--k-muted)]">נמסרו לאחרונה:</span>
            {recent.map((o) => {
              const b = recallButton(o);
              return (
                <div key={o.id} className="flex shrink-0 items-center gap-2 rounded-lg bg-[var(--k-chip)] py-1 pe-1 ps-3">
                  <bdi className="text-xl font-black">{orderTitle(o)}</bdi>
                  {b ? <TouchButton button={b} onPress={(x) => press(x, o)} flashing={flashKey === `${b.key}|${b.label}`} className="min-h-[48px] px-4 text-base" /> : null}
                </div>
              );
            })}
          </footer>
        ) : null}

        {ask ? (
          <ReasonSheet
            kind={ask.button.reason ?? 'override'}
            title={
              ask.button.reason === 'priority'
                ? `${ask.button.label} — ${orderTitle(ask.order)}`
                : `מוכן לאיסוף לפני שכל התחנות סיימו — ${orderTitle(ask.order)}`
            }
            subtitle={ask.button.reason === 'override' ? `ממתין ל: ${waitingFor(ask.order).join(', ') || '—'}` : null}
            onCancel={() => setAsk(null)}
            onConfirm={(reason) => {
              send(ask.button, reason);
              setAsk(null);
            }}
          />
        ) : null}
        {overlay}
      </div>
    </KdsLookContext.Provider>
  );
}

function Centered({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="text-[34px] font-black">{title}</div>
      <div className="max-w-2xl text-xl text-[var(--k-muted)]">{body}</div>
    </div>
  );
}
