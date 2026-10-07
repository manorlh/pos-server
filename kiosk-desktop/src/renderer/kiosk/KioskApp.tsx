/**
 * The kiosk on the customer's screen: the Android kiosk's flow (core/kioskFlow.ts, a port of
 * domain/KioskFlow.kt) driving the very screens the dashboard's live preview draws
 * (client/src/components/dashboard/kiosks/preview-screens.tsx, through @kiosk-shared) — one code,
 * one look, in every UI style. Everything comes from the local service; nothing here reaches the
 * network.
 */

import { layoutOf, productColumns } from '@dash-lib/kioskLayout';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from 'react';
import { Pencil } from 'lucide-react';
import {
  addMs,
  aspectRatioCss,
  buttonRadius,
  cartPanelShown,
  categoryRailImage,
  checkoutStepsNow,
  ctaBox,
  fontStack,
  catalogColumns,
  kioskAddPath,
  kioskCatalogView,
  kioskOpenAt,
  messagePlacement,
  motionSpec,
  resolveThemeColors,
  transitionSpec,
  stepMode,
  payMethodAsk,
  tickerBandPx,
  typeScaleFactor,
  typeWeights,
  type CheckoutStep,
  type KioskConfig,
  type PaymentMethod,
  type KioskTextKey,
  type MessageScreen,
} from '@dash-lib/kioskConfig';
import {
  AttractCta,
  AttractScreen,
  AttractServiceButtons,
  CartScreen,
  ConfirmSheet,
  EntryWindow,
  Flyer,
  KioskSwap,
  MessageOverlay,
  PausedScreen,
  PayScreen,
  PREVIEW_CSS,
  ServiceScreen,
  SuccessScreen,
  TickerFrame,
  cardStyle,
  basketPricing,
  CashAtTillDone,
  lineUnitAgorot,
  orderMealOf,
  orderOptionsOf,
  screenOrder,
  type Flight,
  type KioskLivePayMethod,
  type PGroup,
  type PMeal,
  type KioskLive,
  type PCategory,
  type PLine,
  type PProduct,
  type PreviewModel,
  type PreviewScreen,
  GuidedFrame,
  LayoutCatalog,
  LayoutProductSheet,
  ReachFrame,
  ReachSheets,
  ReachToggle,
  REACH_STRIP_PX,
} from '@kiosk-shared/index';
import { configuredText, kioskTextOf, webTextOverride } from '@dash-lib/kioskTexts';
import { localDateTimeOf, promotionsOf } from '@dash-lib/kioskMoney';
import { dueAgorot as dueOf, newId, voucherCodeOf, type VoucherLeg } from '@dash-lib/kioskWebOrders';
import {
  backAction,
  busy as flowBusy,
  detailsAsked,
  idle as flowIdle,
  idleCheck,
  INITIAL_FLOW,
  mayCancelPayment,
  reduce,
  rulesOf,
  serviceOnAttract,
  orderServiceOf,
  successDone,
  wire,
  type FlowConfigIn,
  type KioskEvent,
  type KioskFlowState,
} from '../../core/kioskFlow';
import { inTechnicianZone, mayOpen as technicianMayOpen, TapSequence } from '../../core/technician';
import type { BasketChange, KioskView, PayProgress, PlaceOrderOut, StartPaymentIn } from '../../shared/bridge';
import { scannedVoucherCode } from '../../core/kioskScan';
import { kiosk } from '../bridge';
import { formatMoney, t, txtOf, voucherReason } from '../i18n';
import { DetailsScreen, NO_DETAILS, tipOfDetails, type DetailsValue } from './Details';
import { newKioskFunnel, useFunnelObserve } from './useKioskFunnel';
import { BatteryAlerts } from './BatteryAlerts';
import { Dialog } from './Dialog';
import { noteEntry, type EntryRequest } from './EntryWindow';
import { StaffLayer } from '../staff/StaffLayer';
import { useKioskScanner } from './kioskScanner';

/** The strip "POWERED BY R2M POS" takes at the bottom (CSS px). */
const FOOTER_PX = 18;

/** The admin's corner (CSS px from the physical top-right). */
const ADMIN_ZONE = 48;

type FlowAction = { event: KioskEvent; cartEmpty: boolean };

/** "מזומן בקופה" and the vouchers of this order (main/kiosk/payAtTill.ts). */
interface TillState {
  vouchers: VoucherLeg[];
  busy: boolean;
  note: string | null;
  error: string | null;
  /** The voucher's code typed in the kiosk's window. */
  entry: boolean;
  /** A one-time voucher only partly taken: the customer is asked (its code). */
  forfeit: string | null;
  /** The order sent to the tills. */
  placed: Extract<PlaceOrderOut, { ok: true }> | null;
}

const NO_TILL: TillState = { vouchers: [], busy: false, note: null, error: null, entry: false, forfeit: null, placed: null };

/** Screens outside the checkout: an order that reaches one before it went to the tills gives its vouchers back. */
const LEAVES_CHECKOUT: ReadonlySet<string> = new Set(['attract', 'paused', 'closed', 'no_payment', 'setup', 'service', 'catalog', 'cart', 'confirm']);

function useWindowSize() {
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const on = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return size;
}

