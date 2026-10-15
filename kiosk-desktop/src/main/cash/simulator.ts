/**
 * The in-memory cash device: PayLink's model played in memory, for the tests and for the cash
 * host's "simulator" setting (`cashSimulator`, a station run with no hardware). It is built to
 * behave as the manuals describe each device family, so the host's code is exercised the way the
 * real unit would exercise it:
 *
 *  - lifetime counters that never go back (CurrentValue / CurrentPaid / coin Count / dispenser
 *    Count), kept over a "power cut" (`powerCut()`), EscrowThroughput lost by it;
 *  - coin acceptors and note acceptors, per-coin and per-acceptor inhibit, coin routing
 *    (Path / DefaultPath / PathSwitchLevel → a hopper until full, then the cashbox);
 *  - single-note escrow (EscrowEnable / Accept / Return) and a recycler's extended escrow (START /
 *    ACCEPT / PAUSE / STACK / RETURN, the return paying the same notes back);
 *  - ccTalk hoppers with accurate counts or level sensors only (LOW / MID / HIGH, CoinCount 0);
 *    Innovative SmartHopper (a dispenser per denomination + the "total" one for the full dump);
 *    MDB changers (level 2 tubes pre-inhibited + the level 3 payout); note recyclers on ccTalk /
 *    ID-003 / MDB / CCNet / EBDS (bills presented and taken, abandoned when inhibited, dumps,
 *    DISPENSER_UPDATE_COUNT on ID-003 only, no dumps on MDB);
 *  - PayOut (descending values, falling over when a unit is empty or jams) and PaySpecific;
 *    payouts progress one piece per read, so a test sees PAY_ONGOING;
 *  - the CheckOperation watchdog (acceptance stops silently when it lapses), switches and lamps,
 *    the event queue, DES status, the driver's status and a consistency error on demand.
 */

import type { CashDevice, CommandResult, DeviceCommand, DeviceEvent, DeviceSnapshot, DispenserSnap, OpenResult, AcceptorSnap, EscrowBlockSnap } from '../../core/cash/device';
import {
  ACCEPTOR_INHIBIT,
  COIN_DISPENSER_EVENT,
  COIN_EVENT,
  DES_NOT,
  DISPENSER_ACCURATE,
  DISPENSER_ACCURATE_FULL,
  DISPENSER_CASHBOX_DUMP,
  DISPENSER_COIN_HIGH,
  DISPENSER_COIN_LOW,
  DISPENSER_COIN_MID,
  DISPENSER_COUNT_UPDATED,
  DISPENSER_DUMP_FINISHED,
  DISPENSER_PARTIAL_DUMP,
  DISPENSER_RESET_STATUS,
  DISPENSER_UPDATE_COUNT,
  DP_CC_GHOST_HOPPER,
  DP_CCTALK_INTERFACE,
  DP_COIN_ACCEPT_DEVICE,
  DP_COIN_PAYOUT_DEVICE,
  DP_EBDS_INTERFACE,
  DP_CCNET_INTERFACE,
  DP_JCM_INTERFACE,
  DP_MDB_INTERFACE,
  DP_MDB_LEVEL_2_TUBE,
  DP_MDB_TYPE_3_PAYOUT,
  DP_NOTE_ACCEPT_DEVICE,
  DP_NOTE_PAYOUT_DEVICE,
  DP_SHOPPER,
  DP_SHOPPER_TOTAL,
  EV,
  EXT_ESCROW_ACCEPT,
  EXT_ESCROW_BUSY,
  EXT_ESCROW_COMPLETE,
  EXT_ESCROW_IDLE,
  EXT_ESCROW_LOADING,
  EXT_ESCROW_OFF,
  EXT_ESCROW_PAUSE,
  EXT_ESCROW_PAUSED,
  EXT_ESCROW_POWER_ACTIVE,
  EXT_ESCROW_RETURN,
  EXT_ESCROW_RETURNED_OK,
  EXT_ESCROW_RETURNING,
  EXT_ESCROW_STACK,
  EXT_ESCROW_STACKED_OK,
  EXT_ESCROW_STACKING,
  EXT_ESCROW_START,
  EXT_ESCROW_STOP,
  EXT_ESCROW_STORED,
  EXT_ESCROW_WAITING,
  EXT_ESCROW_WRONGSTATE,
  FAULT_BIT,
  NOTE_DISPENSER_EVENT,
  NOTE_EVENT,
  PAY_EMPTY,
  PAY_FINISHED,
  PAY_JAMMED,
  PAY_NO_HOPPER,
  PAY_ONGOING,
  STANDARD_DRIVER,
  busOf,
  dispenserClass,
  type BusName,
} from '../../core/cash/paylinkApi';

export type SimBus = 'cctalk' | 'id003' | 'mdb' | 'ccnet' | 'ebds';

