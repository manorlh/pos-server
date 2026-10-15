import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWorkerHandler, PaylinkSession } from '../src/main/cash/paylinkCore';
import { defineStructs, loadKoffi, STRUCT_SIZES, type AcceptorBlockJs, type DispenserBlockJs, type PaylinkLib } from '../src/main/cash/paylinkFfi';
import { PaylinkDevice, type WorkerLink } from '../src/main/cash/paylinkDevice';
import { decideDriver, driverArgs, EMPTY_DRIVER_MEMORY, type DriverMemory, BAD_FOR_MS, EXIT_GRACE_MS, driverCandidates, dllCandidates } from '../src/core/cash/driverPolicy';
import { ACCEPTOR_INHIBIT, DISPENSER_CASHBOX_DUMP, INTERFACE_VERSION, STANDARD_DRIVER, USB_ERROR, USB_IDLE, FLASH_LOADER } from '../src/core/cash/paylinkApi';
import type { WorkerReply, WorkerRequest } from '../src/main/cash/paylinkCore';
import { PaylinkDriver, type DriverPlatform } from '../src/main/cash/driver';

/** A DLL double: the blocks as PayLink keeps them, every call recorded. */
function fakeLib() {
  const calls: string[] = [];
  const coin = (v: number) => ({ Value: v, Inhibit: 0, Count: 3, Path: 0, PathCount: 0, PathSwitchLevel: 0, DefaultPath: 0, FutureExpansion: 0, HeldInEscrow: 0, FutureExpansion2: 0, CoinName: { ptr: `ILS${v}` } });
  const acceptors: AcceptorBlockJs[] = [
    { Unit: 0x02020103, Status: 0, NoOfCoins: 2, InterfaceNumber: 0, UnitAddress: 2, DefaultPath: 0, BarcodesStacked: 0, Currency: 'ILS', Coin: [coin(100), coin(500), ...Array.from({ length: 254 }, () => coin(0))], SerialNumber: 77, Description: { ptr: 'SR5' }, EscrowBarcodeHere: 0 },
  ];
  const dispensers: DispenserBlockJs[] = [{ Unit: 0x01020101, Status: 1, InterfaceNumber: 0, UnitAddress: 3, Value: 100, Count: 10, Inhibit: 0, NotesToDump: 0, CoinCount: 0, CoinCountStatus: 2, SerialNumber: 5, Description: { ptr: 'SCH2' } }];
  let open = 0;
  const lib: PaylinkLib = {
    OpenMHEVersion: (v) => {
      calls.push(`OpenMHEVersion(${v})`);
      return open;
    },
    OpenSpecificMHEVersion: (s, v) => {
      calls.push(`OpenSpecificMHEVersion(${s},${v})`);
      return open;
    },
    EnableInterface: () => void calls.push('EnableInterface'),
    DisableInterface: () => void calls.push('DisableInterface'),
    CurrentValue: () => 12345,
    CurrentPaid: () => 600,
    LastPayStatus: () => 1,
    CurrentUpdates: () => 9,
    PayOut: (v) => void calls.push(`PayOut(${v})`),
    SetDispenseQuantity: (i, q, v) => (calls.push(`SetDispenseQuantity(${i},${q},${v})`), q * v),
    PaySpecific: () => (calls.push('PaySpecific'), 300),
    IndicatorOn: (n) => void calls.push(`IndicatorOn(${n})`),
    IndicatorOff: (n) => void calls.push(`IndicatorOff(${n})`),
    SwitchOpens: (n) => (n === 1 ? 1 : 0),
    SwitchCloses: (n) => (n === 1 ? 2 : 0),
    ReadAcceptorDetails: (n) => (acceptors[n] ? structuredClone(acceptors[n]) : null),
    WriteAcceptorDetails: (n, b) => {
      calls.push(`WriteAcceptorDetails(${n})`);
      acceptors[n] = structuredClone(b);
    },
    ReadDispenserDetails: (n) => (dispensers[n] ? structuredClone(dispensers[n]) : null),
    WriteDispenserDetails: (n, b) => {
      calls.push(`WriteDispenserDetails(${n},${b.Status},${b.Inhibit})`);
      dispensers[n] = structuredClone(b);
    },
    EscrowEnable: () => void calls.push('EscrowEnable'),
    EscrowDisable: () => void calls.push('EscrowDisable'),
    EscrowAccept: () => void calls.push('EscrowAccept'),
    EscrowReturn: () => void calls.push('EscrowReturn'),
    EscrowThroughput: () => 0,
    ReadEscrowBlock: () => null,
    EscrowCommand: (n, c) => void calls.push(`EscrowCommand(${n},${c})`),
    NextEvent: (() => {
      const q = [{ EventCode: 0x100 | 6, RawEvent: 4, DispenserEvent: 0, Index: 0 }];
      return () => q.shift() ?? null;
    })(),
    CheckOperation: (s) => s,
    SerialNumber: () => 4242,
    FirmwareVersion: () => (4 << 24) | (1 << 16) | (12 << 8) | 6,
    USBDriverStatus: () => STANDARD_DRIVER,
    USBDriverExit: () => void calls.push('USBDriverExit'),
    IMHEIConsistencyError: () => null,
    DESStatus: () => -1,
    text: (p) => (p && typeof p === 'object' ? String((p as { ptr: string }).ptr) : ''),
  };
  return { lib, calls, acceptors, dispensers, setOpen: (v: number) => (open = v) };
}

