/**
 * The cash stations' side on the Windows till (P:/specs/cash-paylink.md §11.8, §11.15א — pos-android data/repo/CashOwed.kt,
 * CashCreditService.kt, ui/alerts/TillAlertsUi.kt `CashOwedPayButton`):
 *
 *  - "עודף חייב ללקוח" / "זיכוי מוחזק": the change a cash station could not give, routed by the cloud to this till; "שולם ללקוח"
 *    pays it out of this till's drawer, in this order (an online till with an open shift only): the drawer's own rules for the
 *    cash out — refused, nothing is sent; a manager's approval they want is asked now, and a prompt dismissed sends nothing —
 *    then the cloud (`POST …/cash/owed/{id}/pay` with a new movement id), and only after its 200 the till's own cash out under
 *    that id, with that approver;
 *  - "זיכוי מזומן" (`CC:<code>`): a station's credit for the next order taken towards this sale — looked up, redeemed for
 *    min(what is left on it, what is left of the goods) under a new redemption id; given back when the sale is not closed.
 */

import { randomUUID } from 'node:crypto';
import { cashCreditCodeOf, refusalOf } from '../../core/cash/credit';
import { CREDIT_TEXT, OWED_TEXT, cashMoneyText, creditTake, creditWhyOf, owedCashOutReason, owedLine, parseOwedList, type CashOwedNotice, type CreditRefusal } from '../../core/till/cashOwed';
import { approvalText, mayApproveDrawer, type DrawerRequest, type DrawerVerdict } from '../../core/till/drawer';
import { approveBy } from '../../core/till/approval';
import { NO_LOCK, type ExitLock } from '../../core/desktopExit';
import type { ApiReply } from '../sync/api';
import type { DrawerPerson } from './drawerService';
import type { TillDrawer } from './tillDrawer';
import type { TillContext } from './tillContext';

type Reply = ApiReply<unknown>;

/* ------------------------------------------------------------- the debts */

/** The cloud's two calls, apart so a test answers them. */
export interface CashOwedCloud {
  owed(): Promise<Reply>;
  pay(id: string, movementId: string, shiftId: string | null, userId: string | null, userName: string | null, amountAgorot: number): Promise<Reply>;
}

/** "איזו מגירה לפתוח?" asked ahead of "שולם ללקוח". */
export type CashOutDrawer<D> = { kind: 'not_asked' } | { kind: 'picked'; target: D } | { kind: 'dismissed' };

export type OwedPayResult =
  | { kind: 'paid'; movementId: string }
  | { kind: 'already'; by: string | null; at: string | null }
  | { kind: 'refused'; why: 'no_shift' | 'offline' | 'not_allowed' | 'failed' | 'not_approved' | 'no_drawer'; detail?: string | null };

/** The heartbeat's word missing on Windows: asked every two minutes, and when the screen opens. */
export const OWED_FETCH_EVERY_MS = 120_000;

function refusalCode(body: unknown): { code: string | null; message: string | null; extra: Record<string, unknown> } {
  return refusalOf(body);
}

export class CashOwedRepository {
  items: CashOwedNotice[] = [];
  /** The cloud has answered since the till started: a notice missing now really ended. */
  loaded = false;
  private lastFetchAt: number | null = null;

  constructor(
    private readonly d: {
      cloud: CashOwedCloud;
      /** The till's open shift now (null: none). */
      shiftId(): string | null;
      /** The drawer's own rules for a cash out (null: not known). */
      drawerVerdict(request: DrawerRequest): DrawerVerdict | null;
      /** Who is signed in: (id, name). */
      user(): { id: string | null; name: string | null };
      newId?: () => string;
      log?: (m: string) => void;
    },
  ) {}

  async refreshIfDue(now: number, force = false): Promise<void> {
    if (!force && this.lastFetchAt !== null && now - this.lastFetchAt < OWED_FETCH_EVERY_MS) return;
    this.lastFetchAt = now;
    const r = await this.d.cloud.owed();
    if (r.kind === 'ok') {
      this.items = parseOwedList(r.body);
      this.loaded = true;
    } else if (r.kind === 'refused' && (r.status === 404 || r.status === 403)) {
      // Not an alert till (or an older cloud): nothing to offer.
      this.items = [];
      this.loaded = true;
    }
    // Offline: the last known stays (none is paid offline — §11.8).
  }

  byId(id: string): CashOwedNotice | null {
    return this.items.find((n) => n.id === id) ?? null;
  }

