/**
 * The KDS feed: `GET /sync/{m}/kds/board?since=<version>` on a short timer (the screens'
 * cadence on Android and the public pickup screen: 3 s), the last full answer kept in the local
 * database so a restart without internet still shows the last board.
 *
 * Shared by the KDS screen (orders) and the order status board (the `pickup` payload of a
 * `pickup` KDS device) — the cloud answers each device by its own KDS role.
 */

import type { RoleContext } from './types';

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
  private timer: NodeJS.Timeout | null = null;
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

  /** At once (after an action): the next answer shows its effect. */
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
    const reply = await this.ctx.api.get<Record<string, unknown>>(`sync/${id}/kds/board${version !== null ? `?since=${version}` : ''}`, { timeoutMs: 10_000 });
    const now = this.now();
    if (reply.kind === 'ok' && reply.body && typeof reply.body === 'object') {
      const b = reply.body;
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
