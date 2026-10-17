/**
 * The till role of the one app bundle (S0-2; P:/specs/web-till-spec-v2.md §6.7, §6.10, §13):
 * sell, cart, checkout and shift against whatever engine the host links to — the mock in demo
 * mode today. The screens show what the engine says and send ops; they never number a document,
 * never decide a fiscal rule, never touch hardware.
 *
 *  - the layout comes from the display profile (§6.10), live on resize / rotation;
 *  - every screen says "מצב הדגמה" when the engine is the demo;
 *  - the capability tiles are greyed with their reasons (§2.5);
 *  - at rest / busy goes to the host (no update mid-sale, §2.6, §8.2);
 *  - light for Chromium 108 and a Celeron (§13.3, §13.4): plain CSS, hex colours, no blur, no
 *    backdrop-filter, a virtualised grid, and "lite" (`data-lite`) turns transitions off;
 *  - "ניהול הקיוסק" (staff/adminHold.tsx — the Android KioskAdminCorner): two seconds held in the top-right corner asks
 *    the Windows shell for its manager's menu (a manager's code, the work mode, the technician, status, reprints, the
 *    desktop) — never during a payment; a host without that menu (a browser) leaves the corner unarmed;
 *  - the bar is the Android till's (ui/nav/BottomBar.kt, in its order from the right): "תפריט" — the ☰ drawer of
 *    parts/TillMenuDrawer.tsx, its rows core/till/tillMenu.ts's (P:/specs/windows-till-menu-parity.md) — and "הזמנה מהירה";
 *    a menu screen lights neither, and leaving it goes back to the till.
 */

// The phase-2 screens' own styles (plain CSS, as till.css).
import './css/catalogAdmin.css';
import './css/shopZ.css';
import './css/attendance.css';
import './css/readyOrders.css';
import './css/alerts.css';
import './css/voucherBalance.css';
import './css/voucherStation.css';
import './css/cloudZ.css';
import './css/printers.css';
import './css/screenEdit.css';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { tillBusy, type OpArgs, type BasketDiscountMode, type DeviceRoleName, type DocumentDetail, type LocalReportKind, type ReportPreset, type TillState, type XReport } from '../../../shared/till/protocol';
import { capabilityTiles, NO_CAPS } from '../../host/caps';
import type { HostCaps, TillHost } from '../../host/TillHost';
import type { DisplayProfile } from './layout/displayProfileAdapter';
import { tillLayout } from './layout/tillLayout';
import { AdminHoldBar, useAdminCornerHold } from '../../staff/adminHold';
import { TechnicianCorner, tillTechnicianArmed } from '../../../core/technician';
import { useDisplayProfile } from './layout/useDisplayProfile';
import { CapabilityTiles } from './parts/CapabilityTiles';
import { EngineDialog } from './parts/EngineDialog';
import { BasketDiscountSheet, CardTipsChoiceSheet, PresetForSheet, HeldSheet, NoticeDialog, OrderDetailsSheet, OthSheet, ReceiptPicker, RefundChooser, type DiscountPreview, type ReceiptFind, type ReceiptRow } from './parts/TillSheets';
import { ORDER_TEXT } from '../../../core/till/orderDetails';
import { FAILOVER_TEXT } from '../../../core/kitchen/failover';
import { CheckoutScreen } from './screens/CheckoutScreen';
import { DrawerScreen, type DrawerLog, type DrawerSheet, type WalletRow } from './screens/DrawerScreen';
import { HistoryScreen, type HistoryRow } from './screens/HistoryScreen';
import { LockScreen } from './screens/LockScreen';
import { LocalReportScreen } from './screens/LocalReportScreen';
import { KiosksScreen } from './screens/KiosksScreen';
import { MenuActionSheet, TillMenuDrawer } from './parts/TillMenuDrawer';
import { MENU_TEXT, buildTillMenu, folderOpenAtStart, type MenuTarget, type TillMenuFacts } from '../../../core/till/tillMenu';
import { SellScreen } from './screens/SellScreen';
import type { QuickButton } from './parts/CartPane';
import { ChoicesSheet, type ChoicesTarget } from './parts/ChoicesSheet';
import { CatalogAdminScreen } from './screens/CatalogAdminScreen';
import { ShopZScreen } from './screens/ShopZScreen';
import { AttendanceClockButton, AttendanceScreen } from './screens/AttendanceScreen';
import { ReadyOrdersScreen, type ReadyOrdersActions } from './screens/ReadyOrdersScreen';
import { AlertsLine, AlertsScreen } from './screens/AlertsScreen';
import { VoucherBalanceScreen } from './screens/VoucherBalanceScreen';
import { VoucherStationScreen } from './screens/VoucherStationScreen';
import { CloudZScreen } from './screens/CloudZScreen';
import { PrintersScreen } from './screens/PrintersScreen';
import { KioskOrdersSheet, KioskOrdersStrip } from './screens/KioskOrdersScreen';
import { useAlertSound } from './parts/alertSound';
import { opensSheet } from '../../../core/till/choices';
import { ShiftScreen, type CloseResult } from './screens/ShiftScreen';
import { ShopXScreen } from './screens/ShopXScreen';
import { UsersScreen } from './screens/UsersScreen';
import { OwedScreen } from './screens/OwedScreen';
import { TransmissionScreen } from './screens/TransmissionScreen';
import { BlockSheet, BlocksScreen, type BlocksActions } from './screens/BlocksScreen';
import { PrintQueueScreen, type PrintQueueActions, type QueueRow } from './screens/PrintQueueScreen';
import type { BlockSheetView, BlocksListView } from '../../../core/till/itemBlocks';
import { T } from './text';
import { useTillEngine } from './useTillEngine';
import { tillThemeVars, useSystemDark } from './theme/tillTheme';
import { designFor, tillDesignProfileOf } from '../../../core/till/tillDesign';

/** At rest: nothing in the cart / payment / dialog, and no touch for this long (§8.2). */
export const AT_REST_AFTER_MS = 60_000;

type View =
  | 'sell'
  | 'shift'
  | 'history'
  | 'recent'
  | 'report'
  | 'caps'
  | 'shopx'
  | 'drawer'
  | 'users'
  | 'owed'
  | 'transmission'
  | 'blocks'
  | 'printQueue'
  | 'kiosks'
  // Phase 2 (P:/specs/windows-till-menu-parity.md §7).
  | 'catalogAdmin'
  | 'shopZ'
  | 'readyOrders'
  | 'voucherBalance'
  | 'cloudZ'
  | 'printers'
  | 'alerts';

/** The menu's report rows and the local report each is. */
const REPORT_OF: Partial<Record<MenuTarget, LocalReportKind>> = { shiftHistory: 'shifts', tillZHistory: 'tillZs', productSales: 'products', workers: 'workers', tips: 'tips' };

/** The cash menu's actions (Android `cashActions`, in its order) and the drawer's sheet each opens. */
const CASH_ACTIONS: Array<{ id: 'cashIn' | 'cashOut' | 'deposit' | 'count' | 'walletDeposit' | 'log'; label: string; sheet: DrawerSheet }> = [
  { id: 'cashIn', label: 'הכנסת מזומן', sheet: 'CASH_IN' },
  { id: 'cashOut', label: 'הוצאת מזומן', sheet: 'CASH_OUT' },
  { id: 'deposit', label: 'הפקדה / ריקון חלקי', sheet: 'DEPOSIT' },
  { id: 'count', label: 'ספירת מגירה', sheet: 'count' },
  { id: 'walletDeposit', label: 'הפקדת מזומן מעובד', sheet: 'wallets' },
  { id: 'log', label: 'לוג פתיחות מגירה', sheet: 'log' },
];

/** The sell screen's sheets: the basket discount, OTH (from a line), the receipt picker, the held sales (at a close too). */
type Sheet =
  | { kind: 'discount' }
  | { kind: 'presetFor'; presetId: string; fromDiscount: boolean }
  | { kind: 'oth'; lineId: string | null }
  | { kind: 'receipt' }
  | { kind: 'held' }
  | { kind: 'heldClose'; retry: (keepHeld: boolean) => void }
  | { kind: 'cardTipsChoice'; title: string; body: string; partial: string; negative: string; retry: (choice: 'partial' | 'negative') => void }
  | { kind: 'block'; productId: string };

