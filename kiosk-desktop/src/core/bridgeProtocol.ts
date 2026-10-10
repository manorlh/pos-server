/**
 * "גשר לדפדפן" — the local bridge's protocol (pos-server docs/SPEC_KIOSK.md §28): what a browser
 * page of the R2M dashboard (the browser kiosk `/k`, a KDS or a "מוכן / לא מוכן" board) may ask of
 * R2M POS for Windows running in bridge mode on the same PC, over http://127.0.0.1:<port>.
 *
 *  - Only the dashboard's own origins are answered (defaults below, more in kiosk.json
 *    `bridgeOrigins` / the bridge window); Chrome / Edge's Private Network Access preflight is
 *    answered with `Access-Control-Allow-Private-Network: true`.
 *  - A page pairs ONCE with the 6-digit code the bridge shows; both keep a shared secret. Every
 *    other call is signed: HMAC-SHA256(secret, canonical(method, path, ts, nonce, sha256(body)))
 *    with a ±2 min clock window and a nonce never seen twice — no payment, print or drawer call
 *    without it.
 *  - What a page may ask depends on its role (ROLE_CAPS): a kiosk takes cards, prints and opens
 *    the drawer; a KDS prints; a board asks nothing (the bridge only opens it on start).
 *
 * The browser's copy of these rules is client/src/lib/kioskBridge.ts (the dashboard is built
 * without this folder); test/bridge.test.ts runs that copy against this bridge's real server.
 * Pure: no Node, no Electron.
 */

/** The protocol's version (the page refuses a bridge it does not speak). */
export const BRIDGE_API = 1;
/** The fixed port on 127.0.0.1 (kiosk.json `bridgePort` moves it; the pages ask this one). */
export const BRIDGE_PORT = 47615;
export const BRIDGE_HOST = '127.0.0.1';

export type BridgeRole = 'kiosk' | 'kds' | 'order_status_board';
export const BRIDGE_ROLES: readonly BridgeRole[] = ['kiosk', 'kds', 'order_status_board'];

export const ROLE_LABEL: Record<BridgeRole, string> = {
  kiosk: 'קיוסק',
  kds: 'מסך מטבח (KDS)',
  order_status_board: 'מסך מוכן / לא מוכן',
};

export interface BridgeCaps {
  /** Card payments on the local pinpad (Nayax LAN / SynqPay), with the kiosk's fiscal ledger. */
  card: boolean;
  /** ESC/POS pages on a Windows printer or a network printer. */
  print: boolean;
  /** The cash drawer's kick (when the bridge is set to have one). */
  drawer: boolean;
}

export const NO_CAPS: BridgeCaps = { card: false, print: false, drawer: false };

/** What each browser role may ask of the bridge. */
export const ROLE_CAPS: Record<BridgeRole, BridgeCaps> = {
  kiosk: { card: true, print: true, drawer: true },
  kds: { card: false, print: true, drawer: false },
  order_status_board: { card: false, print: false, drawer: false },
};

export function roleOf(raw: unknown): BridgeRole | null {
  if (typeof raw !== 'string') return null;
  const r = raw.trim().toLowerCase().replace(/[-\s]/g, '_');
  if (r === 'kiosk') return 'kiosk';
  if (r === 'kds' || r === 'kitchen') return 'kds';
  if (r === 'order_status_board' || r === 'board' || r === 'pickup' || r === 'status_board') return 'order_status_board';
  return null;
}

/** The dashboard's own sites: production, and the dev dashboard. */
export const DEFAULT_ORIGINS: readonly string[] = ['https://pos-cloud-app.vercel.app', 'http://localhost:3002'];

/** `https://Host:443/` → `https://host`; anything that is not an http(s) origin → null. */
export function normalizeOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s === 'null') return null;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password) return null;
  const defaultPort = (u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80');
  return `${u.protocol}//${u.hostname.toLowerCase()}${u.port && !defaultPort ? `:${u.port}` : ''}`;
}

