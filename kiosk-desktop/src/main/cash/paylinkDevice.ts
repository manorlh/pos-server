/**
 * A cash station's real device: PayLink through the vendor's DLL in a utility process
 * (paylinkWorker.ts), one process per unit — each one opens its unit by serial (§12), so several
 * PayLinks on one box never share the DLL's "current unit". The process is started on the first
 * open and again after it dies; a request that gets no answer in time fails (the station treats
 * the device as gone and holds what was open).
 */

import type { CashDevice, CommandResult, DeviceCommand, DeviceEvent, DeviceSnapshot, OpenResult } from '../../core/cash/device';
import type { WorkerReply, WorkerRequest } from './paylinkCore';

export interface WorkerLink {
  post(msg: WorkerRequest): void;
  onMessage(fn: (msg: WorkerReply) => void): void;
  onExit(fn: (code: number | null) => void): void;
  kill(): void;
}

export class PaylinkDevice implements CashDevice {
  readonly kind = 'paylink' as const;
  private link: WorkerLink | null = null;
  private seq = 0;
  private waiting = new Map<number, { resolve: (r: WorkerReply) => void; timer: NodeJS.Timeout }>();
  private loaded = false;

  constructor(
    private readonly spawn: () => WorkerLink,
    private readonly opts: { dllPath: () => string | null; serial: string; timeoutMs?: number; log?: (m: string) => void },
  ) {}

  private ensure(): WorkerLink {
    if (this.link) return this.link;
    const link = this.spawn();
    link.onMessage((r) => {
      const w = this.waiting.get(r.id);
      if (!w) return;
      clearTimeout(w.timer);
      this.waiting.delete(r.id);
      w.resolve(r);
    });
    link.onExit((code) => {
      this.opts.log?.(`[cash paylink ${this.opts.serial || 'default'}] worker exited (${code ?? '-'})`);
      if (this.link === link) {
        this.link = null;
        this.loaded = false;
      }
      for (const [id, w] of this.waiting) {
        clearTimeout(w.timer);
        w.resolve({ id, ok: false, error: 'worker exited' });
      }
      this.waiting.clear();
    });
    this.link = link;
    return link;
  }

  private request(msg: Omit<WorkerRequest, 'id'>, timeoutMs = this.opts.timeoutMs ?? 5_000): Promise<WorkerReply> {
    const link = this.ensure();
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        resolve({ id, ok: false, error: 'timeout' });
      }, timeoutMs);
      this.waiting.set(id, { resolve, timer });
      link.post({ ...msg, id } as WorkerRequest);
    });
  }

  async open(): Promise<OpenResult> {
    const dll = this.opts.dllPath();
    if (!dll) return { ok: false, code: null, message: 'דרייבר מזומן לא מותקן (AESImhei64.dll לא נמצא)', retry: true };
    if (!this.loaded) {
      const r = await this.request({ op: 'load', dllPath: dll, serial: this.opts.serial } as Omit<WorkerRequest, 'id'>, 15_000);
      if (!r.ok) return { ok: false, code: null, message: `הספרייה לא נטענה: ${r.error}`, retry: true };
      this.loaded = true;
    }
    const r = await this.request({ op: 'open' } as Omit<WorkerRequest, 'id'>, 15_000);
    if (!r.ok) return { ok: false, code: null, message: r.error, retry: true };
    return r.value as OpenResult;
  }

  async close(): Promise<void> {
    if (!this.link) return;
    await this.request({ op: 'close' } as Omit<WorkerRequest, 'id'>, 3_000);
  }

  async read(): Promise<{ snapshot: DeviceSnapshot; events: DeviceEvent[] }> {
    const r = await this.request({ op: 'read' } as Omit<WorkerRequest, 'id'>);
    if (!r.ok) throw new Error(r.error);
    return r.value as { snapshot: DeviceSnapshot; events: DeviceEvent[] };
  }

  async command(c: DeviceCommand): Promise<CommandResult> {
    const r = await this.request({ op: 'command', command: c } as Omit<WorkerRequest, 'id'>);
    if (!r.ok) return { ok: false, error: r.error };
    return r.value as CommandResult;
  }

  /** USBDriverStatus (null: the DLL is not loaded / no answer). */
  async driverStatus(): Promise<number | null> {
    if (!this.loaded) return null;
    const r = await this.request({ op: 'driver_status' } as Omit<WorkerRequest, 'id'>, 3_000);
    return r.ok && typeof r.value === 'number' ? r.value : null;
  }

  async driverExit(): Promise<void> {
    if (!this.loaded) return;
    await this.request({ op: 'driver_exit' } as Omit<WorkerRequest, 'id'>, 3_000);
  }

  /** The process ends (an app exit / the station removed). */
  stop() {
    this.link?.kill();
    this.link = null;
    this.loaded = false;
  }
}