export function TillApp({ host, initialProfile }: { host: TillHost; initialProfile?: DisplayProfile }) {
  const engine = useTillEngine(host.engine);
  const profile = useDisplayProfile(initialProfile);
  const layout = useMemo(() => tillLayout(profile), [profile]);
  const [caps, setCaps] = useState<HostCaps>(NO_CAPS);
  const [view, setView] = useState<View>('sell');
  const [sheet, setSheet] = useState<Sheet | null>(null);
  /** "תפריט": the drawer is open; the menu row whose screen is on show; "מזומן במגירה"'s action sheet. */
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuAt, setMenuAt] = useState<MenuTarget | null>(null);
  const [cashSheet, setCashSheet] = useState(false);
  const [drawerAt, setDrawerAt] = useState<DrawerSheet>('menu');
  const [reportKind, setReportKind] = useState<LocalReportKind>('products');
  /** "מזומן עם עודף" from the quick bar: the payment opens on its cash pad. */
  const [padFirst, setPadFirst] = useState(false);
  /** "הדבורה"'s home on screen: no island over it (Android FlowShell). */
  const [flowHomeShown, setFlowHomeShown] = useState(false);
  /** "תוספות / ארוחה / הערות": the sheet open for a product tapped, or for a cart line ("עריכת המנה"). */
  const [choices, setChoices] = useState<ChoicesTarget | null>(null);
  /** "הזמנות קיוסק ממתינות לתשלום": the list over the till. */
  const [kioskList, setKioskList] = useState(false);
  const { state, catalog, status, toasts, run, attempt, say } = engine;
  // "התראות": the notice's sound, once per new one (core/till/tillAlerts.ts).
  useAlertSound(state?.alerts?.beep ?? null);

  useEffect(() => {
    let alive = true;
    void host.capabilities().then((c) => alive && setCaps(c));
    return () => {
      alive = false;
    };
  }, [host]);

  const demoTerminal = host.demo && state?.health.terminal !== 'none' && state !== null;
  const tiles = useMemo(() => capabilityTiles(caps, host.kind, { demo: host.demo, demoTerminal }), [caps, host.kind, host.demo, demoTerminal]);
  // A real engine knows whether it has a terminal that answers: its health, not the host's guess.
  const cardTile = useMemo(() => {
    const t = tiles.find((x) => x.id === 'card') ?? tiles[0];
    if (host.demo || !state) return t;
    const ok = state.health.terminal !== 'none';
    return { ...t, available: ok, reason: ok ? 'מסופון זמין' : 'אין אמצעי תשלום זמינים – פנו למנהל' };
  }, [tiles, host.demo, state]);

  // The menu closes when nobody is signed in any more, or a payment starts (it is never open over one); Esc closes it.
  const menuMayStay = !!state?.session.cashier && !state.session.locked && state.checkout.phase === 'idle';
  useEffect(() => {
    if (!menuMayStay) {
      setMenuOpen(false);
      setCashSheet(false);
    }
  }, [menuMayStay]);
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  // Ready once the till is drawn; the screen stays awake while the till is open.
  const readySent = useRef(false);
  useEffect(() => {
    if (!state || readySent.current) return;
    readySent.current = true;
    host.bundle.reportReady();
    host.ui.keepAwake(true);
  }, [host, state]);

  // At rest / busy, for the update (never mid-sale) and the role switch.
  const lastTouch = useRef(Date.now());
  const lastReport = useRef('');
  const busy = state ? tillBusy(state) : true;
  const report = useCallback(() => {
    const idle = !busy && Date.now() - lastTouch.current >= AT_REST_AFTER_MS;
    const key = `${idle}:${busy}`;
    if (key === lastReport.current) return;
    lastReport.current = key;
    host.bundle.reportIdle(idle, busy);
  }, [host, busy]);
  useEffect(() => {
    report();
    const t = window.setInterval(report, 5_000);
    return () => window.clearInterval(t);
  }, [report]);
  const lastPing = useRef(0);
  const touch = () => {
    lastTouch.current = Date.now();
    if (lastReport.current.startsWith('true')) report();
    // A touch is the engine's too (the idle return to the kiosk counts from it): at most every 2 s.
    if (!host.demo && lastTouch.current - lastPing.current > 2_000) {
      lastPing.current = lastTouch.current;
      void host.engine.call('session.activity', {}).catch(() => undefined);
    }
  };

  const loadHistory = useCallback(async () => (await run('doc.history', {})) as HistoryRow[] | undefined, [run]);
  /** "24 השעות האחרונות" (Android RecentDocumentsScreen): the documents of the last day, each opening as in the history. */
  const loadRecent = useCallback(async () => (await run('doc.history', { hours: 24 })) as HistoryRow[] | undefined, [run]);
  const loadDetail = useCallback(
    async (documentId: string, quantities?: Record<string, number>) => (await run('doc.detail', quantities ? { documentId, quantities } : { documentId })) as DocumentDetail | undefined,
    [run],
  );
  const previewDiscount = useCallback(
    async (mode: BasketDiscountMode, input: string) => {
      const r = await attempt('discount.preview', { mode, input });
      return r.ok ? (r.value as DiscountPreview) : undefined;
    },
    [attempt],
  );
  // "חסומים כעת" / "חסום / אזל": the engine's views and ops (a manager's code is its dialog; then the sheet closes).
  const blocksActions = useMemo<BlocksActions>(
    () => ({
      list: async () => (await run('blocks.list', {})) as BlocksListView | undefined,
      sheet: async (item) => (await run('blocks.sheet', item)) as BlockSheetView | undefined,
      block: async (request) => {
        const r = await attempt('blocks.block', request as OpArgs['blocks.block']);
        if (!r.ok) say(r.message, 'error');
        return r.ok;
      },
      release: async (ids) => {
        const r = await attempt('blocks.release', { ids });
        if (!r.ok) say(r.message, 'error');
        return r.ok;
      },
    }),
    [run, attempt, say],
  );
  const printQueueActions = useMemo<PrintQueueActions>(
    () => ({
      list: async () => (await run('printQueue.list', {})) as { rows: QueueRow[]; view: { redirects: Array<{ fromId: string; text: string }> } | null } | undefined,
      choices: async (jobId) => (await run('printQueue.choices', { jobId })) as Array<{ id: string; label: string }> | undefined,
      retry: (jobId) => run('printQueue.retry', { jobId }),
      move: (jobId, toId) => run('printQueue.move', { jobId, toId }),
      handled: (jobId) => run('printQueue.handled', { jobId }),
      endRedirect: (fromId) => run('printQueue.endRedirect', { fromId }),
      back: () => setView('sell'),
    }),
    [run],
  );
  const refreshKiosks = useCallback(() => void run('kiosks.refresh', {}), [run]);
  // "הזמנות להכנה": memoised — its screen polls with them every 5 s.
  const readyActions = useMemo<ReadyOrdersActions>(
    () => ({
      refresh: () => void run('ready.refresh', {}),
      tap: (orderId, action) => void run('ready.tap', { orderId, action }),
      retry: (orderId) => void run('ready.retry', { orderId }),
      discard: (orderId) => void run('ready.discard', { orderId }),
      dismiss: () => void run('ready.dismiss', {}),
    }),
    [run],
  );
  /** An op whose refusal is said (the module's words). */
  const act = useCallback((op: Parameters<typeof attempt>[0], args: Record<string, unknown> = {}) => void attempt(op, args).then((r) => !r.ok && say(r.message, 'error')), [attempt, say]);
  const askReport = useCallback(
    (kind: LocalReportKind, preset: ReportPreset) =>
      void attempt('report.local', { kind, preset }).then((r) => {
        if (r.ok) return;
        say(r.message, 'error');
        setView('sell');
      }),
    [attempt, say],
  );
  const recentReceipts = useCallback(async () => (await run('refund.recent', {})) as ReceiptRow[] | undefined, [run]);
  const findReceipt = useCallback(async (query: string) => (await run('refund.find', { query })) as ReceiptFind | undefined, [run]);
  const pickReceipt = useCallback(async (transactionId: string) => (await run('refund.pick', { transactionId })) as ReceiptFind | undefined, [run]);

  /**
   * A close (the shift's, the Z) that may be held by the held sales ("יש N מכירות מושהות", core/till/heldSales.ts): the
   * list opens — pay or cancel each — and, where the shop allows it, "סגור והשאר מושהות" closes over them.
   */
  const closing = useCallback(
    async <R,>(op: 'shift.close' | 'z.produce', args: { countedCashAgorot?: number }): Promise<R | undefined> => {
      const r = op === 'shift.close' ? await attempt('shift.close', { countedCashAgorot: args.countedCashAgorot ?? 0 }) : await attempt('z.produce', args);
      if (r.ok) return r.value as R;
      // "כשאין מספיק מזומן לטיפים באשראי" = ask (x-z-cash-with-tips §2): the manager chooses, the close goes again.
      if (r.code === 'card_tips_choice') {
        const d = (r.details ?? {}) as Record<string, unknown>;
        setSheet({
          kind: 'cardTipsChoice',
          title: r.message,
          body: String(d.body ?? ''),
          partial: String(d.partial ?? ''),
          negative: String(d.negative ?? ''),
          retry: (cardTipsChoice) => {
            setSheet(null);
            const again = op === 'shift.close' ? attempt('shift.close', { countedCashAgorot: args.countedCashAgorot ?? 0, cardTipsChoice }) : attempt('z.produce', { ...args, cardTipsChoice });
            void again.then((x) => {
              if (!x.ok) say(x.message, 'error');
              else setView('shift');
            });
          },
        });
        return undefined;
      }
      if (r.code === 'held_sales') {
        setView('sell');
        setSheet({
          kind: 'heldClose',
          retry: (keepHeld) => {
            setSheet(null);
            const again = op === 'shift.close' ? attempt('shift.close', { countedCashAgorot: args.countedCashAgorot ?? 0, keepHeld }) : attempt('z.produce', { ...args, keepHeld });
            void again.then((x) => {
              if (!x.ok) say(x.message, 'error');
              else setView('shift');
            });
          },
        });
        return undefined;
      }
      say(r.message, 'error');
      return undefined;
    },
    [attempt, say],
  );

  // "ניהול הקיוסק": the shell's manager's menu from the till's corner — never while paying, never over a dialog.
  const adminHold = useAdminCornerHold({
    rtl: true,
    armed: () => !!host.ui.openAdmin && !!state && state.checkout.phase !== 'tender' && state.checkout.phase !== 'card_waiting' && state.dialog === null,
    onOpen: () => host.ui.openAdmin?.(),
  });

  // "בדיקות ומידע": six taps in the top-left corner within 3 s → the shell's technician's code and screen — on every till
  // screen, the PIN screen too (no employee's or manager's code needed to unpair or fix the display), never while paying.
  // Watched in the capture phase without taking the taps: what is drawn in the corner still gets them.
  const techCorner = useRef(new TechnicianCorner());
  const onTechTap = (e: React.PointerEvent) => {
    if (!host.ui.openTechnician) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (techCorner.current.tap(e.clientX - rect.left, e.clientY - rect.top, Date.now(), tillTechnicianArmed(state?.checkout.phase ?? null))) host.ui.openTechnician();
  };

  // "עיצוב קופה" for this window's profile (Android ProvideTillDesign: the profile follows the window), and the colours
  // the Android till paints (theme/tillTheme.ts): the design's accent and mode over the brand and "ערכת צבע".
  const systemDark = useSystemDark();
  const design = state?.design ? designFor(state.design, tillDesignProfileOf(profile.widthDp, profile.heightDp)) : null;
  const night = design?.drawn === 'night';
  const themeVars = useMemo(() => tillThemeVars(state?.theme, systemDark, night), [state?.theme, systemDark, night]);
  const root = (children: ReactNode) => (
    <div
      className="t-root"
      dir="rtl"
      lang="he"
      data-lite={host.device.lite ? '1' : '0'}
      data-layout={layout.cls}
      data-template={design?.drawn ?? 'clean'}
      data-shell={design?.shell ?? 'classic'}
      data-dark={themeVars.colorScheme === 'dark' ? '1' : '0'}
      style={{ ...themeVars, ...(profile.scale !== 1 ? { zoom: profile.scale, '--t-zoom': String(profile.scale) } : {}) } as CSSProperties}
      onPointerDown={touch}
      {...adminHold.handlers}
      onPointerDownCapture={(e) => {
        onTechTap(e);
        adminHold.handlers.onPointerDownCapture(e);
      }}
    >
      {children}
      <AdminHoldBar progress={adminHold.progress} rtl={adminHold.rtl} />
    </div>
  );

  if (status === 'mismatch') return root(<div className="t-blocking">{T.updateRequired}</div>);
  if (!state) return root(<div className="t-blocking">{status === 'offline' ? T.engineOffline : T.engineStarting}</div>);

  const s = state;
  /**
   * A tile tapped (or a code scanned): a meal, a dish with a required group, or — as the parameters say — one with add-ons /
   * note chips of its own opens its sheet first (core/till/choices.ts opensSheet); the engine's answer `{choices: true}`
   * opens it too (a product it knows asks).
   */
  const addProduct = (productId: string) => {
    const p = catalog?.products.find((x) => x.id === productId);
    if (p?.choices && s.sell.refundMode !== true && opensSheet(p.choices, s.sell.choicesAuto ?? { addOns: false, notes: false })) return setChoices({ productId });
    void run('sell.add', { productId }).then((v) => {
      if (v && typeof v === 'object' && (v as { choices?: unknown }).choices === true) setChoices({ productId });
    });
  };
  const confirmChoices = (target: ChoicesTarget, args: Omit<OpArgs['sell.configure'], 'lineId'>) => {
    const done = target.line ? attempt('sell.configure', { ...args, lineId: target.line.lineId }) : attempt('sell.add', { ...args, productId: target.productId, configured: true });
    void done.then((r) => (r.ok ? setChoices(null) : say(r.message, 'error')));
  };
  // "הנחות קבועות": the one on the basket again takes it off; one that asks "עבור מי" opens its sheet first.
  const presets = s.presetDiscounts?.items ?? [];
  const presetButtons = presets.filter((p) => (s.presetDiscounts?.buttons ?? []).includes(p.id));
  const sendPreset = (presetId: string, who: Omit<OpArgs['discount.preset'], 'presetId'> = {}) =>
    void attempt('discount.preset', { presetId, ...who }).then((r) => (r.ok ? setSheet(null) : say(r.message, 'error')));
  const tapPreset = (presetId: string, fromDiscount: boolean) => {
    const p = presets.find((x) => x.id === presetId);
    if (p && p.forWhom !== 'none' && s.sell.basketDiscount?.preset?.id !== presetId) return setSheet({ kind: 'presetFor', presetId, fromDiscount });
    sendPreset(presetId);
  };
  // "תפריט": the rows (core/till/tillMenu.ts) and the one on show; never over a payment, never signed out.
  const menuReady = !!s.session.cashier && !s.session.locked && s.checkout.phase === 'idle';
  const menuCurrent: MenuTarget | null =
    view === 'shift' && (menuAt === 'shift' || menuAt === 'shiftClose' || menuAt === 'tillZ')
      ? menuAt
      : view === 'report'
        ? ((Object.keys(REPORT_OF) as MenuTarget[]).find((t) => REPORT_OF[t] === reportKind) ?? null)
        : view === 'caps'
          ? 'diagnostics'
          : view === 'shopx' ||
              view === 'history' ||
              view === 'recent' ||
              view === 'transmission' ||
              view === 'printQueue' ||
              view === 'blocks' ||
              view === 'users' ||
              view === 'owed' ||
              view === 'kiosks' ||
              view === 'catalogAdmin' ||
              view === 'shopZ' ||
              view === 'readyOrders' ||
              view === 'voucherBalance' ||
              view === 'cloudZ' ||
              view === 'printers' ||
              view === 'alerts'
            ? view
            : null;
  const menuGroups = buildTillMenu(menuFactsOf(s, { demo: host.demo, settings: !!host.ui.openAdmin, current: menuCurrent }));
  /** A row tapped: the drawer closes and its screen opens (the sync stays: it runs in place). */
  const onMenu = (t: MenuTarget) => {
    if (t === 'sync') return void run('menu.sync', {});
    setMenuOpen(false);
    const report = REPORT_OF[t];
    if (report) {
      setReportKind(report);
      setMenuAt(t);
      return setView('report');
    }
    switch (t) {
      case 'shift':
      case 'shiftClose':
      case 'tillZ':
        setMenuAt(t);
        return setView('shift');
      case 'drawerOpen':
        setDrawerAt('reason');
        return setView('drawer');
      case 'drawerRemote':
        setDrawerAt('remote');
        return setView('drawer');
      case 'cashMenu':
        return setCashSheet(true);
      case 'refund':
        setView('sell');
        return void run('refund.button', {});
      case 'refundEnd':
        setView('sell');
        return void run('refund.end', {});
      case 'update':
        return void run('menu.update', {});
      case 'support':
        return void run('menu.support', {});
      case 'settings':
        return host.ui.openAdmin?.();
      // "אבחון" (Android: the technician's screen behind its code): the shell's technician screen where the host has one,
      // else the device's capabilities.
      case 'diagnostics':
        if (host.ui.openTechnician) return host.ui.openTechnician();
        return setView('caps');
      case 'workMode':
        return void run('mode.switch', { to: 'kiosk' });
      // Phase 2: each module's screen, opened through its own op.
      case 'catalogAdmin':
        setMenuAt(t);
        setView('catalogAdmin');
        return act('catalog.open');
      case 'shopZ':
      case 'readyOrders':
      case 'alerts':
        setMenuAt(t);
        return setView(t);
      case 'attendance':
        return act('attendance.open');
      case 'kioskOrders':
        setView('sell');
        return setKioskList(true);
      case 'voucherStation':
        setView('sell');
        return act(s.voucherStation?.active ? 'voucherStation.leave' : 'voucherStation.return');
      case 'voucherBalance':
        setMenuAt(t);
        setView('voucherBalance');
        return act('voucherBalance.open');
      case 'cloudZ':
        setMenuAt(t);
        setView('cloudZ');
        return act('cloudZ.open');
      case 'printers':
        setMenuAt(t);
        setView('printers');
        return act('printers.open');
      case 'screenEdit':
        setView('sell');
        return act('screenEdit.start');
      case 'signOut':
        return void run('session.logout', {});
      case 'shopx':
      case 'history':
      case 'recent':
      case 'transmission':
      case 'printQueue':
      case 'blocks':
      case 'users':
      case 'owed':
      case 'kiosks':
        setMenuAt(t);
        return setView(t);
      default:
        return undefined;
    }
  };
  // "עיצוב קופה" / "כפתור תשלום מהיר": a quick-bar button (Android QuickOrderPanel's), through the payment's own ops.
  const startCheckout = async () => {
    setPadFirst(false);
    const r = await attempt('checkout.start', {});
    if (!r.ok) say(r.message, 'error');
    return r.ok;
  };
  const quick = (b: QuickButton) => {
    switch (b.action) {
      case 'fastCard':
        return void startCheckout().then((ok) => ok && run('checkout.card', {}));
      case 'fastCash':
        return void startCheckout().then((ok) => ok && run('checkout.cash', { amountAgorot: s.sell.totalAgorot }));
      case 'cashNotes':
        return void startCheckout().then((ok) => ok && b.noteShekels && run('checkout.cash', { amountAgorot: b.noteShekels * 100 }));
      case 'cashWithChange':
        setPadFirst(true);
        return void attempt('checkout.start', {}).then((r) => {
          if (!r.ok) {
            setPadFirst(false);
            say(r.message, 'error');
          }
        });
      case 'hold':
        return setSheet({ kind: 'held' });
      case 'discount':
        return b.presetId ? tapPreset(b.presetId, false) : setSheet({ kind: 'discount' });
      case 'orderDetails':
        return void run('order.edit', {});
      case 'clear':
        return void run('sell.clear', {});
      default:
        return undefined;
    }
  };
  const identity = [s.menu?.shopName, s.menu?.posNumber ? `קופה ${s.menu.posNumber}` : null].filter(Boolean).join(' · ') || null;
  const main = (() => {
    if (s.session.locked || !s.session.cashier)
      // "טכנאי" under the pad, as Android's login screen (the six taps work here too).
      return (
        <LockScreen
          demo={host.demo}
          onLogin={(pin) => void run('session.login', { pin })}
          onTechnician={host.ui.openTechnician ? () => host.ui.openTechnician!() : undefined}
          extra={<AttendanceClockButton view={s.attendance} onOpen={() => act('attendance.clock')} />}
        />
      );
    if (s.checkout.phase !== 'idle') {
      return (
        <CheckoutScreen
          checkout={s.checkout}
          layout={layout}
          cardTile={cardTile}
          noCard={s.health.noCard === true}
          startWithPad={padFirst}
          lines={s.sell.lines}
          wideCash={profile.widthDp >= 840 && profile.widthDp > profile.heightDp && profile.heightDp >= 600}
          demo={s.session.demo}
          actions={{
            cash: (amountAgorot) => void run('checkout.cash', { amountAgorot }),
            card: () => void run('checkout.card', {}),
            cancel: () => void run('checkout.cancel', {}),
            finish: () => void run('checkout.finish', {}),
            print: (print) => void run('checkout.print', { print }),
            // "הדפס העתק" on the sale just done: the engine prints it without a manager (the Android checkout's own).
            copy: () => void (s.checkout.documentId ? run('doc.reprint', { documentId: s.checkout.documentId }) : undefined),
            recheck: () => void run('checkout.recheckCard', {}),
            markNotApproved: () => void run('checkout.markNotApproved', {}),
            returnCustomer: (c) => void run('checkout.returnCustomer', c),
            exchange: () => void run('checkout.exchange', {}),
            payout: (method) => void run('checkout.payout', { method }),
            // "זיכוי מזומן": the real engine's (the demo has no cloud to redeem with).
            ...(host.demo
              ? {}
              : {
                  credit: (code: string) => void run('checkout.credit', { code }),
                  removeCredit: (redemptionId: string) => void run('checkout.removeCredit', { redemptionId }),
                  voucher: (code: string) => void run('checkout.voucher', { code }),
                  removeVoucher: (id: string) => void run('checkout.removeVoucher', { id }),
                  finishTest: () => void run('checkout.finishTest', {}),
                }),
          }}
        />
      );
    }
    if (view === 'shift') {
      return (
        <ShiftScreen
          state={s}
          layout={layout}
          actions={{
            open: (openingCashAgorot) => void run('shift.open', { openingCashAgorot }),
            close: async (countedCashAgorot) => closing<CloseResult>('shift.close', { countedCashAgorot }),
            x: async () => (await run('report.x', {})) as XReport | undefined,
            z: async (countedCashAgorot) => closing<{ message?: string }>('z.produce', countedCashAgorot === undefined ? {} : { countedCashAgorot }),
            switchTo: (to: DeviceRoleName) => void run('mode.switch', { to }),
            back: () => setView('sell'),
          }}
        />
      );
    }
    if (view === 'recent') {
      return (
        <HistoryScreen
          title={MENU_TEXT.recent}
          load={loadRecent}
          reprint={(id) => void run('doc.reprint', { documentId: id })}
          back={() => setView('sell')}
          detail={loadDetail}
          refund={async (documentId, quantities) => {
            const r = await attempt('doc.refund', { documentId, quantities });
            if (!r.ok) say(r.message, 'error');
            return r.ok && !(r.value && typeof r.value === 'object' && 'dialogId' in (r.value as object));
          }}
          refundHidden={(s.session.hidden ?? []).includes('REFUND')}
        />
      );
    }
    if (view === 'catalogAdmin' && s.catalogAdmin?.open) {
      return (
        <CatalogAdminScreen
          view={s.catalogAdmin}
          actions={{
            panel: (panel) => act('catalog.panel', { panel }),
            filter: (f) => act('catalog.filter', f),
            more: () => act('catalog.more'),
            page: (productId) => act('catalog.page', { productId }),
            pageClose: () => act('catalog.pageClose'),
            save: (productId, draft, photo) => act('catalog.save', { productId, draft, photo }),
            add: (draft, photo) => act('catalog.add', { draft, photo }),
            priceLevel: (level) => act('catalog.priceLevel', { level }),
            priceCancel: () => act('catalog.priceCancel'),
            setAvailable: (a) => act('catalog.setAvailable', a),
            moveCategory: (productIds, categoryId) => act('catalog.moveCategory', { productIds, categoryId }),
            categoryAdd: (name) => act('catalog.categoryAdd', { name }),
            categoryRename: (categoryId, name) => act('catalog.categoryRename', { categoryId, name }),
            categoryActive: (a) => act('catalog.categoryActive', a),
            machineAuth: () => act('catalog.machineAuth'),
            machineSave: (mode, productIds) => act('catalog.machineSave', { mode, productIds }),
            release: () => act('catalog.release'),
            dismiss: () => act('catalog.dismiss'),
            block: (item) => (item.productId ? setSheet({ kind: 'block', productId: item.productId }) : undefined),
          }}
          back={() => {
            act('catalog.close');
            setView('sell');
          }}
        />
      );
    }
    if (view === 'shopZ') {
      return (
        <ShopZScreen
          view={s.shopZ}
          actions={{
            open: () => act('shopZ.open'),
            leave: () => void run('shopZ.leave', {}),
            refresh: () => act('shopZ.refresh'),
            scope: (area) => act('shopZ.scope', { area }),
            start: (confirm) =>
              void attempt('shopZ.start', { confirm }).then((r) => {
                if (r.ok) return;
                if (r.code === 'held_sales') {
                  // "יש N מכירות מושהות": paid or cancelled first — or kept where the shop allows it.
                  setSheet({
                    kind: 'heldClose',
                    retry: (keepHeld) => {
                      setSheet(null);
                      act('shopZ.start', { confirm, keepHeld });
                    },
                  });
                  return;
                }
                say(r.message, 'error');
              }),
            proceed: () => act('shopZ.proceed'),
            dismiss: () => act('shopZ.dismiss'),
            printSummary: () => act('shopZ.printSummary'),
            details: (answer) => act('shopZ.details', { answer }),
            printDetails: (machineIds) => act('shopZ.printDetails', { machineIds }),
            cancelDetails: () => act('shopZ.cancelDetails'),
          }}
          back={() => setView('sell')}
        />
      );
    }
    if (view === 'readyOrders') {
      return <ReadyOrdersScreen view={s.readyOrders} actions={readyActions} back={() => setView('sell')} />;
    }
    if (view === 'alerts') {
      return (
        <AlertsScreen
          view={s.alerts}
          actions={{
            refresh: () => void run('alerts.refresh', {}),
            seen: (keys) => act('alerts.seen', { keys }),
            seenAll: () => act('alerts.seenAll'),
            onMyWay: (key) => act('alerts.onMyWay', { key }),
            pay: (key) => act('alerts.pay', { key }),
            ...((s.menuHidden ?? []).includes('print_queue') ? {} : { openQueue: () => setView('printQueue') }),
            ...((s.menuHidden ?? []).includes('printers') ? {} : { openPrinters: () => {
              setView('printers');
              act('printers.open');
            } }),
            ...((s.menuHidden ?? []).includes('managed_kiosks') || !s.kiosks ? {} : { openKiosks: () => setView('kiosks') }),
          }}
          back={() => setView('sell')}
        />
      );
    }
    if (view === 'voucherBalance' && s.voucherBalance) {
      return (
        <VoucherBalanceScreen
          view={s.voucherBalance}
          actions={{
            lookup: (code, typed) => act('voucherBalance.lookup', { code, typed }),
            again: () => act('voucherBalance.again'),
            ...(s.voucherStation?.active
              ? {
                  redeem: (code: string) => {
                    void run('voucherBalance.close', {});
                    setView('sell');
                    act('voucherStation.scan', { code: `PV:${code}`, typed: false });
                  },
                }
              : {}),
          }}
          back={() => {
            void run('voucherBalance.close', {});
            setView('sell');
          }}
        />
      );
    }
    if (view === 'cloudZ') {
      return (
        <CloudZScreen
          view={s.cloudZ ?? null}
          actions={{
            toggle: (id) => act('cloudZ.toggle', { id }),
            selectAll: () => act('cloudZ.selectAll'),
            print: (id) => act('cloudZ.print', { id }),
            printSequence: () => act('cloudZ.printSequence'),
            printSummary: (id) => act('cloudZ.printSummary', { id }),
            printTill: (id, machineId) => act('cloudZ.printTills', { id, machineIds: [machineId] }),
            printAllTills: (id) => act('cloudZ.printTills', { id }),
            dismissChoice: () => act('cloudZ.dismissChoice'),
            cancelTills: () => act('cloudZ.cancelTills'),
          }}
          back={() => {
            void run('cloudZ.close', {});
            setView('sell');
          }}
        />
      );
    }
    if (view === 'printers') {
      return (
        <PrintersScreen
          view={s.printers ?? null}
          actions={{
            check: (printerId) => act('printers.check', { printerId }),
            test: (printerId) => act('printers.test', { printerId }),
            designTest: (printerId) => act('printers.designTest', { printerId }),
            widthTest: (printerId) => act('printers.widthTest', { printerId }),
            reprint: (jobId) => act('printers.reprint', { jobId }),
            retry: (jobId) => act('printQueue.retry', { jobId }),
            handled: (jobId) => act('printQueue.handled', { jobId }),
            move: (jobId) => act('printers.move', { jobId }),
            toTill: (jobId) => act('printers.toTill', { jobId }),
            receipt: (choice) => act('printers.receipt', { choice }),
            scan: () => act('printers.scan'),
            scanStop: () => act('printers.scanStop'),
            add: (p) => act('printers.add', p),
          }}
          back={() => {
            void run('printers.close', {});
            setView('sell');
          }}
        />
      );
    }
    if (view === 'kiosks') {
      return (
        <KiosksScreen
          kiosks={s.kiosks}
          refresh={refreshKiosks}
          command={(c) => void attempt('kiosks.command', c).then((r) => !r.ok && say(r.message, 'error'))}
          back={() => setView('sell')}
        />
      );
    }
    if (view === 'report') {
      return <LocalReportScreen kind={reportKind} report={s.menu?.report ?? null} ask={askReport} reprintZ={(id) => void run('report.reprintZ', { id })} back={() => setView('sell')} />;
    }
    if (view === 'drawer' && s.drawer) {
      return (
        <DrawerScreen
          key={drawerAt}
          drawer={s.drawer}
          initial={drawerAt}
          actions={{
            open: (reason, note) => run('drawer.open', { reason, note }),
            openRemote: (machineId, reason, note) => run('drawer.openRemote', { machineId, reason, note }),
            movement: (type, amountAgorot, reason, note, source) => run('drawer.movement', { type, amountAgorot, reason, note, source }),
            count: () => run('drawer.count', {}),
            countSave: (countedAgorot) => run('drawer.countSave', { countedAgorot }),
            countDone: () => run('drawer.countDone', {}),
            wallets: async () => (await run('drawer.wallets', {})) as { wallets: WalletRow[]; offline: boolean } | undefined,
            deposit: (employeeId, countedAgorot) => run('drawer.walletDeposit', { employeeId, countedAgorot }),
            log: async () => (await run('drawer.log', {})) as DrawerLog | undefined,
            back: () => setView('sell'),
          }}
        />
      );
    }
    if (view === 'owed') {
      return (
        <OwedScreen
          owed={s.owed}
          actions={{
            refresh: () => void run('owed.refresh', {}),
            pay: (id) => void run('owed.pay', { id }),
            back: () => setView('sell'),
          }}
        />
      );
    }
    if (view === 'users') {
      return (
        <UsersScreen
          users={s.users}
          actions={{
            open: () => void run('users.open', {}),
            refresh: () => void run('users.refresh', {}),
            release: (sessionId) => void run('users.release', { sessionId }),
            close: () => {
              void run('users.close', {});
              setView('sell');
            },
          }}
        />
      );
    }
    if (view === 'printQueue') {
      return <PrintQueueScreen actions={printQueueActions} />;
    }
    if (view === 'blocks') {
      return <BlocksScreen actions={blocksActions} catalog={catalog} back={() => setView('sell')} />;
    }
    if (view === 'transmission') {
      return (
        <TransmissionScreen
          tx={s.transmission}
          actions={{
            open: () => void run('transmission.open', {}),
            now: () => void run('transmission.now', {}),
            offline: (on) => void run('transmission.offline', { on }),
            authorize: () => void run('transmission.authorize', {}),
            read: () => void run('transmission.read', {}),
            more: () => void run('transmission.more', {}),
            back: () => setView('sell'),
          }}
        />
      );
    }
    if (view === 'shopx') {
      return (
        <ShopXScreen
          shopX={s.shopX}
          load={(refresh, scope) => void run('report.shopX', { ...(refresh ? { refresh: true } : {}), ...(scope === 'area' ? { scope } : {}) })}
          print={() => void run('report.shopX', { print: true })}
          back={() => setView('sell')}
        />
      );
    }
    if (view === 'history') {
      return (
        <HistoryScreen
          load={loadHistory}
          reprint={(id) => void run('doc.reprint', { documentId: id })}
          back={() => setView('sell')}
          detail={loadDetail}
          refund={async (documentId, quantities) => {
            const r = await attempt('doc.refund', { documentId, quantities });
            if (!r.ok) say(r.message, 'error');
            // A manager's code: the engine's dialog is up; the refund goes on when it is answered.
            return r.ok && !(r.value && typeof r.value === 'object' && 'dialogId' in (r.value as object));
          }}
          refundHidden={(s.session.hidden ?? []).includes('REFUND')}
        />
      );
    }
    if (view === 'caps') {
      return (
        <div className="t-report" style={layout.reportMaxWidthDp ? { maxWidth: layout.reportMaxWidthDp } : undefined}>
          <div className="t-report-head">
            <h1 className="t-report-title">{T.caps}</h1>
            <button type="button" className="t-btn t-btn-ghost" onClick={() => setView('sell')}>
              {T.back}
            </button>
          </div>
          <CapabilityTiles tiles={tiles} />
        </div>
      );
    }
    // "עמדת שובר": the station replaces the sell screen while it is on (the payment shows as usual over it).
    if (s.voucherStation?.active) {
      return (
        <VoucherStationScreen
          view={s.voucherStation}
          back={() => setMenuOpen(true)}
          actions={{
            scan: (code, typed) => act('voucherStation.scan', { code, typed }),
            dismiss: () => act('voucherStation.dismiss'),
            pick: (productId, groupKey, delta) => act('voucherStation.pick', { productId, groupKey, delta }),
            commit: () => act('voucherStation.commit'),
            closePicker: () => act('voucherStation.closePicker'),
            basket: () => act('voucherStation.basket'),
            add: (productId) => act('voucherStation.add', { productId }),
            toggle: (lineId, toVoucher) => act('voucherStation.toggle', { lineId, toVoucher }),
            category: (categoryId) => act('voucherStation.category', { categoryId }),
            backToScan: () => act('voucherStation.back'),
            removeVoucher: (voucherId) => act('voucherStation.removeVoucher', { voucherId }),
            pay: () => act('voucherStation.pay'),
            payOpen: () => act('voucherStation.payOpen'),
            clear: () => act('voucherStation.clear'),
          }}
        />
      );
    }
    return (
      <SellScreen
        state={s}
        catalog={catalog}
        layout={layout}
        onAdd={addProduct}
        onCustomize={(productId) => setChoices({ productId })}
        onKioskSlip={host.demo ? undefined : (code) => act('kioskOrders.scan', { code })}
        screenEdit={
          s.screenEdit?.on
            ? {
                view: s.screenEdit,
                actions: {
                  done: () => act('screenEdit.done'),
                  cancel: () => act('screenEdit.cancel'),
                  moveCategory: (fromId, toId) => act('screenEdit.moveCategory', { fromId, toId }),
                  move: (fromId, toId, shown) => act('screenEdit.move', { fromId, toId, shown }),
                  lock: (productId, locked) => act('screenEdit.lock', { productId, locked }),
                },
              }
            : null
        }
        onDepartment={(departmentId) => void run('sell.department', { departmentId })}
        onSearch={(text) => void run('sell.search', { text })}
        onVoucher={host.demo ? undefined : (code) => void run('sell.voucher', { code })}
        onHold={host.demo || (s.session.hidden ?? []).includes('ITEM_BLOCK') ? undefined : (productId) => setSheet({ kind: 'block', productId })}
        shiftOpen={host.demo || s.shift.open || s.shift.hidden === true}
        goShift={() => setView('shift')}
        cart={{
          setQty: (lineId, qty) => void run('sell.setQty', { lineId, qty }),
          discount: (lineId: string, pct: number) => void run('sell.discount', { lineId, pct }),
          remove: (lineId) => void run('sell.remove', { lineId }),
          clear: () => void run('sell.clear', {}),
          pay: () => void startCheckout(),
          quick,
          ...(host.demo
            ? {}
            : {
                oth: (lineId: string) => setSheet({ kind: 'oth', lineId }),
                othUndo: (lineId: string) => void run('oth.undo', { lineId }),
                basketDiscount: () => setSheet({ kind: 'discount' }),
                refund: () => void run('refund.button', {}),
                hold: () => setSheet({ kind: 'held' }),
                held: () => setSheet({ kind: 'held' }),
                orderEdit: () => void run('order.edit', {}),
                preset: (presetId: string) => tapPreset(presetId, false),
                editLine: (lineId: string) => {
                  const l = s.sell.lines.find((x) => x.lineId === lineId);
                  if (l?.choices) setChoices({ productId: l.productId, line: { lineId, qty: l.qty, choices: l.choices } });
                },
              }),
        }}
        cartView={{
          hidden: s.session.hidden ?? [],
          othEnabled: s.oth?.enabled === true,
          heldCount: s.held?.count ?? 0,
          order: s.order ? { strip: s.order.strip, configured: s.order.configured } : null,
          presetButtons,
          bar: design?.actionBar ?? [],
          notes: s.design?.quickCash.offered ?? [],
          payWord: s.design?.texts.pay,
        }}
        identity={identity}
        design={design}
        quick={quick}
        onMenu={menuReady ? () => setMenuOpen(true) : undefined}
        onFlowHome={setFlowHomeShown}
        ops={
          host.demo
            ? { addQty: (productId, qty) => void run('sell.add', { productId, qty }) }
            : {
                addQty: (productId, qty) => void run('sell.add', { productId, qty }),
                orderDetails: (d) => void run('order.details', d),
                resume: (id) => void run('held.resume', { id }),
                park: (label) => void run('held.hold', label ? { label } : {}),
              }
        }
      />
    );
  })();

  // The island is the shell's (Android PosShell): the sign-in and the payment are screens of their own, over it.
  const islandShown = !s.session.locked && !!s.session.cashier && s.checkout.phase === 'idle' && !(flowHomeShown && view === 'sell');
  return root(
    <>
      <header className={`t-top${islandShown ? '' : ' t-top-bare'}`}>
        <div className="t-brand">
          R2M <b>POS</b>
        </div>
        {/* The Android bar (BottomBar.kt), from the right: "תפריט" (an action, never lit), "הזמנה מהירה" (lit on the till). */}
        <nav className="t-nav">
          <button
            type="button"
            className={`t-nav-btn t-nav-menu${menuOpen ? ' t-nav-on' : ''}`}
            data-nav="menu"
            disabled={!menuReady}
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
          >
            <NavGlyph name="menu" />
            <span>{T.menu}</span>
          </button>
          <button type="button" className={`t-nav-btn${view === 'sell' && !menuOpen ? ' t-nav-on' : ''}`} data-nav="sell" onClick={() => setView('sell')}>
            <NavGlyph name="catalog" />
            <span>{T.quickOrder}</span>
          </button>
        </nav>
        <div className="t-health" aria-label="מצב">
          <span className={`t-dot ${s.health.cloud === 'online' ? 't-dot-ok' : s.health.cloud === 'demo' ? 't-dot-demo' : 't-dot-off'}`} title={s.health.cloud === 'offline' ? T.offline : T.online} />
          <span className={`t-dot ${s.health.printer === 'ok' ? 't-dot-ok' : s.health.printer === 'error' ? 't-dot-bad' : 't-dot-off'}`} title={T.printer} />
          {s.health.noCard ? null : <span className={`t-dot ${s.health.terminal === 'none' ? 't-dot-off' : 't-dot-ok'}`} title={T.terminal} />}
          <span className="t-cashier">{s.session.cashier?.name ?? ''}</span>
          {s.session.cashier ? (
            <button type="button" className="t-btn t-btn-ghost t-btn-small" onClick={() => void run('session.logout', {})}>
              {T.logout}
            </button>
          ) : null}
        </div>
      </header>
      {/* The strips over the screen: at most a third of its height, scrolling past it (till.css .t-notices). */}
      <div className="t-notices">
        {host.demo ? (
          <div className="t-demo" role="note">
            {T.demoBadge}
          </div>
        ) : null}
        {!host.demo && s.mode.role === 'kiosk' ? (
          // A kiosk working as a till today (Android KioskTillModeBanner): the way back, and the idle return's notice.
          <div className="t-worknote" role="note">
            <span className="t-worknote-text">{T.workModeBanner}</span>
            {s.mode.countdownSec ? (
              <>
                <span className="t-worknote-count">{T.workModeCountdown(s.mode.countdownSec)}</span>
                <button type="button" className="t-pill" onClick={touch}>
                  {T.workModeStay}
                </button>
              </>
            ) : null}
            {s.mode.rolesAllowed.includes('kiosk') ? (
              <button type="button" className="t-pill t-pill-light" onClick={() => void run('mode.switch', { to: 'kiosk' })}>
                {s.mode.switchLabel ?? 'חזרה לקיוסק'}
              </button>
            ) : null}
          </div>
        ) : null}
        {s.owed && s.owed.items.length > 0 && !s.session.locked && view !== 'owed' && s.checkout.phase === 'idle' ? (
          // "עודף חייב ללקוח": urgent on the till (Android's alerts list) — the way to "שולם ללקוח".
          <div className="t-notice" role="status">
            <span className="t-notice-text">
              עודף חייב ללקוח · {s.owed.items.length}
            </span>
            <button type="button" className="t-pill" onClick={() => setView('owed')}>
              שולם ללקוח
            </button>
          </div>
        ) : null}
        {s.kioskOrders && !s.session.locked && view === 'sell' && s.checkout.phase === 'idle' && !(s.menuHidden ?? []).includes('kiosk_orders') ? (
          // "הזמנות קיוסק ממתינות לתשלום (N)" (KioskOpenOrdersBadge): a tap opens the list.
          <KioskOrdersStrip count={s.kioskOrders.waiting} onOpen={() => setKioskList(true)} />
        ) : null}
        {s.alerts && !s.session.locked && view === 'sell' && s.checkout.phase === 'idle' && s.alerts.line ? (
          <AlertsLine view={s.alerts} onOpen={(s.menuHidden ?? []).includes('alerts') ? undefined : () => setView('alerts')} onSeenAll={() => act('alerts.seenAll')} />
        ) : null}
        {s.printQueue?.banner && !s.session.locked && view !== 'printQueue' ? (
          // "בון לא הודפס במדפסת מטבח" (KitchenPrintBanner): never quieted; a tap opens the queue.
          <button type="button" className="t-banner t-banner-button" role="alert" onClick={() => setView('printQueue')}>
            {s.printQueue.banner}
          </button>
        ) : null}
        {view === 'sell' && !s.session.locked
          ? (s.printQueue?.redirects ?? []).map((r) => (
              <div key={r.fromId} className="t-notice t-redirect" role="status">
                <span className="t-notice-text">{r.text}</span>
                <button type="button" className="t-pill" onClick={() => void run('printQueue.endRedirect', { fromId: r.fromId })}>
                  {FAILOVER_TEXT.endRedirect}
                </button>
              </div>
            ))
          : null}
        {s.terminalOffline && !s.session.locked && s.checkout.phase === 'idle' && view === 'sell' ? (
          // The terminal works deferred (Android TerminalOfflineChip): amber, the cards that do not pass on the second line.
          <div className="t-notice t-deferred-banner" role="status">
            <span className="t-notice-text">
              {s.terminalOffline.text.split('\n').map((line, i) => (
                <span key={i} style={{ display: 'block' }}>
                  {line}
                </span>
              ))}
            </span>
            <button type="button" className="t-pill" onClick={() => setView('transmission')}>
              {T.transmissionOpen}
            </button>
          </div>
        ) : null}
        {s.users?.notice ? (
          // "עובד מחובר בקופה אחת בלבד": signed in elsewhere too, signing out at the end of the action, signed out (exclusive login v2).
          <div className="t-notice" role="status">
            <span className="t-notice-text">{s.users.notice}</span>
            <button type="button" className="t-pill" onClick={() => void run('session.dismissNotice', {})}>
              {T.close}
            </button>
          </div>
        ) : null}
        {status === 'offline' ? (
          <div className="t-banner" role="alert">
            {T.engineOffline}
          </div>
        ) : null}
      </div>
      <main className="t-main">{main}</main>
      {/* "Powered by R2M" under the sell screen, as the Android till's shell draws it. */}
      {islandShown && view === 'sell' ? <div className="t-powered">Powered by <b>R2M</b></div> : null}
      {menuOpen && menuReady ? (
        <TillMenuDrawer
          groups={menuGroups}
          folderOpen={folderOpenAtStart(menuGroups, menuCurrent, s.shift.open, s.shift.hidden === true)}
          user={{
            name: s.session.cashier?.name ?? '',
            roleName: s.menu?.roleName ?? null,
            shopName: s.menu?.shopName ?? null,
            posNumber: s.menu?.posNumber ?? null,
            identity: s.menu?.identity ?? [],
          }}
          onTarget={onMenu}
          onClose={() => setMenuOpen(false)}
        />
      ) : null}
      {cashSheet && s.drawer && s.session.cashier ? (
        <MenuActionSheet
          title={MENU_TEXT.cashMenu}
          actions={CASH_ACTIONS.filter((a) => s.drawer!.offered[a.id]).map((a) => ({
            id: a.id,
            label: a.label,
            onTap: () => {
              setCashSheet(false);
              setDrawerAt(a.sheet);
              setMenuAt('cashMenu');
              setView('drawer');
            },
          }))}
          onClose={() => setCashSheet(false)}
        />
      ) : null}
      {s.session.cashier && s.sell.refundChooser && !s.dialog && sheet?.kind !== 'receipt' ? (
        <RefundChooser onCatalog={() => void run('refund.catalog', {})} onReceipt={() => setSheet({ kind: 'receipt' })} onClose={() => void run('refund.end', {})} />
      ) : null}
      {s.session.cashier && sheet?.kind === 'discount' ? (
        <BasketDiscountSheet
          preview={previewDiscount}
          current={s.sell.basketDiscount ?? null}
          apply={(mode, input) => void attempt('discount.apply', { mode, input }).then((r) => (r.ok ? setSheet(null) : say(r.message, 'error')))}
          remove={() => void run('discount.remove', {}).then(() => setSheet(null))}
          presets={(s.session.hidden ?? []).includes('DISCOUNT') ? [] : presets}
          onPreset={(presetId) => tapPreset(presetId, true)}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {s.session.cashier && sheet?.kind === 'presetFor'
        ? (() => {
            const preset = presets.find((p) => p.id === sheet.presetId);
            if (!preset) return null;
            return (
              <PresetForSheet
                preset={preset}
                employees={s.presetDiscounts?.employees ?? []}
                onApply={(who) => sendPreset(preset.id, who)}
                onClose={() => setSheet(sheet.fromDiscount ? { kind: 'discount' } : null)}
              />
            );
          })()
        : null}
      {s.session.cashier && sheet?.kind === 'oth' ? (
        <OthSheet
          lines={s.sell.lines}
          reasons={s.oth?.reasons ?? []}
          requiresManager={s.oth?.requiresManager !== false}
          initial={sheet.lineId}
          onConfirm={(lineIds, reason) => void attempt('oth.confirm', { lineIds, reason }).then((r) => (r.ok ? setSheet(null) : say(r.message, 'error')))}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {s.session.cashier && sheet?.kind === 'receipt' ? (
        <ReceiptPicker
          recent={recentReceipts}
          find={findReceipt}
          pick={pickReceipt}
          add={async (transactionId, quantities) => {
            const r = await attempt('refund.add', { transactionId, quantities });
            if (!r.ok) say(r.message, 'error');
            return r.ok;
          }}
          onClose={() => setSheet(null)}
        />
      ) : null}
      {sheet?.kind === 'cardTipsChoice' ? (
        <CardTipsChoiceSheet title={sheet.title} body={sheet.body} partial={sheet.partial} negative={sheet.negative} onChoose={sheet.retry} onClose={() => setSheet(null)} />
      ) : null}
      {s.session.cashier && (sheet?.kind === 'held' || sheet?.kind === 'heldClose') && s.held ? (
        <HeldSheet
          held={s.held}
          closing={sheet.kind === 'heldClose'}
          canHold={sheet.kind === 'held' && s.sell.lines.length > 0}
          hideCancel={(s.session.hidden ?? []).includes('HELD_SALE_CANCEL')}
          onHold={(label) => void attempt('held.hold', label.trim() ? { label } : {}).then((r) => (r.ok ? setSheet(null) : say(r.message, 'error')))}
          onResume={(id) =>
            void attempt('held.resume', { id }).then(async (r) => {
              if (r.ok) return setSheet(null);
              // Items rung up: the live basket is parked first, never merged or lost.
              if (r.details?.conflict === true && window.confirm(`${r.message}\n${T.heldConflictConfirm}?`)) {
                const again = await attempt('held.resume', { id, parkLive: true });
                if (again.ok) setSheet(null);
                else say(again.message, 'error');
                return;
              }
              say(r.message, 'error');
            })
          }
          onCancel={(id, reason) => void attempt('held.cancel', { id, reason }).then((r) => !r.ok && say(r.message, 'error'))}
          {...(sheet.kind === 'heldClose' ? { onKeepAndClose: () => sheet.retry(true) } : {})}
          onClose={() => {
            // The close goes on by itself once none is left.
            if (sheet.kind === 'heldClose' && s.held!.count === 0) sheet.retry(false);
            else setSheet(null);
          }}
        />
      ) : null}
      {s.session.cashier && view === 'sell' && s.order?.ask && !s.dialog && !sheet ? (
        // "פרטי הזמנה" (askEatInTakeAway / askOrderName): when the engine asks — a new order, its first item, the payment.
        <OrderDetailsSheet
          key={`${s.order.ask.purpose}:${s.order.ask.dining}:${s.order.ask.name}`}
          ask={s.order.ask}
          dining={s.order.dining}
          name={s.order.name}
          texts={ORDER_TEXT}
          onConfirm={(dining, name) => void attempt('order.details', { dining, name }).then((r) => !r.ok && say(r.message, 'error'))}
          onDismiss={() => void run('order.dismiss', {})}
        />
      ) : null}
      {s.session.cashier && kioskList && s.checkout.phase === 'idle' ? (
        <KioskOrdersSheet
          view={s.kioskOrders}
          actions={{
            refresh: () => void run('kioskOrders.refresh', {}),
            pay: (id) =>
              void attempt('kioskOrders.pay', { id }).then((r) => {
                if (r.ok) setKioskList(false);
                else say(r.message, 'error');
              }),
            cancel: (id, reason) => act('kioskOrders.cancel', { id, reason }),
          }}
          onClose={() => setKioskList(false)}
        />
      ) : null}
      {s.attendance ? (
        // "נוכחות": its card and sheets over whatever is on (the lock screen's clock too); the gate card covers the till.
        <AttendanceScreen
          view={s.attendance}
          actions={{
            close: () => void run('attendance.close', {}),
            act: (action) => act('attendance.act', { action }),
            code: (pin) => act('attendance.code', { pin }),
            behalf: () => act('attendance.behalf'),
            manager: (pin) => act('attendance.manager', { pin }),
            pick: (userId) => act('attendance.pick', { userId }),
            clockOutChoice: (choice) => act('attendance.clockOutChoice', { choice }),
            transfer: () => act('attendance.transfer'),
            correction: () => act('attendance.correction'),
            correctionSend: (form) => act('attendance.correctionSend', { ...form }),
            signOut: () => act('attendance.signOut'),
          }}
        />
      ) : null}
      {s.session.cashier && choices && s.checkout.phase === 'idle' && !s.dialog ? (
        <ChoicesSheet key={`${choices.productId}:${choices.line?.lineId ?? ''}`} catalog={catalog} target={choices} onConfirm={(args) => confirmChoices(choices, args)} onClose={() => setChoices(null)} />
      ) : null}
      {s.session.cashier && sheet?.kind === 'block' ? <BlockSheet item={{ productId: sheet.productId }} actions={blocksActions} onDone={() => setSheet(null)} /> : null}
      {s.notice && !s.dialog ? <NoticeDialog title={s.notice.title} text={s.notice.text} onOk={() => void run('notice.ack', {})} /> : null}
      {s.dialog ? <EngineDialog dialog={s.dialog} answer={(action, answers) => void run('dialog.answer', { dialogId: s.dialog!.id, action, answers })} /> : null}
      <div className="t-toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`t-toast t-toast-${t.tone}`}>
            {t.text}
          </div>
        ))}
      </div>
    </>,
  );
}

