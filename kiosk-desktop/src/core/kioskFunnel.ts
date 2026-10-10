/**
 * "ביצועי קיוסקים": the kiosk's anonymous funnel (pos-server docs/SPEC_KIOSK_INSIGHTS.md §1) — the
 * same events the Android kiosk records (pos-android domain/KioskFunnel.kt).
 *
 * A session is one customer: from the first tap on the attract screen until the kiosk is back at
 * rest. The tracker watches the flow (`observe`, on every change) and turns it into events —
 * session start, each screen (and the checkout's own steps), the payment's life, the end and why —
 * while the screens tell it what only they know (an item opened or added, an upsell, the basket
 * check, a help request). Each event carries its session's id, a sequence number and the time
 * since the first tap (a monotonic clock, so a clock change never bends a duration). Nothing
 * personal: product and rule ids, steps, amounts, reasons.
 *
 * The cloud stores them idempotently by (session, seq) — `POST /sync/{m}/kiosk/events`.
 */

export type FunnelEventType =
  | 'session_start'
  | 'screen'
  | 'item_open'
  | 'item_add'
  | 'upsell'
  | 'pay'
  | 'basket_check'
  | 'help'
  | 'session_end';

/** The cloud's kiosk_funnel.STEPS. */
export type FunnelStep =
  | 'attract'
  | 'service'
  | 'catalog'
  | 'item'
  | 'cart'
  | 'confirm'
  | 'details'
  | 'tip'
  | 'pay_method'
  | 'pay'
  | 'success';

export type FunnelEndReason = 'paid' | 'abandoned' | 'timeout' | 'cancelled' | 'help' | 'reset';
export type FunnelPayResult = 'started' | 'approved' | 'declined' | 'cancelled' | 'error' | 'unknown';
export type FunnelUpsellAction = 'shown' | 'accepted' | 'declined' | 'dismissed';
export type FunnelUpsellMoment = 'item' | 'steps' | 'checkout';

export interface FunnelEvent {
  sessionId: string;
  seq: number;
  type: FunnelEventType;
  at: string;
  step?: FunnelStep;
  elapsedMs?: number;
  data?: Record<string, string | number | boolean>;
}

/** What the tracker watches: the flow as it stands, and the basket. */
export interface FunnelSnapshot {
  screen: string;
  /** The checkout's step on the details screen ('tip' | 'details' | 'pay_method'), when there. */
  sub?: string | null;
  pay: 'idle' | 'starting' | 'charging' | 'approved' | 'declined' | 'unknown';
  service: 'take_away' | 'eat_in' | null;
  basketAgorot: number;
  items: number;
  /** The inactivity warning is up (a reset that follows is a timeout). */
  idleWarn: boolean;
}

const ORDERING = new Set(['service', 'catalog', 'cart', 'confirm', 'details', 'pay', 'success']);
const SCREEN_STEP: Record<string, FunnelStep> = {
  attract: 'attract',
  service: 'service',
  catalog: 'catalog',
  cart: 'cart',
  confirm: 'confirm',
  details: 'details',
  pay: 'pay',
  success: 'success',
};

/** The funnel's step for a screen (and the details screen's own step). */
export function funnelStepOf(screen: string, sub?: string | null): FunnelStep | null {
  if (screen === 'details') {
    if (sub === 'tip') return 'tip';
    if (sub === 'payMethod' || sub === 'pay_method') return 'pay_method';
    return 'details';
  }
  return SCREEN_STEP[screen] ?? null;
}

/** Why a session that went back to rest ended (paid wins; then help; then what moved it). */
export function endReasonOf(s: { paid: boolean; helped: boolean; lastEvent: string | null; idleWarn: boolean; staff: boolean }): FunnelEndReason {
  if (s.paid) return 'paid';
  if (s.staff) return 'reset';
  if (s.idleWarn) return 'timeout';
  if (s.helped) return 'help';
  if (s.lastEvent === 'back') return 'abandoned';
  if (s.lastEvent === 'reset') return 'cancelled';
  return 'abandoned';
}

