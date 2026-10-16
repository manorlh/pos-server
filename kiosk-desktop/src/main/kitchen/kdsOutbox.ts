/**
 * The till's durable queue to the cloud's KDS (`POST /sync/{m}/kds/release`) — the port of pos-android
 * ui/kds/KdsOutbox.kt and KdsBridge.kt's settle / overdue, for a Windows till's paid counter sales:
 *
 *  - strictly in order, each entry with its idempotency key (`id`): a retry after a lost answer is the same release in
 *    the cloud — never a second order on the screens;
 *  - retried with backoff while there is no answer; a refusal (4xx) is final;
 *  - the fallback is durable: a KDS-only shop's tickets wait HELD in the kitchen queue under the entry's hold, and the
 *    entry's own age decides — not delivered within 8 s and the fallback on → printed (flagged, and the cloud told
 *    `fallbackPrinted`); the fallback off → after 45 s shown to a person;
 *  - settled before it is gone: taken — the held tickets go; not taken (refused, `accepted: false`) — printed (the
 *    fallback on) or shown to a person.
 *
 * Kept in the kiosk DB's kv (`kitchen.kds`), so a restart keeps every entry.
 */

import type { Api, ApiReply } from '../sync/api';
import type { Kv } from '../db/schema';
import { KDS_FALLBACK_AFTER_MS, KDS_VISIBLE_AFTER_MS, kdsTaken } from '../../core/kitchen/kds';
import { KDS_NOT_TAKEN, reason } from '../../core/kitchen/queue';
import type { KitchenService } from './kitchenService';

const KEY = 'kitchen.kds';
const FIRST_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
const CALL_MS = 8_000;
/** Why a fallback ticket shown to a person went: the KDS had it after all. */
export const KDS_TOOK_IT = 'the KDS took it';

export interface KdsEntry {
  id: string;
  body: Record<string, unknown>;
  attempts: number;
  nextAt: number;
  createdAt: number;
  /** The kitchen queue's hold of this release's fallback tickets ("hold:kds:<id>"); null: none. */
  fallbackHold: string | null;
  /** The printer fallback is on: printed by itself when overdue. */
  autoFallback: boolean;
  /** Shown to a person already (fallback off, overdue). */
  surfaced: boolean;
}

export interface KdsOutboxDeps {
  kv: Kv;
  api: Api;
  machineId(): string | null;
  kitchen: KitchenService;
  log(m: string): void;
  now?(): number;
}

export function kdsBackoffMs(attempts: number): number {
  let d = FIRST_BACKOFF_MS;
  for (let i = 1; i < attempts; i++) d = Math.min(MAX_BACKOFF_MS, d * 2);
  return d;
}

export class KdsOutbox {
  private timer: NodeJS.Timeout | null = null;
  private draining: Promise<void> | null = null;
  private stopped = true;

  constructor(private readonly d: KdsOutboxDeps) {}

  private now(): number {
    return this.d.now ? this.d.now() : Date.now();
  }

  entries(): KdsEntry[] {
    return (this.d.kv.getJson<KdsEntry[]>(KEY) ?? []).slice().sort((a, b) => a.createdAt - b.createdAt);
  }

  private save(list: KdsEntry[]) {
    if (list.length === 0) this.d.kv.delete(KEY);
    else this.d.kv.setJson(KEY, list);
  }

  private put(e: KdsEntry) {
    const list = this.entries().filter((x) => x.id !== e.id);
    list.push(e);
    this.save(list);
  }

  private remove(id: string) {
    this.save(this.entries().filter((x) => x.id !== id));
  }

  isPending(id: string): boolean {
    return this.entries().some((e) => e.id === id);
  }

  /** Queued durably before it returns; the same id twice is one entry. */
  enqueue(id: string, body: Record<string, unknown>, fallbackHold: string | null, autoFallback: boolean): void {
    if (this.isPending(id)) return;
    const now = this.now();
    this.put({ id, body, attempts: 0, nextAt: now, createdAt: now, fallbackHold, autoFallback, surfaced: false });
    this.kick(0);
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.kick(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private kick(ms: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.run();
    }, ms);
    this.timer.unref?.();
  }

