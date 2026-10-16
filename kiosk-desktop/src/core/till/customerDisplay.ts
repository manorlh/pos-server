/**
 * "מסך לקוח" on the Windows till's second screen (P:/specs/customer-display.md, customer-display-transitions.md; pos-android
 * domain/CustomerDisplay.kt `CustomerDisplayMapping.basket` / `screen` / `filtered`, `CdHold.waitMs`, data/repo/CustomerDisplayBus.kt,
 * data/repo/CustomerDisplayGate.kt): the one state the screen draws (`customer_display_state` v1 — the dashboard's
 * client/src/lib/customerDisplay.ts `CdState`, drawn by its `CustomerScreen`), mapped from what the till's engine shows:
 *
 *  - the basket: its lines (a line's discounts together), the promotions, the discounts, the total, the count; empty — idle;
 *  - the payment over it: paying (the card waited for, being processed, declined; the §13 notice while the terminal works
 *    deferred), the thanks with the change once done — held `thanksSec` before the idle screen, never before a new sale;
 *  - `show` filters every field before anything leaves the bus: nothing hidden ever reaches the screen;
 *  - the settings are the cloud's (`GET /sync/{m}/customer-display`): shown only on a till, when `enabled`, on a second screen.
 *
 * Pure (the bus takes its clock and its timer).
 */

import { DEFAULTS, IDLE_STATE, type CdConfig, type CdState } from '@dash-lib/customerDisplay';
import type { CheckoutState, SellState } from '../../shared/till/protocol';

export { IDLE_STATE, type CdConfig, type CdState };

/** The basket as the screen shows it (CustomerDisplayMapping.basket). */
export function basketOf(sell: Pick<SellState, 'lines' | 'itemCount' | 'totalAgorot' | 'promotionsAgorot' | 'lineDiscountsAgorot' | 'basketDiscount'>): CdState {
  if (sell.lines.length === 0) return IDLE_STATE;
  const promo = sell.promotionsAgorot ?? 0;
  return {
    ...IDLE_STATE,
    phase: 'basket',
    lines: sell.lines.map((l) => ({
      id: l.lineId,
      name: l.name,
      qty: l.qty,
      unit: null,
      total: Math.abs(l.totalAgorot),
      modifiers: [],
      discount: Math.max(0, l.discountAgorot ?? 0),
      promo: null,
      refund: l.refund === true,
    })),
    promotions: promo > 0 ? [{ name: 'מבצעים', amount: promo }] : [],
    discount: Math.max(0, (sell.lineDiscountsAgorot ?? 0) + (sell.basketDiscount?.amountAgorot ?? 0) + promo),
    total: sell.totalAgorot,
    itemCount: sell.itemCount,
  };
}

/** The payment over the basket (CustomerDisplayMapping.screen); [notice] — the §13 customer notice, on a card's states. */
export function screenOf(basket: CdState, c: CheckoutState | null, notice: string | null): CdState {
  if (!c || c.phase === 'idle') return basket;
  const vouchers = (c.vouchers?.items ?? []).filter((v) => v.amountAgorot > 0).map((v) => ({ name: v.label, amount: v.amountAgorot }));
  const base: CdState = { ...basket, phase: basket.phase === 'idle' ? 'basket' : basket.phase, total: c.totalAgorot, vouchers };
  if (c.phase === 'done') return { ...base, phase: 'thanks', thanks: { total: c.totalAgorot, change: c.changeAgorot, tip: 0, receiptUrl: null } };
  const card = (status: NonNullable<CdState['payment']>['status']): CdState => ({
    ...base,
    phase: 'paying',
    payment: { method: 'card', status, due: c.dueAgorot, paid: c.paidAgorot, ...(notice ? { notice } : {}) },
  });
  if (c.cardUnknown || (c.phase as string) === 'card_unknown') return card('processing');
  if (c.phase === 'card_waiting') return card('waiting_card');
  if (c.cardError) return card('declined');
  return { ...base, phase: 'paying', payment: { method: 'other', status: 'choose', due: c.dueAgorot, paid: c.paidAgorot } };
}

