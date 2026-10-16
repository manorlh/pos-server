/**
 * "מגירת מזומן" on the Windows till's screens (pos-android ui/drawer/DrawerUi.kt `DrawerFlow`): the short UX of the drawer
 * spec §18 — "פתח מגירה" → a reason → (a manager, when needed) → open; Cash In / Cash Out / Deposit with their amount; a
 * count (blind when the till says so); "הפקדת מזומן מעובד"; the shift's log and movements — and after a cash payment the
 * drawer, as `cashDrawer` says (opened, or "לפתוח מגירה?" first, §9א), or — on a device away from the drawer — where the money
 * goes (P:/specs/drawer-away.md §5.3).
 *
 * Every opening here is a `CashDrawerService.requestOpen`: this module only asks the questions the service sends back (a
 * manager's code for one action, which drawer) as the engine's dialogs, and says what happened. Electron-free.
 */

import { randomUUID } from 'node:crypto';
import { formatShekelSign } from '../../core/money';
import { approveBy } from '../../core/till/approval';
import {
  DRAWER_PERM,
  DRAWER_REASONS,
  DRAWER_REASON_LABEL,
  MOVEMENT_REASONS,
  contextOfReason,
  drawerAskOpens,
  drawerModeAsks,
  drawerModeHasButton,
  drawerPermLabel,
  mayApproveDrawer,
  stateOfUser,
  type DrawerRequest,
  type DrawerVerdict,
} from '../../core/till/drawer';
import {
  AWAY_NONE,
  AWAY_TEXT,
  AWAY_WALLET,
  awayPlan,
  isAway,
  parseWallets,
  walletVariance,
  withPending,
  type DrawerChoice,
  type WalletBalance,
} from '../../core/till/drawerAway';
import { NO_LOCK, type ExitLock } from '../../core/desktopExit';
import type { RosterUser } from '../../core/till/staff';
import { CashDrawerService, type DrawerOutcome, type DrawerPerson, type DrawerTarget } from './drawerService';
import { DrawerStore, cashMovementWire, drawerEventWire } from './drawerStore';
import type { TillContext } from './tillContext';

const APPROVAL_LOCK = 'till.drawerApprovalLock';
const sh = (agorot: number) => formatShekelSign(agorot);

/** Android's words (strings*.xml: drawer_*, cash_*, wallet_deposit_*). */
export const DRAWER_TEXT = {
  opened: 'המגירה נפתחה (נרשם בענן)',
  denied: (why: string) => `המגירה לא נפתחה: ${why}`,
  failed: 'המגירה לא נפתחה (מדפסת / מגירה לא זמינה)',
  askTitle: 'לפתוח מגירה?',
  askOpen: 'פתח',
  askSkip: 'לא',
  askAutoOpen: (n: number) => `נפתחת בעוד ${n} שניות`,
  askAutoSkip: (n: number) => `לא תיפתח אם אין תשובה תוך ${n} שניות`,
  whichTitle: 'איזו מגירה לפתוח?',
  managerTitle: 'אישור מנהל',
  managerCode: 'קוד מנהל',
  approve: 'אישור',
  cancel: 'ביטול',
  countResult: (expected: string, counted: string, gap: string) => `צפוי ${expected} · נספר ${counted} · פער ${gap}`,
  movementsDisabled: 'הכנסה / הוצאה / הפקדה כבויות בהגדרות הקופה',
  notAuthorized: (name: string) => `${name} אינו מורשה לאשר פעולה זו`,
  noApprover: (code: string) => `אין בסניף מנהל עם ההרשאה "${drawerPermLabel(code)}"`,
} as const;

/** A saved count: what was counted against what was expected, and the variance. */
export interface CountResult {
  countedAgorot: number;
  expectedAgorot: number | null;
  varianceAgorot: number | null;
}

/** What the screens show of the drawer (`TillState.drawer`). */
export interface TillDrawerState {
  /** The menu's rows ("פתיחת מגירה", "מזומן במגירה" and its actions), as Android offers them. */
  offered: { open: boolean; cashIn: boolean; cashOut: boolean; deposit: boolean; count: boolean; walletDeposit: boolean; log: boolean };
  requireReason: boolean;
  requireNoteForOther: boolean;
  movementsEnabled: boolean;
  blindCount: boolean;
  reasons: Array<{ code: string; label: string }>;
  /** A count in progress ("ספירת מגירה"): blind or not, the expected (hidden while blind), and its result once saved. */
  count: { blind: boolean; expectedAgorot: number | null; result: CountResult | null } | null;
}