export interface FunnelClock {
  now(): number;
  mono(): number;
}

const SYSTEM_CLOCK: FunnelClock = {
  now: () => Date.now(),
  mono: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
};

export class FunnelTracker {
  private sessionId: string | null = null;
  private seq = 0;
  private startedMono = 0;
  private last: FunnelSnapshot | null = null;
  private lastStep: FunnelStep | null = null;
  private paid = false;
  private helped = false;
  private lastEvent: string | null = null;
  private staff = false;
  private payCancel = false;
  private tip = 0;

  constructor(
    private readonly sink: (events: FunnelEvent[]) => void,
    private readonly newId: () => string,
    private readonly platform: 'windows' | 'android' = 'windows',
    private readonly clock: FunnelClock = SYSTEM_CLOCK,
  ) {}

  get session(): string | null {
    return this.sessionId;
  }

  private ev(type: FunnelEventType, step: FunnelStep | null, data?: Record<string, string | number | boolean | null | undefined>): FunnelEvent | null {
    if (!this.sessionId) return null;
    const clean: Record<string, string | number | boolean> = {};
    for (const [k, v] of Object.entries(data ?? {})) if (v !== null && v !== undefined) clean[k] = v;
    const e: FunnelEvent = {
      sessionId: this.sessionId,
      seq: this.seq++,
      type,
      at: new Date(this.clock.now()).toISOString(),
      elapsedMs: Math.max(0, Math.round(this.clock.mono() - this.startedMono)),
    };
    if (step) e.step = step;
    if (Object.keys(clean).length > 0) e.data = clean;
    return e;
  }

  private emit(...events: Array<FunnelEvent | null>) {
    const out = events.filter((e): e is FunnelEvent => e !== null);
    if (out.length > 0) this.sink(out);
  }

  /** The flow's own event (KioskEvent.type), so the end can say what moved it. */
  noteEvent(type: string) {
    this.lastEvent = type;
  }

  /** An employee reset the kiosk (staff screen): the session ends as "reset". */
  noteStaffReset() {
    this.staff = true;
  }

  /** The customer asked to cancel the card on the terminal: a decline that follows is "cancelled". */
  noteCancelPayment() {
    this.payCancel = true;
  }

  /** The tip chosen, for the session's end. */
  noteTip(agorot: number) {
    this.tip = Math.max(0, Math.round(agorot));
  }

  observe(s: FunnelSnapshot) {
    const prev = this.last;
    this.last = s;
    const ordering = ORDERING.has(s.screen);
    if (!this.sessionId) {
      if (!ordering || (prev && ORDERING.has(prev.screen))) return;
      // The first tap: a new session.
      this.sessionId = this.newId();
      this.seq = 0;
      this.startedMono = this.clock.mono();
      this.paid = false;
      this.helped = false;
      this.staff = false;
      this.payCancel = false;
      this.tip = 0;
      this.lastStep = null;
      this.emit(this.ev('session_start', 'attract', { platform: this.platform, service: s.service ?? undefined }));
    }
    if (!ordering) {
      // Back to rest: the end, and why.
      const reason = endReasonOf({ paid: this.paid, helped: this.helped, lastEvent: this.lastEvent, idleWarn: !!prev?.idleWarn, staff: this.staff });
      const before = prev ?? s;
      this.emit(
        this.ev('session_end', this.paid ? 'success' : (this.lastStep ?? funnelStepOf(before.screen, before.sub) ?? 'attract'), {
          reason,
          durationMs: Math.max(0, Math.round(this.clock.mono() - this.startedMono)),
          basketAgorot: before.basketAgorot,
          items: before.items,
          tipAgorot: this.paid ? this.tip : undefined,
        }),
      );
      this.sessionId = null;
      this.lastEvent = null;
      return;
    }
    const step = funnelStepOf(s.screen, s.sub);
    if (step && step !== this.lastStep) {
      this.lastStep = step;
      this.emit(this.ev('screen', step, { service: s.service ?? undefined }));
    }
    if (!prev || prev.pay !== s.pay) this.onPay(prev?.pay ?? 'idle', s);
  }