/** What the settings let the screen show (`filtered`): hidden fields never leave the till. */
export function filtered(s: CdState, show: CdConfig['show']): CdState {
  const lines = !show.items
    ? []
    : s.lines.map((l) => ({ ...l, total: show.prices ? l.total : 0, discount: show.prices ? l.discount : 0, modifiers: show.modifiers ? l.modifiers : [], promo: show.promotions ? l.promo : null }));
  const thanks = show.thanks && s.thanks ? (show.change ? s.thanks : { ...s.thanks, change: 0 }) : null;
  const out: CdState = {
    ...s,
    lines,
    promotions: show.promotions ? s.promotions : [],
    vouchers: show.vouchers ? s.vouchers : [],
    total: show.totals ? s.total : 0,
    discount: show.totals ? s.discount : 0,
    tip: show.tip ? s.tip : null,
    payment: show.payment ? s.payment : null,
    cash: show.change ? s.cash : null,
    thanks,
  };
  if (out.phase === 'tip' && !out.tip) out.phase = 'basket';
  if (out.phase === 'paying' && !out.payment) out.phase = 'basket';
  if (out.phase === 'change' && !out.cash) out.phase = 'basket';
  if (out.phase === 'thanks' && !out.thanks) out.phase = 'idle';
  return out;
}

/** Only "thanks" → idle waits (CdHold.waitMs): the rest of `thanksSec` since the thanks came. */
export function holdWaitMs(cur: CdState, thanksSince: number | null, next: CdState, now: number, thanksMs: number): number {
  if (cur.phase !== 'thanks' || next.phase !== 'idle' || thanksSince === null) return 0;
  return Math.max(0, thanksSince + thanksMs - now);
}

/** The same screen, whatever its sequence number. */
export function sameScreen(a: CdState, b: CdState): boolean {
  return JSON.stringify({ ...a, seq: 0 }) === JSON.stringify({ ...b, seq: 0 });
}

/**
 * The one state (CustomerDisplayBus): filtered, "thanks" held, each new screen a higher `seq` (from the clock at start, so it
 * grows across restarts).
 */
export class CustomerDisplayBus {
  private state: CdState;
  private thanksSince: number | null = null;
  private seq: number;
  private pending: ReturnType<typeof setTimeout> | null = null;
  show: CdConfig['show'] = DEFAULTS.show;
  thanksMs = DEFAULTS.thanksSec * 1000;

  constructor(
    private readonly onState: (s: CdState) => void,
    private readonly now: () => number = () => Date.now(),
    private readonly timer: { set(fn: () => void, ms: number): ReturnType<typeof setTimeout>; clear(t: ReturnType<typeof setTimeout>): void } = {
      set: (fn, ms) => setTimeout(fn, ms),
      clear: (t) => clearTimeout(t),
    },
  ) {
    this.seq = this.now();
    this.state = { ...IDLE_STATE, seq: this.seq };
  }

  get current(): CdState {
    return this.state;
  }

  publish(next: CdState) {
    const f = filtered(next, this.show);
    if (this.pending) {
      this.timer.clear(this.pending);
      this.pending = null;
    }
    const wait = holdWaitMs(this.state, this.thanksSince, f, this.now(), this.thanksMs);
    if (wait > 0) {
      this.pending = this.timer.set(() => {
        this.pending = null;
        this.apply(f);
      }, wait);
      return;
    }
    this.apply(f);
  }

  private apply(next: CdState) {
    if (sameScreen(this.state, next)) return;
    const wasThanks = this.state.phase === 'thanks';
    this.thanksSince = next.phase === 'thanks' ? (wasThanks ? this.thanksSince : this.now()) : null;
    this.seq += 1;
    this.state = { ...next, seq: this.seq };
    this.onState(this.state);
  }

