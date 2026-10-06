/**
 * The kiosk's own Z (zMode = till), as the Android kiosk's automatic close
 * (pos-android data/repo/KioskRepository.autoCloseTick, TillZRepository.kt):
 *
 *  - every 30 s, only while the kiosk is idle and no card is on the terminal;
 *  - at the kiosk's time (operations.autoCloseAt, else the parameter autoCloseShiftAt): close the
 *    shift (as "קיוסק · <name>", counted = expected), then in zMode = till mark the Z OWED (on disk)
 *    and ask for it: every close delivered first, the card batch transmitted, then POST till-z
 *    with ONE clientRequestId (saved before the first attempt, reused until the Z is stored);
 *  - the number is the cloud's next — strictly sequential; the Z is stored with it and never
 *    renumbered; "owed" survives a restart and offline; a refusal that will never produce a Z
 *    (nothing_to_report, empty_z…) clears it.
 */

import { randomUUID } from 'node:crypto';
import {
  asksTillZ,
  autoCloseDue,
  autoCloseTimeOf,
  refusalClearsOwed,
  sumTillTotals,
  tillZRefusalOf,
  type ZMode,
} from '../../core/tillZ';
import type { Db } from '../db/sqlite';
import type { Kv } from '../db/schema';
import type { Api } from '../sync/api';
import type { Ledger } from './ledger';
import type { TransmitResult } from '../payment/provider';

const OWED = 'tillZ.owed';
const PENDING = 'tillZ.pendingRequest';

export type ZOutcome =
  | { kind: 'produced'; z: Record<string, unknown> }
  | { kind: 'refused'; refusal: string }
  | { kind: 'waiting'; why: string }
  | { kind: 'offline' }
  | { kind: 'failed'; status: number; detail: string | null };

export interface TillZDeps {
  db: Db;
  kv: Kv;
  api: Api;
  ledger: Ledger;
  machineId: () => string | null;
  zMode: () => ZMode;
  /** Flush the outbox now (closes first). */
  flush: () => Promise<void>;
  /** The card batch (doPeriodic) before the Z; null when there is no terminal to ask. */
  transmit: () => Promise<TransmitResult | null>;
  print: (z: Record<string, unknown>) => void;
  log: (m: string) => void;
}

export class TillZService {
  private busy = false;
  private cardTransmission: Record<string, unknown> | null = null;

  constructor(private readonly d: TillZDeps) {}

  get owed(): boolean {
    return this.d.kv.get(OWED) === '1';
  }

  /** The 30-second tick of the kiosk (KioskRepository.autoCloseTick). */
  async tick(input: { mayRun: boolean; kioskAt: unknown; paramAt: unknown; closerName: string; vatRate: number; now?: Date }): Promise<void> {
    if (!input.mayRun || this.busy) return;
    this.busy = true;
    try {
      if (this.owed) {
        if (asksTillZ(this.d.zMode())) await this.produce(input.closerName, true);
        else this.d.kv.delete(OWED);
        return;
      }
      const at = autoCloseTimeOf(input.kioskAt, input.paramAt);
      if (!at) return;
      const shift = this.d.ledger.currentShift();
      const now = input.now ?? new Date();
      if (!shift || !autoCloseDue(now.getTime(), at, Date.parse(shift.opened_at))) return;
      const closed = this.d.ledger.closeShift({ closedByName: input.closerName, vatRate: input.vatRate, now });
      if (closed.kind !== 'closed') return;
      this.d.log(`automatic close at ${at}: shift ${closed.shift.id}`);
      await this.d.flush();
      if (asksTillZ(this.d.zMode())) {
        this.d.kv.set(OWED, '1');
        await this.produce(input.closerName, true);
      }
    } finally {
      this.busy = false;
    }
  }

  /** A close requested by the cloud (heartbeat pendingCloseShift): the same close, its request id carried. */
  closeForCloud(input: { requestId: string; closerName: string; vatRate: number }) {
    return this.d.ledger.closeShift({ closedByName: input.closerName, closeRequestId: input.requestId, unattended: true, vatRate: input.vatRate });
  }

  /** prepare(): every close accepted by the cloud first (the Z must include them). */
  private async prepared(): Promise<'ready' | 'offline' | 'waiting'> {
    await this.d.flush();
    if (this.d.ledger.closingCount() > 0) return 'waiting';
    return 'ready';
  }

