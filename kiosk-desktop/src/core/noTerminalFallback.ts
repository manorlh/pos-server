/**
 * "קיוסק — כשאין מסופון אשראי" (the till parameter `kioskNoTerminalFallback`, pos-server app/services/till_parameters.py),
 * set per company / shop / point of sale / till. The owner (16.10.2026, "גם אם אין מסופון שיעלה"): a kiosk comes up
 * and takes orders even when it has no card terminal — none set up, "ללא אשראי", or one that does not answer:
 *
 *   `pay_at_till` (the default)  the card cannot be charged and nothing else pays: the kiosk still opens its menu, and at
 *                                 the payment offers "תשלום בקופה" — the order goes to the till as pay-at-till does (the
 *                                 cloud, the shop's LAN host / print server offline, else the "לתשלום בקופה" slip). No
 *                                 tax document on the kiosk: the till that takes the money writes it;
 *   `block`                       as before: with nothing to charge the kiosk rests on "התשלום אינו זמין כרגע".
 *
 * A terminal set up but not answering (its checks, or a charge that never reached it) keeps its tile — tried on the
 * press, its error said then — with "תשלום בקופה" beside it. The kiosk's own "תשלום בקופה", or a cash station that
 * answers, already pays: nothing is added then. "חסימת הזמנות כשאין אינטרנט" still holds what it holds
 * (core/offlineBlock.ts runs after this).
 *
 * One rule for both hosts: the Windows kiosk reads the parameter (`GET /sync/{m}/parameters`), the Android web bundle
 * its kiosk config — the cloud puts a value other than the default there as `general.noTerminalFallback`. A cloud that
 * does not know the parameter yet sends neither: the default (`pay_at_till`), so the kiosk comes up all the same.
 * The Android kiosk's domain/KioskTillFallback.kt is the same rule. Pure.
 */

import type { PaymentMethod } from '@dash-lib/kioskConfig';

/** The till parameter's key. */
export const NO_TERMINAL_FALLBACK_KEY = 'kioskNoTerminalFallback';
/** Where the kiosk config carries it (only when not the default). */
export const NO_TERMINAL_FALLBACK_CONFIG_FIELD = 'noTerminalFallback';

export const NO_TERMINAL_FALLBACKS = ['pay_at_till', 'block'] as const;
export type NoTerminalFallback = (typeof NO_TERMINAL_FALLBACKS)[number];
export const NO_TERMINAL_FALLBACK_DEFAULT: NoTerminalFallback = 'pay_at_till';

/** The customer's words where the card is not there now and the till is offered instead. */
export const CARD_FALLBACK_TEXT = 'האשראי לא זמין כרגע — אפשר לשלם בקופה';

/** The first of [values] that is one of the choices; none — the default (`pay_at_till`). */
export function noTerminalFallbackOf(...values: unknown[]): NoTerminalFallback {
  for (const v of values) {
    if (typeof v === 'string' && (NO_TERMINAL_FALLBACKS as readonly string[]).includes(v)) return v as NoTerminalFallback;
  }
  return NO_TERMINAL_FALLBACK_DEFAULT;
}

/** The choice a kiosk config carries (`general.noTerminalFallback`), as it came from the cloud; undefined: none. */
export function configNoTerminalFallback(config: unknown): unknown {
  if (!config || typeof config !== 'object') return undefined;
  const general = (config as { general?: unknown }).general;
  return general && typeof general === 'object' ? (general as Record<string, unknown>)[NO_TERMINAL_FALLBACK_CONFIG_FIELD] : undefined;
}

/**
 * The card now: `ok` — a terminal set up that answers (or is not checked yet); `flaky` — set up, but its checks or a
 * charge did not reach it (its tile stays: tried on the press); `missing` — none to charge on in advance (none set up, a
 * built-in one only, "ללא אשראי", or the cloud's lock on an unresolved card).
 */
export type FallbackCard = 'ok' | 'flaky' | 'missing';

/** The card's state from a terminal's: [configured] (one to charge on), [unreachable] (its checks / a charge failed), [locked]. */
export function fallbackCard(f: { configured: boolean; unreachable: boolean; locked?: boolean }): FallbackCard {
  if (!f.configured || f.locked) return 'missing';
  return f.unreachable ? 'flaky' : 'ok';
}

/**
 * Whether "תשלום בקופה" is offered for the terminal's sake: [mode] `pay_at_till`, the card not `ok`, the kiosk not set to
 * take "תשלום בקופה" itself, and no cash station that answers ([cashDeviceUsable] with `cash_device` among [methods]).
 */
export function tillFallbackApplies(f: { mode: NoTerminalFallback; methods: readonly PaymentMethod[]; card: FallbackCard; cashDeviceUsable: boolean }): boolean {
  if (f.mode !== 'pay_at_till' || f.card === 'ok') return false;
  if (f.methods.includes('cash_at_till')) return false;
  return !(f.cashDeviceUsable && f.methods.includes('cash_device'));
}

/** [methods] with "תשלום בקופה" last when [applies]. */
export function withTillFallback(methods: readonly PaymentMethod[], applies: boolean): PaymentMethod[] {
  return applies && !methods.includes('cash_at_till') ? [...methods, 'cash_at_till'] : [...methods];
}

/**
 * "איך תרצו לשלם?" while the till is offered for the terminal ([tillFallback]): the config's step read over the methods the
 * kiosk offers now ([methods] — the card and the till), and asked — "כבוי" (a card-only kiosk's step is off: nothing to
 * choose) becomes "חובה", so a terminal that does not answer never leaves the customer with the card alone; "רשות" stays
 * (it passes with the card, the till a tap away). Not offered: [cfg] as it is.
 */
export function fallbackPayConfig<C extends { payment: { methods?: unknown; stepModes?: Partial<Record<string, unknown>> } }>(
  cfg: C,
  methods: readonly PaymentMethod[],
  tillFallback: boolean,
): C {
  if (!tillFallback) return cfg;
  const own = cfg.payment.stepModes?.payMethod;
  return { ...cfg, payment: { ...cfg.payment, methods: [...methods], stepModes: { ...(cfg.payment.stepModes ?? {}), payMethod: own === 'optional' ? 'optional' : 'required' } } };
}

/**
 * May the kiosk place an order to pay at the till: set to take it, or — with [mode] `pay_at_till` — offered for the
 * terminal's sake. Asked again when the order is placed: a terminal that came back in between does not refuse an order the
 * customer already chose to pay at the till.
 */
export function mayPayAtTill(configured: readonly PaymentMethod[], mode: NoTerminalFallback): boolean {
  return configured.includes('cash_at_till') || mode === 'pay_at_till';
}
