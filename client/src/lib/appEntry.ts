/**
 * `/app` — the single web entry (web-till spec v2 §6.1, §8.2; work plan S0-10): one loader on the
 * dashboard's site for every role the cloud gives a browser — till, kiosk, KDS, ready board,
 * customer display. Pure: what to show for an address, what a pairing link says, and which
 * credentials to use — this browser's own, or those an older page (`/k`, `/kds`, `/board`) already
 * keeps on this site, so a device paired there is never paired again.
 *
 *  - **Aliases.** `/t`, `/k`, `/kds` and `/board` are names for `/app`: the alias says which role
 *    the pairing screen is for until the device is paired; after that the CLOUD's role wins
 *    (`machines/me.deviceRole`), whatever the address — as `screenWebService` hands a board's code
 *    typed at `/kds` over to `/board` today. Until P6-6, `/k`, `/kds` and `/board` stay the live
 *    pages they are; only `/t` is new.
 *  - **Pairing link.** `/app#pair=CODE` (also on an alias): the code is after the `#`, so it never
 *    reaches a server log; the page clears the hash once it read it.
 *  - **Credentials import (design, done by P6-6):** `/app` keeps its own (`APP_STORE`, key
 *    `r2m.app.credentials`). With none, it looks in the older pages' stores on the same site —
 *    `r2m.kiosk.credentials` (IndexedDB `r2m-kiosk`), `r2m.kds.credentials` (`r2m-kds`),
 *    `r2m.board.credentials` (`r2m-board`), each mirrored to localStorage — and takes one
 *    (`planCredentials`): the alias's own first, else the newest pairing. It COPIES them (the
 *    machine token is the same machine: no re-pairing, no new register number) and records where
 *    from (`r2m.app.importedFrom`); the old page's copy is left alone until P6-6 points that page
 *    at `/app` (`r2m.<route>.movedTo`), so a device in the field never breaks halfway.
 *
 * No `@/` imports (the node tests compile it on its own).
 */

import { normalizePairingCode, type KioskCredentials } from './kioskWebApi';
import { normalizeRole, type DeviceRole } from './deviceMode';

/** The address names `/app` answers to, and the role each alias pairs for. */
export const APP_ALIASES: Readonly<Record<string, DeviceRole | null>> = {
  app: null,
  t: 'till',
  k: 'kiosk',
  kds: 'kds',
  board: 'board',
};

/** `/app`'s own store (lib/kioskWebStore.ts `openKioskStore` options). */
export const APP_STORE = {
  dbName: 'r2m-app',
  credentials: 'r2m.app.credentials',
  /** `{route, at}`: the older page the credentials were copied from. */
  importedFrom: 'r2m.app.importedFrom',
  /** The device's persisted mode (lib/deviceMode.ts `PersistedMode`) — a non-fiscal role only; a fiscal one's is the engine's. */
  mode: 'r2m.app.mode',
} as const;

export type LegacyRoute = 'k' | 'kds' | 'board';

/** Where each older page keeps its credentials on this site (kioskWebStore.ts KV, screenWebService.ts screenKeys). */
export const LEGACY_STORES: ReadonlyArray<{ route: LegacyRoute; role: DeviceRole; dbName: string; key: string }> = [
  { route: 'k', role: 'kiosk', dbName: 'r2m-kiosk', key: 'r2m.kiosk.credentials' },
  { route: 'kds', role: 'kds', dbName: 'r2m-kds', key: 'r2m.kds.credentials' },
  { route: 'board', role: 'board', dbName: 'r2m-board', key: 'r2m.board.credentials' },
];

export interface AppEntryAddress {
  /** The route the page was opened at: "app", "t", "k", "kds" or "board". */
  route: string;
  /** The role the alias pairs for; null at `/app` itself. */
  alias: DeviceRole | null;
  /** `#pair=CODE`, normalised ("AB12 CD34" → "AB12CD34"); null when there is none. */
  pairCode: string | null;
}

/**
 * The first segment of `pathname`, `?as=<role>` of `search` (at `/app` itself) and `#pair=` of
 * `hash` — e.g. ("/t", "", "#pair=ab12-cd34").
 */