export interface SimConfig {
  serial?: string;
  /** "V4-1-12-6" as a number (4.1.12.6). */
  firmware?: number;
  coins?: number[] | null;
  notes?: { values: number[]; bus?: SimBus; escrow?: boolean } | null;
  /** Coin hoppers fed by the coin acceptor (route to it until full when `fed`). */
  hoppers?: Array<{ valueAgorot: number; count: number; levelOnly?: boolean; lowAt?: number; highAt?: number; capacity?: number; fed?: boolean }>;
  /** An Innovative SmartHopper with its own acceptor path: every coin of its denominations is recycled. */
  smartHopper?: { denominations: Array<{ valueAgorot: number; count: number }>; capacity?: number } | null;
  /** An MDB coin changer: the coin acceptor is the changer; tubes recycle their coins. */
  mdbChanger?: { tubes: Array<{ valueAgorot: number; count: number; capacity?: number }> } | null;
  /** A note recycler: the note acceptor routes these denominations into its units. */
  noteRecycler?: { units: Array<{ valueAgorot: number; count: number; capacity?: number }>; extendedEscrow?: boolean } | null;
  /** The customer takes a presented bill at once (else `takeBill()`). */
  autoTakeBills?: boolean;
  watchdogSupported?: boolean;
  des?: number;
  /** Pieces paid per read (payout speed). */
  piecesPerRead?: number;
}

interface SimCoin {
  valueAgorot: number;
  inhibit: boolean;
  count: number;
  path: number;
  pathCount: number;
  pathSwitchLevel: number;
  defaultPath: number;
  heldInEscrow: number;
  name: string;
}

interface SimAcceptor {
  unit: number;
  kind: 'coin' | 'note';
  status: number;
  address: number;
  serial: number;
  coins: SimCoin[];
  escrowCapable: boolean;
}

interface SimDispenser {
  unit: number;
  address: number;
  valueAgorot: number;
  status: number;
  count: number;
  inhibit: boolean;
  notesToDump: number;
  /** The real number inside (the simulator's truth). */
  inside: number;
  capacity: number;
  levelOnly: boolean;
  lowAt: number;
  highAt: number;
  serial: number;
  jammed: boolean;
  /** Reported coin count (accurate units) — may be "set" by UPDATE_COUNT. */
  reportedOffset: number;
}

interface PayoutJob {
  /** Remaining pieces per dispenser index (PaySpecific) or a value to make (PayOut). */
  specific: Map<number, number> | null;
  leftAgorot: number;
  tried: Set<number>;
  failStatus: number | null;
  /** A bill presented, waiting to be taken. */
  presented: { dispenser: number; valueAgorot: number; at: number } | null;
}

const FIRMWARE_4_1_12_6 = (4 << 24) | (1 << 16) | (12 << 8) | 6;

function busCode(bus: SimBus): number {
  return bus === 'id003' ? DP_JCM_INTERFACE : bus === 'mdb' ? DP_MDB_INTERFACE : bus === 'ccnet' ? DP_CCNET_INTERFACE : bus === 'ebds' ? DP_EBDS_INTERFACE : DP_CCTALK_INTERFACE;
}

export class SimulatedPaylink implements CashDevice {
  readonly kind = 'simulator' as const;
  private acceptors: SimAcceptor[] = [];
  private dispensers: SimDispenser[] = [];
  private currentValue = 0;
  private currentPaid = 0;
  private lastPayStatus = PAY_FINISHED;
  private updates = 0;
  private opened = false;
  private interfaceEnabled = false;
  private escrowEnabled = false;
  private escrowThroughput = 0;
  private escrowHeld: { acceptor: number; coin: number } | null = null;
  private ext: { state: number; result: number; notes: Array<{ valueAgorot: number; coin: number; location: number; status: number }>; returned: number } | null = null;
  private extUnit = 0;
  private job: PayoutJob | null = null;
  private events: DeviceEvent[] = [];
  private switches = new Map<number, { opens: number; closes: number }>();
  readonly lamps = new Map<number, boolean>();
  private watchdog: { seq: number; timeoutMs: number; at: number } | null = null;
  private now: () => number;
  /** Test knobs. */
  driver = STANDARD_DRIVER;
  des: number;
  consistencyError: string | null = null;
  openFails: { code: number; message: string; retry: boolean } | null = null;
  readonly cfg: SimConfig;
  /** Every command the host sent, in order (tests read it). */
  readonly commands: DeviceCommand[] = [];

  constructor(cfg: SimConfig = {}, now: () => number = Date.now) {
    this.cfg = cfg;
    this.now = now;
    this.des = cfg.des ?? DES_NOT;
    this.build();
  }

  /* ------------------------------------------------------------ building */