describe('the DLL layer', () => {
  it('koffi computes the header’s struct sizes (x64, default alignment)', () => {
    const koffi = loadKoffi();
    const s = defineStructs(koffi as Parameters<typeof defineStructs>[0]);
    expect(koffi.sizeof(s.AcceptorCoin)).toBe(STRUCT_SIZES.AcceptorCoin);
    expect(koffi.sizeof(s.AcceptorBlock)).toBe(STRUCT_SIZES.AcceptorBlock);
    expect(koffi.sizeof(s.DispenserBlock)).toBe(STRUCT_SIZES.DispenserBlock);
    expect(koffi.sizeof(s.EscrowNoteDetails)).toBe(STRUCT_SIZES.EscrowNoteDetails);
    expect(koffi.sizeof(s.EscrowControlBlock)).toBe(STRUCT_SIZES.EscrowControlBlock);
    expect(koffi.sizeof(s.EventDetailBlock)).toBe(STRUCT_SIZES.EventDetailBlock);
  });

  it('open: by serial, every acceptor inhibited, then EnableInterface; a failure code is translated', () => {
    const f = fakeLib();
    const s = new PaylinkSession(f.lib, 'AE000002');
    expect(s.open()).toEqual({ ok: true });
    expect(f.calls.slice(0, 3)).toEqual([`OpenSpecificMHEVersion(AE000002,${INTERFACE_VERSION})`, 'WriteAcceptorDetails(0)', 'EnableInterface']);
    expect(f.acceptors[0].Status & ACCEPTOR_INHIBIT).toBe(ACCEPTOR_INHIBIT);
    const g = fakeLib();
    g.setOpen(31);
    expect(new PaylinkSession(g.lib, '').open()).toEqual({ ok: false, code: 31, message: 'דרייבר המזומן (Paylink.exe) לא רץ', retry: true });
  });

  it('read: blocks to a snapshot (classes, switches, events, firmware)', () => {
    const f = fakeLib();
    const s = new PaylinkSession(f.lib, '');
    s.open();
    const { snapshot, events } = s.read();
    expect(snapshot.currentValueAgorot).toBe(12345);
    expect(snapshot.acceptors[0]).toMatchObject({ kind: 'coin', bus: 'cctalk', serial: 77, description: 'SR5', currency: 'ILS' });
    expect(snapshot.acceptors[0].coins.map((c) => [c.valueAgorot, c.name])).toEqual([
      [100, 'ILS100'],
      [500, 'ILS500'],
    ]);
    expect(snapshot.dispensers[0]).toMatchObject({ cls: 'hopper', valueAgorot: 100, coinCountStatus: 2 });
    expect(snapshot.switches.find((x) => x.n === 1)).toEqual({ n: 1, opens: 1, closes: 2 });
    expect(snapshot.serial).toBe('4242');
    expect(events).toHaveLength(1);
    expect(events[0].code).toBe(0x106);
  });

  it('commands: read → change → write back; precise pay; dumps', () => {
    const f = fakeLib();
    const s = new PaylinkSession(f.lib, '');
    s.open();
    s.command({ op: 'acceptance', acceptors: [{ index: 0, inhibit: false, coins: [{ index: 0, inhibit: false }, { index: 1, inhibit: true }] }] });
    expect(f.acceptors[0].Status & ACCEPTOR_INHIBIT).toBe(0);
    expect([f.acceptors[0].Coin[0].Inhibit, f.acceptors[0].Coin[1].Inhibit]).toEqual([0, 1]);
    // The opaque char* members go back as they came.
    expect(f.acceptors[0].Description).toEqual({ ptr: 'SR5' });
    expect(s.command({ op: 'pay_specific', items: [{ dispenser: 0, quantity: 3, valueAgorot: 100 }] })).toEqual({ ok: true, value: 300 });
    s.command({ op: 'dispenser', index: 0, status: DISPENSER_CASHBOX_DUMP });
    expect(f.calls).toContain(`WriteDispenserDetails(0,${DISPENSER_CASHBOX_DUMP},0)`);
    expect(s.command({ op: 'watchdog', sequence: 17, timeoutMs: 2500 })).toEqual({ ok: true, value: 17 });
  });

  it('the device proxy talks to the worker; a dead worker is a failed read', async () => {
    const f = fakeLib();
    const handle = createWorkerHandler(() => f.lib);
    let exit: ((c: number | null) => void) | null = null;
    let onMsg: ((m: WorkerReply) => void) | null = null;
    const link: WorkerLink = {
      post: (m: WorkerRequest) => setTimeout(() => onMsg?.(handle(m)), 1),
      onMessage: (fn) => (onMsg = fn),
      onExit: (fn) => (exit = fn),
      kill: () => exit?.(0),
    };
    const dev = new PaylinkDevice(() => link, { dllPath: () => 'C:\\x\\AESImhei64.dll', serial: '' });
    expect(await dev.open()).toEqual({ ok: true });
    expect((await dev.read()).snapshot.currentPaidAgorot).toBe(600);
    expect(await dev.command({ op: 'pay_out', valueAgorot: 250 })).toEqual({ ok: true });
    expect(f.calls).toContain('PayOut(250)');
    expect(await dev.driverStatus()).toBe(STANDARD_DRIVER);
    const noDll = new PaylinkDevice(() => link, { dllPath: () => null, serial: '' });
    expect((await noDll.open()).ok).toBe(false);
  });
});

