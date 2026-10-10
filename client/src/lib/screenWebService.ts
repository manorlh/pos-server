/**
 * The browser KDS and "מסך מוכן / לא מוכן" board's local service (`/kds`, `/board` on the
 * dashboard's site — docs/SPEC_KDS.md §13): what the Windows app's shell is to its role screens,
 * for a browser. Display devices only — not a till: no documents, no shifts, no payments (the
 * cloud refuses them too: `is_fiscal = false`).
 *
 *  - pairing with a code from the dashboard ("הוספת מכשיר" → מסך מטבח / מסך מוכן → "דפדפן (Web)");
 *    the browser says it is "web" (`device_info.platform`), the code says what it is. The machine
 *    token is kept in IndexedDB, mirrored to localStorage (lib/kioskWebStore.ts, a database per
 *    route: `r2m-kds` / `r2m-board`);
 *  - the screens' engine is the Windows app's own (lib/kdsScreenEngine.ts): the feed every 3 s with
 *    the last board kept (a reload with no network shows it at once), and the KDS actions' ordered,
 *    durable outbox (sent at once and shown applied; without a connection kept and sent in order,
 *    with the same ids, when it is back);
 *  - a heartbeat every 30 s (the dashboard's "מחובר", the version), `machines/me` at start and
 *    every 15 minutes (the name, the shop, the role);
 *  - what it shows follows the cloud: a `pickup` screen is the board, any other KDS screen the
 *    kitchen screen — whatever the route. Right after pairing, a code of another route hands the
 *    credentials over (`handoff`: the board's code typed at `/kds` opens `/board`, a kiosk's `/k`);
 *  - a revoked token (401) goes back to pairing.
 *
 * Pure of React and of the DOM (the browser's facts come in through `deps`), so the node tests
 * drive it with a fake fetch and a memory store. No `@/` imports.
 */

import { KioskApi, apiBase, pairWithCode, tokenRevoked, type ApiReply, type FetchFn, type KioskCredentials } from './kioskWebApi';
import type { KvStore } from './kioskWebStore';
import { KDS_CACHE_KEY, KDS_OUTBOX_KEY, KdsModule, boardView, feedShows, type RoleApi, type RoleApiReply, type RoleKv } from './kdsScreenEngine';
import type { BoardView, KdsActionInput, KdsView } from './kdsScreenTypes';

export type ScreenRoute = 'kds' | 'board';

export const BEAT_MS = 30_000;
export const MACHINE_MS = 15 * 60_000;

/** The route's own keys (localStorage is one per site, so every key names its route). */
export function screenKeys(route: ScreenRoute) {
  return {
    credentials: `r2m.${route}.credentials`,
    machine: `r2m.${route}.machine`,
    /** The parameter `technicianCode` (the staff sheet's code), from `sync/{m}/parameters`. */
    technicianCode: `r2m.${route}.technicianCode`,
    /** The engine's keys (the board cache, the outbox) live under this prefix. */
    kvPrefix: `r2m.${route}.kv.`,
  } as const;
}

/** The route's database and the keys mirrored to localStorage (lib/kioskWebStore.ts `openKioskStore`). */
export function screenStoreOptions(route: ScreenRoute): { dbName: string; mirrored: string[] } {
  return { dbName: `r2m-${route}`, mirrored: [screenKeys(route).credentials] };
}

/** The engine's keys a screen keeps. */
const ENGINE_KEYS = [KDS_CACHE_KEY, KDS_OUTBOX_KEY];

/**
 * The engine's synchronous kv over the browser's asynchronous store: read once at start, then
 * every write kept in memory at once and written behind, in order (the outbox's order is the
 * order of the writes).
 */
export class ScreenKv implements RoleKv {
  private readonly map = new Map<string, string>();
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private readonly store: KvStore,
    private readonly prefix: string,
  ) {}

  async load(keys: readonly string[]): Promise<void> {
    for (const k of keys) {
      const v = await this.store.get<unknown>(this.prefix + k);
      if (v !== null && v !== undefined) this.map.set(k, JSON.stringify(v));
    }
  }

  getJson<T>(key: string): T | null {
    const raw = this.map.get(key);
    if (raw === undefined) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }

  setJson(key: string, value: unknown): void {
    const json = JSON.stringify(value);
    this.map.set(key, json);
    this.chain = this.chain.then(() => this.store.set(this.prefix + key, JSON.parse(json))).catch(() => undefined);
  }

  /** Every write so far is in the store. */
  flush(): Promise<void> {
    return this.chain;
  }

  async clear(keys: readonly string[]): Promise<void> {
    for (const k of keys) this.map.delete(k);
    await this.flush();
    for (const k of keys) await this.store.del(this.prefix + k);
  }
}

