/**
 * "מגירת מזומן" — the one way a drawer opens on the Windows till (pos-android data/repo/CashDrawerService.kt; the owner's drawer
 * spec §19: "אין לבנות פונקציה כללית openDrawer() … כל פתיחה חייבת לעבור דרך CashDrawerService.requestOpen()"). The sale's
 * cash, the manual "פתח מגירה", cash in / out / deposit, a count, an employee's deposit, another till's drawer and an opening
 * after the close all come here; the printer's drawer command is reached through `kick` only, which nothing else is handed.
 *
 * The order of every request (spec §19): who → role and permission → context and reason → the sale / payment → the shift →
 * the limits → a manager's override (one action; the signed-in user never changes; both names recorded) → the audit row →
 * the physical command → the result. A refused or failed request is recorded and sends no command. Offline changes none of
 * it: the profile, the parameters, the counts and the approvers' PIN hashes are all on the till, and the audit waits in the
 * outbox with its own id.
 */

import { randomUUID } from 'node:crypto';
import {
  DRAWER_CONTEXT,
  MOVEMENT,
  approvalText,
  cashDrawerModeOf,
  decisionOf,
  drawerAskSettingsOf,
  drawerModeHasButton,
  drawerModeOpensOnCash,
  drawerSettingsOf,
  evaluateDrawer,
  mayApproveDrawer,
  movementsNet,
  movementTotalsOf,
  requestIsManual,
  requestPaymentLike,
  walletTotalsOf,
  type CashMovementTotals,
  type DrawerContext,
  type DrawerRequest,
  type DrawerSettings,
  type DrawerUser,
  type DrawerVerdict,
  type WalletTotals,
} from '../../core/till/drawer';
import {
  AWAY_NONE,
  AWAY_WALLET,
  WALLET_REASON_DEPOSIT,
  WALLET_REASON_IN,
  drawerAwaySettingsOf,
  walletSourceOf,
  walletVariance,
  type DrawerAwayPolicy,
  type WalletBalance,
} from '../../core/till/drawerAway';
import type { CashMovementRow, DrawerEventRow, DrawerStore } from './drawerStore';

/** Who acts at the drawer: the signed-in employee, or the manager who approved (their profile with its limits). */
export interface DrawerPerson extends DrawerUser {
  id: string;
  name: string;
  tillRoleName?: string | null;
}

/** Where a drawer is: this till's own (its receipt printer's port), or another till's (a drawer job, §9ב–§9ג). */
export type DrawerTarget =
  | { kind: 'own'; id: string; name: string }
  | {
      kind: 'remote';
      id: string;
      name: string;
      host: { machineId: string; printerId: string | null; label: string };
      /** A payment's: the document that went there (its type code and number). */
      documentType?: string | null;
      documentNumber?: string | null;
    };

/** What a drawer job carries to the other till (bill-print-other-till §10.9). */
export interface DrawerJob {
  id: string;
  reason: 'payment' | 'manual';
  documentType: string | null;
  documentNumber: string | null;
  amount: number | null;
  reasonCode: string | null;
  reasonNote: string | null;
  requestedBy: { id: string | null; name: string | null };
  approvedBy: { id: string; name: string; method: 'pin' } | null;
  shiftId: string | null;
  sourceMachineId: string | null;
}

/** What `requestOpen` came to. */
export type DrawerOutcome =
  | { kind: 'opened'; eventId: string; expectedAgorot: number | null }
  | { kind: 'approval'; verdict: Extract<DrawerVerdict, { kind: 'approval' }>; message: string }
  | { kind: 'choose'; drawers: DrawerTarget[] }
  | { kind: 'denied'; reason: string }
  | { kind: 'failed'; reason: string }
  /** Allowed, and no drawer is connected here: a movement or a count is still recorded — the cash moved by hand. */
  | { kind: 'no_drawer'; eventId: string; expectedAgorot: number | null };