export class TillDrawer {
  readonly service: CashDrawerService;
  private count: { eventId: string | null; blind: boolean; result: CountResult | null } | null = null;
  /** The wallets the deposit screen showed (the cloud's, with this device's not sent yet): a deposit settles what was shown. */
  private wallets: WalletBalance[] | null = null;

  constructor(
    private readonly c: TillContext,
    o: { expectedBalance: () => number | null; deviceId?: string | null; service?: CashDrawerService },
  ) {
    const svc = c.svc;
    this.service =
      o.service ??
      new CashDrawerService({
        store: new DrawerStore(svc.db),
        operator: () => this.person(c.operator()),
        parameters: () => svc.cloud.parameters(),
        // The Windows till's own drawer: its receipt printer's RJ11 port.
        ownDrawer: () => ({ id: 'local', name: 'הקופה' }),
        kick: async (target) => {
          if (target.kind !== 'own') throw new Error('אין מגירה כזו בקופה זו');
          await svc.openDrawer();
        },
        currentShiftId: () => svc.ledger.currentShift()?.id ?? null,
        expectedBalance: o.expectedBalance,
        identity: () => ({ companyId: null, shopId: svc.shopIdHere(), machineId: svc.machineId, deviceId: o.deviceId ?? null }),
        online: () => !svc.isOffline,
        enqueue: (kind, id) => svc.outbox.enqueue(kind, id),
        warn: (m) => c.log(m),
      });
    // The audit and the movements reach the cloud as side rows, by their own ids (idempotent there).
    svc.registerSideKind('drawer_event', (row) => {
      const e = this.service.store.event(row.ref_id);
      return e && e.result !== 'pending' ? { path: 'cash-drawer/events', body: drawerEventWire(e) } : null;
    });
    svc.registerSideKind('cash_movement', (row) => {
      const m = this.service.store.movement(row.ref_id);
      return m ? { path: 'cash-drawer/movements', body: cashMovementWire(m) } : null;
    });
  }

  /** A roster user as the drawer reads them. */
  person(u: RosterUser | null): DrawerPerson | null {
    if (!u) return null;
    const name = [u.firstName, u.lastName].filter(Boolean).join(' ') || u.username;
    return { id: u.id, name, role: u.role, permissions: u.permissions ?? null, limits: u.limits ?? null, tillRoleName: u.tillRoleName ?? null };
  }

  /* ------------------------------------------------------------------ state */

  /** "הצג מושבת עם הסבר" shows a denied row (and says why on the tap); the default hides it. */
  private offeredCode(u: RosterUser, code: string): boolean {
    const p = this.c.svc.cloud.parameters().permissionsDeniedUi;
    return (typeof p === 'string' && p.trim() === 'הצג מושבת עם הסבר') || stateOfUser(u, code) !== 'deny';
  }

  state(): TillDrawerState {
    const s = this.service.settings();
    const u = this.c.operator();
    const mode = this.service.drawerMode();
    const ownDrawer = this.service.targets({ context: 'MANUAL' }).length > 0 || this.service.targets({ context: 'CASH_SALE', saleId: 'x' }).length > 0;
    const off = (code: string) => !!u && this.offeredCode(u, code);
    return {
      offered: {
        open: drawerModeHasButton(mode) && (off(DRAWER_PERM.MANUAL) || off(DRAWER_PERM.CHANGE)),
        cashIn: s.movementsEnabled && off(DRAWER_PERM.CASH_IN),
        cashOut: s.movementsEnabled && off(DRAWER_PERM.CASH_OUT),
        deposit: s.movementsEnabled && off(DRAWER_PERM.DEPOSIT),
        count: off(DRAWER_PERM.COUNT) || off(DRAWER_PERM.BLIND_COUNT),
        walletDeposit: (ownDrawer || drawerModeHasButton(mode)) && off(DRAWER_PERM.WALLET_DEPOSIT),
        log: off(DRAWER_PERM.VIEW_LOG) || off(DRAWER_PERM.VIEW_MOVEMENTS),
      },
      requireReason: s.requireReason,
      requireNoteForOther: s.requireNoteForOther,
      movementsEnabled: s.movementsEnabled,
      blindCount: s.blindCount,
      reasons: DRAWER_REASONS.map((code) => ({ code, label: DRAWER_REASON_LABEL[code] })),
      count: this.count
        ? { blind: this.count.blind, expectedAgorot: this.count.blind && !this.count.result ? null : this.service.expectedNow(), result: this.count.result }
        : null,
    };
  }