export function KioskApp({ view }: { view: KioskView }) {
  const cfg = view.config as unknown as KioskConfig;
  const cfgIn = cfg as unknown as FlowConfigIn;
  // "איך תרצו לשלם?" (payment.methods, stepModes.payMethod — payMethodAsk): what this kiosk can take now
  // (the card through its terminal, a voucher online, cash at the till), asked by the step's mode.
  const payInfo = view.pay ?? { methods: ['card'] as PaymentMethod[], usable: (view.state.noPayment ? [] : ['card']) as PaymentMethod[], cardOff: null };
  const payAsk = payMethodAsk(payInfo.methods, payInfo.usable, stepMode(cfg, 'payMethod'));
  const asksPay = payAsk.asks;
  const fallbackMethod: 'card' | 'cash_at_till' = payAsk.fallback === 'cash_at_till' ? 'cash_at_till' : 'card';
  const flowReducer = useCallback((s: KioskFlowState, a: FlowAction) => reduce(s, a.event, { ...rulesOf(cfgIn, a.cartEmpty), asksPayMethod: asksPay }), [cfgIn, asksPay]);
  const [flow, dispatchFlow] = useReducer(flowReducer, INITIAL_FLOW);
  const [cart, setCart] = useState<PLine[]>([]);
  const cartRef = useRef(cart);
  cartRef.current = cart;
  // "ביצועי קיוסקים": the session's funnel (core/kioskFunnel.ts); every flow event noted.
  const [funnel] = useState(newKioskFunnel);
  const dispatch = useCallback(
    (event: KioskEvent) => {
      funnel.noteEvent(event.type);
      dispatchFlow({ event, cartEmpty: cartRef.current.length === 0 });
    },
    [funnel],
  );
  const flowRef = useRef(flow);
  flowRef.current = flow;

  const [productId, setProductId] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [details, setDetails] = useState<DetailsValue>(NO_DETAILS);
  const [pay, setPay] = useState<PayProgress | null>(null);
  const [payBlocked, setPayBlocked] = useState<string | null>(null);
  const [successAt, setSuccessAt] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [till, setTill] = useState<TillState>(NO_TILL);
  const tillRef = useRef(till);
  tillRef.current = till;
  /** This order's method: chosen on "איך תרצו לשלם?", else the fallback (payMethodAsk). */
  const methodRef = useRef<'card' | 'cash_at_till' | null>(null);
  const [lastTouch, setLastTouch] = useState(() => Date.now());
  const [leaveAsk, setLeaveAsk] = useState(false);
  const [changes, setChanges] = useState<string[] | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [visit, setVisit] = useState(0);
  const [flights, setFlights] = useState<Flight[]>([]);
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const [cartBump, setCartBump] = useState(0);
  const [staffOpen, setStaffOpen] = useState<'none' | 'admin' | 'technician'>('none');
  /** The entry window drawn over everything (the product sheet's note). */
  const [entry, setEntry] = useState<EntryRequest | null>(null);
  /** "נגיש": this customer's ♿ (layout.reachToggle), back as configured at rest. */
  const [reachToggled, setReachToggled] = useState(false);
  /** The checkout's step on the details screen (tip / details), for the funnel. */
  const [detailsSub, setDetailsSub] = useState<string | null>(null);
  // Back from the payment to the details screen: its steps open on the last one.
  const [seenScreen, setSeenScreen] = useState(flow.screen);
  const [detailsFromPay, setDetailsFromPay] = useState(false);
  if (seenScreen !== flow.screen) {
    setSeenScreen(flow.screen);
    setDetailsFromPay(flow.screen === 'details' && seenScreen === 'pay');
  }
  const pendingService = useRef<'take_away' | 'eat_in' | null>(null);
  const screenRef = useRef<HTMLDivElement>(null);
  const cartTargetRef = useRef<HTMLDivElement | null>(null);
  const setCartTarget = useCallback((el: HTMLDivElement | null) => {
    cartTargetRef.current = el;
  }, []);
  const flightSeq = useRef(0);
  const taps = useRef(new TapSequence());
  const longPress = useRef<number | null>(null);
  const swallowClick = useRef(false);
  const size = useWindowSize();

  /* ---------------------------------------------------------- the catalog */

  const view2 = useMemo(() => {
    const products = view.catalog.products.map((p) => ({ ...p, available: p.available }));
    return kioskCatalogView(view.catalog.categories, products, cfg);
  }, [view.catalog, cfg]);
  const required = useCallback((id: string) => (view.catalog.groups[id] ?? []).some((g) => g.min > 0), [view.catalog.groups]);
  const catalogImages = useMemo(() => Object.fromEntries(view.catalog.categories.map((c) => [c.id, c.imageUrl])), [view.catalog.categories]);
  const categories: PCategory[] = useMemo(
    () =>
      view2.categories.map((row) => ({
        id: row.category.id,
        name: row.category.name,
        imageUrl: categoryRailImage(row.category.id, { categoryImages: Object.fromEntries(Object.entries(view.catalog.categoryImages).map(([k, url]) => [k, { url, kind: 'image' as const, sha256: null, bytes: null }])) }, catalogImages),
        products: row.products.map((x) => toP(x.product, x.soldOut, required(x.product.id))),
      })),
    [view2, view.catalog.categoryImages, catalogImages, required],
  );
  const featured = useMemo(() => view2.featured.map((x) => toP(x.product, x.soldOut, required(x.product.id))), [view2, required]);
  const allProducts = useMemo(() => categories.flatMap((c) => c.products), [categories]);
  const product = productId ? (allProducts.find((p) => p.id === productId) ?? null) : null;
  /** Every product the kiosk sells (a meal's component may sit in no category shown). */
  const soldById = useMemo(() => new Map(view.catalog.products.map((p) => [p.id, p])), [view.catalog.products]);
  const groupsOf = useCallback((id: string): PGroup[] => pGroupsOf(view.catalog.groups[id] ?? []), [view.catalog.groups]);
  /** A meal's window (menu.meals): each slot's products, a component's groups. */
  const mealOf = useCallback(
    (p: PProduct): PMeal | null => {
      const slots = view.catalog.meals?.[p.id];
      if (!slots || slots.length === 0) return null;
      return {
        slots: slots.map((s) => ({
          id: s.id,
          name: s.name,
          minSelect: s.minSelect,
          maxSelect: s.maxSelect,
          allowRepeat: s.allowRepeat,
          choices: s.choices.flatMap((c) => {
            const x = soldById.get(c.productId);
            return x ? [{ product: toP(x, x.soldOut, false), upchargeAgorot: c.upchargeAgorot, isDefault: c.isDefault }] : [];
          }),
        })),
        groupsOf,
      };
    },
    [view.catalog.meals, soldById, groupsOf],
  );
  // "מבצעים": the basket priced as it will be charged (kioskMoney.ts — the till's promotions), by the minute.
  const promotions = useMemo(() => promotionsOf(view.catalog.promotions ?? []), [view.catalog.promotions]);
  const minute = Math.floor(nowMs / 60_000);
  const { pricing } = useMemo(
    () => basketPricing(cart, promotions, localDateTimeOf(new Date(minute * 60_000)), (id) => soldById.get(id)?.noDiscount === true),
    [cart, promotions, minute, soldById],
  );
  const pricingRef = useRef(pricing);
  pricingRef.current = pricing;

  /* ---------------------------------------------------- the outside world */

  useEffect(() => {
    dispatch({ type: 'paused', paused: view.state.paused });
  }, [view.state.paused, dispatch]);
  // The kiosk sells while it can take money one way it is set to: the card, or cash at the till.
  const sells = payAsk.fallback !== null;
  useEffect(() => {
    dispatch({ type: 'terminal', canCharge: sells });
  }, [sells, dispatch]);
  useEffect(() => {
    const check = () => {
      const d = new Date();
      dispatch({ type: 'hours', open: kioskOpenAt(cfg.hours, d.getDay(), d.getHours() * 60 + d.getMinutes()) });
    };
    check();
    const id = window.setInterval(check, 30_000);
    return () => window.clearInterval(id);
  }, [cfg.hours, dispatch]);

  // The flow, as the cloud's status and the automatic close read it.
  useEffect(() => {
    kiosk.reportFlow({ flowState: wire(flow), screen: flow.screen, busy: flowBusy(flow), idle: flowIdle(flow) });
  }, [flow]);

  // Back to rest: the order's own state cleared.
  const resting = !['service', 'catalog', 'cart', 'confirm', 'details', 'pay', 'success'].includes(flow.screen);
  useEffect(() => {
    if (!resting) return;
    setCart([]);
    setDetails(NO_DETAILS);
    setPay(null);
    setPayBlocked(null);
    setProductId(null);
    setSuccessAt(null);
    setLeaveAsk(false);
    setChanges(null);
    setEntry(null);
    setReachToggled(false);
    setTill(NO_TILL);
    methodRef.current = null;
  }, [resting]);

  // Out of the checkout before the order went to the tills: its vouchers back on themselves.
  const prevScreen = useRef(flow.screen);
  useEffect(() => {
    const was = prevScreen.current;
    prevScreen.current = flow.screen;
    if (was === flow.screen || LEAVES_CHECKOUT.has(was) || !LEAVES_CHECKOUT.has(flow.screen) || tillRef.current.placed) return;
    for (const v of tillRef.current.vouchers) void kiosk.reverseVoucher?.(v.redemptionId);
    setTill(NO_TILL);
    methodRef.current = null;
  }, [flow.screen]);

  useEffect(() => setVisit((v) => v + 1), [flow.screen]);

  /* -------------------------------------------------------------- payment */

  /** The basket as the service takes it (it prices it again from its own catalog). */
  const paymentInput = useCallback(
    (): StartPaymentIn => ({
      // The unit prices and the total the customer saw: never charged if they moved (core/basketCheck.ts).
      expectedTotalAgorot: pricingRef.current.totalAgorot,
      lines: cartRef.current.map((l) => ({ key: l.key, productId: l.product.id, qty: l.qty, unitAgorot: lineUnitAgorot(l), options: orderOptionsOf(l), meal: orderMealOf(l), notes: l.note ? [l.note] : [] })),
      service: orderServiceOf(flowRef.current.service, cfgIn),
      customerName: details.name.trim() || null,
      customerPhone: details.phone.trim() || null,
      tableRef: details.table.trim() || null,
      // The tip asked on its own step: a preset's percent, or "סכום אחר" (whole shekels, in agorot).
      tipPct: details.tipAgorot === null ? details.tipPct : null,
      tipAgorot: details.tipAgorot,
    }),
    [details, cfgIn],
  );

  const startPayment = useCallback(async () => {
    dispatch({ type: 'paymentStarted' });
    setPayBlocked(null);
    // The total the customer saw, after the promotions.
    const shownAgorot = pricingRef.current.totalAgorot;
    funnel.noteTip(tipOfDetails(details, shownAgorot));
    const input = paymentInput();
    // "מזומן בקופה": the order to the shop's tills, with its vouchers (no document here).
    const cash = (methodRef.current ?? fallbackMethod) === 'cash_at_till';
    const r: PlaceOrderOut | Awaited<ReturnType<typeof kiosk.startPayment>> = cash
      ? ((await kiosk.placeOpenOrder?.({ ...input, vouchers: tillRef.current.vouchers })) ?? { ok: false, reason: 'error', message: t('placeFailed') })
      : await kiosk.startPayment(input);
    if (r.ok) {
      if (cash && 'pickupLabel' in r) {
        setTill((p) => ({ ...p, placed: r }));
        dispatch({ type: 'paymentApproved' });
        setSuccessAt(Date.now());
      }
      return;
    }
    funnel.payRefused(r.reason);
    dispatch({ type: 'paymentDeclined' });
    if (r.reason === 'changed' && 'changes' in r) {
      const changed: BasketChange[] = r.changes;
      const removed = new Set(changed.filter((c) => c.kind === 'removed').map((c) => c.key ?? c.productId));
      const repriced = new Map(changed.flatMap((c) => (c.kind === 'repriced' ? [[c.key ?? c.productId, c.to] as const] : [])));
      setCart((c) =>
        c
          .filter((l) => !removed.has(l.key) && !removed.has(l.product.id))
          .map((l) => {
            const to = repriced.get(l.key) ?? repriced.get(l.product.id);
            return to === undefined ? l : { ...l, unit: to / 100, unitAgorot: to };
          }),
      );
      funnel.basketCheck({
        removed: removed.size,
        repriced: repriced.size,
        fromAgorot: shownAgorot,
        toAgorot: r.totalAgorot ?? shownAgorot,
        source: 'cloud',
      });
      const lines = changed.map((c) => (c.kind === 'removed' ? t('basketRemoved', { name: c.name }) : t('basketRepriced', { name: c.name })));
      // The new total, to confirm before anything is charged.
      if (typeof r.totalAgorot === 'number' && r.totalAgorot !== shownAgorot) lines.push(t('basketNewTotal', { total: formatMoney(r.totalAgorot / 100) }));
      // Back to the basket: a voucher already taken goes back with the checkout, to be scanned again.
      if (tillRef.current.vouchers.length > 0) lines.push(t('basketVouchersBack'));
      setChanges(lines.length > 0 ? lines : [t('basketNewTotal', { total: formatMoney((r.totalAgorot ?? shownAgorot) / 100) })]);
      return;
    }
    setPayBlocked('message' in r ? r.message || t('placeFailed') : t('placeFailed'));
  }, [details, dispatch, funnel, paymentInput, fallbackMethod]);

  /* --------------------------------------------------------------- vouchers */

  /** A screen text: the business's, else the built-in one. */
  const screenText = useCallback((key: KioskTextKey) => configuredText(cfg, 'he', key) ?? txtOf(undefined, key), [cfg]);

  const voucherAttempt = useRef<{ code: string; id: string } | null>(null);
  /** A voucher scanned or typed: redeemed online for this basket (the service prices it). */
  const redeem = useCallback(
    async (raw: string, forfeitRest = false) => {
      const code = scannedVoucherCode(raw) ?? voucherCodeOf(raw);
      if (!code || tillRef.current.busy || !kiosk.redeemVoucher) return;
      if (!voucherAttempt.current || voucherAttempt.current.code !== code) voucherAttempt.current = { code, id: newId() };
      setTill((p) => ({ ...p, busy: true, error: null, note: t('voucherChecking'), entry: false, forfeit: null }));
      const r = await kiosk.redeemVoucher({ code, basket: paymentInput(), earlier: tillRef.current.vouchers, forfeitRest, clientRequestId: voucherAttempt.current.id });
      if (r.kind === 'ok') {
        voucherAttempt.current = null;
        const legs = [...tillRef.current.vouchers, r.leg];
        tillRef.current = { ...tillRef.current, vouchers: legs };
        setTill((p) => ({ ...p, busy: false, error: null, vouchers: legs, note: t('voucherAppliedNote', { amount: formatMoney(r.leg.amountAgorot / 100) }) }));
        // Everything paid by the vouchers (no tip left): the order goes to the tills by itself — once, on this answer.
        const goods = pricingRef.current.totalAgorot;
        if (dueOf(goods, tipOfDetails(details, goods), legs) === 0) {
          methodRef.current = 'cash_at_till';
          dispatch({ type: 'detailsDone' });
        }
        return;
      }
      const error =
        r.kind === 'offline' ? screenText('voucherOffline') : r.kind === 'no_match' ? screenText('voucherNoMatch') : r.kind === 'forfeit' ? null : voucherReason(r.reason);
      if (r.kind !== 'offline') voucherAttempt.current = r.kind === 'forfeit' ? voucherAttempt.current : null;
      setTill((p) => ({ ...p, busy: false, note: null, error, forfeit: r.kind === 'forfeit' ? code : null }));
    },
    [details, dispatch, paymentInput, screenText],
  );

  // Into the pay screen: the charge starts at once (as on the till).
  useEffect(() => {
    if (flow.screen === 'pay' && flow.pay === 'idle' && cart.length > 0) void startPayment();
  }, [flow.screen, flow.pay, cart.length, startPayment]);

  useEffect(
    () =>
      kiosk.on('pay', (p) => {
        setPay(p);
        if (p.phase === 'charging') dispatch({ type: 'paymentCharging' });
        else if (p.phase === 'approved') {
          dispatch({ type: 'paymentApproved' });
          setSuccessAt(Date.now());
        } else if (p.phase === 'declined') dispatch({ type: 'paymentDeclined' });
        else if (p.phase === 'unknown') dispatch({ type: 'paymentUnknown' });
      }),
    [dispatch],
  );

  /* ---------------------------------------------------------------- timers */

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const timers = { inactivitySec: cfg.timers.inactivitySec, warningSec: cfg.timers.warningSec, successSec: cfg.timers.successSec };
  const idleState = idleCheck(flow, lastTouch, nowMs, timers);
  useFunnelObserve(funnel, {
    screen: flow.screen,
    sub: flow.screen === 'details' ? detailsSub : null,
    pay: flow.pay,
    service: flow.service,
    basketAgorot: pricing.totalAgorot,
    items: cart.reduce((n, l) => n + l.qty, 0),
    idleWarn: idleState.kind !== 'none',
  });
  useEffect(() => {
    if (idleState.kind === 'reset') dispatch({ type: 'reset' });
  }, [idleState.kind, dispatch]);
  useEffect(() => {
    if (successDone(flow, successAt, nowMs, timers)) dispatch({ type: 'successDone' });
  });

  /* -------------------------------------------------------------- the model */

  const wide = size.w >= 600;
  const panel = cartPanelShown(cfg.theme, size.w);
  const side = cfg.theme.categoryLayout !== 'top';
  const motion = motionSpec(cfg.theme, cfg.general, cfg.motion);
  // "הנפשות ומעברים": the dashboard's choices, all off with reduce motion.
  const transitions = transitionSpec(cfg.motion, cfg.general);
  const colors = resolveThemeColors(cfg.theme);
  // "גודל מוצרים" (layout.productSize) moves the density's columns.
  const cols = productColumns(catalogColumns(cfg.theme.gridDensity, wide, panel, side), layoutOf(cfg).productSize, size.w);
  const rules = { ...rulesOf(cfgIn, cart.length === 0), asksPayMethod: asksPay };
  const back = () => {
    const a = backAction(flow, rules);
    if (a === 'confirm_leave') setLeaveAsk(true);
    else if (a === 'cancel_payment') {
      funnel.noteCancelPayment();
      void kiosk.cancelPayment();
    }
    else if (a === 'navigate') dispatch({ type: 'back' });
  };

  const go = (target: PreviewScreen) => {
    const s = flowRef.current.screen;
    if (target === 'service' || target === 'catalog') {
      if (s === 'attract') dispatch({ type: 'start' });
      else if (s === 'service' && pendingService.current) dispatch({ type: 'chooseService', service: pendingService.current });
      else dispatch({ type: 'backToCatalog' });
    } else if (target === 'cart') dispatch({ type: 'openCart' });
    else if (target === 'pay') dispatch({ type: 'checkout' });
    else if (target === 'attract') dispatch({ type: 'reset' });
  };

  const amount = pay?.amountAgorot ?? 0;
  const live: KioskLive = {
    back: flow.screen === 'service' || flow.screen === 'catalog' || flow.screen === 'cart' ? back : undefined,
    startOver: flow.screen === 'catalog' ? () => (cart.length > 0 ? setLeaveAsk(true) : dispatch({ type: 'reset' })) : undefined,
    detailsScreen: true,
    help: () => {
      funnel.help();
      void kiosk.helpRequest();
      setToast(t('helpSent'));
    },
    pay:
      flow.screen === 'pay'
        ? {
            phase: payBlocked ? 'blocked' : flow.pay === 'idle' ? 'starting' : flow.pay === 'approved' ? 'charging' : flow.pay,
            message: payBlocked ?? pay?.message ?? null,
            amount: amount / 100,
            canCancel: mayCancelPayment(flow) && !!pay?.canCancel,
            cancelling: !!pay?.cancelling,
            onCancel: () => {
              funnel.noteCancelPayment();
              void kiosk.cancelPayment();
            },
            onRetry: () => dispatch({ type: 'retryPayment' }),
            onBack: () => {
              setPayBlocked(null);
              dispatch({ type: 'back' });
            },
          }
        : undefined,
    success:
      flow.screen === 'success' && pay
        ? {
            pickupLabel: pay.pickupLabel ?? '',
            paid: pay.amountAgorot / 100,
            receipt: pay.receipt ?? 'none',
            onReceipt: (print) => void kiosk.receiptChoice(pay.orderId, print),
            secondsLeft: Math.max(0, Math.ceil((cfg.timers.successSec * 1000 - (nowMs - (successAt ?? nowMs))) / 1000)),
            onNewOrder: () => dispatch({ type: 'successDone' }),
          }
        : undefined,
  };

  // "כיתוב רץ" on the attract screen: its start button and the rest are laid out on what the strip leaves.
  const band = flow.screen === 'attract' ? tickerBandPx(cfg, 'attract', new Date(nowMs), FOOTER_PX) : { top: 0, bottom: 0 };
  const attractSize = { w: size.w, h: size.h - band.top - band.bottom };
  const attractBox = ctaBox(cfg.attract.cta, attractSize.w, attractSize.h);
  /** The start button's box over the whole window (below a strip at the top). */
  const ctaOnScreen = band.top > 0 ? { ...attractBox, y: attractBox.y + band.top } : attractBox;
  const m: PreviewModel = {
    cfg,
    c: colors,
    radius: cfg.theme.cornerRadius,
    btnRadius: buttonRadius(cfg.theme),
    wide,
    cols,
    ratio: aspectRatioCss(cfg.theme.imageRatio),
    font: fontStack(cfg.theme.font),
    // Every customer text through the registry (lib/kioskTexts.ts): the business's, else the built-in one.
    txt: (key: KioskTextKey) => configuredText(cfg, 'he', key) ?? txtOf(undefined, key),
    t: (key, values) => webTextOverride(cfg, 'he', key, values) ?? t(key, values),
    kt: (key, values) => kioskTextOf(cfg, 'he', key, values),
    // "רוצים להפוך לארוחה?": the meals the till's upsells offer for a dish.
    mealOptions: (p) => mealsFor(view, p.id, allProducts),
    reach: { toggled: reachToggled, toggle: () => setReachToggled((v) => !v) },
    pricing,
    mealOf,
    money: formatMoney,
    categories,
    featured,
    logoUrl: cfg.theme.logo?.url ?? null,
    brandName: view.brandName,
    nowMs,
    go,
    openProduct: (p) => {
      if (p.soldOut) return;
      funnel.itemOpen(p.id);
      setProductId(p.id);
    },
    cart,
    setCart,
    service: flow.service ?? 'take_away',
    setService: (s) => {
      pendingService.current = s;
    },
    motion,
    transitions,
    justAddedId: justAdded,
    cartBump,
    setCartTarget,
    panel,
    screen: band.top + band.bottom > 0 ? attractSize : size,
    ctaBox: attractBox,
    live,
  };
  live.noteField = (value, onChange) => <NoteField m={m} value={value} onOpen={() => setEntry(noteEntry(m, value, onChange))} />;
  // The details screen: at the checkout, this order's steps before the payment (the tip, the
  // details, in the configured order); asked at another step, the details alone.
  const atCheckout = flow.screen === 'details' && (flow.detailsNext === 'pay' || flow.detailsNext === null) && flow.pay !== 'approved';
  // "איך תרצו לשלם?" (SPEC_KIOSK §23): last, when this kiosk asks it (payMethodAsk).
  const nowSteps: CheckoutStep[] = atCheckout ? checkoutStepsNow(cfg.payment, detailsAsked(cfgIn, flow.service), flow.detailsDone).filter((s) => s !== 'payMethod') : [];
  if (atCheckout && asksPay) nowSteps.push('payMethod');
  const detailsSteps: CheckoutStep[] = nowSteps.length > 0 ? nowSteps : ['details'];
  const goodsAgorot = pricing.totalAgorot;
  const tipNow = tipOfDetails(details, goodsAgorot);
  const dueNow = dueOf(goodsAgorot, tipNow, till.vouchers);
  const atPayMethod = flow.screen === 'details' && flow.detailsNext === 'pay';
  const usable = new Set(payInfo.usable);
  const voucherOffered = usable.has('voucher') && dueNow > 0;
  // The card's tile: never with a voucher (one tender per document here — the rest is paid at the till).
  const cardOff = till.vouchers.length > 0 ? t('cardWithVoucher') : payInfo.cardOff;
  const payMethodLive: KioskLivePayMethod | null = detailsSteps.includes('payMethod')
    ? {
        steps: detailsSteps,
        tiles: payInfo.methods.map((method) => ({
          method,
          off: method === 'card' ? cardOff : method === 'voucher' && !usable.has('voucher') ? t('voucherOffline') : method === 'voucher' && dueNow === 0 ? m.txt('voucherApplied') : null,
        })),
        goodsAgorot,
        tipAgorot: tipNow,
        vouchers: till.vouchers.map((v) => ({ id: v.redemptionId, serial: v.serial, amountAgorot: v.amountAgorot, label: v.eventName })),
        dueAgorot: dueNow,
        onPick: (method) => {
          setLastTouch(Date.now());
          if (method === 'voucher') setTill((p) => ({ ...p, entry: true, error: null, note: null }));
          else if (method === 'cash_at_till' || (method === 'card' && cardOff === null)) {
            methodRef.current = method;
            dispatch({ type: 'detailsDone' });
          }
        },
        onRemoveVoucher: (id) => {
          void kiosk.reverseVoucher?.(id);
          setTill((p) => ({ ...p, vouchers: p.vouchers.filter((v) => v.redemptionId !== id), note: null }));
        },
        busy: till.busy,
        note: till.note,
        error: till.error,
        // "רשות": passed with the default method.
        skip:
          payAsk.optional && payAsk.fallback && payAsk.fallback !== 'voucher' && !(payAsk.fallback === 'card' && cardOff !== null)
            ? {
                method: payAsk.fallback,
                onSkip: () => {
                  setLastTouch(Date.now());
                  methodRef.current = fallbackMethod;
                  dispatch({ type: 'detailsDone' });
                },
              }
            : null,
      }
    : null;
  /** This order's payment goes to the till ("מזומן בקופה"). */
  const cashMode = flow.screen === 'pay' && (methodRef.current ?? fallbackMethod) === 'cash_at_till';

  // As the preview (and the till): a flight that lands bounces the badge then; a reduce-motion fade already did at the tap.
  const removeFlight = useCallback((flight: Flight) => {
    setFlights((list) => list.filter((f) => f.id !== flight.id));
    if (flight.lands) setCartBump((n) => n + 1);
  }, []);
  const justAddedTimer = useRef<number | null>(null);
  /** `merge`: the cart line this one joins (the same plain dish, as on the till). */
  const addLine = (line: PLine, from: DOMRect | null, merge?: (l: PLine) => boolean) => {
    setCart((c) => {
      const i = merge ? c.findIndex(merge) : -1;
      return i >= 0 ? c.map((l, j) => (j === i ? { ...l, qty: l.qty + line.qty } : l)) : [...c, line];
    });
    setJustAdded(line.product.id);
    // From the basket's offers: an upsell taken.
    const fromUpsell = flowRef.current.screen === 'cart' && upsellRef.current.some((u) => u.id === line.product.id);
    funnel.itemAdd(line.product.id, line.qty, fromUpsell, lineUnitAgorot(line));
    if (fromUpsell) funnel.upsell('accepted', 'steps', null, line.product.id);
    if (justAddedTimer.current) window.clearTimeout(justAddedTimer.current);
    justAddedTimer.current = window.setTimeout(() => setJustAdded(null), 900);
    const box = screenRef.current?.getBoundingClientRect();
    const lands = motion.flyMs > 0;
    if (addMs(motion) > 0 && from && box && (!lands || cartTargetRef.current)) {
      flightSeq.current += 1;
      setFlights((list) => [
        ...list.slice(-7),
        { id: flightSeq.current, x: from.left + from.width / 2 - box.left, y: from.top + from.height / 2 - box.top, imageUrl: line.product.imageUrl, name: line.product.name, lands },
      ]);
      if (!lands) setCartBump((n) => n + 1);
    } else {
      setCartBump((n) => n + 1);
    }
    setProductId(null);
    dispatchFlow({ event: { type: 'itemAdded' }, cartEmpty: false });
  };
  m.quickAdd = (p, from) => {
    const plain = (l: PLine) => l.product.id === p.id && l.extras.length === 0 && !l.note && (l.options?.length ?? 0) === 0;
    // At most one plain line per dish (the next joins it), so its key is unique.
    addLine({ key: `${p.id}-plain`, product: p, qty: 1, unit: p.price, unitAgorot: p.priceAgorot, extras: [], options: [] }, from, plain);
  };

  // Barcode scans (a USB HID scanner), 1D and 2D, no button first — the Android kiosk's rules (kioskScanner.tsx).
  const scanNote = useKioskScanner({
    m,
    screen: flow.screen,
    busy: flowBusy(flow),
    staff: staffOpen !== 'none',
    sheetOpen: !!product || leaveAsk || !!changes || till.entry,
    shown: allProducts,
    codes: view.catalog.products,
    screenRef,
    add: (p, from) => m.quickAdd?.(p, from),
    choose: (p) => {
      // The sheet opens over the menu.
      if (flowRef.current.screen !== 'catalog') dispatch({ type: 'backToCatalog' });
      setProductId(p.id);
    },
    start: () => dispatch({ type: 'start' }),
    serviceOnAttract: serviceOnAttract(cfgIn),
    touch: () => setLastTouch(Date.now()),
    // A voucher scanned on "איך תרצו לשלם?" is redeemed there.
    onVoucher: atPayMethod && voucherOffered && !till.busy ? (code) => void redeem(code) : null,
  });

  // "חובה / רשות / כבוי" (payment.stepModes.upsellSteps): the basket's offers are that moment's.
  const upsellOn = stepMode(cfg, 'upsellSteps') !== 'off';
  const upsell = useMemo(() => (upsellOn ? upsellFor(view, cfg, cart, allProducts) : []), [upsellOn, view, cfg, cart, allProducts]);
  const upsellRef = useRef(upsell);
  upsellRef.current = upsell;
  const upsellShown = useRef<string | null>(null);
  useEffect(() => {
    if (flow.screen !== 'cart' || upsell.length === 0) return;
    const key = `${funnel.session}:${visit}`;
    if (upsellShown.current === key) return;
    upsellShown.current = key;
    funnel.upsell('shown', 'steps', null, upsell[0].id);
  }, [flow.screen, upsell, funnel, visit]);

  /* ------------------------------------------------------------ the screen */

  const screen = flow.screen;
  const messageScreen: MessageScreen | null = screen === 'service' || screen === 'catalog' ? screen : screen === 'cart' || screen === 'confirm' ? 'cart' : null;
  const overlay = messageScreen && messagePlacement(messageScreen) === 'overlay-center';
  const weights = typeWeights(cfg.theme.typeWeight);
  const rootVars = {
    '--k-scale': String(typeScaleFactor(cfg.theme.typeScale)),
    '--k-w-body': String(weights.body),
    '--font-weight-medium': String(weights.medium),
    '--font-weight-semibold': String(weights.semibold),
    '--font-weight-bold': String(weights.bold),
    '--font-weight-extrabold': String(weights.extrabold),
    '--font-weight-black': String(weights.black),
  } as CSSProperties;
  const bgImage = cfg.theme.backgroundImage?.url;
  const onAttractService = serviceOnAttract(cfgIn);

  return (
    <div
      ref={screenRef}
      dir="rtl"
      className={`k-root relative h-screen w-screen overflow-hidden select-none ${cfg.general.reduceMotion ? 'k-reduce' : ''}`}
      style={{ ...rootVars, background: colors.background, color: colors.text, fontFamily: m.font }}
      onPointerDownCapture={(e) => {
        setLastTouch(Date.now());
        // "ניהול הקיוסק": a 2 s press in the physical top-right corner (nothing drawn over it).
        if (e.clientX > window.innerWidth - ADMIN_ZONE && e.clientY < ADMIN_ZONE) {
          longPress.current = window.setTimeout(() => {
            longPress.current = null;
            swallowClick.current = true;
            if (technicianMayOpen({ screen: flowRef.current.screen, busy: flowBusy(flowRef.current) }, false)) setStaffOpen('admin');
          }, 2000);
        }
        // The technician's corner: the physical top-left, whatever the language.
        if (inTechnicianZone(e.clientX, e.clientY) && taps.current.tap(Date.now()) && technicianMayOpen({ screen: flow.screen, busy: flowBusy(flow) }, flowBusy(flow))) {
          setStaffOpen('technician');
        }
      }}
      onPointerUpCapture={() => {
        if (longPress.current) window.clearTimeout(longPress.current);
        longPress.current = null;
      }}
      onPointerCancelCapture={() => {
        if (longPress.current) window.clearTimeout(longPress.current);
        longPress.current = null;
      }}
      onClickCapture={(e) => {
        // The technician's corner is for its taps only, and the press that opened the admin is not a tap.
        if (inTechnicianZone(e.clientX, e.clientY) || swallowClick.current) {
          swallowClick.current = false;
          e.stopPropagation();
          e.preventDefault();
        }
      }}
    >
      <style>{PREVIEW_CSS}</style>
      {view.fontFace ? <style>{view.fontFace}</style> : null}
      {bgImage ? (
        <>
          <img src={bgImage} alt="" className="absolute inset-0 h-full w-full object-cover" draggable={false} />
          <div className="absolute inset-0" style={{ background: screen === 'attract' ? `${colors.background}66` : `${colors.background}D9` }} />
        </>
      ) : null}
      {/* The ordering screens end above "POWERED BY R2M POS", so their bottom buttons never sit under it. */}
      <div className="relative h-full" style={resting ? undefined : { paddingBottom: FOOTER_PX + (cfg.layout?.reachToggle ? REACH_STRIP_PX : 0) }}>
        {/* "נגיש" (layout.reach): the screens in the bottom half under a display (kiosk-shared/layouts). */}
        <ReachFrame m={m} screen={screen === 'confirm' ? 'catalog' : screen} dish={product} category={activeCategory}>
        {/* "מעבר בין מסכים": the dashboard's transition; the leaving screen is frozen and takes no taps. */}
        <KioskSwap
          id={screen === 'confirm' ? 'catalog' : screen}
          fx={transitions.screenChange}
          ms={transitions.screenMs}
          order={screenOrder}
          className="h-full"
          slotClassName="h-full"
          render={(s) => (
            // "כיתוב רץ" as the first or last row of the screens without a header bar of their own
            // (on the full-bleed attract screen, a bottom strip stays above "POWERED BY R2M POS").
            <TickerFrame m={m} screen={s} footerGap={s === 'attract' ? FOOTER_PX : 0}>{
            s === 'attract' ? (
              <AttractScreen m={m} />
            ) : s === 'service' ? (
              <GuidedFrame m={m} screen={s}>
                <ServiceScreen m={m} />
              </GuidedFrame>
            ) : s === 'catalog' ? (
              // "מבנה הקיוסק": the layout's menu screen (today's for standard).
              <GuidedFrame m={m} screen={s}>
                <LayoutCatalog m={m} activeCategory={activeCategory} onCategory={setActiveCategory} />
              </GuidedFrame>
            ) : s === 'cart' ? (
              <GuidedFrame m={m} screen={s}>
                <CartScreen m={m} upsell={upsell} />
              </GuidedFrame>
            ) : s === 'details' ? (
              <DetailsScreen
                m={m}
                value={details}
                onChange={setDetails}
                steps={detailsSteps}
                startAtEnd={detailsFromPay}
                goodsAgorot={goodsAgorot}
                onDone={() => dispatch({ type: 'detailsDone' })}
                onBack={flow.pay === 'approved' ? null : back}
                service={flow.service}
                afterPay={flow.pay === 'approved'}
                onStep={setDetailsSub}
                payMethod={payMethodLive}
              />
            ) : s === 'pay' ? (
              cashMode && !payBlocked ? (
                <RestNote m={m} title={t('placing')} body="" />
              ) : (
                <PayScreen m={m} />
              )
            ) : s === 'success' ? (
              till.placed ? (
                // "גשו לקופה לתשלום": the number, what is left to pay, the order's code for the till's scanner.
                <CashAtTillDone
                  m={m}
                  live={{
                    pickupLabel: till.placed.pickupLabel,
                    dueAgorot: till.placed.dueAgorot,
                    vouchers: till.placed.vouchers.map((v) => ({ id: v.redemptionId, serial: v.serial, amountAgorot: v.amountAgorot })),
                    code: till.placed.code,
                    pending: till.placed.pending,
                    secondsLeft: Math.max(0, Math.ceil((cfg.timers.successSec * 1000 - (nowMs - (successAt ?? nowMs))) / 1000)),
                    onNewOrder: () => dispatch({ type: 'successDone' }),
                  }}
                />
              ) : (
                <SuccessScreen m={m} />
              )
            ) : s === 'setup' ? (
              <RestNote m={m} title={t('setupTitle')} body={t('setupBody')} />
            ) : (
              // "יצאתי לנוח… תכף אשוב" (paused / closed): the pause's own message and end, as the cloud sent them.
              <PausedScreen
                m={m}
                variant={s === 'closed' ? 'closed' : s === 'no_payment' ? 'noPayment' : 'paused'}
                pause={{ message: view.state.pausedMessage, until: view.state.pausedUntil }}
              />
            )
            }</TickerFrame>
          )}
        />
        </ReachFrame>
        {screen === 'catalog' && product ? (
          <ReachSheets m={m}>
          <LayoutProductSheet
            key={product.id}
            m={m}
            product={product}
            groups={groupsOf(product.id)}
            allergens={view.catalog.products.find((p) => p.id === product.id)?.allergens ?? []}
            quickNotes={view.catalog.quickNotes[product.id] ?? []}
            onClose={() => setProductId(null)}
            onAdd={addLine}
          />
          </ReachSheets>
        ) : null}
        <ReachToggle m={m} bottom={resting ? FOOTER_PX + 6 : 8} />
        {screen === 'attract' ? (
          onAttractService ? (
            <AttractServiceButtons m={m} box={ctaOnScreen} onPick={(s) => dispatch({ type: 'startWith', service: s })} />
          ) : (
            <AttractCta m={m} box={ctaOnScreen} screen={{ w: size.w, h: size.h - band.bottom }} />
          )
        ) : null}
        {screen === 'confirm' ? <ConfirmSheet m={m} onMore={() => dispatch({ type: 'backToCatalog' })} onPay={() => dispatch({ type: 'checkout' })} /> : null}
        {overlay && messageScreen ? <MessageOverlay key={`${messageScreen}-${visit}`} m={m} screen={messageScreen} suppressed={!!product || screen === 'confirm'} /> : null}
      </div>
      {flights.map((f) => (
        <Flyer key={f.id} flight={f} motion={motion} dp={1} surface={colors.surface} text={colors.text} containerRef={screenRef} targetRef={cartTargetRef} onDone={removeFlight} />
      ))}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0.5 z-10 text-center text-[10px] font-medium tracking-[0.12em]" style={{ color: colors.mutedText, opacity: 0.55 }}>
        {t('poweredBy')}
      </div>
      {/* The product sheet's note: typed in the kiosk's window, over the sheet. */}
      {entry && screen === 'catalog' && product ? (
        <EntryWindow m={m} caption={entry.caption} steps={entry.steps} onFinish={() => setEntry(null)} onClose={() => setEntry(null)} />
      ) : null}
      {idleState.kind === 'warn' ? (
        <Dialog
          m={m}
          title={t('idleTitle')}
          body={t('idleBody', { n: idleState.secondsLeft })}
          primary={{ label: t('idleContinue'), onClick: () => setLastTouch(Date.now()) }}
          secondary={{ label: t('idleCancel'), onClick: () => dispatch({ type: 'reset' }) }}
        />
      ) : null}
      {leaveAsk ? (
        <Dialog
          m={m}
          title={t('leaveTitle')}
          body={t('leaveBody')}
          primary={{ label: t('leaveNo'), onClick: () => setLeaveAsk(false) }}
          secondary={{
            label: t('leaveYes'),
            onClick: () => {
              setLeaveAsk(false);
              dispatch({ type: 'reset' });
            },
          }}
        />
      ) : null}
      {changes ? (
        <Dialog
          m={m}
          title={t('basketChangedTitle')}
          body={changes.join('\n')}
          primary={{
            label: t('basketOk'),
            onClick: () => {
              setChanges(null);
              dispatch({ type: 'backToCatalog' });
              if (cartRef.current.length > 0 && cfg.general.skipCart === 'off') dispatch({ type: 'openCart' });
            },
          }}
        />
      ) : null}
      {/* The voucher's code typed in the kiosk's window ("איך תרצו לשלם?" → שובר). */}
      {till.entry && atPayMethod ? (
        <EntryWindow
          m={m}
          caption={m.txt('stepPayMethod')}
          steps={[
            {
              key: 'voucher',
              icon: 'note',
              title: m.txt('voucherTitle'),
              subtitle: m.txt('voucherHint'),
              hint: 'XXXX XXXX XXXX XXXX',
              initial: '',
              max: 19,
              confirmLabel: m.txt('voucherApply'),
              check: (v) => (voucherCodeOf(v) ? null : voucherReason('prepaid_voucher_not_found')),
              commit: (v) => void redeem(v),
            },
          ]}
          onFinish={() => setTill((p) => ({ ...p, entry: false }))}
          onClose={() => setTill((p) => ({ ...p, entry: false }))}
        />
      ) : null}
      {till.forfeit && atPayMethod ? (
        <Dialog
          m={m}
          title={m.txt('voucherTitle')}
          body={m.txt('voucherForfeit')}
          primary={{ label: t('voucherForfeitYes'), onClick: () => void redeem(till.forfeit ?? '', true) }}
          secondary={{ label: t('voucherForfeitNo'), onClick: () => setTill((p) => ({ ...p, forfeit: null })) }}
        />
      ) : null}
      {toast ? <Toast m={m} text={toast} onDone={() => setToast(null)} /> : null}
      {/* "סוללה חלשה": the strip and the alarm — never over a payment (BatteryAlerts.tsx). */}
      <BatteryAlerts busy={flowBusy(flow) || flow.screen === 'pay'} />
      {scanNote}
      <StaffLayer m={m} view={view} open={staffOpen} onClose={() => setStaffOpen('none')} />
    </div>
  );
}