export interface DrawerServiceDeps {
  store: DrawerStore;
  /** The employee signed in now. */
  operator(): DrawerPerson | null;
  parameters(): Record<string, unknown>;
  /** This till's own drawer as a destination (its receipt printer); whether it opens is `cashDrawer`'s word. */
  ownDrawer(): { id: string; name: string } | null;
  /** The physical command (or another till's job, answered). Throws when the drawer did not open. Only this service holds it. */
  kick(target: DrawerTarget, job: DrawerJob | null): Promise<void>;
  currentShiftId(): string | null;
  /** The open shift's expected drawer balance (spec §8) with the movements and wallets as recorded now; null with no shift. */
  expectedBalance(): number | null;
  identity(): { companyId: string | null; shopId: string | null; machineId: string | null; deviceId: string | null };
  online(): boolean;
  enqueue(kind: 'drawer_event' | 'cash_movement', id: string): void;
  now?: () => string;
  newId?: () => string;
  warn?: (m: string) => void;
}

export class CashDrawerService {
  private readonly now: () => string;
  private readonly newId: () => string;
  private readonly warn: (m: string) => void;

  constructor(private readonly d: DrawerServiceDeps) {
    this.now = d.now ?? (() => new Date().toISOString());
    this.newId = d.newId ?? (() => randomUUID());
    this.warn = d.warn ?? (() => undefined);
  }

  get store(): DrawerStore {
    return this.d.store;
  }

  settings(): DrawerSettings {
    return drawerSettingsOf(this.params());
  }

  private params(): Record<string, unknown> {
    try {
      return this.d.parameters();
    } catch {
      return {};
    }
  }

  /** `cashDrawer` now ("בתשלום מזומן — לשאול": asks). */
  drawerMode() {
    return cashDrawerModeOf(this.params());
  }

  /** "לפתוח מגירה?": how long it waits, and what it does unanswered (§9א). */
  askSettings() {
    return drawerAskSettingsOf(this.params());
  }

  /** "מגירה כשהעובד לא ליד המגירה" (P:/specs/drawer-away.md §5.1) as the cloud merged it for this device. */
  awaySettings() {
    return drawerAwaySettingsOf(this.params());
  }

  /** The open shift's expected drawer balance now (spec §8), or null with no shift. */
  expectedNow(): number | null {
    try {
      return this.d.expectedBalance();
    } catch {
      return null;
    }
  }

  /** The movements and wallets of a shift, as its X and its close take them. */
  shiftTotals(shiftId: string): { movements: CashMovementTotals; wallets: WalletTotals } {
    const rows = this.d.store.movementsOfShift(shiftId);
    return { movements: movementTotalsOf(rows), wallets: walletTotalsOf(rows) };
  }

  /** Steps 1–7 for `request`, from what the till knows now. */
  evaluate(request: DrawerRequest): DrawerVerdict {
    const shiftId = this.d.currentShiftId();
    const me = this.d.operator();
    const manual = shiftId && me ? this.d.store.manualOpensOfShift(shiftId, me.id) : 0;
    return evaluateDrawer(request, { user: me, shiftOpen: shiftId !== null, settings: this.settings(), manualOpensThisShift: manual });
  }

  /** This till's own drawers a request may open: on a payment those that open on cash, on the button those with the button. */
  targets(request: DrawerRequest): DrawerTarget[] {
    const own = this.d.ownDrawer();
    if (!own) return [];
    const mode = this.drawerMode();
    const ok = requestPaymentLike(request) ? drawerModeOpensOnCash(mode) : drawerModeHasButton(mode);
    return ok ? [{ kind: 'own', id: own.id, name: own.name }] : [];
  }

  /** Whether `request` would ask "איזו מגירה לפתוח?": the drawers — null when it would not (one, or none). */
  choiceFor(request: DrawerRequest): DrawerTarget[] | null {
    const list = this.targets(request);
    return list.length > 1 ? list : null;
  }