export type ScreenPhase = 'loading' | 'unpaired' | 'ready';

export interface ScreenWebView {
  phase: ScreenPhase;
  route: ScreenRoute;
  /** What the screen shows: the cloud's word (a `pickup` device is the board), else the route's. */
  shows: ScreenRoute;
  machine: {
    machineId: string;
    name: string | null;
    shopName: string | null;
    /** `machines/me` deviceRole (kds / order_status_board; a till or a kiosk is not a screen). */
    deviceRole: string | null;
    serverUrl: string;
  } | null;
  /** The cloud answered lately (any call). */
  online: boolean;
  lastBeatOkAt: number | null;
  pendingActions: number;
  storage: string;
  appVersion: string;
  /** The parameter `technicianCode` (a PBKDF2 hash) when the cloud set one; else the default code opens the staff sheet. */
  technicianCode: string | null;
}

export interface ScreenWebDeps {
  route: ScreenRoute;
  store: KvStore;
  fetchFn: FetchFn;
  /** The dashboard's own API (NEXT_PUBLIC_API_URL): pairing asks only the code. */
  defaultServer: string;
  appVersion: string;
  deviceInfo: () => Record<string, string>;
  now?: () => number;
  uuid?: () => string;
  /** The feed's cadence (3 s). */
  feedEveryMs?: number;
  log?: (msg: string) => void;
  timers?: { set: (fn: () => void, ms: number) => unknown; clear: (id: unknown) => void };
}

export type PairOutcome = { ok: true; handoff: ScreenRoute | 'k' | null } | { ok: false; error: string };

/** The route a machine's role belongs to: a board, a KDS, or the kiosk (`/k`); null for a till / unknown. */
export function routeOfRole(deviceRole: unknown): ScreenRoute | 'k' | null {
  if (deviceRole === 'order_status_board') return 'board';
  if (deviceRole === 'kds') return 'kds';
  if (deviceRole === 'kiosk') return 'k';
  return null;
}

type ScreenEvents = { kds: KdsView; board: BoardView };

export class ScreenWebService {
  readonly api: KioskApi;
  private creds: KioskCredentials | null = null;
  private machine: Record<string, unknown> | null = null;
  private technicianCode: string | null = null;
  private kv: ScreenKv;
  private kds: KdsModule | null = null;
  private loaded = false;
  private lastAnswerAt: number | null = null;
  private lastBeatOkAt: number | null = null;
  private lastBeatAt = 0;
  private lastMachineAt = 0;
  private timer: unknown = null;
  private stopped = true;
  private beating = false;
  private lastViewJson = '';
  private readonly viewListeners = new Set<(v: ScreenWebView) => void>();
  private readonly listeners: { [K in keyof ScreenEvents]: Set<(p: ScreenEvents[K]) => void> } = { kds: new Set(), board: new Set() };
  private readonly keys: ReturnType<typeof screenKeys>;
  /** The credentials of a pairing handed to another route (the page writes them there). */
  handedOver: KioskCredentials | null = null;

