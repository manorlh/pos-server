/**
 * What the PayLink utility process does with the DLL (paylinkFfi.ts), as plain functions over a
 * `PaylinkLib` — so the same code runs under the real DLL and under a test double:
 *
 *  - open: OpenMHE / OpenSpecificMHE (the unit's USB serial, §12) — with the System Manual's check
 *    that a driver really runs (a stale shared segment answers 0 with none: USBDriverStatus must
 *    be STANDARD_DRIVER); every acceptor inhibited, then EnableInterface;
 *  - read: the whole state (counters, every acceptor / dispenser / escrow block, switches, events)
 *    as one DeviceSnapshot;
 *  - command: read → change → write back, as the API expects for every control.
 */

import type { AcceptorSnap, CommandResult, DeviceCommand, DeviceEvent, DeviceSnapshot, DispenserSnap, EscrowBlockSnap, OpenResult } from '../../core/cash/device';
import {
  ACCEPTOR_INHIBIT,
  busOf,
  dispenserClass,
  EXT_ESCROW_NONE,
  INTERFACE_VERSION,
  isNoteAcceptor,
  MAX_ACCEPTOR_COINS,
  MAX_DISPENSERS,
  MAX_ESCROW,
  OPEN_ERRORS,
  STANDARD_COIN_TIME,
  STANDARD_DRIVER,
  STANDARD_NOTE_TIME,
} from '../../core/cash/paylinkApi';
import type { AcceptorBlockJs, PaylinkLib } from './paylinkFfi';

/** How many switch inputs are read (Standard PayLink: 16; Lite: 4 — the rest just read 0). */
const SWITCHES = 16;
const MAX_ACCEPTORS = 32;
const MAX_ESCROW_BLOCKS = 4;
const MAX_EVENTS_PER_READ = 64;

export class PaylinkSession {
  private opened = false;
  private escrowOn = false;
  private serialText: string | null = null;

  constructor(
    private readonly lib: PaylinkLib,
    private readonly serial: string,
    private readonly now: () => number = Date.now,
  ) {}

  open(): OpenResult {
    const code = this.serial ? this.lib.OpenSpecificMHEVersion(this.serial, INTERFACE_VERSION) : this.lib.OpenMHEVersion(INTERFACE_VERSION);
    if (code !== 0) {
      const known = OPEN_ERRORS[code];
      return { ok: false, code, message: known?.text ?? `OpenMHE ${code}`, retry: known?.retry ?? true };
    }
    // The manual: OpenMHE may answer 0 from a stale segment with no driver behind it.
    const driver = this.lib.USBDriverStatus();
    if (driver !== STANDARD_DRIVER && driver !== -1) return { ok: false, code: 31, message: `USBDriverStatus ${driver}`, retry: true };
    // Closed to money before the interface is enabled (the counters are read by the host first).
    for (let i = 0; i < MAX_ACCEPTORS; i++) {
      const b = this.lib.ReadAcceptorDetails(i);
      if (!b) break;
      b.Status |= ACCEPTOR_INHIBIT;
      this.lib.WriteAcceptorDetails(i, b);
    }
    this.lib.EnableInterface();
    this.opened = true;
    const sn = this.lib.SerialNumber();
    this.serialText = sn === -1 || sn === 0 ? null : String(sn >>> 0);
    return { ok: true };
  }

  close() {
    if (!this.opened) return;
    try {
      this.lib.DisableInterface();
    } finally {
      this.opened = false;
    }
  }

  private acceptor(i: number, b: AcceptorBlockJs): AcceptorSnap {
    const n = Math.min(MAX_ACCEPTOR_COINS, Math.max(0, b.NoOfCoins));
    const currency = typeof b.Currency === 'string' ? b.Currency : String.fromCharCode(...(b.Currency ?? []).filter((c) => c > 0));
    return {
      index: i,
      unit: b.Unit >>> 0,
      kind: isNoteAcceptor(b.Unit) ? 'note' : 'coin',
      bus: busOf(b.Unit),
      status: b.Status,
      inhibited: (b.Status & ACCEPTOR_INHIBIT) !== 0,
      interfaceNumber: b.InterfaceNumber,
      address: b.UnitAddress,
      currency: currency.replace(/\0/g, ''),
      serial: b.SerialNumber,
      description: this.lib.text(b.Description),
      coins: b.Coin.slice(0, n).map((c, ci) => ({
        index: ci,
        valueAgorot: c.Value,
        inhibit: c.Inhibit !== 0,
        count: c.Count,
        path: c.Path,
        pathCount: c.PathCount,
        pathSwitchLevel: c.PathSwitchLevel,
        defaultPath: c.DefaultPath,
        heldInEscrow: c.HeldInEscrow,
        name: this.lib.text(c.CoinName),
      })),
    };
  }

