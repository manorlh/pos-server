/**
 * The cash host (`cash_host` role, P:/specs/cash-paylink.md §2, §12): a headless Windows box that
 * runs one or more cash stations (one PayLink unit each) for the kiosks of its shop.
 *
 *  - its configuration from the cloud (`GET /sync/{m}/cash`, ETag; kept in `kv` so the host starts
 *    and works with no internet, §13): the host secret, the stations (serial, settings, the clients
 *    assigned to each), staff commands from the dashboard, the shop's LAN servers for alerts;
 *  - the LAN API (lanServer.ts) for the kiosks, signed per client;
 *  - the loop: every station ticks (~150 ms), the CheckOperation watchdog every 500 ms;
 *  - the journal to the cloud (`POST /sync/{m}/cash/journal`, idempotent) — later when offline;
 *  - its heartbeat block (`cash`: LAN address, port, each station's state, change, alerts);
 *  - with no cloud: the stations' alerts to the shop's LAN server (`POST /kiosk/alerts`), as a kiosk does.
 */

import type { Api } from '../sync/api';
import type { Kv } from '../db/schema';
import type { CashDevice } from '../../core/cash/device';
import { CASH_API, CASH_PORT, type CashEvent, type CashHealth, type CashRoute } from '../../core/cash/lanProtocol';
import { cashSettingsOf, type CashSettings } from '../../core/cash/settings';
import { txView } from '../../core/cash/tx';
import type { CashJournal, CashMove } from './journal';
import { CashLanServer, type CashLanHost } from './lanServer';
import { CashStation, type Reply, type StationConfig } from './station';

export interface HostStationConfig {
  stationId: string;
  name: string;
  location: string | null;
  serial: string;
  simulator: boolean;
  settings: Record<string, unknown>;
  clients: Array<{ machineId: string; name: string; kind: string }>;
}

export interface HostCommand {
  id: string;
  stationId: string;
  op: string;
  args: Record<string, unknown>;
  by: { userId: string | null; name: string | null } | null;
  createdAt: string | null;
}

export interface HostConfig {
  hostSecret: string | null;
  stations: HostStationConfig[];
  commands: HostCommand[];
  settings: Record<string, unknown>;
  lanAlertTargets: Array<{ lanAddress: string; port: number; secret: string }>;
}

export interface CashHostDeps {
  api: Api;
  kv: Kv;
  journal: CashJournal;
  machineId(): string | null;
  appVersion: string;
  now(): number;
  newId(): string;
  log(m: string): void;
  /** This box's address on the shop's LAN (reported to the cloud for the kiosks). */
  lanAddress(): string | null;
  /** The cloud answered lately (the sync engine's heartbeat). */
  cloudOnline(): boolean;
  /** A device for a station: the simulator, or PayLink through the vendor's DLL. */
  createDevice(station: HostStationConfig, settings: CashSettings): { device: CashDevice; driverInstalled(): boolean; stop?(): Promise<void> };
  port?: number;
  /** Timers off (tests drive `tick` / `watchdog` / `pull` / `upload` themselves). */
  manualTimers?: boolean;
  fetch?: typeof fetch;
}

const K = { config: 'cash.hostConfig', etag: 'cash.hostConfigEtag', commandsDone: 'cash.commandsDone' } as const;
const TICK_MS = 150;
const WATCHDOG_MS = 500;
const PULL_MS = 25_000;
const UPLOAD_MS = 10_000;
const LAN_ALERT_MS = 30_000;

export const EMPTY_HOST_CONFIG: HostConfig = { hostSecret: null, stations: [], commands: [], settings: {}, lanAlertTargets: [] };

