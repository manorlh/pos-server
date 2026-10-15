/**
 * The `cash_host` role module (core/roles.ts): the cash host on top of the shared service layer —
 * the same pairing, sync, heartbeat and updates as every role (P:/specs/cash-paylink.md §2). It
 * owns the stations' devices: the simulator where the cloud says so (`cashSimulator`), else the
 * vendor's DLL in a utility process per unit with its driver supervised (driver.ts).
 */

import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type { KioskService } from '../service';
import type { CashSettings } from '../../core/cash/settings';
import { CashJournal } from './journal';
import { CashHost, type HostStationConfig } from './host';
import { SimulatedPaylink, type SimConfig } from './simulator';
import { PaylinkDevice, type WorkerLink } from './paylinkDevice';
import { PaylinkDriver, windowsDriverPlatform, type DriverPlatform } from './driver';
import type { CashStation } from './station';
import { DeviceCommands, DEVICE_LOGS_CAPABILITY } from '../deviceCommands';
import type { RollingLog } from '../deviceLog';

/** The simulator's unit when no hardware is used: an Israeli coin set, a note acceptor with escrow and a 20/50 recycler. */
export const DEFAULT_SIM: SimConfig = {
  coins: [10, 50, 100, 200, 500, 1000],
  notes: { values: [2000, 5000, 10000, 20000], bus: 'id003', escrow: true },
  hoppers: [
    { valueAgorot: 1000, count: 100 },
    { valueAgorot: 500, count: 100 },
    { valueAgorot: 200, count: 100 },
    { valueAgorot: 100, count: 200 },
    { valueAgorot: 50, count: 100 },
    { valueAgorot: 10, count: 200 },
  ],
  noteRecycler: { units: [{ valueAgorot: 2000, count: 20 }, { valueAgorot: 5000, count: 10 }] },
  autoTakeBills: true,
  piecesPerRead: 2,
};

export interface CashModuleOptions {
  /** A utility process running main/cash/paylinkWorker.js (Electron); absent in tools → simulator only. */
  spawnWorker?: () => WorkerLink;
  driverPlatform?: DriverPlatform;
  port?: number;
  log: (m: string) => void;
  /** "שליטה מרחוק" (§11.15ד): the app's rolling log ("בקש לוגים") and its restart ("הפעלה מחדש"). */
  logs?: RollingLog | null;
  restartApp?: () => void;
}

const DRIVER_EVERY_MS = 15_000;

export class CashHostModule {
  readonly host: CashHost;
  private readonly sims = new Map<string, SimulatedPaylink>();
  private readonly drivers = new Map<string, { driver: PaylinkDriver; device: PaylinkDevice }>();
  private driverTimer: NodeJS.Timeout | null = null;
  /** The dashboard's generic commands for this box: a restart, a logs request (§11.15ד). */
  readonly commands: DeviceCommands;

  constructor(
    private readonly svc: KioskService,
    private readonly o: CashModuleOptions,
  ) {
    this.host = new CashHost({
      api: svc.api,
      kv: svc.kv,
      journal: new CashJournal(svc.db),
      machineId: () => svc.machineId,
      appVersion: svc.appVersion,
      now: Date.now,
      newId: () => randomUUID(),
      log: o.log,
      lanAddress: () => lanAddressOf(svc.lanInterfaces()),
      cloudOnline: () => svc.cloudOnline(),
      createDevice: (s, settings) => this.createDevice(s, settings),
      port: o.port,
    });
    this.commands = new DeviceCommands({
      api: svc.api,
      machineId: () => svc.machineId,
      log: o.log,
      logs: o.logs ?? null,
      appVersion: svc.appVersion,
      // Never mid-payment: an open transaction at any station holds the restart off.
      busy: () => (this.host.busy() ? 'payment_in_progress' : null),
      restart: () => (o.restartApp ? o.restartApp() : o.log('device command: restart_app — no restart hook here')),
    });
  }

  private createDevice(s: HostStationConfig, settings: CashSettings) {
    if (settings.simulator || !this.o.spawnWorker) {
      const sim = new SimulatedPaylink({ ...DEFAULT_SIM, serial: s.serial || `SIM-${s.stationId.slice(0, 6)}` });
      this.sims.set(s.stationId, sim);
      return { device: sim, driverInstalled: () => true };
    }
    const driver = new PaylinkDriver(this.o.driverPlatform ?? windowsDriverPlatform(), {
      serial: s.serial,
      driverPath: settings.driverPath,
      dllPath: settings.dllPath,
      logDir: path.join(this.svc.dataDir, 'paylink-logs'),
      now: Date.now,
      log: this.o.log,
    });
    const device = new PaylinkDevice(this.o.spawnWorker, { dllPath: () => driver.dllPath, serial: s.serial, log: this.o.log });
    this.drivers.set(s.stationId, { driver, device });
    return {
      device,
      driverInstalled: () => driver.installed(),
      stop: async () => {
        device.stop();
        this.drivers.delete(s.stationId);
      },
    };
  }

  async start(): Promise<void> {
    this.svc.setHeartbeatPart('cash', () => this.host.heartbeatBlock());
    // "בקש לוגים" is offered to a device that says it can (device-logs-api.md §2).
    if (this.o.logs) this.svc.setHeartbeatPart('capabilities', () => [DEVICE_LOGS_CAPABILITY]);
    await this.host.start();
    this.commands.start();
    this.driverTimer = setInterval(() => void this.superviseDrivers(), DRIVER_EVERY_MS);
    void this.superviseDrivers();
  }

  async stop(): Promise<void> {
    if (this.driverTimer) clearInterval(this.driverTimer);
    this.driverTimer = null;
    this.svc.setHeartbeatPart('cash', null);
    this.svc.setHeartbeatPart('capabilities', null);
    this.commands.stop();
    await this.host.stop();
  }

  private async superviseDrivers() {
    for (const [id, { driver, device }] of this.drivers) {
      const st = this.host.station(id);
      const status = await device.driverStatus().catch(() => null);
      await driver.step({ status, openError: st?.openErrorCode ?? null }, () => device.driverExit()).catch((e) => this.o.log(`[cash driver] ${String(e)}`));
    }
  }

  busy(): boolean {
    return this.host.busy();
  }

  /** The simulator's unit of a station (the staff screen's "simulate" buttons), when it runs one. */
  simulator(stationId: string): SimulatedPaylink | null {
    return this.sims.get(stationId) ?? null;
  }

  station(stationId: string): CashStation | null {
    return this.host.station(stationId);
  }
}

/** The address the kiosks reach this box at: the first private IPv4 (10/8, 172.16/12, 192.168/16), else any. */
export function lanAddressOf(list: Array<{ name: string; address: string }>): string | null {
  const priv = (a: string) => /^10\./.test(a) || /^192\.168\./.test(a) || /^172\.(1[6-9]|2\d|3[01])\./.test(a);
  const virt = (n: string) => /vEthernet|VirtualBox|VMware|Hyper-V|WSL|Loopback|Tailscale|ZeroTier/i.test(n);
  return list.find((i) => priv(i.address) && !virt(i.name))?.address ?? list.find((i) => priv(i.address))?.address ?? list[0]?.address ?? null;
}