/** The origins answered: the defaults and the configured ones, normalized, without doubles. */
export function originList(extra: readonly unknown[] = []): string[] {
  const out: string[] = [];
  for (const o of [...DEFAULT_ORIGINS, ...extra]) {
    const n = normalizeOrigin(o);
    if (n && !out.includes(n)) out.push(n);
  }
  return out;
}

export function originAllowed(origin: unknown, allowed: readonly string[]): boolean {
  const n = normalizeOrigin(origin);
  return n !== null && allowed.includes(n);
}

/** The signature's headers (lower case, as Node reads them). */
export const H = {
  key: 'x-r2m-bridge-key',
  ts: 'x-r2m-ts',
  nonce: 'x-r2m-nonce',
  sig: 'x-r2m-sig',
} as const;

export const ALLOWED_HEADERS = 'Content-Type, X-R2M-Bridge-Key, X-R2M-Ts, X-R2M-Nonce, X-R2M-Sig';
export const ALLOWED_METHODS = 'GET, POST, OPTIONS';

/**
 * The CORS headers for an allowed origin. A preflight also gets the methods / headers, and the
 * Private Network Access answer when Chrome / Edge asked for it (`Access-Control-Request-Private-
 * Network: true`, and its later name `…-Local-Network`).
 */
export function corsHeaders(
  origin: string,
  req: { preflight: boolean; privateNetwork?: boolean; localNetwork?: boolean },
): Record<string, string> {
  const h: Record<string, string> = {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin, Access-Control-Request-Private-Network',
  };
  if (req.preflight) {
    h['Access-Control-Allow-Methods'] = ALLOWED_METHODS;
    h['Access-Control-Allow-Headers'] = ALLOWED_HEADERS;
    h['Access-Control-Max-Age'] = '600';
    if (req.privateNetwork) h['Access-Control-Allow-Private-Network'] = 'true';
    if (req.localNetwork) h['Access-Control-Allow-Local-Network'] = 'true';
  }
  return h;
}

/** How far the page's clock may be from the bridge's (the same PC: seconds at most). */
export const SKEW_MS = 120_000;
export const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
export const KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;
export const SIG_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * What is signed: the method, the path (with its query), the time (epoch ms), the nonce and the
 * body's SHA-256 (hex; of "" for a GET), one per line.
 */
export function canonical(method: string, path: string, ts: number | string, nonce: string, bodySha256Hex: string): string {
  return [method.toUpperCase(), path, String(ts), nonce, bodySha256Hex.toLowerCase()].join('\n');
}

/** SHA-256 of the empty string (a GET's body). */
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** Where a call goes and which capability it needs (null: any paired page). */
export const ROUTE_CAPS: Record<string, keyof BridgeCaps | null> = {
  'GET /status': null,
  'POST /link': null,
  'POST /unlink': null,
  'POST /unpair': null,
  'POST /flow': null,
  'POST /launcher/exit': null,
  'POST /pay/start': 'card',
  'GET /pay/status': 'card',
  'POST /pay/cancel': 'card',
  'POST /pay/receipt': 'card',
  'POST /close-request': 'card',
  'GET /admin/info': 'card',
  'POST /admin/unlock': 'card',
  'POST /admin/action': 'card',
  'POST /print': 'print',
  'POST /drawer': 'drawer',
};

/** The routes a page may call, as "METHOD /path". */
export function routeKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path.split('?')[0]}`;
}

/** The bridge's answer to `GET /health` (no secret, no machine): enough to know it is there. */
export interface BridgeHealth {
  bridge: 'r2m';
  api: number;
  version: string;
  /** A page is paired (its id below); the page compares it with the one it keeps. */
  paired: boolean;
  pairingId: string | null;
  /** The paired page's role. */
  role: BridgeRole | null;
  /** What the paired role may do here now (the role's caps, and the hardware ready). */
  ready: BridgeCaps;
}

/** A 6-digit pairing code typed as "123 456" / "123-456" → "123456". */
export function normalizeBridgeCode(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/[\s-]+/g, '') : '';
}