  private build() {
    const cfg = this.cfg;
    let addr = 1;
    const coinValues = new Set<number>(cfg.coins ?? [10, 50, 100, 200, 500, 1000]);
    for (const t of cfg.mdbChanger?.tubes ?? []) coinValues.add(t.valueAgorot);
    for (const d of cfg.smartHopper?.denominations ?? []) coinValues.add(d.valueAgorot);
    const coinBus = cfg.mdbChanger ? DP_MDB_INTERFACE : DP_CCTALK_INTERFACE;
    if (coinValues.size > 0 && cfg.coins !== null) {
      this.acceptors.push({
        unit: (DP_COIN_ACCEPT_DEVICE | coinBus | 0x0100 | 3) >>> 0,
        kind: 'coin',
        status: ACCEPTOR_INHIBIT,
        address: 2,
        serial: 1001,
        coins: [...coinValues].sort((a, b) => a - b).map((v) => this.coin(v)),
        escrowCapable: false,
      });
    }
    if (cfg.notes) {
      const bus = cfg.notes.bus ?? 'id003';
      this.acceptors.push({
        unit: (DP_NOTE_ACCEPT_DEVICE | busCode(bus) | (cfg.noteRecycler ? 2 : 0)) >>> 0,
        kind: 'note',
        status: ACCEPTOR_INHIBIT,
        address: 40,
        serial: 2002,
        coins: [...cfg.notes.values].sort((a, b) => a - b).map((v) => this.coin(v)),
        escrowCapable: cfg.notes.escrow !== false,
      });
    }
    const coinAcc = this.acceptors.find((a) => a.kind === 'coin');
    for (const h of cfg.hoppers ?? []) {
      const d = this.dispenser(DP_COIN_PAYOUT_DEVICE | DP_CCTALK_INTERFACE | 0x0100 | 1, addr++, h.valueAgorot, h.count, { levelOnly: h.levelOnly, lowAt: h.lowAt, highAt: h.highAt, capacity: h.capacity });
      this.dispensers.push(d);
      const c = coinAcc?.coins.find((x) => x.valueAgorot === h.valueAgorot);
      if (c && h.fed) {
        // The manual's "route to a hopper until full, then the coin cashbox".
        c.path = d.address;
        c.defaultPath = 4;
        c.pathSwitchLevel = c.pathCount + Math.max(0, d.capacity - d.inside);
      }
    }
    if (cfg.smartHopper) {
      const total = this.dispenser(DP_SHOPPER_TOTAL, 7, 0, 0, {});
      total.reportedOffset = 0;
      this.dispensers.push(total);
      for (const s of cfg.smartHopper.denominations) {
        const d = this.dispenser(DP_SHOPPER, 7, s.valueAgorot, s.count, { capacity: cfg.smartHopper.capacity ?? 2000 });
        this.dispensers.push(d);
        const c = coinAcc?.coins.find((x) => x.valueAgorot === s.valueAgorot);
        if (c) c.path = 7;
      }
    }
    if (cfg.mdbChanger) {
      this.dispensers.push(this.dispenser(DP_MDB_TYPE_3_PAYOUT, 0, 1, 0, {}));
      let tube = 1;
      for (const t of cfg.mdbChanger.tubes) {
        const d = this.dispenser(DP_MDB_LEVEL_2_TUBE, tube, t.valueAgorot, t.count, { capacity: t.capacity ?? 100 });
        d.inhibit = true; // pre-set inhibited alongside the level 3 payout
        this.dispensers.push(d);
        const c = coinAcc?.coins.find((x) => x.valueAgorot === t.valueAgorot);
        if (c) c.path = tube;
        tube++;
      }
    }
    if (cfg.noteRecycler && cfg.notes) {
      const noteAcc = this.acceptors.find((a) => a.kind === 'note')!;
      const bus = cfg.notes.bus ?? 'id003';
      let unitAddr = 1;
      for (const u of cfg.noteRecycler.units) {
        const d = this.dispenser(DP_NOTE_PAYOUT_DEVICE | busCode(bus) | 2, 40 | unitAddr, u.valueAgorot, u.count, { capacity: u.capacity ?? 60 });
        this.dispensers.push(d);
        const c = noteAcc.coins.find((x) => x.valueAgorot === u.valueAgorot);
        if (c) c.path = unitAddr;
        unitAddr++;
      }
      if (cfg.noteRecycler.extendedEscrow) {
        this.ext = { state: EXT_ESCROW_OFF, result: EXT_ESCROW_COMPLETE, notes: [], returned: 0 };
        this.extUnit = 0;
      }
    }
  }

  private coin(v: number): SimCoin {
    return { valueAgorot: v, inhibit: true, count: 0, path: 0, pathCount: 0, pathSwitchLevel: 0, defaultPath: 0, heldInEscrow: 0, name: `ILS${v / 100}` };
  }