  read(): { snapshot: DeviceSnapshot; events: DeviceEvent[] } {
    const L = this.lib;
    const acceptors: AcceptorSnap[] = [];
    for (let i = 0; i < MAX_ACCEPTORS; i++) {
      const b = L.ReadAcceptorDetails(i);
      if (!b) break;
      acceptors.push(this.acceptor(i, b));
    }
    const dispensers: DispenserSnap[] = [];
    for (let i = 0; i < MAX_DISPENSERS * 4; i++) {
      const d = L.ReadDispenserDetails(i);
      if (!d) break;
      dispensers.push({
        index: i,
        unit: d.Unit >>> 0,
        cls: dispenserClass(d.Unit),
        bus: busOf(d.Unit),
        status: d.Status,
        interfaceNumber: d.InterfaceNumber,
        address: d.UnitAddress,
        valueAgorot: d.Value,
        count: d.Count,
        inhibit: d.Inhibit !== 0,
        notesToDump: d.NotesToDump,
        coinCount: d.CoinCount,
        coinCountStatus: d.CoinCountStatus,
        serial: d.SerialNumber,
        description: L.text(d.Description),
      });
    }
    const escrows: EscrowBlockSnap[] = [];
    for (let i = 0; i < MAX_ESCROW_BLOCKS; i++) {
      const e = L.ReadEscrowBlock(i);
      if (!e) break;
      if (e.State === EXT_ESCROW_NONE) continue;
      escrows.push({
        index: i,
        version: e.EscrowVersion,
        state: e.State,
        result: e.Result,
        totalValueAgorot: e.TotalValue,
        valueReturnedAgorot: e.ValueReturned,
        acceptorNo: e.AcceptorNo,
        notes: e.EscrowNote.slice(0, Math.min(MAX_ESCROW, Math.max(0, e.NoInEscrow))).map((n) => ({ valueAgorot: n.Value, noteNumber: n.NoteNumber, location: n.Location, status: n.Status })),
      });
    }
    const events: DeviceEvent[] = [];
    for (let i = 0; i < MAX_EVENTS_PER_READ; i++) {
      const ev = L.NextEvent();
      if (!ev) break;
      events.push({ at: this.now(), code: ev.EventCode, raw: ev.RawEvent, dispenser: ev.DispenserEvent !== 0, index: ev.Index });
    }
    const switches = [];
    for (let n = 0; n < SWITCHES; n++) switches.push({ n, opens: L.SwitchOpens(n), closes: L.SwitchCloses(n) });
    const snapshot: DeviceSnapshot = {
      at: this.now(),
      open: this.opened,
      serial: this.serialText,
      firmware: L.FirmwareVersion(),
      driver: L.USBDriverStatus(),
      des: L.DESStatus(),
      updates: L.CurrentUpdates(),
      currentValueAgorot: L.CurrentValue(),
      currentPaidAgorot: L.CurrentPaid(),
      lastPayStatus: L.LastPayStatus(),
      escrowThroughputAgorot: this.escrowOn ? L.EscrowThroughput() : null,
      acceptors,
      dispensers,
      escrows,
      switches,
      consistencyError: L.IMHEIConsistencyError(STANDARD_COIN_TIME, STANDARD_NOTE_TIME),
      watchdogSeq: null,
    };
    return { snapshot, events };
  }

