/**
 * The till's engine on the Windows kiosk core (the owner, 10.10.2026: the installed Windows app is a till too).
 *
 * The till screens (renderer/roles/till — the one app bundle) talk to an `EngineEndpoint` (shared/till/protocol.ts):
 * envelopes in, a state with a rising `seq` out. Until now that was the demo mock; this is the REAL one, a thin adapter
 * over what the kiosk already is — nothing fiscal is invented here:
 *
 *  - the catalog, prices, promotions, blocks, sold-out and the VAT are the kiosk's own shared code
 *    (service.tillCatalogData / priceTillBasket → client/src/lib/kioskMoney.ts, kioskSoldOut.ts), on the till channel;
 *  - a document is the same 320/400 the kiosk writes (main/fiscal/ledger.ts — counters saved before use, one series per
 *    machine, never renumbered), with `payments` legs (cash / card), the cash handed over and the change, and the
 *    employee signed in as its cashier; it goes to the cloud through the same outbox;
 *  - a card goes through the configured terminal's provider and the card-recovery rules (payment/payService.ts) —
 *    the pending document is written BEFORE the frame leaves, and an unknown answer blocks until it is resolved;
 *  - shifts open with the float counted into the drawer and close with the counted cash (X frozen into the close);
 *    the Z is the machine's own (fiscal/tillZService.ts) only in zMode = till — otherwise closing the shift is all this
 *    till does, exactly as the kiosk's own Z today;
 *  - staff sign in with their PIN from the synced roster, with the cloud's permissions (core/till/staff.ts), offline.
 *
 * Android is the reference: the flows and the Hebrew sentences are copied from pos-android (ui/sell, ui/checkout,
 * res/values/strings*.xml). Out of today's scope, the screens say "בקרוב": refunds, tables, held sales, manual
 * discounts, vouchers and club, attendance, the customer display.
 *
 * The state is the engine's alone (§3.3): the screens show what it says. Every changing op carries a `clientOpId` and is
 * never applied twice. Electron-free: tests drive it over a real KioskService with a fake terminal and printer.
 */

import bcrypt from 'bcryptjs';
import { randomUUID } from 'node:crypto';
import { formatShekelSign, ofShekels } from '../../core/money';
import { formatDocNumber, prefixFor } from '../../core/documentNumbers';
import { localDate } from '../../core/kioskOrders';
import { buildXTill, saleDocumentType, saleTotals, unitAgorot, type SaleLine, type SaleTotals } from '../../core/sale';
import { zModeOf } from '../../core/tillZ';
import { parameterOn } from '../sync/cloud';
import { PERM, TEXT, approve, displayName, permLabel, stateOf, tryLogin, type RosterUser } from '../../core/till/staff';
import { cardLast, dueOf, handedTotal, paidOf, quickNotes, takeCash, validCashAmount, type TenderLeg } from '../../core/till/tender';
import { NO_LOCK, type BcryptCompare, type ExitLock } from '../../core/desktopExit';
import type { StartPaymentIn } from '../../shared/bridge';
import {
  MUTATING_OPS,
  TILL_OPS,
  TILL_PROTOCOL,
  engineError,
  engineErrorText,
  type Catalog,
  type CartLine,
  type CheckoutState,
  type DeviceRoleName,
  type EngineCall,
  type EngineDialog,
  type EngineEndpoint,
  type EngineError,
  type EngineEvent,
  type EngineReply,
  type HelloReply,
  type Product,
  type TillErrorCode,
  type TillOp,
  type TillState,
  type XReport,
} from '../../shared/till/protocol';
import { legsOf, xDocOf, type AppliedPromotionRow, type DocDraft } from '../fiscal/ledger';
import type { KioskService } from '../service';

/** The parts of the work-mode runtime (main/workMode.ts) the till asks of; null until it is wired. */
export interface TillWorkMode {
  mode(): 'kiosk' | 'till';
  homeTill(): boolean;
  offered(): { toTill: boolean; toKiosk: boolean };
  mayReturn(): { wire: string; text: string } | null;
  countdownSec(): number | null;
  checkManagerCode(code: string): Promise<{ ok: true; id: string; name: string } | { ok: false; reason: string; message: string }>;
  returnToKiosk(source: 'manual' | 'idle' | 'remote' | 'cloud', by?: string | null, byId?: string | null): Promise<{ wire: string; text: string } | null>;
  setTillFacts(
    fn: () => {
      basketOpen: boolean;
      checkoutOpen: boolean;
      holdsTender: boolean;
      cardInFlight: boolean;
      tableOpen: boolean;
      heldSales: number;
      employee: { id: string; name: string } | null;
      lastActivityAtMs: number | null;
    },
  ): void;
  onChange(fn: () => void): () => void;
}

export interface TillEngineOptions {
  svc: KioskService;
  /** bcrypt, injected for tests (the roster's PIN hashes are bcrypt only). */
  compare?: BcryptCompare;
  now?: () => number;
  workMode?: () => TillWorkMode | null;
  log?: (m: string) => void;
}

class Refusal extends Error {
  constructor(readonly error: EngineError) {
    super(error.code);
  }
}

const refuse = (code: TillErrorCode, message?: string, details?: Record<string, unknown>): never => {
  throw new Refusal(message ? engineErrorText(code, message, details) : engineError(code, details));
};

const REMEMBER_OPS = 500;
const MAX_QTY = 999;
const PALETTE = ['#2563eb', '#16a34a', '#d97706', '#dc2626', '#7c3aed', '#0891b2', '#be185d', '#4d7c0f', '#b45309', '#475569'];
const LOGIN_LOCK = 'till.loginLock';
const APPROVAL_LOCK = 'till.approvalLock';
/** The codes the screens show or hide by. */
const SESSION_CODES = [PERM.SELL, PERM.SHIFT_OPEN, PERM.SHIFT_CLOSE, PERM.X, PERM.Z, PERM.REPRINT, PERM.DRAWER_ON_CASH_SALE, PERM.KIOSK_TILL_MODE];

const sh = (agorot: number) => formatShekelSign(agorot);

/** Android's words (res/values/strings*.xml), one place. */
const WORDS = {
  noShiftBlocksSale: 'לא ניתן לגבות לפני פתיחת משמרת.',
  shiftNone: 'אין משמרת פתוחה. לא ניתן למכור עד שתיפתח משמרת.',
  notSellable: (n: string) => `${n} אינו זמין למכירה`,
  blocked: (n: string, why?: string | null) => (why ? `${n} חסום למכירה: ${why}` : `${n} חסום למכירה`),
  soldOutTitle: 'אזל',
  soldOutMessage: (n: string, until: string) => `${n} סומן „אזל“${until}. אפשר למכור רק באישור מנהל.`,
  soldOutMessageStock: (n: string) => `${n} — אין במלאי. אפשר למכור רק באישור מנהל.`,
  soldOutUntil: (d: string) => ` עד ${d}`,
  soldOutApprove: 'מכירה באישור מנהל',
  soldOutApproveSelf: 'מכור בכל זאת',
  soldOutManager: (n: string) => `מכירת פריט שאזל — ${n}`,
  stockBlocked: (n: string) => `${n} אינו במלאי`,
  stockWarnTitle: 'אין במלאי',
  stockWarnMessage: (n: string) => `${n} אינו במלאי. למכור בכל זאת?`,
  cancel: 'ביטול',
  insufficient: 'הסכום שהתקבל קטן מהסכום לתשלום',
  noPaymentOptions: 'אין אמצעי תשלום זמינים – פנו למנהל',
  cardPending: 'תשלום קודם ממתין לבירור. אנא פנו לצוות.',
  presentCard: 'הצמד, הכנס או העבר את הכרטיס',
  cancelling: 'מבטל… ממתין לתשובת המסוף',
  returnCashTitle: 'החזר מזומן ללקוח',
  returnCashBody: 'המכירה לא הושלמה ולא נרשם מסמך. החזר את המזומן שהתקבל.',
  returnCashDone: 'החזרתי את המזומן',
  receiptProblem: (why: string) => `קבלה: ${why}`,
  noReceiptPrinter: 'לא הוגדרה מדפסת לקבלות',
  pendingBlocksClose: (n: number) => `${n} מכירות בהמתנה במשמרת זו. יש לברר את תוצאתן לפני סגירת המשמרת.`,
  zDisabled: 'הקופה מוגדרת כך שדו״ח Z מופק בענן ולא בקופה. אין צורך להפיק כאן.',
  zNeedsConnection: 'נדרש חיבור לאינטרנט להפקת דו״ח Z',
  zNotAccepted: 'סגירת המשמרת עדיין לא נקלטה בענן, ולכן אי אפשר להפיק דו״ח Z. נסו שוב בעוד רגע.',
  zNothing: 'אין משמרות סגורות שעוד לא נכללו בדו״ח Z',
  zCloudError: 'הענן לא הפיק את דו״ח Z. נסו שוב.',
  zDone: (n: number) => `דו״ח Z מס׳ ${n} הופק`,
  zConfirmOpenShift: (n: number | string) => `משמרת #${n} פתוחה. היא תיסגר קודם: ספירת הקופה והדפסת דו״ח X, ואז יופק דו״ח Z.`,
  shiftClosedSynced: 'המשמרת נסגרה ונקלטה בענן.',
  shiftClosedQueued: 'המשמרת נסגרה. היא תישלח לענן ברגע שיהיה חיבור.',
  comingSoon: (what: string) => `${what} — בקרוב`,
  workModeApproveBack: 'חזרה למצב קיוסק',
  workModeApproveToKiosk: 'מעבר למצב קיוסק',
  workModeMenuBack: 'חזרה למצב קיוסק',
  workModeMenuToKiosk: 'מעבר לקיוסק',
  modeBusy: 'אי אפשר לעבור עכשיו: יש הזמנה או תשלום פתוחים.',
  managerCode: 'קוד מנהל',
  approve: 'אישור',
  wrongPin: 'קוד שגוי',
  managerApprovalTitle: 'אישור מנהל',
} as const;