  /**
   * §9א: the cashier said "לא" to "לפתוח מגירה?" (`timedOut`: nobody answered and the default is to skip). Written to the
   * drawer's log — not opened, and no exception: `failed` with the reason, never `denied`.
   */
  recordDeclined(request: DrawerRequest, timedOut: boolean): void {
    const verdict = this.evaluate(request);
    this.audit(this.newId(), request, verdict, {
      result: 'failed',
      reason: timedOut ? 'לא נפתחה — לא נענתה השאלה' : 'לא נפתחה — בחירת הקופאי',
      decision: decisionOf(verdict),
      extra: { askDeclined: true, askTimedOut: timedOut },
    });
    this.warn(`drawer: "לפתוח מגירה?" — ${timedOut ? 'no answer' : 'no'} by ${this.d.operator()?.name ?? '-'} (sale ${request.saleId ?? '-'})`);
  }

  /**
   * §5.3: a cash payment on a device away from the drawer that opened nothing here — "הכסף אצלי" (`wallet`: the cash written
   * to the employee's wallet, a `wallet_in` movement, §5.4) or "בלי מגירה" (`none`). The drawer's log says so (`CASH_SALE`,
   * `failed`, `details.drawerAway`) — never an exception. Returns the wallet's movement.
   */
  recordAway(request: DrawerRequest, choice: string, policy: DrawerAwayPolicy, cashAgorot: number | null, dismissed = false): CashMovementRow | null {
    const verdict = this.evaluate(request);
    const eventId = this.newId();
    const wallet = choice === AWAY_WALLET && cashAgorot !== null && cashAgorot > 0;
    let movement: CashMovementRow | null = null;
    if (wallet) {
      const me = this.d.operator();
      // The drawer's expected before the money left it for the employee's hands, and after.
      const before = this.expectedNow();
      const row: CashMovementRow = {
        id: this.newId(),
        type: MOVEMENT.WALLET_IN,
        amountAgorot: cashAgorot!,
        expectedBeforeAgorot: before,
        expectedAfterAgorot: before === null ? null : before - cashAgorot!,
        varianceAgorot: null,
        blind: false,
        reason: WALLET_REASON_IN,
        note: [request.documentType, request.documentNumber].filter(Boolean).join(' ') || null,
        source: walletSourceOf(request.saleId),
        shiftId: this.d.currentShiftId(),
        employeeId: me?.id ?? null,
        employeeName: me?.name ?? null,
        approverId: null,
        approverName: null,
        drawerEventId: eventId,
        offline: !this.d.online(),
        occurredAt: this.now(),
      };
      try {
        this.d.store.putMovement(row);
        this.d.enqueue('cash_movement', row.id);
        movement = row;
      } catch (e) {
        this.warn(`drawer: wallet not recorded — ${String(e)}`);
      }
    }
    this.audit(
      eventId,
      { ...request, movementId: movement?.id ?? request.movementId ?? null },
      verdict,
      {
        result: 'failed',
        reason: wallet ? 'הכסף אצל העובד' : 'בלי מגירה — רישום בלבד',
        decision: decisionOf(verdict),
        extra: { drawerAway: wallet ? AWAY_WALLET : AWAY_NONE, awayPolicy: policy, askDismissed: dismissed ? true : null },
      },
    );
    this.warn(`drawer: cash payment away from the drawer — ${wallet ? `kept by ${this.d.operator()?.name ?? '-'}` : 'recorded only'} (sale ${request.saleId ?? '-'})`);
    return movement;
  }

