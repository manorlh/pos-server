/**
 * The self-order kiosk's flow — a line-for-line port of the Android till's
 * domain/KioskFlow.kt (pos-server docs/SPEC_KIOSK.md §2), so Windows and Android move the
 * customer the same way:
 *
 *  - attract → service type (skipped when only one) → catalog → product → cart (or "דלג על
 *    סל": straight to payment, or a mini confirm) → details (only when something is asked: the
 *    checkout steps — the customer's details, the tip and "איך תרצו לשלם?", in the configured order)
 *    → payment (the terminal, or the order to the till) → success → back to the attract screen;
 *  - the service is asked once: on its own screen, or (`general.servicePlacement` = attract) by the
 *    two buttons on the attract screen — then never as a step too (nothing else there starts an order);
 *  - nothing resets, pauses or closes the kiosk while a payment is on its way or its result
 *    is unknown — the inactivity timer does not even run there;
 *  - a pause, the opening hours and the terminal's state take effect when the kiosk is idle or
 *    once the customer on it is done — never in the middle of a payment.
 */

import { kioskTipAsked } from '@dash-lib/kioskConfig';

export type KioskScreen =
  | 'setup'
  | 'attract'
  | 'service'
  | 'catalog'
  | 'cart'
  | 'confirm'
  | 'details'
  | 'pay'
  | 'success'
  | 'paused'
  | 'closed'
  | 'no_payment';

export const ORDERING: ReadonlySet<KioskScreen> = new Set(['service', 'catalog', 'cart', 'confirm', 'details', 'pay']);

export type KioskService = 'take_away' | 'eat_in';
export type KioskSkipCart = 'off' | 'direct' | 'confirm';
/** When the customer's details are asked. */
export type KioskDetailsStep = 'after_service' | 'before_cart' | 'before_pay' | 'after_pay';

export type KioskPayPhase = 'idle' | 'starting' | 'charging' | 'approved' | 'declined' | 'unknown';

/** A payment is on its way or unresolved: nothing may reset the kiosk. */
export function holds(p: KioskPayPhase): boolean {
  return p === 'starting' || p === 'charging' || p === 'unknown';
}

export interface KioskFlowState {
  screen: KioskScreen;
  service: KioskService | null;
  pay: KioskPayPhase;
  paused: boolean;
  closed: boolean;
  noPayment: boolean;
  ready: boolean;
  cameFrom: KioskScreen | null;
  detailsDone: boolean;
  detailsNext: KioskScreen | null;
}

export const INITIAL_FLOW: KioskFlowState = {
  screen: 'attract',
  service: null,
  pay: 'idle',
  paused: false,
  closed: false,
  noPayment: false,
  ready: true,
  cameFrom: null,
  detailsDone: false,
  detailsNext: null,
};

export const busy = (s: KioskFlowState) => holds(s.pay);
export const idle = (s: KioskFlowState) => !ORDERING.has(s.screen) && s.screen !== 'success';

export interface KioskFlowRules {
  services: KioskService[];
  skipCart: KioskSkipCart;
  /** Name / phone shown, or eat-in with the table asked (never the tip). */
  asksDetails: (service: KioskService | null) => boolean;
  /** "טיפ לצוות" is asked before the payment (kioskTipAsked): a step of its own on the details screen. */
  asksTip?: boolean;
  /**
   * "איך תרצו לשלם?" is asked right before the payment (the Android kiosk's KioskFlow.asksPayMethod,
   * docs/SPEC_KIOSK.md §23): the details screen hosts it, so the checkout goes there first. Absent: never.
   */
  asksPayMethod?: boolean;
  cartEmpty: boolean;
  detailsStep: KioskDetailsStep;
  /** "לקחת / לשבת" is chosen on the attract screen: no service screen at all — none to start into, none to go back to. */
  serviceOnAttract?: boolean;
}

export type KioskEvent =
  /** The attract button, or a tap anywhere when that is on — nothing with "לקחת / לשבת" on the attract screen (serviceOnAttract). */
  | { type: 'start' }
  | { type: 'startWith'; service: KioskService }
  | { type: 'chooseService'; service: KioskService }
  | { type: 'itemAdded' }
  | { type: 'openCart' }
  | { type: 'backToCatalog' }
  | { type: 'checkout' }
  | { type: 'detailsDone' }
  | { type: 'back' }
  | { type: 'paymentStarted' }
  | { type: 'paymentCharging' }
  | { type: 'paymentApproved' }
  | { type: 'paymentDeclined' }
  | { type: 'paymentUnknown' }
  | { type: 'paymentReleased' }
  | { type: 'retryPayment' }
  | { type: 'successDone' }
  | { type: 'reset' }
  | { type: 'paused'; paused: boolean }
  | { type: 'hours'; open: boolean }
  | { type: 'terminal'; canCharge: boolean }
  | { type: 'ready'; ready: boolean };

