/**
 * Supervising the vendor's USB driver program (`Paylink.exe`), as the System Manual says
 * ("User control of driver program"): it should run from boot to shutdown; when the application
 * starts it, it first cleans a stale shared segment (USBDriverExit when OpenMHE answers 0 with no
 * driver behind it); the system is not usable for 10 s after a driver (re)start; a driver that is
 * stopped is asked to exit cleanly (USBDriverExit → USB_IDLE) before it is ended. Anything other
 * than STANDARD_DRIVER means "not working now" — but the flash loader and the manufacturer's test
 * tool own the link while they run: never restarted under a technician.
 *
 * Pure: the decision; main/cash/driver.ts does the processes.
 */

import { DRIVER_RESTART, DRIVER_SETTLE_MS, FLASH_LOADER, MANUFACTURING_TEST, STANDARD_DRIVER, USB_ERROR, USB_IDLE } from './paylinkApi';

export interface DriverFacts {
  now: number;
  /** Paylink.exe and AESImhei64.dll were found. */
  installed: boolean;
  /** A Paylink.exe process for this unit runs. */
  running: boolean;
  /** USBDriverStatus (null: the DLL could not be asked). */
  status: number | null;
  /** OpenMHE's last failure code (31 = driver not running), null when open. */
  openError: number | null;
}

export interface DriverMemory {
  lastStartAt: number | null;
  lastRestartAt: number | null;
  /** Since when the status has been bad while the process runs. */
  badSince: number | null;
  exitRequestedAt: number | null;
}

export const EMPTY_DRIVER_MEMORY: DriverMemory = { lastStartAt: null, lastRestartAt: null, badSince: null, exitRequestedAt: null };

export type DriverAction =
  | { kind: 'none'; state: 'ok' | 'missing' | 'settling' | 'tool' | 'waiting' }
  | { kind: 'start' }
  | { kind: 'request_exit' }
  | { kind: 'kill' };

/** A bad status this long while the process runs → a clean restart. */
export const BAD_FOR_MS = 20_000;
/** Never more than one restart in this long. */
export const RESTART_EVERY_MS = 120_000;
/** A start that did not show up in this long is tried again. */
export const START_RETRY_MS = 15_000;
/** USBDriverExit is given this long to end the program before it is ended by force. */
export const EXIT_GRACE_MS = 10_000;

export function decideDriver(f: DriverFacts, m: DriverMemory): { action: DriverAction; memory: DriverMemory } {
  const mem = { ...m };
  if (!f.installed) return { action: { kind: 'none', state: 'missing' }, memory: mem };
  // A clean exit was asked: wait for it, then end it.
  if (mem.exitRequestedAt !== null) {
    if (!f.running || f.status === USB_IDLE) {
      mem.exitRequestedAt = null;
      mem.lastStartAt = f.now;
      return { action: { kind: 'start' }, memory: mem };
    }
    if (f.now - mem.exitRequestedAt > EXIT_GRACE_MS) {
      mem.exitRequestedAt = null;
      return { action: { kind: 'kill' }, memory: mem };
    }
    return { action: { kind: 'none', state: 'waiting' }, memory: mem };
  }
  if (!f.running) {
    mem.badSince = null;
    if (mem.lastStartAt !== null && f.now - mem.lastStartAt < START_RETRY_MS) return { action: { kind: 'none', state: 'settling' }, memory: mem };
    mem.lastStartAt = f.now;
    return { action: { kind: 'start' }, memory: mem };
  }
  if (f.status === FLASH_LOADER || f.status === MANUFACTURING_TEST) {
    mem.badSince = null;
    return { action: { kind: 'none', state: 'tool' }, memory: mem };
  }
  if (mem.lastStartAt !== null && f.now - mem.lastStartAt < DRIVER_SETTLE_MS) return { action: { kind: 'none', state: 'settling' }, memory: mem };
  const bad = f.status === USB_ERROR || f.status === USB_IDLE || (f.status !== null && f.status !== STANDARD_DRIVER && f.status !== DRIVER_RESTART) || f.openError === 31;
  if (!bad) {
    mem.badSince = null;
    return { action: { kind: 'none', state: f.status === DRIVER_RESTART ? 'waiting' : 'ok' }, memory: mem };
  }
  if (mem.badSince === null) mem.badSince = f.now;
  if (f.now - mem.badSince < BAD_FOR_MS) return { action: { kind: 'none', state: 'waiting' }, memory: mem };
  if (mem.lastRestartAt !== null && f.now - mem.lastRestartAt < RESTART_EVERY_MS) return { action: { kind: 'none', state: 'waiting' }, memory: mem };
  mem.lastRestartAt = f.now;
  mem.exitRequestedAt = f.now;
  mem.badSince = null;
  return { action: { kind: 'request_exit' }, memory: mem };
}

/** The driver's command line (the System Manual's switches): hidden, a log file, the unit's serial. */
export function driverArgs(o: { serial: string; logFile: string | null; configFile?: string | null }): string[] {
  const args: string[] = [];
  if (o.configFile) args.push(o.configFile);
  args.push('/H');
  if (o.logFile) args.push('/L', o.logFile, '/Z', '1024');
  if (o.serial) args.push('/S', o.serial);
  return args;
}

/** Where the vendor's package puts its files (the install guide), then the cloud's own paths first. */
export function driverCandidates(o: { driverPath: string; programFiles: string[] }): string[] {
  const out: string[] = [];
  if (o.driverPath) out.push(o.driverPath.toLowerCase().endsWith('.exe') ? o.driverPath : `${o.driverPath.replace(/[\\/]+$/, '')}\\Paylink.exe`);
  for (const pf of o.programFiles) {
    for (const dir of ['Aardvark\\Paylink', 'Aardvark Embedded Solutions\\Paylink', 'Paylink', 'Money Controls\\Paylink', 'Crane\\Paylink', 'CPI\\Paylink', 'AES\\Paylink']) out.push(`${pf}\\${dir}\\Paylink.exe`);
  }
  out.push('C:\\Paylink\\Paylink.exe');
  return [...new Set(out)];
}

export function dllCandidates(o: { dllPath: string; driverExe: string | null; windowsDir: string; programFiles: string[] }): string[] {
  const out: string[] = [];
  if (o.dllPath) out.push(o.dllPath.toLowerCase().endsWith('.dll') ? o.dllPath : `${o.dllPath.replace(/[\\/]+$/, '')}\\AESImhei64.dll`);
  if (o.driverExe) out.push(o.driverExe.replace(/[^\\/]+$/, 'AESImhei64.dll'));
  // The manual's recommended places for the 64-bit DLL.
  out.push(`${o.windowsDir}\\System\\AESImhei64.dll`, `${o.windowsDir}\\System32\\AESImhei64.dll`, `${o.windowsDir}\\AESImhei64.dll`);
  for (const pf of o.programFiles) out.push(`${pf}\\Aardvark\\Paylink\\AESImhei64.dll`, `${pf}\\Paylink\\AESImhei64.dll`);
  return [...new Set(out)];
}