  /**
   * "הפקדת מזומן מעובד" (§5.4): `owner`'s cash counted into this drawer — `expected` what their wallet holds (the cloud's,
   * shown), `counted` what went in. One decision under CASH_DRAWER.WALLET_DEPOSIT, two records: the opening (`WALLET_DEPOSIT`)
   * and the `wallet_deposit` movement with its variance. With no drawer here the movement is written all the same.
   */
  walletDeposit(owner: WalletBalance, expectedAgorot: number, countedAgorot: number, target: DrawerTarget | null = null, approver: DrawerPerson | null = null, movementId: string | null = null): Promise<DrawerOutcome> {
    const id = movementId ?? this.newId();
    const request: DrawerRequest = { context: 'WALLET_DEPOSIT', reason: WALLET_REASON_DEPOSIT, note: owner.employeeName, amountAgorot: countedAgorot, movementId: id };
    return this.requestOpen(request, target, approver, (eventId) => {
      const me = this.d.operator();
      this.d.store.putMovement({
        id,
        type: MOVEMENT.WALLET_DEPOSIT,
        amountAgorot: countedAgorot,
        expectedBeforeAgorot: expectedAgorot,
        expectedAfterAgorot: 0,
        varianceAgorot: walletVariance(countedAgorot, expectedAgorot),
        blind: false,
        reason: WALLET_REASON_DEPOSIT,
        note: null,
        source: null,
        shiftId: this.d.currentShiftId(),
        // Whose wallet it was; who received it.
        employeeId: owner.employeeId,
        employeeName: owner.employeeName,
        approverId: me?.id ?? null,
        approverName: me?.name ?? null,
        drawerEventId: eventId,
        offline: !this.d.online(),
        occurredAt: this.now(),
      });
      this.d.enqueue('cash_movement', id);
    });
  }

  /**
   * Decide, record and — only when allowed — open. Call again with `approver` after an `approval`, with `target` after a
   * `choose`. `beforeKick` runs once the request is allowed, before the audit row and the command: a cash movement is written
   * there, so the opening and the movement share their ids.
   */
  async requestOpen(request: DrawerRequest, target: DrawerTarget | null = null, approver: DrawerPerson | null = null, beforeKick?: (eventId: string) => void): Promise<DrawerOutcome> {
    const verdict = this.evaluate(request);
    const eventId = this.newId();
    if (verdict.kind === 'refused') {
      this.audit(eventId, request, verdict, { result: 'denied', reason: verdict.why, decision: 'deny' });
      return { kind: 'denied', reason: verdict.why };
    }
    if (verdict.kind === 'approval') {
      if (!approver) return { kind: 'approval', verdict, message: approvalText(verdict.permission, verdict.why) };
      if (!mayApproveDrawer(approver, verdict)) {
        const why = `${approver.name} אינו מורשה לאשר פעולה זו`;
        this.audit(eventId, request, verdict, { result: 'denied', reason: why, decision: 'approval', approver });
        return { kind: 'denied', reason: why };
      }
    }
    let drawer = target;
    if (!drawer) {
      const list = this.targets(request);
      if (list.length === 0) {
        const why = 'אין מגירה מחוברת לקופה';
        const expected = this.expectedNow();
        const recordsAnyway = !!beforeKick || request.context === 'COUNT' || request.context === 'BLIND_COUNT';
        if (beforeKick) {
          try {
            beforeKick(eventId);
          } catch (e) {
            this.warn(`drawer: movement — ${String(e)}`);
          }
        }
        this.audit(eventId, request, verdict, { result: 'failed', reason: why, decision: decisionOf(verdict), approver, expected });
        return recordsAnyway ? { kind: 'no_drawer', eventId, expectedAgorot: expected } : { kind: 'failed', reason: why };
      }
      if (list.length > 1) return { kind: 'choose', drawers: list };
      drawer = list[0];
    }
    const expected = this.expectedNow();
    try {
      beforeKick?.(eventId);
    } catch (e) {
      this.warn(`drawer: before the kick — ${String(e)}`);
    }
    // Another till's drawer: the job says what it is for, by whom, approved by whom — its id the audit row's.
    let job: DrawerJob | null = null;
    if (drawer.kind === 'remote') {
      const me = this.d.operator();
      job = {
        id: eventId,
        reason: request.context === 'CASH_SALE' ? 'payment' : 'manual',
        documentType: drawer.documentType ?? request.documentType ?? null,
        documentNumber: drawer.documentNumber ?? request.documentNumber ?? null,
        amount: request.amountAgorot === null || request.amountAgorot === undefined ? null : request.amountAgorot / 100,
        reasonCode: request.reason ?? null,
        reasonNote: request.note ?? null,
        requestedBy: { id: me?.id ?? null, name: me?.name ?? null },
        approvedBy: approver ? { id: approver.id, name: approver.name, method: 'pin' } : null,
        shiftId: this.d.currentShiftId(),
        sourceMachineId: this.d.identity().machineId,
      };
    }
    // The audit row before the command (spec §19), then the command, then its result.
    this.audit(eventId, request, verdict, { result: 'pending', decision: decisionOf(verdict), approver, drawer, expected, enqueue: false, jobId: job?.id ?? null });
    let failure: string | null = null;
    try {
      await this.d.kick(drawer, job);
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    }
    const row = this.d.store.event(eventId);
    if (row) {
      this.d.store.putEvent({ ...row, result: failure === null ? 'approved' : 'failed', resultReason: failure?.slice(0, 300) ?? null });
      this.d.enqueue('drawer_event', eventId);
    }
    return failure === null ? { kind: 'opened', eventId, expectedAgorot: expected } : { kind: 'failed', reason: failure };
  }