export function restingScreen(s: KioskFlowState): KioskScreen {
  if (!s.ready) return 'setup';
  if (s.paused) return 'paused';
  if (s.closed) return 'closed';
  if (s.noPayment) return 'no_payment';
  return 'attract';
}

/** The state the cloud's status knows (kiosk_control.FLOW_STATES). */
export function wire(s: KioskFlowState): string {
  if (holds(s.pay)) return 'paying';
  switch (s.screen) {
    case 'attract':
      return 'attract';
    case 'service':
    case 'catalog':
    case 'cart':
    case 'confirm':
    case 'details':
      return 'ordering';
    case 'pay':
      return 'paying';
    case 'success':
      return 'success';
    case 'paused':
      return 'paused';
    case 'closed':
      return 'closed';
    case 'setup':
      return 'setup';
    case 'no_payment':
      return 'no_payment';
  }
}

/** Only while the charge is starting or on the terminal — never once answered. */
export function mayCancelPayment(s: KioskFlowState): boolean {
  return s.screen === 'pay' && (s.pay === 'starting' || s.pay === 'charging');
}

function rest(s: KioskFlowState): KioskFlowState {
  return { ...s, screen: restingScreen(s), service: null, pay: 'idle', cameFrom: null, detailsDone: false, detailsNext: null };
}

function details(s: KioskFlowState, next: KioskScreen): KioskFlowState {
  return { ...s, screen: 'details', cameFrom: s.screen, detailsNext: next, pay: next === 'success' ? s.pay : 'idle' };
}

function afterService(s: KioskFlowState, r: KioskFlowRules): KioskFlowState {
  if (r.detailsStep === 'after_service' && r.asksDetails(s.service) && !s.detailsDone) return details(s, 'catalog');
  return { ...s, screen: 'catalog' };
}

/**
 * "לתשלום": the details screen first when it has a step now — the details (before the payment, or
 * set for an earlier step and not given yet; never those asked after the payment) or the tip.
 */
function checkout(s: KioskFlowState, r: KioskFlowRules): KioskFlowState {
  if (r.cartEmpty) return s;
  const asks =
    r.asksDetails(s.service) && (r.detailsStep === 'before_pay' ? true : r.detailsStep === 'after_pay' ? false : !s.detailsDone);
  return asks || r.asksTip || r.asksPayMethod ? details(s, 'pay') : { ...s, screen: 'pay', cameFrom: s.screen, pay: 'idle' };
}

export type KioskBackAction = 'navigate' | 'confirm_leave' | 'cancel_payment' | 'blocked' | 'none';

export function backAction(s: KioskFlowState, r: KioskFlowRules): KioskBackAction {
  if (s.screen === 'pay') {
    if (s.pay === 'charging') return 'cancel_payment';
    if (holds(s.pay) || s.pay === 'approved') return 'blocked';
    return 'navigate';
  }
  if (s.screen === 'details' && s.pay === 'approved') return 'blocked';
  const next = reduce(s, { type: 'back' }, r);
  if (sameState(next, s)) return 'none';
  const dropsOrder = ORDERING.has(s.screen) && !ORDERING.has(next.screen) && next.screen !== 'success';
  return dropsOrder && !r.cartEmpty ? 'confirm_leave' : 'navigate';
}

export function sameState(a: KioskFlowState, b: KioskFlowState): boolean {
  return (Object.keys(a) as (keyof KioskFlowState)[]).every((k) => a[k] === b[k]);
}

const inSet = (screen: KioskScreen, list: KioskScreen[]) => list.includes(screen);

