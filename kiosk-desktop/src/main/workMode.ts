/**
 * "מצב עבודה: קיוסק / קופה" at work on the device — the runtime port of the Android app's
 * KioskWorkModeRuntime.kt and the mode persistence of KioskRepository.kt (P:\specs\kiosk-landscape-till-mode.md
 * §5; the rules are core/workMode.ts, pinned by test/workMode.test.ts).
 *
 *  - It exists only where the owner's gate `kioskTillModeEnabled` is on. With the gate off nothing is
 *    offered; if the gate closes while the device is away from its home mode, it goes back home as soon
 *    as nothing is open (`tick`).
 *  - The mode is kept across restarts (`WorkSessions`, in the service's kv): a till session for a kiosk
 *    by role, an "away in kiosk" session for a till by role. Same machine, same series, same shift: NO
 *    new fiscal identity — nothing fiscal moves with the mode.
 *  - A manager's code with KIOSK_TILL_MODE is ALWAYS needed (checked offline against the synced roster,
 *    five wrong codes lock it for a minute); the user whose code is already on screen (the one that
 *    opened the admin, the employee signed in on the till) counts when they hold the permission.
 *  - Never mid-order or mid-payment, both ways: the kiosk side from the service's flow, the till side
 *    from the till engine (`setTillFacts`).
 *  - The idle return, the dashboard's `enter_till` / `return_kiosk` (carried out when allowed, else kept
 *    and reported as `tillMode.returnBlocked`, done as `commandsDone`), and a till event `kiosk_till_mode`
 *    for every switch.
 *
 * No Electron here: every door is injected (`WorkModeDeps`), so tests run it with fakes; `createWorkMode`
 * wires it to the KioskService.
 */

import bcrypt from 'bcryptjs';
import { displayName, NO_LOCK, type ExitLock, type RosterUser } from '../core/desktopExit';
import { normalizeRole } from '../core/roles';
import {
  FLOW_TILL_MODE,
  HANDLED_KEEP,
  KioskHomeRole,
  NO_TILL_FACTS,
  REFUSALS,
  TICK_MS,
  TILL_TICK_MS,
  decideManager,
  eventDetails,
  heldNoticeOf,
  idleCountdownSec,
  idleReturnDue,
  mayEnter,
  mayReturn,
  paramsOf,
  parseCommand,
  parseSession,
  planAfterSync,
  rawFactsOf,
  remote,
  sessionToJson,
  statusJson,
  userHolds,
  approval as approvalOf,
  type KioskSideFacts,
  type ManagerOutcome,
  type RawKioskFacts,
  type TillApproval,
  type TillFacts,
  type TillModeParams,
  type TillModeRefusal,
  type TillModeStatus,
  type TillSession,
  type WorkMode,
  type WorkModeCommand,
  type WorkModeSource,
} from '../core/workMode';
import type { WorkModeView } from '../shared/roles';
import type { KioskService } from './service';

/** The part of the service's key-value store the work mode uses. */
export interface KvLike {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

const K = {
  /** A kiosk by role works as a till since… (Android prefs `workMode.till`). */
  till: 'workMode.till',
  /** A till by role works as a kiosk since… (Android prefs `workMode.kiosk`). */
  away: 'workMode.kiosk',
  /** The dashboard's commands carried out, until the cloud stops listing them (`status.commandsDone`). */
  done: 'workMode.done',
  /** Commands answered lately: one the cloud lists again never runs twice. */
  handled: 'workMode.handled',
  lock: 'workMode.lock',
} as const;

/* ------------------------------------------------------------ the sessions */

/**
 * The two sessions the mode is made of, and the dashboard commands' bookkeeping, kept in the service's kv
 * (so a restart opens in the same mode, with no network at all). The service owns one (`svc.workSessions`):
 * its `isKiosk()` and the role manager read it from the first moment, before the runtime is even built.
 */
export class WorkSessions {
  private readonly cache = new Map<string, unknown>();

  constructor(private readonly kv: KvLike) {}

  private session(key: string): TillSession | null {
    if (!this.cache.has(key)) this.cache.set(key, parseSession(this.kv.get(key)));
    return this.cache.get(key) as TillSession | null;
  }