interface CartRec {
  lineId: string;
  productId: string;
  qty: number;
}

/** Who approved: a manager by their code, or nobody (the user's own right, a confirmation). */
interface Approver {
  id: string;
  name: string;
}

interface PendingDialog {
  dialog: EngineDialog;
  /** The permission a manager's code must hold; null = a confirmation (no code). */
  code: string | null;
  /** A check of the typed code of its own (the work mode's, against KIOSK_TILL_MODE in the runtime); else `code` against the roster. */
  verify?: (pin: string) => Promise<{ ok: true; by: Approver } | { ok: false; message: string }>;
  resume(approver: Approver | null): Promise<unknown> | unknown;
}

interface CheckoutRec {
  phase: CheckoutState['phase'] | 'card_unknown';
  totalAgorot: number;
  legs: Array<TenderLeg & { status: 'approved' | 'pending' }>;
  docId: string | null;
  documentRef: string | null;
  changeAgorot: number;
  askPrint: boolean;
  printWarning: string | null;
  cardStatus: string | null;
  cardError: string | null;
  /** The cart as priced when the payment opened: what the document is written from. */
  frozen: Frozen | null;
  /** The receipt (print job) of the finished sale, until the cashier is done. */
  receiptJob: string | null;
}

interface Frozen {
  lines: SaleLine[];
  tracked: string[];
  promotions: AppliedPromotionRow[];
  totals: SaleTotals;
}

const idleCheckout = (): CheckoutRec => ({
  phase: 'idle',
  totalAgorot: 0,
  legs: [],
  docId: null,
  documentRef: null,
  changeAgorot: 0,
  askPrint: false,
  printWarning: null,
  cardStatus: null,
  cardError: null,
  frozen: null,
  receiptJob: null,
});

function isInt(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
}

export class KioskCoreTillEngine implements EngineEndpoint {
  private seq = 1;
  private dirty = true;
  private readonly listeners = new Set<(e: EngineEvent) => void>();
  private readonly applied = new Map<string, EngineReply>();
  private chain: Promise<unknown> = Promise.resolve();
  private readonly svc: KioskService;
  private readonly compare: BcryptCompare;
  private readonly nowFn: () => number;
  private readonly log: (m: string) => void;

  private cashier: RosterUser | null = null;
  private locked = true;
  private cart: CartRec[] = [];
  private lineSeq = 0;
  private department: string | null = null;
  private search = '';
  private checkout: CheckoutRec = idleCheckout();
  private pending: PendingDialog | null = null;
  private dialogSeq = 0;
  /** "SELL" approved by a manager for this basket (asked once per basket, Android sellGate). */
  private sellApprovedFor: string | null = null;
  private basketId = randomUUID();
  private hostIdle = { idle: true, busy: false };
  private lastActivityAt: number;
  private lastZNumber: number | null = null;
  private toasts: Array<{ tone: 'info' | 'error' | 'ok'; text: string }> = [];
  private offView: (() => void) | null = null;
  private offMode: (() => void) | null = null;
  private tick: NodeJS.Timeout | null = null;
  private stopped = false;
  private lastState = '';

  constructor(private readonly o: TillEngineOptions) {
    this.svc = o.svc;
    this.compare = o.compare ?? ((p, h) => bcrypt.compare(p, h));
    this.nowFn = o.now ?? (() => Date.now());
    this.log = o.log ?? (() => undefined);
    this.lastActivityAt = this.nowFn();
    this.restorePending();
    // What the kiosk learns (catalog, stock, settings, the shift closed by the cloud…) reaches the screens.
    const onView = () => this.refresh();
    this.svc.on('view', onView);
    this.offView = () => this.svc.off('view', onView);
    this.tick = setInterval(() => this.refresh(), 5_000);
    this.attachWorkMode();
  }

  stop() {
    this.stopped = true;
    this.offView?.();
    this.offMode?.();
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
  }

  /** The work mode runtime exists after the engine in the shell's start: tried again until it is there. */
  private attachedMode: TillWorkMode | null = null;
  attachWorkMode() {
    const wm = this.o.workMode?.() ?? null;
    if (!wm || wm === this.attachedMode) return;
    this.attachedMode = wm;
    this.offMode?.();
    this.offMode = wm.onChange(() => this.refresh());
    wm.setTillFacts(() => ({
      basketOpen: this.cart.length > 0,
      checkoutOpen: this.checkout.phase !== 'idle',
      holdsTender: this.checkout.legs.length > 0,
      cardInFlight: this.svc.pay.cardInFlight,
      tableOpen: false,
      heldSales: 0,
      employee: this.cashier ? { id: this.cashier.id, name: displayName(this.cashier) } : null,
      lastActivityAtMs: this.lastActivityAt,
    }));
  }

  /* -------------------------------------------------------------- the endpoint */

  hello(_since?: number): HelloReply {
    return { protocol: TILL_PROTOCOL, seq: this.seq, state: this.snapshot() };
  }

  snapshot(): TillState {
    return this.buildState();
  }

  get currentSeq(): number {
    return this.seq;
  }

