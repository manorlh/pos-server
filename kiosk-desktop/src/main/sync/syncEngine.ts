/**
 * The kiosk's conversation with the cloud, on the Android till's cadence (pos-android
 * data/sync/HeartbeatLoop.kt, AppContainer.collectAfterBeat, CloudSync.kt, KioskRepository.kt):
 *
 *  - heartbeat every 30 s (no realtime channel on Windows yet), 5 s while the cloud asks for a
 *    fast beat; its answer carries zMode, lastTillZNumber, Zs that cover our shifts, and remote
 *    instructions (close the shift, produce the Z, transmit, reset, the main till's shop Z part);
 *  - after a good beat (at most every 25 s): parameters (ETag), settings (since), kiosk/sync
 *    (every 15 s for a kiosk), catalog (delta), promotions (ETag), the outbox;
 *  - every 15 minutes (and at start): machines/me, a full catalog, POS users;
 *  - nothing here is on the customer's path: the screens only ever read the local copies.
 */

import { stockLevelsOf } from '@dash-lib/kioskSoldOut';
import { apiBase, tokenRevoked, type Api, type ApiReply } from './api';
import { docResults, FINAL_ON_REFUSAL, plan, type Outbox, type OutboxRow } from './outbox';
import type { CloudStore, Credentials, MachineMe } from './cloud';
import type { Ledger } from '../fiscal/ledger';
import { documentWire } from '../fiscal/ledger';

export const BEAT_MS = 30_000;
export const FAST_BEAT_MS = 5_000;
export const FAST_HOLD_MS = 60_000;
export const PULL_MIN_MS = 25_000;
export const KIOSK_SYNC_MS = 15_000;
export const FULL_SYNC_MS = 15 * 60_000;

export interface RemoteHooks {
  /** The heartbeat body's kiosk-specific parts (printer, offline Z, counters…). */
  heartbeatExtras(): Record<string, unknown>;
  /** The status `kiosk/sync` reports (null for a till that is not a kiosk). */
  kioskStatus(): Record<string, unknown> | null;
  /** The kiosk snapshot changed (config, state, media list). */
  onKioskSnapshot(next: Record<string, unknown>, prev: Record<string, unknown> | null): void;
  onCatalog(): void;
  /** The promotions changed (the basket is priced with them, lib/kioskMoney.ts). */
  onPromotions?(): void;
  /** The stock levels changed ("אזל" counts by them). */
  onStock?(): void;
  onSettings(): void;
  onParameters(): void;
  /** Remote instructions from the heartbeat. */
  onPendingCloseShift(req: { requestId: string; shiftId?: string | null; force?: boolean }): void;
  onPendingTillZ(req: { requestId: string; force?: boolean }): void;
  onPendingTransmit(req: { requestId: string }): void;
  onPendingReset(req: { commandId: string; kind: string; reason?: string }): void;
  /**
   * The main till's local shop Z asks this kiosk for its part through the cloud (SPEC_INDEPENDENT_TILL
   * §8.14): repeated on every beat until the kiosk answers (main/fiscal/shopZPart.ts).
   */
  onPendingShopZPart(req: { requestId: string; roundId: string; force: boolean }): void;
  /** Kiosk orders and other side uploads after a good beat. */
  afterBeat(): Promise<void>;
  /** A side outbox row (transmission, acks): its request, or null to drop it. */
  sideRequest(row: OutboxRow): { path: string; body: unknown } | null;
  /** The token was revoked (re-paired elsewhere / unpaired): back to pairing. */
  onRevoked(): void;
  log(msg: string): void;
}

export interface SyncStatus {
  lastBeatOkAt: number | null;
  lastBeatError: string | null;
  lastKioskSyncAt: number | null;
  lastCatalogAt: number | null;
  lastFlushAt: number | null;
  lastFlushError: string | null;
  clockSkewMs: number | null;
}

export class SyncEngine {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private fastUntil = 0;
  private lastPullAt = 0;
  private lastKioskSyncAttempt = 0;
  private lastFullAt = 0;
  private flushing: Promise<void> | null = null;
  private stopped = false;
  readonly status: SyncStatus = {
    lastBeatOkAt: null,
    lastBeatError: null,
    lastKioskSyncAt: null,
    lastCatalogAt: null,
    lastFlushAt: null,
    lastFlushError: null,
    clockSkewMs: null,
  };

