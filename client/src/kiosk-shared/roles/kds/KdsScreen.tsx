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
 *
 * What the kitchen learned from a reference KDS (§16, tools.tsx), all in this look: a toolbar under
 * the header ("להכנה", "מוכנות", list / tickets, zoom, "היסטוריה", "השהה", "מרוכז"), the "להכנה"
 * panel with its search and filter by item, the ticket's menu (a tap on its header), a tap on an item
 * (`itemTap`), FIFO / LIFO, tickets per row, the most height of a ticket, the order-type filters,
 * keep a finished ticket or not, overflow to the list. The local choices (zoom, list, the panel,
 * compact) stay on the device; with the toolbar off the screen is exactly the dashboard's.
 */

import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import {
  ChefHat,
  ClipboardCheck,
  ClipboardList,
  CloudOff,
  History,
  Inbox,
  LayoutGrid,
  List,
  Maximize2,
  Minimize2,
  Pause,
  Play,
  Wifi,
  WifiOff,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { KdsDisplay, KdsLayout, KdsOrder, KdsTask, KdsView } from '@/lib/kdsScreenTypes';
import {
  hasWork,
  newArrivals,
  openItemCount,
  orderTimer,
  orderTitle,
  pendingChanges,
  recallButton,
  recallFor,
  roleTitle,
  screenOf,
  screenRole,
  ticketMenu,
  waitingFor,
  type KdsButton,
} from '@/lib/kdsBoard';
import {
  allDayCounts,
  cardsWithItem,
  historyAfter,
  historyRows,
  isReadyCard,
  overflowing,
  passesFilters,
  pausedView,
  sameItem,
  searchItems,
  splitDone,
  type HistoryEntry,
} from '@/lib/kdsLayouts';
import { DEFAULT_KDS_DISPLAY, screenThresholds } from '@/lib/screenLook';
import type { RoleScreenBridge } from '../bridge';
import { BigLayout, ColumnsLayout, ListLayout, RailLayout, TicketsLayout, type LayoutProps } from './layouts';
import { playTone, ReasonSheet, TouchButton, useNow, useSize } from './parts';
import { KdsLookContext, kdsTheme, themeVars } from './theme';
import { AllDayPanel, HistorySheet, TicketMenuSheet, ToolButton } from './tools';

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

/* ------------------------------------------------- the device's own choices */

/** What this device remembers of its toolbar (§16): never the cloud's, never shared. */
interface LocalPrefs {
  /** The zoom (0.6–2); null = the dashboard's text size. */
  zoom: number | null;
  /** List / tickets; null = the dashboard's layout. */
  view: 'list' | 'tickets' | null;
  /** The "להכנה" panel; null = as the dashboard opens it. */
  allDay: boolean | null;
  compact: boolean;
}

const LOCAL_KEY = 'r2m.kds.local';
const NO_PREFS: LocalPrefs = { zoom: null, view: null, allDay: null, compact: false };
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 2;
const ZOOM_STEP = 0.1;

function readPrefs(): LocalPrefs {
  try {
    if (typeof window === 'undefined') return NO_PREFS;
    const raw = JSON.parse(window.localStorage.getItem(LOCAL_KEY) ?? 'null') as Partial<LocalPrefs> | null;
    if (!raw || typeof raw !== 'object') return NO_PREFS;
    const zoom = typeof raw.zoom === 'number' && Number.isFinite(raw.zoom) ? Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, raw.zoom)) : null;
    return {
      zoom,
      view: raw.view === 'list' || raw.view === 'tickets' ? raw.view : null,
      allDay: typeof raw.allDay === 'boolean' ? raw.allDay : null,
      compact: raw.compact === true,
    };
  } catch {
    return NO_PREFS;
  }
}