/** The menu's facts from the engine's state and the host (core/till/tillMenu.ts builds the rows from them). */
export function menuFactsOf(s: TillState, host: { demo: boolean; settings: boolean; current: MenuTarget | null }): TillMenuFacts {
  return {
    shiftOpen: s.shift.open,
    zOnly: s.shift.hidden === true,
    tillZMode: s.z.zMode === 'till',
    hidden: s.menuHidden ?? [],
    denied: s.session.hidden ?? [],
    refundMode: s.sell.refundMode === true,
    drawer: s.drawer?.offered ?? null,
    drawerHosts: s.drawer?.hosts ?? [],
    owedCount: s.owed?.items.length ?? 0,
    sync: s.menu?.sync ?? null,
    update: s.menu?.update ?? null,
    showTillZHistory: s.menu?.showTillZHistory === true,
    localReports: !!s.menu,
    shopX: s.shopX?.offered === true,
    settings: host.settings,
    printQueueCount: s.printQueue?.count ?? 0,
    printQueue: !host.demo,
    blocks: !host.demo,
    signedInUsers: s.users?.offered === true,
    workMode: s.mode.rolesAllowed.includes('kiosk') ? { label: s.mode.switchLabel ?? MENU_TEXT.toKiosk } : null,
    kiosks: s.kiosks?.rows.length ?? 0,
    support: s.menu?.support === true,
    current: host.current,
    // Phase 2: each module's own word on its row.
    catalogAdmin: s.catalogAdmin?.entryShown === true,
    shopZ: s.menuOffers?.shopZ === true,
    attendance: s.attendance && s.attendance.menuLine !== null ? { line: s.attendance.menuLine } : null,
    readyOrders: !!s.readyOrders,
    kioskOrders: s.kioskOrders?.waiting ?? 0,
    voucherStation: s.voucherStation?.menu ?? null,
    voucherBalance: s.voucherBalance?.enabled === true,
    cloudZ: s.menuOffers?.cloudZ === true,
    printers: !host.demo && !!s.menu,
    screenEdit: s.screenEdit?.available === true,
    alerts: s.alerts ? { line: s.alerts.subtitle } : null,
  };
}

