/**
 * How a client reaches its cash station's host (P:/specs/cash-paylink.md §14.2 `cashRoute`, the cloud relay §14.4):
 *
 *  - `lan` (default): straight to the host on the shop's LAN (§11.3–§11.6) — works with no internet;
 *  - `cloud`: every §11.4 call through the cloud relay, the same call signed the same way;
 *  - `auto`: the LAN first; the cloud when the station does not answer on the LAN.
 *
 * A host kiosk's own payments at its own station never leave the app (`local`, §14.1), whatever the route says.
 *
 * `auto` is safe because a payment never has two routes in flight: it picks one when it starts (the LAN if the
 * station answered there in the last `AUTO_LAN_FRESH_MS`, else the cloud) and keeps it to its end; only the recovery
 * afterwards (a restart, an ack still owed) may try both — calls the station takes idempotently, after the payment's
 * own loop is over, and a relayed call older than `RELAY_EXECUTE_MAX_AGE_MS` is never run by the host.
 *
 * Pinned by the shared golden test/fixtures/contract/cash_relay_golden.json (the same bytes in pos-server and
 * pos-android). Pure.
 */

export type CashRouteName = 'lan' | 'cloud' | 'auto';
/** The way one call actually goes. */
export type CashVia = 'lan' | 'cloud' | 'local';

export const CASH_ROUTES: readonly CashRouteName[] = ['lan', 'cloud', 'auto'];

/** `auto`: the LAN counts as answering for this long after its last answer. */
export const AUTO_LAN_FRESH_MS = 30_000;

/** A lease taken through the cloud: renewed every 5 s, gone after 20 s unrenewed (the LAN's: 2 / 6 s, lanProtocol.ts). */
export const CLOUD_LEASE_RENEW_MS = 5_000;
export const CLOUD_LEASE_TTL_MS = 20_000;

/** The host never runs a relayed call that reached the cloud longer ago than this (§14.4). */
export const RELAY_EXECUTE_MAX_AGE_MS = 10_000;
/** The client: how long the cloud holds its call open for the answer, and its own limit for one call. */
export const RELAY_CLIENT_WAIT_MS = 6_000;
export const RELAY_CALL_DEADLINE_MS = 8_000;
/** The host's long poll. */
export const RELAY_HOST_WAIT_MS = 20_000;

/** `cashRoute` as read: anything unknown is the LAN. */
export function routeOf(raw: unknown): CashRouteName {
  const s = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return (CASH_ROUTES as readonly string[]).includes(s) ? (s as CashRouteName) : 'lan';
}

/** The way a new payment goes (§14.2): its own station — in the app; `auto` — the LAN while it answers lately. */
export function paymentVia(route: CashRouteName, ownHost: boolean, lanOkAgoMs: number | null): CashVia {
  if (ownHost) return 'local';
  if (route === 'cloud') return 'cloud';
  if (route === 'auto') return lanOkAgoMs !== null && lanOkAgoMs < AUTO_LAN_FRESH_MS ? 'lan' : 'cloud';
  return 'lan';
}

/** The ways a payment's recovery tries, in order (§14.2.3): `auto` — the LAN, then the cloud. */
export function recoveryVia(route: CashRouteName, ownHost: boolean): CashVia[] {
  if (ownHost) return ['local'];
  if (route === 'cloud') return ['cloud'];
  if (route === 'auto') return ['lan', 'cloud'];
  return ['lan'];
}