  private setSession(key: string, s: TillSession | null) {
    if (s) this.kv.set(key, sessionToJson(s));
    else this.kv.delete(key);
    this.cache.set(key, s);
  }

  /** A kiosk by role working as a till: who switched it, when, how. */
  till(): TillSession | null {
    return this.session(K.till);
  }

  /** A till by role working as a kiosk. */
  away(): TillSession | null {
    return this.session(K.away);
  }

  enterTill(s: TillSession) {
    this.setSession(K.till, s);
  }

  leaveTill() {
    this.setSession(K.till, null);
  }

  enterAway(s: TillSession) {
    this.setSession(K.away, s);
  }

  leaveAway() {
    this.setSession(K.away, null);
  }

  /** Unpaired: no mode to keep. */
  clear() {
    this.leaveTill();
    this.leaveAway();
    this.setList(K.done, []);
  }

  private list(key: string): string[] {
    if (!this.cache.has(key)) {
      let v: unknown = null;
      try {
        v = JSON.parse(this.kv.get(key) ?? 'null');
      } catch {
        v = null;
      }
      this.cache.set(key, Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    }
    return this.cache.get(key) as string[];
  }

  private setList(key: string, ids: string[]) {
    if (ids.length > 0) this.kv.set(key, JSON.stringify(ids));
    else this.kv.delete(key);
    this.cache.set(key, ids);
  }

  /** The commands carried out: told to the cloud with every status until it stops listing them. */
  done(): string[] {
    return [...this.list(K.done)];
  }

  markDone(id: string) {
    const ids = this.list(K.done);
    if (!ids.includes(id)) this.setList(K.done, [...ids, id]);
  }

  /** Done ids the cloud no longer lists: it has them; nothing more to say. */
  forgetDone(keepListed: string | null) {
    const ids = this.list(K.done);
    const kept = ids.filter((id) => id === keepListed);
    if (kept.length !== ids.length) this.setList(K.done, kept);
  }

  wasHandled(id: string): boolean {
    return this.list(K.handled).includes(id);
  }

  markHandled(id: string) {
    const ids = this.list(K.handled);
    if (!ids.includes(id)) this.setList(K.handled, [...ids, id].slice(-HANDLED_KEEP));
  }
}

/* --------------------------------------------------------------- the runtime */

/** Everything the runtime needs from the outside (the service, in production; fakes in tests). */
export interface WorkModeDeps {
  sessions: WorkSessions;
  kv: KvLike;
  now(): number;
  paired(): boolean;
  /** A screen (KDS, board) is no till: nothing here concerns it. */
  fiscal(): boolean;
  /** The cloud's last `kiosk/sync` answer as it said it (a till's kiosk-mode row says `kiosk: true, homeRole: "till"`). */
  snapshot(): Record<string, unknown> | null;
  /** `machines/me` deviceRole. */
  deviceRole(): unknown;
  /** The till parameters (`param.<key>`). */
  parameters(): Record<string, unknown>;
  /** The shop's POS users, with their PIN hashes and effective permissions. */
  roster(): RosterUser[];
  shopId(): string | null;
  /** The kiosk side now: paying, ordering (derived from the kiosk's flow). */
  kioskFacts(): KioskSideFacts;
  /** A card request is out at the terminal (either side). */
  cardInFlight(): boolean;
  /** `kiosk/sync` now (the status is read through `statusFields` / `kioskModeRequested`). */
  kioskSync(): Promise<void>;
  /** A till event of type `kiosk_till_mode`, kept here and sent to the cloud. */
  recordEvent(details: Record<string, unknown>, posUserId: string | null): void;
  /** The mode (or what the screens show of it) changed: the view, the role. */
  changed(): void;
  compare(pin: string, hash: string): Promise<boolean>;
  log(m: string): void;
}

export type ManagerCheck =
  | { ok: true; id: string; name: string }
  | { ok: false; reason: ManagerOutcome; message: string; triesLeft: number; lockedForMs: number };

/** The first delay: after the device is up. */
const FIRST_TICK_MS = 2_000;
const COUNTDOWN_TICK_MS = 1_000;

export class WorkModeRuntime {
  private tillFactsFn: (() => TillFacts) | null = null;
  private signOutFn: (() => void | Promise<void>) | null = null;
  private pending: WorkModeCommand | null = null;
  private blocked: TillModeRefusal | null = null;
  private held: number | null = null;
  private asking = false;
  private touchedAt = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private codeChain: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<() => void>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private running: Promise<void> | null = null;
  private again = false;
  private lastSignature = '';

