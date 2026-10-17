/**
 * "נוכחות" on the Windows till — the port of pos-android data/repo/AttendanceRepository.kt and ui/attendance/AttendanceUi.kt
 * (the pure rules: core/till/attendance.ts; the cloud: pos-server app/routers/attendance.py):
 *
 *  - after a PIN, the employee's state: "לא במשמרת" with "התחל משמרת" (required before selling under
 *    `requireClockInBeforeLogin` — a card that cannot be dismissed), "בהפסקה" with "חזרה מהפסקה" (a break locks the sale
 *    screen until it ends), or a short "במשמרת מ־17:02";
 *  - the menu's panel ("נוכחות"): התחל משמרת / יציאה להפסקה / חזרה מהפסקה / סיום משמרת and "בקשת תיקון נוכחות";
 *  - "סיום משמרת"'s checks: the open tables (the cloud's), the cash not deposited, a manager's code where required;
 *  - "שעון נוכחות" on the sign-in screen: any employee types their own code (or a manager acts for one) and punches —
 *    without signing in to the till;
 *  - "קוד עובד בכל פעולה": every action asks the employee's own code at that moment (the cards right after a PIN count the
 *    PIN), or a manager's acting for them; checked here against the roster, offline; never kept, sent or logged.
 *
 * Offline-first, never losing or doubling a punch (Android's outbox kind `attendance`): each action is written to a durable
 * queue in the kv FIRST (`attendance.outbox`, one entry per action id), then to this till's copy (`attendance.shifts`),
 * and delivered in order to `POST /sync/{m}/attendance/actions`, idempotent in the cloud by the ids it carries — a retry
 * after a lost answer is a replay there. An entry leaves the queue only when the cloud took it (2xx); a refusal keeps it
 * (retried hourly — an older cloud may learn the route), no answer retries with a backoff.
 *
 * Separate from the sign-in: this never starts or ends a shift because someone signed in or out — only the buttons do.
 */

import { randomUUID } from 'node:crypto';
import {
  ACTION_WORD,
  ATTENDANCE_TEXT as A,
  AttendanceMachine,
  CLOCK_ATTEMPTS_KEY,
  CLOCK_DONE_MS,
  CONFIRM,
  CORRECTION_KINDS,
  PinAttemptLimiter,
  REFUSAL_TEXT,
  attendanceParamsOf,
  byManager,
  checkClockOut,
  checkCode,
  clockActions,
  clockShown,
  cloudOf,
  confirmedBy,
  correctionTimeIso,
  formatLocalTime,
  formatWorked,
  mergeShift,
  ownCode,
  panelLines,
  payloadOf,
  shiftOf,
  statusLine,
  statusOf,
  tableLine,
  todayIn,
  unionTables,
  withoutPrompt,
  workedMs,
  type ActionConfirmation,
  type AttendanceAction,
  type AttendanceButton,
  type AttendanceCard,
  type AttendanceOpenTable,
  type AttendanceOutcome,
  type AttendanceParams,
  type AttendancePunch,
  type AttendanceShift,
  type AttendanceSheet,
  type AttendanceState,
  type ClockOutApproval,
  type CloudAttendance,
  type CorrectionKind,
} from '../../core/till/attendance';
import { formatShekelSign } from '../../core/money';
import { drawerAwaySettingsOf } from '../../core/till/drawerAway';
import { cloudIdOf } from '../../core/till/exclusiveLogin';
import { approve, displayName, loginCandidates, stateOf as permissionState, type RosterUser } from '../../core/till/staff';
import { NO_LOCK, verifyPin, type ExitLock } from '../../core/desktopExit';
import type { ApproverRef, TillContext, TillFeature } from './tillContext';

export const ATTENDANCE_OPS = [
  'attendance.open',
  'attendance.close',
  'attendance.clock',
  'attendance.act',
  'attendance.code',
  'attendance.behalf',
  'attendance.manager',
  'attendance.pick',
  'attendance.clockOutChoice',
  'attendance.transfer',
  'attendance.correction',
  'attendance.correctionSend',
  'attendance.signOut',
] as const;

export type AttendanceOp = (typeof ATTENDANCE_OPS)[number];

/** The ops that may record a punch (each needs a clientOpId, never applied twice). */
export const ATTENDANCE_MUTATING: readonly AttendanceOp[] = ['attendance.act', 'attendance.code', 'attendance.manager', 'attendance.clockOutChoice', 'attendance.correctionSend'];

const SHIFTS_KEY = 'attendance.shifts';
const OUTBOX_KEY = 'attendance.outbox';
/** The permission a manager's code must hold here (Android ElevationScope.ATTENDANCE_MANAGE). */
export const ATTENDANCE_MANAGE = 'ATTENDANCE_MANAGE';
const MESSAGE_MS = 4_000;
const STATE_TIMEOUT_MS = 5_000;
const SEND_TIMEOUT_MS = 10_000;

/** One action waiting for the cloud: its body (the cloud's `AttendanceActionIn`, `sentAt` set at delivery). */
export interface AttendanceOutboxEntry {
  /** The action's id — its idempotency key in the cloud, and one entry here however often it is queued. */
  id: string;
  body: Record<string, unknown>;
  createdAt: number;
  attempts: number;
  nextAt: number;
  lastError: string | null;
  /** The cloud refused it (a 4xx): kept, tried again hourly; it never blocks the ones behind it. */
  parked: boolean;
}

export function sendBackoffMs(attempts: number, parked: boolean): number {
  const n = Math.max(0, Math.min(10, attempts - 1));
  return parked ? Math.min(3_600_000, 60_000 * 2 ** n) : Math.min(300_000, 2_000 * 2 ** n);
}

