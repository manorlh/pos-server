/**
 * "מסך לקוח" in a browser (`/display`, P:/specs/customer-display.md §4): any device facing the
 * customer — a TV stick, an old tablet, an iPad, a PC — paired as the customer display of a till.
 * Read only: it sends nothing but its heartbeat.
 *
 *  - pairing with a code from the dashboard ("הוספת מכשיר" → מסך לקוח → "דפדפן (Web)"); the token is
 *    kept like the other browser screens (lib/kioskWebStore.ts, database `r2m-display`);
 *  - its configuration (`sync/{m}/customer-display`, ETag) at start and every `poll.configSec`;
 *  - the till's screen through the cloud relay (`sync/{m}/customer-display/state?after=seq`) every
 *    `poll.relayMs` — a page served over https cannot reach the till's LAN server (http), so the
 *    browser always reads through the cloud; an Android display reads the LAN first;
 *  - a heartbeat every 30 s; a revoked token (401) goes back to pairing.
 *
 * Pure of React and of the DOM (the browser's facts come in through `deps`), so the node tests
 * drive it with a fake fetch and a memory store. No `@/` imports.
 */

import { KioskApi, apiBase, pairWithCode, tokenRevoked, type ApiReply, type FetchFn, type KioskCredentials } from './kioskWebApi';
import type { KvStore } from './kioskWebStore';
import { DEFAULTS, IDLE_STATE, parseState, type CdConfig, type CdState } from './customerDisplay';

export const KEYS = {
  credentials: 'r2m.display.credentials',
  config: 'r2m.display.config',
} as const;

export const BEAT_MS = 30_000;
const DEFAULT_RELAY_MS = 1_500;
const DEFAULT_CONFIG_MS = 120_000;
/** No answer from the cloud for this long: "מחכה לקופה…" over the last screen. */
export const OFFLINE_AFTER_MS = 15_000;

export interface DisplayConfigPayload {
  config: CdConfig;
  branding: { shopName: string; logoUrl: string; primaryColor: string | null };
  media: { url: string; kind: string; bytes: number | null }[];
  poll: { configSec: number; relayMs: number; lanMs: number };
  role: 'till' | 'display';
  till?: { machineId: string; name: string } | null;
}

export type DisplayPhase = 'loading' | 'unpaired' | 'ready';

export interface DisplayWebView {
  phase: DisplayPhase;
  config: CdConfig;
  branding: DisplayConfigPayload['branding'];
  tillName: string | null;
  state: CdState;
  /** The cloud answered lately. */
  online: boolean;
  /** Paired, but the cloud says this device is no customer display (a KDS's code, a till's). */
  wrongRole: string | null;
}

export interface DisplayWebDeps {
  store: KvStore;
  fetchFn: FetchFn;
  defaultServer: string;
  appVersion: string;
  deviceInfo: () => Record<string, string>;
  now?: () => number;
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (id: unknown) => void };
  log?: (msg: string) => void;
}

export type DisplayPairOutcome = { ok: true } | { ok: false; error: string };

/** The configuration from the wire, safe to use (anything missing is the default). */
export function parseConfigPayload(raw: unknown): DisplayConfigPayload | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const c = (o.config && typeof o.config === 'object' ? o.config : {}) as Partial<CdConfig>;
  const b = (o.branding && typeof o.branding === 'object' ? o.branding : {}) as Record<string, unknown>;
  const p = (o.poll && typeof o.poll === 'object' ? o.poll : {}) as Record<string, unknown>;
  const till = o.till && typeof o.till === 'object' ? (o.till as Record<string, unknown>) : null;
  return {
    config: { ...DEFAULTS, ...c, show: { ...DEFAULTS.show, ...(c.show ?? {}) }, playlist: Array.isArray(c.playlist) ? c.playlist : [] },
    branding: {
      shopName: typeof b.shopName === 'string' ? b.shopName : '',
      logoUrl: typeof b.logoUrl === 'string' ? b.logoUrl : '',
      primaryColor: typeof b.primaryColor === 'string' ? b.primaryColor : null,
    },
    media: Array.isArray(o.media) ? (o.media as DisplayConfigPayload['media']) : [],
    poll: {
      configSec: typeof p.configSec === 'number' && p.configSec >= 10 ? p.configSec : DEFAULT_CONFIG_MS / 1000,
      relayMs: typeof p.relayMs === 'number' && p.relayMs >= 500 ? p.relayMs : DEFAULT_RELAY_MS,
      lanMs: typeof p.lanMs === 'number' ? p.lanMs : 700,
    },
    role: o.role === 'display' ? 'display' : 'till',
    till: till && typeof till.machineId === 'string' ? { machineId: till.machineId, name: typeof till.name === 'string' ? till.name : '' } : null,
  };
}