  private dispenser(unit: number, address: number, value: number, count: number, o: { levelOnly?: boolean; lowAt?: number; highAt?: number; capacity?: number }): SimDispenser {
    return {
      unit: unit >>> 0,
      address,
      valueAgorot: value,
      status: PAY_FINISHED,
      count: 0,
      inhibit: false,
      notesToDump: 0,
      inside: count,
      capacity: o.capacity ?? 1000,
      levelOnly: o.levelOnly === true,
      lowAt: o.lowAt ?? 20,
      highAt: o.highAt ?? 400,
      serial: 3000 + this.dispensers.length,
      jammed: false,
      reportedOffset: 0,
    };
  }

  /* ------------------------------------------------------------ CashDevice */

  async open(): Promise<OpenResult> {
    if (this.openFails) return { ok: false, code: this.openFails.code, message: this.openFails.message, retry: this.openFails.retry };
    if (this.driver !== STANDARD_DRIVER) return { ok: false, code: 31, message: 'driver not running', retry: true };
    this.opened = true;
    this.interfaceEnabled = true;
    this.bump();
    return { ok: true };
  }

  async close(): Promise<void> {
    this.opened = false;
    this.interfaceEnabled = false;
  }

  async read(): Promise<{ snapshot: DeviceSnapshot; events: DeviceEvent[] }> {
    this.progress();
    const events = this.events;
    this.events = [];
    return { snapshot: this.snapshot(), events };
  }

  async command(c: DeviceCommand): Promise<CommandResult> {
    this.commands.push(c);
    if (!this.opened && c.op !== 'watchdog') return { ok: false, error: 'not open' };
    switch (c.op) {
      case 'enable_interface':
        this.interfaceEnabled = true;
        break;
      case 'disable_interface':
        this.interfaceEnabled = false;
        break;
      case 'acceptance':
        for (const a of c.acceptors) {
          const acc = this.acceptors[a.index];
          if (!acc) continue;
          acc.status = a.inhibit ? acc.status | ACCEPTOR_INHIBIT : acc.status & ~ACCEPTOR_INHIBIT;
          for (const x of a.coins ?? []) if (acc.coins[x.index]) acc.coins[x.index].inhibit = x.inhibit;
        }
        break;
      case 'route': {
        const coin = this.acceptors[c.acceptor]?.coins[c.coin];
        if (!coin) return { ok: false, error: 'no such coin' };
        coin.path = c.path;
        if (c.defaultPath !== undefined) coin.defaultPath = c.defaultPath;
        if (c.pathSwitchLevel !== undefined) coin.pathSwitchLevel = c.pathSwitchLevel;
        break;
      }
      case 'pay_out':
        if (this.job) return { ok: false, error: 'payout in progress' };
        this.job = { specific: null, leftAgorot: c.valueAgorot, tried: new Set(), failStatus: null, presented: null };
        this.lastPayStatus = PAY_ONGOING;
        break;
      case 'pay_specific': {
        if (this.job) return { ok: false, error: 'payout in progress' };
        const m = new Map<number, number>();
        let total = 0;
        for (const it of c.items) {
          const d = this.dispensers[it.dispenser];
          if (!d || d.valueAgorot !== it.valueAgorot) return { ok: true, value: 0 };
          m.set(it.dispenser, (m.get(it.dispenser) ?? 0) + it.quantity);
          total += it.quantity * it.valueAgorot;
        }
        this.job = { specific: m, leftAgorot: total, tried: new Set(), failStatus: null, presented: null };
        this.lastPayStatus = PAY_ONGOING;
        return { ok: true, value: total };
      }
      case 'dispenser':
        return this.dispenserWrite(c);
      case 'escrow':
        this.escrowCmd(c.action);
        break;
      case 'ext_escrow':
        this.extCmd(c.command);
        break;
      case 'indicator':
        this.lamps.set(c.n, c.on);
        break;
      case 'watchdog':
        if (this.cfg.watchdogSupported === false) return { ok: true, value: -1 };
        this.watchdog = { seq: c.sequence, timeoutMs: c.timeoutMs, at: this.now() };
        return { ok: true, value: c.sequence };
    }
    this.bump();
    return { ok: true };
  }

  /* ------------------------------------------------------------ the customer and the world */

  /** Whether money can go in now (interface on, watchdog alive). */
  private accepting(): boolean {
    if (!this.opened || !this.interfaceEnabled) return false;
    if (this.watchdog && this.watchdog.timeoutMs > 0 && this.now() - this.watchdog.at > this.watchdog.timeoutMs) return false;
    return true;
  }