export function reduce(s: KioskFlowState, e: KioskEvent, r: KioskFlowRules): KioskFlowState {
  switch (e.type) {
    case 'start':
      if (s.screen !== 'attract') return s;
      if (r.services.length <= 1) return afterService({ ...s, service: r.services[0] ?? null, cameFrom: 'attract' }, r);
      // "לקחת / לשבת" are the attract screen's own buttons (startWith): asked there or as a step, never both.
      if (r.serviceOnAttract) return s;
      return { ...s, screen: 'service', cameFrom: 'attract' };
    case 'startWith':
      if (s.screen !== 'attract' || !r.services.includes(e.service)) return s;
      return afterService({ ...s, service: e.service, cameFrom: 'attract' }, r);
    case 'chooseService':
      if (s.screen !== 'service' || !r.services.includes(e.service)) return s;
      return afterService({ ...s, service: e.service, cameFrom: 'service' }, r);
    case 'itemAdded':
      if (s.screen !== 'catalog') return s;
      if (r.skipCart === 'off') return s;
      if (r.skipCart === 'direct') return checkout(s, r);
      return r.cartEmpty ? s : { ...s, screen: 'confirm', cameFrom: 'catalog' };
    case 'openCart':
      if (!inSet(s.screen, ['catalog', 'confirm']) || r.cartEmpty) return s;
      if (r.detailsStep === 'before_cart' && r.asksDetails(s.service) && !s.detailsDone) return details(s, 'cart');
      return { ...s, screen: 'cart', cameFrom: s.screen };
    case 'backToCatalog':
      if (inSet(s.screen, ['cart', 'confirm', 'details']) || (s.screen === 'pay' && !holds(s.pay) && s.pay !== 'approved')) {
        return { ...s, screen: 'catalog', pay: 'idle', cameFrom: null };
      }
      return s;
    case 'checkout':
      return inSet(s.screen, ['cart', 'confirm', 'catalog']) ? checkout(s, r) : s;
    case 'detailsDone': {
      if (s.screen !== 'details') return s;
      const next = s.detailsNext ?? 'pay';
      if (next === 'success') return { ...s, screen: 'success', detailsDone: true, detailsNext: null };
      // Before the payment with the details asked after it: only the tip was here — they are still to come.
      if (next === 'pay') return r.cartEmpty ? s : { ...s, screen: 'pay', pay: 'idle', detailsDone: r.detailsStep === 'after_pay' ? s.detailsDone : true, detailsNext: null };
      return { ...s, screen: next, detailsDone: true, detailsNext: null, cameFrom: 'details' };
    }
    case 'back':
      return back(s, r);
    case 'paymentStarted':
      return s.screen === 'pay' && (s.pay === 'idle' || s.pay === 'declined') ? { ...s, pay: 'starting' } : s;
    case 'paymentCharging':
      return s.screen === 'pay' && s.pay === 'starting' ? { ...s, pay: 'charging' } : s;
    case 'paymentApproved':
      // An approval is never lost, whatever the screen thinks: it is money taken.
      if (r.detailsStep === 'after_pay' && r.asksDetails(s.service) && !s.detailsDone && s.screen === 'pay') {
        return { ...s, screen: 'details', pay: 'approved', cameFrom: null, detailsNext: 'success' };
      }
      return { ...s, screen: 'success', pay: 'approved', cameFrom: null };
    case 'paymentDeclined':
      return s.screen === 'pay' && s.pay !== 'approved' ? { ...s, pay: 'declined' } : s;
    case 'paymentUnknown':
      return s.pay !== 'approved' ? { ...s, screen: 'pay', pay: 'unknown' } : s;
    case 'paymentReleased':
      return s.pay === 'unknown' ? { ...s, pay: 'declined' } : s;
    case 'retryPayment':
      return s.screen === 'pay' && s.pay === 'declined' ? { ...s, pay: 'idle' } : s;
    case 'successDone':
      return s.screen === 'success' ? rest(s) : s;
    case 'reset':
      return holds(s.pay) ? s : rest(s);
    case 'paused':
      return settle({ ...s, paused: e.paused });
    case 'hours':
      return settle({ ...s, closed: !e.open });
    case 'terminal':
      return settle({ ...s, noPayment: !e.canCharge });
    case 'ready':
      return settle({ ...s, ready: e.ready });
  }
}

/** A flag changed: an idle kiosk shows it now; a customer on it finishes first. */
function settle(s: KioskFlowState): KioskFlowState {
  return idle(s) ? { ...s, screen: restingScreen(s) } : s;
}

function back(s: KioskFlowState, r: KioskFlowRules): KioskFlowState {
  switch (s.screen) {
    case 'service':
      return rest(s);
    case 'catalog':
      return r.services.length > 1 && !r.serviceOnAttract ? { ...s, screen: 'service', cameFrom: 'attract' } : rest(s);
    case 'cart':
    case 'confirm':
      return { ...s, screen: 'catalog', cameFrom: null };
    case 'details': {
      if (s.pay === 'approved') return s;
      if (s.cameFrom === 'attract') return rest(s);
      if (s.cameFrom === 'service') return r.serviceOnAttract ? rest(s) : { ...s, screen: 'service', cameFrom: 'attract', detailsNext: null };
      const to: KioskScreen = s.cameFrom && s.cameFrom !== 'details' ? s.cameFrom : 'cart';
      const next: KioskFlowState = { ...s, screen: to, cameFrom: null, detailsNext: null };
      return next.screen === 'cart' && r.skipCart !== 'off' ? { ...next, screen: 'catalog' } : next;
    }
    case 'pay':
      if (holds(s.pay) || s.pay === 'approved') return s;
      if ((r.detailsStep === 'before_pay' && r.asksDetails(s.service)) || r.asksTip || r.asksPayMethod) return { ...s, screen: 'details', pay: 'idle', detailsNext: 'pay' };
      return { ...s, screen: r.skipCart === 'off' ? 'cart' : 'catalog', pay: 'idle' };
    case 'success':
      return rest(s);
    default:
      return s;
  }
}