export class CustomerDisplayWebService {
  readonly api: KioskApi;
  private creds: KioskCredentials | null = null;
  private payload: DisplayConfigPayload | null = null;
  private etag: string | null = null;
  private state: CdState = IDLE_STATE;
  private seq = -1;
  private loaded = false;
  private stopped = true;
  private timer: unknown = null;
  private busy = false;
  private lastAnswerAt: number | null = null;
  /** -Infinity: never asked (due at once, whatever the clock reads). */
  private lastConfigAt = Number.NEGATIVE_INFINITY;
  private lastBeatAt = Number.NEGATIVE_INFINITY;
  private wrongRole: string | null = null;
  private lastViewJson = '';
  private readonly listeners = new Set<(v: DisplayWebView) => void>();

  constructor(private readonly deps: DisplayWebDeps) {
    this.api = new KioskApi(apiBase(deps.defaultServer || 'https://invalid.local'), () => this.creds?.accessToken ?? null, deps.fetchFn);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  async init(): Promise<DisplayWebView> {
    this.creds = await this.deps.store.get<KioskCredentials>(KEYS.credentials);
    this.payload = parseConfigPayload(await this.deps.store.get<unknown>(KEYS.config));
    if (this.creds) this.api.setBase(this.creds.serverUrl);
    this.loaded = true;
    if (this.creds) this.start();
    this.changed();
    return this.view();
  }

  start() {
    if (!this.creds) return;
    this.stopped = false;
    this.schedule(0);
  }

  stop() {
    this.stopped = true;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private setTimer(fn: () => void, ms: number): unknown {
    return this.deps.timers ? this.deps.timers.set(fn, ms) : setTimeout(fn, ms);
  }

  private clearTimer(id: unknown) {
    if (this.deps.timers) this.deps.timers.clear(id);
    else clearTimeout(id as ReturnType<typeof setTimeout>);
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => void this.tick(), ms);
  }

  /** One round: the configuration when due, the heartbeat when due, the till's state always. */
  async tick(): Promise<void> {
    if (this.busy || !this.creds) return;
    this.busy = true;
    try {
      const now = this.now();
      const configMs = (this.payload?.poll.configSec ?? DEFAULT_CONFIG_MS / 1000) * 1000;
      if (now - this.lastConfigAt >= configMs) await this.pullConfig();
      if (this.creds && now - this.lastBeatAt >= BEAT_MS) await this.heartbeat();
      if (this.creds && !this.wrongRole) await this.pullState();
    } finally {
      this.busy = false;
      this.changed();
      this.schedule(this.payload?.poll.relayMs ?? DEFAULT_RELAY_MS);
    }
  }

  view(): DisplayWebView {
    const online = this.lastAnswerAt !== null && this.now() - this.lastAnswerAt < OFFLINE_AFTER_MS;
    return {
      phase: !this.loaded ? 'loading' : this.creds ? 'ready' : 'unpaired',
      config: this.payload?.config ?? DEFAULTS,
      branding: this.payload?.branding ?? { shopName: '', logoUrl: '', primaryColor: null },
      tillName: this.payload?.till?.name ?? null,
      state: this.state,
      online,
      wrongRole: this.wrongRole,
    };
  }

  onView(fn: (v: DisplayWebView) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private changed() {
    const v = this.view();
    const json = JSON.stringify(v);
    if (json === this.lastViewJson) return;
    this.lastViewJson = json;
    for (const fn of this.listeners) fn(v);
  }

  async pair(input: { code: string; machineName: string; serverUrl?: string | null }): Promise<DisplayPairOutcome> {
    if (this.creds) return { ok: false, error: 'המסך כבר מצומד' };
    const serverUrl = input.serverUrl?.trim() || this.deps.defaultServer;
    if (!serverUrl) return { ok: false, error: 'חסרה כתובת השרת' };
    const r = await pairWithCode(this.api, { serverUrl, code: input.code, machineName: input.machineName, deviceInfo: this.deps.deviceInfo() }, new Date(this.now()));
    if (!r.ok) return { ok: false, error: r.error };
    this.creds = r.credentials;
    await this.deps.store.set(KEYS.credentials, r.credentials);
    this.api.setBase(r.credentials.serverUrl);
    this.lastConfigAt = Number.NEGATIVE_INFINITY;
    this.start();
    this.changed();
    return { ok: true };
  }

  /** "ניתוק": this browser forgets the pairing (the cloud keeps the machine; a new code pairs again). */
  async unpair(): Promise<void> {
    this.stop();
    this.creds = null;
    this.payload = null;
    this.etag = null;
    this.state = IDLE_STATE;
    this.seq = -1;
    this.wrongRole = null;
    this.lastAnswerAt = null;
    this.lastConfigAt = Number.NEGATIVE_INFINITY;
    this.lastBeatAt = Number.NEGATIVE_INFINITY;
    await this.deps.store.del(KEYS.credentials);
    await this.deps.store.del(KEYS.config);
    this.changed();
  }

  private async seen<T>(reply: ApiReply<T>): Promise<ApiReply<T>> {
    if (reply.kind === 'offline') return reply;
    this.lastAnswerAt = this.now();
    if (tokenRevoked(reply) && this.creds) {
      this.deps.log?.('machine token revoked: back to pairing');
      await this.unpair();
    }
    return reply;
  }

  async pullConfig(): Promise<void> {
    if (!this.creds) return;
    this.lastConfigAt = this.now();
    const headers: Record<string, string> = this.etag ? { 'If-None-Match': this.etag } : {};
    const r = await this.seen(await this.api.get<unknown>(`sync/${this.creds.machineId}/customer-display`, { timeoutMs: 20_000, headers }));
    if (r.kind !== 'ok' || r.status === 304 || !this.creds) return;
    const parsed = parseConfigPayload(r.body);
    if (!parsed) return;
    this.etag = r.etag;
    this.payload = parsed;
    this.wrongRole = parsed.role === 'display' ? null : 'הקוד שהוקלד אינו של מסך לקוח. צרו בדשבורד קוד "מסך לקוח".';
    await this.deps.store.set(KEYS.config, r.body);
  }

  async pullState(): Promise<void> {
    if (!this.creds) return;
    const after = this.seq >= 0 ? `?after=${this.seq}` : '';
    const r = await this.seen(await this.api.get<{ seq?: number; state?: unknown }>(`sync/${this.creds.machineId}/customer-display/state${after}`, { timeoutMs: 10_000 }));
    if (r.kind !== 'ok' || r.status === 204 || !r.body) return;
    const seq = typeof r.body.seq === 'number' ? r.body.seq : 0;
    this.seq = seq;
    this.state = parseState(r.body.state);
  }

  private async heartbeat() {
    if (!this.creds) return;
    this.lastBeatAt = this.now();
    await this.seen(await this.api.post('machines/me/heartbeat', { appVersion: this.deps.appVersion, pendingCount: 0, realtimeConnected: false }, { timeoutMs: 15_000 }));
  }
}
