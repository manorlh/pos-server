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
export function offlineUsable(usable: readonly PaymentMethod[], blocked: boolean, scope: OfflineBlockScope): PaymentMethod[] {
  if (!blocked) return [...usable];
  return scope === 'all' ? [] : usable.filter((m) => m !== 'cash_at_till');
}

/** Whether the kiosk rests on its "offline" screen for it: blocked with `all` (with `pay_at_till`, only when nothing is left). */
export function offlineRests(blocked: boolean, scope: OfflineBlockScope, usableLeft: readonly PaymentMethod[]): boolean {
  if (!blocked) return false;
  return scope === 'all' || !usableLeft.some((m) => m === 'card' || m === 'cash_at_till');
}