  /** Deliver what is due, then the overdue fallbacks; the next look when something waits. */
  async run(): Promise<void> {
    try {
      await this.drain();
    } catch (e) {
      this.d.log(`kds outbox: ${String(e)}`);
    }
    this.checkOverdue();
    const list = this.entries();
    if (list.length === 0) return;
    const now = this.now();
    const times = list.map((e) => e.nextAt);
    for (const e of list) {
      if (!e.fallbackHold || e.body.fallbackPrinted === true) continue;
      if (e.autoFallback) times.push(e.createdAt + KDS_FALLBACK_AFTER_MS);
      else if (!e.surfaced) times.push(e.createdAt + KDS_VISIBLE_AFTER_MS);
    }
    this.kick(Math.max(250, Math.min(15_000, Math.min(...times) - now)));
  }

  async drain(): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = this.drainNow().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  private async send(body: Record<string, unknown>): Promise<ApiReply> {
    const m = this.d.machineId();
    if (!m) return { kind: 'offline', reason: 'not paired' };
    return this.d.api.post(`sync/${m}/kds/release`, body, { timeoutMs: CALL_MS });
  }

  private async drainNow(): Promise<void> {
    for (;;) {
      const head = this.entries()[0];
      if (!head || head.nextAt > this.now()) return;
      const reply = await this.send(head.body);
      if (reply.kind === 'offline') {
        const current = this.entries().find((e) => e.id === head.id) ?? head;
        this.put({ ...current, attempts: current.attempts + 1, nextAt: this.now() + kdsBackoffMs(current.attempts + 1) });
        return;
      }
      let final = reply;
      if (reply.kind === 'ok' && head.body.fallbackPrinted !== true) {
        // Printed on the fallback printer while this was in flight: the cloud told, so the screen reconciles it.
        const now = this.entries().find((e) => e.id === head.id);
        if (now?.body.fallbackPrinted === true) {
          const again = await this.send(now.body);
          if (again.kind === 'offline') {
            this.put({ ...now, nextAt: this.now() + kdsBackoffMs(1) });
            return;
          }
          final = again;
        }
      }
      const entry = this.entries().find((e) => e.id === head.id) ?? head;
      this.settle(entry, final);
      this.remove(head.id);
    }
  }

  /** A release's final answer: taken — its held tickets go; not taken — printed (fallback on) or shown to a person. */
  private settle(entry: KdsEntry, reply: ApiReply): void {
    const taken = kdsTaken(entry.body, reply.kind === 'ok' ? { kind: 'ok', body: reply.body } : reply.kind === 'refused' ? { kind: 'refused' } : { kind: 'offline' });
    if (taken === false) this.d.log(`kds release ${entry.id} not taken (${reply.kind === 'refused' ? `refused ${reply.status} ${reply.detail ?? ''}` : 'not accepted'})`);
    const hold = entry.fallbackHold;
    if (!hold) return;
    const notTaken = reason(KDS_NOT_TAKEN, entry.id);
    if (taken === true) {
      this.d.kitchen.dropHeld(hold);
      this.d.kitchen.settleSurfaced(notTaken, false, KDS_TOOK_IT);
    } else if (taken === false) {
      if (entry.body.fallbackPrinted === true) return;
      if (entry.autoFallback) this.d.kitchen.releaseHeld(hold);
      else this.d.kitchen.surfaceHeld(hold, KDS_NOT_TAKEN, entry.id);
    }
  }

  /** Not delivered in time: printed now (the fallback on, flagged for the cloud) or shown to a person. */
  checkOverdue(): void {
    const now = this.now();
    for (const e of this.entries()) {
      if (!e.fallbackHold || e.body.fallbackPrinted === true) continue;
      if (e.autoFallback && now - e.createdAt >= KDS_FALLBACK_AFTER_MS) {
        this.d.log(`kds release ${e.id} not delivered in time: printing on the fallback printer`);
        this.d.kitchen.releaseHeld(e.fallbackHold);
        this.put({ ...e, body: { ...e.body, fallbackPrinted: true } });
      } else if (!e.autoFallback && !e.surfaced && now - e.createdAt >= KDS_VISIBLE_AFTER_MS) {
        this.d.kitchen.surfaceHeld(e.fallbackHold, KDS_NOT_TAKEN, e.id);
        this.put({ ...e, surfaced: true });
      }
    }
  }
}