  constructor(
    private readonly api: Api,
    private readonly cloud: CloudStore,
    private readonly ledger: Ledger,
    private readonly outbox: Outbox,
    private readonly hooks: RemoteHooks,
    private readonly appVersion: string,
  ) {
    this.status.lastKioskSyncAt = cloud.kioskSyncAt();
    this.status.lastBeatOkAt = cloud.heartbeat().lastOkAt;
  }

  get machineId(): string | null {
    return this.cloud.credentials()?.machineId ?? null;
  }

  start() {
    this.stopped = false;
    this.schedule(1_000);
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number) {
    if (this.stopped) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  /** One cycle: beat, then the pulls when due. Never two at once. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      if (!this.machineId) return;
      const now = Date.now();
      if (now - this.lastFullAt >= FULL_SYNC_MS) {
        this.lastFullAt = now;
        await this.fullSync();
      }
      const ok = await this.heartbeat();
      if (ok && Date.now() - this.lastPullAt >= PULL_MIN_MS) {
        this.lastPullAt = Date.now();
        await this.pulls();
      }
      if (ok) {
        await this.flush();
        await this.hooks.afterBeat().catch((e) => this.hooks.log(`afterBeat: ${String(e)}`));
      }
    } catch (e) {
      this.hooks.log(`sync tick: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
    } finally {
      this.running = false;
      this.schedule(Date.now() < this.fastUntil ? FAST_BEAT_MS : BEAT_MS);
    }
  }

  /** "סנכרון עכשיו" (admin) and after a sale. */
  async syncNow(): Promise<void> {
    this.lastPullAt = 0;
    this.lastKioskSyncAttempt = 0;
    await this.tick();
  }

  private check(reply: ApiReply): boolean {
    if (tokenRevoked(reply)) {
      this.hooks.onRevoked();
      return false;
    }
    return reply.kind === 'ok';
  }

  private machinePath(rest: string): string {
    return `sync/${this.machineId}/${rest}`;
  }

  /* -------------------------------------------------------------- heartbeat */

  async heartbeat(): Promise<boolean> {
    const shift = this.ledger.currentShift();
    const body: Record<string, unknown> = {
      appVersion: this.appVersion,
      pendingCount: this.outbox.count(),
      pendingDocuments: this.outbox.count('transaction'),
      realtimeConnected: false,
      ...(this.status.clockSkewMs !== null ? { clockSkewMs: this.status.clockSkewMs } : {}),
      ...(shift ? { openShiftId: shift.id, openShiftOpenedAt: shift.opened_at } : {}),
      documentCounters: this.ledger.counters.report(),
      ...this.hooks.heartbeatExtras(),
    };
    const sentAt = Date.now();
    const reply = await this.api.post<Record<string, unknown>>('machines/me/heartbeat', body, { timeoutMs: 20_000 });
    if (!this.check(reply)) {
      this.status.lastBeatError = reply.kind === 'offline' ? reply.reason : `HTTP ${reply.status}`;
      return false;
    }
    if (reply.kind !== 'ok') return false;
    const date = reply.headers.get('date');
    if (date) {
      const server = Date.parse(date);
      if (Number.isFinite(server)) this.status.clockSkewMs = Math.round((sentAt + Date.now()) / 2 - server);
    }
    const b = reply.body ?? {};
    const prev = this.cloud.heartbeat();
    const epoch = typeof b.tillZEpoch === 'number' ? b.tillZEpoch : prev.tillZEpoch;
    this.cloud.setHeartbeat({
      zMode: b.zMode === 'till' ? 'till' : 'cloud',
      lastTillZNumber: typeof b.lastTillZNumber === 'number' ? b.lastTillZNumber : epoch !== prev.tillZEpoch ? null : prev.lastTillZNumber,
      tillZEpoch: epoch,
      independentTill: b.independentTill === true,
      lastOkAt: Date.now(),
      serverTime: typeof b.serverTime === 'string' ? b.serverTime : null,
    });
    this.status.lastBeatOkAt = Date.now();
    this.status.lastBeatError = null;
    if (b.fastBeat === true) this.fastUntil = Date.now() + FAST_HOLD_MS;
    if (Array.isArray(b.recentShiftZs)) {
      for (const z of b.recentShiftZs as Array<Record<string, unknown>>) {
        if (typeof z.shiftId === 'string' && typeof z.zReportId === 'string') {
          this.ledger.markShiftsInZ([z.shiftId], z.zReportId, typeof z.zNumber === 'number' ? z.zNumber : null);
        }
      }
    }
    const req = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : null);
    const close = req(b.pendingCloseShift);
    if (close && typeof close.requestId === 'string') this.hooks.onPendingCloseShift({ requestId: close.requestId, shiftId: (close.shiftId as string) ?? null, force: close.force === true });
    const z = req(b.pendingTillZ);
    if (z && typeof z.requestId === 'string') this.hooks.onPendingTillZ({ requestId: z.requestId, force: z.force === true });
    const transmit = req(b.pendingTransmit);
    if (transmit && typeof transmit.requestId === 'string') this.hooks.onPendingTransmit({ requestId: transmit.requestId });
    const reset = req(b.pendingReset);
    if (reset && typeof reset.commandId === 'string') this.hooks.onPendingReset({ commandId: reset.commandId, kind: String(reset.kind ?? ''), reason: (reset.reason as string) ?? undefined });
    const part = req(b.pendingShopZPart);
    if (part && typeof part.requestId === 'string' && typeof part.roundId === 'string') this.hooks.onPendingShopZPart({ requestId: part.requestId, roundId: part.roundId, force: part.force !== false });
    return true;
  }

