/**
 * Rows of a previous pairing, uploaded to their own till (P:/specs/foreign-records-upload.md §4):
 * `POST /sync/{B}/foreign-records` as the pairing now (B), one call per previous machine (A) and at most 200 records,
 * in the order shift opens → documents → shift closes → card transmissions → cash movements.
 *
 *  - `accepted` / `duplicate` — filed under A: the row goes (a document is marked synced);
 *  - `refused` — permanent: the row stays held (`refused:<code>` as its error, never sent again) and in the backups;
 *  - `retry` (or a result missing from the answer) — sent again after the row's backoff;
 *  - a whole-request refusal (409 `foreign_machine_unknown`, `foreign_machine_other_tenant`, `foreign_machine_is_self`)
 *    — nothing written: the rows stay held, that machine is asked again a day later;
 *  - a server without the endpoint (404 / 405) — the rows stay held (main/sync/outbox.ts `foreign`) and the server is
 *    asked again some hours later (a server update brings it).
 *
 * Only money rows go (documents, shifts, card transmissions, cash movements); another pairing's events and rows whose
 * machine is unknown stay held and exportable ("ייצוא לקובץ").
 */

import type { Kv } from '../db/schema';
import type { Api } from './api';
import { UNKNOWN_OWNER, type Outbox, type OutboxRow } from './outbox';

/** The kinds the endpoint files, in the order they are sent. */
export const FOREIGN_UPLOAD_ORDER = ['shift_open', 'transaction', 'shift_close', 'transmission', 'cash_movement'] as const;
export const FOREIGN_BATCH = 200;
/** A server without the endpoint: asked again after this long. */
export const UNSUPPORTED_RETRY_MS = 6 * 3_600_000;
/** A machine the server refused the whole request for: asked again after this long. */
export const REQUEST_REFUSED_RETRY_MS = 24 * 3_600_000;
export const REFUSED_PREFIX = 'refused:';

const STATUS_KEY = 'foreign.upload';

export interface ForeignMachineStatus {
  machineId: string;
  machineName: string | null;
  posNumber: string | null;
  shopName: string | null;
  /** Rows filed under that till so far (accepted or duplicate). */
  uploaded: number;
  lastAt: number | null;
  /** The last whole-request refusal or failure (a code), or null. */
  lastError: string | null;
  /** Not asked again before (a whole-request refusal). */
  blockedUntil: number | null;
}

export interface ForeignUploadState {
  /** The server lacks the endpoint (feature detection): when that was learned. */
  unsupportedAt: number | null;
  machines: Record<string, ForeignMachineStatus>;
}

export interface ForeignUploadDeps {
  api: Api;
  outbox: Outbox;
  kv: Kv;
  /** The pairing now (B). */
  machineId(): string | null;
  /** The record's body as the ordinary push of its kind sends it (null — the record is gone). */
  body(row: OutboxRow): unknown;
  /** Documents filed under their till: marked synced. */
  synced(docIds: string[]): void;
  log(m: string): void;
  now?: () => number;
}

interface ResultIn {
  kind?: unknown;
  id?: unknown;
  status?: unknown;
  code?: unknown;
}

/** May the row go up: a money kind, a known machine, not refused for good, its backoff over. */
export function uploadable(row: OutboxRow, nowMs: number): boolean {
  return (
    (FOREIGN_UPLOAD_ORDER as readonly string[]).includes(row.kind) &&
    !!row.machine_id &&
    row.machine_id !== UNKNOWN_OWNER &&
    !(row.last_error ?? '').startsWith(REFUSED_PREFIX) &&
    row.next_at <= nowMs
  );
}

/** The rows per previous machine, each in the endpoint's order (then by when they were made). */
export function uploadGroups(rows: OutboxRow[], nowMs: number): Array<{ machineId: string; tenantId: string | null; rows: OutboxRow[] }> {
  const rank = (k: string) => (FOREIGN_UPLOAD_ORDER as readonly string[]).indexOf(k);
  const by = new Map<string, { machineId: string; tenantId: string | null; rows: OutboxRow[] }>();
  for (const r of rows) {
    if (!uploadable(r, nowMs)) continue;
    const g = by.get(r.machine_id!) ?? { machineId: r.machine_id!, tenantId: r.tenant_id ?? null, rows: [] };
    g.tenantId ??= r.tenant_id ?? null;
    g.rows.push(r);
    by.set(r.machine_id!, g);
  }
  for (const g of by.values()) g.rows.sort((a, b) => rank(a.kind) - rank(b.kind) || a.seq - b.seq);
  return [...by.values()];
}

export class ForeignUploader {
  private running: Promise<void> | null = null;
  private readonly now: () => number;

  constructor(private readonly d: ForeignUploadDeps) {
    this.now = d.now ?? Date.now;
  }

  state(): ForeignUploadState {
    const s = this.d.kv.getJson<ForeignUploadState>(STATUS_KEY);
    return { unsupportedAt: s?.unsupportedAt ?? null, machines: s?.machines ?? {} };
  }