  /* -------------------------------------------------------------- the flow */

  /** A manager's code for `verdict` on its own: who may approve it here (their limit, the drawer approval). */
  private async verifyApprover(verdict: Extract<DrawerVerdict, { kind: 'approval' }>, pin: string) {
    const svc = this.c.svc;
    const out = await approveBy({
      users: this.c.roster(),
      shopId: this.c.shopId(),
      pin,
      may: (u) => mayApproveDrawer(this.person(u)!, verdict),
      noApprover: DRAWER_TEXT.noApprover(verdict.permission),
      lock: svc.kv.getJson<ExitLock>(APPROVAL_LOCK) ?? NO_LOCK,
      nowMs: this.c.now(),
      compare: this.c.compare,
    });
    if (!out.ok) {
      svc.kv.setJson(APPROVAL_LOCK, out.lock);
      return { ok: false as const, message: out.message };
    }
    svc.kv.setJson(APPROVAL_LOCK, NO_LOCK);
    return { ok: true as const, by: { id: out.user.id, name: this.person(out.user)!.name } };
  }

  private approverById(id: string): DrawerPerson | null {
    return this.person(this.c.roster().find((u) => u.id === id) ?? null);
  }

  /**
   * Follow the service's answer: a manager's code (asked now — the retry carries the approver), a drawer to pick, or a word
   * on the screen. `then` gets the final outcome.
   */
  private follow(
    outcome: DrawerOutcome,
    o: { quiet: boolean; retryApproval: (who: DrawerPerson) => Promise<unknown>; retryTarget: (t: DrawerTarget) => Promise<unknown>; then?: (o: DrawerOutcome) => unknown; onDismiss?: () => unknown },
  ): unknown {
    if (outcome.kind === 'approval') {
      const verdict = outcome.verdict;
      return this.c.ask({
        kind: 'manager_approval',
        title: DRAWER_TEXT.managerTitle,
        body: outcome.message,
        fields: [{ name: 'pin', label: DRAWER_TEXT.managerCode, kind: 'pin' }],
        actions: [
          { id: 'approve', label: DRAWER_TEXT.approve, primary: true },
          { id: 'cancel', label: DRAWER_TEXT.cancel },
        ],
        verify: (pin) => this.verifyApprover(verdict, pin),
        resume: (by) => {
          const who = by ? this.approverById(by.id) : null;
          return who ? o.retryApproval(who) : undefined;
        },
        onCancel: o.onDismiss,
      });
    }
    if (outcome.kind === 'choose') {
      return this.c.ask({
        kind: 'confirm',
        title: DRAWER_TEXT.whichTitle,
        body: '',
        fields: [],
        actions: [...outcome.drawers.map((d, i) => ({ id: `drawer:${d.id}`, label: d.name, primary: i === 0 })), { id: 'cancel', label: DRAWER_TEXT.cancel }],
        onAction: (action) => {
          const t = outcome.drawers.find((d) => `drawer:${d.id}` === action);
          return t ? o.retryTarget(t) : undefined;
        },
        onCancel: o.onDismiss,
      });
    }
    if (outcome.kind === 'opened' && !o.quiet) this.c.toast(DRAWER_TEXT.opened, 'ok');
    else if (outcome.kind === 'denied') this.c.toast(DRAWER_TEXT.denied(outcome.reason), 'error');
    else if (outcome.kind === 'failed' && !o.quiet) this.c.toast(DRAWER_TEXT.failed, 'error');
    return o.then?.(outcome);
  }

  /** Ask the service to open for `request` and follow its answer. */
  private async open(request: DrawerRequest, o: { target?: DrawerTarget | null; approver?: DrawerPerson | null; quiet?: boolean; then?: (o: DrawerOutcome) => unknown } = {}): Promise<unknown> {
    const outcome = await this.service.requestOpen(request, o.target ?? null, o.approver ?? null);
    this.c.changed();
    return this.follow(outcome, {
      quiet: o.quiet ?? false,
      retryApproval: (who) => this.open(request, { ...o, approver: who }),
      retryTarget: (t) => this.open(request, { ...o, target: t }),
      then: o.then,
    });
  }