  on(fn: (e: EngineEvent) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private emit(ev: EngineEvent['ev'], data: unknown) {
    const e: EngineEvent = { ev, seq: this.seq, data };
    for (const fn of Array.from(this.listeners)) fn(e);
  }

  /** The state, when it changed (a coalesced look: each op, the kiosk's views, the 5 s tick). */
  private refresh() {
    if (this.stopped) return;
    this.attachWorkMode();
    this.commit(true);
  }

  private commit(always = false) {
    if (!this.dirty && !always) return;
    const state = this.buildState();
    const json = JSON.stringify(state);
    this.dirty = false;
    if (json === this.lastState) return;
    this.lastState = json;
    this.seq += 1;
    this.emit('state', state);
    // The updater and the pay monitor see a till as a quiet or busy device (never an update mid-sale).
    const busy = state.sell.lines.length > 0 || state.checkout.phase !== 'idle' || state.dialog !== null;
    this.svc.reportFlow({ flowState: busy ? 'paying' : 'attract', screen: state.checkout.phase !== 'idle' ? 'pay' : 'attract', busy, idle: !busy && this.nowFn() - this.lastActivityAt > 60_000 });
    this.drainToasts();
  }

  private drainToasts() {
    const t = this.toasts;
    this.toasts = [];
    for (const x of t) this.emit('toast', x);
  }

  private toast(text: string, tone: 'info' | 'error' | 'ok' = 'info') {
    this.toasts.push({ tone, text });
  }

  /* ------------------------------------------------------------------- calls */

  call(c: EngineCall): Promise<EngineReply> {
    const run = this.chain.then(() => this.exec(c));
    this.chain = run.catch(() => undefined);
    return run;
  }

  /** Serialises work that continues after an op returned (a card's answer): never between two steps of another op. */
  private later<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.chain.then(fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async exec(c: EngineCall): Promise<EngineReply> {
    if (!(TILL_OPS as readonly string[]).includes(c.op)) return { id: c.id, ok: false, error: engineError('unknown_op') };
    const mutating = MUTATING_OPS.has(c.op);
    if (mutating) {
      if (!c.clientOpId) return { id: c.id, ok: false, error: engineError('missing_client_op_id') };
      const before = this.applied.get(c.clientOpId);
      if (before) return { ...before, id: c.id };
    }
    let reply: EngineReply;
    try {
      if (!this.svc.fiscal && c.op !== 'session.hello' && c.op !== 'host.idle' && c.op !== 'session.activity') refuse('not_a_till');
      const value = await this.apply(c.op, (c.args ?? {}) as Record<string, unknown>);
      reply = value === undefined ? { id: c.id, ok: true } : { id: c.id, ok: true, value };
    } catch (e) {
      if (e instanceof Refusal) reply = { id: c.id, ok: false, error: e.error };
      else {
        this.log(`till engine ${c.op}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
        reply = { id: c.id, ok: false, error: engineError('invalid_args') };
      }
    }
    if (mutating && c.clientOpId) {
      this.applied.set(c.clientOpId, reply);
      if (this.applied.size > REMEMBER_OPS) this.applied.delete(this.applied.keys().next().value as string);
    }
    this.dirty = true;
    this.commit();
    return reply;
  }

  private async apply(op: TillOp, a: Record<string, unknown>): Promise<unknown> {
    switch (op) {
      case 'session.hello':
        return this.hello();
      case 'session.login':
        return this.login(String(a.pin ?? a.code ?? ''));
      case 'session.logout':
        return this.logout();
      case 'session.activity':
        this.lastActivityAt = this.nowFn();
        return undefined;
      case 'catalog.snapshot':
        return this.catalogSnapshot();
      case 'sell.add':
        return this.add(String(a.productId ?? ''), a.qty === undefined ? 1 : (a.qty as number));
      case 'sell.setQty':
        return this.setQty(String(a.lineId ?? ''), a.qty as number);
      case 'sell.remove':
        this.editable();
        this.cart = this.cart.filter((l) => l.lineId !== a.lineId);
        return undefined;
      case 'sell.discount':
        return this.comingSoon('הנחה ידנית');
      case 'sell.clear':
        this.editable();
        this.cart = [];
        this.sellApprovedFor = null;
        return undefined;
      case 'sell.department': {
        const id = (a.departmentId as string | null) ?? null;
        if (id !== null && !this.svc.tillCatalogData().categories.some((c) => c.id === id)) refuse('invalid_args');
        this.department = id;
        return undefined;
      }
      case 'sell.search':
        if (typeof a.text !== 'string' || a.text.length > 60) refuse('invalid_args');
        this.search = a.text as string;
        return undefined;
      case 'checkout.start':
        return this.checkoutStart();
      case 'checkout.cash':
        return this.cashTender(a.amountAgorot);
      case 'checkout.card':
        return this.cardTender();
      case 'checkout.cancel':
        return this.checkoutCancel();
      case 'checkout.finish':
        return this.checkoutFinish();
      case 'checkout.print':
        return this.answerPrint(a.print === true);
      case 'checkout.recheckCard':
        return this.recheckCard();
      case 'checkout.markNotApproved':
        return this.markNotApproved();
      case 'dialog.answer':
        return this.answerDialog(String(a.dialogId ?? ''), String(a.action ?? ''), (a.answers ?? {}) as Record<string, string>);
      case 'doc.history':
        return this.history();
      case 'doc.reprint':
        return this.reprint(String(a.documentId ?? ''));
      case 'doc.refund':
        return this.comingSoon('זיכוי');
      case 'shift.open':
        return this.shiftOpen(a.openingCashAgorot);
      case 'shift.close':
        return this.shiftClose(a.countedCashAgorot);
      case 'report.x':
        return this.reportX();
      case 'z.produce':
        return this.zProduce(a.countedCashAgorot);
      case 'mode.switch':
        return this.modeSwitch(a.to as DeviceRoleName, typeof a.managerCode === 'string' ? a.managerCode : null);
      case 'host.idle':
        this.hostIdle = { idle: a.idle === true, busy: a.busy === true };
        return undefined;
      case 'hw.result':
        // The real engine carries out its own hardware: nothing arrives from a page (the role refuses it too).
        return undefined;
    }
    return refuse('unknown_op');
  }

  /* ------------------------------------------------------------------ staff */

  private roster(): RosterUser[] {
    return this.svc.cloud.posUsers() as RosterUser[];
  }

  private shop(): string | null {
    return this.svc.shopIdHere();
  }

  private signedIn(): RosterUser {
    if (!this.cashier || this.locked) return refuse('not_logged_in', TEXT.notSignedIn);
    return this.cashier;
  }

  private operator() {
    const u = this.signedIn();
    return { id: u.id, name: displayName(u) };
  }

  private async login(pin: string) {
    const d = await tryLogin({
      users: this.roster(),
      shopId: this.shop(),
      pin,
      lock: this.svc.kv.getJson<ExitLock>(LOGIN_LOCK) ?? NO_LOCK,
      nowMs: this.nowFn(),
      compare: this.compare,
    });
    this.svc.kv.setJson(LOGIN_LOCK, d.lock);
    if (d.outcome !== 'granted' || !d.user) {
      const code: TillErrorCode = d.outcome === 'locked' || d.outcome === 'locked_out' ? 'login_locked' : 'wrong_pin';
      return refuse(code, d.message ?? TEXT.loginBad, { triesLeft: d.triesLeft });
    }
    this.cashier = d.user;
    this.locked = false;
    this.lastActivityAt = this.nowFn();
    return { cashier: { id: d.user.id, name: displayName(d.user) } };
  }

  private logout() {
    if (this.checkout.phase !== 'idle') refuse('checkout_busy');
    this.cashier = null;
    this.locked = true;
    this.pending = null;
    return undefined;
  }

  /**
   * The Android PermissionGate: the user's own answer for `code` — `allow` runs `resume` at once; `approval` asks a
   * manager's code (a dialog, the engine's question); `deny` is "אין לך הרשאה" — or, with `askOnDeny`, asks a manager too
   * (an action a cashier never has but a manager may approve at the till: the sold-out sale, the work mode).
   */
  private gate(code: string, resume: (approver: Approver | null) => Promise<unknown> | unknown, opts: { askOnDeny?: boolean; title?: string; body?: string } = {}): Promise<unknown> | unknown {
    const user = this.signedIn();
    const st = stateOf(user, code);
    if (st === 'allow') return resume(null);
    if (st === 'deny' && !opts.askOnDeny) return refuse('permission_denied', TEXT.denied(code));
    this.openDialog({
      kind: 'manager_approval',
      title: opts.title ?? WORDS.managerApprovalTitle,
      body: opts.body ?? TEXT.approval(code),
      fields: [{ name: 'pin', label: WORDS.managerCode, kind: 'pin' }],
      actions: [
        { id: 'approve', label: WORDS.approve, primary: true },
        { id: 'cancel', label: WORDS.cancel },
      ],
      code,
      resume,
    });
    return { dialogId: this.pending!.dialog.id };
  }

  private openDialog(d: { kind: EngineDialog['kind']; title: string; body: string; fields: EngineDialog['fields']; actions: EngineDialog['actions']; code: string | null; resume: PendingDialog['resume']; verify?: PendingDialog['verify'] }) {
    this.dialogSeq += 1;
    this.pending = { dialog: { id: `d${this.dialogSeq}`, kind: d.kind, title: d.title, body: d.body, fields: d.fields, actions: d.actions }, code: d.code, verify: d.verify, resume: d.resume };
  }

  private async answerDialog(id: string, action: string, answers: Record<string, string>) {
    const p = this.pending;
    if (!p || p.dialog.id !== id) return refuse('invalid_args');
    if (action === 'cancel') {
      this.pending = null;
      return undefined;
    }
    if (action !== 'approve') return refuse('invalid_args');
    let approver: Approver | null = null;
    if (p.verify) {
      const v = await p.verify(String(answers.pin ?? ''));
      if (!v.ok) return refuse('wrong_pin', v.message);
      approver = v.by;
    } else if (p.code) {
      const out = await approve({
        users: this.roster(),
        shopId: this.shop(),
        code: p.code,
        pin: String(answers.pin ?? ''),
        lock: this.svc.kv.getJson<ExitLock>(APPROVAL_LOCK) ?? NO_LOCK,
        nowMs: this.nowFn(),
        compare: this.compare,
      });
      if (!out.ok) {
        this.svc.kv.setJson(APPROVAL_LOCK, out.lock);
        return refuse(out.reason === 'locked' ? 'login_locked' : out.reason === 'no_approver' ? 'manager_required' : 'wrong_pin', out.message);
      }
      this.svc.kv.setJson(APPROVAL_LOCK, NO_LOCK);
      approver = { id: out.user.id, name: displayName(out.user) };
    }
    this.pending = null;
    const value = await p.resume(approver);
    return value === undefined ? undefined : value;
  }

  /* ----------------------------------------------------------------- catalog */

  /** The kiosk catalog's version, and whether this user sees manager-approval items (another sign-in may see another list). */
  private catalogVersion(): number {
    const user = this.cashier;
    return this.svc.tillCatalogVersion() * 2 + (user && stateOf(user, PERM.SELL_RESTRICTED) !== 'deny' ? 1 : 0);
  }

  private catalogSnapshot(): Catalog {
    const cat = this.svc.tillCatalogData();
    const user = this.cashier;
    const mayRestricted = !!user && stateOf(user, PERM.SELL_RESTRICTED) !== 'deny';
    const ids = new Map(cat.categories.map((c, i) => [c.id, i] as const));
    return {
      version: this.catalogVersion(),
      departments: cat.categories.map((c, i) => ({ id: c.id, name: c.name, color: PALETTE[i % PALETTE.length] })),
      products: cat.products
        .filter((p) => p.categoryId !== null && ids.has(p.categoryId) && (!p.restricted || mayRestricted))
        .map((p): Product => {
          const sale = !p.available ? 'unavailable' : p.sale?.state === 'blocked' ? 'blocked' : p.sale?.state === 'sold_out' ? 'sold_out' : undefined;
          return {
            id: p.id,
            departmentId: p.categoryId as string,
            name: p.name,
            priceAgorot: p.priceAgorot,
            ...(p.barcode ? { barcode: p.barcode } : {}),
            ...(p.sku ? { sku: p.sku } : {}),
            ...(sale ? { sale } : {}),
            ...(p.restricted ? { restricted: true } : {}),
          };
        }),
    };
  }

  /* -------------------------------------------------------------------- cart */

  private comingSoon(what: string): never {
    return refuse('coming_soon', WORDS.comingSoon(what));
  }

  /** The cart may change: signed in, no payment open. */
  private editable() {
    this.signedIn();
    if (this.checkout.phase !== 'idle') refuse('checkout_busy');
  }

  private add(productId: string, qty: number) {
    this.editable();
    if (!isInt(qty, 1, MAX_QTY)) refuse('invalid_args');
    const cat = this.svc.tillCatalogData();
    const p = cat.products.find((x) => x.id === productId);
    if (!p) return refuse('invalid_args');
    const settings = this.svc.settingsMap();
    const user = this.signedIn();
    const proceed = (soldOutApproved: boolean) => {
      // A meal and a dish with a required choice open their sheet on the Android till: soon.
      if (p.meal) return this.comingSoon('ארוחות');
      const groups = cat.groups[p.id] ?? [];
      if (groups.some((g) => g.min > 0)) return this.comingSoon('פריט עם תוספות חובה');
      this.putLine(p.id, qty);
      void soldOutApproved;
      return undefined;
    };
    const afterSellGate = (): unknown => {
      // "לא זמין" — the product's own lock ("נעילת מוצר").
      if (!p.available) return refuse('sell_refused', WORDS.notSellable(p.name));
      const restricted = () =>
        p.restricted
          ? this.gate(PERM.SELL_RESTRICTED, () => afterRestricted(), { body: TEXT.approval(PERM.SELL_RESTRICTED) })
          : afterRestricted();
      return restricted();
    };
    const afterRestricted = (): unknown => {
      const sale = p.sale;
      if (!sale || sale.state === 'available') return proceed(false);
      if (sale.state === 'blocked') return refuse('sell_refused', WORDS.blocked(p.name, sale.note));
      // "אזל": a hand-set one asks a manager; an automatic one (the stock ran out) follows the shop's out-of-stock policy.
      const policy = String(settings.outOfStockPolicy ?? '').trim().toLowerCase();
      const policyBlocks = policy === 'block';
      const manual = sale.reason === 'manual';
      if (!manual && !policyBlocks) {
        if (policy === 'warn') {
          this.openDialog({
            kind: 'confirm',
            title: WORDS.stockWarnTitle,
            body: WORDS.stockWarnMessage(p.name),
            fields: [],
            actions: [
              { id: 'approve', label: 'המשך', primary: true },
              { id: 'cancel', label: WORDS.cancel },
            ],
            code: null,
            resume: () => proceed(true),
          });
          return { dialogId: this.pending!.dialog.id };
        }
        return proceed(false);
      }
      const until = sale.untilMs ? WORDS.soldOutUntil(new Date(sale.untilMs).toLocaleString('he-IL')) : '';
      const body = sale.reason === 'stock' ? WORDS.soldOutMessageStock(p.name) : WORDS.soldOutMessage(p.name, until);
      // The Android dialog: a user who may edit the catalog sells it anyway; any other asks a manager's code.
      if (stateOf(user, PERM.CATALOG_WRITE) === 'allow') {
        this.openDialog({
          kind: 'confirm',
          title: WORDS.soldOutTitle,
          body,
          fields: [],
          actions: [
            { id: 'approve', label: WORDS.soldOutApproveSelf, primary: true },
            { id: 'cancel', label: WORDS.cancel },
          ],
          code: null,
          resume: () => proceed(true),
        });
      } else {
        this.openDialog({
          kind: 'manager_approval',
          title: WORDS.soldOutTitle,
          body: `${body}\n${WORDS.soldOutManager(p.name)}`,
          fields: [{ name: 'pin', label: WORDS.managerCode, kind: 'pin' }],
          actions: [
            { id: 'approve', label: WORDS.soldOutApprove, primary: true },
            { id: 'cancel', label: WORDS.cancel },
          ],
          code: PERM.CATALOG_WRITE,
          resume: () => proceed(true),
        });
      }
      return { dialogId: this.pending!.dialog.id };
    };
    // SELL: asked once per basket when the user needs a manager for it (Android sellGate).
    if (this.sellApprovedFor === this.basketId) return afterSellGate();
    return this.gate(PERM.SELL, (approver) => {
      if (approver) this.sellApprovedFor = this.basketId;
      return afterSellGate();
    });
  }

  private putLine(productId: string, qty: number) {
    const same = this.cart.find((l) => l.productId === productId);
    if (same) same.qty = Math.min(MAX_QTY, same.qty + qty);
    else {
      this.lineSeq += 1;
      this.cart.push({ lineId: `l${this.lineSeq}`, productId, qty });
    }
  }

  private setQty(lineId: string, qty: number) {
    this.editable();
    if (!isInt(qty, 0, MAX_QTY)) refuse('invalid_args');
    const line = this.cart.find((l) => l.lineId === lineId);
    if (!line) return refuse('invalid_args');
    if (qty === 0) this.cart = this.cart.filter((l) => l.lineId !== lineId);
    else {
      // More of a product is a line coming in again: the gate asks about it as for a tap (a block that arrived since refuses).
      const grew = qty > line.qty;
      if (grew) return this.add(line.productId, qty - line.qty);
      line.qty = qty;
    }
    return undefined;
  }

  /** The cart priced by the kiosk's own engine on the till channel (promotions by the clock). */
  private priced(now = new Date(this.nowFn())): Frozen & { gone: string[] } {
    const lines = this.cart.map((l) => ({ key: l.lineId, productId: l.productId, qty: l.qty, notes: [] as string[], options: [] as never[] }));
    const input = { lines, service: null, customerName: null, customerPhone: null, tableRef: null, tipPct: null, tipAgorot: null } as unknown as StartPaymentIn;
    const r = this.svc.priceTillBasket(input, now);
    const gone = r.changes.filter((c) => c.kind === 'removed').map((c) => c.key ?? '');
    return { lines: r.lines, tracked: r.tracked, promotions: r.promotions, totals: saleTotals(r.lines, this.svc.vatRate()), gone };
  }

  /* ---------------------------------------------------------------- checkout */

  private checkoutStart() {
    this.signedIn();
    if (this.cart.length === 0) refuse('cart_empty');
    if (this.checkout.phase !== 'idle') refuse('checkout_busy');
    if (!this.svc.ledger.currentShift() && !this.shiftsHidden()) refuse('shift_not_open', WORDS.noShiftBlocksSale);
    const p = this.priced();
    if (p.gone.length > 0) {
      // What the catalog no longer sells leaves the cart; the cashier looks again.
      this.cart = this.cart.filter((l) => !p.gone.includes(l.lineId));
      this.toast('חלק מהפריטים כבר לא נמכרים והוסרו מהסל', 'error');
      return undefined;
    }
    if (p.totals.totalAgorot < 1) return refuse('cart_empty');
    this.checkout = { ...idleCheckout(), phase: 'tender', totalAgorot: p.totals.totalAgorot, frozen: { lines: p.lines, tracked: p.tracked, promotions: p.promotions, totals: p.totals } };
    return undefined;
  }

  private tenderOpen() {
    if (this.checkout.phase !== 'tender') refuse('invalid_args');
  }

  private approvedLegs(): TenderLeg[] {
    return this.checkout.legs.filter((l) => l.status === 'approved');
  }

  /**
   * The owner's rule (10.10.2026): an INDEPENDENT till (`independentTill` from the cloud, Z on the till) has no shifts in its UI —
   * the shift opens silently on the first sale (float 0) and is closed inside "הפק Z". The till parameter `independentTillZOnly`
   * (default on; read when present) can give the shift screens back. Shop-Z and own-Z tills keep the normal shift flow.
   */
  private shiftsHidden(): boolean {
    const beat = this.svc.cloud.heartbeat();
    if (beat.independentTill !== true || zModeOf(beat.zMode) !== 'till') return false;
    const p = this.svc.cloud.parameters().independentTillZOnly;
    return p === undefined || p === null || p === '' ? true : parameterOn(p);
  }

  /** The shift a sale is written in: the open one, or — on an independent till — one opened now by the first sale. */
  private ensureShift(): boolean {
    if (this.svc.ledger.currentShift()) return true;
    if (!this.shiftsHidden()) return false;
    this.svc.ledger.openShift(this.operator(), new Date(this.nowFn()), 0);
    return true;
  }

  private async cashTender(amount: unknown) {
    this.signedIn();
    this.tenderOpen();
    if (!validCashAmount(amount)) refuse('invalid_args');
    const total = this.checkout.totalAgorot;
    const step = takeCash(total, this.approvedLegs(), amount as number);
    if (step.kind === 'partial') {
      this.checkout.legs.push({ ...step.leg, status: 'approved' });
      return undefined;
    }
    const f = this.checkout.frozen!;
    if (!this.ensureShift()) return refuse('shift_not_open', WORDS.shiftNone);
    const doc = this.svc.ledger.recordCashSale({
      documentType: saleDocumentType(this.svc.business().dealerType),
      prefix: this.prefix(),
      branchId: this.svc.business().branchId,
      operator: this.operator(),
      orderId: null,
      lines: f.lines,
      tracked: f.tracked,
      totals: f.totals,
      promotions: f.promotions,
      payments: step.legs.map((l) => ({ method: l.method, amountAgorot: l.amountAgorot })),
      tenderedAgorot: step.tenderedAgorot,
      changeAgorot: step.changeAgorot,
      channel: 'till',
    });
    if (!doc) return refuse('shift_not_open', WORDS.shiftNone);
    this.checkout.legs.push({ ...step.leg, status: 'approved' });
    this.finalize(doc);
    return undefined;
  }

  private prefix(): string | null {
    const me = this.svc.cloud.machine();
    return prefixFor(me?.documentPrefix ?? null, me?.posNumber ?? null);
  }

  private cardTender() {
    this.signedIn();
    this.tenderOpen();
    const pay = this.svc.pay;
    if (pay.cardInFlight) refuse('checkout_busy');
    if (!pay.configured) refuse('terminal_unavailable', WORDS.noPaymentOptions);
    if (pay.blocked() || pay.unresolved()) refuse('terminal_unavailable', WORDS.cardPending);
    const f = this.checkout.frozen!;
    const legs = cardLast(this.checkout.totalAgorot, this.approvedLegs());
    const card = legs[legs.length - 1];
    if (card.amountAgorot < 1) return refuse('invalid_args');
    const handed = handedTotal(legs);
    if (!this.ensureShift()) return refuse('shift_not_open', WORDS.shiftNone);
    // The pending document is written (numbered, the counter saved first) BEFORE the terminal is asked.
    const doc = this.svc.ledger.openCardSale({
      documentType: saleDocumentType(this.svc.business().dealerType),
      prefix: this.prefix(),
      branchId: this.svc.business().branchId,
      operator: this.operator(),
      orderId: null,
      lines: f.lines,
      tracked: f.tracked,
      totals: f.totals,
      promotions: f.promotions,
      payments: legs.map((l) => ({ method: l.method, amountAgorot: l.amountAgorot })),
      ...(handed > 0 ? { tenderedAgorot: handed, changeAgorot: 0 } : {}),
      channel: 'till',
    });
    if (!doc) return refuse('shift_not_open', WORDS.shiftNone);
    this.checkout.docId = doc.id;
    this.checkout.legs.push({ method: 'card', amountAgorot: card.amountAgorot, handedAgorot: 0, status: 'pending' });
    this.checkout.phase = 'card_waiting';
    this.checkout.cardError = null;
    this.checkout.cardStatus = WORDS.presentCard;
    void this.runCharge(doc, card.amountAgorot);
    return undefined;
  }

  private async runCharge(doc: DocDraft, amount: number) {
    const outcome = await this.svc.pay.charge({
      transactionId: doc.id,
      orderId: null,
      amountAgorot: amount,
      tipAgorot: 0,
      onSent: () => this.later(() => this.setCardStatus(WORDS.presentCard)),
      onProgress: (m) => void this.later(() => this.setCardStatus(m)),
    });
    await this.later(() => {
      const ref = this.svc.pay.attempts().find((a) => a.transactionId === doc.id)?.vuid ?? null;
      if (outcome.kind === 'approved') {
        const done = this.svc.ledger.completeCardSale(doc.id, outcome.card);
        if (ref) this.svc.pay.forgetAttempt(ref);
        if (done && done.status === 'completed') this.finalize(done);
      } else if (outcome.kind === 'declined' || outcome.kind === 'refused') {
        this.svc.ledger.voidCardSale(doc.id, outcome.kind === 'declined' ? outcome.voidMeta : null);
        if (ref) this.svc.pay.forgetAttempt(ref);
        this.cardFailed(outcome.kind === 'declined' ? outcome.message : WORDS.noPaymentOptions);
        void this.svc.sync.flush();
      } else {
        // Unknown: never a second charge — the document stays pending and every tender waits for the answer.
        this.checkout.phase = 'card_unknown';
        this.checkout.cardStatus = null;
        this.checkout.cardError = outcome.message;
      }
      this.dirty = true;
      this.commit();
    });
  }

  private setCardStatus(m: string) {
    if (this.checkout.phase === 'card_waiting') {
      this.checkout.cardStatus = m;
      this.dirty = true;
      this.commit();
    }
  }

  /** The card did not go through (certainly not charged): back to the tenders, the words shown. */
  private cardFailed(message: string) {
    this.checkout.legs = this.checkout.legs.filter((l) => !(l.method === 'card' && l.status === 'pending'));
    this.checkout.docId = null;
    this.checkout.phase = 'tender';
    this.checkout.cardStatus = null;
    this.checkout.cardError = message;
  }

  private checkoutCancel() {
    this.signedIn();
    const c = this.checkout;
    if (c.phase === 'card_waiting') {
      void this.svc.pay.cancel();
      c.cardStatus = WORDS.cancelling;
      return undefined;
    }
    if (c.phase === 'card_unknown') refuse('card_in_flight');
    if (c.phase !== 'tender') refuse('invalid_args');
    const handed = handedTotal(this.approvedLegs());
    const reset = () => {
      this.checkout = idleCheckout();
      return undefined;
    };
    if (handed === 0) return reset();
    // Cash was already taken: the sale is abandoned only with the money handed back (Android "בטל מכירה והחזר מזומן").
    this.openDialog({
      kind: 'confirm',
      title: WORDS.returnCashTitle,
      body: `${WORDS.returnCashBody} ${sh(handed)}`,
      fields: [],
      actions: [
        { id: 'approve', label: WORDS.returnCashDone, primary: true },
        { id: 'cancel', label: WORDS.cancel },
      ],
      code: null,
      resume: () => reset(),
    });
    return { dialogId: this.pending!.dialog.id };
  }

  private checkoutFinish() {
    if (this.checkout.phase !== 'done') refuse('invalid_args');
    this.checkout = idleCheckout();
    return undefined;
  }

  /** The sale is complete: the cart is gone (never sold twice), the drawer, the receipt. */
  private finalize(doc: DocDraft) {
    const legs = legsOf(doc);
    const c = this.checkout;
    c.phase = 'done';
    c.docId = doc.id;
    c.documentRef = formatDocNumber(doc.prefix, String(doc.number));
    c.changeAgorot = doc.changeAgorot ?? 0;
    c.legs = legs.map((l) => ({ method: l.method, amountAgorot: l.amountAgorot, handedAgorot: l.method === 'cash' ? l.amountAgorot : 0, status: 'approved' as const }));
    c.cardStatus = null;
    c.cardError = null;
    this.cart = [];
    this.sellApprovedFor = null;
    this.basketId = randomUUID();
    void this.svc.sync.flush();
    this.kickDrawer(doc);
    this.printOrAsk(doc);
  }

  /** "פתיחת מגירה": on every payment that moves cash, when the till parameter and the user's right say so (the Android drawer, without its audit yet). */
  private kickDrawer(doc: DocDraft) {
    if (!legsOf(doc).some((l) => l.method === 'cash')) return;
    const v = String(this.svc.cloud.parameters().cashDrawer ?? '').trim().toLowerCase();
    const mode = v === '' || v === 'כבוי' || v === 'off' || v === 'false' ? 'off' : 'on';
    if (mode === 'off') return;
    if (!this.cashier || stateOf(this.cashier, PERM.DRAWER_ON_CASH_SALE) !== 'allow') return;
    void this.svc.openDrawer().catch((e: unknown) => this.log(`cash drawer: ${String(e)}`));
  }

  private printMode(): { off: boolean; ask: boolean } {
    const params = this.svc.cloud.parameters();
    const reportsOnly = ['דוחות בלבד', 'reports', 'reports_only', 'reportsonly'].includes(String(params.printMode ?? '').trim().toLowerCase());
    const ask = ['true', '1', 'yes', 'כן'].includes(String(params.askBeforePrint ?? '').trim().toLowerCase());
    return { off: reportsOnly, ask: ask && !reportsOnly };
  }

  private printOrAsk(doc: DocDraft) {
    const m = this.printMode();
    if (m.off) return;
    if (m.ask) {
      this.checkout.askPrint = true;
      return;
    }
    this.printReceipt(doc, false);
  }

  private printReceipt(doc: DocDraft, copy: boolean) {
    const job = this.svc.printDocReceipt(doc, copy);
    if (!job) return;
    this.checkout.receiptJob = job;
    void this.watchPrint(job, doc.id);
  }

  /** A receipt that did not print is a warning on the done screen and a retry — never the sale's problem. */
  private async watchPrint(job: string, docId: string) {
    for (let i = 0; i < 30 && !this.stopped; i++) {
      await new Promise((r) => setTimeout(r, 1_000));
      if (this.stopped) return;
      let j: ReturnType<typeof this.svc.printQueue.job> = null;
      try {
        j = this.svc.printQueue.job(job);
      } catch {
        return; // the service is closing
      }
      if (!j) return;
      if (j.status === 'sent') return;
      if (j.status === 'failed') {
        await this.later(() => {
          if (this.checkout.docId === docId && this.checkout.phase === 'done') {
            this.checkout.printWarning = WORDS.receiptProblem(j.last_error ?? WORDS.noReceiptPrinter);
            this.dirty = true;
            this.commit();
          }
        });
        return;
      }
    }
  }

  private answerPrint(print: boolean) {
    const c = this.checkout;
    if (c.phase !== 'done' || !(c.askPrint || c.printWarning) || !c.docId) return refuse('invalid_args');
    c.askPrint = false;
    c.printWarning = null;
    if (print) {
      const doc = this.svc.ledger.doc(c.docId);
      if (doc) this.printReceipt(doc, false);
    }
    return undefined;
  }

  /**
   * "בדוק שוב" on a card whose answer is unknown (Android recheckCard): the terminal is asked about THE SAME reference
   * (payService.resolveOrphans) — approved completes the sale, certainly not charged voids the document and reopens the
   * tenders, still unknown stays.
   */
  private async recheckCard() {
    this.signedIn();
    const c = this.checkout;
    if (c.phase !== 'card_unknown' || !c.docId) return refuse('invalid_args');
    await this.svc.settleOrphans();
    const doc = this.svc.ledger.doc(c.docId);
    if (!doc) return refuse('invalid_args');
    if (doc.status === 'completed') this.finalize(doc);
    else if (doc.status === 'cancelled') this.cardFailed('העסקה לא חויבה');
    else c.cardError = WORDS.cardPending;
    return undefined;
  }

  /** "סמן כלא אושר והמשך" — a manager's code (CARD_UNRESOLVED), after checking the terminal: void and forget. */
  private markNotApproved() {
    const user = this.signedIn();
    const c = this.checkout;
    if (c.phase !== 'card_unknown' || !c.docId) return refuse('invalid_args');
    const docId = c.docId;
    return this.gate(
      'CARD_UNRESOLVED',
      (by) => {
        const attempt = this.svc.pay.attempts().find((a) => a.transactionId === docId);
        const who = by ?? { id: user.id, name: displayName(user) };
        if (attempt) this.svc.pay.markNotApproved(attempt.vuid, who, (att, meta) => this.svc.ledger.voidCardSale(att.transactionId, meta));
        else this.svc.ledger.voidCardSale(docId, null);
        this.cardFailed('העסקה סומנה כלא אושרה באישור מנהל');
        void this.svc.sync.flush();
        return undefined;
      },
      { askOnDeny: true },
    );
  }

  /* --------------------------------------------------------- documents, copies */

  private history() {
    this.signedIn();
    return this.svc.ledger
      .todaysDocs(localDate(this.nowFn()))
      .slice(0, 40)
      .map((d) => ({ id: d.id, ref: formatDocNumber(d.prefix, String(d.number)), totalAgorot: d.totals.totalAgorot, at: d.createdAt, cashier: d.cashierName, methods: legsOf(d).map((l) => l.method) }));
  }

  private reprint(documentId: string) {
    this.signedIn();
    const doc = this.svc.ledger.doc(documentId);
    if (!doc || doc.status !== 'completed') return refuse('invalid_args');
    // The copy of the sale just done, on its own done screen, is the checkout's (Android CheckoutViewModel.reprint): no code.
    if (this.checkout.phase === 'done' && this.checkout.docId === documentId) {
      this.svc.printDocReceipt(doc, true);
      return undefined;
    }
    return this.gate(PERM.REPRINT, () => {
      // The checkout's own "הדפס העתק" (the sale just done) and the history's: a copy, as the Android till prints it.
      this.svc.printDocReceipt(doc, true);
      return undefined;
    });
  }

  /* ------------------------------------------------------------------- shift */

  private noShiftsHere(): never {
    return refuse('permission_denied', 'בקופה הזו אין משמרות — הפקת Z סוגרת את המשמרת הפנימית');
  }

  private shiftOpen(opening: unknown) {
    const user = this.signedIn();
    if (this.shiftsHidden()) this.noShiftsHere();
    if (this.svc.ledger.currentShift()) refuse('shift_open');
    const amount = opening === undefined ? 0 : opening;
    if (!isInt(amount, 0, 100_000_000)) refuse('invalid_args');
    return this.gate(PERM.SHIFT_OPEN, () => {
      // The shift is the employee's: opened by them with the float counted into the drawer.
      this.svc.ledger.openShift({ id: user.id, name: displayName(user) }, new Date(this.nowFn()), amount as number);
      void this.svc.sync.flush();
      return undefined;
    });
  }

  private xFigures(shiftId: string) {
    const shift = this.svc.ledger.shift(shiftId)!;
    return { shift, ...buildXTill(this.svc.ledger.docsOfShift(shiftId).map(xDocOf), shift.opening_cash, this.svc.vatRate()) };
  }

  /** The shift closed with the counted cash: X frozen into the close and printed, the documents flushed (no gate: the callers' own). */
  private closeNow(user: RosterUser, counted: number) {
    const closed = this.svc.ledger.closeShift({ closedByName: displayName(user), closedByUserId: user.id, vatRate: this.svc.vatRate(), countedCashAgorot: counted, now: new Date(this.nowFn()) });
    if (closed.kind === 'pending') return refuse('checkout_busy', WORDS.pendingBlocksClose(closed.count));
    if (closed.kind === 'none') return refuse('shift_closed');
    const fig = this.xFigures(closed.shift.id);
    // The internal shift of an independent till has no paper of its own: its Z is the paper.
    if (!this.shiftsHidden()) {
      this.svc.printX({
        refId: `x:${closed.shift.id}`,
        cashierName: displayName(user),
        shiftNumber: closed.shift.sequence_number,
        businessDate: closed.shift.business_date,
        openedAt: new Date(closed.shift.opened_at),
        closedAt: new Date(closed.shift.closed_at ?? this.nowFn()),
        till: fig.till,
        countedCash: counted / 100,
      });
    }
    void this.svc.sync.flush();
    const report = this.xReportOf(fig.till, closed.shift.sequence_number);
    return { ...report, countedCashAgorot: counted, differenceAgorot: counted - report.expectedCashAgorot, message: this.svc.outbox.count() === 0 ? WORDS.shiftClosedSynced : WORDS.shiftClosedQueued };
  }

  private shiftClose(counted: unknown) {
    const user = this.signedIn();
    if (this.shiftsHidden()) this.noShiftsHere();
    const shift = this.svc.ledger.currentShift();
    if (!shift) return refuse('shift_closed');
    if (this.cart.length > 0 || this.checkout.phase !== 'idle') refuse('checkout_busy');
    if (!isInt(counted, 0, 100_000_000)) refuse('invalid_args');
    const pendingDocs = this.svc.ledger.pendingInShift(shift.id);
    if (pendingDocs > 0) refuse('checkout_busy', WORDS.pendingBlocksClose(pendingDocs));
    return this.gate(PERM.SHIFT_CLOSE, () => this.closeNow(user, counted as number));
  }

  private xReportOf(t: ReturnType<typeof buildXTill>['till'], number: number | null): XReport {
    const a = (shekels: number) => ofShekels(shekels);
    return {
      shiftNumber: number,
      salesCount: t.transactionsCount,
      salesAgorot: a(t.totalSales - t.totalDiscounts - t.totalRefunds),
      cashAgorot: a(t.totalCash),
      cardAgorot: a(t.totalCard),
      expectedCashAgorot: a(t.expectedCash),
      demo: false,
      openingCashAgorot: a(t.openingCash),
      discountsAgorot: a(t.totalDiscounts),
      refundsAgorot: a(t.totalRefunds),
      vatAgorot: a(t.vatTotal ?? 0),
      tipsAgorot: a(t.totalTips),
      itemsCount: t.itemsCount,
    };
  }

  private reportX() {
    const user = this.signedIn();
    if (this.shiftsHidden()) this.noShiftsHere();
    const shift = this.svc.ledger.currentShift();
    if (!shift) return refuse('shift_closed');
    return this.gate(PERM.X, () => {
      const fig = this.xFigures(shift.id);
      this.svc.printX({
        refId: `x:${shift.id}:${this.nowFn()}`,
        cashierName: displayName(user),
        shiftNumber: shift.sequence_number,
        businessDate: shift.business_date,
        openedAt: new Date(shift.opened_at),
        closedAt: null,
        till: fig.till,
        countedCash: null,
      });
      return { ...this.xReportOf(fig.till, shift.sequence_number), printed: true };
    });
  }

  /**
   * "הפק Z" (Android TillZRepository): only where this till makes its own Z (zMode = till). An open shift is closed first
   * (counted, X printed), then the machine's Z through tillZService — the one path that numbers a Z, strictly sequential,
   * offline-safe. In the shop's Z mode closing the shift is all this till does.
   */
  private async zProduce(counted: unknown) {
    const user = this.signedIn();
    if (zModeOf(this.svc.cloud.heartbeat().zMode) !== 'till') refuse('permission_denied', WORDS.zDisabled);
    if (this.checkout.phase !== 'idle' || this.cart.length > 0) refuse('checkout_busy');
    return this.gate(PERM.Z, async () => {
      const open = this.svc.ledger.currentShift();
      if (open) {
        // "משמרת #N פתוחה. היא תיסגר קודם": counted, X printed, then the Z (the Z's own permission covers the close).
        if (!isInt(counted, 0, 100_000_000)) refuse('invalid_args', WORDS.zConfirmOpenShift(open.sequence_number));
        const pendingDocs = this.svc.ledger.pendingInShift(open.id);
        if (pendingDocs > 0) refuse('checkout_busy', WORDS.pendingBlocksClose(pendingDocs));
        this.closeNow(user, counted as number);
        // The close must be on the cloud before its Z (a flush already under way may have missed it: again, a few times).
        for (let i = 0; i < 3 && this.svc.ledger.closingCount() > 0; i++) await this.svc.sync.flush();
      }
      if (this.svc.isOffline) refuse('engine_offline', WORDS.zNeedsConnection);
      const z = await this.svc.tillZ.produce(displayName(user), false);
      if (z.kind === 'produced') {
        const n = Number(z.z.machineSequenceNumber ?? z.z.zNumber);
        this.lastZNumber = Number.isFinite(n) ? n : this.lastZNumber;
        return { zNumber: this.lastZNumber, message: WORDS.zDone(n) };
      }
      if (z.kind === 'refused') return refuse('invalid_args', z.refusal === 'nothing_to_report' ? WORDS.zNothing : WORDS.zCloudError);
      if (z.kind === 'waiting') return refuse('invalid_args', WORDS.zNotAccepted);
      if (z.kind === 'offline') return refuse('engine_offline', WORDS.zNeedsConnection);
      return refuse('invalid_args', WORDS.zCloudError);
    });
  }

  /* -------------------------------------------------------------------- mode */

  private modeSwitch(to: DeviceRoleName, managerCode: string | null) {
    const wm = this.attachedMode;
    if (to !== 'kiosk' || !wm || !wm.offered().toKiosk) return refuse('role_not_allowed');
    const user = this.signedIn();
    const refusal = wm.mayReturn();
    if (refusal) return refuse('mode_switch_busy', refusal.text, { reason: refusal.wire });
    const back = !wm.homeTill();
    const go = async (by: Approver) => {
      const r = await wm.returnToKiosk('manual', by.name, by.id);
      if (r) return refuse('mode_switch_busy', r.text, { reason: r.wire });
      // The employee's session ends with the till mode (Android: session.signOut).
      this.cashier = null;
      this.locked = true;
      this.cart = [];
      return undefined;
    };
    const check = async (code: string) => {
      const m = await wm.checkManagerCode(code);
      return m.ok ? ({ ok: true, by: { id: m.id, name: m.name } } as const) : ({ ok: false, message: m.message } as const);
    };
    // Always a manager's code with KIOSK_TILL_MODE: the employee signed in counts when they hold it.
    if (stateOf(user, PERM.KIOSK_TILL_MODE) === 'allow') return go({ id: user.id, name: displayName(user) });
    if (managerCode) {
      return (async () => {
        const v = await check(managerCode);
        if (!v.ok) return refuse('wrong_pin', v.message);
        return go(v.by);
      })();
    }
    const title = back ? WORDS.workModeApproveBack : WORDS.workModeApproveToKiosk;
    this.openDialog({
      kind: 'manager_approval',
      title,
      body: title,
      fields: [{ name: 'pin', label: WORDS.managerCode, kind: 'pin' }],
      actions: [
        { id: 'approve', label: WORDS.approve, primary: true },
        { id: 'cancel', label: WORDS.cancel },
      ],
      code: null,
      // The runtime checks the code itself (KIOSK_TILL_MODE against the roster, with its own lock).
      verify: check,
      resume: (by) => (by ? go(by) : undefined),
    });
    return { dialogId: this.pending!.dialog.id };
  }

  /* ------------------------------------------------------------------- state */

  private cartView(): { lines: CartLine[]; totals: SaleTotals | null; gone: string[] } {
    if (this.cart.length === 0) return { lines: [], totals: null, gone: [] };
    // After a payment opened, what it was priced from; else the cart as priced now.
    const p = this.checkout.frozen && this.checkout.phase !== 'idle' ? { ...this.checkout.frozen, gone: [] as string[] } : this.priced();
    const byKey = new Map(p.lines.map((l) => [l.key, l] as const));
    const lines: CartLine[] = [];
    for (const rec of this.cart) {
      const l = byKey.get(rec.lineId);
      if (!l) continue;
      const unit = unitAgorot(l);
      const gross = unit * l.qty;
      lines.push({ lineId: rec.lineId, productId: rec.productId, name: l.name, qty: l.qty, unitAgorot: unit, discountPct: 0, totalAgorot: gross - (l.promotionAgorot ?? 0) });
    }
    return { lines, totals: p.totals, gone: p.gone };
  }

  private buildState(): TillState {
    const user = this.cashier;
    const view = this.cartView();
    // A line the catalog no longer sells is dropped from the cart the next time it is looked at (never mid-payment).
    if (view.gone.length > 0 && this.checkout.phase === 'idle') {
      this.cart = this.cart.filter((l) => !view.gone.includes(l.lineId));
    }
    const t = view.totals;
    const c = this.checkout;
    const approved = this.approvedLegs();
    const paid = paidOf(approved) + (c.phase === 'done' ? 0 : 0);
    const shift = this.svc.ledger.currentShift();
    const last = this.svc.ledger.lastClosedShift();
    const fig = shift ? this.xFigures(shift.id).till : null;
    const zMode = zModeOf(this.svc.cloud.heartbeat().zMode);
    const lastZ = this.svc.tillZ.list(1)[0]?.number ?? this.lastZNumber;
    const wm = this.attachedMode;
    const offered = wm?.offered() ?? { toTill: false, toKiosk: false };
    const homeTill = wm ? wm.homeTill() : true;
    const permissions = user ? SESSION_CODES.filter((code) => stateOf(user, code) !== 'deny') : [];
    const health = this.svc.printQueue.health();
    const terminal = this.svc.pay.cardInFlight ? 'busy' : this.svc.pay.configured && this.svc.pay.monitor.state !== 'unreachable' ? 'ok' : 'none';
    const checkoutPhase: CheckoutState['phase'] = c.phase === 'card_unknown' ? 'tender' : c.phase;
    const dialog = this.pending?.dialog ?? null;
    const state: TillState = {
      protocol: TILL_PROTOCOL,
      session: { cashier: user && !this.locked ? { id: user.id, name: displayName(user) } : null, locked: this.locked || !user, permissions, demo: false },
      sell: {
        catalogVersion: this.catalogVersion(),
        departmentId: this.department,
        search: this.search,
        lines: view.lines,
        itemCount: view.lines.reduce((s, l) => s + l.qty, 0),
        totalAgorot: t?.totalAgorot ?? 0,
        vatAgorot: t?.vatAgorot ?? 0,
        promotionsAgorot: t?.discountAgorot ?? 0,
      },
      checkout: {
        phase: checkoutPhase,
        totalAgorot: c.phase === 'idle' ? 0 : c.totalAgorot,
        paidAgorot: c.phase === 'done' ? c.totalAgorot : paid,
        dueAgorot: c.phase === 'idle' || c.phase === 'done' ? 0 : dueOf(c.totalAgorot, approved),
        changeAgorot: c.changeAgorot,
        legs: c.legs.map((l) => ({ method: l.method, amountAgorot: l.amountAgorot, status: l.status })),
        documentRef: c.documentRef,
        documentId: c.phase === 'done' ? c.docId : null,
        tenderedAgorot: handedTotal(approved),
        askPrint: c.askPrint,
        printWarning: c.printWarning,
        cardStatus: c.cardStatus,
        cardError: c.phase === 'card_unknown' ? (c.cardError ?? WORDS.cardPending) : c.cardError,
        cardUnknown: c.phase === 'card_unknown',
      },
      shift: {
        hidden: this.shiftsHidden(),
        open: !!shift,
        number: shift?.sequence_number ?? last?.sequence_number ?? null,
        openedAt: shift?.opened_at ?? null,
        openingCashAgorot: shift?.opening_cash ?? 0,
        salesCount: fig?.transactionsCount ?? 0,
        salesAgorot: fig ? ofShekels(fig.totalSales - fig.totalDiscounts - fig.totalRefunds) : 0,
        cashAgorot: fig ? ofShekels(fig.totalCash) : 0,
        cardAgorot: fig ? ofShekels(fig.totalCard) : 0,
      },
      z: {
        lastNumber: lastZ ?? null,
        canProduce: zMode === 'till',
        reason: zMode === 'till' ? null : WORDS.zDisabled,
        zMode: zMode === 'till' ? 'till' : 'shop',
      },
      health: {
        cloud: this.svc.isOffline ? 'offline' : 'online',
        printer: health === 'ok' ? 'ok' : health === 'unknown' ? 'none' : 'error',
        terminal,
        outbox: this.svc.outbox.count(),
      },
      dialog,
      mode: {
        role: (homeTill ? 'till' : 'kiosk') as DeviceRoleName,
        current: 'till',
        rolesAllowed: offered.toKiosk ? ['kiosk'] : [],
        switchLabel: homeTill ? WORDS.workModeMenuToKiosk : WORDS.workModeMenuBack,
        countdownSec: wm?.countdownSec() ?? null,
      },
    };
    return state;
  }

  /** Whether a payment, a cart or a question is open (the update and the mode switch wait for it). */
  get busy(): boolean {
    return this.cart.length > 0 || this.checkout.phase !== 'idle' || this.pending !== null || this.svc.pay.cardInFlight;
  }

  get lastActivity(): number {
    return this.lastActivityAt;
  }

  /** A till document left pending by a crash or a restart mid-card: the sale is not lost, the answer is asked for. */
  private restorePending() {
    const doc = this.svc.ledger.pendingDocs().find((d) => d.channel === 'till');
    if (!doc) return;
    this.checkout = {
      ...idleCheckout(),
      phase: 'card_unknown',
      totalAgorot: doc.totals.totalAgorot,
      docId: doc.id,
      legs: (doc.payments ?? []).map((l) => ({ method: l.method, amountAgorot: l.amountAgorot, handedAgorot: l.method === 'cash' ? l.amountAgorot : 0, status: l.method === 'card' ? ('pending' as const) : ('approved' as const) })),
      cardError: WORDS.cardPending,
      frozen: { lines: doc.lines, tracked: doc.tracked, promotions: doc.promotions ?? [], totals: doc.totals },
    };
  }
}

export { quickNotes, permLabel };