export interface TillAttendanceDeps {
  newId?: () => string;
  /** The machine's wall clock zone (tests); the machine's own by default. */
  timeZone?: string;
  /** This till's view of the employee's open tables (none on a till without tables). */
  localOpenTables?: (user: RosterUser) => AttendanceOpenTable[] | Promise<AttendanceOpenTable[]>;
  /** "הכסף אצלי": the employee's cash not deposited, in agorot; null — none known. */
  walletAgorot?: (user: RosterUser) => Promise<number | null> | number | null;
  /** "העברת שולחנות": the till's tables screen, where each table is handed over; absent — no such button. */
  toTables?: () => void;
  /** A kiosk taken for staff (it stays a kiosk: no clock), a KDS screen. */
  kioskTakenForStaff?: () => boolean;
  kdsScreen?: () => boolean;
}

/** Who an action is for, and how it was (or will be) confirmed. */
export interface AttendanceSubject {
  user: RosterUser;
  confirm: ActionConfirmation | null;
  atClock: boolean;
}

type Sheet =
  | { kind: 'code'; user: RosterUser; what: string; run: (c: ActionConfirmation) => unknown; error: string | null }
  | { kind: 'clockCode'; error: string | null }
  | { kind: 'manager'; prompt: string; run: (by: ApproverRef) => unknown; error: string | null }
  | { kind: 'pick'; users: RosterUser[]; forManager: boolean }
  | { kind: 'clockOut'; variant: 'blocked' | 'warning' | 'wallet_warning' | 'wallet_blocked'; subject: AttendanceSubject; tables: AttendanceOpenTable[]; amountAgorot: number }
  | { kind: 'correction'; subject: AttendanceSubject }
  | { kind: 'done'; text: string };

export class TillAttendance implements TillFeature {
  readonly key = 'attendance';
  readonly ops = ATTENDANCE_OPS;
  readonly mutating = ATTENDANCE_MUTATING;

  private readonly newId: () => string;
  /** Wrong attendance codes, for as long as the app runs (closing a sheet does not reset the count). */
  readonly codeAttempts: PinAttemptLimiter;
  private managerLock: ExitLock = NO_LOCK;
  /** The cloud's last answer per employee (open tables, corrections, job title). */
  private readonly clouds = new Map<string, CloudAttendance>();

  // The screens' state.
  private lastOperatorId: string | null = null;
  /** When this sign-in's PIN was typed: the cards right after it count it as the code. */
  private signedInAt: number | null = null;
  private offerArmed = false;
  private greetArmed = false;
  /** The cloud answered (or did not, in time) since this sign-in. */
  private settled = false;
  private cloudAnswered = true;
  private panelOpen = false;
  private clockOpen = false;
  private clockSubject: AttendanceSubject | null = null;
  private clockLoading = false;
  private sheet: Sheet | null = null;
  private busy = false;
  private codeBusy = false;
  private message: string | null = null;
  private messageTimer: NodeJS.Timeout | null = null;
  private doneTimer: NodeJS.Timeout | null = null;