  async pay<A, D>(
    notice: CashOwedNotice,
    reason: string,
    approve: (verdict: Extract<DrawerVerdict, { kind: 'approval' }>) => Promise<A | null>,
    chooseDrawer: (request: DrawerRequest) => Promise<CashOutDrawer<D>>,
    recordCashOut: (movementId: string, amountAgorot: number, reason: string, approver: A | null, drawer: D | null) => Promise<unknown> | unknown,
  ): Promise<OwedPayResult> {
    const shift = this.d.shiftId();
    if (!shift) return { kind: 'refused', why: 'no_shift' };
    const request: DrawerRequest = { context: 'CASH_OUT', reason, note: notice.txId, amountAgorot: notice.amountAgorot };
    const verdict = this.d.drawerVerdict(request);
    let approver: A | null = null;
    if (verdict?.kind === 'refused') return { kind: 'refused', why: 'not_allowed', detail: verdict.why };
    if (verdict?.kind === 'approval') {
      // Before anything is sent: a dismissed prompt (or one refused) leaves the debt as it was.
      approver = await approve(verdict);
      if (approver === null) return { kind: 'refused', why: 'not_approved' };
    }
    // Several drawers: which one, before anything is sent too.
    const pick = await chooseDrawer(request);
    if (pick.kind === 'dismissed') return { kind: 'refused', why: 'no_drawer' };
    const drawer = pick.kind === 'picked' ? pick.target : null;
    const user = this.d.user();
    const movementId = (this.d.newId ?? (() => randomUUID()))();
    const r = await this.d.cloud.pay(notice.id, movementId, shift, user.id, user.name, notice.amountAgorot);
    if (r.kind === 'ok') {
      // Only now the cash leaves this drawer's books (§11.8 2), approved already.
      await recordCashOut(movementId, notice.amountAgorot, reason, approver, drawer);
      this.items = this.items.filter((n) => n.id !== notice.id);
      this.d.log?.(`cash owed ${notice.id} (${notice.txId}) paid from this drawer: ${notice.amountAgorot} agorot, movement ${movementId}`);
      return { kind: 'paid', movementId };
    }
    if (r.kind === 'offline') return { kind: 'refused', why: 'offline', detail: r.reason };
    const ref = refusalCode(r.body);
    const message = ref.message ?? `HTTP ${r.status}`;
    if (r.status === 409 && ref.code === 'already_resolved') {
      this.items = this.items.filter((n) => n.id !== notice.id);
      const by = typeof ref.extra.resolvedBy === 'string' ? ref.extra.resolvedBy : null;
      const at = typeof ref.extra.resolvedAt === 'string' ? ref.extra.resolvedAt : null;
      return { kind: 'already', by, at };
    }
    // §11.8: no shift open in the cloud's eyes either.
    if (ref.code === 'shift_not_open') return { kind: 'refused', why: 'no_shift', detail: message };
    // Gone (or not this till's any more): off the list, said why.
    if (ref.code === 'owed_not_found' || ref.code === 'not_alert_till') this.items = this.items.filter((n) => n.id !== notice.id);
    return { kind: 'refused', why: 'failed', detail: message };
  }
}

/* ------------------------------------------------------------ the credits */

export interface CashCreditUse {
  code: string;
  redemptionId: string;
  amountAgorot: number;
}

export type CreditRedeem = { kind: 'taken'; use: CashCreditUse } | { kind: 'refused'; why: CreditRefusal };

/** The cloud's credits API, as the service needs it — a fake in the tests. */
export interface CashCreditCloud {
  credit(code: string): Promise<Reply>;
  redeem(code: string, redemptionId: string, amountAgorot: number): Promise<Reply>;
  release(redemptionId: string): void;
}

/**
 * Taking a credit (Android CashCreditService.redeem): its code looked up, then redeemed for min(what is left on it, what is
 * left of the goods) under a new redemption id; a cloud that says less is left (`amount_exceeds`) — once more for that.
 */