/** The bar's two pictures (BottomBar.kt): the ☰ and the catalog's four tiles. */
function NavGlyph({ name }: { name: 'menu' | 'catalog' }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden fill="currentColor">
      {name === 'menu' ? (
        <path d="M3 6h18v2H3zM3 11h18v2H3zM3 16h18v2H3z" />
      ) : (
        <path d="M4.5 3h4.5A1.5 1.5 0 0 1 10.5 4.5V9A1.5 1.5 0 0 1 9 10.5H4.5A1.5 1.5 0 0 1 3 9V4.5A1.5 1.5 0 0 1 4.5 3zM15 3h4.5A1.5 1.5 0 0 1 21 4.5V9a1.5 1.5 0 0 1-1.5 1.5H15A1.5 1.5 0 0 1 13.5 9V4.5A1.5 1.5 0 0 1 15 3zM4.5 13.5H9a1.5 1.5 0 0 1 1.5 1.5v4.5A1.5 1.5 0 0 1 9 21H4.5A1.5 1.5 0 0 1 3 19.5V15a1.5 1.5 0 0 1 1.5-1.5zM15 13.5h4.5A1.5 1.5 0 0 1 21 15v4.5a1.5 1.5 0 0 1-1.5 1.5H15a1.5 1.5 0 0 1-1.5-1.5V15a1.5 1.5 0 0 1 1.5-1.5z" />
      )}
    </svg>
  );
}