  /* ----------------------------------------------------------------- pulls */

  async pulls(): Promise<void> {
    await this.pullParameters();
    await this.pullSettings();
    if (Date.now() - this.lastKioskSyncAttempt >= KIOSK_SYNC_MS) await this.kioskSync();
    await this.pullCatalog(false);
    await this.pullPromotions();
    await this.pullStock();
  }

  async fullSync(): Promise<void> {
    await this.pullMachine();
    await this.pullSettings(true);
    await this.pullParameters();
    await this.kioskSync();
    await this.pullCatalog(true);
    await this.pullPromotions();
    await this.pullStock();
    await this.pullPosUsers();
  }

  async pullMachine(): Promise<MachineMe | null> {
    const reply = await this.api.get<MachineMe>('machines/me', { timeoutMs: 20_000 });
    if (!this.check(reply) || reply.kind !== 'ok' || !reply.body) return null;
    this.cloud.setMachine(reply.body);
    return reply.body;
  }

  async pullParameters(): Promise<void> {
    const etag = this.cloud.parametersEtag();
    const reply = await this.api.get<{ parameters?: Record<string, unknown> }>(this.machinePath('parameters'), {
      headers: etag && Object.keys(this.cloud.parameters()).length > 0 ? { 'If-None-Match': etag } : {},
      timeoutMs: 20_000,
    });
    if (!this.check(reply) || reply.kind !== 'ok' || reply.status === 304) return;
    const params = reply.body?.parameters;
    if (params && typeof params === 'object') {
      this.cloud.setParameters(params, reply.headers.get('etag'));
      this.hooks.onParameters();
    }
  }

  async pullSettings(full = false): Promise<void> {
    const prev = this.cloud.settings();
    const since = !full && prev.settingsUpdatedAt ? `?since=${encodeURIComponent(prev.settingsUpdatedAt)}` : '';
    const reply = await this.api.get<Record<string, unknown>>(this.machinePath(`settings${since}`), { timeoutMs: 20_000 });
    if (!this.check(reply) || reply.kind !== 'ok' || !reply.body) return;
    const b = reply.body;
    if (b.syncType === 'unchanged') return;
    this.cloud.setSettings({
      settings: (b.settings as Record<string, unknown>) ?? {},
      businessInfo: (b.businessInfo as Record<string, unknown>) ?? null,
      settingsUpdatedAt: typeof b.settingsUpdatedAt === 'string' ? b.settingsUpdatedAt : null,
      serverTime: typeof b.serverTime === 'string' ? b.serverTime : null,
    });
    this.hooks.onSettings();
  }

