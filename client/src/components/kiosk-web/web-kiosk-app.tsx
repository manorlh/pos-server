'use client';

/**
 * The browser kiosk on the customer's screen (`/k`, docs/SPEC_KIOSK.md §27): the Windows kiosk's
 * renderer (kiosk-desktop/src/renderer/kiosk/KioskApp.tsx) for a browser — the same flow
 * (lib/kioskFlow.ts, the port of the Android kiosk's KioskFlow.kt) driving the very screens the
 * dashboard's live preview draws (kiosk-shared), through the same optional `live` hooks. Every
 * config section works as there: theme / uiStyle, motion, layout, ticker, texts, the attract
 * screen and its button, service types, the customer's details, the tip, the review, the checkout
 * steps, paused / closed, help.
 *
 * What differs is the payment: a browser cannot reach a pinpad and writes no tax document, so the
 * checkout always ends on "איך תרצו לשלם?" (kiosk-shared PayMethodStep): "מזומן בקופה" — an open
 * order the shop's tills collect, its number and its QR on the screen (kiosk-shared CashAtTillDone)
 * — and prepaid vouchers redeemed online (scanned, typed, or read by the camera where the browser
 * can). The card's tile is shown greyed ("לא זמין בקיוסק בדפדפן") when the business offers it.
 */

import { layoutOf, productColumns } from '@/lib/kioskLayout';
import { browserFacts, displayProfile, kioskDisplay, kioskDisplayTheme } from '@/lib/displayProfile';
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
  engineMotionSpec,
  engineTransitionSpec,
  kioskMotionEngine,
  resolveThemeColors,
  stepMode,
  payMethodAsk,
  tickerBandPx,
  typeScaleFactor,
  typeWeights,
  type CheckoutStep,
  type KioskConfig,
  type KioskTextKey,
  type MessageScreen,
  type PaymentMethod,
} from '@/lib/kioskConfig';
import {
  AttractCta,
  AttractScreen,
  AttractServiceButtons,
  WaitLogo,
  CartScreen,
  CashAtTillDone,
  ConfirmSheet,
  EntryWindow,
  Flyer,
  KioskBackdrop,
  KioskWallpaper,
  KioskStatusBar,
  KioskSwap,
  MessageOverlay,
  PausedScreen,
  PayScreen,
  PREVIEW_CSS,
  ServiceScreen,
  TickerFrame,
  cardStyle,
  chromeRoot,
  statusLinePx,
  basketPricing,
  lineUnitAgorot,
  orderMealOf,
  orderOptionsOf,
  screenOrder,
  screenSwap,
  AddedToast,
  type EntryStep,
  type Flight,
  type KioskLive,
  type KioskLivePayMethod,
  type PCategory,
  type PGroup,
  type PLine,
  type PMeal,
  type PProduct,
  type PreviewModel,
  type PreviewScreen,
  GuidedFrame,
  defaultsLine,
  LayoutCatalog,
  LayoutProductSheet,
  ReachFrame,
  ReachSheets,
  ReachToggle,
  REACH_STRIP_PX,
  SuccessScreen,
  useKioskRenderProfile,
} from '@/kiosk-shared';
import { configuredText, kioskTextOf, webTextOverride } from '@/lib/kioskTexts';
import { localDateTimeOf, promotionsOf } from '@/lib/kioskMoney';
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
  type KioskFlowRules,
  type KioskFlowState,
} from '@/lib/kioskFlow';
import { webSells, type BasketChange, type WebKioskService, type WebKioskView } from '@/lib/kioskWebService';
import { payFlowEvent, type BridgePayProgress } from '@/lib/kioskBridge';
import { dueAgorot as dueOf, goodsAgorot as goodsOf, newId, orderCode, voucherCodeOf, type OpenOrder, type VoucherLeg, type WebOrderLine } from '@/lib/kioskWebOrders';
import { scannedVoucherCode } from '@/lib/kioskScan';
import { formatMoney, voucherReason, type KioskWords } from './web-i18n';
import { NO_DETAILS, WebDetailsScreen, tipOfDetails, type DetailsValue } from './web-details';
import { WebDialog } from './web-dialog';
import { useWebScanner } from './web-scanner';
import { CameraScanButton, CameraScanner, cameraScanAvailable } from './web-camera';
import { WebStaff, TapSequence, inTechnicianZone } from './web-staff';
import { BridgePairPrompt, bridgePromptDue } from './web-bridge';

/** The strip "POWERED BY R2M POS" takes at the bottom (CSS px). */
const FOOTER_PX = 18;
/** The admin's corner (CSS px from the physical top-right). */
const ADMIN_ZONE = 48;
/** The note window's limit (lib/kioskKeys NOTE_MAX). */
const NOTE_MAX = 80;

type FlowAction = { event: KioskEvent; cartEmpty: boolean };

/** The screens of an order (anything else is rest). */
const RESTING: ReadonlySet<string> = new Set(['attract', 'paused', 'closed', 'no_payment', 'setup']);
/** Where the checkout is left for (the vouchers taken go back, as the till's checkout). */
const LEAVES_CHECKOUT: ReadonlySet<string> = new Set(['attract', 'paused', 'closed', 'no_payment', 'setup', 'service', 'catalog', 'cart', 'confirm']);

function useWindowSize() {
  const [size, setSize] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const on = () => setSize({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', on);
    window.addEventListener('orientationchange', on);
    return () => {
      window.removeEventListener('resize', on);
      window.removeEventListener('orientationchange', on);
    };
  }, []);
  return size;
}

interface PayState {
  vouchers: VoucherLeg[];
  busy: boolean;
  note: string | null;
  error: string | null;
  entry: boolean;
  camera: boolean;
  forfeit: string | null;
  /** The order placed ("מזומן בקופה"). */
  placed: { order: OpenOrder; dueAgorot: number; pending: boolean } | null;
}

const NO_PAY: PayState = { vouchers: [], busy: false, note: null, error: null, entry: false, camera: false, forfeit: null, placed: null };