export function entryOf(pathname: string, hash: string, search = ''): AppEntryAddress {
  const first = (pathname || '/').split('/').filter(Boolean)[0]?.toLowerCase() ?? 'app';
  const route = Object.prototype.hasOwnProperty.call(APP_ALIASES, first) ? first : 'app';
  const as = route === 'app' ? normalizeRole(new URLSearchParams(search || '').get('as')) : null;
  const params = new URLSearchParams((hash || '').replace(/^#/, ''));
  const raw = params.get('pair');
  const code = raw ? normalizePairingCode(raw) : '';
  return { route, alias: APP_ALIASES[route] ?? as, pairCode: code.length >= 6 ? code : null };
}

/** `/app`'s address for an alias (the old pages move there in P6-6); the pairing code stays after `#`. */
export function appHref(alias: DeviceRole | null, pairCode: string | null = null): string {
  const as = alias ? `?as=${alias}` : '';
  return `/app${as}${pairCode ? `#pair=${encodeURIComponent(pairCode)}` : ''}`;
}

/* ------------------------------------------------------------ credentials */

export interface FoundCredentials {
  route: LegacyRoute;
  credentials: KioskCredentials;
}

export type CredentialPlan =
  | { use: 'own'; credentials: KioskCredentials }
  | { use: 'import'; from: LegacyRoute; credentials: KioskCredentials; others: LegacyRoute[] }
  | { use: 'pair'; alias: DeviceRole | null };

function usable(c: KioskCredentials | null | undefined): c is KioskCredentials {
  return !!c && typeof c.accessToken === 'string' && !!c.accessToken && typeof c.machineId === 'string' && !!c.machineId && typeof c.serverUrl === 'string';
}

function pairedAtMs(c: KioskCredentials): number {
  const t = Date.parse(c.pairedAt);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Which credentials `/app` runs on: its own; else an older page's on this site — the alias's own
 * route first, then the newest pairing (another page's kept as `others`, never deleted); else pair.
 */
export function planCredentials(own: KioskCredentials | null, found: readonly FoundCredentials[], alias: DeviceRole | null): CredentialPlan {
  if (usable(own)) return { use: 'own', credentials: own };
  const candidates = found.filter((f) => usable(f.credentials));
  if (candidates.length === 0) return { use: 'pair', alias };
  const routeOfAlias = LEGACY_STORES.find((s) => s.role === alias)?.route ?? null;
  const ordered = [...candidates].sort((a, b) => {
    if (a.route === routeOfAlias && b.route !== routeOfAlias) return -1;
    if (b.route === routeOfAlias && a.route !== routeOfAlias) return 1;
    return pairedAtMs(b.credentials) - pairedAtMs(a.credentials);
  });
  const [chosen, ...rest] = ordered;
  return { use: 'import', from: chosen.route, credentials: chosen.credentials, others: rest.map((r) => r.route) };
}

/* ------------------------------------------------------------ what to show */

export type AppScreen =
  | { kind: 'pair'; alias: DeviceRole | null }
  | { kind: 'waiting' }
  | { kind: 'role'; role: DeviceRole; fiscal: boolean };

/**
 * The screen for this browser: pairing until it has credentials; then the role the cloud says
 * (`machines/me.deviceRole`, `fiscal`) — the alias never overrides it; "waiting" until the cloud
 * has been asked. `mode` (lib/deviceMode.ts) is shown instead of the role when it differs.
 */
export function screenFor(input: {
  paired: boolean;
  alias: DeviceRole | null;
  deviceRole: unknown;
  fiscal?: boolean | null;
  mode?: DeviceRole | null;
}): AppScreen {
  if (!input.paired) return { kind: 'pair', alias: input.alias };
  const role = normalizeRole(input.deviceRole);
  if (!role) return { kind: 'waiting' };
  const shown = input.mode ?? role;
  const fiscal = shown === 'till' || shown === 'kiosk' ? input.fiscal !== false : false;
  return { kind: 'role', role: shown, fiscal };
}

/** Hebrew names, as the dashboard's "הוספת מכשיר" names the device types. */
export const ROLE_LABELS: Readonly<Record<DeviceRole, string>> = {
  till: 'קופה',
  kiosk: 'קיוסק',
  kds: 'מסך מטבח (KDS)',
  board: 'מסך מוכן / לא מוכן',
  display: 'מסך לקוח',
};

/** The page that runs a role today, until its screens come from the r2m-app bundle (P1-8, P6-6); null: not built yet. */
export function livePageOf(role: DeviceRole): string | null {
  if (role === 'kiosk') return '/k';
  if (role === 'kds') return '/kds';
  if (role === 'board') return '/board';
  return null;
}
