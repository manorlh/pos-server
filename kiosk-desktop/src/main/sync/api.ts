/**
 * The cloud's till API, spoken exactly as the Android till speaks it (pos-android
 * data/remote/ApiClient.kt, PosApi.kt, KioskApi.kt):
 *
 *  - base = the server URL as typed, trimmed, without a trailing "/", with "/api/v1" added when it
 *    names no /api/vN;
 *  - `Authorization: Bearer <machine JWT>` on every call once paired (the token never expires and
 *    is never refreshed; 401 "Machine token revoked" means re-pair);
 *  - camelCase JSON, except pairing/validate (snake_case only).
 *
 * Every call answers ok / refused (an HTTP status the cloud chose) / offline (no answer) — never
 * throws on the network, so callers decide what an outage means.
 */

export type ApiReply<T = unknown> =
  | { kind: 'ok'; status: number; body: T; headers: Headers }
  | { kind: 'refused'; status: number; body: unknown; detail: string | null; headers: Headers }
  | { kind: 'offline'; reason: string };

export function apiBase(serverUrl: string): string {
  let s = serverUrl.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  if (!/\/api\/v\d+$/i.test(s)) s = `${s}/api/v1`;
  return `${s}/`;
}

/** FastAPI's `{"detail": "..."}` (a string), else null. */
export function detailOf(body: unknown): string | null {
  if (body && typeof body === 'object' && typeof (body as { detail?: unknown }).detail === 'string') return (body as { detail: string }).detail;
  return null;
}

export interface RequestOptions {
  body?: unknown;
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** Send the machine token (default true). */
  auth?: boolean;
}

export type FetchFn = typeof fetch;

export class Api {
  constructor(
    private baseUrl: string,
    private readonly token: () => string | null,
    private readonly fetchFn: FetchFn = (...a) => fetch(...a),
    private readonly userAgent = 'R2M-Kiosk-Windows',
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
    const headers: Record<string, string> = { Accept: 'application/json', 'User-Agent': this.userAgent, ...(opts.headers ?? {}) };
    const token = opts.auth === false ? null : this.token();
    if (token) headers.Authorization = `Bearer ${token}`;
    let body: string | undefined;
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
      body = JSON.stringify(opts.body);
    }
    let res: Response;
    try {
      res = await this.fetchFn(this.url(path), { method, headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 45_000) });
    } catch (e) {
      return { kind: 'offline', reason: e instanceof Error ? `${e.name}: ${e.message}` : String(e) };
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
    if (res.ok || res.status === 304) return { kind: 'ok', status: res.status, body: parsed as T, headers: res.headers };
    // A gateway in front of the API that cannot reach it is an outage, not the cloud's answer.
    if (res.status === 502 || res.status === 503 || res.status === 504) return { kind: 'offline', reason: `HTTP ${res.status}` };
    return { kind: 'refused', status: res.status, body: parsed, detail: detailOf(parsed), headers: res.headers };
  }

  get<T = unknown>(path: string, opts?: RequestOptions) {
    return this.request<T>('GET', path, opts);
  }

  post<T = unknown>(path: string, body?: unknown, opts?: RequestOptions) {
    return this.request<T>('POST', path, { ...opts, body: body ?? {} });
  }

  put<T = unknown>(path: string, body?: unknown, opts?: RequestOptions) {
    return this.request<T>('PUT', path, { ...opts, body: body ?? {} });
  }
}

/** The machine token was revoked (unpaired, or a replacement device took over): back to pairing. */
export function tokenRevoked(reply: ApiReply): boolean {
  return reply.kind === 'refused' && reply.status === 401 && /revoked|re-pair/i.test(reply.detail ?? '');
}