/** The cloud's answer, read leniently (contract §11.2, host). */
export function hostConfigOf(body: unknown): HostConfig | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as Record<string, unknown>;
  if (b.role !== undefined && b.role !== 'host') return null;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const stations: HostStationConfig[] = Array.isArray(b.stations)
    ? (b.stations as Array<Record<string, unknown>>)
        .filter((s) => s && typeof s.stationId === 'string' && s.stationId)
        .map((s) => ({
          stationId: String(s.stationId),
          name: str(s.name) || 'עמדת מזומן',
          location: typeof s.location === 'string' && s.location ? s.location : null,
          serial: str(s.serial),
          simulator: s.simulator === true,
          settings: s.settings && typeof s.settings === 'object' ? (s.settings as Record<string, unknown>) : {},
          clients: Array.isArray(s.clients)
            ? (s.clients as Array<Record<string, unknown>>).filter((c) => c && typeof c.machineId === 'string').map((c) => ({ machineId: String(c.machineId), name: str(c.name), kind: str(c.kind) || 'kiosk' }))
            : [],
        }))
    : [];
  const commands: HostCommand[] = Array.isArray(b.commands)
    ? (b.commands as Array<Record<string, unknown>>)
        .filter((c) => c && typeof c.id === 'string' && typeof c.op === 'string')
        .map((c) => ({
          id: String(c.id),
          stationId: str(c.stationId),
          op: String(c.op),
          args: c.args && typeof c.args === 'object' ? (c.args as Record<string, unknown>) : {},
          by: c.by && typeof c.by === 'object' ? { userId: (c.by as Record<string, unknown>).userId as string | null, name: (c.by as Record<string, unknown>).name as string | null } : null,
          createdAt: typeof c.createdAt === 'string' ? c.createdAt : null,
        }))
    : [];
  const targets = Array.isArray(b.lanAlertTargets)
    ? (b.lanAlertTargets as Array<Record<string, unknown>>)
        .filter((t) => t && typeof t.lanAddress === 'string' && t.lanAddress && typeof t.secret === 'string')
        .map((t) => ({ lanAddress: String(t.lanAddress), port: typeof t.port === 'number' ? t.port : 8765, secret: String(t.secret) }))
    : [];
  return {
    hostSecret: typeof b.hostSecret === 'string' && b.hostSecret ? b.hostSecret : null,
    stations,
    commands,
    settings: b.settings && typeof b.settings === 'object' ? (b.settings as Record<string, unknown>) : {},
    lanAlertTargets: targets,
  };
}

interface RunningStation {
  station: CashStation;
  cfg: HostStationConfig;
  stop?: () => Promise<void>;
  deviceKey: string;
}

export class CashHost implements CashLanHost {
  private cfg: HostConfig;
  private stations = new Map<string, RunningStation>();
  private server: CashLanServer | null = null;
  private timers: NodeJS.Timeout[] = [];
  private uploading = false;
  private pulling = false;
  private lastUploadError: string | null = null;
  private lastPullAt: number | null = null;
  private readonly fetchFn: typeof fetch;
  private commandsRunning = false;

  constructor(private readonly d: CashHostDeps) {
    this.cfg = d.kv.getJson<HostConfig>(K.config) ?? { ...EMPTY_HOST_CONFIG };
    this.fetchFn = d.fetch ?? ((...a) => fetch(...a));
  }

  /* ------------------------------------------------------------------ lifecycle */

