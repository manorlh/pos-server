/**
 * The KDS and "מסך מוכן / לא מוכן" screens' engine — the feed, the KDS actions' ordered outbox and
 * the views — shared by every host: the Windows app's shell (kiosk-desktop/src/main/roles/{feed,
 * kds,board}.ts re-export it over its SQLite kv and its Api) and the browser screens at `/kds` and
 * `/board` (lib/screenWebService.ts, over IndexedDB / localStorage and fetch). One code, so a
 * kitchen screen in a browser queues, retries and overlays exactly as the Windows one.
 *
 * Not a till: no documents, no shifts, no payments — the cloud's `kds/*` endpoints only, which are
 * open to display devices (`is_fiscal = false`, docs/SPEC_DEVICE_ROLE_MODEL.md §2.2).
 *
 * **The feed** (`KdsFeed`): `GET /sync/{m}/kds/board?since=<version>` on a short timer (the screens'
 * cadence on Android and the public pickup screen: 3 s), the last full answer kept in the kv so a
 * restart / reload without internet still shows the last board. Shared by the KDS screen (orders)
 * and the order status board (the `pickup` payload of a `pickup` KDS device) — the cloud answers
 * each device by its own KDS role.
 *
 * **The actions** (`KdsModule`, as the Android KdsOutbox, docs/SPEC_KDS.md §9):
 *  - each gets its idempotency id (a UUID), `occurredAt` on the cloud's clock and — only for an
 *    item action sent at once from a live board, with nothing of this screen still in flight for
 *    it — the item's `expectedVersion` (the cloud's 409 version_conflict for a stale tap);
 *  - it goes out at once and is shown applied at once (kdsBoard.ts `applyPending`);
 *  - without an answer (offline, 502–504) or on a server error (5xx, 408, 429) it stays in an
 *    ordered outbox in the kv (it survives a restart) and is retried, in order, on the next good
 *    poll — the same id, so a retry is the same action in the cloud. A waiting action is a late
 *    action: it is retried without `expectedVersion` (the cloud's offline rules apply — it acts on
 *    the active quantity only, never reviving a cancellation; "prepared before the cancel" is
 *    recorded from `occurredAt`). A server error gives up after a few backed-off tries;
 *  - a refusal (4xx, or the cloud's `outcome: rejected`) drops it and says why, in Hebrew;
 *  - a delivered action stays drawn until the board shows it (no flicker), then the feed refreshes.
 *
 * Self-contained (no `@/` imports, no Node or DOM APIs beyond timers and `crypto`): the node tests
 * and kiosk-desktop's main process compile it as is.
 */

import type { BoardView, KdsActionInput, KdsOrder, KdsView } from './kdsScreenTypes';
import { ACTION_TEXT, applyPending, checkAction, isSettled, orderTitle, refusalText, screenRole, type OverlayAction, type Settling } from './kdsBoard';
import { boardDisplayOf, boardOf } from './pickupBoard';

/* ------------------------------------------------------------- the host's parts */

/** What a call answered: the shape both hosts' APIs return (extra fields — headers, date — allowed). */
export type RoleApiReply<T = unknown> =
  | { kind: 'ok'; status: number; body: T; [extra: string]: unknown }
  | { kind: 'refused'; status: number; body: unknown; detail?: string | null; [extra: string]: unknown }
  | { kind: 'offline'; reason: string };

/** The host's API (bodies come back as `unknown`: the engine checks every one it reads). */
export interface RoleApi {
  get(path: string, opts?: { timeoutMs?: number }): Promise<RoleApiReply>;
  post(path: string, body?: unknown, opts?: { timeoutMs?: number }): Promise<RoleApiReply>;
}

/** A synchronous JSON key-value store (the Windows app's SQLite kv; the browser's memory copy of IndexedDB). */
export interface RoleKv {
  getJson<T>(key: string): T | null;
  setJson(key: string, value: unknown): void;
}

export interface RoleContext {
  api: RoleApi;
  kv: RoleKv;
  machineId(): string | null;
  log(m: string): void;
}