/* ------------------------------------------------------------- idle timer */

export type KioskIdle = { kind: 'none' } | { kind: 'warn'; secondsLeft: number } | { kind: 'reset' };

export interface KioskTimers {
  inactivitySec: number;
  warningSec: number;
  successSec: number;
}

/** Never on payment in flight, never on rest screens. */
export function idleTimerRunsOn(s: KioskFlowState): boolean {
  switch (s.screen) {
    case 'service':
    case 'catalog':
    case 'cart':
    case 'confirm':
    case 'details':
      return true;
    case 'pay':
      return s.pay === 'declined';
    default:
      return false;
  }
}

export function idleCheck(s: KioskFlowState, lastTouchMs: number, nowMs: number, t: KioskTimers): KioskIdle {
  if (!idleTimerRunsOn(s)) return { kind: 'none' };
  const idleMs = Math.max(0, nowMs - lastTouchMs);
  const warnAt = t.inactivitySec * 1000;
  const resetAt = warnAt + t.warningSec * 1000;
  if (idleMs >= resetAt) return { kind: 'reset' };
  if (idleMs >= warnAt) return { kind: 'warn', secondsLeft: Math.max(1, Math.ceil((resetAt - idleMs) / 1000)) };
  return { kind: 'none' };
}

export function successDone(s: KioskFlowState, successAtMs: number | null, nowMs: number, t: KioskTimers): boolean {
  return s.screen === 'success' && successAtMs !== null && nowMs - successAtMs >= t.successSec * 1000;
}

/* --------------------------------------------------------- rules from cfg */

export interface FlowConfigIn {
  general: { serviceTypes: string[]; skipCart: string; askTableNumber: boolean; servicePlacement?: string };
  payment: {
    customerName: string;
    customerPhone: string;
    tipEnabled: boolean;
    tipPresets?: number[];
    tipOther?: boolean;
    detailsStep?: string;
    tableNumber?: string;
    /** "חובה / רשות / כבוי" per step (kioskConfig.ts stepMode, docs/SPEC_KIOSK_INSIGHTS.md §4). */
    stepModes?: Partial<Record<string, string>>;
  };
}

const DETAILS_STEPS: KioskDetailsStep[] = ['after_service', 'before_cart', 'before_pay', 'after_pay'];

export function detailsStepOf(cfg: FlowConfigIn): KioskDetailsStep {
  const v = cfg.payment.detailsStep;
  return DETAILS_STEPS.includes(v as KioskDetailsStep) ? (v as KioskDetailsStep) : 'before_pay';
}

export function servicesOf(cfg: FlowConfigIn): KioskService[] {
  const list = (cfg.general.serviceTypes ?? []).filter((s): s is KioskService => s === 'take_away' || s === 'eat_in');
  // "כבוי" (stepModes.service): never asked — every order is the first type.
  if (list.length > 1 && cfg.payment.stepModes?.service === 'off') return [list[0]];
  return list.length > 0 ? list : ['take_away'];
}

/** `general.servicePlacement = attract` with two services: "לקחת / לשבת" on the attract screen. */
export function serviceOnAttract(cfg: FlowConfigIn): boolean {
  return cfg.general.servicePlacement === 'attract' && servicesOf(cfg).length > 1;
}

const shown = (v: string | undefined) => v === 'optional' || v === 'required';

/** The customer's details are asked for `service`: the name or the phone shown, or eat-in with the table asked. */
export function detailsAsked(cfg: FlowConfigIn, service: KioskService | null): boolean {
  return (
    shown(cfg.payment.customerName) ||
    shown(cfg.payment.customerPhone) ||
    (service === 'eat_in' && (cfg.general.askTableNumber || shown(cfg.payment.tableNumber)))
  );
}

/** KioskFlowRules.of: what is asked, by the config. */
export function rulesOf(cfg: FlowConfigIn, cartEmpty: boolean): KioskFlowRules {
  const step = detailsStepOf(cfg);
  const skip = (['off', 'direct', 'confirm'] as const).includes(cfg.general.skipCart as KioskSkipCart) ? (cfg.general.skipCart as KioskSkipCart) : 'off';
  return {
    services: servicesOf(cfg),
    skipCart: skip,
    asksDetails: (service) => detailsAsked(cfg, service),
    asksTip:
      kioskTipAsked({ tipEnabled: cfg.payment.tipEnabled, tipPresets: cfg.payment.tipPresets ?? [], tipOther: cfg.payment.tipOther ?? true }) &&
      cfg.payment.stepModes?.tip !== 'off',
    cartEmpty,
    detailsStep: step,
    serviceOnAttract: serviceOnAttract(cfg),
  };
}
