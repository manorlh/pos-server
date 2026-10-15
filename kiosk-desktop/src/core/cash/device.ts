/**
 * The cash device as the cash host sees it — one shape for the real PayLink (main/cash/paylink*.ts,
 * the vendor DLL through koffi in a utility process) and for the in-memory simulator
 * (main/cash/simulator.ts, the tests and the "simulator" setting).
 *
 * The shape is PayLink's own model, deliberately: lifetime counters that never go back
 * (`currentValue` = all money ever accepted, `currentPaid` = all money ever paid out, per-coin
 * `count`s, per-dispenser `count`s) read as snapshots; the host keeps the starting values of a
 * transaction in its journal before every command and works out what happened from the
 * differences — so nothing is lost to a slow poll, a crash or a power cut.
 *
 * Pure types: no Node, no FFI.
 */

import type { BusName, DispenserClass } from './paylinkApi';

export interface CoinSnap {
  /** Index in the acceptor's coin array. */
  index: number;
  valueAgorot: number;
  /** Set by the host: this coin / note is refused. */
  inhibit: boolean;
  /** Lifetime count accepted. */
  count: number;
  /** Routing: the dispenser address / path this coin goes to (0 = the cashbox). */
  path: number;
  /** Lifetime count sent down `path`. */
  pathCount: number;
  pathSwitchLevel: number;
  defaultPath: number;
  /** How many of it sit in (single-note) escrow now. */
  heldInEscrow: number;
  name: string;
}

export interface AcceptorSnap {
  index: number;
  unit: number;
  kind: 'coin' | 'note';
  bus: BusName;
  /** ACCEPTOR_* bits (paylinkApi.ts); 0 = fine. */
  status: number;
  /** The host's ACCEPTOR_INHIBIT is set. */
  inhibited: boolean;
  interfaceNumber: number;
  address: number;
  currency: string;
  serial: number;
  description: string;
  coins: CoinSnap[];
}

export interface DispenserSnap {
  index: number;
  unit: number;
  cls: DispenserClass;
  bus: BusName;
  /** The result of the last payout attempt (PAY_*), or a written / acknowledged DISPENSER_* value. */
  status: number;
  interfaceNumber: number;
  address: number;
  valueAgorot: number;
  /** Lifetime count paid out (kept over power cuts by the units that can). */
  count: number;
  inhibit: boolean;
  notesToDump: number;
  /** Coins / notes inside, when the unit reports it (see coinCountStatus). */
  coinCount: number;
  /** DISPENSER_COIN_* level (0..3) or DISPENSER_ACCURATE(_FULL) (−1 / −2). */
  coinCountStatus: number;
  serial: number;
  description: string;
}

export interface EscrowNoteSnap {
  valueAgorot: number;
  noteNumber: number;
  location: number;
  status: number;
}

/** An extended-escrow system (a note recycler's escrow unit, PayLink 1.12.6). */
export interface EscrowBlockSnap {
  index: number;
  version: number;
  state: number;
  result: number;
  totalValueAgorot: number;
  valueReturnedAgorot: number;
  acceptorNo: number;
  notes: EscrowNoteSnap[];
}

export interface SwitchSnap {
  n: number;
  opens: number;
  closes: number;
}

export interface DeviceSnapshot {
  /** Epoch ms of the read. */
  at: number;
  /** OpenMHE succeeded and the interface is enabled. */
  open: boolean;
  /** PayLink's electronic serial (as text; null when not set / unsupported). */
  serial: string | null;
  firmware: number | null;
  /** USBDriverStatus (paylinkApi.ts USB_*); null when unknown. */
  driver: number | null;
  /** DESStatus (DES_*); null when unknown. */
  des: number | null;
  /** CurrentUpdates — a change means "look again". */
  updates: number;
  currentValueAgorot: number;
  currentPaidAgorot: number;
  /** LastPayStatus (PAY_*). */
  lastPayStatus: number;
  /** EscrowThroughput (single-note escrow; not kept over a reset); null while escrow is off. */
  escrowThroughputAgorot: number | null;
  acceptors: AcceptorSnap[];
  dispensers: DispenserSnap[];
  escrows: EscrowBlockSnap[];
  switches: SwitchSnap[];
  /** IMHEIConsistencyError: null = consistent. */
  consistencyError: string | null;
  /** CheckOperation's last answer (−1: unsupported). */
  watchdogSeq: number | null;
}

export interface DeviceEvent {
  at: number;
  code: number;
  raw: number;
  dispenser: boolean;
  index: number;
}

/**
 * What the host may ask of the device. Every write is the API's own (WriteAcceptorDetails /
 * WriteDispenserDetails / PayOut / …): read, change, write back.
 */
export type DeviceCommand =
  | { op: 'enable_interface' }
  | { op: 'disable_interface' }
  /** Per-acceptor inhibit and per-coin inhibits (absent = unchanged). */
  | { op: 'acceptance'; acceptors: Array<{ index: number; inhibit: boolean; coins?: Array<{ index: number; inhibit: boolean }> }> }
  /** Coin / bill routing (AcceptorCoin.Path; coin acceptors also DefaultPath / PathSwitchLevel). */
  | { op: 'route'; acceptor: number; coin: number; path: number; defaultPath?: number; pathSwitchLevel?: number }
  | { op: 'pay_out'; valueAgorot: number }
  /** SetDispenseQuantity per dispenser, then PaySpecific (1.12.6). */
  | { op: 'pay_specific'; items: Array<{ dispenser: number; quantity: number; valueAgorot: number }> }
  /**
   * A dispenser write: inhibit (also abandons a payout in progress on it / delivers bills held after a
   * power cut when cleared), a status (DISPENSER_CASHBOX_DUMP / PARTIAL_DUMP with notesToDump /
   * UPDATE_COUNT with coinCount / RESET_STATUS / REASSIGN_VALUE with valueAgorot).
   */
  | { op: 'dispenser'; index: number; inhibit?: boolean; status?: number; notesToDump?: number; coinCount?: number; valueAgorot?: number }
  | { op: 'escrow'; action: 'enable' | 'disable' | 'accept' | 'return' }
  | { op: 'ext_escrow'; unit: number; command: number }
  | { op: 'indicator'; n: number; on: boolean }
  | { op: 'watchdog'; sequence: number; timeoutMs: number };

export type CommandResult = { ok: true; value?: number } | { ok: false; error: string };

export type OpenResult = { ok: true } | { ok: false; code: number | null; message: string; retry: boolean };

export interface CashDevice {
  readonly kind: 'paylink' | 'simulator';
  /** Opens the interface (OpenMHE, baseline read, EnableInterface with every acceptor inhibited). */
  open(): Promise<OpenResult>;
  close(): Promise<void>;
  /** A fresh read of everything (and the events queued since the last one). */
  read(): Promise<{ snapshot: DeviceSnapshot; events: DeviceEvent[] }>;
  command(c: DeviceCommand): Promise<CommandResult>;
}