  private onPay(from: FunnelSnapshot['pay'], s: FunnelSnapshot) {
    const step: FunnelStep = 'pay';
    if (s.pay === 'starting' && from !== 'charging') this.emit(this.ev('pay', step, { result: 'started', method: 'card', amountAgorot: s.basketAgorot + this.tip }));
    else if (s.pay === 'approved') {
      this.paid = true;
      this.emit(this.ev('pay', step, { result: 'approved', amountAgorot: s.basketAgorot + this.tip }));
    } else if (s.pay === 'declined' && from !== 'declined') {
      const cancelled = this.payCancel;
      this.payCancel = false;
      this.emit(this.ev('pay', step, { result: cancelled ? 'cancelled' : 'declined', reason: cancelled ? 'cancelled_by_customer' : 'declined' }));
    } else if (s.pay === 'unknown' && from !== 'unknown') this.emit(this.ev('pay', step, { result: 'unknown', reason: 'no_answer' }));
  }

  /** The payment was refused before the terminal (no terminal, unresolved, the basket changed…). */
  payRefused(reason: string) {
    this.emit(this.ev('pay', 'pay', { result: 'error', reason: reason.slice(0, 64) }));
  }

  itemOpen(productId: string) {
    this.emit(this.ev('item_open', 'item', { productId }));
  }

  itemAdd(productId: string, qty: number, upsell = false, priceAgorot?: number) {
    this.emit(this.ev('item_add', funnelStepOf(this.last?.screen ?? 'catalog', this.last?.sub) ?? 'catalog', { productId, qty: Math.max(1, Math.round(qty)), upsell, priceAgorot }));
  }

  upsell(action: FunnelUpsellAction, moment: FunnelUpsellMoment, ruleId: string | null, productId?: string | null) {
    this.emit(this.ev('upsell', funnelStepOf(this.last?.screen ?? 'catalog', this.last?.sub) ?? 'catalog', { action, moment, ruleId: ruleId ?? undefined, productId: productId ?? undefined }));
  }

  basketCheck(c: { removed: number; repriced: number; fromAgorot: number; toAgorot: number; source: 'cloud' | 'local'; promotions?: boolean }) {
    this.emit(this.ev('basket_check', 'pay', { ...c, outcome: 'shown' }));
  }

  help() {
    this.helped = true;
    this.emit(this.ev('help', this.lastStep));
  }
}

/* ------------------------------------------------------------- the queue */

/** At most this many events wait on the kiosk (the oldest go first); a batch is ≤ BATCH. */
export const FUNNEL_QUEUE_MAX = 5000;
export const FUNNEL_BATCH = 200;

/** The queue with [events] added, the oldest dropped past the cap. */
export function enqueueFunnel(queue: readonly FunnelEvent[], events: readonly FunnelEvent[], max = FUNNEL_QUEUE_MAX): FunnelEvent[] {
  const all = [...queue, ...events];
  return all.length > max ? all.slice(all.length - max) : all;
}

/** What the cloud's answer means for a sent batch: drop it (taken, or refused for good) or keep it (try later). */
export function funnelReplyDrops(reply: { kind: 'ok' } | { kind: 'refused'; status: number } | { kind: 'offline' }): boolean {
  if (reply.kind === 'ok') return true;
  if (reply.kind === 'offline') return false;
  // 401 (re-pair), 408 / 429 and 5xx: later. Any other refusal would refuse it forever: dropped.
  return !(reply.status === 401 || reply.status === 408 || reply.status === 429 || reply.status >= 500);
}