  async pullCatalog(full: boolean): Promise<void> {
    const prev = this.cloud.catalog();
    const since = !full && prev.serverTime ? `?since=${encodeURIComponent(prev.serverTime)}` : '';
    const reply = await this.api.get<Record<string, unknown>>(this.machinePath(`catalog${since}`), { timeoutMs: 60_000 });
    if (!this.check(reply) || reply.kind !== 'ok' || !reply.body) return;
    const b = reply.body;
    const changed = b.syncType === 'full' || (Array.isArray(b.products) && b.products.length > 0) || (Array.isArray(b.categories) && b.categories.length > 0) || !!b.menu || (!!b.catalogMenus && typeof b.catalogMenus === 'object');
    this.cloud.applyCatalog(b);
    this.status.lastCatalogAt = Date.now();
    if (changed) this.hooks.onCatalog();
  }

  /** "מבצעים": the till's promotions (`GET /sync/{m}/promotions`, ETag); offline, the last ones stay. */
  async pullPromotions(): Promise<void> {
    const etag = this.cloud.promotionsEtag();
    const q = etag ? `?etag=${encodeURIComponent(etag)}` : '';
    const reply = await this.api.get<{ syncType?: string; etag?: string; promotions?: unknown }>(this.machinePath(`promotions${q}`), { timeoutMs: 20_000 });
    if (!this.check(reply) || reply.kind !== 'ok' || !reply.body) return;
    if (reply.body.syncType === 'unchanged') return;
    const list = Array.isArray(reply.body.promotions) ? (reply.body.promotions as Array<Record<string, unknown>>).filter((p) => !!p && typeof p === 'object') : [];
    this.cloud.setPromotions(list, typeof reply.body.etag === 'string' ? reply.body.etag : null);
    this.hooks.onPromotions?.();
  }

  /**
   * The shop's stock levels (`GET /sync/{m}/stock`, whole, as the Android till pulls them): a product that
   * tracks stock with none here is "אזל" on the kiosk (lib/kioskSoldOut.ts). Offline, the last levels stay.
   */
  async pullStock(): Promise<void> {
    const reply = await this.api.get<Record<string, unknown>>(this.machinePath('stock'), { timeoutMs: 20_000 });
    if (!this.check(reply) || reply.kind !== 'ok' || !reply.body) return;
    if (this.cloud.mergeStockLevels(stockLevelsOf(reply.body))) this.hooks.onStock?.();
  }

  async pullPosUsers(): Promise<void> {
    const since = this.cloud.posUsersAt();
    const reply = await this.api.get<Record<string, unknown>>(this.machinePath(`pos-users${since ? `?since=${encodeURIComponent(since)}` : ''}`), { timeoutMs: 20_000 });
    if (!this.check(reply) || reply.kind !== 'ok' || !reply.body) return;
    this.cloud.applyPosUsers(reply.body);
  }

  /** `kiosk/sync`: the status up, the config/state/media/operator down. */
  async kioskSync(): Promise<boolean> {
    this.lastKioskSyncAttempt = Date.now();
    const status = this.hooks.kioskStatus();
    const reply = await this.api.post<Record<string, unknown>>(this.machinePath('kiosk/sync'), status ? { status } : {}, { timeoutMs: 15_000 });
    if (!this.check(reply) || reply.kind !== 'ok' || !reply.body || typeof reply.body !== 'object') return false;
    const prev = this.cloud.kioskSnapshot();
    this.cloud.setKioskSnapshot(reply.body);
    this.status.lastKioskSyncAt = Date.now();
    this.hooks.onKioskSnapshot(reply.body, prev);
    return true;
  }

  /* --------------------------------------------------------------- outbox */

  /** Deliver the outbox in order (one flush at a time). */
  flush(): Promise<void> {
    if (!this.flushing) {
      this.flushing = this.doFlush()
        .catch((e) => {
          this.status.lastFlushError = String(e);
        })
        .finally(() => {
          this.flushing = null;
        });
    }
    return this.flushing;
  }