  /** Cash In / Cash Out / Deposit (spec §7): the movement, its expected balance before and after (§8), and the drawer opened for it. */
  cashMovement(
    context: 'CASH_IN' | 'CASH_OUT' | 'DEPOSIT',
    amountAgorot: number,
    reason: string | null,
    note: string | null,
    o: { source?: string | null; target?: DrawerTarget | null; approver?: DrawerPerson | null; movementId?: string | null } = {},
  ): Promise<DrawerOutcome> {
    const movementId = o.movementId ?? this.newId();
    const request: DrawerRequest = { context, reason: reason ?? DRAWER_CONTEXT[context].eventType, note, amountAgorot, movementId };
    const type = context === 'CASH_IN' ? MOVEMENT.CASH_IN : context === 'CASH_OUT' ? MOVEMENT.CASH_OUT : MOVEMENT.DEPOSIT;
    return this.requestOpen(request, o.target ?? null, o.approver ?? null, (eventId) => {
      const before = this.expectedNow();
      const after = before === null ? null : type === MOVEMENT.CASH_IN ? before + amountAgorot : before - amountAgorot;
      const me = this.d.operator();
      this.d.store.putMovement({
        id: movementId,
        type,
        amountAgorot,
        expectedBeforeAgorot: before,
        expectedAfterAgorot: after,
        varianceAgorot: null,
        blind: false,
        reason,
        note,
        source: o.source ?? null,
        shiftId: this.d.currentShiftId(),
        employeeId: me?.id ?? null,
        employeeName: me?.name ?? null,
        approverId: o.approver?.id ?? null,
        approverName: o.approver?.name ?? null,
        drawerEventId: eventId,
        offline: !this.d.online(),
        occurredAt: this.now(),
      });
      this.d.enqueue('cash_movement', movementId);
    });
  }

  /**
   * A count's result (spec §9): what was counted, against the expected balance, and the variance — recorded with who counted
   * and who approved. `blind`: the expected was not shown before the amount was entered. `expected` is read now unless given
   * (a shift close passes the closing X's).
   */
  recordCount(countedAgorot: number, blind: boolean, drawerEventId: string | null, o: { approver?: DrawerPerson | null; expectedAgorot?: number | null; shiftId?: string | null } = {}): CashMovementRow {
    const exp = o.expectedAgorot ?? this.expectedNow();
    const me = this.d.operator();
    const row: CashMovementRow = {
      id: this.newId(),
      type: MOVEMENT.COUNT,
      amountAgorot: countedAgorot,
      expectedBeforeAgorot: exp,
      expectedAfterAgorot: exp,
      varianceAgorot: exp === null ? null : countedAgorot - exp,
      blind,
      reason: null,
      note: null,
      source: null,
      shiftId: o.shiftId ?? this.d.currentShiftId(),
      employeeId: me?.id ?? null,
      employeeName: me?.name ?? null,
      approverId: o.approver?.id ?? null,
      approverName: o.approver?.name ?? null,
      drawerEventId,
      offline: !this.d.online(),
      occurredAt: this.now(),
    };
    try {
      this.d.store.putMovement(row);
      this.d.enqueue('cash_movement', row.id);
    } catch (e) {
      this.warn(`drawer: count not recorded — ${String(e)}`);
    }
    return row;
  }