  /**
   * A coin / note put in. 'accepted' (credited), 'escrow' (held for the host's decision),
   * 'rejected' (inhibited, unknown, or the unit closed).
   */
  insert(valueAgorot: number): 'accepted' | 'escrow' | 'rejected' {
    const accIndex = this.acceptors.findIndex((a) => a.coins.some((c) => c.valueAgorot === valueAgorot) && (a.kind === 'note') === valueAgorot >= 2000);
    const acc = this.acceptors[accIndex];
    if (!acc) return 'rejected';
    const coinIndex = acc.coins.findIndex((c) => c.valueAgorot === valueAgorot);
    const coin = acc.coins[coinIndex];
    const extOn = acc.kind === 'note' && this.ext && (this.ext.state === EXT_ESCROW_WAITING || this.ext.state === EXT_ESCROW_LOADING);
    const inhibited = coin.inhibit || (!extOn && (acc.status & ACCEPTOR_INHIBIT) !== 0);
    if (!this.accepting() || inhibited || this.escrowHeld) {
      this.events.push({ at: this.now(), code: (acc.kind === 'note' ? NOTE_EVENT : COIN_EVENT) | EV.INHIBITED, raw: 0, dispenser: false, index: accIndex });
      return 'rejected';
    }
    if (extOn) {
      // Into the recycler's escrow unit: accepted money (CurrentValue), tracked by the escrow block.
      this.credit(acc, coin, false);
      this.ext!.notes.push({ valueAgorot: valueAgorot, coin: coinIndex, location: 99, status: 0 });
      this.ext!.state = EXT_ESCROW_LOADING;
      this.bump();
      return 'accepted';
    }
    if (acc.kind === 'note' && acc.escrowCapable && this.escrowEnabled) {
      this.escrowHeld = { acceptor: accIndex, coin: coinIndex };
      coin.heldInEscrow = 1;
      this.escrowThroughput += valueAgorot;
      this.bump();
      return 'escrow';
    }
    this.credit(acc, coin, true);
    this.bump();
    return 'accepted';
  }

  private credit(acc: SimAcceptor, coin: SimCoin, route: boolean) {
    this.currentValue += coin.valueAgorot;
    coin.count++;
    if (!route) return;
    if (coin.path !== 0) {
      const switching = coin.defaultPath !== 0 && coin.pathSwitchLevel !== 0;
      const target =
        acc.kind === 'note'
          ? this.dispensers.find((d) => dispenserClass(d.unit) === 'note' && (d.address & 0x07) === coin.path)
          : this.dispensers.find((d) => {
              const cls = dispenserClass(d.unit);
              if (cls === 'smart_hopper' || cls === 'mdb_tube') return d.valueAgorot === coin.valueAgorot;
              return cls === 'hopper' && d.address === coin.path;
            });
      if (switching && coin.pathCount >= coin.pathSwitchLevel) return; // hopper full: the coin cashbox
      if (target && target.inside < target.capacity) {
        target.inside++;
        coin.pathCount++;
      }
    }
  }

  /** The customer takes the bill presented as change. */
  takeBill(): boolean {
    if (!this.job?.presented) return false;
    this.job.presented = null;
    this.bump();
    return true;
  }

  jam(valueAgorot: number, on = true) {
    for (const d of this.dispensers) if (d.valueAgorot === valueAgorot) d.jammed = on;
  }

  setInside(valueAgorot: number, count: number) {
    for (const d of this.dispensers) if (d.valueAgorot === valueAgorot && dispenserClass(d.unit) !== 'smart_total') d.inside = count;
    this.bump();
  }

  inside(valueAgorot: number): number {
    return this.dispensers.filter((d) => d.valueAgorot === valueAgorot && dispenserClass(d.unit) !== 'smart_total').reduce((s, d) => s + d.inside, 0);
  }

  /** A switch input closes / opens. */
  setSwitch(n: number, closed: boolean) {
    const s = this.switches.get(n) ?? { opens: 0, closes: 0 };
    const isClosed = s.closes > s.opens;
    if (closed && !isClosed) s.closes++;
    if (!closed && isClosed) s.opens++;
    this.switches.set(n, s);
    this.bump();
  }

  queueEvent(code: number, index = 0, dispenser = false, raw = 0) {
    this.events.push({ at: this.now(), code, raw, dispenser, index });
    this.bump();
  }