  constructor(private readonly d: WorkModeDeps) {}

  /* ------------------------------------------------------------- lifecycle */

  start() {
    if (this.started) return;
    this.started = true;
    this.schedule(FIRST_TICK_MS);
  }

  stop() {
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number) {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.schedule(this.nextDelay()));
    }, ms);
    this.timer.unref?.();
  }

  /** In till mode the idle notice counts down: looked at often (never a database read in between). */
  private nextDelay(): number {
    if (this.mode() !== 'till') return TICK_MS;
    return this.countdownSec() !== null ? COUNTDOWN_TICK_MS : TILL_TICK_MS;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Listeners (and the service's view) hear of a change in what the screens show. */
  private changed(force = false) {
    const sig = JSON.stringify(this.view());
    if (!force && sig === this.lastSignature) return;
    this.lastSignature = sig;
    try {
      this.d.changed();
    } catch (e) {
      this.d.log(`work mode: change not delivered (${String(e)})`);
    }
    for (const fn of this.listeners) {
      try {
        fn();
      } catch {
        // a screen's listener never stops the switch
      }
    }
  }

  /* ---------------------------------------------------------- the facts now */

  private raw(): RawKioskFacts {
    return rawFactsOf(this.d.snapshot());
  }

  /** The feature's parameters as this device has them. */
  params(): TillModeParams {
    return paramsOf(this.d.parameters());
  }

  /**
   * Whether any of this concerns the device: paired, a till or a kiosk (not a screen), and either a kiosk
   * row exists or the cloud made it a till. A till never allowed the kiosk mode, with no kiosk-mode row, is out.
   */
  applicable(): boolean {
    if (!this.d.paired() || !this.d.fiscal()) return false;
    if (this.raw().kiosk) return true;
    return normalizeRole(this.d.deviceRole()) === 'till';
  }

  /** The current mode, by the role the device was given (§5.10). */
  mode(): WorkMode {
    return KioskHomeRole.mode(this.raw(), this.d.sessions.till() !== null, this.d.sessions.away() !== null);
  }

  /** A till by role (its kiosk-mode row, or none yet). */
  homeTill(): boolean {
    return !KioskHomeRole.kioskByRole(this.raw());
  }

  /** A kiosk by role working as a till now (its till session). */
  inTillSession(): boolean {
    return this.d.sessions.till() !== null && KioskHomeRole.kioskByRole(this.raw());
  }

  /** A till by role working as a kiosk now. */
  awayInKiosk(): boolean {
    return this.d.sessions.away() !== null;
  }

  /** The kiosk side now (a customer ordering or paying). */
  kioskFacts(): KioskSideFacts {
    const f = this.d.kioskFacts();
    return { ...f, cardInFlight: f.cardInFlight || this.safeCard() };
  }

  private safeCard(): boolean {
    try {
      return this.d.cardInFlight();
    } catch {
      return true;
    }
  }

  /** The till engine's word: its side facts, who is signed in, the last touch. A card at the terminal counts either way. */
  tillFacts(): TillFacts {
    let f = NO_TILL_FACTS;
    try {
      f = this.tillFactsFn?.() ?? NO_TILL_FACTS;
    } catch (e) {
      this.d.log(`work mode: till facts failed (${String(e)})`);
    }
    return { ...f, cardInFlight: f.cardInFlight || this.safeCard() };
  }

  /**
   * The till engine (the till role) tells its side: lines on the sell screen, the payment screen, a tender, a
   * card, a table, held sales, who is signed in, and the last touch of its screens. Until it does, all false.
   */
  setTillFacts(fn: () => TillFacts) {
    this.tillFactsFn = fn;
  }

  /** The till's sign-out, on the way to the kiosk (the employee leaves with the mode). */
  setTillSignOut(fn: () => void | Promise<void>) {
    this.signOutFn = fn;
  }

  /* ---------------------------------------------------------- what is offered */

  /**
   * What menu entry exists now. "קופה" (`toTill`): in kiosk mode, where the owner allowed it. "קיוסק" (`toKiosk`):
   * in till mode — a kiosk by role always (the gate closing never traps it; `tick` sends it home), a till by role
   * only where the owner allowed the kiosk mode.
   */
  offered(): { toTill: boolean; toKiosk: boolean } {
    if (!this.applicable()) return { toTill: false, toKiosk: false };
    const enabled = this.params().enabled;
    const mode = this.mode();
    return { toTill: enabled && mode === 'kiosk', toKiosk: mode === 'till' && (KioskHomeRole.kioskByRole(this.raw()) || enabled) };
  }

  /** Whether the device may go to the till now (the kiosk side: a customer's order or payment); null — yes. */
  mayEnter(): TillModeRefusal | null {
    if (!this.applicable()) return REFUSALS.disabled;
    return mayEnter(this.params(), this.kioskFacts());
  }

  /** Whether the device may go back to the kiosk now (the till side: a sale, a payment, a table); null — yes. */
  mayReturn(): TillModeRefusal | null {
    if (this.mode() !== 'till') return null;
    return mayReturn(this.tillFacts());
  }

  /** What holds a pending dashboard switch back right now; null — nothing pending, or nothing holds it. */
  blockedReason(): TillModeRefusal | null {
    return this.blocked;
  }

  /** Seconds until the idle return ("חוזר לקיוסק בעוד…"), while within its notice; null otherwise. */
  countdownSec(): number | null {
    if (!this.applicable() || this.mode() !== 'till' || !KioskHomeRole.idleReturnApplies(this.raw())) return null;
    const facts = this.tillFacts();
    return idleCountdownSec(this.params(), this.idleMs(facts), facts);
  }

  /** "יש N מכירות מושהות — יחכו במצב קופה": said once on the way back to the kiosk. */
  heldNotice(): number | null {
    return this.held;
  }

  dismissHeldNotice() {
    if (this.held === null) return;
    this.held = null;
    this.changed();
  }

  /** Milliseconds since the last touch: the till's screens, "נשארים", or the switch itself. */
  private idleMs(facts: TillFacts): number {
    const since = this.d.sessions.till()?.sinceMs ?? 0;
    const last = Math.max(facts.lastActivityAtMs ?? 0, this.touchedAt, since);
    return last > 0 ? Math.max(0, this.d.now() - last) : 0;
  }

  /** A touch on the device's screens ("נשארים", or the role manager's activity): the idle return starts over. */
  stay() {
    this.touchedAt = this.d.now();
    this.changed();
  }

  /** The same, without a view (every touch of the shell). */
  touched() {
    this.touchedAt = this.d.now();
  }

  /** What the screens show of the mode. */
  view(): WorkModeView {
    const o = this.offered();
    return {
      enabled: this.applicable() && this.params().enabled,
      mode: this.mode(),
      homeTill: this.homeTill(),
      toTill: o.toTill,
      toKiosk: o.toKiosk,
      countdownSec: this.countdownSec(),
      heldNotice: this.held,
      blocked: this.blocked?.wire ?? null,
    };
  }

  /* ------------------------------------------------------- the manager's code */

  /** Whether this user (read from the roster now) holds KIOSK_TILL_MODE — their own code on screen needs no second one. */
  holds(userId: string | null | undefined): boolean {
    return userHolds(this.d.roster(), this.d.shopId(), userId);
  }

  /** The approval a switch needs: none when the user whose code is on screen holds KIOSK_TILL_MODE, else a manager's code. */
  approval(userId: string | null | undefined): TillApproval {
    return approvalOf(this.holds(userId));
  }

  /**
   * A manager's code with KIOSK_TILL_MODE, checked offline against the synced roster (bcrypt). Five wrong
   * codes lock the pad for a minute (kept across restarts, its own lock).
   */
  checkManagerCode(code: string): Promise<ManagerCheck> {
    const run = this.codeChain.then(() => this.checkCode(code));
    this.codeChain = run.catch(() => undefined);
    return run;
  }

  private async checkCode(code: string): Promise<ManagerCheck> {
    let lock: ExitLock = NO_LOCK;
    try {
      lock = (JSON.parse(this.d.kv.get(K.lock) ?? 'null') as ExitLock | null) ?? NO_LOCK;
    } catch {
      lock = NO_LOCK;
    }
    const decision = await decideManager({ users: this.d.roster(), shopId: this.d.shopId(), code: typeof code === 'string' ? code : '', lock, nowMs: this.d.now(), compare: this.d.compare });
    this.d.kv.set(K.lock, JSON.stringify(decision.lock));
    if (decision.outcome === 'granted' && decision.user) return { ok: true, id: decision.user.id, name: displayName(decision.user) };
    if (decision.outcome === 'locked_out') this.d.log('work mode: five wrong manager codes — the pad is locked for a minute');
    return { ok: false, reason: decision.outcome, message: decision.message ?? '', triesLeft: decision.triesLeft, lockedForMs: decision.lockedForMs };
  }

  /* ------------------------------------------------------------- the switch */

  /** One switch at a time. */
  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * To the till, by a manager on the device ("ניהול הקיוסק"), the dashboard, or — for a till by role away in its
   * kiosk mode — home. The approval is the caller's (a manager's code); the facts are checked here too: never over a
   * customer's order or payment, never with the owner's gate closed (but for the cloud sending a device home).
   * Null: done.
   */
  enterTill(by: string | null, byId: string | null, source: WorkModeSource, commandId?: string | null): Promise<TillModeRefusal | null> {
    return this.withLock(async () => {
      if (!this.applicable()) return REFUSALS.disabled;
      if (this.mode() === 'till') return null;
      const params = source === 'cloud' ? { ...this.params(), enabled: true } : this.params();
      const refusal = mayEnter(params, this.kioskFacts());
      if (refusal) return refusal;
      // A kiosk by role starts its till session; a till by role comes home.
      if (this.homeTill()) this.d.sessions.leaveAway();
      else this.d.sessions.enterTill({ sinceMs: this.d.now(), by, byId, source });
      this.record('till', source, by, byId, null, 0, commandId ?? null);
      this.d.log(`work mode: till (${source}) by ${by ?? '?'}`);
      this.held = null;
      this.changed(true);
      void this.syncNow();
      return null;
    });
  }

  /**
   * Back to the kiosk: refused (the reason) while a sale is open; held sales stay held and the notice says so. A till
   * by role needs its kiosk config first (asked of the cloud the first time: `kiosk_config_missing` without it) and the
   * owner's gate open. Null: done.
   */
  returnToKiosk(source: WorkModeSource, by: string | null = null, byId: string | null = null, commandId: string | null = null): Promise<TillModeRefusal | null> {
    return this.withLock(async () => {
      if (!this.applicable()) return REFUSALS.disabled;
      if (this.mode() === 'kiosk') return null;
      if (this.homeTill() && !this.params().enabled) return REFUSALS.disabled;
      const till = this.tillFacts();
      const refusal = mayReturn(till);
      if (refusal) return refusal;
      // A till by role: its kiosk mode's config first (asked of the cloud the first time).
      if (this.homeTill() && !(await this.ensureKioskConfig())) return REFUSALS.kiosk_config_missing;
      const employee = till.employee;
      const who = by ?? employee?.name ?? null;
      const whoId = byId ?? employee?.id ?? null;
      this.record('kiosk', source, who, whoId, employee?.name ?? null, till.heldSales, commandId);
      try {
        await this.signOutFn?.();
      } catch (e) {
        this.d.log(`work mode: sign-out failed (${String(e)})`);
      }
      if (this.homeTill()) this.d.sessions.enterAway({ sinceMs: this.d.now(), by: who, byId: whoId, source });
      else this.d.sessions.leaveTill();
      this.held = heldNoticeOf(till);
      this.d.log(`work mode: kiosk (${source})${till.heldSales > 0 ? ` — ${till.heldSales} held sales wait for the till` : ''}`);
      this.changed(true);
      void this.syncNow();
      return null;
    });
  }

  /**
   * A till by role's kiosk config is on the device — asked for now when it is not (`requestKioskMode`: the cloud
   * makes its kiosk-mode row where the owner allowed it). False: no config and no answer.
   */
  async ensureKioskConfig(): Promise<boolean> {
    if (this.raw().kiosk) return true;
    this.asking = true;
    try {
      await this.d.kioskSync();
    } catch (e) {
      this.d.log(`work mode: kiosk config request failed (${String(e)})`);
    } finally {
      this.asking = false;
    }
    return this.raw().kiosk;
  }

  /** The kiosk/sync now (the cloud hears the new mode at once, not 15 s later). */
  private async syncNow() {
    try {
      await this.d.kioskSync();
    } catch {
      // offline: the next regular sync says it
    }
  }

  private record(to: WorkMode, source: WorkModeSource, by: string | null, byId: string | null, employee: string | null, heldSales: number, commandId: string | null) {
    try {
      this.d.recordEvent(eventDetails({ to, source, by, byId, employee, heldSales, commandId }), byId);
    } catch (e) {
      this.d.log(`work mode: event not recorded (${String(e)})`);
    }
  }

  /* ------------------------------------------------------ what the cloud sees */

  /** Whether the kiosk/sync going out now asks for the device's kiosk-mode row (`status.requestKioskMode`). */
  kioskModeRequested(): boolean {
    return this.asking;
  }

  /**
   * The work mode's part of the kiosk status: `flowState: "till_mode"` and `tillMode` while working as a till
   * (a till at home with a kiosk row too), `tillMode.returnBlocked` alone while a dashboard switch to the till
   * waits on a customer, `commandsDone` until the cloud stops listing them. Nothing from a device that has no
   * kiosk row.
   */
  statusFields(): { flowState?: string; tillMode?: TillModeStatus; commandsDone?: string[] } {
    const out: { flowState?: string; tillMode?: TillModeStatus; commandsDone?: string[] } = {};
    if (!this.raw().kiosk) return out;
    if (this.mode() === 'till') {
      out.flowState = FLOW_TILL_MODE;
      out.tillMode = statusJson(this.d.sessions.till(), this.tillFacts().employee?.name ?? null, this.blocked);
    } else if (this.blocked !== null) {
      // An `enter_till` held back by a customer's order or payment: the dashboard says "ממתין — לקוח באמצע הזמנה" (the
      // device is still a kiosk, so only the reason goes up — Android sends `tillMode` in till mode alone).
      out.tillMode = statusJson(null, null, this.blocked);
    }
    const done = this.d.sessions.done();
    if (done.length > 0) out.commandsDone = done;
    return out;
  }

  /* ------------------------------------------------ the cloud's `kiosk/sync` */

  /**
   * The cloud answered `kiosk/sync` (SyncEngine → RemoteHooks.onKioskSnapshot): the sessions follow its word, and the
   * dashboard's switch (`workMode`: {id, mode, by} or null) is taken up.
   */
  onKioskReply(next: Record<string, unknown>, prev: Record<string, unknown> | null) {
    const nextRaw = rawFactsOf(next);
    const employee = this.tillFacts().employee;
    const plan = planAfterSync(rawFactsOf(prev), nextRaw, { till: this.d.sessions.till() !== null, away: this.d.sessions.away() !== null }, employee !== null);
    if (plan.dropTill) this.d.sessions.leaveTill();
    if (plan.dropAway) this.d.sessions.leaveAway();
    if (plan.startTill) {
      // Made a kiosk (by role) while an employee is signed in (perhaps mid-sale): never yanked away — the till
      // stays, with the way back to the kiosk for when they are done.
      this.d.sessions.enterTill({ sinceMs: this.d.now(), by: employee?.name ?? null, byId: employee?.id ?? null, source: 'cloud' });
      this.record('till', 'cloud', employee?.name ?? null, employee?.id ?? null, employee?.name ?? null, 0, null);
      this.d.log('work mode: made a kiosk while a till was signed in — the till stays');
    }
    if (nextRaw.kiosk) {
      const command = parseCommand(next.workMode);
      this.d.sessions.forgetDone(command?.id ?? null);
      this.onCommand(command);
    } else {
      this.pending = null;
      this.blocked = null;
    }
    this.changed(plan.dropTill || plan.dropAway || plan.startTill);
  }

  /** The dashboard's switch from kiosk/sync: kept until it runs (or is for the mode already on). */
  onCommand(command: WorkModeCommand | null) {
    if (!command) {
      this.pending = null;
      this.blocked = null;
      return;
    }
    if (this.d.sessions.wasHandled(command.id)) {
      // Answered already, and the cloud still lists it: said again with the next status, never run twice.
      this.d.sessions.markDone(command.id);
      this.pending = null;
      this.blocked = null;
      return;
    }
    if (this.pending?.id === command.id) return;
    this.d.log(`work mode: the dashboard asks for ${command.mode} (${command.id})`);
    this.pending = command;
    void this.tick();
  }

  private finish(command: WorkModeCommand) {
    this.d.sessions.markDone(command.id);
    this.d.sessions.markHandled(command.id);
    this.pending = null;
    this.blocked = null;
    void this.syncNow();
  }

  /* -------------------------------------------------------------------- tick */

  /**
   * One look (every 15 s in kiosk mode, every 2 s in till mode — its idle notice counts down): the owner's gate
   * closed → home as soon as nothing is open; a pending dashboard switch carried out when it may; the idle return.
   */
  tick(): Promise<void> {
    // One look at a time; a look asked for while one runs is made again right after it, and awaiting either waits for both.
    if (this.running) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.tickOnce();
        } while (this.again);
      } catch (e) {
        this.d.log(`work mode tick: ${String(e)}`);
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private async tickOnce() {
    if (!this.d.paired()) {
      // Unpaired: no mode to keep.
      if (this.d.sessions.till() || this.d.sessions.away()) {
        this.d.sessions.clear();
        this.pending = null;
        this.blocked = null;
      }
      this.changed();
      return;
    }
    if (!this.applicable()) {
      this.pending = null;
      this.blocked = null;
      this.changed();
      return;
    }
    const params = this.params();
    const raw = this.raw();

    // The owner's gate closed: there is no other mode — back home as soon as nothing is open.
    if (!params.enabled && this.mode() !== KioskHomeRole.home(raw)) {
      if (KioskHomeRole.home(raw) === 'kiosk') await this.returnToKiosk('cloud');
      else await this.enterTill(null, null, 'cloud');
      this.changed();
      return;
    }

    const command = this.pending;
    if (command) {
      const outcome = remote(command, this.mode(), params, this.kioskFacts(), this.tillFacts());
      this.blocked = outcome.blocked;
      let done = outcome.done;
      if (outcome.run) {
        const refusal = command.mode === 'till' ? await this.enterTill(command.by, null, 'remote', command.id) : await this.returnToKiosk('remote', command.by, null, command.id);
        // Refused at the door (a sale opened in between, no kiosk config): it keeps waiting, with the reason.
        if (refusal) {
          this.blocked = refusal;
          done = false;
        }
      }
      if (done) this.finish(command);
    }

    // The idle return: a kiosk by role in till mode only — a till at home is where it belongs.
    if (this.mode() === 'till' && KioskHomeRole.idleReturnApplies(this.raw())) {
      const facts = this.tillFacts();
      if (idleReturnDue(params, this.idleMs(facts), facts)) await this.returnToKiosk('idle');
    }
    this.changed();
  }
}