  /** The net the movements and wallets add to a shift's expected cash. */
  netOfShift(shiftId: string): number {
    const t = this.shiftTotals(shiftId);
    return movementsNet(t.movements) + (t.wallets.walletDeposits - t.wallets.walletIn);
  }

  private audit(
    id: string,
    request: DrawerRequest,
    verdict: DrawerVerdict,
    o: {
      result: DrawerEventRow['result'];
      reason?: string | null;
      decision?: DrawerEventRow['decision'];
      approver?: DrawerPerson | null;
      drawer?: DrawerTarget | null;
      expected?: number | null;
      enqueue?: boolean;
      jobId?: string | null;
      extra?: Record<string, unknown>;
    },
  ): void {
    const me = this.d.operator();
    const ident = this.d.identity();
    const settings = this.settings();
    const details: Record<string, unknown> = {};
    if (requestIsManual(request)) {
      details.reasonRequired = settings.requireReason;
      details.noteRequired = settings.requireNoteForOther;
    }
    if (verdict.eventType === 'AFTER_CLOSE') details.afterClose = true;
    if (request.technician && !me) details.technician = true;
    if (request.preApproved) details.preApproved = true;
    if (verdict.kind === 'approval') details.approvalWhy = verdict.why;
    // "מגירה נפתחה מרחוק" (bill-print-other-till §9ב–§9ג): whose drawer, and the job that opened it.
    if (o.drawer?.kind === 'remote') {
      details.remote = true;
      details.remoteHost = o.drawer.host.machineId;
      details.remoteHostName = o.drawer.host.label;
      if (o.jobId) details.remoteJobId = o.jobId;
    }
    for (const [k, v] of Object.entries(o.extra ?? {})) if (v !== null && v !== undefined) details[k] = v;
    const ctx: DrawerContext = request.context;
    const row: DrawerEventRow = {
      id,
      category: 'drawer',
      eventType: verdict.eventType,
      permission: verdict.permission,
      decision: o.decision ?? null,
      result: o.result,
      resultReason: o.reason?.slice(0, 300) ?? null,
      companyId: ident.companyId,
      shopId: ident.shopId,
      machineId: ident.machineId,
      drawerId: o.drawer?.id ?? null,
      drawerName: o.drawer?.name ?? null,
      deviceId: ident.deviceId,
      shiftId: this.d.currentShiftId(),
      employeeId: me?.id ?? null,
      employeeName: me?.name ?? (request.technician ? 'טכנאי' : null),
      employeeRole: me ? (me.tillRoleName?.trim() || me.role) : null,
      approverId: o.approver?.id ?? null,
      approverName: o.approver?.name ?? null,
      approverMethod: o.approver ? 'pin' : request.technician && !me ? 'technician' : null,
      tableId: request.tableId ?? null,
      saleId: request.saleId ?? null,
      paymentId: request.paymentId ?? null,
      originalSaleId: request.originalSaleId ?? null,
      reason: request.reason ?? null,
      reasonNote: request.note ?? null,
      movementId: request.movementId ?? null,
      cashMovementType:
        ctx === 'CASH_IN'
          ? MOVEMENT.CASH_IN
          : ctx === 'CASH_OUT'
            ? MOVEMENT.CASH_OUT
            : ctx === 'DEPOSIT'
              ? MOVEMENT.DEPOSIT
              : ctx === 'COUNT' || ctx === 'BLIND_COUNT'
                ? MOVEMENT.COUNT
                : ctx === 'WALLET_DEPOSIT'
                  ? MOVEMENT.WALLET_DEPOSIT
                  : null,
      amountAgorot: request.amountAgorot ?? null,
      expectedBalanceAgorot: o.expected ?? null,
      offline: !this.d.online(),
      occurredAt: this.now(),
      details: Object.keys(details).length > 0 ? details : null,
    };
    try {
      this.d.store.putEvent(row);
      if (o.enqueue !== false) this.d.enqueue('drawer_event', id);
    } catch (e) {
      this.warn(`drawer audit: not recorded — ${String(e)}`);
    }
  }
}