  private save(s: ForeignUploadState) {
    this.d.kv.setJson(STATUS_KEY, s);
  }

  private machine(s: ForeignUploadState, id: string): ForeignMachineStatus {
    return (s.machines[id] ??= { machineId: id, machineName: null, posNumber: null, shopName: null, uploaded: 0, lastAt: null, lastError: null, blockedUntil: null });
  }

  /** One pass (one at a time): every previous machine's rows that may go. */
  run(): Promise<void> {
    this.running ??= this.pass()
      .catch((e) => this.d.log(`foreign upload: ${String(e)}`))
      .finally(() => {
        this.running = null;
      });
    return this.running;
  }

  private async pass(): Promise<void> {
    const me = this.d.machineId();
    if (!me) return;
    const now = this.now();
    const st = this.state();
    if (st.unsupportedAt !== null && now - st.unsupportedAt < UNSUPPORTED_RETRY_MS) return;
    for (const g of uploadGroups(this.d.outbox.foreign(), now)) {
      if (g.machineId === me) continue;
      const m = this.machine(st, g.machineId);
      if (m.blockedUntil !== null && now < m.blockedUntil) continue;
      for (let i = 0; i < g.rows.length; i += FOREIGN_BATCH) {
        const go = await this.batch(st, g.machineId, g.tenantId, g.rows.slice(i, i + FOREIGN_BATCH), me);
        this.save(st);
        if (go === 'stop') return;
        if (go === 'next_machine') break;
      }
    }
    this.save(st);
  }

  private async batch(st: ForeignUploadState, machineId: string, tenantId: string | null, rows: OutboxRow[], me: string): Promise<'go' | 'next_machine' | 'stop'> {
    const now = this.now();
    const m = this.machine(st, machineId);
    const records: Array<{ kind: string; id: string; body: unknown }> = [];
    for (const r of rows) {
      const body = this.d.body(r);
      if (body === null || body === undefined) {
        // The record itself is gone from the device: nothing to file — held for good (it is in the backups' copy).
        this.d.outbox.hold(r.kind, r.ref_id, `${REFUSED_PREFIX}missing_record`);
        continue;
      }
      records.push({ kind: r.kind, id: r.ref_id, body });
    }
    if (records.length === 0) return 'go';
    const reply = await this.d.api.post<{ machineName?: unknown; posNumber?: unknown; shopName?: unknown; results?: ResultIn[] }>(
      `sync/${me}/foreign-records`,
      { machineId, tenantId, records },
      { timeoutMs: 90_000 },
    );
    if (reply.kind === 'offline') return 'stop';
    if (reply.kind === 'refused') {
      if (reply.status === 404 || reply.status === 405) {
        st.unsupportedAt = now;
        this.d.log('foreign upload: the server has no foreign-records endpoint — the rows stay held');
        return 'stop';
      }
      if (reply.status === 409) {
        m.lastError = reply.detail ?? 'refused';
        m.blockedUntil = now + REQUEST_REFUSED_RETRY_MS;
        m.lastAt = now;
        this.d.log(`foreign upload: machine ${machineId} refused (${m.lastError}) — the rows stay held`);
        return 'next_machine';
      }
      m.lastError = `HTTP ${reply.status}`;
      m.lastAt = now;
      for (const r of rows) this.d.outbox.park(r.kind, r.ref_id, `foreign upload HTTP ${reply.status}`, now);
      return 'next_machine';
    }
    st.unsupportedAt = null;
    const b = reply.body ?? {};
    if (typeof b.machineName === 'string') m.machineName = b.machineName;
    if (typeof b.posNumber === 'string' || typeof b.posNumber === 'number') m.posNumber = String(b.posNumber);
    if (typeof b.shopName === 'string') m.shopName = b.shopName;
    m.lastAt = now;
    m.lastError = null;
    m.blockedUntil = null;
    const results = new Map<string, ResultIn>();
    for (const x of Array.isArray(b.results) ? b.results : []) results.set(`${String(x.kind)}|${String(x.id)}`, x);
    const synced: string[] = [];
    for (const rec of records) {
      const x = results.get(`${rec.kind}|${rec.id}`);
      const status = typeof x?.status === 'string' ? x.status : null;
      if (status === 'accepted' || status === 'duplicate') {
        this.d.outbox.remove(rec.kind as OutboxRow['kind'], rec.id);
        m.uploaded += 1;
        if (rec.kind === 'transaction') synced.push(rec.id);
      } else if (status === 'refused') {
        this.d.outbox.hold(rec.kind as OutboxRow['kind'], rec.id, `${REFUSED_PREFIX}${typeof x?.code === 'string' ? x.code : 'refused'}`);
      } else {
        this.d.outbox.park(rec.kind as OutboxRow['kind'], rec.id, `foreign upload ${status ?? 'unanswered'}${typeof x?.code === 'string' ? ` ${x.code}` : ''}`, now);
      }
    }
    if (synced.length > 0) this.d.synced(synced);
    return 'go';
  }
}