  private async doFlush(): Promise<void> {
    if (!this.machineId) return;
    const rows = this.outbox.due();
    if (rows.length === 0) {
      this.status.lastFlushAt = Date.now();
      return;
    }
    const steps = plan(
      rows,
      (docId) => this.ledger.doc(docId)?.shiftId ?? null,
      (id) => {
        const s = this.ledger.shift(id);
        return s ? { id, sequence: s.sequence_number, openedAt: s.opened_at } : null;
      },
    );
    for (const step of steps) {
      if (step.kind === 'side') {
        const req = this.hooks.sideRequest(step.row);
        if (!req) {
          this.outbox.remove(step.row.kind, step.row.ref_id);
          continue;
        }
        const reply = await this.api.post(this.machinePath(req.path), req.body);
        if (reply.kind === 'offline') return this.stopFlush(reply.reason);
        if (reply.kind === 'ok' || (reply.kind === 'refused' && (reply.status === 404 || reply.status === 410))) this.outbox.remove(step.row.kind, step.row.ref_id);
        else if (reply.kind === 'refused' && reply.status >= 400 && reply.status < 500 && FINAL_ON_REFUSAL.has(step.row.kind)) {
          this.hooks.log(`${step.row.kind} ${step.row.ref_id} refused for good: HTTP ${reply.status} ${reply.detail ?? ''}`);
          this.outbox.remove(step.row.kind, step.row.ref_id);
        } else this.outbox.park(step.row.kind, step.row.ref_id, `HTTP ${reply.status} ${reply.detail ?? ''}`);
        continue;
      }
      if (step.kind === 'open') {
        const shift = this.ledger.shift(step.shiftId);
        if (!shift) {
          this.outbox.remove('shift_open', step.shiftId);
          continue;
        }
        const reply = await this.api.post(this.machinePath('shifts'), this.ledger.shiftOpenWire(shift));
        if (reply.kind === 'ok') {
          this.outbox.remove('shift_open', step.shiftId);
          continue;
        }
        if (reply.kind === 'offline') return this.stopFlush(reply.reason);
        if (reply.status === 403 && reply.detail === 'shift_belongs_to_another_machine') {
          this.ledger.retireShift(step.shiftId);
          this.outbox.remove('shift_open', step.shiftId);
          continue;
        }
        if (reply.status === 409) this.outbox.hold('shift_open', step.shiftId, reply.detail ?? '409');
        else this.outbox.park('shift_open', step.shiftId, `HTTP ${reply.status} ${reply.detail ?? ''}`);
        return this.stopFlush(`shift open: HTTP ${reply.status}`);
      }
      if (step.kind === 'docs') {
        const sent = step.rows.map((r) => r.ref_id).filter((id) => {
          const d = this.ledger.doc(id);
          if (!d || d.status === 'pending') {
            this.outbox.remove('transaction', id);
            return false;
          }
          return true;
        });
        if (sent.length === 0) continue;
        const docs = sent.map((id) => documentWire(this.ledger.doc(id)!));
        const reply = await this.api.post(this.machinePath('transactions'), { transactions: docs }, { timeoutMs: 60_000 });
        if (reply.kind === 'offline') return this.stopFlush(reply.reason);
        if (reply.kind === 'refused') {
          if (reply.status === 400 || reply.status === 422) {
            for (const id of sent) this.outbox.park('transaction', id, `HTTP ${reply.status} ${reply.detail ?? ''}`);
            continue;
          }
          return this.stopFlush(`transactions: HTTP ${reply.status} ${reply.detail ?? ''}`);
        }
        const results = docResults(sent, reply.body);
        const synced: string[] = [];
        let held = false;
        for (const [id, r] of results) {
          if (r.result === 'synced') {
            synced.push(id);
            this.outbox.remove('transaction', id);
          } else if (r.result === 'rejected') this.outbox.park('transaction', id, r.reason ?? 'rejected');
          else {
            held = true;
            this.outbox.hold('transaction', id, r.reason ?? 'held');
          }
        }
        if (synced.length > 0) this.ledger.markSynced(synced);
        if (held) return this.stopFlush('a document was not answered');
        continue;
      }
      if (step.kind === 'close') {
        const shift = this.ledger.shift(step.shiftId);
        if (!shift || !shift.close_payload) {
          this.outbox.remove('shift_close', step.shiftId);
          continue;
        }
        const reply = await this.api.post<Record<string, unknown>>(this.machinePath(`shifts/${step.shiftId}/close`), JSON.parse(shift.close_payload));
        if (reply.kind === 'ok') {
          const b = reply.body ?? {};
          this.ledger.markCloseAccepted(step.shiftId, { zReportId: (b.zReportId as string) ?? null, zNumber: (b.zNumber as number) ?? null });
          this.outbox.remove('shift_close', step.shiftId);
          continue;
        }
        if (reply.kind === 'offline') return this.stopFlush(reply.reason);
        const body = (reply.body ?? {}) as Record<string, unknown>;
        if (reply.status === 409 && reply.detail === 'missing_transactions') {
          const again = [...((body.missingIds as string[]) ?? []), ...((body.staleIds as string[]) ?? [])];
          for (const id of again) if (this.ledger.doc(id)) this.outbox.enqueue('transaction', id);
          this.outbox.hold('shift_close', step.shiftId, 'missing_transactions');
          return this.stopFlush('close waits for its documents');
        }
        if (reply.status === 403 && reply.detail === 'shift_belongs_to_another_machine') {
          this.ledger.retireShift(step.shiftId);
          this.outbox.remove('shift_close', step.shiftId);
          continue;
        }
        if (reply.status === 409) this.outbox.hold('shift_close', step.shiftId, reply.detail ?? '409');
        else this.outbox.park('shift_close', step.shiftId, `HTTP ${reply.status} ${reply.detail ?? ''}`);
        return this.stopFlush(`shift close: HTTP ${reply.status}`);
      }
    }
    this.status.lastFlushAt = Date.now();
    this.status.lastFlushError = null;
  }

