/**
 * The kiosk on the customer's screen: the Android kiosk's flow (core/kioskFlow.ts, a port of
 * domain/KioskFlow.kt) driving the very screens the dashboard's live preview draws
 * (client/src/components/dashboard/kiosks/preview-screens.tsx, through @kiosk-shared) — one code,
 * one look, in every UI style. Everything comes from the local service; nothing here reaches the
 * network.
 */

import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from 'react';
import {
  addMs,
  aspectRatioCss,
  buttonRadius,
  cartPanelShown,
  categoryRailImage,
  ctaBox,
  fontStack,
  catalogColumns,
  kioskAddPath,
  kioskCatalogView,
  kioskOpenAt,
  messagePlacement,
  motionSpec,
  resolveThemeColors,
  typeScaleFactor,
  typeWeights,
  type KioskConfig,
  type KioskTextKey,
  type MessageScreen,
} from '@dash-lib/kioskConfig';
import {
  AttractCta,
  AttractScreen,
  AttractServiceButtons,
  CartScreen,
  CatalogScreen,
  ConfirmSheet,
  Flyer,
  MessageOverlay,
  PausedScreen,
  PayScreen,
  PREVIEW_CSS,
  ProductSheet,
  ServiceScreen,
  SuccessScreen,
  cardStyle,
  type Flight,
  type KioskLive,
  type PCategory,
  type PLine,
  type PProduct,
  type PreviewModel,
  type PreviewScreen,
} from '@kiosk-shared/index';
import {
  backAction,
  busy as flowBusy,
  idle as flowIdle,
  idleCheck,
  INITIAL_FLOW,
  mayCancelPayment,
  reduce,
  rulesOf,
  serviceOnAttract,
  successDone,
  wire,
  type FlowConfigIn,
  type KioskEvent,
  type KioskFlowState,
} from '../../core/kioskFlow';
import { inTechnicianZone, mayOpen as technicianMayOpen, TapSequence } from '../../core/technician';
import type { KioskView, PayProgress } from '../../shared/bridge';
import { kiosk } from '../bridge';
import { formatMoney, t, txtOf } from '../i18n';
import { DetailsScreen, type DetailsValue } from './Details';
import { Dialog } from './Dialog';
import { Keyboard } from './Keyboard';
import { StaffLayer } from '../staff/StaffLayer';

const NO_DETAILS: DetailsValue = { name: '', phone: '', table: '', tipPct: null };
/** The admin's corner (CSS px from the physical top-right). */
const ADMIN_ZONE = 48;