function writePrefs(p: LocalPrefs) {
  try {
    window.localStorage.setItem(LOCAL_KEY, JSON.stringify(p));
  } catch {
    // Storage blocked (a private window): the choice lasts until the page reloads.
  }
}

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
  /** Fill the parent instead of the window (the dashboard's preview; nothing remembered on the device). */
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
  // §16: the toolbar's choices (kept on the device) and this session's (pause, filters, sheets).
  const [prefs, setPrefs] = useState<LocalPrefs>(() => (embedded ? NO_PREFS : readPrefs()));
  const [readyOnly, setReadyOnly] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pausedIds, setPausedIds] = useState<ReadonlySet<string> | null>(null);
  const [itemFilter, setItemFilter] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [history, setHistory] = useState<Map<string, HistoryEntry>>(new Map());

  const look = forced ?? view?.display ?? DEFAULT_KDS_DISPLAY;
  const theme = useMemo(() => kdsTheme(look.theme, look.accent), [look.theme, look.accent]);
  const lookCtx = useMemo(() => ({ theme, look }), [theme, look]);
  const sounds = useRef(look.sounds);
  const quiet = useRef(silent);
  const pausedRef = useRef(false);
  useEffect(() => {
    sounds.current = look.sounds;
    quiet.current = silent;
    pausedRef.current = pausedIds !== null;
  }, [look.sounds, silent, pausedIds]);
  useEffect(() => {
    if (!embedded) writePrefs(prefs);
  }, [prefs, embedded]);

  // The history (§16) follows the boards as they arrive: what finished here, kept half an hour.
  const forcedRef = useRef<KdsDisplay | null>(forced);
  useEffect(() => {
    forcedRef.current = forced;
  }, [forced]);
  useEffect(() => {
    let alive = true;
    const onView = (v: KdsView) => {
      setView(v);
      const shown = forcedRef.current ?? v.display ?? DEFAULT_KDS_DISPLAY;
      setHistory((h) => historyAfter(h, v.orders, screenRole(v.device), shown, Date.now() + (v.serverOffsetMs ?? 0)));
    };
    void bridge.kds().then((v) => alive && v && onView(v));
    const off = bridge.on('kds', onView);
    return () => {
      alive = false;
      off();
    };
  }, [bridge]);

  // The orders this screen shows at all (its order-type filters, §16; all of them by default).
  const shownOrders = useMemo(() => (view?.orders ?? []).filter((o) => passesFilters(o, look)), [view, look]);

  // A new order (or a new cancellation / note to see) sounds and glows — never the first board; a
  // paused screen neither shows nor sounds the new ones.
  useEffect(() => {
    if (!view) return;
    const ids = shownOrders.map((o) => o.id);
    const changeIds = shownOrders.flatMap((o) => pendingChanges(o).map((c) => c.id));
    const arrived = newArrivals(known.current, shownOrders);
    const newChanges = knownChanges.current ? changeIds.filter((id) => !knownChanges.current!.has(id)) : [];
    known.current = new Set(ids);
    knownChanges.current = new Set(changeIds);
    if (arrived.length > 0 && !pausedRef.current) {
      const until = Date.now() + FRESH_MS;
      setFresh((m) => new Map([...m, ...arrived.map((id) => [id, until] as const)]));
      if (!quiet.current) playTone(sounds.current.new);
    } else if (newChanges.length > 0 && !quiet.current) playTone(sounds.current.change);
  }, [view, shownOrders]);
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
  const lifo = look.ticketOrder === 'lifo';
  const { cards: screenCards, recent } = useMemo(() => screenOf(shownOrders, role, nowMs, { lifo }), [shownOrders, role, nowMs, lifo]);
  // "בון נשאר פתוח אחרי שכל המנות מוכנות" off: a finished card goes to the history at once.
  const { cards: kept } = useMemo(() => splitDone(screenCards, role, look.keepReadyOpen), [screenCards, role, look.keepReadyOpen]);
  const { cards: live, waiting: pausedWaiting } = useMemo(() => pausedView(kept, pausedIds), [kept, pausedIds]);
  const allDay = useMemo(() => allDayCounts(live), [live]);
  const filterActive = itemFilter !== null;
  const cards = useMemo(() => {
    const byItem = itemFilter ? cardsWithItem(live, itemFilter) : live;
    return readyOnly ? byItem.filter((o) => isReadyCard(o, role)) : byItem;
  }, [live, itemFilter, readyOnly, role]);
  const readyCount = useMemo(() => live.filter((o) => isReadyCard(o, role)).length, [live, role]);
  const settings = useMemo(() => view?.stationSettings ?? {}, [view]);
  const lateIds = useMemo(() => {
    const timerLook = { thresholds: screenThresholds(look), ageColors: look.ageColors };
    return live.filter((o) => orderTimer(o, settings, nowMs, timerLook).level === 'late').map((o) => o.id);
  }, [live, settings, nowMs, look]);

  const onScreen = useMemo(() => new Set(live.map((o) => o.id)), [live]);
  const historyList = useMemo(() => historyRows(history, onScreen), [history, onScreen]);

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

  // The toolbar (§16). Off: the screen is exactly the dashboard's (no local zoom, list or panel).
  const tools = look.toolbar;
  const compact = tools && prefs.compact;
  const panelOpen = !compact && (tools ? (prefs.allDay ?? look.allDay) : look.allDay);
  const setPref = (patch: Partial<LocalPrefs>) => setPrefs((p) => ({ ...p, ...patch }));
  const baseScale = look.fontScale > 0 ? look.fontScale : 1;
  const scale = tools && prefs.zoom !== null ? prefs.zoom : baseScale;
  const zoomBy = (d: number) => setPref({ zoom: Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, scale + d)) * 10) / 10 });
  const overflow = overflowing(live.length, look.overflowAt);
  const chosen: KdsLayout = tools && prefs.view ? (prefs.view === 'list' ? 'list' : look.layout === 'list' ? 'tickets' : look.layout) : look.layout;
  const layoutName: KdsLayout = overflow ? 'list' : chosen;
  const toggleView = () => {
    const next = layoutName === 'list' ? 'tickets' : 'list';
    // Back to the dashboard's layout is "no choice".
    setPref({ view: (next === 'list' ? look.layout === 'list' : look.layout !== 'list') ? null : next });
  };
  const togglePause = () => setPausedIds((p) => (p ? null : new Set(kept.map((o) => o.id))));
  const taskFilter = itemFilter && !look.filterFullTicket ? (t: KdsTask) => sameItem(t.name, itemFilter) : undefined;
  const menuOrder = menuFor ? (view?.orders.find((o) => o.id === menuFor) ?? null) : null;

  const error = toast ?? (view?.lastError && view.lastError !== dismissed ? view.lastError : null);
  const updated = view?.updatedAt ? clockText(view.updatedAt) : null;
  const noData = !view || (view.updatedAt === null && view.orders.length === 0 && !view.device);
  const items = openItemCount(live);
  // A station counts the orders it still works on; the Expo every order it still has to release.
  const orderCount = role === 'station' ? live.filter(hasWork).length : live.length;
  const Layout = LAYOUTS[layoutName] ?? TicketsLayout;
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
    perRow: look.perRow,
    maxTicketHeight: look.maxTicketHeight,
    lifo,
    taskFilter,
    onMenu: (o) => setMenuFor(o.id),
  };
  const ready = !noData && !view?.notConfigured;

  const connection = view?.offline ? (
    <div className="flex items-center gap-2 rounded-lg bg-[#dc2626] px-3 py-1.5 text-lg font-bold text-white">
      <WifiOff size={20} /> אין חיבור{updated ? ` · מוצג המידע האחרון (${updated})` : ''}
    </div>
  ) : view ? (
    <div className="flex items-center gap-2 rounded-lg bg-[var(--k-chip)] px-3 py-1.5 text-lg font-bold text-[var(--k-ready)]">
      <Wifi size={20} /> {compact ? null : 'מחובר'}
    </div>
  ) : null;
  const pendingChip =
    view && view.pendingActions > 0 ? (
      <div className="flex items-center gap-2 rounded-lg bg-[var(--k-warn)] px-3 py-1.5 text-lg font-extrabold text-black">
        <CloudOff size={20} /> {view.pendingActions === 1 ? 'פעולה אחת ממתינה לשליחה' : `${view.pendingActions} פעולות ממתינות לשליחה`}
      </div>
    ) : null;

  const toolbar =
    tools && ready ? (
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--k-line)] bg-[var(--k-panel)] px-3 py-2">
        {compact ? <div className="me-1 truncate text-xl font-black">{roleTitle(view?.device)}</div> : null}
        <ToolButton icon={<ClipboardList size={22} />} label="להכנה" active={panelOpen} onClick={() => setPref({ allDay: !panelOpen, compact: false })} />
        <ToolButton icon={<ClipboardCheck size={22} />} label="מוכנות" active={readyOnly} badge={readyCount} onClick={() => setReadyOnly((v) => !v)} />
        <ToolButton
          icon={layoutName === 'list' ? <LayoutGrid size={22} /> : <List size={22} />}
          label={layoutName === 'list' ? 'כרטיסים' : 'רשימה'}
          disabled={overflow}
          onClick={toggleView}
        />
        <div className="flex items-center gap-1 rounded-xl bg-[var(--k-quiet)] p-0.5">
          <button type="button" aria-label="הקטנה" onClick={() => zoomBy(-ZOOM_STEP)} disabled={scale <= ZOOM_MIN + 1e-6} className="flex h-[52px] w-[48px] touch-manipulation items-center justify-center rounded-lg text-[var(--k-on-quiet)] active:scale-[0.94] disabled:opacity-40">
            <ZoomOut size={22} />
          </button>
          <button type="button" aria-label="גודל הדשבורד" onClick={() => setPref({ zoom: null })} className="h-[52px] min-w-[60px] touch-manipulation rounded-lg text-base font-black tabular-nums text-[var(--k-on-quiet)]">
            {Math.round(scale * 100)}%
          </button>
          <button type="button" aria-label="הגדלה" onClick={() => zoomBy(ZOOM_STEP)} disabled={scale >= ZOOM_MAX - 1e-6} className="flex h-[52px] w-[48px] touch-manipulation items-center justify-center rounded-lg text-[var(--k-on-quiet)] active:scale-[0.94] disabled:opacity-40">
            <ZoomIn size={22} />
          </button>
        </div>
        <ToolButton icon={<History size={22} />} label="היסטוריה" badge={historyList.length || null} onClick={() => setHistoryOpen(true)} />
        <ToolButton icon={pausedIds ? <Play size={22} /> : <Pause size={22} />} label={pausedIds ? 'המשך' : 'השהה'} active={!!pausedIds} onClick={togglePause} />
        <ToolButton icon={compact ? <Maximize2 size={22} /> : <Minimize2 size={22} />} label={compact ? 'מורחב' : 'מרוכז'} active={compact} onClick={() => setPref({ compact: !compact })} />
        <div className="flex-1" />
        {itemFilter ? (
          <button type="button" onClick={() => setItemFilter(null)} className="flex min-h-[48px] items-center gap-2 rounded-lg bg-[var(--k-accent-soft)] px-3 text-lg font-extrabold text-[var(--k-accent-text)]">
            מסונן: <bdi>{itemFilter}</bdi> <X size={20} />
          </button>
        ) : null}
        {overflow ? <div className="rounded-lg bg-[var(--k-warn)] px-3 py-1.5 text-lg font-extrabold text-black">מצב עומס · {live.length} הזמנות</div> : null}
        {pausedIds ? (
          <div className="r2m-kds-late rounded-lg bg-[var(--k-warn)] px-3 py-1.5 text-lg font-extrabold text-black">
            מושהה{pausedWaiting > 0 ? ` · ${pausedWaiting === 1 ? 'הזמנה חדשה ממתינה' : `${pausedWaiting} חדשות ממתינות`}` : ''}
          </div>
        ) : null}
        {compact ? (
          <>
            {connection}
            {pendingChip}
            {headerExtra}
            {look.clock ? <div className="text-[28px] font-black tabular-nums leading-none">{clockText(nowMs)}</div> : null}
          </>
        ) : null}
      </div>
    ) : null;

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
        {compact && ready ? null : (
          <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-[var(--k-line)] bg-[var(--k-panel)] px-5 py-3">
            <ChefHat className="shrink-0 text-[var(--k-accent)]" size={34} />
            <div className="min-w-0">
              <div className="truncate text-[26px] font-black leading-tight">{roleTitle(view?.device)}</div>
              <div className="truncate text-base text-[var(--k-muted)]">{[view?.device?.name ?? machineName, view?.shopName ?? shopName, view?.device?.scopeLabel].filter(Boolean).join(' · ')}</div>
            </div>
            <div className="flex-1" />
            {look.counts && ready ? (
              <>
                <div className="rounded-lg bg-[var(--k-chip)] px-3 py-1.5 text-lg font-bold tabular-nums">
                  {orderCount} הזמנות · {items} פריטים פתוחים
                </div>
                {look.ageColors && lateIds.length > 0 ? (
                  <div className="rounded-lg bg-[var(--k-late)] px-3 py-1.5 text-lg font-extrabold tabular-nums text-white">{lateIds.length} באיחור</div>
                ) : null}
              </>
            ) : null}
            {connection}
            {pendingChip}
            {headerExtra}
            {look.clock ? <div className="text-[32px] font-black tabular-nums leading-none">{clockText(nowMs)}</div> : null}
          </header>
        )}
        {toolbar}

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
          <div className="flex min-h-0 flex-1">
            {panelOpen ? <AllDayPanel items={searchItems(allDay, search)} search={search} onSearch={setSearch} selected={itemFilter} onSelect={setItemFilter} /> : null}
            <div ref={setBodyEl} className="relative min-h-0 min-w-0 flex-1 overflow-hidden">
              {cards.length === 0 ? (
                live.length > 0 && (filterActive || readyOnly) ? (
                  <div className="flex h-full flex-col items-center justify-center gap-4 text-center text-[var(--k-faint)]">
                    <div className="text-[30px] font-black text-[var(--k-muted)]">{readyOnly ? 'אין הזמנות מוכנות' : 'אין הזמנות עם הפריט הזה'}</div>
                    <button
                      type="button"
                      onClick={() => {
                        setItemFilter(null);
                        setReadyOnly(false);
                      }}
                      className="min-h-[56px] rounded-xl bg-[var(--k-quiet)] px-6 text-xl font-bold text-[var(--k-on-quiet)]"
                    >
                      הצגת כל ההזמנות
                    </button>
                  </div>
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-3 text-center text-[var(--k-faint)]">
                    <Inbox size={72} strokeWidth={1.4} />
                    <div className="text-[32px] font-black text-[var(--k-muted)]">אין הזמנות פתוחות</div>
                    <div className="text-xl">{pausedWaiting > 0 ? 'המסך מושהה — "המשך" מציג את ההזמנות החדשות' : 'הזמנות חדשות יופיעו כאן מעצמן'}</div>
                  </div>
                )
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

        {menuOrder ? (
          <TicketMenuSheet
            order={menuOrder}
            buttons={ticketMenu(menuOrder, role, { stationRush: look.stationRush, urgencyLevels: look.urgencyLevels })}
            onPick={(b) => {
              setMenuFor(null);
              press(b, menuOrder);
            }}
            onClose={() => setMenuFor(null)}
          />
        ) : null}
        {historyOpen ? (
          <HistorySheet
            rows={historyList}
            recallOf={(o) => recallFor(o, role)}
            onRecall={(b, o) => {
              setHistoryOpen(false);
              press(b, o);
            }}
            onClose={() => setHistoryOpen(false)}
          />
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