  constructor(private readonly deps: ScreenWebDeps) {
    this.keys = screenKeys(deps.route);
    this.kv = new ScreenKv(deps.store, this.keys.kvPrefix);
    this.api = new KioskApi(apiBase(deps.defaultServer || 'https://invalid.local'), () => this.creds?.accessToken ?? null, deps.fetchFn);
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private log(msg: string) {
    this.deps.log?.(msg);
  }

  /* ------------------------------------------------------------------- life */

  /** Loads what the screen kept (credentials, the last board, the waiting actions) and starts when paired. */
  async init(): Promise<ScreenWebView> {
    const s = this.deps.store;
    this.creds = await s.get<KioskCredentials>(this.keys.credentials);
    this.machine = await s.get<Record<string, unknown>>(this.keys.machine);
    this.technicianCode = await s.get<string>(this.keys.technicianCode);
    await this.kv.load(ENGINE_KEYS);
    if (this.creds) this.api.setBase(this.creds.serverUrl);
    this.loaded = true;
    if (this.creds) this.start();
    this.changed();
    return this.view();
  }

  start() {
    if (!this.creds) return;
    this.stopped = false;
    if (!this.kds) {
      this.kds = new KdsModule(this.context(), () => this.onEngine(), { now: this.deps.now, uuid: this.deps.uuid, feedEveryMs: this.deps.feedEveryMs });
      this.kds.start();
    }
    this.schedule(0);
  }

  stop() {
    this.stopped = true;
    this.kds?.stop();
    this.kds = null;
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
  }

  private context() {
    const api: RoleApi = {
      get: async (path, opts) => (await this.seen(await this.api.get(path, opts))) as RoleApiReply,
      post: async (path, body, opts) => (await this.seen(await this.api.post(path, body, opts))) as RoleApiReply,
    };
    return { api, kv: this.kv, machineId: () => this.creds?.machineId ?? null, log: (m: string) => this.log(m) };
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

  /** The heartbeat (30 s) and `machines/me` (15 min); the feed runs on its own timer. */
  async tick(): Promise<void> {
    if (this.beating || !this.creds) return;
    this.beating = true;
    try {
      const now = this.now();
      if (now - this.lastMachineAt >= MACHINE_MS) await this.pullMachine();
      if (this.creds && now - this.lastBeatAt >= BEAT_MS) await this.heartbeat();
    } finally {
      this.beating = false;
      this.schedule(BEAT_MS);
    }
  }

  /** The browser went on line, or the tab came back: the board and the waiting actions at once. */
  networkChanged() {
    void this.refresh();
  }

  /** The board now, then the waiting actions in order. */
  async refresh(): Promise<void> {
    if (!this.kds) return;
    await this.kds.feed.refresh();
    await this.kds?.drain();
  }

  /* ------------------------------------------------------------------ views */

  view(): ScreenWebView {
    const m = this.machine;
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
    const shows = (this.kds ? feedShows(this.kds.feed.state()) : null) ?? this.deps.route;
    return {
      phase: !this.loaded ? 'loading' : this.creds ? 'ready' : 'unpaired',
      route: this.deps.route,
      shows,
      machine: this.creds
        ? {
            machineId: this.creds.machineId,
            name: str(m?.machineName) ?? str(m?.name),
            shopName: str(m?.shopName),
            deviceRole: str(m?.deviceRole),
            serverUrl: this.creds.serverUrl,
          }
        : null,
      online: this.lastAnswerAt !== null && !(this.kds?.feed.state().offline ?? false),
      lastBeatOkAt: this.lastBeatOkAt,
      pendingActions: this.kds?.outbox().length ?? 0,
      storage: this.deps.store.kind,
      appVersion: this.deps.appVersion,
      technicianCode: this.technicianCode,
    };
  }

  onView(fn: (v: ScreenWebView) => void): () => void {
    this.viewListeners.add(fn);
    return () => void this.viewListeners.delete(fn);
  }

  private changed() {
    const v = this.view();
    const json = JSON.stringify(v);
    if (json === this.lastViewJson) return;
    this.lastViewJson = json;
    for (const fn of this.viewListeners) fn(v);
  }

  private onEngine() {
    if (!this.kds) return;
    const k = this.kds.view();
    for (const fn of this.listeners.kds) fn(k);
    const b = boardView(this.kds.feed.state());
    for (const fn of this.listeners.board) fn(b);
    this.changed();
  }

  /* ------------------------------------------------- the role screens' bridge */

  async kdsView(): Promise<KdsView> {
    return this.kds ? this.kds.view() : emptyKds();
  }

  async boardView(): Promise<BoardView> {
    return this.kds ? boardView(this.kds.feed.state()) : { shopName: null, preparing: [], ready: [], updatedAt: null, offline: true, notConfigured: false, display: null };
  }

  async kdsAction(a: KdsActionInput): Promise<{ ok: boolean; message?: string }> {
    if (!this.kds) return { ok: false, message: 'המכשיר לא מצומד' };
    return this.kds.action(a);
  }

  /** What the shared screens (kiosk-shared/roles) read: the RoleScreenBridge's shape. */
  bridge() {
    return {
      kds: () => this.kdsView(),
      board: () => this.boardView(),
      kdsAction: (a: KdsActionInput) => this.kdsAction(a),
      activity: () => undefined,
      on: <K extends keyof ScreenEvents>(event: K, fn: (payload: ScreenEvents[K]) => void): (() => void) => {
        const set = this.listeners[event] as Set<(p: ScreenEvents[K]) => void>;
        set.add(fn);
        return () => void set.delete(fn);
      },
    };
  }

  /* ---------------------------------------------------------------- pairing */

  credentials(): KioskCredentials | null {
    return this.creds;
  }

  async pair(input: { code: string; machineName: string; serverUrl?: string | null }): Promise<PairOutcome> {
    if (this.creds) return { ok: false, error: 'המסך כבר מצומד' };
    const serverUrl = input.serverUrl?.trim() || this.deps.defaultServer;
    if (!serverUrl) return { ok: false, error: 'חסרה כתובת השרת' };
    const r = await pairWithCode(this.api, { serverUrl, code: input.code, machineName: input.machineName, deviceInfo: this.deps.deviceInfo() }, new Date(this.now()));
    if (!r.ok) return { ok: false, error: r.error };
    this.creds = r.credentials;
    await this.deps.store.set(this.keys.credentials, r.credentials);
    this.api.setBase(r.credentials.serverUrl);
    await this.pullMachine();
    const belongs = routeOfRole(this.machine?.deviceRole);
    if (belongs && belongs !== this.deps.route) {
      // Another route's code (the board's typed at /kds, a kiosk's): its page takes the credentials.
      this.log(`paired as ${String(this.machine?.deviceRole)}: handed over to /${belongs}`);
      const creds = this.creds;
      await this.forget();
      this.creds = null;
      this.handedOver = creds;
      this.changed();
      return { ok: true, handoff: belongs };
    }
    this.start();
    this.changed();
    return { ok: true, handoff: null };
  }

  /** "ניתוק": this browser forgets the screen (the cloud keeps the machine; a new code pairs again). */
  async unpair(): Promise<void> {
    await this.forget();
    this.changed();
  }

  private async forget() {
    this.stop();
    this.creds = null;
    this.machine = null;
    this.technicianCode = null;
    this.lastAnswerAt = null;
    this.lastBeatOkAt = null;
    this.lastBeatAt = 0;
    this.lastMachineAt = 0;
    await this.kv.clear(ENGINE_KEYS);
    for (const key of [this.keys.credentials, this.keys.machine, this.keys.technicianCode]) await this.deps.store.del(key);
  }

  /* ------------------------------------------------------------------- sync */

  /** Every reply goes through here: the connection, and a revoked token ends the pairing. */
  private async seen<T>(reply: ApiReply<T>): Promise<ApiReply<T>> {
    if (reply.kind === 'offline') return reply;
    this.lastAnswerAt = this.now();
    if (tokenRevoked(reply) && this.creds) {
      this.log('machine token revoked: back to pairing');
      await this.unpair();
    }
    return reply;
  }

  private async pullMachine() {
    this.lastMachineAt = this.now();
    const r = await this.seen(await this.api.get<Record<string, unknown>>('machines/me', { timeoutMs: 20_000 }));
    if (r.kind !== 'ok' || !r.body || typeof r.body !== 'object' || !this.creds) return;
    this.machine = r.body;
    await this.deps.store.set(this.keys.machine, r.body);
    this.changed();
    await this.pullParameters();
  }

  /** `technicianCode` only (the parameters are open to a display device). */
  private async pullParameters() {
    if (!this.creds) return;
    const r = await this.seen(await this.api.get<{ parameters?: Record<string, unknown> }>(`sync/${this.creds.machineId}/parameters`, { timeoutMs: 20_000 }));
    if (r.kind !== 'ok' || !r.body?.parameters || typeof r.body.parameters !== 'object' || !this.creds) return;
    const code = r.body.parameters.technicianCode;
    this.technicianCode = typeof code === 'string' && code.trim() ? code.trim() : null;
    await this.deps.store.set(this.keys.technicianCode, this.technicianCode);
    this.changed();
  }

  private async heartbeat() {
    this.lastBeatAt = this.now();
    const pending = this.kds?.outbox().length ?? 0;
    const r = await this.seen(await this.api.post('machines/me/heartbeat', { appVersion: this.deps.appVersion, pendingCount: pending, realtimeConnected: false }, { timeoutMs: 15_000 }));
    if (r.kind === 'ok') this.lastBeatOkAt = this.now();
    this.changed();
  }

  /** Every write of the engine is in the store (tests; before a handoff). */
  flush(): Promise<void> {
    return this.kv.flush();
  }
}

function emptyKds(): KdsView {
  return { device: null, shopName: null, orders: [], stationSettings: {}, updatedAt: null, offline: true, pendingActions: 0, lastError: null, serverOffsetMs: 0 };
}
