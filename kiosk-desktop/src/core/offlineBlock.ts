/**
 * "חסימת הזמנות כשאין אינטרנט" (the kiosk setting `general.blockWhenOffline`, client lib/kioskConfig.ts
 * kioskOfflineBlocks) — and what it blocks, the till parameter "קיוסק — מה נחסם כשאין אינטרנט"
 * (`kioskOfflineBlockScope`, pos-server app/services/till_parameters.py), set per company / shop / point of
 * sale / till:
 *
 *   `all` (the default)  every way to pay: the kiosk takes no order and rests on its "offline" screen;
 *   `pay_at_till`        only "תשלום בקופה": the card (and a voucher it finishes) stays.
 *
 * One rule for both hosts: the Windows kiosk reads the parameter (`GET /sync/{m}/parameters`), the Android web
 * bundle its kiosk config — the cloud puts a scope other than the default there as `general.offlineBlockScope`
 * (the APK hands the screens the config, not the parameters). Pure.
 */

import type { PaymentMethod } from '@dash-lib/kioskConfig';

/** The till parameter's key. */
export const OFFLINE_BLOCK_SCOPE_KEY = 'kioskOfflineBlockScope';
/** Where the kiosk config carries it (only when not the default). */
export const OFFLINE_BLOCK_CONFIG_FIELD = 'offlineBlockScope';

export const OFFLINE_BLOCK_SCOPES = ['all', 'pay_at_till'] as const;
export type OfflineBlockScope = (typeof OFFLINE_BLOCK_SCOPES)[number];
export const OFFLINE_BLOCK_SCOPE_DEFAULT: OfflineBlockScope = 'all';

/**
 * "מזומן עובד בלי אינטרנט" (P:/specs/cash-paylink.md §13, the owner: "כי מזומן זה מקומי"): the cash
 * station is on the LAN — even with the block on, `cash_device` stays, unless the till parameter
 * `kioskOfflineBlockCash` (default false) says to block it too. Windows reads the parameter; the Android
 * bundle its config (`general.offlineBlockCash`, put there by the cloud only when true).
 */
export const OFFLINE_BLOCK_CASH_KEY = 'kioskOfflineBlockCash';
export const OFFLINE_BLOCK_CASH_FIELD = 'offlineBlockCash';

/** Whether the offline block takes the cash station too: the parameter, else the config's field; default no. */
export function offlineBlockCashOf(param: unknown, config: unknown): boolean {
  const on = (v: unknown) => v === true || v === 'true' || v === 1 || v === '1';
  if (param !== undefined && param !== null && param !== '') return on(param);
  if (!config || typeof config !== 'object') return false;
  const general = (config as { general?: unknown }).general;
  return !!general && typeof general === 'object' && on((general as Record<string, unknown>)[OFFLINE_BLOCK_CASH_FIELD]);
}

/** The first of [values] that is a scope; none — the default (`all`). */
export function offlineBlockScopeOf(...values: unknown[]): OfflineBlockScope {
  for (const v of values) {
    if (typeof v === 'string' && (OFFLINE_BLOCK_SCOPES as readonly string[]).includes(v)) return v as OfflineBlockScope;
  }
  return OFFLINE_BLOCK_SCOPE_DEFAULT;
}

/** The scope a kiosk config carries (`general.offlineBlockScope`), as it came from the cloud; undefined: none. */
export function configOfflineBlockScope(config: unknown): unknown {
  if (!config || typeof config !== 'object') return undefined;
  const general = (config as { general?: unknown }).general;
  return general && typeof general === 'object' ? (general as Record<string, unknown>)[OFFLINE_BLOCK_CONFIG_FIELD] : undefined;
}

/**
 * What is still usable while "חסימת הזמנות כשאין אינטרנט" holds the kiosk ([blocked]): nothing (`all`), or
 * everything but the till (`pay_at_till`). Not blocked: [usable] as it is.
 */
export function offlineUsable(usable: readonly PaymentMethod[], blocked: boolean, scope: OfflineBlockScope, blockCash = false): PaymentMethod[] {
  if (!blocked) return [...usable];
  // The cash station is local (§13): it stays unless `kioskOfflineBlockCash`.
  const cashStays = (m: PaymentMethod) => m === 'cash_device' && !blockCash;
  return scope === 'all' ? usable.filter(cashStays) : usable.filter((m) => m !== 'cash_at_till' && (m !== 'cash_device' || !blockCash));
}

/** Whether the kiosk rests on its "offline" screen for it: blocked with `all` (with `pay_at_till`, only when nothing is left). */
export function offlineRests(blocked: boolean, scope: OfflineBlockScope, usableLeft: readonly PaymentMethod[]): boolean {
  if (!blocked) return false;
  // The cash station still takes the order (§13): no "offline" rest while it is usable.
  if (usableLeft.includes('cash_device')) return false;
  return scope === 'all' || !usableLeft.some((m) => m === 'card' || m === 'cash_at_till');
}

/** The screens a customer orders on (and the welcome): where the offline notice may show. */
const NOTICE_SCREENS: ReadonlySet<string> = new Set(['attract', 'service', 'catalog', 'cart', 'confirm', 'details', 'success']);

/**
 * "הודעה ללקוח כשאין אינטרנט" (`general.offlineNotice`, off by default; docs/SPEC_KIOSK.md §17 — the Android kiosk's
 * KioskPayBlock.offlineNoticeShown / KioskOfflineNotice): a quiet line at the top while the kiosk is offline and still
 * selling — never on a rest screen (it says why itself), never over the payment.
 */
export function offlineNoticeShown(f: { enabled: boolean; offline: boolean; sells: boolean; screen: string }): boolean {
  return f.enabled && f.offline && f.sells && NOTICE_SCREENS.has(f.screen);
}

/** Its words when the kiosk set none (`texts.offlineNotice`): the Android kiosk's (kalert_offline_notice) — without the terminal on a kiosk that takes no card now. */
export function offlineNoticeText(cardUsable: boolean): string {
  return cardUsable ? 'אין כרגע חיבור לאינטרנט. ההזמנה והתשלום במסופון ממשיכים כרגיל.' : 'אין כרגע חיבור לאינטרנט. אפשר להמשיך להזמין כרגיל.';
}