  /**
   * After a cash payment (Android CheckoutViewModel.drawerAfterCash → DrawerFlow.open, quiet): on a device away from the
   * drawer where the money goes (§5.3); else "בתשלום מזומן — לשאול" asks first (§9א); then the drawer, through the service.
   */
  async afterCashSale(sale: { id: string; documentType: number; number: number }, cashAgorot: number): Promise<unknown> {
    const request: DrawerRequest = {
      context: 'CASH_SALE',
      amountAgorot: cashAgorot,
      saleId: sale.id,
      documentType: String(sale.documentType),
      documentNumber: String(sale.number),
    };
    const away = this.awayDecides(request);
    if (away !== false) return away;
    const asks = drawerModeAsks(this.service.drawerMode()) && this.service.targets(request).length > 0;
    if (asks) {
      const wait = this.service.askSettings();
      return this.c.ask({
        kind: 'confirm',
        title: DRAWER_TEXT.askTitle,
        body: wait.openByDefault ? DRAWER_TEXT.askAutoOpen(wait.timeoutSec) : DRAWER_TEXT.askAutoSkip(wait.timeoutSec),
        fields: [],
        actions: [
          { id: 'open', label: DRAWER_TEXT.askOpen, primary: true },
          { id: 'skip', label: DRAWER_TEXT.askSkip },
        ],
        onAction: (action) => this.askAnswered(request, action === 'open'),
        onCancel: () => this.askAnswered(request, false),
        expiresInMs: wait.timeoutSec * 1000,
        onTimeout: () => this.askAnswered(request, null),
      });
    }
    return this.open(request, { quiet: true });
  }

  private askAnswered(request: DrawerRequest, answer: boolean | null): unknown {
    if (!drawerAskOpens(this.service.askSettings(), answer)) {
      this.service.recordDeclined(request, answer === null);
      return undefined;
    }
    return this.open(request, { quiet: true });
  }

  /**
   * §5.3: decide a cash payment on a device away from the drawer — false: not away, or `none` (today's way). The Windows till
   * is never a handheld; with `auto` it is away only when it has no drawer of its own.
   */
  private awayDecides(request: DrawerRequest): unknown | false {
    const settings = this.service.awaySettings();
    if (settings.policy === 'none') return false;
    const own = this.service.targets(request);
    if (!isAway(settings.near, own.length > 0, false)) return false;
    const choices: DrawerChoice[] = own.map((d) => ({ id: d.id, name: d.name }));
    const plan = awayPlan(settings, choices);
    const cash = request.amountAgorot ?? null;
    const record = (choice: string, dismissed = false) => {
      this.service.recordAway(request, choice, settings.policy, cash, dismissed);
      if (choice === AWAY_WALLET && cash !== null && cash > 0) this.c.toast(AWAY_TEXT.walletDone(sh(cash)), 'ok');
      this.c.changed();
      return undefined;
    };
    const openOwn = (id: string) => {
      const t = own.find((d) => d.id === id);
      return t ? this.open(request, { target: t, quiet: true }) : record(AWAY_NONE);
    };
    switch (plan.kind) {
      case 'open':
        return openOwn(plan.drawer.id);
      case 'choose':
        return this.c.ask({
          kind: 'confirm',
          title: DRAWER_TEXT.whichTitle,
          body: '',
          fields: [],
          actions: [...plan.drawers.map((d, i) => ({ id: `drawer:${d.id}`, label: d.name, primary: i === 0 })), { id: 'cancel', label: DRAWER_TEXT.cancel }],
          onAction: (action) => openOwn(action.replace(/^drawer:/, '')),
          onCancel: () => record(AWAY_NONE, true),
        });
      case 'ask':
        return this.c.ask({
          kind: 'confirm',
          title: AWAY_TEXT.title,
          body: cash !== null ? AWAY_TEXT.amount(sh(cash)) : '',
          fields: [],
          actions: [
            ...plan.drawers.map((d, i) => ({ id: `drawer:${d.id}`, label: AWAY_TEXT.open(d.name), primary: i === 0 })),
            { id: 'wallet', label: AWAY_TEXT.wallet, primary: plan.drawers.length === 0 },
            { id: 'none', label: AWAY_TEXT.none },
          ],
          onAction: (action) => (action === 'wallet' ? record(AWAY_WALLET) : action === 'none' ? record(AWAY_NONE) : openOwn(action.replace(/^drawer:/, ''))),
          // Closing the sheet with no choice is "בלי מגירה".
          onCancel: () => record(AWAY_NONE, true),
        });
      case 'wallet':
        return record(AWAY_WALLET);
      case 'none':
        return record(AWAY_NONE);
    }
  }