  /**
   * Power off and on (PayLink and the PC): lifetime counters survive, escrow throughput does not,
   * a payout in progress stops; a bill that was presented stays in the unit, its dispenser
   * inhibited, with IMHEI_NOTE_DISPENSER_PENDING — never delivered without the application.
   */
  powerCut() {
    if (this.job?.presented) {
      const d = this.dispensers[this.job.presented.dispenser];
      for (const x of this.dispensers) if (dispenserClass(x.unit) === 'note') x.inhibit = true;
      this.events.push({ at: this.now(), code: NOTE_DISPENSER_EVENT | EV.DISPENSE_PENDING, raw: 1, dispenser: true, index: this.dispensers.indexOf(d) });
    }
    this.job = null;
    this.lastPayStatus = PAY_FINISHED;
    if (this.escrowHeld) {
      // A note in single escrow at power-off is returned by the acceptor.
      this.acceptors[this.escrowHeld.acceptor].coins[this.escrowHeld.coin].heldInEscrow = 0;
      this.escrowHeld = null;
    }
    this.escrowThroughput = 0;
    this.escrowEnabled = false;
    if (this.ext && this.ext.notes.length > 0) this.ext.state = EXT_ESCROW_POWER_ACTIVE;
    else if (this.ext) this.ext.state = EXT_ESCROW_OFF;
    for (const a of this.acceptors) a.status |= ACCEPTOR_INHIBIT;
    this.opened = false;
    this.interfaceEnabled = false;
    this.watchdog = null;
    this.bump();
  }

  /* ------------------------------------------------------------ internals */

  private bump() {
    this.updates++;
  }

  private escrowCmd(action: 'enable' | 'disable' | 'accept' | 'return') {
    if (action === 'enable') this.escrowEnabled = true;
    if (action === 'disable') {
      this.escrowEnabled = false;
      if (this.escrowHeld) this.escrowCmd('accept');
    }
    if ((action === 'accept' || action === 'return') && this.escrowHeld) {
      const acc = this.acceptors[this.escrowHeld.acceptor];
      const coin = acc.coins[this.escrowHeld.coin];
      coin.heldInEscrow = 0;
      this.escrowHeld = null;
      if (action === 'accept') this.credit(acc, coin, true);
      else this.events.push({ at: this.now(), code: NOTE_EVENT | EV.RETURN, raw: 0, dispenser: false, index: this.acceptors.indexOf(acc) });
    }
  }

  private extCmd(cmd: number) {
    const e = this.ext;
    if (!e) return;
    e.result = EXT_ESCROW_BUSY;
    const ok = () => (e.result = EXT_ESCROW_COMPLETE);
    const wrong = () => (e.result = EXT_ESCROW_WRONGSTATE);
    switch (cmd) {
      case EXT_ESCROW_START:
        if (e.state === EXT_ESCROW_OFF) {
          e.state = EXT_ESCROW_IDLE;
          ok();
        } else if (e.state === EXT_ESCROW_POWER_ACTIVE) ok();
        else wrong();
        break;
      case EXT_ESCROW_STOP:
        e.state = EXT_ESCROW_OFF;
        ok();
        break;
      case EXT_ESCROW_ACCEPT:
        if (e.state === EXT_ESCROW_IDLE || e.state === EXT_ESCROW_PAUSED || e.state === EXT_ESCROW_STORED || e.state === EXT_ESCROW_STACKED_OK || e.state === EXT_ESCROW_RETURNED_OK) {
          if (e.state !== EXT_ESCROW_PAUSED && e.state !== EXT_ESCROW_STORED) {
            e.notes = [];
            e.returned = 0;
          }
          e.state = EXT_ESCROW_WAITING;
          ok();
        } else wrong();
        break;
      case EXT_ESCROW_PAUSE:
        if (e.state === EXT_ESCROW_WAITING || e.state === EXT_ESCROW_LOADING) {
          e.state = EXT_ESCROW_PAUSED;
          ok();
        } else wrong();
        break;
      case EXT_ESCROW_STACK:
        if (e.state === EXT_ESCROW_PAUSED || e.state === EXT_ESCROW_STORED || e.state === EXT_ESCROW_POWER_ACTIVE) {
          e.state = EXT_ESCROW_STACKING;
          // Keep: matching notes stay in their recycler unit, the rest go to the cashbox.
          const noteAcc = this.acceptors.find((a) => a.kind === 'note')!;
          for (const n of e.notes) {
            const coin = noteAcc.coins[n.coin];
            const unit = this.dispensers.find((d) => dispenserClass(d.unit) === 'note' && d.valueAgorot === n.valueAgorot);
            if (unit && coin.path !== 0 && unit.inside < unit.capacity) {
              unit.inside++;
              coin.pathCount++;
            }
            n.status = 1;
          }
          e.state = EXT_ESCROW_STACKED_OK;
          ok();
        } else wrong();
        break;
      case EXT_ESCROW_RETURN:
        if (e.state === EXT_ESCROW_PAUSED || e.state === EXT_ESCROW_STORED || e.state === EXT_ESCROW_POWER_ACTIVE || e.state === EXT_ESCROW_LOADING || e.state === EXT_ESCROW_WAITING) {
          e.state = EXT_ESCROW_RETURNING;
          // The same notes go back: Paylink pays them out of the escrow unit (CurrentPaid rises).
          let back = 0;
          for (const n of e.notes) {
            back += n.valueAgorot;
            n.status = 2;
          }
          this.currentPaid += back;
          e.returned = back;
          e.notes = [];
          e.state = EXT_ESCROW_RETURNED_OK;
          ok();
        } else wrong();
        break;
    }
  }