  private stopFlush(why: string) {
    this.status.lastFlushError = why;
  }
}

/* ---------------------------------------------------------------- pairing */

export type PairResult = { ok: true; credentials: Credentials; machine: MachineMe | null } | { ok: false; error: string; status?: number };

/**
 * The pairing screen's flow (server URL + 8-character code, as on the till): validate (snake_case
 * only — camelCase loses the device info), keep the credentials, read machines/me, and raise the
 * counters from the last closed shift.
 */
export async function pair(
  api: Api,
  input: { serverUrl: string; code: string; machineName: string; deviceInfo: Record<string, string> },
): Promise<PairResult> {
  api.setBase(input.serverUrl);
  const code = input.code.trim().toUpperCase().replace(/\s+/g, '');
  const reply = await api.post<Record<string, unknown>>(
    'pairing/validate',
    { code, machine_name: input.machineName || undefined, device_info: input.deviceInfo },
    { auth: false, timeoutMs: 30_000 },
  );
  if (reply.kind === 'offline') return { ok: false, error: `אין חיבור לשרת (${reply.reason})` };
  if (reply.kind === 'refused') {
    // The cloud's own Hebrew sentence when it gives one (e.g. a Windows code redeemed on Android: platform_mismatch).
    const said = reply.body && typeof reply.body === 'object' ? (reply.body as { message?: unknown; detail?: unknown }) : null;
    const message = typeof said?.message === 'string' ? said.message : typeof (said?.detail as { message?: unknown } | undefined)?.message === 'string' ? String((said!.detail as { message: string }).message) : null;
    if (message) return { ok: false, error: message, status: reply.status };
    if (reply.status === 400 || reply.status === 404) return { ok: false, error: 'קוד הצימוד שגוי או שפג תוקפו', status: reply.status };
    if (reply.status === 409 && reply.detail === 'untransmitted_card_sales') return { ok: false, error: 'בקופה הקודמת יש עסקאות אשראי שלא שודרו — יש לשדר לפני ההחלפה', status: 409 };
    if (reply.status === 409) return { ok: false, error: reply.detail ?? 'הקופה עדיין פתוחה', status: 409 };
    return { ok: false, error: `שגיאת שרת ${reply.status}`, status: reply.status };
  }
  const b = reply.body ?? {};
  if (typeof b.accessToken !== 'string' || typeof b.machineId !== 'string') return { ok: false, error: 'תשובת צימוד לא תקינה' };
  const credentials: Credentials = {
    serverUrl: apiBase(input.serverUrl),
    accessToken: b.accessToken,
    machineId: b.machineId,
    machineCode: (b.machineCode as string) ?? null,
    tenantId: (b.tenantId as string) ?? null,
    shopId: (b.shopId as string) ?? null,
    mqttClientId: (b.mqttClientId as string) ?? null,
    realtimeChannel: (b.realtimeChannel as string) ?? null,
    pairedAt: new Date().toISOString(),
  };
  return { ok: true, credentials, machine: null };
}
