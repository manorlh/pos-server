/**
 * The browser kiosk's conversation with the cloud (`/k`, docs/SPEC_KIOSK.md §27): the very till
 * API the Windows kiosk speaks (kiosk-desktop/src/main/sync/api.ts, itself the Android till's):
 *
 *  - base = the server URL, trimmed, without a trailing "/", with "/api/v1" added when it names no
 *    /api/vN — by default the dashboard's own API (NEXT_PUBLIC_API_URL), so pairing asks only the code;
 *  - `Authorization: Bearer <machine JWT>` on every call once paired (never refreshed; 401 "revoked"
 *    means re-pair);
 *  - camelCase JSON, except pairing/validate (snake_case only);
 *  - every call answers ok / refused (an HTTP status the cloud chose) / offline (no answer) — never
 *    throws, so the kiosk decides what an outage means.
 *
 * A browser cannot set User-Agent: the kiosk tells what it is in `device_info` at pairing and in
 * `status.health.platform = "web"` on every kiosk/sync. No custom header either (CORS preflight).
 *
 * Pure of React; no `@/` imports (the node tests compile it on its own).
 */

export type ApiReply<T = unknown> =
  | { kind: 'ok'; status: number; body: T; date: string | null; etag: string | null }
  | { kind: 'refused'; status: number; body: unknown; detail: string | null }
  | { kind: 'offline'; reason: string };

export function apiBase(serverUrl: string): string {
  let s = serverUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  if (!/\/api\/v\d+$/i.test(s)) s = `${s}/api/v1`;
  return `${s}/`;
}

/** FastAPI's `{"detail": "..."}` (a string), or `{"detail": {"code": ...}}`'s code, else null. */
export function detailOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const d = (body as { detail?: unknown }).detail;
  if (typeof d === 'string') return d;
  if (d && typeof d === 'object') {
    const o = d as { code?: unknown; reason?: unknown; error?: unknown };
    for (const v of [o.code, o.reason, o.error]) if (typeof v === 'string') return v;
  }
  const o = body as { code?: unknown; reason?: unknown };
  for (const v of [o.code, o.reason]) if (typeof v === 'string') return v;
  return null;
}

/** The cloud's own Hebrew sentence when it gives one (`message`, or `detail.message`). */
export function messageOf(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { message?: unknown; detail?: unknown };
  if (typeof b.message === 'string' && b.message.trim()) return b.message;
  const d = b.detail as { message?: unknown } | undefined;
  if (d && typeof d === 'object' && typeof d.message === 'string' && d.message.trim()) return d.message;
  return null;
}

export interface RequestOptions {
  body?: unknown;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Send the machine token (default true). */
  auth?: boolean;
}

export type FetchFn = (input: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal; cache?: RequestCache; credentials?: RequestCredentials }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  headers: { get(name: string): string | null };
}>;

export class KioskApi {
  constructor(
    private baseUrl: string,
    private readonly token: () => string | null,
    private readonly fetchFn: FetchFn,
  ) {}

  get base(): string {
    return this.baseUrl;
  }

  setBase(serverUrl: string) {
    this.baseUrl = apiBase(serverUrl);
  }

  url(path: string): string {
    return new URL(path.replace(/^\/+/, ''), this.baseUrl).toString();
  }

  async request<T = unknown>(method: string, path: string, opts: RequestOptions = {}): Promise<ApiReply<T>> {
    const headers: Record<string, string> = { Accept: 'application/json', ...(opts.headers ?? {}) };
    const token = opts.auth === false ? null : this.token();
    if (token) headers.Authorization = `Bearer ${token}`;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000) : null;
    let res: Awaited<ReturnType<FetchFn>>;
    try {
      // No cookies: the machine token is the only credential (never the dashboard user's session).
      res = await this.fetchFn(this.url(path), { method, headers, body, signal: ctrl?.signal, cache: 'no-store', credentials: 'omit' });
    } catch (e) {
      return { kind: 'offline', reason: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
    } finally {
      if (timer) clearTimeout(timer);
    }
    const text = await res.text().catch(() => '');
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }
    if (res.ok || res.status === 304) return { kind: 'ok', status: res.status, body: parsed as T, date: res.headers.get('date'), etag: res.headers.get('etag') };
    // A gateway in front of the API that cannot reach it is an outage, not the cloud's answer.
    if (res.status === 502 || res.status === 503 || res.status === 504) return { kind: 'offline', reason: `HTTP ${res.status}` };
    return { kind: 'refused', status: res.status, body: parsed, detail: detailOf(parsed) };
  }

  get<T = unknown>(path: string, opts?: RequestOptions) {
    return this.request<T>('GET', path, opts);
  }

  post<T = unknown>(path: string, body?: unknown, opts?: RequestOptions) {
    return this.request<T>('POST', path, { ...opts, body: body ?? {} });
  }
}

/** The machine token was revoked (unpaired, or a replacement device took over): back to pairing. */
export function tokenRevoked(reply: ApiReply): boolean {
  return reply.kind === 'refused' && reply.status === 401 && /revoked|re-pair|invalid|expired|not found/i.test(reply.detail ?? '');
}

/* ---------------------------------------------------------------- pairing */

export interface KioskCredentials {
  /** apiBase() of the server it paired with. */
  serverUrl: string;
  accessToken: string;
  machineId: string;
  machineCode: string | null;
  tenantId: string | null;
  shopId: string | null;
  pairedAt: string;
}