  private dispenserWrite(c: Extract<DeviceCommand, { op: 'dispenser' }>): CommandResult {
    const d = this.dispensers[c.index];
    if (!d) return { ok: false, error: 'no such dispenser' };
    const cls = dispenserClass(d.unit);
    const bus = busOf(d.unit);
    if (c.inhibit !== undefined) {
      d.inhibit = c.inhibit;
      // Inhibiting the unit whose bill is presented abandons it: the bill goes back (Vega / UBA / iPro: Count and CurrentPaid drop).
      if (c.inhibit && this.job?.presented && this.job.presented.dispenser === c.index) {
        const p = this.job.presented;
        d.count--;
        d.inside++;
        this.currentPaid -= p.valueAgorot;
        this.job.leftAgorot += p.valueAgorot;
        this.job.presented = null;
        this.job.tried.add(c.index);
      }
    }
    if (c.status !== undefined) {
      if (c.status === DISPENSER_CASHBOX_DUMP) {
        if (bus === 'mdb' || !(cls === 'note' || cls === 'smart_total')) {
          d.status = c.status; // no effect on this unit (MDB: dumps are not possible)
        } else {
          const targets = cls === 'smart_total' ? this.dispensers.filter((x) => dispenserClass(x.unit) === 'smart_hopper') : [d];
          for (const t of targets) t.inside = 0;
          d.status = DISPENSER_DUMP_FINISHED;
        }
      } else if (c.status === DISPENSER_PARTIAL_DUMP) {
        if (bus === 'mdb' || !(cls === 'note' || cls === 'smart_hopper')) d.status = c.status;
        else {
          const n = Math.min(d.inside, Math.max(0, c.notesToDump ?? d.notesToDump));
          d.inside -= n;
          d.status = DISPENSER_DUMP_FINISHED;
        }
      } else if (c.status === DISPENSER_UPDATE_COUNT) {
        if (cls === 'note' && bus === 'id003' && c.coinCount !== undefined) {
          d.reportedOffset = c.coinCount - d.inside;
          d.status = DISPENSER_COUNT_UPDATED;
        } else d.status = c.status;
      } else if (c.status === DISPENSER_RESET_STATUS) d.status = PAY_FINISHED;
      else d.status = c.status;
    }
    this.bump();
    return { ok: true };
  }

  /** One step of the payout in progress. */
  private progress() {
    const job = this.job;
    if (!job) return;
    if (job.presented) {
      if (this.cfg.autoTakeBills !== false) job.presented = null;
      else return;
    }
    let steps = this.cfg.piecesPerRead ?? 1;
    while (steps-- > 0 && job.leftAgorot > 0) {
      const pick = this.pickDispenser(job);
      if (pick === null) break;
      const d = this.dispensers[pick];
      if (d.jammed) {
        d.status = PAY_JAMMED;
        job.failStatus = PAY_JAMMED;
        job.tried.add(pick);
        this.events.push({ at: this.now(), code: (dispenserClass(d.unit) === 'note' ? NOTE_DISPENSER_EVENT : COIN_DISPENSER_EVENT) | FAULT_BIT | 1, raw: 0, dispenser: true, index: pick });
        continue;
      }
      if (d.inside <= 0) {
        d.status = PAY_EMPTY;
        job.failStatus = PAY_EMPTY;
        job.tried.add(pick);
        continue;
      }
      d.inside--;
      d.count++;
      d.status = PAY_FINISHED;
      this.currentPaid += d.valueAgorot;
      job.leftAgorot -= d.valueAgorot;
      if (job.specific) job.specific.set(pick, (job.specific.get(pick) ?? 0) - 1);
      if (dispenserClass(d.unit) === 'note') {
        job.presented = { dispenser: pick, valueAgorot: d.valueAgorot, at: this.now() };
        if (this.cfg.autoTakeBills === false) break;
        job.presented = null;
      }
      this.bump();
    }
    if (job.presented) return;
    const stuck = this.pickDispenser(job) === null;
    if (job.leftAgorot <= 0 || stuck) {
      this.lastPayStatus = job.leftAgorot <= 0 ? PAY_FINISHED : (job.failStatus ?? (this.dispensers.length === 0 ? PAY_NO_HOPPER : PAY_EMPTY));
      this.job = null;
      this.bump();
    }
  }