export function WebKioskApp({ view, svc, words }: { view: WebKioskView; svc: WebKioskService; words: KioskWords }) {
  // "שיתאים את עצמו" (P:/specs/kiosk-landscape-till-mode.md §2, §4): the window read again at every resize or
  // turn; in landscape the side cart where there is room and the rail or the top tabs (lib/displayProfile.ts,
  // the same rules as the Android kiosk). Portrait: the config exactly as it is. The cart and the flow are
  // state, never the layout's — a resize keeps them.
  const raw = useWindowSize();
  const screenProfile = useMemo(
    () => displayProfile(browserFacts(raw.w, raw.h, typeof window !== 'undefined' ? window.devicePixelRatio : 1)),
    [raw.w, raw.h],
  );
  // The screen in its effective dp: a 4K screen at ratio 1 is laid out as full HD and drawn at twice the size
  // (the root's zoom, below); every other screen exactly as its window says.
  const size = useMemo(() => ({ w: screenProfile.widthDp, h: screenProfile.heightDp }), [screenProfile.widthDp, screenProfile.heightDp]);
  const display = useMemo(() => kioskDisplay(screenProfile), [screenProfile]);
  const cfg = useMemo(() => {
    const base = view.config as KioskConfig;
    if (!display.landscape) return base;
    const theme = kioskDisplayTheme(base.theme, display);
    return theme === base.theme ? base : { ...base, theme };
  }, [view.config, display]);
  const cfgIn = cfg as unknown as FlowConfigIn;
  // The card only through a paired Windows bridge (§28, lib/kioskBridge.ts).
  const cardReady = view.pay.usable.includes('card');
  // "איך תרצו לשלם?" by its mode (payment.stepModes.payMethod, payMethodAsk): asked when the browser
  // can sell, unless the card through the bridge is the only way, or the step is off and the card is
  // usable — then straight to the pinpad, as the Windows kiosk; "רשות" may be passed with the default.
  const sells = webSells(view.pay.methods, cardReady);
  const payAsk = payMethodAsk(view.pay.methods, view.pay.usable, stepMode(cfg, 'payMethod'));
  const asks = payAsk.asks;
  const fallbackMethod: 'card' | 'cash_at_till' = payAsk.fallback === 'card' ? 'card' : 'cash_at_till';
  const rulesFor = useCallback((cartEmpty: boolean): KioskFlowRules => ({ ...rulesOf(cfgIn, cartEmpty), asksPayMethod: asks }), [cfgIn, asks]);
  const flowReducer = useCallback((s: KioskFlowState, a: FlowAction) => reduce(s, a.event, rulesFor(a.cartEmpty)), [rulesFor]);
  const [flow, dispatchFlow] = useReducer(flowReducer, INITIAL_FLOW);
  const [cart, setCart] = useState<PLine[]>([]);
  const flowRef = useRef(flow);
  useEffect(() => {
    flowRef.current = flow;
  }, [flow]);
  const cartRef = useRef(cart);
  useEffect(() => {
    cartRef.current = cart;
  }, [cart]);
  const payRef = useRef<PayState>(NO_PAY);
  /** Every voucher of this order back on itself (the order left the checkout before it went to the tills). */
  const giveBackVouchers = useCallback(() => {
    const legs = payRef.current.placed ? [] : payRef.current.vouchers;
    for (const v of legs) void svc.reverseVoucher(v.redemptionId);
  }, [svc]);
  const dispatch = useCallback(
    (event: KioskEvent) => {
      const cartEmpty = cartRef.current.length === 0;
      const next = reduce(flowRef.current, event, rulesFor(cartEmpty));
      if (LEAVES_CHECKOUT.has(next.screen) && !LEAVES_CHECKOUT.has(flowRef.current.screen)) giveBackVouchers();
      dispatchFlow({ event, cartEmpty });
    },
    [rulesFor, giveBackVouchers],
  );

  const [productId, setProductId] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [details, setDetails] = useState<DetailsValue>(NO_DETAILS);
  const detailsRef = useRef(details);
  useEffect(() => {
    detailsRef.current = details;
  }, [details]);
  const [pay, setPay] = useState<PayState>(NO_PAY);
  useEffect(() => {
    payRef.current = pay;
  }, [pay]);
  const [payBlocked, setPayBlocked] = useState<string | null>(null);
  /** A card payment through the bridge, as its kiosk service reports it (§28). */
  const [cardPay, setCardPay] = useState<BridgePayProgress | null>(null);
  /** The method of this order's payment: chosen on "איך תרצו לשלם?", or the card when it is the only one. */
  const methodRef = useRef<'card' | 'cash_at_till' | null>(null);
  const [methodChoice, setMethodChoice] = useState<'card' | 'cash_at_till' | null>(null);
  const chooseMethod = useCallback((m: 'card' | 'cash_at_till') => {
    methodRef.current = m;
    setMethodChoice(m);
  }, []);
  const stopFollow = useRef<(() => void) | null>(null);
  const [successAt, setSuccessAt] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [lastTouch, setLastTouch] = useState(() => Date.now());
  const [leaveAsk, setLeaveAsk] = useState(false);
  const [changes, setChanges] = useState<string[] | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [visit, setVisit] = useState(0);
  const [flights, setFlights] = useState<Flight[]>([]);
  const [justAdded, setJustAdded] = useState<string | null>(null);
  const [cartBump, setCartBump] = useState(0);
  const [staffOpen, setStaffOpen] = useState(false);
  const [bridgePromptClosed, setBridgePromptClosed] = useState(false);
  const [noteEntry, setNoteEntry] = useState<{ caption: string; steps: EntryStep[] } | null>(null);
  const [reachToggled, setReachToggled] = useState(false);
  const [seenScreen, setSeenScreen] = useState(flow.screen);
  const [detailsFromPay, setDetailsFromPay] = useState(false);
  if (seenScreen !== flow.screen) {
    setSeenScreen(flow.screen);
    setDetailsFromPay(flow.screen === 'details' && seenScreen === 'pay');
    setVisit((v) => v + 1);
    // Back to rest: the order's own state cleared; out of the checkout: its vouchers (given back by dispatch).
    if (!LEAVES_CHECKOUT.has(seenScreen) && LEAVES_CHECKOUT.has(flow.screen) && !pay.placed) setPay(NO_PAY);
    if (RESTING.has(flow.screen) && !RESTING.has(seenScreen)) {
      setCart([]);
      setDetails(NO_DETAILS);
      setPay(NO_PAY);
      setPayBlocked(null);
      setCardPay(null);
      setMethodChoice(null);
      setProductId(null);
      setSuccessAt(null);
      setLeaveAsk(false);
      setChanges(null);
      setNoteEntry(null);
      setReachToggled(false);
    }
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
  const voucherAttempt = useRef<{ code: string; id: string } | null>(null);

  /* ---------------------------------------------------------- the catalog */

  const view2 = useMemo(() => kioskCatalogView(view.catalog.categories, view.catalog.products, cfg), [view.catalog, cfg]);
  const required = useCallback((id: string) => (view.catalog.groups[id] ?? []).some((g) => g.min > 0), [view.catalog.groups]);
  // quickAdd "always" (the wall): the dishes whose options' defaults answer what they require (never a meal).
  const answered = useCallback(
    (p: WebKioskView['catalog']['products'][number]) => !p.meal && defaultsLine(p, pGroupsOf(view.catalog.groups[p.id] ?? [])) !== null,
    [view.catalog.groups],
  );
  const catalogImages = useMemo(() => Object.fromEntries(view.catalog.categories.map((c) => [c.id, c.imageUrl])), [view.catalog.categories]);
  const categories: PCategory[] = useMemo(
    () =>
      view2.categories.map((row) => ({
        id: row.category.id,
        name: row.category.name,
        imageUrl: categoryRailImage(
          row.category.id,
          { categoryImages: Object.fromEntries(Object.entries(view.catalog.categoryImages).map(([k, url]) => [k, { url, kind: 'image' as const, sha256: null, bytes: null }])) },
          catalogImages,
        ),
        products: row.products.map((x) => toP(x.product, x.soldOut, required(x.product.id), answered(x.product))),
      })),
    [view2, view.catalog.categoryImages, catalogImages, required, answered],
  );
  const featured = useMemo(() => view2.featured.map((x) => toP(x.product, x.soldOut, required(x.product.id), answered(x.product))), [view2, required, answered]);
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
  // "מבצעים": the basket priced as the till will charge it (lib/kioskMoney.ts — the till's promotions), by the minute.
  const promotions = useMemo(() => promotionsOf(view.catalog.promotions ?? []), [view.catalog.promotions]);
  const minute = Math.floor(nowMs / 60_000);
  const { pricing, priced } = useMemo(
    () => basketPricing(cart, promotions, localDateTimeOf(new Date(minute * 60_000)), (id) => soldById.get(id)?.noDiscount === true),
    [cart, promotions, minute, soldById],
  );
  const pricingRef = useRef(pricing);
  const pricedRef = useRef(priced);
  useEffect(() => {
    pricingRef.current = pricing;
    pricedRef.current = priced;
  }, [pricing, priced]);

  /** The basket as the order carries it (the choices as charged, a meal's components, each line's promotions). */
  const orderLines = useCallback(
    (lines: PLine[]): WebOrderLine[] => {
      const shares = new Map(pricedRef.current.lines.map((x) => [x.id, x] as const));
      return lines.map((l) => {
        const row = soldById.get(l.product.id);
        const share = shares.get(l.key);
        const option = (o: NonNullable<PLine['options']>[number]) => ({
          groupId: o.groupId,
          groupName: o.groupName ?? null,
          kind: o.kind ?? 'addon',
          optionId: o.optionId,
          name: o.name,
          priceAgorot: Math.round(o.price * 100),
          qty: o.qty ?? 1,
          pre: o.pre ?? null,
          ...(o.chargedAgorot !== undefined ? { chargedAgorot: o.chargedAgorot } : {}),
        });
        return {
          key: l.key,
          productId: l.product.id,
          name: l.product.name,
          qty: l.qty,
          baseAgorot: row?.priceAgorot ?? Math.round(l.product.price * 100),
          unitAgorot: lineUnitAgorot(l),
          options: (l.options ?? []).map(option),
          note: l.note?.trim() || null,
          categoryId: l.product.categoryId,
          sku: row?.sku ?? null,
          barcode: row?.barcode ?? null,
          imageUrl: row?.imageUrl ?? null,
          allergens: row?.allergenCodes ?? [],
          meal: l.meal
            ? {
                components: l.meal.components.map((c) => ({
                  slotId: c.slotId,
                  slotName: c.slotName,
                  productId: c.productId,
                  name: c.name,
                  categoryId: soldById.get(c.productId)?.categoryId ?? null,
                  listPriceAgorot: soldById.get(c.productId)?.priceAgorot ?? 0,
                  upchargeAgorot: c.upchargeAgorot,
                  options: c.options.map(option),
                })),
              }
            : null,
          noDiscount: row?.noDiscount === true,
          ...(share && share.promotionAgorot > 0 ? { promotionAgorot: share.promotionAgorot, promotionId: share.promotionId, promotionName: share.promotionName } : {}),
        };
      });
    },
    [soldById],
  );

  /* ---------------------------------------------------- the outside world */

  useEffect(() => {
    dispatch({ type: 'paused', paused: view.state.paused });
  }, [view.state.paused, dispatch]);
  useEffect(() => {
    dispatch({ type: 'terminal', canCharge: !view.state.noPayment });
  }, [view.state.noPayment, dispatch]);
  useEffect(() => {
    const check = () => {
      const d = new Date();
      dispatch({ type: 'hours', open: kioskOpenAt(cfg.hours, d.getDay(), d.getHours() * 60 + d.getMinutes()) });
    };
    check();
    const id = window.setInterval(check, 30_000);
    return () => window.clearInterval(id);
  }, [cfg.hours, dispatch]);

  useEffect(() => {
    svc.reportFlow({ flowState: wire(flow), screen: flow.screen, busy: flowBusy(flow), idle: flowIdle(flow) });
  }, [flow, svc]);

  const resting = RESTING.has(flow.screen);
  // At rest: the method forgotten, a payment no longer followed.
  useEffect(() => {
    if (!resting) return;
    methodRef.current = null;
    stopFollow.current?.();
    stopFollow.current = null;
  }, [resting]);
  useEffect(() => () => stopFollow.current?.(), []);

  /* -------------------------------------------------------------- payment */

  // What the goods cost after the promotions (the tip is on that, as the till's).
  const goodsAgorot = pricing.totalAgorot;
  const tipAgorot = tipOfDetails(details, goodsAgorot);
  const dueNow = dueOf(goodsAgorot, tipAgorot, pay.vouchers);

  /**
   * "מזומן בקופה": the basket checked against the catalog, then the open order to the tills.
   * "אשראי" through the Windows bridge (§28): exactly the Windows kiosk's payment (KioskApp.tsx) —
   * the bridge re-prices the basket from its own catalog, writes the pending document, charges the
   * pinpad, completes or voids the document in its ledger, prints the bon / receipt as the kiosk's
   * config says; the screen follows its progress (waiting for the card, approved, declined, unknown).
   */
  const startPayment = useCallback(async () => {
    // Started by the pay screen's effect: nothing changes before the next tick.
    await Promise.resolve();
    // The card (picked, or the only way): through the bridge.
    if ((methodRef.current ?? fallbackMethod) === 'card') {
      const bridge = svc.bridge;
      dispatch({ type: 'paymentStarted' });
      setPayBlocked(null);
      setCardPay(null);
      if (!bridge) {
        dispatch({ type: 'paymentDeclined' });
        setPayBlocked(words.t('cardOffBrowser'));
        return;
      }
      const lines = cartRef.current;
      const shownAgorot = pricingRef.current.totalAgorot;
      const d = detailsRef.current;
      const r = await bridge.startPayment({
        expectedTotalAgorot: shownAgorot,
        lines: lines.map((l) => ({ key: l.key, productId: l.product.id, qty: l.qty, unitAgorot: lineUnitAgorot(l), options: orderOptionsOf(l), meal: orderMealOf(l), notes: l.note ? [l.note] : [] })),
        service: orderServiceOf(flowRef.current.service, cfgIn),
        customerName: d.name.trim() || null,
        customerPhone: d.phone.trim() || null,
        tableRef: d.table.trim() || null,
        tipPct: d.tipAgorot === null ? d.tipPct : null,
        tipAgorot: d.tipAgorot,
      });
      if (r.kind !== 'ok') {
        dispatch({ type: 'paymentDeclined' });
        setPayBlocked(r.kind === 'offline' ? words.t('bridgeNoAnswer') : (r.message ?? words.t('bridgeNoAnswer')));
        return;
      }
      const out = r.body;
      if (!out.ok) {
        dispatch({ type: 'paymentDeclined' });
        if (out.reason === 'changed' && 'changes' in out) {
          const removed = new Set(out.changes.filter((c) => c.kind === 'removed').map((c) => c.key ?? c.productId));
          const repriced = new Map(out.changes.flatMap((c) => (c.kind === 'repriced' && typeof c.to === 'number' ? [[c.key ?? c.productId, c.to] as const] : [])));
          setCart((c) =>
            c
              .filter((l) => !removed.has(l.key) && !removed.has(l.product.id))
              .map((l) => {
                const to = repriced.get(l.key) ?? repriced.get(l.product.id);
                return to === undefined ? l : { ...l, unit: to / 100, unitAgorot: to };
              }),
          );
          const said = out.changes.map((c) => (c.kind === 'removed' ? words.t('basketRemoved', { name: c.name }) : words.t('basketRepriced', { name: c.name })));
          if (typeof out.totalAgorot === 'number' && out.totalAgorot !== shownAgorot) said.push(words.t('basketNewTotal', { total: formatMoney(out.totalAgorot / 100) }));
          setChanges(said.length > 0 ? said : [words.t('basketNewTotal', { total: formatMoney((out.totalAgorot ?? shownAgorot) / 100) })]);
          return;
        }
        setPayBlocked('message' in out ? out.message : words.t('bridgeNoAnswer'));
        return;
      }
      stopFollow.current?.();
      stopFollow.current = bridge.followPayment(out.orderId, (p) => {
        setCardPay(p);
        const ev = payFlowEvent(p);
        if (ev === 'paymentApproved') setSuccessAt((x) => x ?? Date.now());
        if (ev) dispatch({ type: ev });
      });
      return;
    }
    dispatch({ type: 'paymentStarted' });
    const lines = orderLines(cartRef.current);
    const shownAgorot = goodsOf(lines);
    // What moved, shown before anything goes to the tills: the basket follows it, and the customer
    // goes on from the basket (a voucher already taken goes back with the checkout, to be scanned again).
    const showChanges = (list: readonly BasketChange[], totalAgorot: number | null) => {
      dispatch({ type: 'paymentDeclined' });
      const removed = new Set(list.filter((c) => c.kind === 'removed').map((c) => c.key));
      const repriced = new Map(list.flatMap((c) => (c.kind === 'repriced' ? [[c.key, c.to] as const] : [])));
      setCart((c) => c.filter((l) => !removed.has(l.key)).map((l) => (repriced.has(l.key) ? { ...l, unit: (repriced.get(l.key) ?? 0) / 100, unitAgorot: repriced.get(l.key) ?? 0 } : l)));
      const said = list.map((c) => (c.kind === 'removed' ? words.t('basketRemoved', { name: c.name }) : words.t('basketRepriced', { name: c.name })));
      if (totalAgorot !== null && totalAgorot !== shownAgorot) said.push(words.t('basketNewTotal', { total: formatMoney(totalAgorot / 100) }));
      if (payRef.current.vouchers.length > 0) said.push(words.t('basketVouchersBack'));
      setChanges(said);
    };
    // Even after a voucher: the cloud's word first (kiosk/basket-check), then the catalog as it is now.
    const check = await svc.checkBasket(
      cartRef.current.map((l) => ({ key: l.key, productId: l.product.id, unitAgorot: lineUnitAgorot(l), qty: l.qty, options: orderOptionsOf(l), meal: orderMealOf(l) })),
      shownAgorot,
    );
    if (check.changes.length > 0 || check.totalMoved) {
      showChanges(check.changes, check.totalAgorot);
      return;
    }
    dispatch({ type: 'paymentCharging' });
    // Never left holding the kiosk: anything unexpected is a refusal the customer can go back from.
    const r = await svc
      .placeOpenOrder({
        lines,
        service: orderServiceOf(flowRef.current.service, cfgIn),
        tableRef: details.table.trim() || null,
        customerName: details.name.trim() || null,
        customerPhone: details.phone.trim() || null,
        tipAgorot: tipOfDetails(details, shownAgorot),
        vouchers: payRef.current.vouchers,
      })
      .catch((e: unknown) => ({ ok: false as const, reason: 'error' as const, message: e instanceof Error ? e.message : String(e) }));
    // The cloud prices the basket otherwise (kiosk_open_orders): nothing went to the tills.
    if (!r.ok && r.reason === 'changed') {
      showChanges(r.changes, null);
      return;
    }
    if (!r.ok) {
      dispatch({ type: 'paymentDeclined' });
      setPayBlocked(r.message || words.t('placeFailed'));
      return;
    }
    setPay((p) => ({ ...p, placed: { order: r.order, dueAgorot: r.dueAgorot, pending: r.pending } }));
    dispatch({ type: 'paymentApproved' });
    setSuccessAt(Date.now());
  }, [details, dispatch, orderLines, svc, words, fallbackMethod, cfgIn]);

  // Into the pay screen: the order goes to the tills at once.
  useEffect(() => {
    if (!(flow.screen === 'pay' && flow.pay === 'idle' && cart.length > 0 && !payBlocked)) return;
    // On the next tick (never a state change inside the effect itself).
    const id = window.setTimeout(() => void startPayment(), 0);
    return () => window.clearTimeout(id);
  }, [flow.screen, flow.pay, cart.length, startPayment, payBlocked]);

  /* --------------------------------------------------------------- vouchers */

  /** A kiosk text: the business's, else the built-in one (lib/kioskTexts.ts). */
  const txt = useCallback((key: KioskTextKey) => configuredText(cfg, 'he', key) ?? words.builtin(key), [cfg, words]);

  const redeem = useCallback(
    async (rawCode: string, forfeitRest = false) => {
      const code = scannedVoucherCode(rawCode) ?? voucherCodeOf(rawCode);
      if (!code || payRef.current.busy) return;
      if (!voucherAttempt.current || voucherAttempt.current.code !== code) voucherAttempt.current = { code, id: newId() };
      setPay((p) => ({ ...p, busy: true, error: null, note: words.t('voucherChecking'), entry: false, camera: false, forfeit: null }));
      const r = await svc.redeemVoucher({ code, lines: orderLines(cartRef.current), earlier: payRef.current.vouchers, forfeitRest, clientRequestId: voucherAttempt.current.id });
      if (r.kind === 'ok') {
        voucherAttempt.current = null;
        const legs = [...payRef.current.vouchers, r.leg];
        payRef.current = { ...payRef.current, vouchers: legs };
        setPay((p) => ({ ...p, busy: false, error: null, vouchers: legs, note: words.t('voucherAppliedNote', { amount: formatMoney(r.leg.amountAgorot / 100) }) }));
        // Everything paid by the vouchers (no tip left): the order goes to the tills by itself — once, on this answer.
        const goods = pricingRef.current.totalAgorot;
        if (dueOf(goods, tipOfDetails(detailsRef.current, goods), legs) === 0) {
          chooseMethod('cash_at_till');
          dispatch({ type: 'detailsDone' });
        }
        return;
      }
      const error =
        r.kind === 'offline' ? txt('voucherOffline') : r.kind === 'no_match' ? txt('voucherNoMatch') : r.kind === 'forfeit' ? null : voucherReason(words, r.reason);
      if (r.kind !== 'offline') voucherAttempt.current = r.kind === 'forfeit' ? voucherAttempt.current : null;
      setPay((p) => ({ ...p, busy: false, note: null, error, forfeit: r.kind === 'forfeit' ? code : null }));
    },
    [svc, orderLines, words, txt, dispatch, chooseMethod],
  );

  const atPayMethod = flow.screen === 'details' && flow.detailsNext === 'pay';

  /* ---------------------------------------------------------------- timers */

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  const timers = { inactivitySec: cfg.timers.inactivitySec, warningSec: cfg.timers.warningSec, successSec: cfg.timers.successSec };
  const idleState = idleCheck(flow, lastTouch, nowMs, timers);
  useEffect(() => {
    if (idleState.kind === 'reset') dispatch({ type: 'reset' });
  }, [idleState.kind, dispatch]);
  const doneNow = successDone(flow, successAt, nowMs, timers);
  useEffect(() => {
    if (doneNow) dispatch({ type: 'successDone' });
  }, [doneNow, dispatch]);

  /* -------------------------------------------------------------- the model */

  const wide = size.w >= 600;
  const panel = cartPanelShown(cfg.theme, size.w);
  const side = cfg.theme.categoryLayout !== 'top';
  // "אפקטים": the config's profile, or this device's (prefers-reduced-motion, a slow first-frames probe).
  const profile = useKioskRenderProfile(cfg.motion.effects);
  // "מנוע הנפשות": every event resolved once — the preset, the speed, the events' own values, this profile.
  const engine = useMemo(() => kioskMotionEngine(cfg.motion, cfg.general, profile), [cfg.motion, cfg.general, profile]);
  const motion = engineMotionSpec(engine, cfg.theme);
  const transitions = engineTransitionSpec(engine);
  // The screen change towards this screen: back home by homeReturn, into the basket by cartOpen, else pageTransition.
  const swap = screenSwap(transitions, engine, flow.screen === 'confirm' ? 'catalog' : flow.screen);
  const colors = resolveThemeColors(cfg.theme);
  // "גודל מוצרים" (layout.productSize) moves the density's columns.
  const cols = productColumns(catalogColumns(cfg.theme.gridDensity, wide, panel, side), layoutOf(cfg).productSize, size.w);
  const rules = rulesFor(cart.length === 0);
  const back = () => {
    const a = backAction(flow, rules);
    if (a === 'confirm_leave') setLeaveAsk(true);
    else if (a === 'cancel_payment') void svc.bridge?.cancelPayment();
    else if (a === 'navigate') dispatch({ type: 'back' });
  };
  /** This order's payment is the card's (through the bridge). */
  const cardMode = flow.screen === 'pay' && (methodChoice ?? fallbackMethod) === 'card';

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

  const live: KioskLive = {
    back: flow.screen === 'service' || flow.screen === 'catalog' || flow.screen === 'cart' ? back : undefined,
    startOver: flow.screen === 'catalog' ? () => (cart.length > 0 ? setLeaveAsk(true) : dispatch({ type: 'reset' })) : undefined,
    detailsScreen: true,
    help: () => {
      svc.helpRequest();
      setToast(words.t('helpSent'));
    },
    pay: cardMode
      ? {
          // As the Windows kiosk: "הצמידו כרטיס", the terminal's own lines, cancel while the card is out.
          phase: payBlocked ? 'blocked' : flow.pay === 'idle' ? 'starting' : flow.pay === 'approved' ? 'charging' : flow.pay,
          message: payBlocked ?? cardPay?.message ?? null,
          amount: (cardPay?.amountAgorot ?? goodsAgorot + tipAgorot) / 100,
          canCancel: mayCancelPayment(flow) && !!cardPay?.canCancel,
          cancelling: !!cardPay?.cancelling,
          onCancel: () => void svc.bridge?.cancelPayment(),
          onRetry: () => {
            setPayBlocked(null);
            dispatch({ type: 'retryPayment' });
          },
          onBack: () => {
            setPayBlocked(null);
            dispatch({ type: 'back' });
          },
        }
      : flow.screen === 'pay' && payBlocked
        ? {
            phase: 'blocked',
            message: payBlocked,
            amount: dueNow / 100,
            canCancel: false,
            cancelling: false,
            onCancel: () => undefined,
            onRetry: () => {
              setPayBlocked(null);
              dispatch({ type: 'retryPayment' });
            },
            onBack: () => {
              setPayBlocked(null);
              dispatch({ type: 'back' });
            },
          }
        : undefined,
    // The card's success (the Windows kiosk's screen): the pickup number, the receipt as the config says.
    success:
      flow.screen === 'success' && cardPay && cardPay.phase === 'approved'
        ? {
            pickupLabel: cardPay.pickupLabel ?? '',
            paid: cardPay.amountAgorot / 100,
            receipt: cardPay.receipt ?? 'none',
            onReceipt: (print) => void svc.bridge?.receiptChoice(cardPay.orderId, print),
            secondsLeft: Math.max(0, Math.ceil((cfg.timers.successSec * 1000 - (nowMs - (successAt ?? nowMs))) / 1000)),
            onNewOrder: () => dispatch({ type: 'successDone' }),
          }
        : undefined,
  };

  // The style's status line (tech) takes its height off the top of every screen.
  const statusPx = statusLinePx({ cfg, c: colors });
  const ticker = flow.screen === 'attract' ? tickerBandPx(cfg, 'attract', new Date(nowMs), FOOTER_PX) : { top: 0, bottom: 0 };
  const band = { top: ticker.top + statusPx, bottom: ticker.bottom };
  const attractSize = { w: size.w, h: size.h - band.top - band.bottom };
  const attractBox = ctaBox(cfg.attract.cta, attractSize.w, attractSize.h);
  const ctaOnScreen = band.top > 0 ? { ...attractBox, y: attractBox.y + band.top } : attractBox;
  const m: PreviewModel = {
    cfg,
    // Landscape (lib/displayProfile.ts): the cart and the checkout's steps in two columns, a readable width.
    twoColumns: display.twoColumns,
    contentMaxWidth: display.contentMaxWidthDp,
    c: colors,
    radius: cfg.theme.cornerRadius,
    btnRadius: buttonRadius(cfg.theme),
    wide,
    cols,
    ratio: aspectRatioCss(cfg.theme.imageRatio),
    font: fontStack(cfg.theme.font),
    txt,
    t: (key, values) => webTextOverride(cfg, 'he', key, values) ?? words.t(key, values),
    kt: (key, values) => kioskTextOf(cfg, 'he', key, values),
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
    engine,
    justAddedId: justAdded,
    cartBump,
    setCartTarget,
    panel,
    screen: band.top + band.bottom > 0 ? attractSize : size,
    ctaBox: attractBox,
    light: profile === 'light',
    live,
    quickAdd: (p, from) => {
      // quickAdd "always" (the wall): a dish with a required choice goes in on its options' defaults — a
      // line of its own, as the window adds it; a choice with no default opens the window.
      if (p.addPath !== 'direct') {
        const d = defaultsLine(p, groupsOf(p.id));
        if (!d) return setProductId(p.id);
        addLine({ key: defaultsLineKey(p.id), product: p, qty: 1, unit: d.unitAgorot / 100, unitAgorot: d.unitAgorot, extras: d.texts, options: d.options }, from);
        return;
      }
      const plain = (l: PLine) => l.product.id === p.id && l.extras.length === 0 && !l.note && (l.options?.length ?? 0) === 0;
      addLine({ key: `${p.id}-plain`, product: p, qty: 1, unit: p.price, unitAgorot: p.priceAgorot, extras: [], options: [] }, from, plain);
    },
  };

  const removeFlight = useCallback((flight: Flight) => {
    setFlights((list) => list.filter((f) => f.id !== flight.id));
    if (flight.lands) setCartBump((n) => n + 1);
  }, []);
  const justAddedTimer = useRef<number | null>(null);
  const addLine = (line: PLine, from: DOMRect | null, merge?: (l: PLine) => boolean) => {
    setCart((c) => {
      const i = merge ? c.findIndex(merge) : -1;
      return i >= 0 ? c.map((l, j) => (j === i ? { ...l, qty: l.qty + line.qty } : l)) : [...c, line];
    });
    setJustAdded(line.product.id);
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
  live.noteField = (value, onChange) => (
    <NoteField
      m={m}
      value={value}
      onOpen={() =>
        setNoteEntry({
          caption: txt('detailsCaption'),
          steps: [{ key: 'note', icon: 'note', title: txt('noteTitle'), hint: txt('noteHint'), initial: value, max: NOTE_MAX, confirmLabel: txt('noteSave'), commit: onChange }],
        })
      }
    />
  );

  // The details screen's steps: the tip, the details and (always, when the browser sells) the method.
  const atCheckout = flow.screen === 'details' && (flow.detailsNext === 'pay' || flow.detailsNext === null) && flow.pay !== 'approved';
  const nowSteps: CheckoutStep[] = atCheckout ? checkoutStepsNow(cfg.payment, detailsAsked(cfgIn, flow.service), flow.detailsDone).filter((s) => s !== 'payMethod') : [];
  if (atCheckout && sells && asks) nowSteps.push('payMethod');
  const detailsSteps: CheckoutStep[] = nowSteps.length > 0 ? nowSteps : ['details'];

  const usable = new Set<PaymentMethod>(view.pay.usable);
  const voucherOffered = usable.has('voucher') && dueNow > 0;
  // The card's tile: through the bridge when it takes cards (never with a voucher — one tender per document here).
  const cardOff =
    view.pay.cardOff === 'browser' ? words.t('cardOffBrowser') : view.pay.cardOff !== null ? view.pay.cardOff : pay.vouchers.length > 0 ? words.t('cardWithVoucher') : null;
  const payMethodLive: KioskLivePayMethod | null = detailsSteps.includes('payMethod')
    ? {
        steps: detailsSteps,
        tiles: view.pay.methods.map((method) => ({
          method,
          off: method === 'card' ? cardOff : method === 'voucher' && !usable.has('voucher') ? words.t('voucherOffline') : method === 'voucher' && dueNow === 0 ? txt('voucherApplied') : null,
        })),
        goodsAgorot,
        tipAgorot,
        vouchers: pay.vouchers.map((v) => ({ id: v.redemptionId, serial: v.serial, amountAgorot: v.amountAgorot, label: v.eventName })),
        dueAgorot: dueNow,
        onPick: (method) => {
          setLastTouch(Date.now());
          if (method === 'voucher') setPay((p) => ({ ...p, entry: true, error: null, note: null }));
          else if (method === 'cash_at_till' || (method === 'card' && cardOff === null)) {
            chooseMethod(method);
            dispatch({ type: 'detailsDone' });
          }
        },
        onRemoveVoucher: (id) => {
          void svc.reverseVoucher(id);
          setPay((p) => ({ ...p, vouchers: p.vouchers.filter((v) => v.redemptionId !== id), note: null }));
        },
        busy: pay.busy,
        note: pay.note,
        error: pay.error,
        // "רשות": passed with the default method (never with a voucher waiting to pay the rest by card).
        skip:
          payAsk.optional && payAsk.fallback && payAsk.fallback !== 'voucher' && !(payAsk.fallback === 'card' && cardOff !== null)
            ? {
                method: payAsk.fallback,
                onSkip: () => {
                  setLastTouch(Date.now());
                  chooseMethod(fallbackMethod);
                  dispatch({ type: 'detailsDone' });
                },
              }
            : null,
        extra:
          voucherOffered && cameraScanAvailable() ? (
            <CameraScanButton m={m} label={words.t('voucherCamera')} onClick={() => setPay((p) => ({ ...p, camera: true, error: null }))} />
          ) : undefined,
      }
    : null;


  const scanNote = useWebScanner({
    m,
    screen: flow.screen,
    busy: flowBusy(flow),
    staff: staffOpen,
    sheetOpen: !!product || leaveAsk || !!changes || pay.entry || pay.camera,
    shown: allProducts,
    codes: view.catalog.products,
    screenRef,
    add: (p, from) => m.quickAdd?.(p, from),
    choose: (p) => {
      if (flowRef.current.screen !== 'catalog') dispatch({ type: 'backToCatalog' });
      setProductId(p.id);
    },
    start: () => dispatch({ type: 'start' }),
    serviceOnAttract: serviceOnAttract(cfgIn),
    touch: () => setLastTouch(Date.now()),
    onVoucher: atPayMethod && voucherOffered && !pay.busy ? (code) => void redeem(code) : null,
  });

  const upsellOn = stepMode(cfg, 'upsellSteps') !== 'off';
  const upsell = useMemo(() => (upsellOn ? upsellFor(view, cfg, cart, allProducts) : []), [upsellOn, view, cfg, cart, allProducts]);

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
  const light = profile === 'light';
  // The style's chrome, and the motion engine's press and badge (CSS custom properties on the root).
  const chrome = useMemo(() => chromeRoot({ cfg, c: colors, light, engine }), [cfg, colors, light, engine]);
  const onAttractService = serviceOnAttract(cfgIn);
  const placed = pay.placed;

  return (
    <div
      ref={screenRef}
      dir="rtl"
      className={`k-root relative h-dvh w-screen overflow-hidden select-none ${cfg.general.reduceMotion ? 'k-reduce' : ''} ${chrome.className}`}
      style={{
        ...rootVars,
        ...chrome.style,
        background: colors.background,
        color: colors.text,
        fontFamily: m.font,
        touchAction: 'manipulation',
        // A 4K screen at ratio 1: laid out in its effective size and drawn at the profile's scale.
        ...(screenProfile.scale !== 1 ? { zoom: screenProfile.scale, width: size.w, height: size.h } : {}),
      }}
      onPointerDownCapture={(e) => {
        setLastTouch(Date.now());
        // "ניהול הקיוסק": a 2 s press in the physical top-right corner.
        if (e.clientX > window.innerWidth - ADMIN_ZONE && e.clientY < ADMIN_ZONE) {
          longPress.current = window.setTimeout(() => {
            longPress.current = null;
            swallowClick.current = true;
            if (!flowBusy(flowRef.current) && flowRef.current.screen !== 'pay') setStaffOpen(true);
          }, 2000);
        }
        // The technician's corner: six taps in the physical top-left.
        if (inTechnicianZone(e.clientX, e.clientY) && taps.current.tap(Date.now()) && !flowBusy(flow) && flow.screen !== 'pay') setStaffOpen(true);
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
        if (inTechnicianZone(e.clientX, e.clientY) || swallowClick.current) {
          swallowClick.current = false;
          e.stopPropagation();
          e.preventDefault();
        }
      }}
    >
      <style>{PREVIEW_CSS}</style>
      {view.fontFace ? <style>{view.fontFace}</style> : null}
      {/* "תמונת רקע": once, behind every screen (or only the rest screens), under its veil. */}
      <KioskWallpaper m={m} screen={screen} />
      {/* The style's backdrop pattern (tech): behind every screen. */}
      <KioskBackdrop m={m} />
      <div
        className="relative h-full"
        style={{
          ...(resting ? {} : { paddingBottom: FOOTER_PX + (cfg.layout?.reachToggle ? REACH_STRIP_PX : 0) }),
          ...(statusPx > 0 ? { paddingTop: statusPx } : {}),
        }}
      >
        {/* "שורת מצב" (tech): the state, the order's number and the time, over the screens. */}
        <KioskStatusBar m={m} screen={flow.screen} pickup={flow.screen === 'success' ? (cardPay?.pickupLabel ?? placed?.order.pickupLabel ?? null) : null} />
        <ReachFrame m={m} screen={screen === 'confirm' ? 'catalog' : screen} dish={product} category={activeCategory}>
          {/* "מנוע הנפשות": back home by homeReturn (a fade, never a sharp reset), into the basket by cartOpen. */}
          <KioskSwap
            id={screen === 'confirm' ? 'catalog' : screen}
            {...swap}
            order={screenOrder}
            className="h-full"
            slotClassName="h-full"
            render={(s) => (
              <TickerFrame m={m} screen={s} footerGap={s === 'attract' ? FOOTER_PX : 0}>
                {s === 'attract' ? (
                  <AttractScreen m={m} />
                ) : s === 'service' ? (
                  <GuidedFrame m={m} screen={s}>
                    <ServiceScreen m={m} />
                  </GuidedFrame>
                ) : s === 'catalog' ? (
                  <GuidedFrame m={m} screen={s}>
                    <LayoutCatalog m={m} activeCategory={activeCategory} onCategory={setActiveCategory} />
                  </GuidedFrame>
                ) : s === 'cart' ? (
                  <GuidedFrame m={m} screen={s}>
                    <CartScreen m={m} upsell={upsell} />
                  </GuidedFrame>
                ) : s === 'details' ? (
                  <WebDetailsScreen
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
                    payMethod={payMethodLive}
                  />
                ) : s === 'pay' ? (
                  payBlocked || cardMode ? (
                    <PayScreen m={m} />
                  ) : (
                    <Placing m={m} text={words.t('placing')} />
                  )
                ) : s === 'success' ? (
                  live.success ? (
                    <SuccessScreen m={m} />
                  ) : placed ? (
                    <CashAtTillDone
                      m={m}
                      live={{
                        pickupLabel: placed.order.pickupLabel,
                        dueAgorot: placed.dueAgorot,
                        vouchers: placed.order.vouchers.map((v) => ({ id: v.redemptionId, serial: v.serial, amountAgorot: v.amountAgorot })),
                        code: orderCode(placed.order.localId),
                        pending: placed.pending,
                        secondsLeft: Math.max(0, Math.ceil((cfg.timers.successSec * 1000 - (nowMs - (successAt ?? nowMs))) / 1000)),
                        onNewOrder: () => dispatch({ type: 'successDone' }),
                      }}
                    />
                  ) : (
                    <Placing m={m} text={words.t('placing')} />
                  )
                ) : s === 'setup' ? (
                  <RestNote m={m} title={words.t('setupTitle')} body={words.t('setupBody')} />
                ) : (
                  <PausedScreen m={m} variant={s === 'closed' ? 'closed' : s === 'no_payment' ? 'noPayment' : 'paused'} pause={{ message: view.state.pausedMessage, until: view.state.pausedUntil }} />
                )}
              </TickerFrame>
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
      {/* "נוסף להזמנה" as the badge pops (the engine's toast); the add itself is in the basket already. */}
      {screen === 'catalog' || screen === 'cart' ? <AddedToast m={m} bottom={FOOTER_PX + 88} /> : null}
      <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0.5 z-10 text-center text-[10px] font-medium tracking-[0.12em]" style={{ color: colors.mutedText, opacity: 0.55 }}>
        {words.t('poweredBy')}
      </div>
      {noteEntry && screen === 'catalog' && product ? (
        <EntryWindow m={m} caption={noteEntry.caption} steps={noteEntry.steps} onFinish={() => setNoteEntry(null)} onClose={() => setNoteEntry(null)} />
      ) : null}
      {pay.entry && atPayMethod ? (
        <EntryWindow
          m={m}
          caption={txt('stepPayMethod')}
          steps={[
            {
              key: 'voucher',
              icon: 'note',
              title: txt('voucherTitle'),
              subtitle: txt('voucherHint'),
              hint: 'XXXX XXXX XXXX XXXX',
              initial: '',
              max: 19,
              confirmLabel: txt('voucherApply'),
              check: (v) => (voucherCodeOf(v) ? null : voucherReason(words, 'prepaid_voucher_not_found')),
              commit: (v) => void redeem(v),
            },
          ]}
          onFinish={() => setPay((p) => ({ ...p, entry: false }))}
          onClose={() => setPay((p) => ({ ...p, entry: false }))}
        />
      ) : null}
      {pay.camera && atPayMethod ? (
        <CameraScanner
          m={m}
          title={txt('voucherTitle')}
          hint={words.t('voucherCameraHint')}
          denied={words.t('voucherCameraDenied')}
          onCode={(raw) => {
            setPay((p) => ({ ...p, camera: false }));
            void redeem(raw);
          }}
          onClose={() => setPay((p) => ({ ...p, camera: false }))}
        />
      ) : null}
      {pay.forfeit && atPayMethod ? (
        <WebDialog
          m={m}
          title={txt('voucherTitle')}
          body={txt('voucherForfeit')}
          primary={{ label: words.t('voucherForfeitYes'), onClick: () => void redeem(pay.forfeit ?? '', true) }}
          secondary={{ label: words.t('voucherForfeitNo'), onClick: () => setPay((p) => ({ ...p, forfeit: null })) }}
        />
      ) : null}
      {idleState.kind === 'warn' ? (
        <WebDialog
          m={m}
          title={words.t('idleTitle')}
          body={words.t('idleBody', { n: idleState.secondsLeft })}
          primary={{ label: words.t('idleContinue'), onClick: () => setLastTouch(Date.now()) }}
          secondary={{ label: words.t('idleCancel'), onClick: () => dispatch({ type: 'reset' }) }}
        />
      ) : null}
      {leaveAsk ? (
        <WebDialog
          m={m}
          title={words.t('leaveTitle')}
          body={words.t('leaveBody')}
          primary={{ label: words.t('leaveNo'), onClick: () => setLeaveAsk(false) }}
          secondary={{
            label: words.t('leaveYes'),
            onClick: () => {
              setLeaveAsk(false);
              dispatch({ type: 'reset' });
            },
          }}
        />
      ) : null}
      {changes ? (
        <WebDialog
          m={m}
          title={words.t('basketChangedTitle')}
          body={changes.join('\n')}
          primary={{
            label: words.t('basketOk'),
            onClick: () => {
              setChanges(null);
              dispatch({ type: 'backToCatalog' });
              if (cartRef.current.length > 0 && cfg.general.skipCart === 'off') dispatch({ type: 'openCart' });
            },
          }}
        />
      ) : null}
      {toast ? <Toast m={m} text={toast} onDone={() => setToast(null)} /> : null}
      {scanNote}
      {staffOpen ? <WebStaff m={m} view={view} svc={svc} onClose={() => setStaffOpen(false)} /> : null}
      {/* "גשר לדפדפן": a bridge on this PC, not paired yet — asked once, only at rest (§28). */}
      {!staffOpen && !bridgePromptClosed && bridgePromptDue(view, flow.screen === 'attract', nowMs) ? (
        <BridgePairPrompt m={m} svc={svc} words={words} onClose={() => setBridgePromptClosed(true)} />
      ) : null}
    </div>
  );
}

/** A line's key for a dish put in on its defaults (each tap a line of its own, as the window adds). */
let defaultsLineSeq = 0;
function defaultsLineKey(productId: string): string {
  defaultsLineSeq += 1;
  return `${productId}-defaults-${defaultsLineSeq}`;
}

function toP(p: WebKioskView['catalog']['products'][number], soldOut: boolean, requiredChoice: boolean, defaultsAnswer = false): PProduct {
  return {
    addPath: kioskAddPath(soldOut, p.meal, requiredChoice),
    defaultsAnswer: requiredChoice && defaultsAnswer,
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
function pGroupsOf(groups: WebKioskView['catalog']['groups'][string]): PGroup[] {
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

/** The offers: the kiosk's own rules, else the till's menu upsells (as the Windows kiosk). */
function upsellFor(view: WebKioskView, cfg: KioskConfig, cart: PLine[], all: PProduct[]): PProduct[] {
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

function mealsFor(view: WebKioskView, productId: string, all: PProduct[]): PProduct[] {
  const meals = new Set(view.catalog.products.filter((p) => p.meal).map((p) => p.id));
  const ids = view.catalog.upsells.filter((u) => u.triggerType === 'product' && u.triggerIds.includes(productId)).flatMap((u) => u.productIds).filter((id) => meals.has(id));
  return Array.from(new Set(ids))
    .map((id) => all.find((p) => p.id === id && !p.soldOut))
    .filter((p): p is PProduct => !!p)
    .slice(0, 3);
}

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

/** The order on its way to the tills (a second, or the time the cloud takes to answer). */
function Placing({ m, text }: { m: PreviewModel; text: string }) {
  return (
    <div className="relative flex h-full flex-col items-center justify-center gap-4 p-6 text-center">
      {/* "לוגו במסך התשלום": in the free band above, never moving the spinner. */}
      <div className="absolute inset-x-0 top-6">
        <WaitLogo m={m} />
      </div>
      <span className="h-14 w-14 animate-spin rounded-full border-4" style={{ borderColor: `${m.c.button}33`, borderTopColor: m.c.button }} />
      <p className="text-lg font-bold">{text}</p>
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