function toP(p: KioskView['catalog']['products'][number], soldOut: boolean, requiredChoice: boolean): PProduct {
  return {
    addPath: kioskAddPath(soldOut, p.meal, requiredChoice),
    id: p.id,
    name: p.name,
    price: p.price,
    priceAgorot: p.priceAgorot,
    imageUrl: p.imageUrl,
    imageLarge: p.imageLarge,
    soldOut,
    description: p.description,
    categoryId: p.categoryId,
    dietaryTags: p.dietaryTags,
  };
}

/** The catalog's groups as the shared screens take them, with every rule that prices them (kioskMoney.ts). */
function pGroupsOf(groups: KioskView['catalog']['groups'][string]): PGroup[] {
  return groups.map((g) => ({
    id: g.id,
    name: g.name,
    min: g.min,
    max: g.max,
    kind: g.kind,
    freeCount: g.freeCount,
    allowQuantity: g.allowQuantity,
    allowPre: g.allowPre,
    options: g.options.map((o) => ({ id: o.id, name: o.name, price: o.price, priceAgorot: o.priceAgorot, isDefault: o.isDefault, maxQty: o.maxQty })),
  }));
}

/**
 * The offers: the kiosk's own rules ("הצעה", config.upsell — as the preview), else the till's menu
 * upsells; triggered by what is in the cart, never sold out, never in it already.
 */