  private pickDispenser(job: PayoutJob): number | null {
    if (job.specific) {
      for (const [i, n] of job.specific) if (n > 0 && !job.tried.has(i) && !this.dispensers[i].inhibit) return i;
      return null;
    }
    // PayOut: highest value that fits, not inhibited, not yet given up. MDB: the level 3 payout drives the (inhibited) tubes.
    const mdb = this.dispensers.some((d) => dispenserClass(d.unit) === 'mdb_payout' && !d.inhibit);
    let best: number | null = null;
    this.dispensers.forEach((d, i) => {
      const cls = dispenserClass(d.unit);
      if (cls === 'smart_total' || cls === 'mdb_payout') return;
      if (d.inhibit && !(mdb && cls === 'mdb_tube')) return;
      if (job.tried.has(i) || d.valueAgorot <= 0 || d.valueAgorot > job.leftAgorot) return;
      if (best === null || d.valueAgorot > this.dispensers[best].valueAgorot) best = i;
    });
    return best;
  }

  private snapshot(): DeviceSnapshot {
    const acceptors: AcceptorSnap[] = this.acceptors.map((a, index) => ({
      index,
      unit: a.unit,
      kind: a.kind,
      bus: busOf(a.unit) as BusName,
      status: a.status,
      inhibited: (a.status & ACCEPTOR_INHIBIT) !== 0,
      interfaceNumber: 0,
      address: a.address,
      currency: 'ILS',
      serial: a.serial,
      description: a.kind === 'note' ? 'SIM NOTE' : 'SIM COIN',
      coins: a.coins.map((c, ci) => ({ index: ci, ...c })),
    }));
    const dispensers: DispenserSnap[] = this.dispensers.map((d, index) => {
      const cls = dispenserClass(d.unit);
      const accurate = !d.levelOnly && cls !== 'smart_total' && cls !== 'mdb_payout' && d.unit !== (DP_CC_GHOST_HOPPER >>> 0);
      let coinCountStatus: number = DISPENSER_ACCURATE;
      if (!accurate) coinCountStatus = d.inside <= d.lowAt ? DISPENSER_COIN_LOW : d.inside >= d.highAt ? DISPENSER_COIN_HIGH : DISPENSER_COIN_MID;
      if (accurate && d.inside >= d.capacity) coinCountStatus = DISPENSER_ACCURATE_FULL;
      return {
        index,
        unit: d.unit,
        cls,
        bus: busOf(d.unit),
        status: d.status,
        interfaceNumber: 0,
        address: d.address,
        valueAgorot: d.valueAgorot,
        count: d.count,
        inhibit: d.inhibit,
        notesToDump: d.notesToDump,
        coinCount: accurate ? Math.max(0, d.inside + d.reportedOffset) : 0,
        coinCountStatus,
        serial: d.serial,
        description: `SIM ${cls}`,
      };
    });
    const escrows: EscrowBlockSnap[] = this.ext
      ? [
          {
            index: 0,
            version: 0,
            state: this.ext.state,
            result: this.ext.result,
            totalValueAgorot: this.ext.notes.reduce((s, n) => s + n.valueAgorot, 0),
            valueReturnedAgorot: this.ext.returned,
            acceptorNo: this.acceptors.findIndex((a) => a.kind === 'note'),
            notes: this.ext.notes.map((n) => ({ valueAgorot: n.valueAgorot, noteNumber: n.coin, location: n.location, status: n.status })),
          },
        ]
      : [];
    return {
      at: this.now(),
      open: this.opened,
      serial: this.cfg.serial ?? 'SIM00001',
      firmware: this.cfg.firmware ?? FIRMWARE_4_1_12_6,
      driver: this.driver,
      des: this.des,
      updates: this.updates,
      currentValueAgorot: this.currentValue,
      currentPaidAgorot: this.currentPaid,
      lastPayStatus: this.lastPayStatus,
      escrowThroughputAgorot: this.escrowEnabled ? this.escrowThroughput : null,
      acceptors,
      dispensers,
      escrows,
      switches: [...this.switches.entries()].map(([n, s]) => ({ n, opens: s.opens, closes: s.closes })),
      consistencyError: this.consistencyError,
      watchdogSeq: this.watchdog?.seq ?? null,
    };
  }

  /** The extended escrow's unit index (for the host's EscrowCommand). */
  get extendedEscrowUnit(): number | null {
    return this.ext ? this.extUnit : null;
  }

  /** Test helper: the escrow note waiting. */
  get escrowNote(): number | null {
    if (!this.escrowHeld) return null;
    return this.acceptors[this.escrowHeld.acceptor].coins[this.escrowHeld.coin].valueAgorot;
  }

  /** Test helper: a presented bill waiting to be taken. */
  get presentedBill(): number | null {
    return this.job?.presented?.valueAgorot ?? null;
  }
}