describe('the driver program', () => {
  const base = { installed: true, running: true, status: STANDARD_DRIVER, openError: null };

  it('missing → nothing to do; not running → start (once per 15 s); running fine → ok', () => {
    expect(decideDriver({ ...base, now: 0, installed: false }, EMPTY_DRIVER_MEMORY).action).toEqual({ kind: 'none', state: 'missing' });
    const a = decideDriver({ ...base, now: 1_000, running: false }, EMPTY_DRIVER_MEMORY);
    expect(a.action.kind).toBe('start');
    expect(decideDriver({ ...base, now: 5_000, running: false }, a.memory).action).toEqual({ kind: 'none', state: 'settling' });
    expect(decideDriver({ ...base, now: 50_000 }, a.memory).action).toEqual({ kind: 'none', state: 'ok' });
  });

  it('a USB error for 20 s → USBDriverExit, then a start (or a kill when it does not exit)', () => {
    let m = { ...EMPTY_DRIVER_MEMORY };
    let r = decideDriver({ ...base, now: 100_000, status: USB_ERROR }, m);
    expect(r.action).toEqual({ kind: 'none', state: 'waiting' });
    m = r.memory;
    r = decideDriver({ ...base, now: 100_000 + BAD_FOR_MS + 1, status: USB_ERROR }, m);
    expect(r.action.kind).toBe('request_exit');
    m = r.memory;
    r = decideDriver({ ...base, now: 100_000 + BAD_FOR_MS + 2_000, status: USB_IDLE }, m);
    expect(r.action.kind).toBe('start');
    // Another bad spell, the program does not go: ended by force.
    let m2: DriverMemory = { ...EMPTY_DRIVER_MEMORY, exitRequestedAt: 0 };
    expect(decideDriver({ ...base, now: EXIT_GRACE_MS + 1, status: USB_ERROR }, m2).action.kind).toBe('kill');
    m2 = { ...EMPTY_DRIVER_MEMORY };
    // Never under the firmware tool.
    expect(decideDriver({ ...base, now: 1e6, status: FLASH_LOADER }, m2).action).toEqual({ kind: 'none', state: 'tool' });
  });

  it('the command line and where the files are looked for', () => {
    expect(driverArgs({ serial: 'AE000002', logFile: 'C:\\d\\p.log' })).toEqual(['/H', '/L', 'C:\\d\\p.log', '/Z', '1024', '/S', 'AE000002']);
    expect(driverArgs({ serial: '', logFile: null })).toEqual(['/H']);
    expect(driverCandidates({ driverPath: 'D:\\Vendor', programFiles: ['C:\\PF'] })[0]).toBe('D:\\Vendor\\Paylink.exe');
    expect(dllCandidates({ dllPath: '', driverExe: 'C:\\PF\\Paylink\\Paylink.exe', windowsDir: 'C:\\Windows', programFiles: [] }).slice(0, 2)).toEqual(['C:\\PF\\Paylink\\AESImhei64.dll', 'C:\\Windows\\System\\AESImhei64.dll']);
  });

  it('the supervisor starts a missing driver with its serial and a log file', async () => {
    const started: Array<{ exe: string; args: string[] }> = [];
    const p: DriverPlatform = {
      exists: (f) => f === 'C:\\PF\\Aardvark\\Paylink\\Paylink.exe' || f === 'C:\\PF\\Aardvark\\Paylink\\AESImhei64.dll',
      processes: async () => [],
      start: (exe, args) => void started.push({ exe, args }),
      kill: async () => undefined,
    };
    const d = new PaylinkDriver(p, { serial: 'AE000002', driverPath: '', dllPath: '', logDir: path.join(os.tmpdir(), 'r2m-paylink-test-logs'), now: () => 1_000, log: () => undefined, programFiles: ['C:\\PF'], windowsDir: 'C:\\Windows' });
    expect(d.installed()).toBe(true);
    expect(d.dllPath).toBe('C:\\PF\\Aardvark\\Paylink\\AESImhei64.dll');
    await d.step({ status: null, openError: 31 }, async () => undefined);
    expect(started).toHaveLength(1);
    expect(started[0].args).toContain('/S');
    expect(started[0].args).toContain('AE000002');
  });
});
