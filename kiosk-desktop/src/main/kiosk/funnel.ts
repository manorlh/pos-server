/**
 * The funnel's events waiting for the cloud ("ביצועי קיוסקים", core/kioskFunnel.ts): kept in the
 * `kv` table (one JSON list, capped — the oldest go first), sent in batches of ≤ 200 to
 * `POST /sync/{m}/kiosk/events` whenever the kiosk syncs. The cloud takes them idempotently by
 * (session, seq): a batch sent twice (the answer lost) changes nothing, so a batch is dropped
 * only once the cloud took it — or refused it for good (funnelReplyDrops).
 */

import { enqueueFunnel, FUNNEL_BATCH, funnelReplyDrops, type FunnelEvent } from '../../core/kioskFunnel';
import type { Kv } from '../db/schema';
import type { Api } from '../sync/api';

const KEY = 'funnel.queue';

export class FunnelStore {
  private pushing = false;

  constructor(private readonly kv: Kv) {}

  all(): FunnelEvent[] {
    return this.kv.getJson<FunnelEvent[]>(KEY) ?? [];
  }

  count(): number {
    return this.all().length;
  }

  /** The oldest waiting event's time, for the health report (null: none). */
  oldestAt(): string | null {
    return this.all()[0]?.at ?? null;
  }

  add(events: readonly FunnelEvent[]): void {
    const clean = events.filter((e) => e && typeof e.sessionId === 'string' && Number.isInteger(e.seq) && typeof e.type === 'string');
    if (clean.length === 0) return;
    this.kv.setJson(KEY, enqueueFunnel(this.all(), clean));
  }

  /** Sends what waits, batch by batch, until it is all sent or the cloud does not take one. */
  async push(api: Api, machineId: string): Promise<boolean> {
    if (this.pushing) return false;
    this.pushing = true;
    try {
      for (let guard = 0; guard < 50; guard++) {
        const batch = this.all().slice(0, FUNNEL_BATCH);
        if (batch.length === 0) return true;
        const reply = await api.post(`sync/${machineId}/kiosk/events`, { events: batch }, { timeoutMs: 20_000 });
        if (!funnelReplyDrops(reply)) return false;
        // Drop exactly what was sent (more may have been added meanwhile).
        const sent = new Set(batch.map((e) => `${e.sessionId}#${e.seq}`));
        this.kv.setJson(
          KEY,
          this.all().filter((e) => !sent.has(`${e.sessionId}#${e.seq}`)),
        );
      }
      return true;
    } finally {
      this.pushing = false;
    }
  }
}
