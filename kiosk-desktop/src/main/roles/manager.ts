/**
 * The shell's role manager: which role this device plays now (core/roles.ts, from the cloud's
 * copies the service keeps), the role module that runs for it (KDS / order status board), and
 * the shell's own view for the screens (role, update status). The kiosk role runs inside the
 * service as before; switching the role never touches the ledger.
 */

import { EventEmitter } from 'node:events';
import type { KioskService } from '../service';
import { parameterOn } from '../sync/cloud';
import { asksKdsDevice, isFiscal, resolveRole } from '../../core/roles';
import type { Activity } from '../../core/updatePolicy';
import type { AppRole, BoardView, KdsActionInput, KdsView, ShellEvents, ShellView, UpdateView } from '../../shared/roles';
import { BoardModule } from './board';
import { KdsModule } from './kds';
import type { RoleContext } from './types';

/**
 * Whether the service may act as a till: the cloud's `machines/me` `fiscal: false` (a KDS / board
 * machine, `pos_machines.is_fiscal`) always wins; otherwise the role decides; a role not known yet
 * keeps a paired kiosk working as before (fiscal).
 */
export function fiscalOf(cloudFiscal: unknown, role: AppRole | null): boolean {
  if (cloudFiscal === false) return false;
  return role === null ? true : isFiscal(role);
}

const KDS_DEVICE = 'shell.kdsDevice';
const KDS_DEVICE_EVERY_MS = 60_000;

type KdsDeviceFact = { role: string; isActive: boolean } | null;

export class RoleManager extends EventEmitter {
  private current: AppRole | null = null;
  private kds: KdsModule | null = null;
  private board: BoardModule | null = null;
  private kdsDevice: KdsDeviceFact;
  private kdsDeviceAt = 0;
  private lastTouchAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private lastViewJson = '';
  private readonly ctx: RoleContext;

  constructor(
    private readonly svc: KioskService,
    private readonly updates: () => UpdateView,
    private readonly log: (m: string) => void = () => undefined,
  ) {
    super();
    this.kdsDevice = svc.kv.getJson<KdsDeviceFact>(KDS_DEVICE) ?? null;
    this.ctx = { api: svc.api, kv: svc.kv, machineId: () => svc.machineId, log };
  }

  start() {
    this.svc.on('view', () => this.recompute());
    this.recompute();
    void this.refreshKdsDevice(true);
    this.timer = setInterval(() => {
      void this.refreshKdsDevice(false);
      this.recompute();
    }, 5_000);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.kds?.stop();
    this.board?.stop();
  }

  role(): AppRole | null {
    return this.current;
  }

  /* -------------------------------------------------------------- the role */

  private facts() {
    const me = this.svc.cloud.machine();
    return { me, deviceRole: me?.deviceRole ?? null };
  }

  /** `kds/device` — only for a screen (or a till flagged `kdsScreen`), as the till asks it. */
  async refreshKdsDevice(force: boolean): Promise<void> {
    const id = this.svc.machineId;
    if (!id) return;
    const { deviceRole } = this.facts();
    if (!asksKdsDevice(deviceRole, parameterOn(this.svc.cloud.parameters().kdsScreen))) {
      if (this.kdsDevice) this.setKdsDevice(null);
      return;
    }
    if (!force && Date.now() - this.kdsDeviceAt < KDS_DEVICE_EVERY_MS) return;
    this.kdsDeviceAt = Date.now();
    const reply = await this.svc.api.get<{ device?: { role?: string; isActive?: boolean } | null }>(`sync/${id}/kds/device`, { timeoutMs: 15_000 });
    if (reply.kind !== 'ok') return; // offline: the last answer stands
    const d = reply.body?.device;
    this.setKdsDevice(d && typeof d.role === 'string' ? { role: d.role, isActive: d.isActive !== false } : null);
  }

  private setKdsDevice(d: KdsDeviceFact) {
    this.kdsDevice = d;
    if (d) this.svc.kv.setJson(KDS_DEVICE, d);
    else this.svc.kv.delete(KDS_DEVICE);
    this.recompute();
  }

  recompute() {
    const { me, deviceRole } = this.facts();
    const next = resolveRole({ paired: this.svc.paired, deviceRole, kioskActive: this.svc.isKiosk(), kdsDevice: this.kdsDevice });
    if (next !== this.current) {
      this.log(`role ${this.current ?? '—'} → ${next ?? '—'}`);
      this.current = next;
      this.switchModule(next);
    }
    this.svc.setFiscalRole(fiscalOf(me?.fiscal, next));
    this.emitView();
  }

  private switchModule(role: AppRole | null) {
    if (role !== 'kds' && this.kds) {
      this.kds.stop();
      this.kds = null;
    }
    if (role !== 'order_status_board' && this.board) {
      this.board.stop();
      this.board = null;
    }
    if (role === 'kds' && !this.kds) {
      this.kds = new KdsModule(this.ctx, (v) => this.emitEvent('kds', v));
      this.kds.start();
    }
    if (role === 'order_status_board' && !this.board) {
      this.board = new BoardModule(this.ctx, (v) => this.emitEvent('board', v));
      this.board.start();
    }
  }

  /* ---------------------------------------------------------------- views */

  view(): ShellView {
    const v = this.svc.view();
    const me = this.svc.cloud.machine();
    return {
      role: this.current,
      fiscal: fiscalOf(me?.fiscal, this.current) && this.current !== null,
      appVersion: v.appVersion,
      machineName: v.machine?.name ?? null,
      shopName: v.machine?.shopName ?? null,
      online: !v.state.offline,
      update: this.updates(),
    };
  }

  emitView() {
    const v = this.view();
    const json = JSON.stringify(v);
    if (json === this.lastViewJson) return;
    this.lastViewJson = json;
    this.emitEvent('view', v);
  }

  private emitEvent<K extends keyof ShellEvents>(name: K, payload: ShellEvents[K]) {
    this.emit(name, payload);
  }

  boardView(): BoardView {
    return this.board?.view() ?? { shopName: null, preparing: [], ready: [], updatedAt: null, offline: true, notConfigured: this.current !== 'order_status_board' };
  }

  kdsView(): KdsView {
    return (
      this.kds?.view() ?? { device: null, shopName: null, orders: [], stationSettings: {}, updatedAt: null, offline: true, pendingActions: 0, lastError: null, serverOffsetMs: 0 }
    );
  }

  kdsAction(a: KdsActionInput): Promise<{ ok: boolean; message?: string }> {
    this.touch();
    return this.kds ? this.kds.action(a) : Promise.resolve({ ok: false, message: 'המכשיר אינו מסך מטבח' });
  }

  /* ------------------------------------------------------------- activity */

  touch() {
    this.lastTouchAt = Date.now();
  }

  /** What the updater asks: the kiosk's flow for a kiosk, the last touch for a screen. */
  activity(): Activity {
    if (this.current === 'kiosk' || this.current === null) return { ...this.svc.activity(), role: this.current };
    return { role: this.current, screen: '', busy: false, idle: true, cardInFlight: false, cardBlocked: false, lastActivityAt: this.lastTouchAt };
  }
}
