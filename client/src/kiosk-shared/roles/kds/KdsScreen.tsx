/**
 * "מסך מטבח (KDS)" — the full-screen kitchen screen of a KDS device (station / expo / manager), from
 * its host's KDS module (lib/kdsScreenEngine.ts — the Windows shell's, or the browser's at `/kds`)
 * through a RoleScreenBridge. Not a till.
 *
 * Dark, RTL, touch-first (no hover-only UI, every target ≥ 52 px): a header with the station(s) /
 * role, the device and shop, the counts, the connection, the actions waiting to be sent and the
 * clock; the cards in columns that fill the screen (5 on a landscape 1920 × 1080, 3 on a portrait
 * one), oldest top-right, urgent first; a new order chimes and glows; the Expo's recently handed
 * over orders in a strip for "החזר". Every touch tells the host (the Windows updater waits for a
 * quiet screen); the host's own corner (the Windows technician, the browser's staff sheet) comes in
 * through `onPointerDown` / `overlay`.
 */

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { ChefHat, ChevronDown, CloudOff, Inbox, Wifi, WifiOff, X } from 'lucide-react';
import type { KdsOrder, KdsView } from '@/lib/kdsScreenTypes';
import {
  cardWeight,
  columnsFor,
  hasWork,
  layoutColumns,
  newArrivals,
  openItemCount,
  orderTitle,
  pendingChanges,
  recallButton,
  roleTitle,
  screenOf,
  screenRole,
  waitingFor,
  type KdsButton,
} from '@/lib/kdsBoard';
import type { RoleScreenBridge } from '../bridge';
import { KdsCard } from './KdsCard';
import { chime, ReasonSheet, TouchButton, useNow, useWidth } from './parts';

const FRESH_MS = 8_000;
const TAP_GUARD_MS = 700;
/** Any button, right after another: the second tap of a double tap on a card that just moved. */
const ANY_TAP_GUARD_MS = 350;
const FLASH_MS = 450;
const TOAST_MS = 6_000;

const STYLE = `
@keyframes r2mKdsFresh{0%,100%{box-shadow:0 0 0 0 rgba(56,189,248,0)}50%{box-shadow:0 0 0 6px rgba(56,189,248,.65)}}
.r2m-kds-fresh{animation:r2mKdsFresh 1.2s ease-in-out infinite}
@keyframes r2mKdsLate{0%,100%{opacity:1}50%{opacity:.55}}
.r2m-kds-late{animation:r2mKdsLate 1.6s ease-in-out infinite}
@media (prefers-reduced-motion: reduce){.r2m-kds-fresh,.r2m-kds-late{animation:none}}
`;

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
}