  stop() {
    if (this.pending) this.timer.clear(this.pending);
    this.pending = null;
  }
}

/** The till's word from `GET /sync/{m}/customer-display`. */
export interface DisplayConfig {
  config: CdConfig;
  branding: { shopName: string; logoUrl: string; primaryColor: string | null };
  role: 'till' | 'display' | 'none';
  configSec: number;
}

const clampN = (v: unknown, min: number, max: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.trunc(v))) : d);

/** Read leniently (CustomerDisplayConfig.of): every field its default when missing or of the wrong kind. */
export function displayConfigOf(raw: unknown): DisplayConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const c = (o.config && typeof o.config === 'object' ? o.config : {}) as Record<string, unknown>;
  const b = (o.branding && typeof o.branding === 'object' ? o.branding : {}) as Record<string, unknown>;
  const p = (o.poll && typeof o.poll === 'object' ? o.poll : {}) as Record<string, unknown>;
  const show = { ...DEFAULTS.show };
  if (c.show && typeof c.show === 'object') for (const [k, v] of Object.entries(c.show as Record<string, unknown>)) if (k in show && typeof v === 'boolean') (show as Record<string, boolean>)[k] = v;
  const oneOf = <T extends string>(v: unknown, all: readonly T[], d: T): T => (typeof v === 'string' && (all as readonly string[]).includes(v) ? (v as T) : d);
  const config: CdConfig = {
    ...DEFAULTS,
    enabled: c.enabled === true,
    layout: oneOf(c.layout, ['auto', 'split', 'full'] as const, 'auto'),
    theme: oneOf(c.theme, ['dark', 'light', 'brand'] as const, 'dark'),
    show,
    playlist: Array.isArray(c.playlist) ? (c.playlist.filter((x) => !!x && typeof x === 'object' && typeof (x as { url?: unknown }).url === 'string') as CdConfig['playlist']) : [],
    logoUrl: typeof c.logoUrl === 'string' ? c.logoUrl : '',
    language: oneOf(c.language, ['auto', 'he', 'en'] as const, 'auto'),
    idleTimeoutSec: clampN(c.idleTimeoutSec, 0, 3600, DEFAULTS.idleTimeoutSec),
    thanksSec: clampN(c.thanksSec, 2, 60, DEFAULTS.thanksSec),
    welcomeText: typeof c.welcomeText === 'string' ? c.welcomeText.slice(0, 80) : '',
    thanksText: typeof c.thanksText === 'string' ? c.thanksText.slice(0, 80) : '',
    transition: oneOf(c.transition, ['fade', 'slide', 'zoom', 'dissolve', 'none'] as const, 'fade') as CdConfig['transition'],
    transitionMs: clampN(c.transitionMs, 200, 2000, DEFAULTS.transitionMs),
    kenBurns: typeof c.kenBurns === 'boolean' ? c.kenBurns : DEFAULTS.kenBurns,
    videoUntilEnd: typeof c.videoUntilEnd === 'boolean' ? c.videoUntilEnd : DEFAULTS.videoUntilEnd,
    shuffle: typeof c.shuffle === 'boolean' ? c.shuffle : DEFAULTS.shuffle,
  };
  return {
    config,
    branding: { shopName: typeof b.shopName === 'string' ? b.shopName : '', logoUrl: typeof b.logoUrl === 'string' ? b.logoUrl : '', primaryColor: typeof b.primaryColor === 'string' ? b.primaryColor : null },
    role: o.role === 'display' ? 'display' : o.role === 'none' ? 'none' : 'till',
    configSec: clampN(p.configSec, 10, 3600, 120),
  };
}

/** Shown on this till's second screen: a till, the setting on (showsOnSecondScreen). */
export const showsOnSecondScreen = (c: DisplayConfig | null): boolean => !!c && c.role === 'till' && c.config.enabled;