export type PairResult = { ok: true; credentials: KioskCredentials } | { ok: false; error: string; status?: number };

/** "AB12 CD34" / "ab12-cd34" → "AB12CD34". */
export function normalizePairingCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[\s-]+/g, '');
}

/**
 * pairing/validate (snake_case only — camelCase loses the device info), as the Windows kiosk
 * (kiosk-desktop/src/main/sync/syncEngine.ts pair). What the device IS (a kiosk) comes from the
 * code; the browser says where it runs in `device_info` (platform "web", the browser, the screen).
 */
export async function pairWithCode(api: KioskApi, input: { serverUrl: string; code: string; machineName: string; deviceInfo: Record<string, string> }, now = new Date()): Promise<PairResult> {
  api.setBase(input.serverUrl);
  const code = normalizePairingCode(input.code);
  if (code.length < 6) return { ok: false, error: 'קוד הצימוד קצר מדי' };
  const reply = await api.post<Record<string, unknown>>(
    'pairing/validate',
    { code, machine_name: input.machineName.trim() || undefined, device_info: input.deviceInfo },
    { auth: false, timeoutMs: 30_000 },
  );
  if (reply.kind === 'offline') return { ok: false, error: `אין חיבור לשרת (${reply.reason})` };
  if (reply.kind === 'refused') {
    const said = messageOf(reply.body);
    if (said) return { ok: false, error: said, status: reply.status };
    if (reply.status === 400 || reply.status === 404) return { ok: false, error: 'קוד הצימוד שגוי או שפג תוקפו', status: reply.status };
    if (reply.status === 409) return { ok: false, error: reply.detail ?? 'המכשיר הקודם עדיין פתוח', status: 409 };
    return { ok: false, error: `שגיאת שרת ${reply.status}`, status: reply.status };
  }
  const b = reply.body ?? {};
  if (typeof b.accessToken !== 'string' || typeof b.machineId !== 'string') return { ok: false, error: 'תשובת צימוד לא תקינה' };
  return {
    ok: true,
    credentials: {
      serverUrl: apiBase(input.serverUrl),
      accessToken: b.accessToken,
      machineId: b.machineId,
      machineCode: typeof b.machineCode === 'string' ? b.machineCode : null,
      tenantId: typeof b.tenantId === 'string' ? b.tenantId : null,
      shopId: typeof b.shopId === 'string' ? b.shopId : null,
      pairedAt: now.toISOString(),
    },
  };
}

/* ------------------------------------------------------------ device info */

export interface BrowserFacts {
  userAgent: string;
  platform?: string | null;
  language?: string | null;
  screen?: { width: number; height: number; dpr: number } | null;
  standalone?: boolean;
  touch?: number;
}

/** The browser and the OS from the user agent, for people (the dashboard's device line), never for logic. */
export function describeBrowser(ua: string): { browser: string; os: string; model: string } {
  const os = /iPad/.test(ua) || (/Macintosh/.test(ua) && /Mobile/.test(ua))
    ? 'iPadOS'
    : /iPhone|iPod/.test(ua)
      ? 'iOS'
      : /Android/.test(ua)
        ? 'Android'
        : /Windows/.test(ua)
          ? 'Windows'
          : /CrOS/.test(ua)
            ? 'ChromeOS'
            : /Mac OS X|Macintosh/.test(ua)
              ? 'macOS'
              : /Linux/.test(ua)
                ? 'Linux'
                : 'other';
  const browser = /EdgA?\//.test(ua)
    ? 'Edge'
    : /SamsungBrowser\//.test(ua)
      ? 'Samsung Internet'
      : /CriOS\//.test(ua)
        ? 'Chrome (iOS)'
        : /FxiOS\//.test(ua)
          ? 'Firefox (iOS)'
          : /Firefox\//.test(ua)
            ? 'Firefox'
            : /Chrome\//.test(ua)
              ? 'Chrome'
              : /Safari\//.test(ua)
                ? 'Safari'
                : 'browser';
  const android = /Android [\d.]+; ([^;)]+)/.exec(ua)?.[1]?.trim();
  const model = android && !/^(K|wv)$/.test(android) ? android : os === 'iPadOS' ? 'iPad' : os === 'iOS' ? 'iPhone' : `${os} PC`;
  return { browser, os, model };
}

/**
 * `device_info` for pairing/validate: "web" as the platform (the cloud stores it with the machine —
 * the dashboard sees a browser kiosk), the browser, the OS, the screen. Strings only, as the tills send.
 */
export function webDeviceInfo(f: BrowserFacts, appVersion: string): Record<string, string> {
  const d = describeBrowser(f.userAgent);
  const out: Record<string, string> = {
    platform: 'web',
    client: 'r2m-web-kiosk',
    appVersion,
    browser: d.browser,
    os: d.os,
    model: d.model,
    manufacturer: d.os === 'iOS' || d.os === 'iPadOS' || d.os === 'macOS' ? 'Apple' : 'browser',
    userAgent: f.userAgent.slice(0, 300),
  };
  if (f.platform) out.browserPlatform = f.platform.slice(0, 60);
  if (f.language) out.language = f.language.slice(0, 20);
  if (f.screen) out.screen = `${f.screen.width}x${f.screen.height}@${f.screen.dpr}`;
  if (f.standalone !== undefined) out.installed = f.standalone ? 'yes' : 'no';
  if (f.touch !== undefined) out.touchPoints = String(f.touch);
  return out;
}