  /** POST till-z with the one request id; the Z stored, its shifts marked, printed. */
  async produce(closerName: string, unattended: boolean, tillZRequestId: string | null = null): Promise<ZOutcome> {
    const machineId = this.d.machineId();
    if (!machineId) return { kind: 'waiting', why: 'not paired' };
    const ready = await this.prepared();
    if (ready !== 'ready') return { kind: 'waiting', why: 'closes not delivered yet' };
    if (!this.cardTransmission) {
      const t = await this.d.transmit().catch(() => null);
      this.cardTransmission = t ? cardTransmissionWire(t) : { outcome: 'skipped', at: new Date().toISOString() };
    }
    let pending = this.d.kv.getJson<{ machineId: string; id: string }>(PENDING);
    if (!pending || pending.machineId !== machineId) {
      pending = { machineId, id: randomUUID() };
      this.d.kv.setJson(PENDING, pending); // before the first attempt
    }
    const closes = this.d.ledger.unreportedShifts().map((s) => {
      try {
        return (JSON.parse(s.close_payload ?? 'null') as Record<string, unknown> | null)?.till as Record<string, unknown> | null;
      } catch {
        return null;
      }
    });
    const till = sumTillTotals(closes);
    const through = this.d.ledger.lastClosedShift();
    const body: Record<string, unknown> = {
      clientRequestId: pending.id,
      ...(tillZRequestId ? { tillZRequestId } : {}),
      ...(through ? { throughShiftId: through.id } : {}),
      createdByName: closerName,
      unattended,
      ...(till ? { till } : {}),
      cardTransmission: this.cardTransmission,
    };
    let reply = await this.d.api.post<Record<string, unknown>>(`sync/${machineId}/till-z`, body, { timeoutMs: 60_000 });
    if (reply.kind === 'refused' && reply.status === 409 && reply.detail === 'client_request_id_conflict') {
      pending = { machineId, id: randomUUID() };
      this.d.kv.setJson(PENDING, pending);
      reply = await this.d.api.post<Record<string, unknown>>(`sync/${machineId}/till-z`, { ...body, clientRequestId: pending.id }, { timeoutMs: 60_000 });
    }
    if (reply.kind === 'offline') return { kind: 'offline' };
    if (reply.kind === 'refused') {
      const refusal = tillZRefusalOf(reply.status, reply.detail);
      if (refusal) {
        if (refusalClearsOwed(refusal)) {
          this.d.kv.delete(OWED);
          this.d.kv.delete(PENDING);
          this.cardTransmission = null;
        }
        this.d.log(`till Z refused: ${refusal}`);
        return { kind: 'refused', refusal };
      }
      return { kind: 'failed', status: reply.status, detail: reply.detail };
    }
    const answer = reply.body ?? {};
    const z = (answer.zReport ?? null) as Record<string, unknown> | null;
    if (!z || typeof z.id !== 'string') return { kind: 'failed', status: reply.status, detail: 'unreadable answer' };
    const number = Number(z.machineSequenceNumber ?? z.zNumber);
    this.d.db.tx(() => {
      this.d.db.run(
        'INSERT OR IGNORE INTO till_zs (id, machine_id, number, epoch, closed_at, business_date, state, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        z.id as string,
        (z.machineId as string) ?? machineId,
        Number.isFinite(number) ? number : 0,
        typeof z.machineSequenceEpoch === 'number' ? z.machineSequenceEpoch : 0,
        (z.closedAt as string) ?? new Date().toISOString(),
        (z.businessDate as string) ?? null,
        'printed',
        JSON.stringify(answer),
      );
      const shiftIds = Array.isArray(answer.shiftIds) ? (answer.shiftIds as string[]) : [];
      this.d.ledger.markShiftsInZ(shiftIds, z.id as string, Number.isFinite(number) ? number : null);
    });
    this.d.kv.delete(OWED);
    this.d.kv.delete(PENDING);
    this.cardTransmission = null;
    this.d.log(`till Z ${number}`);
    try {
      this.d.print(z);
    } catch (e) {
      this.d.log(`till Z print: ${String(e)}`);
    }
    return { kind: 'produced', z };
  }

  /** The Zs the kiosk holds, newest first. */
  list(limit = 40): Array<{ id: string; number: number; closedAt: string; state: string }> {
    return this.d.db.all<{ id: string; number: number; closed_at: string; state: string }>('SELECT id, number, closed_at, state FROM till_zs ORDER BY number DESC LIMIT ?', limit).map((r) => ({
      id: r.id,
      number: r.number,
      closedAt: r.closed_at,
      state: r.state,
    }));
  }

  lastLocalNumber(machineId: string): number | null {
    return this.d.db.get<{ m: number | null }>("SELECT MAX(number) AS m FROM till_zs WHERE machine_id = ? AND state != 'superseded'", machineId)?.m ?? null;
  }
}

/** The `cardTransmission` block of a till Z (ZCardTransmission.wire). */
export function cardTransmissionWire(t: TransmitResult): Record<string, unknown> {
  const out: Record<string, unknown> = {
    outcome: t.outcome,
    batchNumber: t.batchNumber,
    statusCode: t.statusCode,
    statusMessage: t.statusMessage,
    error: t.error,
    transactionCount: t.transactionCount,
    amount: t.amountAgorot === null ? null : (t.amountAgorot / 100).toFixed(2),
    at: new Date().toISOString(),
    // An automatic Z has nobody to confirm a failed transmission: recorded, never blocking.
    confirmedFailure: t.outcome === 'failed' || t.outcome === 'unknown' || t.outcome === 'busy' ? true : undefined,
    confirmedByName: t.outcome === 'failed' || t.outcome === 'unknown' || t.outcome === 'busy' ? 'קיוסק (אוטומטי)' : undefined,
  };
  for (const k of Object.keys(out)) if (out[k] === null || out[k] === undefined) delete out[k];
  return out;
}
