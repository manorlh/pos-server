/**
 * The vendor's driver program for one PayLink unit (core/cash/driverPolicy.ts decides; this does):
 * finds `Paylink.exe` and `AESImhei64.dll` (the cloud's paths, else the vendor's install places —
 * §9ב: the vendor package is installed separately, never shipped with this app), checks the
 * process, starts it hidden with a log file (one per unit serial, `/S <serial>`), asks it to exit
 * cleanly (USBDriverExit) and ends it only if it does not.
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { decideDriver, dllCandidates, driverArgs, driverCandidates, EMPTY_DRIVER_MEMORY, type DriverMemory } from '../../core/cash/driverPolicy';

export interface DriverPlatform {
  exists(p: string): boolean;
  /** Command lines of the running Paylink.exe processes. */
  processes(): Promise<string[]>;
  start(exe: string, args: string[]): void;
  kill(exe: string, serial: string): Promise<void>;
}

export function windowsDriverPlatform(): DriverPlatform {
  return {
    exists: (p) => existsSync(p),
    processes: () =>
      new Promise((resolve) => {
        execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='Paylink.exe'\" | ForEach-Object { $_.CommandLine }"],
          { windowsHide: true, timeout: 15_000 },
          (err, stdout) => resolve(err ? [] : stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)),
        );
      }),
    start: (exe, args) => {
      spawn(exe, args, { cwd: path.dirname(exe), detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => undefined).unref();
    },
    kill: (exe, serial) =>
      new Promise((resolve) => {
        // Only this unit's driver: by its /S serial when it has one.
        const filter = serial ? `Name='Paylink.exe' AND CommandLine LIKE '%${serial.replace(/[^A-Za-z0-9]/g, '')}%'` : "Name='Paylink.exe'";
        execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }`], { windowsHide: true, timeout: 15_000 }, () => resolve());
        void exe;
      }),
  };
}

export class PaylinkDriver {
  private memory: DriverMemory = { ...EMPTY_DRIVER_MEMORY };
  private exe: string | null = null;
  private dll: string | null = null;
  state: 'ok' | 'missing' | 'settling' | 'tool' | 'waiting' | 'starting' = 'waiting';

  constructor(
    private readonly p: DriverPlatform,
    private readonly o: { serial: string; driverPath: string; dllPath: string; logDir: string; now: () => number; log: (m: string) => void; programFiles?: string[]; windowsDir?: string },
  ) {
    this.locate();
  }

  locate() {
    const pf = this.o.programFiles ?? [process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', process.env.ProgramFiles ?? 'C:\\Program Files'];
    this.exe = driverCandidates({ driverPath: this.o.driverPath, programFiles: pf }).find((c) => this.p.exists(c)) ?? null;
    this.dll = dllCandidates({ dllPath: this.o.dllPath, driverExe: this.exe, windowsDir: this.o.windowsDir ?? process.env.SystemRoot ?? 'C:\\Windows', programFiles: pf }).find((c) => this.p.exists(c)) ?? null;
  }

  get dllPath(): string | null {
    return this.dll;
  }

  get exePath(): string | null {
    return this.exe;
  }

  installed(): boolean {
    return this.exe !== null && this.dll !== null;
  }

  /**
   * One supervision step (every ~15 s): `status` / `openError` from the device, `exit` asks the DLL
   * for USBDriverExit.
   */
  async step(facts: { status: number | null; openError: number | null }, exit: () => Promise<void>): Promise<void> {
    if (!this.installed()) this.locate();
    const lines = this.installed() ? await this.p.processes() : [];
    const serial = this.o.serial;
    const running = lines.some((l) => (serial ? l.includes(serial) : !/\/S\s+\S+/i.test(l)));
    const { action, memory } = decideDriver({ now: this.o.now(), installed: this.installed(), running, status: facts.status, openError: facts.openError }, this.memory);
    this.memory = memory;
    switch (action.kind) {
      case 'none':
        this.state = action.state;
        return;
      case 'start': {
        mkdirSync(this.o.logDir, { recursive: true });
        const log = path.join(this.o.logDir, `paylink-${serial || 'default'}.log`);
        this.o.log(`[cash driver] starting ${this.exe} for ${serial || 'the default unit'}`);
        this.p.start(this.exe!, driverArgs({ serial, logFile: log }));
        this.state = 'starting';
        return;
      }
      case 'request_exit':
        this.o.log(`[cash driver] not working (${facts.status ?? '-'} / ${facts.openError ?? '-'}): asking it to exit`);
        await exit().catch(() => undefined);
        this.state = 'waiting';
        return;
      case 'kill':
        this.o.log('[cash driver] did not exit: ending it');
        await this.p.kill(this.exe!, serial);
        this.state = 'waiting';
        return;
    }
  }
}