function upsellFor(view: KioskView, cfg: KioskConfig, cart: PLine[], all: PProduct[]): PProduct[] {
  if (cart.length === 0) return [];
  const inCart = new Set(cart.map((l) => l.product.id));
  const own = (cfg as KioskConfig & { upsell?: { rules?: Array<{ triggerProductIds: string[]; offerProductIds: string[] }> } }).upsell?.rules ?? [];
  if (own.length > 0) {
    const byId = new Map(all.map((p) => [p.id, p]));
    return own
      .filter((r) => r.triggerProductIds.length === 0 || r.triggerProductIds.some((id) => inCart.has(id)))
      .flatMap((r) => r.offerProductIds)
      .map((id) => byId.get(id))
      .filter((p): p is PProduct => !!p && !p.soldOut && !inCart.has(p.id))
      .slice(0, 6);
  }
  const catsInCart = new Set(cart.map((l) => l.product.categoryId).filter(Boolean) as string[]);
  const ids: string[] = [];
  for (const u of view.catalog.upsells) {
    const hit = u.triggerType === 'order' || (u.triggerType === 'product' && u.triggerIds.some((id) => inCart.has(id))) || (u.triggerType === 'category' && u.triggerIds.some((id) => catsInCart.has(id)));
    if (!hit) continue;
    ids.push(...u.productIds);
    for (const c of u.categoryIds) ids.push(...all.filter((p) => p.categoryId === c).map((p) => p.id));
  }
  const byId = new Map(all.map((p) => [p.id, p]));
  return Array.from(new Set(ids))
    .map((id) => byId.get(id))
    .filter((p): p is PProduct => !!p && !p.soldOut && !inCart.has(p.id))
    .slice(0, 4);
}