  command(c: DeviceCommand): CommandResult {
    const L = this.lib;
    switch (c.op) {
      case 'enable_interface':
        L.EnableInterface();
        return { ok: true };
      case 'disable_interface':
        L.DisableInterface();
        return { ok: true };
      case 'acceptance':
        for (const a of c.acceptors) {
          const b = L.ReadAcceptorDetails(a.index);
          if (!b) continue;
          b.Status = a.inhibit ? b.Status | ACCEPTOR_INHIBIT : b.Status & ~ACCEPTOR_INHIBIT;
          for (const x of a.coins ?? []) if (b.Coin[x.index]) b.Coin[x.index].Inhibit = x.inhibit ? 1 : 0;
          L.WriteAcceptorDetails(a.index, b);
        }
        return { ok: true };
      case 'route': {
        const b = L.ReadAcceptorDetails(c.acceptor);
        if (!b || !b.Coin[c.coin]) return { ok: false, error: 'no such coin' };
        b.Coin[c.coin].Path = c.path;
        if (c.defaultPath !== undefined) b.Coin[c.coin].DefaultPath = c.defaultPath;
        if (c.pathSwitchLevel !== undefined) b.Coin[c.coin].PathSwitchLevel = c.pathSwitchLevel;
        L.WriteAcceptorDetails(c.acceptor, b);
        return { ok: true };
      }
      case 'pay_out':
        L.PayOut(c.valueAgorot);
        return { ok: true };
      case 'pay_specific': {
        for (const it of c.items) if (L.SetDispenseQuantity(it.dispenser, it.quantity, it.valueAgorot) === 0) return { ok: false, error: `SetDispenseQuantity refused for dispenser ${it.dispenser}` };
        return { ok: true, value: L.PaySpecific() };
      }
      case 'dispenser': {
        const d = L.ReadDispenserDetails(c.index);
        if (!d) return { ok: false, error: 'no such dispenser' };
        if (c.inhibit !== undefined) d.Inhibit = c.inhibit ? 1 : 0;
        if (c.notesToDump !== undefined) d.NotesToDump = c.notesToDump;
        if (c.coinCount !== undefined) d.CoinCount = c.coinCount;
        if (c.valueAgorot !== undefined) d.Value = c.valueAgorot;
        if (c.status !== undefined) d.Status = c.status;
        L.WriteDispenserDetails(c.index, d);
        return { ok: true };
      }
      case 'escrow':
        if (c.action === 'enable') {
          L.EscrowEnable();
          this.escrowOn = true;
        } else if (c.action === 'disable') {
          L.EscrowDisable();
          this.escrowOn = false;
        } else if (c.action === 'accept') L.EscrowAccept();
        else L.EscrowReturn();
        return { ok: true };
      case 'ext_escrow':
        L.EscrowCommand(c.unit, c.command);
        return { ok: true };
      case 'indicator':
        if (c.on) L.IndicatorOn(c.n);
        else L.IndicatorOff(c.n);
        return { ok: true };
      case 'watchdog':
        return { ok: true, value: L.CheckOperation(c.sequence, c.timeoutMs) };
    }
  }

  driverStatus(): number {
    return this.lib.USBDriverStatus();
  }

  driverExit() {
    this.lib.USBDriverExit();
  }
}

/* ------------------------------------------------------------------ the utility process's protocol */

export type WorkerRequest =
  | { id: number; op: 'load'; dllPath: string; serial: string }
  | { id: number; op: 'open' }
  | { id: number; op: 'read' }
  | { id: number; op: 'command'; command: DeviceCommand }
  | { id: number; op: 'driver_status' }
  | { id: number; op: 'driver_exit' }
  | { id: number; op: 'close' };

export type WorkerReply = { id: number; ok: true; value: unknown } | { id: number; ok: false; error: string };

/** The worker's message handler, over a DLL loader (the real one in paylinkWorker.ts, a double in tests). */
export function createWorkerHandler(load: (dllPath: string) => PaylinkLib, now: () => number = Date.now) {
  let lib: PaylinkLib | null = null;
  let session: PaylinkSession | null = null;
  return (req: WorkerRequest): WorkerReply => {
    try {
      switch (req.op) {
        case 'load':
          lib = load(req.dllPath);
          session = new PaylinkSession(lib, req.serial, now);
          return { id: req.id, ok: true, value: null };
        case 'open':
          if (!session) return { id: req.id, ok: false, error: 'not loaded' };
          return { id: req.id, ok: true, value: session.open() };
        case 'read':
          if (!session) return { id: req.id, ok: false, error: 'not loaded' };
          return { id: req.id, ok: true, value: session.read() };
        case 'command':
          if (!session) return { id: req.id, ok: false, error: 'not loaded' };
          return { id: req.id, ok: true, value: session.command(req.command) };
        case 'driver_status':
          return { id: req.id, ok: true, value: lib ? lib.USBDriverStatus() : null };
        case 'driver_exit':
          lib?.USBDriverExit();
          return { id: req.id, ok: true, value: null };
        case 'close':
          session?.close();
          return { id: req.id, ok: true, value: null };
      }
    } catch (e) {
      return { id: req.id, ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  };
}