type FlowAction = { event: KioskEvent; cartEmpty: boolean };

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
  const flowReducer = useCallback((s: KioskFlowState, a: FlowAction) => reduce(s, a.event, rulesOf(cfgIn, a.cartEmpty)), [cfgIn]);
  const [flow, dispatchFlow] = useReducer(flowReducer, INITIAL_FLOW);
  const [cart, setCart] = useState<PLine[]>([]);
  const cartRef = useRef(cart);
  cartRef.current = cart;
  const dispatch = useCallback((event: KioskEvent) => dispatchFlow({ event, cartEmpty: cartRef.current.length === 0 }), []);
  const flowRef = useRef(flow);
  flowRef.current = flow;

  const [productId, setProductId] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [details, setDetails] = useState<DetailsValue>(NO_DETAILS);
  const [pay, setPay] = useState<PayProgress | null>(null);
  const [payBlocked, setPayBlocked] = useState<string | null>(null);
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
  const [staffOpen, setStaffOpen] = useState<'none' | 'admin' | 'technician'>('none');
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
  }, [resting]);

  useEffect(() => setVisit((v) => v + 1), [flow.screen]);

  /* -------------------------------------------------------------- payment */

  const startPayment = useCallback(async () => {
    dispatch({ type: 'paymentStarted' });
    setPayBlocked(null);
    const r = await kiosk.startPayment({
      lines: cartRef.current.map((l) => ({ key: l.key, productId: l.product.id, qty: l.qty, options: (l.options ?? []).map((o) => ({ groupId: o.groupId, optionId: o.optionId })), notes: l.note ? [l.note] : [] })),
      service: flowRef.current.service ?? 'take_away',
      customerName: details.name.trim() || null,
      customerPhone: details.phone.trim() || null,
      tableRef: details.table.trim() || null,
      tipPct: details.tipPct,
    });
    if (r.ok) return;
    dispatch({ type: 'paymentDeclined' });
    if (r.reason === 'changed') {
      const removed = new Set(r.changes.filter((c) => c.kind === 'removed').map((c) => c.productId));
      setCart((c) => c.filter((l) => !removed.has(l.product.id)));
      setChanges(r.changes.map((c) => (c.kind === 'removed' ? t('basketRemoved', { name: c.name }) : t('basketRepriced', { name: c.name }))));
      return;
    }
    setPayBlocked(r.message);
  }, [details, dispatch]);

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
  const motion = motionSpec(cfg.theme, cfg.general);
  const colors = resolveThemeColors(cfg.theme);
  const cols = catalogColumns(cfg.theme.gridDensity, wide, panel, side);
  const rules = rulesOf(cfgIn, cart.length === 0);
  const back = () => {
    const a = backAction(flow, rules);
    if (a === 'confirm_leave') setLeaveAsk(true);
    else if (a === 'cancel_payment') void kiosk.cancelPayment();
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
            onCancel: () => void kiosk.cancelPayment(),
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

  const m: PreviewModel = {
    cfg,
    c: colors,
    radius: cfg.theme.cornerRadius,
    btnRadius: buttonRadius(cfg.theme),
    wide,
    cols,
    ratio: aspectRatioCss(cfg.theme.imageRatio),
    font: fontStack(cfg.theme.font),
    txt: (key: KioskTextKey) => txtOf(cfg.texts, key),
    t,
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
    justAddedId: justAdded,
    cartBump,
    setCartTarget,
    panel,
    screen: size,
    ctaBox: ctaBox(cfg.attract.cta, size.w, size.h),
    live,
  };
  live.noteField = (value, onChange) => <NoteField m={m} value={value} onChange={onChange} />;

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
    addLine({ key: `${p.id}-plain`, product: p, qty: 1, unit: p.price, extras: [], options: [] }, from, plain);
  };

  const upsell = useMemo(() => upsellFor(view, cfg, cart, allProducts), [view, cfg, cart, allProducts]);

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
      <div className="relative h-full">
        <div key={screen === 'confirm' ? 'catalog' : screen} className="h-full animate-in fade-in slide-in-from-bottom-2 duration-300">
          {screen === 'attract' ? (
            <AttractScreen m={m} />
          ) : screen === 'service' ? (
            <ServiceScreen m={m} />
          ) : screen === 'catalog' || screen === 'confirm' ? (
            <CatalogScreen m={m} activeCategory={activeCategory} onCategory={setActiveCategory} />
          ) : screen === 'cart' ? (
            <CartScreen m={m} upsell={upsell} />
          ) : screen === 'details' ? (
            <DetailsScreen
              m={m}
              value={details}
              onChange={setDetails}
              onDone={() => dispatch({ type: 'detailsDone' })}
              onBack={flow.pay === 'approved' ? null : back}
              service={flow.service}
              afterPay={flow.pay === 'approved'}
            />
          ) : screen === 'pay' ? (
            <PayScreen m={m} />
          ) : screen === 'success' ? (
            <SuccessScreen m={m} />
          ) : screen === 'setup' ? (
            <RestNote m={m} title={t('setupTitle')} body={t('setupBody')} />
          ) : (
            <PausedScreen m={m} variant={screen === 'closed' ? 'closed' : screen === 'no_payment' ? 'noPayment' : 'paused'} />
          )}
        </div>
        {screen === 'catalog' && product ? (
          <ProductSheet
            key={product.id}
            m={m}
            product={product}
            groups={(view.catalog.groups[product.id] ?? []).map((g) => ({ id: g.id, name: g.name, min: g.min, max: g.max, options: g.options.map((o) => ({ id: o.id, name: o.name, price: o.price })) }))}
            allergens={view.catalog.products.find((p) => p.id === product.id)?.allergens ?? []}
            quickNotes={view.catalog.quickNotes[product.id] ?? []}
            onClose={() => setProductId(null)}
            onAdd={addLine}
          />
        ) : null}
        {screen === 'attract' ? (
          onAttractService ? (
            <AttractServiceButtons m={m} box={m.ctaBox} onPick={(s) => dispatch({ type: 'startWith', service: s })} />
          ) : (
            <AttractCta m={m} box={m.ctaBox} screen={m.screen} />
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
      {toast ? <Toast m={m} text={toast} onDone={() => setToast(null)} /> : null}
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
    imageUrl: p.imageUrl,
    imageLarge: p.imageLarge,
    soldOut,
    description: p.description,
    categoryId: p.categoryId,
    dietaryTags: p.dietaryTags,
  };
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

function NoteField({ m, value, onChange }: { m: PreviewModel; value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="block w-full px-3 py-2.5 text-start text-sm"
        style={{ border: `1px solid ${open ? m.c.button : m.c.border}`, borderRadius: Math.min(m.radius, 14), color: value ? m.c.text : m.c.mutedText }}
      >
        {value || t('notePlaceholder')}
      </button>
      {open ? (
        <KeyboardLazy m={m} onKey={(k) => onChange(k === 'Backspace' ? value.slice(0, -1) : value.length >= 80 ? value : value + k)} />
      ) : null}
    </div>
  );
}

function KeyboardLazy({ m, onKey }: { m: PreviewModel; onKey: (k: string) => void }) {
  return <Keyboard m={m} mode="text" onKey={onKey} />;
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