/**
 * The runtime wired to the service: its sessions, its roster, its flow, its outbox. `svc.workMode` keeps it (the
 * kiosk status and the admin read it), and the role manager hears of every change through the service's view.
 */
export function createWorkMode(svc: KioskService, log: (m: string) => void = () => undefined): WorkModeRuntime {
  const runtime = new WorkModeRuntime({
    sessions: svc.workSessions,
    kv: svc.kv,
    now: () => Date.now(),
    paired: () => svc.paired,
    fiscal: () => svc.fiscal,
    snapshot: () => svc.rawKioskSnapshot(),
    deviceRole: () => svc.cloud.machine()?.deviceRole ?? null,
    parameters: () => svc.cloud.parameters(),
    roster: () => svc.cloud.posUsers(),
    shopId: () => svc.shopIdHere(),
    kioskFacts: () => svc.kioskSideFacts(),
    cardInFlight: () => svc.pay.cardInFlight,
    kioskSync: async () => {
      await svc.sync.kioskSync();
    },
    recordEvent: (details, posUserId) => svc.recordWorkModeEvent(details, posUserId),
    changed: () => svc.workModeChanged(),
    compare: (p, h) => bcrypt.compare(p, h),
    log,
  });
  svc.attachWorkMode(runtime);
  return runtime;
}