export async function redeemCredit(cloud: CashCreditCloud, raw: string, goodsDueAgorot: number, inSale: readonly CashCreditUse[], newId: () => string = () => randomUUID()): Promise<CreditRedeem> {
  const code = cashCreditCodeOf(raw);
  if (!code) return { kind: 'refused', why: 'not_a_code' };
  if (inSale.some((u) => u.code === code)) return { kind: 'refused', why: 'in_sale' };
  if (goodsDueAgorot <= 0) return { kind: 'refused', why: 'nothing_due' };
  const look = await cloud.credit(code);
  if (look.kind === 'offline') return { kind: 'refused', why: 'offline' };
  if (look.kind === 'refused') return { kind: 'refused', why: creditWhyOf(refusalOf(look.body).code, look.status) };
  const c = (look.body && typeof look.body === 'object' ? ((look.body as { credit?: unknown }).credit ?? look.body) : null) as Record<string, unknown> | null;
  if (!c || typeof c.code !== 'string') return { kind: 'refused', why: 'failed' };
  const status = typeof c.status === 'string' ? c.status : 'open';
  const remaining = typeof c.remainingAgorot === 'number' ? Math.max(0, c.remainingAgorot) : 0;
  if (status === 'written_off') return { kind: 'refused', why: 'written_off' };
  if (status !== 'open' || remaining <= 0) return { kind: 'refused', why: 'used' };
  let amount = creditTake(remaining, goodsDueAgorot);
  for (let i = 0; i < 2; i++) {
    if (amount <= 0) return { kind: 'refused', why: 'used' };
    // A new id per amount: the same id with another amount is `redemption_conflict`.
    const id = newId();
    const r = await cloud.redeem(code, id, amount);
    if (r.kind === 'ok') {
      const red = r.body && typeof r.body === 'object' ? (r.body as { redemption?: { amountAgorot?: unknown } }).redemption : undefined;
      const taken = typeof red?.amountAgorot === 'number' && red.amountAgorot > 0 ? red.amountAgorot : amount;
      return { kind: 'taken', use: { code, redemptionId: id, amountAgorot: taken } };
    }
    if (r.kind === 'offline') {
      // It may have landed: given back at once (repeatable, 404 when it never did).
      cloud.release(id);
      return { kind: 'refused', why: 'offline' };
    }
    const ref = refusalOf(r.body);
    if (ref.code !== 'amount_exceeds') return { kind: 'refused', why: creditWhyOf(ref.code, r.status) };
    const left = typeof ref.extra.remainingAgorot === 'number' ? ref.extra.remainingAgorot : 0;
    amount = creditTake(left, goodsDueAgorot);
  }
  return { kind: 'refused', why: 'used' };
}

/* ------------------------------------------------------------ the till */

const APPROVAL_LOCK = 'till.owedApprovalLock';

/** What the screens show (`TillState.owed`). */
export interface OwedState {
  items: Array<{ id: string; line: string; amountAgorot: number }>;
}