/** The dish's free note: looks like a field, shows the note; a tap opens the kiosk's window ("הערות למנה"). */
function NoteField({ m, value, onOpen }: { m: PreviewModel; value: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      className="flex w-full items-center gap-2 px-3 py-2.5 text-start text-sm"
      style={{ border: `1px solid ${m.c.border}`, borderRadius: Math.min(m.radius, 14), color: value ? m.c.text : m.c.mutedText, background: m.c.surface }}
    >
      <span className="min-w-0 flex-1 truncate">{value || m.txt('noteHint')}</span>
      <Pencil className="h-4 w-4 shrink-0" style={{ color: m.c.primary }} />
    </button>
  );
}

function RestNote({ m, title, body }: { m: PreviewModel; title: string; body: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
      <span className="h-12 w-12 animate-spin rounded-full border-4" style={{ borderColor: `${m.c.button}33`, borderTopColor: m.c.button }} />
      <h2 className="text-2xl font-extrabold">{title}</h2>
      <p className="text-sm" style={{ color: m.c.mutedText }}>
        {body}
      </p>
    </div>
  );
}

function Toast({ m, text, onDone }: { m: PreviewModel; text: string; onDone: () => void }) {
  useEffect(() => {
    const id = window.setTimeout(onDone, 4000);
    return () => window.clearTimeout(id);
  }, [onDone]);
  return (
    <div className="pointer-events-none absolute inset-x-0 top-1/2 z-[60] flex -translate-y-1/2 justify-center p-6">
      <div className="max-w-[85%] px-5 py-4 text-center text-base font-bold shadow-2xl animate-in fade-in zoom-in-95 duration-200" style={{ ...cardStyle(m), background: m.c.surface }}>
        {text}
      </div>
    </div>
  );
}

/** "רוצים להפוך לארוחה?": the meals the till's upsells offer for a dish (an offered product that is a meal), up to three. */
function mealsFor(view: KioskView, productId: string, all: PProduct[]): PProduct[] {
  const meals = new Set(view.catalog.products.filter((p) => p.meal).map((p) => p.id));
  const ids = view.catalog.upsells.filter((u) => u.triggerType === 'product' && u.triggerIds.includes(productId)).flatMap((u) => u.productIds).filter((id) => meals.has(id));
  return Array.from(new Set(ids))
    .map((id) => all.find((p) => p.id === id && !p.soldOut))
    .filter((p): p is PProduct => !!p)
    .slice(0, 3);
}
