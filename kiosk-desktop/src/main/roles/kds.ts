/**
 * Role module "מסך מטבח (KDS)": the kitchen screen of a KDS device (station / expo / manager),
 * on the cloud's KDS API — `GET /sync/{m}/kds/board` (the feed, every 3 s, the last board kept in
 * the kv) and `POST /sync/{m}/kds/actions`. Not a till: no documents, no shifts, no payments.
 *
 * Actions (as the Android KdsOutbox, docs/SPEC_KDS.md §9):
 *  - each gets its idempotency id (`randomUUID()`), `occurredAt` on the cloud's clock and — only
 *    for an item action sent at once from a live board, with nothing of this screen still in
 *    flight for it — the item's `expectedVersion` (the cloud's 409 version_conflict for a stale tap);
 *  - it goes out at once and is shown applied at once (core/kdsBoard.ts `applyPending`);
 *  - without an answer (offline, 502–504) or on a server error (5xx, 408, 429) it stays in an
 *    ordered outbox in the kv (it survives a restart) and is retried, in order, on the next good
 *    poll — the same id, so a retry is the same action in the cloud. A waiting action is a late
 *    action: it is retried without `expectedVersion` (the cloud's offline rules apply — it acts on
 *    the active quantity only, never reviving a cancellation; "prepared before the cancel" is
 *    recorded from `occurredAt`). A server error gives up after a few backed-off tries;
 *  - a refusal (4xx, or the cloud's `outcome: rejected`) drops it and says why, in Hebrew;
 *  - a delivered action stays drawn until the board shows it (no flicker), then the feed refreshes.
 */

import { randomUUID } from 'node:crypto';
import type { KdsActionInput, KdsOrder, KdsView } from '../../shared/roles';
import {
  ACTION_TEXT,
  applyPending,
  checkAction,
  isSettled,
  orderTitle,
  refusalText,
  screenRole,
  type OverlayAction,
  type Settling,
} from '../../core/kdsBoard';
import type { ApiReply } from '../sync/api';
import { KdsFeed, type FeedState } from './feed';
import type { RoleContext, RoleModule } from './types';

export const KDS_CACHE_KEY = 'role.kds.cache';
export const KDS_OUTBOX_KEY = 'role.kds.outbox';
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
export function deliveryOf(reply: ApiReply<unknown>): Delivery {
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

function readOutbox(raw: unknown): OutboxEntry[] {
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
}

export class KdsModule implements RoleModule {
  readonly role = 'kds' as const;
  readonly feed: KdsFeed;
  private queue: OutboxEntry[];
  private settling: Settling[] = [];
  private draining: Promise<void> | null = null;
  /** The last drain stopped at an action that could not be delivered yet. */
  private blocked = false;
  private lastError: string | null = null;
  private errorTimer: NodeJS.Timeout | null = null;
  private lastOkAt: number | null;
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
    this.uuid = opts.uuid ?? randomUUID;
    this.feed = new KdsFeed(ctx, KDS_CACHE_KEY, opts.feedEveryMs ?? 3_000, this.now);
    this.queue = readOutbox(ctx.kv.getJson<unknown>(KDS_OUTBOX_KEY));
    this.lastOkAt = this.feed.state().okAt;
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
    const good = s.okAt !== this.lastOkAt && !s.offline && !s.notConfigured;
    this.lastOkAt = s.okAt;
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
      const reply = await this.ctx.api.post<unknown>(`sync/${machine}/kds/actions`, head.body, { timeoutMs: 10_000 });
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
    this.errorTimer.unref?.();
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