export class TillCash {
  readonly owed: CashOwedRepository;
  readonly credits: CashCreditCloud;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly c: TillContext,
    private readonly drawer: TillDrawer,
    o: { owedCloud?: CashOwedCloud; creditCloud?: CashCreditCloud } = {},
  ) {
    const svc = c.svc;
    const m = () => svc.machineId;
    this.owed = new CashOwedRepository({
      cloud: o.owedCloud ?? {
        owed: () => (m() ? svc.api.get(`sync/${m()}/cash/owed`, { timeoutMs: 10_000 }) : Promise.resolve({ kind: 'offline', reason: 'not paired' })),
        pay: (id, movementId, shiftId, userId, userName, amountAgorot) =>
          m()
            ? svc.api.post(`sync/${m()}/cash/owed/${encodeURIComponent(id)}/pay`, { movementId, shiftId, userId, userName, amountAgorot }, { timeoutMs: 15_000 })
            : Promise.resolve({ kind: 'offline', reason: 'not paired' }),
      },
      shiftId: () => svc.ledger.currentShift()?.id ?? null,
      drawerVerdict: (request) => drawer.service.evaluate(request),
      user: () => {
        const u = c.operator();
        return { id: u?.id ?? null, name: u ? drawer.person(u)!.name : null };
      },
      log: (msg) => c.log(msg),
    });
    this.credits = o.creditCloud ?? {
      credit: (code) => (m() ? svc.api.get(`sync/${m()}/cash/credits/${encodeURIComponent(code)}`, { timeoutMs: 10_000 }) : Promise.resolve({ kind: 'offline', reason: 'not paired' })),
      redeem: (code, redemptionId, amountAgorot) =>
        m() ? svc.api.post(`sync/${m()}/cash/credits/${encodeURIComponent(code)}/redeem`, { redemptionId, amountAgorot }, { timeoutMs: 12_000 }) : Promise.resolve({ kind: 'offline', reason: 'not paired' }),
      // Kept on the disk and retried until the cloud answers (main/kiosk/cashCredits.ts).
      release: (id) => svc.cashCredits.release(id),
    };
  }

  start() {
    const tick = () => {
      // A till by role only (never a kiosk's background engine): the cloud routes the debts to tills.
      if (!this.c.svc.paired || !this.drawer.isTill()) return;
      void this.owed.refreshIfDue(this.c.now()).then(() => this.c.changed(), () => undefined);
    };
    this.timers.push(setInterval(tick, 30_000), setTimeout(tick, 2_000));
    for (const t of this.timers) t.unref?.();
  }

  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  state(): OwedState {
    return { items: this.owed.items.map((n) => ({ id: n.id, line: owedLine(n), amountAgorot: n.amountAgorot })) };
  }

  /** The list now (the screen opened, "רענון"). */
  async refresh(): Promise<OwedState> {
    this.c.signedIn();
    await this.owed.refreshIfDue(this.c.now(), true);
    return this.state();
  }

  /**
   * "שולם ללקוח": started now, finished when its questions are answered (a manager's code the drawer wants is a dialog: the op
   * returns at once so its answer can come).
   */
  /** The last "שולם ללקוח" under way (the tests wait for it; never sent to a screen — a promise is no answer). */
  lastPay: Promise<OwedPayResult> | null = null;

  pay(id: unknown): { started: true } {
    this.c.signedIn();
    const notice = typeof id === 'string' ? this.owed.byId(id) : null;
    if (!notice) return this.c.refuse('invalid_args', OWED_TEXT.failed('—'));
    const reason = owedCashOutReason(notice);
    const done = this.owed
      .pay<DrawerPerson, never>(
        notice,
        reason,
        (verdict) =>
          new Promise<DrawerPerson | null>((resolve) => {
            void this.c.later(() => {
              this.c.ask({
                kind: 'manager_approval',
                title: 'אישור מנהל',
                body: approvalText(verdict.permission, verdict.why),
                fields: [{ name: 'pin', label: 'קוד מנהל', kind: 'pin' }],
                actions: [
                  { id: 'approve', label: 'אישור', primary: true },
                  { id: 'cancel', label: 'ביטול' },
                ],
                verify: (pin) => this.verifyApprover(verdict, pin),
                resume: (by) => resolve(by ? this.drawer.person(this.c.roster().find((u) => u.id === by.id) ?? null) : null),
                onCancel: () => resolve(null),
              });
              this.c.changed();
            });
          }),
        // One drawer on a Windows till: never a question.
        async () => ({ kind: 'not_asked' }),
        (movementId, amount, why, approver) =>
          this.drawer.service.cashMovement('CASH_OUT', amount, why, notice.txId, { approver, movementId }).then((outcome) => {
            if (outcome.kind === 'denied') this.c.toast(`המגירה לא נפתחה: ${outcome.reason}`, 'error');
          }),
      )
      .then((result) =>
        this.c.later(() => {
          this.c.toast(this.resultText(notice, result), result.kind === 'paid' ? 'ok' : 'error');
          this.c.changed();
          return result;
        }),
      )
      .catch((e: unknown): OwedPayResult => {
        this.c.log(`cash owed: ${String(e)}`);
        return { kind: 'refused', why: 'failed', detail: String(e) };
      });
    this.lastPay = done;
    return { started: true };
  }

  private resultText(n: CashOwedNotice, r: OwedPayResult): string {
    if (r.kind === 'paid') return OWED_TEXT.paid(cashMoneyText(n.amountAgorot));
    if (r.kind === 'already') return OWED_TEXT.already(r.by ?? '—');
    if (r.why === 'no_shift') return OWED_TEXT.noShift;
    if (r.why === 'offline') return OWED_TEXT.offline;
    if (r.why === 'not_approved' || r.why === 'no_drawer') return OWED_TEXT.notApproved;
    return OWED_TEXT.failed(r.detail ?? '—');
  }

  private async verifyApprover(verdict: Extract<DrawerVerdict, { kind: 'approval' }>, pin: string) {
    const svc = this.c.svc;
    const out = await approveBy({
      users: this.c.roster(),
      shopId: this.c.shopId(),
      pin,
      may: (u) => mayApproveDrawer(this.drawer.person(u)!, verdict),
      noApprover: 'אין בסניף מנהל שרשאי לאשר פעולה זו',
      lock: svc.kv.getJson<ExitLock>(APPROVAL_LOCK) ?? NO_LOCK,
      nowMs: this.c.now(),
      compare: this.c.compare,
    });
    if (!out.ok) {
      svc.kv.setJson(APPROVAL_LOCK, out.lock);
      return { ok: false as const, message: out.message };
    }
    svc.kv.setJson(APPROVAL_LOCK, NO_LOCK);
    return { ok: true as const, by: { id: out.user.id, name: this.drawer.person(out.user)!.name } };
  }
}

export { CREDIT_TEXT };