  async start(): Promise<void> {
    this.apply(this.cfg);
    this.server = new CashLanServer(this, { port: this.d.port ?? CASH_PORT });
    try {
      const port = await this.server.listen();
      this.d.log(`[cash] LAN API on port ${port}`);
    } catch (e) {
      this.d.log(`[cash] LAN API could not listen: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (this.d.manualTimers) return;
    this.timers.push(setInterval(() => void this.tick(), TICK_MS));
    this.timers.push(setInterval(() => void this.watchdog(), WATCHDOG_MS));
    this.timers.push(setInterval(() => void this.pull(), PULL_MS));
    this.timers.push(setInterval(() => void this.upload(), UPLOAD_MS));
    this.timers.push(setInterval(() => void this.lanAlerts(), LAN_ALERT_MS));
    setTimeout(() => void this.pull(), 1_000).unref?.();
  }

  async stop(): Promise<void> {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await this.server?.close();
    this.server = null;
    for (const s of this.stations.values()) await s.stop?.().catch(() => undefined);
    this.stations.clear();
  }

  get port(): number {
    return this.server?.listeningPort ?? this.d.port ?? CASH_PORT;
  }

  /** The cloud's word on the stations: new ones open, gone ones close, the rest take new settings. */
  apply(cfg: HostConfig) {
    this.cfg = cfg;
    const host = this.d.machineId();
    const hostSettings = cfg.settings;
    const wanted = new Set(cfg.stations.map((s) => s.stationId));
    for (const [id, r] of this.stations) {
      if (wanted.has(id)) continue;
      if (r.station.busy()) continue; // never under a customer; next time
      void r.stop?.();
      this.stations.delete(id);
      this.d.log(`[cash] station ${id} removed`);
    }
    for (const s of cfg.stations) {
      const settings = cashSettingsOf({ ...hostSettings, ...s.settings, ...(s.simulator ? { cashSimulator: true } : {}) });
      const sc: StationConfig = { stationId: s.stationId, name: s.name, location: s.location, serial: s.serial, settings, clients: s.clients };
      const deviceKey = `${settings.simulator ? 'sim' : 'paylink'}|${s.serial}|${settings.dllPath}`;
      const running = this.stations.get(s.stationId);
      if (running && running.deviceKey === deviceKey) {
        running.station.configure(sc);
        running.cfg = s;
        continue;
      }
      if (running) {
        if (running.station.busy()) continue;
        void running.stop?.();
      }
      const made = this.d.createDevice(s, settings);
      const station = new CashStation(sc, {
        hostId: () => host ?? this.d.machineId(),
        device: made.device,
        journal: this.d.journal,
        now: this.d.now,
        newId: this.d.newId,
        log: this.d.log,
        driverInstalled: made.driverInstalled,
      });
      this.stations.set(s.stationId, { station, cfg: s, stop: made.stop, deviceKey });
      this.d.log(`[cash] station ${s.name} (${s.stationId}) on ${made.device.kind}${s.serial ? ` ${s.serial}` : ''}`);
    }
  }

  station(id: string): CashStation | null {
    return this.stations.get(id)?.station ?? null;
  }

  allStations(): CashStation[] {
    return [...this.stations.values()].map((r) => r.station);
  }

  config(): HostConfig {
    return this.cfg;
  }

  /* ------------------------------------------------------------------ the loop */

  async tick(): Promise<void> {
    await Promise.all([...this.stations.values()].map((r) => r.station.tick()));
  }

  async watchdog(): Promise<void> {
    await Promise.all([...this.stations.values()].map((r) => r.station.watchdogTick()));
  }

  /** A lease or a transaction is open somewhere: the updater waits. */
  busy(): boolean {
    return [...this.stations.values()].some((r) => r.station.busy());
  }

  /* ------------------------------------------------------------------ the cloud */

  async pull(): Promise<void> {
    const m = this.d.machineId();
    if (!m || this.pulling) return;
    this.pulling = true;
    try {
      const etag = this.d.kv.get(K.etag);
      const reply = await this.d.api.get<Record<string, unknown>>(`sync/${m}/cash`, { headers: etag && this.cfg.hostSecret ? { 'If-None-Match': etag } : {}, timeoutMs: 20_000 });
      if (reply.kind !== 'ok') return;
      this.lastPullAt = this.d.now();
      if (reply.status !== 304) {
        const cfg = hostConfigOf(reply.body);
        if (cfg) {
          this.d.kv.setJson(K.config, cfg);
          const tag = reply.headers.get('etag');
          if (tag) this.d.kv.set(K.etag, tag);
          this.apply(cfg);
        }
      }
      await this.runCommands();
    } finally {
      this.pulling = false;
    }
  }

  /** Staff commands from the dashboard (refill, count, collect, dump…), each once, acknowledged. */
  async runCommands(): Promise<void> {
    if (this.commandsRunning) return;
    this.commandsRunning = true;
    try {
      const done = new Set(this.d.kv.getJson<string[]>(K.commandsDone) ?? []);
      for (const c of this.cfg.commands) {
        if (done.has(c.id)) continue;
        const r = await this.runCommand(c);
        const m = this.d.machineId();
        if (m) {
          const ack = await this.d.api.post(`sync/${m}/cash/commands/${encodeURIComponent(c.id)}/ack`, { status: r.status, message: r.message, movementId: r.movementId ?? null }, { timeoutMs: 15_000 });
          if (ack.kind === 'offline') continue; // acknowledged next time (it does not run twice: `done`)
        }
        done.add(c.id);
        this.d.kv.setJson(K.commandsDone, [...done].slice(-300));
      }
    } finally {
      this.commandsRunning = false;
    }
  }

  async runCommand(c: HostCommand): Promise<{ status: 'done' | 'refused' | 'failed'; message: string; movementId?: string }> {
    const st = this.station(c.stationId);
    if (!st) return { status: 'refused', message: 'העמדה אינה בשרת הזה' };
    const a = c.args;
    const pieces = Array.isArray(a.pieces)
      ? (a.pieces as Array<Record<string, unknown>>).map((p) => ({ valueAgorot: Number(p.valueAgorot), count: Number(p.count) })).filter((p) => Number.isInteger(p.valueAgorot) && Number.isInteger(p.count))
      : [];
    const note = typeof a.note === 'string' ? a.note : null;
    const counted = typeof a.countedAgorot === 'number' ? a.countedAgorot : null;
    try {
      let r: { ok: boolean; message: string; move?: CashMove };
      switch (c.op) {
        case 'refill':
        case 'float':
          r = st.refill(c.op, pieces, c.by, note, c.id);
          break;
        case 'count':
          r = await st.count(pieces, counted, c.by, note, c.id);
          break;
        case 'collect':
          r = st.collect(counted, c.by, note, c.id);
          break;
        case 'dump':
          r = await st.dump(typeof a.valueAgorot === 'number' ? a.valueAgorot : null, typeof a.notes === 'number' ? a.notes : null, c.by, c.id);
          break;
        case 'deliver_pending':
          r = await st.deliverPending(c.by);
          break;
        case 'ext_return':
        case 'ext_stack':
          r = await st.resolveExtEscrow(c.op === 'ext_return' ? 'return' : 'stack');
          break;
        case 'maintenance_on':
        case 'maintenance_off':
          st.setMaintenance(c.op === 'maintenance_on', c.by?.name ?? null);
          r = { ok: true, message: c.op === 'maintenance_on' ? 'העמדה בתחזוקה' : 'העמדה חזרה לשירות' };
          break;
        case 'reset_alerts':
          st.resetAlerts();
          r = { ok: true, message: 'ההתראות אופסו' };
          break;
        default:
          return { status: 'refused', message: `פעולה לא מוכרת: ${c.op}` };
      }
      return { status: r.ok ? 'done' : 'refused', message: r.message, movementId: r.move?.id };
    } catch (e) {
      return { status: 'failed', message: e instanceof Error ? e.message : String(e) };
    }
  }

  /** The journal to the cloud: final transactions (and their acknowledgements), then the movements. */
  async upload(): Promise<void> {
    const m = this.d.machineId();
    if (!m || this.uploading) return;
    this.uploading = true;
    try {
      const txs = this.d.journal.toUpload(50);
      const moves = this.d.journal.movesToUpload(50);
      if (txs.length + moves.length === 0) return;
      const entries = [
        ...txs.map((t) => ({
          type: 'tx',
          id: t.txId,
          ...txView(t),
          orderRef: t.orderRef,
          orderLabel: t.orderLabel,
          clientName: t.clientName,
          deviceSerial: this.station(t.stationId)?.snapshot()?.serial ?? null,
          doneAt: t.doneAt,
        })),
        ...moves.map((mv) => ({ type: 'movement', ...mv })),
      ];
      const reply = await this.d.api.post<{ accepted?: string[]; rejected?: Array<{ id: string; error: string }> }>(`sync/${m}/cash/journal`, { entries }, { timeoutMs: 30_000 });
      if (reply.kind !== 'ok') {
        this.lastUploadError = reply.kind === 'offline' ? reply.reason : `HTTP ${reply.status}`;
        return;
      }
      this.lastUploadError = null;
      const accepted = new Set(reply.body?.accepted ?? []);
      for (const r of reply.body?.rejected ?? []) {
        // A refusal is final for that entry (logged) — never resent in a loop.
        accepted.add(r.id);
        this.d.log(`[cash] journal entry ${r.id} refused: ${r.error}`);
      }
      for (const t of txs) if (accepted.has(t.txId)) this.d.journal.markTxUploaded(t.txId, t.seq);
      for (const mv of moves) if (accepted.has(mv.id)) this.d.journal.markMoveUploaded(mv.id);
    } finally {
      this.uploading = false;
    }
  }

  /** The heartbeat's `cash` block (contract §11.9). */
  heartbeatBlock(): Record<string, unknown> {
    return {
      api: CASH_API,
      lanAddress: this.d.lanAddress(),
      port: this.port,
      version: this.d.appVersion,
      uploadError: this.lastUploadError,
      stations: [...this.stations.values()].map((r) => r.station.heartbeatBlock()),
    };
  }

  /**
   * No cloud: the stations' alerts to the shop's LAN server(s), the way a kiosk hands its alerts to
   * the main till (`POST /kiosk/alerts`, the print secret) — the whole state each time (§13).
   */
  async lanAlerts(force = false): Promise<number> {
    if (!force && this.d.cloudOnline()) return 0;
    let delivered = 0;
    for (const r of this.stations.values()) {
      const st = r.station;
      const body = {
        kioskMachineId: st.id,
        kioskName: st.cfg.name,
        alerts: st.alerts().map((a) => ({
          kind: 'cash',
          key: `${a.code}:${a.unit}`,
          reason: a.code,
          detail: {},
          requestId: null,
          pings: 0,
          text: `${st.cfg.name}${st.cfg.location ? ` (${st.cfg.location})` : ''}: ${a.message}`,
        })),
      };
      for (const t of this.cfg.lanAlertTargets) {
        try {
          const res = await this.fetchFn(`http://${t.lanAddress}:${t.port}/kiosk/alerts`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${t.secret}` },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(4_000),
          });
          if (res.ok) {
            delivered++;
            break;
          }
        } catch {
          /* the next target */
        }
      }
    }
    return delivered;
  }

  /* ------------------------------------------------------------------ the LAN API (CashLanHost) */

  health(): CashHealth {
    return { service: 'r2m-cash', api: CASH_API, hostId: this.d.machineId(), version: this.d.appVersion, time: this.d.now(), stations: [...this.stations.keys()] };
  }

  hostSecret(): string | null {
    return this.cfg.hostSecret;
  }

  knownClient(clientId: string): boolean {
    return [...this.stations.values()].some((r) => r.station.isClient(clientId));
  }

  mayWatch(stationId: string, clientId: string): boolean {
    return this.station(stationId)?.isClient(clientId) ?? false;
  }

  onEvent(stationId: string, fn: (e: CashEvent, clientId: string | null) => void): () => void {
    const st = this.station(stationId);
    return st ? st.onEvent(fn) : () => undefined;
  }

  now(): number {
    return this.d.now();
  }

  log(m: string): void {
    this.d.log(m);
  }

  async call(route: CashRoute, clientId: string, body: Record<string, unknown>): Promise<Reply> {
    if (route.kind === 'health' || route.kind === 'events') return { status: 404, body: { error: 'not_found' } };
    const st = this.station(route.stationId);
    if (!st) return { status: 404, body: { error: 'unknown_station', message: 'העמדה אינה בשרת הזה' } };
    if (!st.isClient(clientId)) return { status: 403, body: { error: 'not_assigned', message: 'הקיוסק אינו משויך לעמדה הזו' } };
    switch (route.kind) {
      case 'status':
        return { status: 200, body: st.status(clientId) };
      case 'lease':
        return st.lease(clientId, body);
      case 'release':
        return st.release(clientId, route.leaseId);
      case 'tx_start': {
        const r = st.startTx(clientId, route.txId, body);
        if (r.status === 200) void st.tick();
        return r;
      }
      case 'tx_get':
        return st.getTx(clientId, route.txId);
      case 'tx_cancel':
        return st.cancelTx(clientId, route.txId, body.reason);
      case 'tx_ack':
        return st.ackTx(clientId, route.txId, body);
    }
  }

  /** The staff screen's / technician's look (renderer/roles/cash). */
  staffView() {
    return {
      hostId: this.d.machineId(),
      lanAddress: this.d.lanAddress(),
      port: this.port,
      cloudOnline: this.d.cloudOnline(),
      lastPullAt: this.lastPullAt,
      uploadError: this.lastUploadError,
      pendingUploads: this.d.journal.toUpload(500).length + this.d.journal.movesToUpload(500).length,
      stations: [...this.stations.values()].map((r) => {
        const st = r.station;
        const status = st.status(null);
        const v = st.ledger();
        return {
          stationId: st.id,
          name: st.cfg.name,
          location: st.cfg.location,
          serial: st.cfg.serial,
          simulator: st.settings.simulator || r.cfg.simulator,
          status,
          alerts: st.alerts(),
          denominations: v?.denominations.map((d) => ({ valueAgorot: d.valueAgorot, kind: d.kind, count: d.count, accurate: d.accurate, level: d.level, isLow: d.isLow })) ?? [],
          cashbox: v?.cashbox ?? null,
          changeAvailableAgorot: v?.changeAvailableAgorot ?? 0,
          clients: st.cfg.clients,
          recent: st.recentTxs(15),
          moves: this.d.journal.moves(st.id, 15),
          maintenance: st.inMaintenance,
          refillVia: st.refillActive,
        };
      }),
    };
  }
}