export function KdsScreen({ bridge, machineName = null, shopName = null, onPointerDown, overlay = null, headerExtra = null, onPrint }: KdsScreenProps) {
  const [view, setView] = useState<KdsView | null>(null);
  const [ask, setAsk] = useState<{ button: KdsButton; order: KdsOrder } | null>(null);
  const [flashKey, setFlashKey] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [fresh, setFresh] = useState<Map<string, number>>(new Map());
  const [moreBelow, setMoreBelow] = useState(false);
  const known = useRef<Set<string> | null>(null);
  const knownChanges = useRef<Set<string> | null>(null);
  const lastTap = useRef(new Map<string, number>());
  const lastAnyTap = useRef(0);
  const [mainEl, setMainEl] = useState<HTMLElement | null>(null);
  const width = useWidth(mainEl);
  const localNow = useNow(5_000);

  useEffect(() => {
    let alive = true;
    void bridge.kds().then((v) => alive && v && setView(v));
    const off = bridge.on('kds', setView);
    return () => {
      alive = false;
      off();
    };
  }, [bridge]);

  // A new order (or a new cancellation / note to see) chimes and glows — never the first board.
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
      chime('new');
    } else if (newChanges.length > 0) chime('change');
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
  const columns = useMemo(() => layoutColumns(cards, columnsFor(width), cardWeight), [cards, width]);

  // Whether cards are hidden below the fold (the hint at the bottom).
  useEffect(() => {
    const el = mainEl;
    if (!el) return;
    const check = () => setMoreBelow(el.scrollTop + el.clientHeight < el.scrollHeight - 8);
    check();
    el.addEventListener('scroll', check, { passive: true });
    return () => el.removeEventListener('scroll', check);
  }, [mainEl, columns]);

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

  return (
    <div
      dir="rtl"
      className="relative flex h-dvh w-full select-none flex-col overflow-hidden bg-[#0d1016] text-white"
      onPointerDown={(e) => {
        bridge.activity();
        onPointerDown?.(e);
      }}
    >
      <style>{STYLE}</style>
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-white/10 bg-[#12161d] px-5 py-3">
        <ChefHat className="shrink-0 text-amber-300" size={34} />
        <div className="min-w-0">
          <div className="truncate text-[26px] font-black leading-tight">{roleTitle(view?.device)}</div>
          <div className="truncate text-base text-white/60">{[view?.device?.name ?? machineName, view?.shopName ?? shopName].filter(Boolean).join(' · ')}</div>
        </div>
        <div className="flex-1" />
        {!noData && !view?.notConfigured ? (
          <div className="rounded-xl bg-white/[0.07] px-3 py-1.5 text-lg font-bold tabular-nums">
            {orderCount} הזמנות · {items} פריטים פתוחים
          </div>
        ) : null}
        {view?.offline ? (
          <div className="flex items-center gap-2 rounded-xl bg-red-600/90 px-3 py-1.5 text-lg font-bold">
            <WifiOff size={20} /> אין חיבור{updated ? ` · מוצג המידע האחרון (${updated})` : ''}
          </div>
        ) : view ? (
          <div className="flex items-center gap-2 rounded-xl bg-emerald-600/25 px-3 py-1.5 text-lg font-bold text-emerald-200">
            <Wifi size={20} /> מחובר
          </div>
        ) : null}
        {view && view.pendingActions > 0 ? (
          <div className="flex items-center gap-2 rounded-xl bg-amber-400 px-3 py-1.5 text-lg font-extrabold text-black">
            <CloudOff size={20} /> {view.pendingActions === 1 ? 'פעולה אחת ממתינה לשליחה' : `${view.pendingActions} פעולות ממתינות לשליחה`}
          </div>
        ) : null}
        {headerExtra}
        <div className="text-[32px] font-black tabular-nums leading-none">{clockText(nowMs)}</div>
      </header>

      {error ? (
        <button
          type="button"
          className="flex w-full items-center gap-3 bg-red-600 px-5 py-3 text-start text-xl font-bold"
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
          <div className="flex flex-1 items-center justify-center gap-3 text-2xl font-bold text-white/60">
            <span className="h-8 w-8 animate-spin rounded-full border-4 border-white/20 border-t-sky-400" />
            מתחבר לענן…
          </div>
        )
      ) : (
        <div className="relative min-h-0 flex-1">
          <main ref={setMainEl} className="h-full touch-pan-y overflow-y-auto overscroll-contain p-3">
            {cards.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-white/50">
                <Inbox size={72} strokeWidth={1.4} />
                <div className="text-[32px] font-black text-white/70">אין הזמנות פתוחות</div>
                <div className="text-xl">הזמנות חדשות יופיעו כאן מעצמן</div>
              </div>
            ) : (
              <div className="flex items-start gap-3">
                {columns.map((col, i) => (
                  <div key={i} className="flex min-w-0 flex-1 flex-col gap-3">
                    {col.map((o) => (
                      <KdsCard
                        key={o.id}
                        order={o}
                        role={role}
                        settings={view?.stationSettings ?? {}}
                        nowMs={nowMs}
                        offline={!!view?.offline}
                        fresh={fresh.has(o.id)}
                        flashKey={flashKey}
                        onPress={press}
                        onPrint={printCard}
                      />
                    ))}
                  </div>
                ))}
              </div>
            )}
          </main>
          {moreBelow ? (
            <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center bg-gradient-to-t from-[#0d1016] to-transparent pb-2 pt-10">
              <span className="flex items-center gap-1 rounded-full bg-white/15 px-4 py-1 text-lg font-bold">
                <ChevronDown size={20} /> עוד הזמנות למטה
              </span>
            </div>
          ) : null}
        </div>
      )}

      {role !== 'station' && recent.length > 0 && !view?.notConfigured ? (
        <footer className="flex items-center gap-3 overflow-x-auto border-t border-white/10 bg-[#12161d] px-4 py-2">
          <span className="shrink-0 text-lg font-bold text-white/60">נמסרו לאחרונה:</span>
          {recent.map((o) => {
            const b = recallButton(o);
            return (
              <div key={o.id} className="flex shrink-0 items-center gap-2 rounded-xl bg-white/[0.07] py-1 pe-1 ps-3">
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
  );
}

function Centered({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <div className="text-[34px] font-black">{title}</div>
      <div className="max-w-2xl text-xl text-white/60">{body}</div>
    </div>
  );
}