type Timer = ReturnType<typeof setTimeout>;

/** Lets a Node host exit with a timer pending (a browser's timer is a number: nothing to do). */
function unref(t: Timer | null) {
  (t as unknown as { unref?: () => void } | null)?.unref?.();
}

/** An RFC 4122 v4 id: `crypto.randomUUID` where there is one (a secure context), else from random bytes. */
export function uuid4(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string; getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.randomUUID) {
    try {
      return c.randomUUID();
    } catch {
      /* an insecure context (http on the LAN): the bytes below */
    }
  }
  const b = new Uint8Array(16);
  if (c?.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/* ---------------------------------------------------------------------- the feed */

export interface FeedState {
  /** The last full board (the cloud's JSON), or null. */
  body: Record<string, unknown> | null;
  /** The last good answer, full or unchanged (epoch ms). */
  okAt: number | null;
  offline: boolean;
  /** 403 not_a_kds_device: the cloud does not know this machine as a KDS screen. */
  notConfigured: boolean;
  /** server − local clock (ms), from the answer's serverTime. */
  serverOffsetMs: number;
}

/** Without an answer for this long the screen says so (and keeps the last board). */
export const OFFLINE_AFTER_MS = 12_000;

export class KdsFeed {
  private timer: Timer | null = null;
  private polling: Promise<void> | null = null;
  private stopped = true;
  private listeners = new Set<(s: FeedState) => void>();
  private s: FeedState;

  constructor(
    private readonly ctx: RoleContext,
    private readonly cacheKey: string,
    private readonly everyMs = 3_000,
    private readonly now: () => number = Date.now,
  ) {
    const cached = ctx.kv.getJson<{ body: Record<string, unknown>; okAt: number }>(cacheKey);
    this.s = { body: cached?.body ?? null, okAt: cached?.okAt ?? null, offline: true, notConfigured: false, serverOffsetMs: 0 };
  }

  state(): FeedState {
    return this.s;
  }

  onChange(fn: (s: FeedState) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private set(patch: Partial<FeedState>) {
    this.s = { ...this.s, ...patch };
    for (const fn of this.listeners) fn(this.s);
  }

  start() {
    this.stopped = false;
    void this.poll();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** At once (after an action, the network back): the next answer shows its effect. */
  refresh(): Promise<void> {
    return this.poll();
  }

  poll(): Promise<void> {
    if (!this.polling) {
      this.polling = this.doPoll().finally(() => {
        this.polling = null;
        if (!this.stopped) {
          if (this.timer) clearTimeout(this.timer);
          this.timer = setTimeout(() => void this.poll(), this.everyMs);
        }
      });
    }
    return this.polling;
  }

  private async doPoll(): Promise<void> {
    const id = this.ctx.machineId();
    if (!id) return;
    const version = typeof this.s.body?.version === 'number' ? this.s.body.version : null;
    const reply = await this.ctx.api.get(`sync/${id}/kds/board${version !== null ? `?since=${version}` : ''}`, { timeoutMs: 10_000 });
    const now = this.now();
    if (reply.kind === 'ok' && reply.body && typeof reply.body === 'object') {
      const b = reply.body as Record<string, unknown>;
      const serverTime = typeof b.serverTime === 'string' ? Date.parse(b.serverTime) : NaN;
      const offset = Number.isFinite(serverTime) ? serverTime - now : this.s.serverOffsetMs;
      if (b.syncType === 'unchanged' && this.s.body) {
        this.set({ okAt: now, offline: false, notConfigured: false, serverOffsetMs: offset });
        return;
      }
      this.ctx.kv.setJson(this.cacheKey, { body: b, okAt: now });
      this.set({ body: b, okAt: now, offline: false, notConfigured: false, serverOffsetMs: offset });
      return;
    }
    if (reply.kind === 'refused' && (reply.status === 403 || reply.status === 404)) {
      this.set({ okAt: now, offline: false, notConfigured: true });
      return;
    }
    const offline = this.s.okAt === null || now - this.s.okAt > OFFLINE_AFTER_MS;
    if (offline !== this.s.offline) this.set({ offline });
  }
}

/* ------------------------------------------------------------------ the KDS module */

export const KDS_CACHE_KEY = 'role.kds.cache';
export const KDS_OUTBOX_KEY = 'role.kds.outbox';
export const BOARD_CACHE_KEY = 'role.board.cache';
/** A refusal stays on the screen this long. */
export const ERROR_SHOW_MS = 20_000;
/** Server errors (5xx) on the same action before it is given up. */
export const SERVER_ERROR_TRIES = 6;
/** Beyond this many waiting actions a new one is refused (a dead network for a very long time). */
export const OUTBOX_MAX = 2_000;
export const QUEUED_TEXT = 'אין חיבור — הפעולה נשמרה ותישלח כשהחיבור יחזור';

/** The cloud checks `expectedVersion` on these (server `_apply`: the task's version). */
const VERSIONED = new Set(['start', 'item_ready', 'undo_ready', 'resolve_fallback']);

/** What goes to `POST kds/actions` (server schemas/kds.py `KdsActionIn`). */
export type KdsActionBody = KdsActionInput & { id: string; occurredAt: string; expectedVersion?: number };

export interface OutboxEntry {
  id: string;
  body: KdsActionBody;
  /** Sends without a good answer so far. */
  attempts: number;
  /** Not before (epoch ms): the backoff after a server error. */
  nextAt: number;
  queuedAt: number;
}

export type Delivery =
  | { kind: 'done'; outcome: 'applied' | 'noop'; orderVersion: number | null }
  | { kind: 'refused'; code: string }
  | { kind: 'retry'; serverError: boolean; why: string };

/** The cloud's refusal code: `{"detail": {"code": …}}`, `{"detail": "…"}`, or a 422 list. */
export function refusalCode(status: number, body: unknown): string {
  const detail = body && typeof body === 'object' ? (body as { detail?: unknown }).detail : undefined;
  if (detail && typeof detail === 'object' && !Array.isArray(detail) && typeof (detail as { code?: unknown }).code === 'string') return (detail as { code: string }).code;
  if (typeof detail === 'string' && detail.trim()) return detail.trim();
  if (Array.isArray(detail) || status === 422) return 'invalid_request';
  if (status === 401) return 'unauthorized';
  return `HTTP ${status}`;
}

/** What one answer means for the head of the outbox. */
export function deliveryOf(reply: RoleApiReply<unknown>): Delivery {
  if (reply.kind === 'offline') return { kind: 'retry', serverError: false, why: reply.reason };
  if (reply.kind === 'refused') {
    if (reply.status >= 500 || reply.status === 408 || reply.status === 429) return { kind: 'retry', serverError: true, why: `HTTP ${reply.status}` };
    return { kind: 'refused', code: refusalCode(reply.status, reply.body) };
  }
  const b = reply.body && typeof reply.body === 'object' ? (reply.body as Record<string, unknown>) : {};
  if (b.outcome === 'rejected') return { kind: 'refused', code: typeof b.reason === 'string' && b.reason ? b.reason : 'rejected' };
  const order = b.order && typeof b.order === 'object' ? (b.order as { version?: unknown }) : null;
  return { kind: 'done', outcome: b.outcome === 'noop' ? 'noop' : 'applied', orderVersion: typeof order?.version === 'number' ? order.version : null };
}

/** 2 s, 4 s, 8 s … up to a minute. */
export function backoffMs(attempts: number): number {
  return Math.min(60_000, 2_000 * 2 ** Math.max(0, Math.min(attempts - 1, 5)));
}

export function readOutbox(raw: unknown): OutboxEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is OutboxEntry =>
      !!e && typeof e === 'object' && typeof (e as OutboxEntry).id === 'string' && !!(e as OutboxEntry).body && typeof (e as OutboxEntry).body.type === 'string',
  );
}

export interface KdsModuleOptions {
  now?: () => number;
  uuid?: () => string;
  feedEveryMs?: number;
  /** The feed's cache key (default `role.kds.cache`). */
  cacheKey?: string;
}

export class KdsModule {
  readonly role = 'kds' as const;
  readonly feed: KdsFeed;
  private queue: OutboxEntry[];
  private settling: Settling[] = [];
  private draining: Promise<void> | null = null;
  /** The last drain stopped at an action that could not be delivered yet. */
  private blocked = false;
  private lastError: string | null = null;
  private errorTimer: Timer | null = null;
  /** Callers waiting for their action's answer. */
  private waiting = new Map<string, (r: { ok: boolean; message?: string }) => void>();
  private readonly now: () => number;
  private readonly uuid: () => string;

  constructor(
    private readonly ctx: RoleContext,
    private readonly onView: (v: KdsView) => void,
    opts: KdsModuleOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.uuid = opts.uuid ?? uuid4;
    this.feed = new KdsFeed(ctx, opts.cacheKey ?? KDS_CACHE_KEY, opts.feedEveryMs ?? 3_000, this.now);
    this.queue = readOutbox(ctx.kv.getJson<unknown>(KDS_OUTBOX_KEY));
    this.feed.onChange((s) => this.onFeed(s));
  }

  start() {
    if (this.queue.length) this.ctx.log(`kds: ${this.queue.length} action(s) waiting from before`);
    this.feed.start();
  }

  stop() {
    this.feed.stop();
    if (this.errorTimer) clearTimeout(this.errorTimer);
    this.errorTimer = null;
  }

  /** The outbox, oldest first (tests, the technician). */
  outbox(): readonly OutboxEntry[] {
    return this.queue;
  }

  view(): KdsView {
    const s = this.feed.state();
    const base = kdsView(s, this.queue.length, this.lastError);
    const ctx = { role: screenRole(base.device), stationIds: (base.device?.stations ?? []).map((x) => x.id) };
    const actions: OverlayAction[] = [...this.settling.map((x) => x.action), ...this.queue.map((e) => ({ ...e.body, unsent: true }))];
    return { ...base, orders: applyPending(base.orders, actions, ctx), notConfigured: s.notConfigured };
  }

  /** A tap on the screen: queued, shown applied, sent. Resolves with the cloud's word (or "queued"). */
  async action(a: KdsActionInput): Promise<{ ok: boolean; message?: string }> {
    if (!this.ctx.machineId()) return { ok: false, message: 'המכשיר לא מצומד' };
    const problem = checkAction(a);
    if (problem) return { ok: false, message: problem };
    if (this.queue.length >= OUTBOX_MAX) return { ok: false, message: 'יותר מדי פעולות ממתינות לשליחה — בדקו את החיבור לענן' };
    const body = this.bodyOf(a);
    const entry: OutboxEntry = { id: body.id, body, attempts: 0, nextAt: 0, queuedAt: this.now() };
    const answer = new Promise<{ ok: boolean; message?: string }>((resolve) => this.waiting.set(entry.id, resolve));
    this.queue.push(entry);
    this.save();
    this.emit();
    for (let i = 0; i < 3 && this.queue.some((e) => e.id === entry.id); i++) {
      await this.drain();
      if (this.blocked) break;
    }
    if (this.queue.some((e) => e.id === entry.id)) {
      this.waiting.delete(entry.id);
      return { ok: true, message: QUEUED_TEXT };
    }
    return answer;
  }

  /* ---------------------------------------------------------------- inner */

  private board(): { version: number | null; orders: KdsOrder[] } {
    const b = this.feed.state().body;
    return { version: typeof b?.version === 'number' ? b.version : null, orders: Array.isArray(b?.orders) ? (b.orders as KdsOrder[]) : [] };
  }

  private bodyOf(a: KdsActionInput): KdsActionBody {
    const s = this.feed.state();
    const body: KdsActionBody = { id: this.uuid(), type: a.type, occurredAt: new Date(this.now() + s.serverOffsetMs).toISOString() };
    if (a.taskId) body.taskId = a.taskId;
    if (a.orderId) body.orderId = a.orderId;
    if (a.changeId) body.changeId = a.changeId;
    if (a.stationId) body.stationId = a.stationId;
    if (typeof a.priority === 'number') body.priority = a.priority;
    if (a.reason?.trim()) body.reason = a.reason.trim().slice(0, 200);
    if (a.override) body.override = true;
    if (a.resolution) body.resolution = a.resolution;
    // The item's version as this screen saw it — only when the board is live and the action
    // goes out at once with nothing of ours still moving that item in the cloud.
    if (VERSIONED.has(a.type) && a.taskId && !s.offline && this.queue.length === 0) {
      const { orders } = this.board();
      const order = orders.find((o) => o.tasks.some((t) => t.id === a.taskId));
      const task = order?.tasks.find((t) => t.id === a.taskId);
      const busy = this.settling.some((x) => x.action.taskId === a.taskId || (!!order && x.action.orderId === order.id));
      if (task && typeof task.version === 'number' && !busy) body.expectedVersion = task.version;
    }
    return body;
  }

  private save() {
    this.ctx.kv.setJson(KDS_OUTBOX_KEY, this.queue);
  }

  private emit() {
    this.onView(this.view());
  }

  private onFeed(s: FeedState) {
    // The feed speaks after an answer, or when it goes offline: a live, configured board is a
    // good poll (at worst one extra try of the outbox's head).
    const good = !s.offline && !s.notConfigured;
    const board = this.board();
    const now = this.now();
    this.settling = this.settling.filter((x) => !isSettled(x, board, now));
    if (good && this.queue.length > 0 && !this.draining) void this.drain();
    this.emit();
  }

  /** Sends the outbox in order until it is empty or its head cannot go yet. */
  drain(): Promise<void> {
    if (!this.draining) {
      this.draining = this.runQueue().finally(() => {
        this.draining = null;
      });
    }
    return this.draining;
  }

  private async runQueue(): Promise<void> {
    this.blocked = false;
    const machine = this.ctx.machineId();
    if (!machine) {
      this.blocked = true;
      return;
    }
    let refresh = false;
    while (this.queue.length > 0) {
      const head = this.queue[0];
      if (head.nextAt > this.now()) {
        this.blocked = true;
        break;
      }
      const boardVersion = this.board().version;
      const reply = await this.ctx.api.post(`sync/${machine}/kds/actions`, head.body, { timeoutMs: 10_000 });
      const d = deliveryOf(reply);
      if (d.kind === 'retry') {
        head.attempts += 1;
        // From now on it is a late action: the cloud's offline rules, not this screen's version.
        delete head.body.expectedVersion;
        if (d.serverError && head.attempts >= SERVER_ERROR_TRIES) {
          this.ctx.log(`kds action ${head.body.type} ${head.id} given up after ${head.attempts} server errors (${d.why})`);
          this.finish(head, { ok: false, message: this.describe(head.body, 'הענן לא הצליח לבצע את הפעולה (שגיאת שרת)') });
          refresh = true;
          continue;
        }
        head.nextAt = d.serverError ? this.now() + backoffMs(head.attempts) : 0;
        this.save();
        this.blocked = true;
        if (head.attempts === 1) this.ctx.log(`kds action ${head.body.type} ${head.id} waits: ${d.why}`);
        this.emit();
        break;
      }
      if (d.kind === 'refused') {
        this.ctx.log(`kds action ${head.body.type} ${head.id} refused: ${d.code}`);
        this.finish(head, { ok: false, message: this.describe(head.body, refusalText(d.code)) });
        refresh = true;
        continue;
      }
      this.settling.push({ action: head.body, boardVersion, orderVersion: d.orderVersion, at: this.now() });
      this.finish(head, { ok: true });
      refresh = true;
    }
    if (refresh) void this.feed.refresh();
  }

  /** The head leaves the outbox: its caller hears, a refusal is shown. */
  private finish(head: OutboxEntry, r: { ok: boolean; message?: string }) {
    this.queue = this.queue.filter((e) => e.id !== head.id);
    this.save();
    if (!r.ok && r.message) this.showError(r.message);
    const resolve = this.waiting.get(head.id);
    this.waiting.delete(head.id);
    resolve?.(r);
    this.emit();
  }

  /** "#41 · מוכן: הפריט בוטל" — which tap, on which order, and why. */
  private describe(body: KdsActionBody, why: string): string {
    const { orders } = this.board();
    const order = orders.find((o) => o.id === body.orderId || (!!body.taskId && o.tasks.some((t) => t.id === body.taskId)) || (!!body.changeId && o.changes.some((c) => c.id === body.changeId)));
    return `${order ? `${orderTitle(order)} · ` : ''}${ACTION_TEXT[body.type] ?? body.type}: ${why}`;
  }

  private showError(message: string) {
    this.lastError = message;
    if (this.errorTimer) clearTimeout(this.errorTimer);
    this.errorTimer = setTimeout(() => {
      this.errorTimer = null;
      this.lastError = null;
      this.emit();
    }, ERROR_SHOW_MS);
    unref(this.errorTimer);
  }
}

export function kdsView(s: FeedState, pendingActions: number, lastError: string | null): KdsView {
  const b = s.body ?? {};
  const device = b.device && typeof b.device === 'object' ? (b.device as KdsView['device']) : null;
  return {
    device,
    shopName: typeof b.shopName === 'string' ? b.shopName : null,
    orders: Array.isArray(b.orders) ? (b.orders as KdsView['orders']) : [],
    stationSettings: b.stationSettings && typeof b.stationSettings === 'object' ? (b.stationSettings as KdsView['stationSettings']) : {},
    updatedAt: s.okAt,
    offline: s.offline,
    pendingActions,
    lastError,
    serverOffsetMs: s.serverOffsetMs,
  };
}

/* --------------------------------------------------------------- the board module */

/**
 * "מסך מוכן / לא מוכן" (order status board): a customer-facing screen with the pickup numbers in
 * preparation and ready. It reads the KDS feed of its own `pickup` KDS device and nothing else.
 */
export class BoardModule {
  readonly role = 'order_status_board' as const;
  readonly feed: KdsFeed;

  constructor(ctx: RoleContext, onView: (v: BoardView) => void, cacheKey = BOARD_CACHE_KEY) {
    this.feed = new KdsFeed(ctx, cacheKey);
    this.feed.onChange((s) => onView(boardView(s)));
  }

  start() {
    this.feed.start();
  }

  stop() {
    this.feed.stop();
  }

  view(): BoardView {
    return boardView(this.feed.state());
  }
}

export function boardView(s: FeedState): BoardView {
  const body = s.body ?? {};
  const cols = boardOf(body.pickup);
  const device = body.device && typeof body.device === 'object' ? (body.device as { display?: unknown }) : null;
  return {
    shopName: typeof body.shopName === 'string' ? body.shopName : null,
    preparing: cols.preparing,
    ready: cols.ready,
    updatedAt: s.okAt,
    offline: s.offline,
    // A device that is a KDS station, not a pickup screen, has no `pickup` in its board.
    notConfigured: s.notConfigured || (s.body !== null && !('pickup' in s.body)),
    display: device && device.display && typeof device.display === 'object' ? boardDisplayOf(device.display) : null,
  };
}

/** What the cloud says this screen is from its last board: the board (a `pickup` device), the KDS, or not known yet. */
export function feedShows(s: FeedState): 'kds' | 'board' | null {
  const b = s.body;
  if (!b) return null;
  const device = b.device && typeof b.device === 'object' ? (b.device as { role?: unknown }) : null;
  if (device?.role === 'pickup' || 'pickup' in b) return 'board';
  if (device) return 'kds';
  return null;
}