  /* ------------------------------------------------------------------- ops */

  /** "פתח מגירה" with its reason (a movement or a count goes to its own op). */
  openManual(reason: string | null, note: string | null): Promise<unknown> | unknown {
    this.c.signedIn();
    const r = reason?.trim() || null;
    if (r !== null && !(DRAWER_REASONS as readonly string[]).includes(r)) return this.c.refuse('invalid_args');
    if (r !== null && MOVEMENT_REASONS.has(r)) return this.c.refuse('invalid_args');
    return this.open({ context: contextOfReason(r), reason: r, note: note?.trim() || null });
  }

  /** Cash In / Cash Out / Deposit: the movement and the opening, one decision (spec §7). */
  movement(type: unknown, amountAgorot: unknown, reason: unknown, note: unknown, source: unknown): Promise<unknown> | unknown {
    this.c.signedIn();
    const context = type === 'CASH_IN' || type === 'cash_in' ? 'CASH_IN' : type === 'CASH_OUT' || type === 'cash_out' ? 'CASH_OUT' : type === 'DEPOSIT' || type === 'deposit' ? 'DEPOSIT' : null;
    if (!context) return this.c.refuse('invalid_args');
    if (typeof amountAgorot !== 'number' || !Number.isInteger(amountAgorot) || amountAgorot < 1 || amountAgorot > 100_000_000) return this.c.refuse('invalid_args', 'יש להזין סכום');
    const text = (v: unknown, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
    const run = (approver: DrawerPerson | null, target: DrawerTarget | null, movementId: string | null): Promise<unknown> =>
      this.service.cashMovement(context, amountAgorot, text(reason, 100), text(note, 500), { source: text(source, 200), approver, target, movementId }).then((outcome) => {
        this.c.changed();
        return this.follow(outcome, {
          quiet: false,
          retryApproval: (who) => run(who, target, movementId),
          retryTarget: (t) => run(approver, t, movementId),
        });
      });
    return run(null, null, null);
  }

  /** "ספירת מגירה": open for a count (blind when the till says so), then the amount. */
  startCount(): Promise<unknown> {
    this.c.signedIn();
    const blind = this.service.settings().blindCount;
    return this.open({ context: blind ? 'BLIND_COUNT' : 'COUNT', reason: 'COUNT' }, {
      then: (outcome) => {
        const eventId = outcome.kind === 'opened' || outcome.kind === 'no_drawer' ? outcome.eventId : null;
        if (outcome.kind !== 'opened' && outcome.kind !== 'no_drawer') return undefined;
        this.count = { eventId, blind, result: null };
        this.c.changed();
        return { blind, expectedAgorot: blind ? null : this.service.expectedNow() };
      },
    });
  }

  saveCount(counted: unknown) {
    this.c.signedIn();
    if (!this.count) return this.c.refuse('invalid_args');
    if (typeof counted !== 'number' || !Number.isInteger(counted) || counted < 0 || counted > 100_000_000) return this.c.refuse('invalid_args');
    const row = this.service.recordCount(counted, this.count.blind, this.count.eventId);
    this.count.result = { countedAgorot: counted, expectedAgorot: row.expectedBeforeAgorot, varianceAgorot: row.varianceAgorot };
    this.c.changed();
    return this.count.result;
  }

  closeCount() {
    this.count = null;
    return undefined;
  }

  /** "הפקדת מזומן מעובד": the shop's wallets from the cloud (with this device's not sent yet) — null: no answer (offline). */
  async listWallets(): Promise<{ wallets: WalletBalance[]; offline: boolean }> {
    const u = this.c.signedIn();
    if (stateOfUser(u, DRAWER_PERM.WALLET_DEPOSIT) === 'deny') return this.c.refuse('permission_denied', `אין לך הרשאה: ${drawerPermLabel(DRAWER_PERM.WALLET_DEPOSIT)}`);
    const svc = this.c.svc;
    const m = svc.machineId;
    const r = m ? await svc.api.get(`sync/${m}/cash-wallets`, { timeoutMs: 8_000 }) : null;
    const cloud = r && r.kind === 'ok' ? parseWallets(r.body) : null;
    if (cloud === null) {
      this.wallets = null;
      return { wallets: [], offline: true };
    }
    const pending = this.service.store.walletRows().map((row) => ({
      type: row.type,
      employeeId: row.employeeId,
      employeeName: row.employeeName,
      amountAgorot: row.amountAgorot,
      settledAgorot: row.type === 'wallet_deposit' ? row.expectedBeforeAgorot : null,
      pending: row.pending,
    }));
    this.wallets = withPending(cloud, pending);
    return { wallets: this.wallets, offline: false };
  }

  /** `counted` of an employee's cash (as the list showed it) into this drawer: the opening and the movement, one decision. */
  deposit(employeeId: unknown, counted: unknown): Promise<unknown> | unknown {
    this.c.signedIn();
    const owner = typeof employeeId === 'string' ? this.wallets?.find((w) => w.employeeId === employeeId) : undefined;
    if (!owner) return this.c.refuse('invalid_args', AWAY_TEXT.depositOffline);
    if (typeof counted !== 'number' || !Number.isInteger(counted) || counted < 0 || counted > 100_000_000) return this.c.refuse('invalid_args', 'יש להזין סכום');
    const movementId = randomUUID();
    const run = (approver: DrawerPerson | null, target: DrawerTarget | null): Promise<unknown> =>
      this.service.walletDeposit(owner, owner.balanceAgorot, counted, target, approver, movementId).then((outcome) => {
        this.c.changed();
        return this.follow(outcome, {
          quiet: true,
          retryApproval: (who) => run(who, target),
          retryTarget: (t) => run(approver, t),
          then: (o) => {
            if (o.kind !== 'opened' && o.kind !== 'no_drawer') return undefined;
            const gap = walletVariance(counted, owner.balanceAgorot);
            const who = owner.employeeName ?? '';
            this.c.toast(gap === 0 ? AWAY_TEXT.depositDone(sh(counted), who) : AWAY_TEXT.depositDoneGap(sh(counted), who, `${gap > 0 ? '+' : '−'}${sh(Math.abs(gap))}`), 'ok');
            this.wallets = this.wallets?.filter((w) => w.employeeId !== owner.employeeId) ?? null;
            return { deposited: true, varianceAgorot: gap };
          },
        });
      });
    return run(null, null);
  }

  /** "לוג פתיחות מגירה" / "תנועות מזומן במשמרת": the open shift's, as the user may see them. */
  log() {
    const u = this.c.signedIn();
    const shift = this.c.svc.ledger.currentShift();
    const seeLog = stateOfUser(u, DRAWER_PERM.VIEW_LOG) !== 'deny';
    const seeMoves = stateOfUser(u, DRAWER_PERM.VIEW_MOVEMENTS) !== 'deny';
    if (!seeLog && !seeMoves) return this.c.refuse('permission_denied', `אין לך הרשאה: ${drawerPermLabel(DRAWER_PERM.VIEW_LOG)}`);
    if (!shift) return { events: [], movements: [] };
    return {
      events: seeLog
        ? this.service.store.eventsOfShift(shift.id).filter((e) => e.category === 'drawer').map((e) => ({ id: e.id, at: e.occurredAt, eventType: e.eventType, result: e.result, employeeName: e.employeeName, approverName: e.approverName, reason: e.reason, amountAgorot: e.amountAgorot }))
        : [],
      movements: seeMoves
        ? this.service.store.movementsOfShift(shift.id).map((m) => ({ id: m.id, at: m.occurredAt, type: m.type, amountAgorot: m.amountAgorot, varianceAgorot: m.varianceAgorot, employeeName: m.employeeName, reason: m.reason }))
        : [],
    };
  }

  /** A sign-out (or another employee) ends the count on screen. */
  reset() {
    this.count = null;
    this.wallets = null;
  }
}

/** The ops this module answers (`drawer.*`), for the engine's dispatch. */
export const DRAWER_OPS = ['drawer.open', 'drawer.movement', 'drawer.count', 'drawer.countSave', 'drawer.countDone', 'drawer.wallets', 'drawer.walletDeposit', 'drawer.log'] as const;