  // The queue to the cloud.
  private sendTimer: NodeJS.Timeout | null = null;
  private draining: Promise<void> | null = null;
  private stopped = false;
  /** The last piece of async work (tests wait for it). */
  private work: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly c: TillContext,
    private readonly d: TillAttendanceDeps = {},
  ) {
    this.newId = d.newId ?? (() => randomUUID());
    this.codeAttempts = new PinAttemptLimiter(() => c.now());
    this.kick(0);
  }

  /* ---------------------------------------------------------------- reading */

  params(): AttendanceParams {
    return attendanceParamsOf(this.c.svc.cloud.parameters());
  }

  /** The id the cloud knows the employee by; a local (demo) user keeps their own. */
  idOf(user: Pick<RosterUser, 'id'>): string {
    return cloudIdOf(user.id) ?? user.id;
  }

  private shifts(): Record<string, AttendanceShift> {
    return this.c.svc.kv.getJson<Record<string, AttendanceShift>>(SHIFTS_KEY) ?? {};
  }

  current(user: Pick<RosterUser, 'id'>): AttendanceShift | null {
    return shiftOf(this.shifts()[this.idOf(user)]) ?? null;
  }

  private putShift(shift: AttendanceShift) {
    this.c.svc.kv.setJson(SHIFTS_KEY, { ...this.shifts(), [shift.posUserId]: shift });
  }

  cloud(user: Pick<RosterUser, 'id'>): CloudAttendance | null {
    return this.clouds.get(this.idOf(user)) ?? null;
  }

  /** The actions not yet taken by the cloud, oldest first. */
  outbox(): AttendanceOutboxEntry[] {
    return (this.c.svc.kv.getJson<AttendanceOutboxEntry[]>(OUTBOX_KEY) ?? []).slice().sort((a, b) => a.createdAt - b.createdAt);
  }

  private saveOutbox(list: AttendanceOutboxEntry[]) {
    if (list.length === 0) this.c.svc.kv.delete(OUTBOX_KEY);
    else this.c.svc.kv.setJson(OUTBOX_KEY, list);
  }

  /** Whether `user` is on a break or (`requireClockInBeforeLogin`) not on shift: selling waits. Null — free to sell. */
  gateOf(user: RosterUser | null): 'required' | 'break' | null {
    const p = this.params();
    if (!user || !p.enabled) return null;
    const st = statusOf(this.current(user));
    if (st === 'on_break') return 'break';
    if (st === 'not_working' && p.requireClockIn) return 'required';
    return null;
  }

  /**
   * The engine's sell ops may ask this (Android's blocking card is modal): the refusal's words while the operator is
   * on a break or must clock in first; null — selling goes on.
   */
  sellRefusal(): string | null {
    const g = this.gateOf(this.c.operator());
    return g === 'break' ? A.gateBreak : g === 'required' ? A.gateRequired : null;
  }

  /* ---------------------------------------------------------------- the sign-in */

  /**
   * The engine's sign-in hook (call it from `completeSignIn`, after `this.cashier = user`): the PIN's moment (the cards
   * right after it count it as the code), the cards armed, the cloud asked. It never refuses the sign-in and never
   * starts or ends a shift — Android signs in, then blocks selling with its card (`gateOf`). Returns that gate.
   * Without the call the module notices the new operator at the next state build — the same, a moment later.
   */
  signedIn(user: RosterUser): { gate: 'required' | 'break' | null } {
    this.lastOperatorId = user.id;
    this.onOperator(user);
    return { gate: this.gateOf(user) };
  }

  private onOperator(user: RosterUser | null) {
    const p = this.params();
    this.panelOpen = false;
    this.offerArmed = !!user && p.enabled;
    this.greetArmed = !!user && p.enabled;
    this.signedInAt = user ? this.c.now() : null;
    this.settled = false;
    // Somebody signed in: the clock is for the sign-in screen only; a session's questions go with the session.
    if (this.sheet && this.sheet.kind !== 'done') this.sheet = null;
    if (user) this.closeClock();
    if (!user || !p.enabled) return;
    queueMicrotask(() => {
      this.track(
        this.c.later(async () => {
          const answered = (await this.refresh(user)) !== null;
          if (this.c.operator()?.id !== user.id) return;
          this.cloudAnswered = answered;
          this.settled = true;
          // "במשמרת מ־17:02": a short greeting when on shift already.
          if (this.greetArmed && statusOf(this.current(user)) === 'working') this.say(statusLine(this.current(user), this.d.timeZone));
          this.greetArmed = false;
          this.c.changed();
        }),
      );
    });
  }

  /* ---------------------------------------------------------------- the cloud */

  /** Ask the cloud, merge its view into this till's copy. Null — no answer: the till goes on with its own copy. */
  async refresh(user: RosterUser): Promise<CloudAttendance | null> {
    const id = cloudIdOf(user.id);
    const m = this.c.svc.machineId;
    if (!id || !m) return null;
    const asked = this.current(user)?.id;
    const q = `posUserId=${encodeURIComponent(id)}${asked ? `&shiftId=${encodeURIComponent(asked)}` : ''}`;
    let r;
    try {
      r = await this.c.svc.api.get(`sync/${m}/attendance/state?${q}`, { timeoutMs: STATE_TIMEOUT_MS });
    } catch {
      return null;
    }
    if (r.kind !== 'ok') return null;
    const cloud = cloudOf(r.body);
    if (!cloud) return null;
    this.clouds.set(id, cloud);
    const mine = this.current(user);
    const merged = mergeShift(mine, cloud);
    if (merged && JSON.stringify(merged) !== JSON.stringify(mine)) this.putShift({ ...merged, posUserId: merged.posUserId || id });
    return cloud;
  }

  /* ---------------------------------------------------------------- the actions */

  private nowIso(): string {
    return new Date(this.c.now()).toISOString();
  }

  /** The outbox first: a copy saved with no entry behind it would never reach the cloud. */
  private transition(subject: AttendanceSubject, step: (current: AttendanceShift | null, id: string) => AttendanceOutcome): AttendanceOutcome {
    const id = this.idOf(subject.user);
    const out = step(this.current(subject.user), id);
    if (out.kind !== 'done') return out;
    const action = confirmedBy(out.action, subject.confirm);
    this.enqueue(action);
    this.putShift(out.shift);
    return { ...out, action };
  }

  private enqueue(action: AttendanceAction) {
    // The demo till's local staff are unknown to the cloud: kept here only.
    if (!cloudIdOf(action.posUserId)) return;
    const list = this.outbox();
    if (list.some((e) => e.id === action.id)) return;
    const now = this.c.now();
    list.push({ id: action.id, body: payloadOf(action), createdAt: now, attempts: 0, nextAt: now, lastError: null, parked: false });
    this.saveOutbox(list);
    this.kick(0);
  }

  clockIn(subject: AttendanceSubject): AttendanceOutcome {
    const roleName = this.cloud(subject.user)?.roleName ?? null;
    return this.transition(subject, (cur, id) => AttendanceMachine.clockIn(cur, id, this.newId(), this.newId(), this.nowIso(), this.c.svc.machineId ?? null, roleName));
  }

  startBreak(subject: AttendanceSubject): AttendanceOutcome {
    return this.transition(subject, (cur) => AttendanceMachine.startBreak(cur, this.newId(), this.newId(), this.nowIso()));
  }

  endBreak(subject: AttendanceSubject): AttendanceOutcome {
    return this.transition(subject, (cur) => AttendanceMachine.endBreak(cur, this.newId(), this.nowIso()));
  }

  clockOut(subject: AttendanceSubject, approval: ClockOutApproval | null, openTables: AttendanceOpenTable[]): AttendanceOutcome {
    return this.transition(subject, (cur) => AttendanceMachine.clockOut(cur, this.newId(), this.nowIso(), approval, openTables));
  }

  /** "בקשת תיקון נוכחות": queued for a manager; nothing changes here until one decides. */
  requestCorrection(subject: AttendanceSubject, kind: CorrectionKind, field: string | null, requestedTime: string, requestedEndTime: string | null, reason: string): AttendanceAction {
    const id = this.idOf(subject.user);
    const request = { id: this.newId(), kind, field, requestedTime, requestedEndTime, reason: reason.trim() };
    const action = confirmedBy(AttendanceMachine.correction(this.current(subject.user), id, this.newId(), this.nowIso(), request), subject.confirm);
    this.enqueue(action);
    return action;
  }

  /* ---------------------------------------------------------------- the queue */

  private kick(ms: number) {
    if (this.stopped) return;
    if (this.sendTimer) clearTimeout(this.sendTimer);
    this.sendTimer = setTimeout(() => {
      this.sendTimer = null;
      void this.run();
    }, ms);
    this.sendTimer.unref?.();
  }

  private async run(): Promise<void> {
    try {
      await this.drain(false);
    } catch (e) {
      this.c.log(`attendance outbox: ${String(e)}`);
    }
    const list = this.outbox();
    if (list.length === 0 || this.stopped) return;
    const next = Math.min(...list.map((e) => e.nextAt));
    this.kick(Math.max(1_000, Math.min(300_000, next - this.c.now())));
  }

  /** Delivers what is due now (`force`: everything, the backoff ignored — the tests, a manual sync). */
  flush(force = true): Promise<void> {
    return this.drain(force);
  }

  private drain(force: boolean): Promise<void> {
    if (this.draining) return this.draining;
    this.draining = this.drainNow(force).finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  private async drainNow(force: boolean): Promise<void> {
    const m = this.c.svc.machineId;
    if (!m) return;
    let changed = false;
    for (const e of this.outbox()) {
      if (this.stopped) break;
      const now = this.c.now();
      if (!force && e.nextAt > now) {
        // In order: a waiting entry holds the ones behind it (a refused one does not).
        if (e.parked) continue;
        break;
      }
      const r = await this.c.svc.api.post(`sync/${m}/attendance/actions`, { ...e.body, sentAt: new Date(now).toISOString() }, { timeoutMs: SEND_TIMEOUT_MS });
      if (r.kind === 'ok') {
        this.saveOutbox(this.outbox().filter((x) => x.id !== e.id));
        changed = true;
        continue;
      }
      const parked = r.kind === 'refused' && r.status >= 400 && r.status < 500 && r.status !== 401 && r.status !== 408 && r.status !== 429;
      const error = r.kind === 'offline' ? r.reason : `HTTP ${r.status}${r.detail ? ` ${r.detail}` : ''}`;
      const list = this.outbox().map((x) => (x.id === e.id ? { ...x, attempts: x.attempts + 1, lastError: error.slice(0, 300), parked, nextAt: this.c.now() + sendBackoffMs(x.attempts + 1, parked) } : x));
      this.saveOutbox(list);
      changed = true;
      if (parked) {
        this.c.log(`attendance: action ${e.id} refused (${error}) — kept`);
        continue;
      }
      break;
    }
    if (changed) this.c.changed();
  }

  /* ---------------------------------------------------------------- the screens' flows */

  private track<T>(p: Promise<T>): Promise<T> {
    this.work = this.work.then(
      () => p,
      () => p,
    );
    return p;
  }

  /** Resolves when the work started so far is over (tests). */
  async idle(): Promise<void> {
    let w: Promise<unknown>;
    do {
      w = this.work;
      await w.catch(() => undefined);
      await new Promise((r) => setImmediate(r));
    } while (w !== this.work);
  }

  private say(text: string | null) {
    this.message = text;
    if (this.messageTimer) clearTimeout(this.messageTimer);
    this.messageTimer = null;
    if (text === null) return;
    this.messageTimer = setTimeout(() => {
      this.messageTimer = null;
      this.message = null;
      this.c.changed();
    }, MESSAGE_MS);
    this.messageTimer.unref?.();
  }

  private closeClock() {
    this.clockOpen = false;
    this.clockSubject = null;
    this.clockLoading = false;
    if (this.sheet && (this.sheet.kind === 'done' || this.sheet.kind === 'clockCode' || this.sheet.kind === 'pick')) this.sheet = null;
    if (this.doneTimer) clearTimeout(this.doneTimer);
    this.doneTimer = null;
  }

  /** The clock's last word, then the sign-in screen again. */
  private clockDone(text: string) {
    this.sheet = { kind: 'done', text };
    this.clockSubject = null;
    if (this.doneTimer) clearTimeout(this.doneTimer);
    this.doneTimer = setTimeout(() => {
      this.doneTimer = null;
      this.closeClock();
      this.c.changed();
    }, CLOCK_DONE_MS);
    this.doneTimer.unref?.();
  }

  private name(u: RosterUser): string {
    return displayName(u);
  }

  /** Which card after a PIN is showing (the gate first, then the panel, then the offer). */
  private sessionCard(user: RosterUser): 'gate' | 'panel' | 'offer' | null {
    const p = this.params();
    if (!p.enabled) return null;
    if (this.gateOf(user)) return 'gate';
    if (this.panelOpen) return 'panel';
    if (this.settled && this.offerArmed && statusOf(this.current(user)) === 'not_working') return 'offer';
    return null;
  }

  /**
   * An action inside a session: at once when no code is due ("קוד עובד בכל פעולה" off, or the PIN of this sign-in a moment
   * ago and `fresh` says it counts), else the code sheet.
   */
  private confirmThen(user: RosterUser, what: string, fresh: boolean, run: (c: ActionConfirmation) => unknown): unknown {
    const auto = withoutPrompt(this.params(), fresh ? this.signedInAt : null, this.c.now());
    if (auto) return run(auto);
    this.sheet = { kind: 'code', user, what, run, error: null };
    return undefined;
  }

  private async punch(s: AttendanceSubject, type: AttendancePunch): Promise<void> {
    const t = (iso: string | null | undefined) => formatLocalTime(iso, this.d.timeZone);
    const refused = (o: AttendanceOutcome): AttendanceShift | null => {
      if (o.kind === 'done') return o.shift;
      this.say(REFUSAL_TEXT[o.reason]);
      return null;
    };
    switch (type) {
      case 'clock_in': {
        this.offerArmed = false;
        this.greetArmed = false;
        const sh = refused(this.clockIn(s));
        if (!sh) return;
        if (s.atClock) this.clockDone(A.clockDoneIn(t(sh.clockInAt), this.name(s.user)));
        else this.say(A.started(t(sh.clockInAt)));
        return;
      }
      case 'break_end': {
        this.greetArmed = false;
        const sh = refused(this.endBreak(s));
        if (!sh) return;
        if (s.atClock) this.clockDone(A.clockDoneBack(t(sh.breaks[sh.breaks.length - 1]?.endAt), this.name(s.user)));
        else this.say(A.welcomeBack(t(sh.clockInAt)));
        return;
      }
      case 'break_start': {
        const sh = refused(this.startBreak(s));
        if (!sh) return;
        if (s.atClock) {
          const open = sh.breaks[sh.breaks.length - 1];
          this.clockDone(A.clockDoneBreak(t(open?.startAt), this.name(s.user)));
          return;
        }
        // A break locks the sale screen: back to the PIN, as the idle lock does — the shift goes on.
        this.panelOpen = false;
        this.say(A.onBreakLocked(this.name(s.user)));
        await this.signOut();
        return;
      }
      case 'clock_out':
        return this.tryClockOut(s, null, false, [], false);
    }
  }

  private async signOut() {
    try {
      await this.c.run('session.logout');
    } catch {
      // A payment on: the sign-out waits for the employee (the card stays).
    }
  }

  private selfMayApprove(user: RosterUser): boolean {
    return permissionState(user, ATTENDANCE_MANAGE) === 'allow';
  }

  /** "סיום משמרת": the checks first (the cloud's tables, the cash not deposited, a manager), then the clock-out. */
  private async tryClockOut(s: AttendanceSubject, approval: ClockOutApproval | null, acknowledged: boolean, seen: AttendanceOpenTable[], walletAcknowledged: boolean): Promise<void> {
    const local = this.d.localOpenTables ? await Promise.resolve(this.d.localOpenTables(s.user)).catch(() => []) : [];
    const cloud = (await this.refresh(s.user).catch(() => null)) ?? this.cloud(s.user);
    let wallet: number | null = null;
    if (!approval && !walletAcknowledged && this.d.walletAgorot) {
      try {
        wallet = await Promise.resolve(this.d.walletAgorot(s.user));
      } catch {
        wallet = null;
      }
    }
    const check = checkClockOut({
      params: this.params(),
      openTables: unionTables(local, cloud?.openTables ?? []),
      selfIsManager: this.selfMayApprove(s.user),
      approved: approval !== null,
      warningAcknowledged: acknowledged,
      walletAgorot: wallet,
      walletMode: drawerAwaySettingsOf(this.c.svc.cloud.parameters()).clockOut,
      walletAcknowledged,
    });
    switch (check.kind) {
      case 'allowed':
        return this.finish(s, approval, seen);
      case 'tables_blocked':
        this.sheet = { kind: 'clockOut', variant: 'blocked', subject: s, tables: check.tables, amountAgorot: 0 };
        return;
      case 'tables_warning':
        this.sheet = { kind: 'clockOut', variant: 'warning', subject: s, tables: check.tables, amountAgorot: 0 };
        return;
      case 'wallet_warning':
        this.sheet = { kind: 'clockOut', variant: 'wallet_warning', subject: s, tables: seen, amountAgorot: check.amountAgorot };
        return;
      case 'wallet_blocked':
        this.sheet = { kind: 'clockOut', variant: 'wallet_blocked', subject: s, tables: seen, amountAgorot: check.amountAgorot };
        return;
      case 'needs_manager':
        this.askManager(s, 'require_manager', seen);
        return;
    }
  }

  private async finish(s: AttendanceSubject, approval: ClockOutApproval | null, tables: AttendanceOpenTable[]): Promise<void> {
    if (this.sheet?.kind === 'clockOut') this.sheet = null;
    const o = this.clockOut(s, approval, tables);
    if (o.kind !== 'done') {
      this.say(REFUSAL_TEXT[o.reason]);
      return;
    }
    const worked = formatWorked(workedMs(o.shift, this.c.now()));
    if (s.atClock) {
      this.clockDone(A.clockDoneOut(formatLocalTime(o.shift.clockOutAt, this.d.timeZone), worked, this.name(s.user)));
      return;
    }
    this.panelOpen = false;
    this.say(A.ended(worked));
    // Not on shift may not sell here: back to the PIN.
    if (this.params().requireClockIn) await this.signOut();
  }

  /** A manager approves the clock-out: a manager clocking out approves their own; anyone else asks for a manager's code. */
  private managerApproves(s: AttendanceSubject, reason: string, tables: AttendanceOpenTable[]): Promise<void> | void {
    if (this.selfMayApprove(s.user)) {
      return this.tryClockOut(s, { posUserId: this.idOf(s.user), name: this.name(s.user), reason }, true, tables, false);
    }
    this.askManager(s, reason, tables);
  }

  private askManager(s: AttendanceSubject, reason: string, tables: AttendanceOpenTable[]) {
    const who = this.name(s.user);
    const prompt = reason === 'open_tables' ? A.managerReasonTables(who) : reason === 'wallet' ? A.managerReasonWallet(who) : A.managerReasonClockOut(who);
    this.sheet = {
      kind: 'manager',
      prompt,
      error: null,
      run: (by) => this.tryClockOut(s, { posUserId: this.idOf(by), name: by.name, reason }, true, tables, false),
    };
  }

  private cardButtons(status: ReturnType<typeof statusOf>, atClock: boolean): AttendanceButton[] {
    if (atClock) {
      return clockActions(status).map((a) => ({
        action: a,
        label: a === 'clock_in' ? A.clockActionIn : a === 'clock_out' ? A.clockActionOut : a === 'break_start' ? A.breakStart : A.breakEnd,
        tone: a === 'clock_out' ? 'danger' : a === 'break_start' ? 'tonal' : 'primary',
      }));
    }
    if (status === 'not_working') return [{ action: 'clock_in', label: A.clockIn, tone: 'primary' }];
    if (status === 'working') return [
      { action: 'break_start', label: A.breakStart, tone: 'tonal' },
      { action: 'clock_out', label: A.clockOut, tone: 'danger' },
    ];
    return [
      { action: 'break_end', label: A.breakEnd, tone: 'primary' },
      { action: 'clock_out', label: A.clockOut, tone: 'danger' },
    ];
  }

  /* ---------------------------------------------------------------- the ops */

  apply(op: string, a: Record<string, unknown>): unknown {
    switch (op as AttendanceOp) {
      case 'attendance.open':
        return this.openPanel();
      case 'attendance.close':
        return this.close();
      case 'attendance.clock':
        return this.openClock();
      case 'attendance.act':
        return this.act(a.action);
      case 'attendance.code':
        return this.code(a.pin);
      case 'attendance.behalf':
        return this.behalf();
      case 'attendance.manager':
        return this.manager(a.pin);
      case 'attendance.pick':
        return this.pick(a.userId);
      case 'attendance.clockOutChoice':
        return this.clockOutChoice(a.choice);
      case 'attendance.transfer':
        return this.transfer();
      case 'attendance.correction':
        return this.openCorrection();
      case 'attendance.correctionSend':
        return this.correctionSend(a);
      case 'attendance.signOut':
        return this.gateSignOut();
      default:
        return this.c.refuse('invalid_args');
    }
  }

  private enabled(): AttendanceParams {
    const p = this.params();
    if (!p.enabled) this.c.refuse('invalid_args');
    return p;
  }

  /** "נוכחות" in the menu: the panel, the cloud asked again. */
  private openPanel() {
    this.enabled();
    const user = this.c.signedIn();
    this.panelOpen = true;
    this.offerArmed = false;
    this.busy = true;
    this.track(
      this.c.later(async () => {
        this.cloudAnswered = (await this.refresh(user)) !== null;
        this.busy = false;
        this.c.changed();
      }),
    );
    return undefined;
  }

  /** "ביטול" / "סגירה" / "המשך בלי משמרת": the top sheet, else the card; the gate stays (it has its own ways out). */
  private close() {
    const s = this.sheet;
    if (s) {
      if (this.codeBusy) return undefined;
      // The clock's own steps close the clock; a session's questions go back to the card under them.
      if (this.clockOpen && (s.kind === 'clockCode' || s.kind === 'pick' || s.kind === 'done' || (s.kind === 'manager' && !this.clockSubject))) this.closeClock();
      this.sheet = null;
      return undefined;
    }
    if (this.clockOpen) {
      this.closeClock();
      return undefined;
    }
    if (this.panelOpen) {
      this.panelOpen = false;
      return undefined;
    }
    this.offerArmed = false;
    this.say(null);
    return undefined;
  }

  /** "שעון נוכחות" on the sign-in screen: the code first; nothing of the last employee stays. */
  private openClock() {
    const p = this.enabled();
    if (this.c.operator()) return this.c.refuse('invalid_args');
    if (!this.clockAllowed(p)) return this.c.refuse('invalid_args');
    this.closeClock();
    this.clockOpen = true;
    this.sheet = { kind: 'clockCode', error: null };
    return undefined;
  }

  private clockAllowed(p: AttendanceParams): boolean {
    return clockShown(p, this.c.svc.cloud.machine()?.deviceRole ?? null, this.d.kioskTakenForStaff?.() === true, this.d.kdsScreen?.() === true);
  }

  private act(raw: unknown) {
    if (raw !== 'clock_in' && raw !== 'break_start' && raw !== 'break_end' && raw !== 'clock_out') return this.c.refuse('invalid_args');
    const type: AttendancePunch = raw;
    this.enabled();
    if (this.busy) return undefined;
    // At the clock: the card's employee, confirmed by the code typed (or a manager's).
    if (this.clockOpen && this.clockSubject) {
      if (this.clockLoading) return undefined;
      return this.runPunch(this.clockSubject, type);
    }
    const user = this.c.signedIn();
    const kind = this.sessionCard(user);
    const fresh = kind === 'gate' || kind === 'offer';
    return this.confirmThen(user, ACTION_WORD[type], fresh, (confirm) => this.runPunch({ user, confirm, atClock: false }, type));
  }

  private runPunch(s: AttendanceSubject, type: AttendancePunch) {
    if (type === 'clock_out') {
      this.busy = true;
      this.track(
        this.c.later(async () => {
          try {
            await this.punch(s, type);
          } catch (e) {
            this.c.log(`attendance: ${String(e)}`);
            this.say(A.failed);
          }
          this.busy = false;
          this.c.changed();
        }),
      );
      return undefined;
    }
    return this.punch(s, type).catch((e) => {
      this.c.log(`attendance: ${String(e)}`);
      this.say(A.failed);
    });
  }

  /** The code typed on the sheet: the employee's own (a session), or anyone's (the clock). */
  private async code(raw: unknown) {
    if (typeof raw !== 'string') return this.c.refuse('invalid_args');
    const pin = raw.trim();
    const s = this.sheet;
    if (!s || (s.kind !== 'code' && s.kind !== 'clockCode') || this.codeBusy) return undefined;
    const verify = (p: string, h: string | null | undefined) => verifyPin(p, h, this.c.compare);
    this.codeBusy = true;
    try {
      if (s.kind === 'code') {
        const r = await checkCode(pin, [s.user], this.codeAttempts, this.idOf(s.user), verify);
        if (r.kind === 'match' || r.kind === 'ambiguous') {
          this.sheet = null;
          this.codeBusy = false;
          await s.run(ownCode(CONFIRM.IN_SESSION));
          return { ok: true };
        }
        s.error = r.kind === 'wrong' ? A.codeWrong : null;
        return { ok: false };
      }
      const roster = loginCandidates(this.c.roster(), this.c.shopId());
      const r = await checkCode(pin, roster, this.codeAttempts, CLOCK_ATTEMPTS_KEY, verify);
      if (r.kind === 'match') {
        this.openCard({ user: r.user, confirm: ownCode(CONFIRM.CLOCK), atClock: true });
        return { ok: true };
      }
      if (r.kind === 'ambiguous') {
        this.sheet = { kind: 'pick', users: r.users, forManager: false };
        return { ok: true };
      }
      s.error = r.kind === 'wrong' ? A.codeWrong : null;
      return { ok: false };
    } finally {
      this.codeBusy = false;
    }
  }

  /** The card for an employee at the clock, the cloud asked first (the shift may be open at another till). */
  private openCard(s: AttendanceSubject) {
    this.sheet = null;
    this.clockSubject = s;
    this.clockLoading = true;
    this.track(
      this.c.later(async () => {
        const answered = (await this.refresh(s.user)) !== null;
        if (this.clockSubject === s) {
          this.cloudAnswered = answered;
          this.clockLoading = false;
        }
        this.c.changed();
      }),
    );
  }

  /** "אישור מנהל" on the code sheet / "פעולה בשם עובד" at the clock: a manager's code acting for the employee. */
  private behalf() {
    this.enabled();
    const s = this.sheet;
    if (s?.kind === 'clockCode') {
      this.sheet = { kind: 'pick', users: loginCandidates(this.c.roster(), this.c.shopId()), forManager: true };
      return undefined;
    }
    if (s?.kind !== 'code') return this.c.refuse('invalid_args');
    const subjectId = this.idOf(s.user);
    this.sheet = {
      kind: 'manager',
      prompt: A.onBehalfReason(this.name(s.user), s.what),
      error: null,
      run: (by) => s.run(byManager(subjectId, this.idOf(by), by.name, CONFIRM.IN_SESSION)),
    };
    return undefined;
  }

  /** A manager's code (ATTENDANCE_MANAGE), checked here against the roster — offline, five wrong then a minute. */
  private async manager(raw: unknown) {
    if (typeof raw !== 'string') return this.c.refuse('invalid_args');
    const s = this.sheet;
    if (!s || s.kind !== 'manager' || this.codeBusy) return undefined;
    this.codeBusy = true;
    try {
      const out = await approve({ users: this.c.roster(), shopId: this.c.shopId(), code: ATTENDANCE_MANAGE, pin: raw, lock: this.managerLock, nowMs: this.c.now(), compare: this.c.compare });
      if (!out.ok) {
        this.managerLock = out.lock;
        s.error = out.message;
        return { ok: false };
      }
      this.managerLock = NO_LOCK;
      this.sheet = null;
      this.codeBusy = false;
      const by: ApproverRef = { id: out.user.id, name: displayName(out.user) };
      const v = s.run(by);
      if (v instanceof Promise) {
        this.busy = true;
        this.track(
          this.c.later(async () => {
            try {
              await v;
            } catch (e) {
              this.c.log(`attendance: ${String(e)}`);
              this.say(A.failed);
            }
            this.busy = false;
            this.c.changed();
          }),
        );
      }
      return { ok: true };
    } finally {
      this.codeBusy = false;
    }
  }

  /** A name: whose code it is (two share one), or whom a manager acts for at the clock. */
  private pick(raw: unknown) {
    const s = this.sheet;
    if (typeof raw !== 'string' || s?.kind !== 'pick') return this.c.refuse('invalid_args');
    const who = s.users.find((u) => u.id === raw);
    if (!who) return this.c.refuse('invalid_args');
    if (!s.forManager) {
      this.openCard({ user: who, confirm: ownCode(CONFIRM.CLOCK), atClock: true });
      return undefined;
    }
    const subjectId = this.idOf(who);
    this.sheet = {
      kind: 'manager',
      prompt: A.onBehalfReason(this.name(who), A.clockTitle),
      error: null,
      run: (by) => this.openCard({ user: who, confirm: byManager(subjectId, this.idOf(by), by.name, CONFIRM.CLOCK), atClock: true }),
    };
    return undefined;
  }

  /** The clock-out sheet's buttons: "סיים בכל זאת" (a warning) or "אישור מנהל" (blocked). */
  private clockOutChoice(raw: unknown) {
    const s = this.sheet;
    if ((raw !== 'finish' && raw !== 'approve') || s?.kind !== 'clockOut') return this.c.refuse('invalid_args');
    const blocked = s.variant === 'blocked' || s.variant === 'wallet_blocked';
    if (raw === 'finish' && blocked) return this.c.refuse('invalid_args');
    if (raw === 'approve' && !blocked) return this.c.refuse('invalid_args');
    if (this.busy) return undefined;
    this.sheet = null;
    this.busy = true;
    this.track(
      this.c.later(async () => {
        try {
          if (raw === 'finish') {
            if (s.variant === 'wallet_warning') await this.tryClockOut(s.subject, null, true, s.tables, true);
            else await this.tryClockOut(s.subject, null, true, s.tables, false);
          } else await this.managerApproves(s.subject, s.variant === 'wallet_blocked' ? 'wallet' : 'open_tables', s.tables);
        } catch (e) {
          this.c.log(`attendance: ${String(e)}`);
          this.say(A.failed);
        }
        this.busy = false;
        this.c.changed();
      }),
    );
    return undefined;
  }

  /** "העברת שולחנות": to the tables (inside a session only — nobody is signed in at the clock). */
  private transfer() {
    if (!this.d.toTables || this.sheet?.kind !== 'clockOut' || this.sheet.subject.atClock) return this.c.refuse('invalid_args');
    this.sheet = null;
    this.panelOpen = false;
    this.d.toTables();
    return undefined;
  }

  /** "בקשת תיקון נוכחות" (the panel) / "בקשת תיקון" (the clock's card): the form. */
  private openCorrection() {
    this.enabled();
    if (this.clockOpen && this.clockSubject) {
      this.sheet = { kind: 'correction', subject: this.clockSubject };
      return undefined;
    }
    const user = this.c.signedIn();
    // In a session the code is asked when it is sent — the moment of the action.
    this.sheet = { kind: 'correction', subject: { user, confirm: null, atClock: false } };
    return undefined;
  }

  private correctionSend(a: Record<string, unknown>) {
    const s = this.sheet;
    if (s?.kind !== 'correction') return this.c.refuse('invalid_args');
    const kind = a.kind as CorrectionKind;
    if (!CORRECTION_KINDS.includes(kind)) return this.c.refuse('invalid_args');
    const daysBack = a.daysBack === 1 ? 1 : a.daysBack === 0 || a.daysBack === undefined ? 0 : -1;
    if (daysBack < 0) return this.c.refuse('invalid_args');
    const field = kind === 'wrong_time' ? (a.field === 'clock_out' ? 'clock_out' : a.field === 'clock_in' || a.field === undefined ? 'clock_in' : null) : null;
    if (kind === 'wrong_time' && !field) return this.c.refuse('invalid_args');
    const reason = typeof a.reason === 'string' ? a.reason.trim().slice(0, 500) : '';
    const today = todayIn(this.c.now(), this.d.timeZone);
    const at = typeof a.time === 'string' ? correctionTimeIso(daysBack, a.time, today, this.d.timeZone) : null;
    const endRaw = typeof a.end === 'string' && (kind === 'break' || kind === 'missing_in') ? a.end.trim() : '';
    const end = endRaw ? correctionTimeIso(daysBack, endRaw, today, this.d.timeZone) : null;
    if (!at || (endRaw && !end) || !reason) return this.c.refuse('invalid_args');
    const send = (subject: AttendanceSubject) => {
      this.requestCorrection(subject, kind, field, at, end, reason);
      if (this.sheet?.kind === 'correction') this.sheet = null;
      if (subject.atClock) this.clockDone(A.clockDoneCorrection(this.name(subject.user)));
      else this.say(A.correctionSent);
    };
    if (s.subject.confirm) {
      send(s.subject);
      return undefined;
    }
    const user = s.subject.user;
    this.sheet = null;
    return this.confirmThen(user, ACTION_WORD.correction_request, false, (confirm) => send({ user, confirm, atClock: false }));
  }

  /** The gate's "יציאה": the till's sign-out (the shift, if any, goes on). */
  private async gateSignOut() {
    this.c.signedIn();
    await this.signOut();
    return undefined;
  }

  /* ---------------------------------------------------------------- the state */

  state(): AttendanceState | undefined {
    const p = this.params();
    if (!p.enabled) return undefined;
    const user = this.c.operator();
    const uid = user?.id ?? null;
    if (uid !== this.lastOperatorId) {
      this.lastOperatorId = uid;
      this.onOperator(user);
    }
    const now = this.c.now();
    const tz = this.d.timeZone;
    let card: AttendanceCard | null = null;
    let cardKind: AttendanceState['cardKind'] = null;
    if (user) {
      const kind = this.sessionCard(user);
      if (kind) {
        const shift = this.current(user);
        const st = statusOf(shift);
        const cloud = this.cloud(user);
        const name = this.name(user);
        cardKind = kind;
        card = {
          userId: user.id,
          title: kind === 'panel' ? `${A.menu} · ${name}` : A.hello(name),
          status: statusLine(shift, tz),
          lines: kind === 'gate' ? [st === 'on_break' ? A.gateBreak : A.gateRequired] : kind === 'panel' ? panelLines(shift, cloud, now) : [],
          offline: !this.cloudAnswered,
          buttons: kind === 'gate' ? (st === 'on_break' ? [{ action: 'break_end', label: A.breakEnd, tone: 'primary' }] : [{ action: 'clock_in', label: A.clockIn, tone: 'primary' }]) : kind === 'offer' ? [{ action: 'clock_in', label: A.clockIn, tone: 'primary' }] : this.cardButtons(st, false),
          loading: false,
        };
      }
    } else if (this.clockOpen && this.clockSubject) {
      const who = this.clockSubject.user;
      const shift = this.current(who);
      const cloud = this.cloud(who);
      const behalf = this.clockSubject.confirm?.onBehalf ?? null;
      cardKind = 'clock';
      card = {
        userId: who.id,
        title: A.hello(this.name(who)),
        status: this.clockLoading ? A.checking : statusLine(shift, tz),
        lines: [...(behalf ? [A.clockByManager(behalf.name)] : []), ...panelLines(shift, cloud, now, { breaks: false })],
        offline: !this.clockLoading && !this.cloudAnswered,
        buttons: this.cardButtons(statusOf(shift), true),
        loading: this.clockLoading,
      };
    }
    return {
      clockShown: !user && this.clockAllowed(p),
      clockOpen: this.clockOpen,
      menuLine: user ? statusLine(this.current(user), tz) : null,
      gate: this.gateOf(user),
      card,
      cardKind,
      sheet: this.sheetView(),
      message: this.message,
      busy: this.busy || this.codeBusy,
      unsent: this.outbox().length,
    };
  }

  private sheetView(): AttendanceSheet | null {
    const s = this.sheet;
    if (!s) return null;
    switch (s.kind) {
      case 'code':
        return { kind: 'code', title: A.codeTitle, prompt: A.codePrompt(this.name(s.user), s.what), error: s.error, lockedSeconds: this.codeAttempts.lockedForSeconds(this.idOf(s.user)), busy: this.codeBusy, alternative: A.managerApproval };
      case 'clockCode':
        return { kind: 'code', title: A.clockTitle, prompt: A.clockCodeHint, error: s.error, lockedSeconds: this.codeAttempts.lockedForSeconds(CLOCK_ATTEMPTS_KEY), busy: this.codeBusy, alternative: A.clockOnBehalf };
      case 'manager': {
        const left = Math.max(0, this.managerLock.lockedUntilMs - this.c.now());
        return { kind: 'manager', title: A.managerApproval, prompt: s.prompt, error: left > 0 ? null : s.error, lockedSeconds: Math.floor((left + 999) / 1000), busy: this.codeBusy };
      }
      case 'pick':
        return { kind: 'pick', title: s.forManager ? A.clockPickEmployee : A.clockPickSelf, users: s.users.map((u) => ({ id: u.id, name: this.name(u) })) };
      case 'clockOut': {
        const wallet = s.variant === 'wallet_warning' || s.variant === 'wallet_blocked';
        const blocked = s.variant === 'blocked' || s.variant === 'wallet_blocked';
        const amount = formatShekelSign(s.amountAgorot);
        return {
          kind: 'clockOut',
          variant: s.variant,
          title: wallet ? A.walletTitle : blocked ? A.blockedTitle : A.warningTitle,
          body: wallet ? (blocked ? A.walletBlockedBody(amount) : A.walletBody(amount)) : blocked ? A.blockedBody : A.warningBody,
          lines: wallet ? [] : s.tables.map(tableLine),
          // Handing a table over is done inside the till: nobody is signed in at the clock.
          transferHint: !wallet && s.subject.atClock ? A.clockTransferHint : null,
          canApprove: blocked,
          canFinish: !blocked,
          canTransfer: !wallet && !s.subject.atClock && !!this.d.toTables,
        };
      }
      case 'correction':
        return { kind: 'correction', busy: this.busy };
      case 'done':
        return { kind: 'done', text: s.text };
    }
  }

  stop(): void {
    this.stopped = true;
    for (const t of [this.sendTimer, this.messageTimer, this.doneTimer]) if (t) clearTimeout(t);
    this.sendTimer = null;
    this.messageTimer = null;
    this.doneTimer = null;
  }
}
