/**
 * "מזומן במכשיר" on the Windows till — the Android till's (ui/checkout/CheckoutViewModel.kt `payOnCashMag` →
 * `recordDeviceCash`, data/repo/CashMagPayFlow.kt, ui/settings/CashMagScreen.kt) on the kiosk's own clients:
 *
 *  - CashMag (kiosk/cashmagPay.ts, P:/specs/cashmag-windows.md) when the cloud turned `cashmagEnabled` on for this till, else
 *    the shop's PayLink cash station (kiosk/cashPay.ts, P:/specs/cash-paylink.md §11, §14 — the LAN, the cloud relay or the
 *    host kiosk, as `cashRoute` says) when the cloud assigned one to this till; the device's own journal on the disk BEFORE
 *    the device is asked anything (each client's), under `till:<document id>` — the kiosk's recovery leaves these alone;
 *  - the pending document written (numbered) BEFORE the device is asked, as a card's; completed on a plain "paid" only, with
 *    one cash leg for what was left naming the device's transaction (core/till/deviceCash.ts); voided on a cancel, a refusal
 *    or a fault — never a document without a clear answer, never two for one transaction;
 *  - the machine someone else's: "…בשימוש כרגע על ידי לקוח אחר — יש להמתין לסיום", the payment going on by itself when it is
 *    free, a small "חזרה" (first come first served — never taking the machine);
 *  - change owed: "חסר עודף במכשיר" asked before the document when there is more than a slip to choose; a CashMag slip is
 *    given from the drawer ("נתתי מהמגירה" — a cash out under the drawer's rules), a station's goes to "עודף חייב ללקוח";
 *  - a CashMag fault: no document, CashMag blocked until a manager says "טופל" (`CASH_DRAWER.APPROVE_OPEN`); a station
 *    silent mid-payment: not known — "בדוק שוב", or a manager's "סמן כלא שולם";
 *  - after a restart: what each device's journal says — paid → the document now (no paper), sent and never answered → the
 *    staff's; a station's word asked again;
 *  - no drawer opens for it: the money is in the device (and the drawer's expected cash leaves it out — core/sale.ts).
 *
 * The Windows till has no training mode (core/till/tillMenu.ts): there is no simulated payment to offer.
 */

import { CASHMAG_BUSY_TEXT, CASHMAG_ERRORS } from '../../core/cash/cashmag';
import { shekelText } from '../../core/cash/settings';
import { shortTx, type OwedChoice, type TxView } from '../../core/cash/tx';
import {
  DEVICE_CASH_TEXT as T,
  deviceKindOf,
  deviceLegOf,
  deviceOwedChoices,
  isTillCashRef,
  tillCashRef,
  type DeviceCashScreen,
  type DeviceCashState,
  type DeviceCashView,
  type DeviceKind,
  type DeviceLegMeta,
} from '../../core/till/deviceCash';
import { formatDocNumber } from '../../core/documentNumbers';
import type { DocDraft } from '../fiscal/ledger';
import { txViewOf as cashmagTxView, type CashMagPay, type CashMagProgress } from '../kiosk/cashmagPay';
import { queuedMessage, type CashOutcome, type CashPay, type CashProgress } from '../kiosk/cashPay';
import type { TillContext, TillFeature } from './tillContext';

/** The engine asks a question before the payment opens (its answer runs the payment again): the dialog's reply. */
export class DeviceGate extends Error {
  constructor(readonly reply: { dialogId: string }) {
    super('device cash: a question first');
  }
}

export const DEVICE_CASH_OPS = [
  'deviceCash.pay',
  'deviceCash.cancel',
  'deviceCash.answer',
  'deviceCash.recheck',
  'deviceCash.markNotPaid',
  'deviceCash.owedPaid',
  'deviceCash.open',
  'deviceCash.close',
  'deviceCash.acknowledge',
  'deviceCash.check',
] as const;

const APPROVE = 'CASH_DRAWER.APPROVE_OPEN';

/** The kiosk's CashMag client as the till uses it (tests: the real one over a fake recycler). */
export type CashMagPort = Pick<CashMagPay, 'enabled' | 'config' | 'refusal' | 'offReason' | 'usable' | 'pay' | 'cancel' | 'answerQuestion' | 'ack' | 'journal' | 'unresolved' | 'acknowledge' | 'settle' | 'probe' | 'driverState' | 'inFlight'> & {
  onChange?(fn: () => void): () => void;
};

/** The kiosk's cash station client as the till uses it (tests: a fake). */
export type PaylinkPort = Pick<CashPay, 'configured' | 'usable' | 'offReason' | 'station' | 'settings' | 'pay' | 'cancel' | 'ack' | 'lookUp' | 'cancelAt' | 'pending' | 'forget' | 'inFlight' | 'refreshStatus'> & {
  onChange?(fn: () => void): () => void;
};

/** What the engine does for the payment (its checkout, its ledger, its done screen). */
export interface DeviceCashHooks {
  /** The payment opens: the checkout checked (refused by throwing) and the pending document written with the device's leg. */
  begin(kind: DeviceKind): { docId: string; amountAgorot: number };
  /** The document completed from what the device said (the earlier legs, the device's for what was left). Null: not written. */
  complete(docId: string, meta: DeviceLegMeta): DocDraft | null;
  /** Certainly not paid: the document voided with its evidence. */
  void(docId: string, meta: Record<string, unknown>): void;
  /** The live sale paid: the done screen. */
  done(doc: DocDraft): void;
  /** The live sale not paid: back to the tenders, the words shown. */
  failed(message: string): void;
  /** The live sale's answer not known: the checkout waits for it. */
  unknown(message: string): void;
  /** The document of the payment on the checkout now (live or not known), or null. */
  liveDocId(): string | null;
  /** This sale takes a cash tip (the change owed may be left as one). */
  tipOk(): boolean;
}

interface Live {
  kind: DeviceKind;
  docId: string;
  amountAgorot: number;
  view: DeviceCashView;
}

export interface TillDeviceCashDeps {
  cashmag?: CashMagPort;
  paylink?: PaylinkPort;
  /** The till's cloud answers now (a credit for the change owed is the cloud's). */
  online?: () => boolean;
  /** The settle's pace (tests: none). */
  settleEveryMs?: number;
}

export class TillDeviceCash implements TillFeature {
  readonly key = 'deviceCash';
  readonly ops: readonly string[] = DEVICE_CASH_OPS;
  readonly mutating: readonly string[] = ['deviceCash.pay', 'deviceCash.cancel', 'deviceCash.answer', 'deviceCash.markNotPaid', 'deviceCash.owedPaid', 'deviceCash.acknowledge'];

  private readonly mag: CashMagPort;
  private readonly link: PaylinkPort;
  private readonly online: () => boolean;
  private live: Live | null = null;
  /** The last payment's done look, until the sale screen leaves it. */
  private doneView: DeviceCashView | null = null;
  private screenOpen = false;
  private timers: NodeJS.Timeout[] = [];
  private offs: Array<() => void> = [];
  private settling: Promise<void> | null = null;
  private stopped = false;
  /** The payment under way (the tests wait for it; never sent to a screen). */
  lastRun: Promise<void> | null = null;

  constructor(
    private readonly c: TillContext,
    private readonly h: DeviceCashHooks,
    private readonly deps: TillDeviceCashDeps = {},
  ) {
    this.mag = deps.cashmag ?? c.svc.cashMag;
    this.link = deps.paylink ?? c.svc.cashPay;
    this.online = deps.online ?? (() => c.svc.cloudOnline());
  }

  start() {
    for (const port of [this.mag, this.link]) {
      const off = port.onChange?.(() => this.c.changed());
      if (off) this.offs.push(off);
    }
    // What a restart left, then every half minute (a station that was silent may answer now).
    const tick = () => void this.c.later(() => this.settle()).catch((e: unknown) => this.c.log(`device cash settle: ${String(e)}`));
    const t1 = setTimeout(tick, 1_500);
    t1.unref?.();
    this.timers.push(t1);
    const every = this.deps.settleEveryMs ?? 30_000;
    if (every > 0) {
      const t2 = setInterval(tick, every);
      t2.unref?.();
      this.timers.push(t2);
    }
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
    for (const off of this.offs) off();
    this.offs = [];
  }

  /* ------------------------------------------------------------------ what the till takes cash at */

  kind(): DeviceKind | null {
    return deviceKindOf({ cashmagEnabled: this.mag.enabled(), paylinkConfigured: this.link.configured() });
  }

  private name(kind: DeviceKind | null): string {
    if (kind === 'cashmag') return T.cashmagName;
    if (kind === 'paylink') return this.link.station()?.name ?? 'עמדת מזומן';
    return '';
  }

  /** Why the button is off now (Hebrew); null — it may be pressed. */
  private reason(kind: DeviceKind | null): string | null {
    if (!kind) return T.notConfigured;
    if (this.live) return T.busyHere;
    if (kind === 'cashmag') return this.mag.offReason();
    return this.link.usable() ? null : (this.link.offReason() ?? 'מכשיר המזומן לא זמין');
  }

  /** A payment of this till's at a device is on (live, or its answer not known). */
  get busy(): boolean {
    return this.live !== null;
  }

  /** The payment's look on the checkout (the engine's `checkout.deviceCash`). */
  checkoutView(): DeviceCashView | null {
    return this.live?.view ?? this.doneView;
  }

  /** The sale screen left the done payment (a new sale). */
  clearDone() {
    this.doneView = null;
  }

  state(): DeviceCashState | undefined {
    const kind = this.kind();
    const unresolved = this.mag.unresolved().filter((e) => isTillCashRef(e.orderId)).length;
    if (!kind && unresolved === 0 && !this.screenOpen) return undefined;
    const reason = this.reason(kind);
    return { kind, name: this.name(kind), available: reason === null, reason, unresolvedCount: unresolved, screen: this.screenOpen ? this.screen(kind) : null };
  }

  private screen(kind: DeviceKind | null): DeviceCashScreen {
    const rows: DeviceCashScreen['rows'] = [];
    const src = (s: string) => (s === 'cloud' ? T.sourceCloud : s === 'local' ? T.sourceLocal : T.sourceDefault);
    if (kind === 'cashmag' || this.mag.journal().length > 0) {
      const cfg = this.mag.config();
      const st = this.mag.driverState();
      rows.push({ label: 'מכשיר', value: 'CashMag' });
      rows.push({ label: 'שרת', value: `${cfg.host || '—'}:${cfg.port || '—'} (${src(cfg.sources.host)})`, ltr: true });
      rows.push({ label: 'שם הקופה בשרת', value: `${cfg.terminal} (${src(cfg.sources.terminal)})` });
      rows.push({ label: 'קוד משתמש', value: cfg.userCode ? 'מוגדר' : 'לא מוגדר' });
      rows.push({ label: 'פרוטוקול', value: cfg.protocol === cfg.wire ? cfg.wire : `${cfg.wire} (מהענן: ${cfg.protocol})`, ltr: true });
      rows.push({ label: 'עיגול', value: cfg.rounding === 'none' ? 'ללא' : 'לעשרות אגורות' });
      rows.push({ label: 'זיכוי לעודף חייב', value: cfg.owedCredit ? 'כן' : 'לא' });
      if (st?.connection) rows.push({ label: 'חיבור', value: st.connection, ltr: true });
      if (st?.lastError) rows.push({ label: 'שגיאה אחרונה', value: st.lastError, ltr: true });
    }
    if (kind === 'paylink' || (kind === null && this.link.configured())) {
      const s = this.link.station();
      const set = this.link.settings();
      rows.push({ label: 'מכשיר', value: 'PayLink' });
      rows.push({ label: 'עמדה', value: s?.name ?? '—' });
      if (s?.lanAddress) rows.push({ label: 'כתובת', value: `${s.lanAddress}:${s.port}`, ltr: true });
      rows.push({ label: 'נתיב', value: set.route === 'cloud' ? 'דרך הענן' : set.route === 'auto' ? 'אוטומטי' : 'רשת מקומית' });
    }
    const usable = kind === 'cashmag' ? this.mag.usable() : kind === 'paylink' ? this.link.usable() : false;
    return {
      rows,
      usable,
      reason: kind ? (usable ? null : this.reason(kind)) : T.notConfigured,
      unresolved: this.mag
        .unresolved()
        .filter((e) => isTillCashRef(e.orderId))
        .map((e) => ({ txId: e.txId, txShort: shortTx(e.txId), amountAgorot: e.amountAgorot, startedAt: e.startedAt, outcome: e.outcome, heldAgorot: e.heldAgorot, reason: e.reason })),
      pending: this.link
        .pending()
        .filter((p) => isTillCashRef(p.orderId))
        .map((p) => ({ txShort: shortTx(p.txId), amountAgorot: p.amountAgorot, startedAt: p.startedAt })),
    };
  }

  /* ------------------------------------------------------------------ the ops */

  apply(op: string, a: Record<string, unknown>): unknown {
    switch (op) {
      case 'deviceCash.pay':
        return this.pay();
      case 'deviceCash.cancel':
        return this.cancel();
      case 'deviceCash.answer':
        return this.answer(a.confirm === true);
      case 'deviceCash.recheck':
        return this.recheck();
      case 'deviceCash.markNotPaid':
        return this.markNotPaid();
      case 'deviceCash.owedPaid':
        return this.owedPaid();
      case 'deviceCash.open':
        this.c.signedIn();
        return this.c.gate(APPROVE, () => {
          this.screenOpen = true;
          return undefined;
        }, { askOnDeny: true });
      case 'deviceCash.close':
        this.screenOpen = false;
        return undefined;
      case 'deviceCash.acknowledge':
        return this.acknowledge(a.txId);
      case 'deviceCash.check':
        return this.check();
      default:
        return this.c.refuse('invalid_args');
    }
  }

  /** "מזומן במכשיר · X ₪": the payment at the device, to its end (the op returns at once; the screens follow its state). */
  private pay() {
    this.c.signedIn();
    const kind = this.kind();
    if (!kind) return this.c.refuse('invalid_args', T.notConfigured);
    if (this.live) return this.c.refuse('checkout_busy', T.busyHere);
    const why = kind === 'cashmag' ? this.mag.refusal() : this.link.usable() ? null : (this.link.offReason() ?? 'מכשיר המזומן לא זמין');
    if (why) return this.c.refuse('invalid_args', why);
    if ((kind === 'cashmag' && this.mag.inFlight) || (kind === 'paylink' && this.link.inFlight)) return this.c.refuse('checkout_busy', T.busyHere);
    // The checkout's own refusals, then the pending document — before the device hears anything.
    let opened: { docId: string; amountAgorot: number };
    try {
      opened = this.h.begin(kind);
    } catch (e) {
      // A question first (the vouchers' close): its answer comes back to this op.
      if (e instanceof DeviceGate) return e.reply;
      throw e;
    }
    const { docId, amountAgorot } = opened;
    this.doneView = null;
    this.live = {
      kind,
      docId,
      amountAgorot,
      view: {
        kind,
        name: this.name(kind),
        stage: 'connecting',
        message: T.connecting,
        insertedAgorot: 0,
        dueAgorot: amountAgorot,
        canCancel: true,
        cancelLabel: T.back,
        question: null,
        position: null,
        longWait: false,
        txShort: null,
        done: null,
      },
    };
    this.c.log(`device cash (${kind}): ${amountAgorot} agorot for document ${docId}`);
    this.lastRun = this.run(this.live).catch((e: unknown) => this.c.log(`device cash: ${String(e)}`));
    return undefined;
  }

  private say(l: Live, p: Partial<DeviceCashView>) {
    if (this.live !== l) return;
    l.view = { ...l.view, ...p };
    this.c.changed();
  }

  private async run(l: Live): Promise<void> {
    let outcome: CashOutcome;
    try {
      outcome =
        l.kind === 'cashmag'
          ? await this.mag.pay({ orderId: tillCashRef(l.docId), docId: l.docId, amountAgorot: l.amountAgorot }, (p) => this.onMag(l, p))
          : await this.link.pay({ orderId: tillCashRef(l.docId), docId: l.docId, amountAgorot: l.amountAgorot, orderLabel: null }, (p) => this.onLink(l, p));
    } catch (e) {
      // Never "nothing happened" on a guess: journaled → the staff's (CashMag) / asked again (the station).
      this.c.log(`device cash payment: ${e instanceof Error ? e.message : String(e)}`);
      const entry = l.kind === 'cashmag' ? this.mag.journal().find((x) => x.docId === l.docId) : null;
      const pend = l.kind === 'paylink' ? this.link.pending().find((x) => x.docId === l.docId) : null;
      outcome = entry ? { kind: 'held', tx: cashmagTxView(entry, { state: 'HELD', outcome: null, inserted: 0, held: 0, message: CASHMAG_ERRORS.EXCEPTION }) } : pend ? { kind: 'lost', txId: pend.txId, insertedAgorot: 0 } : { kind: 'refunded', tx: null, message: 'מכשיר המזומן לא זמין' };
    }
    if (this.stopped) return;
    await this.outcome(l, outcome);
  }

  private onMag(l: Live, p: CashMagProgress) {
    const waiting = p.stage === 'connecting' || p.stage === 'busy';
    this.say(l, {
      stage: p.stage === 'question' ? 'question' : p.stage === 'busy' ? 'busy' : p.stage === 'settling' ? 'settling' : p.stage === 'connecting' ? 'connecting' : 'insert',
      message: p.stage === 'busy' ? CASHMAG_BUSY_TEXT : p.stage === 'insert' ? T.insert : p.message,
      insertedAgorot: p.insertedAgorot,
      dueAgorot: p.dueAgorot,
      canCancel: p.canCancel,
      cancelLabel: waiting ? T.back : T.cancel,
      question: p.question,
    });
  }

  private onLink(l: Live, p: CashProgress) {
    const waiting = p.stage === 'connecting' || p.stage === 'queued';
    const tx = p.tx;
    this.say(l, {
      stage: p.stage === 'queued' ? 'busy' : p.stage === 'connecting' ? 'connecting' : p.stage === 'insert' ? 'insert' : 'settling',
      message: p.stage === 'queued' ? queuedMessage(p.position ?? 1, p.longWait === true) : p.message || (p.stage === 'insert' ? T.insert : T.settling),
      insertedAgorot: tx?.insertedAgorot ?? 0,
      dueAgorot: tx?.dueAgorot ?? l.amountAgorot,
      // The station's own rule (§11.6 3): a cancel until the amount is in.
      canCancel: waiting || (p.stage === 'insert' && (tx?.remainingAgorot ?? 1) > 0),
      cancelLabel: waiting ? T.back : T.cancel,
      position: p.position,
      longWait: p.longWait === true,
      txShort: tx ? shortTx(tx.txId) : null,
    });
  }

  /** What the device's word means for the sale: the document on a plain "paid" only. */
  private async outcome(l: Live, o: CashOutcome): Promise<void> {
    if (o.kind === 'paid') {
      const tx = o.tx;
      let owedAs: OwedChoice | null = tx.changeOwedAgorot > 0 ? (tx.changeOwedAs ?? null) : null;
      if (tx.changeOwedAgorot > 0 && !owedAs) owedAs = await this.askOwed(l, tx);
      await this.c.later(async () => {
        const meta = deviceLegOf(tx, owedAs);
        const doc = this.h.complete(l.docId, meta);
        const written = doc && doc.status === 'completed';
        if (l.kind === 'cashmag') await this.mag.ack(tx.txId, written ? doc.id : null);
        else await this.link.ack(tx.txId, written ? doc.id : null, written ? formatDocNumber(doc.prefix, doc.number) : null, null, { changeOwedAs: owedAs });
        this.live = null;
        if (!written) {
          this.c.log(`device cash ${shortTx(tx.txId)}: paid, the document not written`);
          this.h.unknown(T.documentFailed(shortTx(tx.txId)));
          this.c.changed();
          return;
        }
        const owed = tx.changeOwedAgorot;
        const slip = owed > 0 && owedAs !== 'tip' && owedAs !== 'credit';
        const notice = [
          tx.changePaidAgorot > 0 ? T.gave(shekelText(tx.changePaidAgorot)) : null,
          owed > 0 && owedAs === 'credit' ? T.owedCreditDone(shekelText(owed), tx.slipCode ?? '') : null,
          owed > 0 && owedAs === 'tip' ? T.owedTipDone(shekelText(owed)) : null,
          slip ? (l.kind === 'cashmag' ? T.owedSlipBanner(shekelText(owed)) : T.owedSlipPaylink(shekelText(owed))) : null,
        ].filter((x): x is string => !!x);
        this.doneView = {
          ...l.view,
          stage: 'done',
          message: notice.join(' · '),
          insertedAgorot: tx.insertedAgorot,
          canCancel: false,
          question: null,
          txShort: shortTx(tx.txId),
          // A CashMag slip is given from this drawer (the cloud has no debt for it); a station's goes to "עודף חייב ללקוח".
          done: { notice: notice.length > 0 ? notice.join(' · ') : null, owedAgorot: slip ? owed : 0, owedFromDrawer: slip && l.kind === 'cashmag', owedPaid: false },
        };
        this.h.done(doc);
        this.c.changed();
      });
      return;
    }
    await this.c.later(async () => {
      this.live = null;
      if (o.kind === 'refunded') {
        this.h.void(l.docId, { cashTxId: o.tx?.txId ?? null, device: l.kind, outcome: o.tx?.outcome ?? 'cancelled' });
        if (o.tx && l.kind === 'paylink') await this.link.ack(o.tx.txId, null, null);
        const refunded = o.tx?.refundPaidAgorot ?? o.tx?.insertedAgorot ?? 0;
        this.h.failed(o.tx ? (refunded > 0 ? T.cancelledRefunded(shekelText(refunded)) : T.cancelled) : o.message);
      } else if (o.kind === 'held') {
        // A fault: the staff's — no document. CashMag stays blocked until a manager says "טופל".
        this.h.void(l.docId, { cashTxId: o.tx.txId, device: l.kind, outcome: 'held', heldAgorot: o.tx.heldAgorot });
        if (l.kind === 'paylink') await this.link.ack(o.tx.txId, null, null);
        this.h.failed(T.fault(shortTx(o.tx.txId), shekelText(Math.max(o.tx.heldAgorot, o.tx.insertedAgorot))));
      } else {
        // The station went silent: not known. The document waits (pending); the station's word is asked again.
        this.live = { ...l, view: { ...l.view, stage: 'unknown', message: T.lost(shortTx(o.txId)), canCancel: false, question: null, txShort: shortTx(o.txId) } };
        this.h.unknown(T.lost(shortTx(o.txId)));
      }
      this.c.changed();
    });
  }

  /**
   * "חסר עודף במכשיר: X ₪": the cashier's choice before the document — a slip unless something else is on offer; a slip
   * when nobody answers in `cashOwedChoiceSec`.
   */
  private askOwed(l: Live, tx: TxView): Promise<OwedChoice> {
    const choices = deviceOwedChoices({ kind: l.kind, online: this.online(), cashmagOwedCredit: this.mag.config().owedCredit, tipOk: this.h.tipOk() });
    if (choices.length < 2) return Promise.resolve('slip');
    const label = (c: OwedChoice) => (c === 'slip' ? T.owedSlip : c === 'credit' ? T.owedCredit : T.owedTip);
    const secs = Math.max(5, Number(this.c.svc.cloud.parameters().cashOwedChoiceSec) || 30);
    return new Promise<OwedChoice>((resolve) => {
      void this.c.later(() => {
        this.say(l, { stage: 'owed', message: T.owedTitle(shekelText(tx.changeOwedAgorot)), canCancel: false, insertedAgorot: tx.insertedAgorot });
        this.c.ask({
          kind: 'confirm',
          title: T.owedTitle(shekelText(tx.changeOwedAgorot)),
          body: T.owedBody,
          fields: [],
          actions: choices.map((c, i) => ({ id: c, label: label(c), ...(i === 0 ? { primary: true } : {}) })),
          onAction: (action) => resolve(choices.includes(action as OwedChoice) ? (action as OwedChoice) : 'slip'),
          onCancel: () => resolve('slip'),
          expiresInMs: secs * 1000,
          onTimeout: () => resolve('slip'),
        });
        this.c.changed();
      });
    });
  }

  /** "חזרה" / "ביטול": the wait ends (nothing reached the device), or the device gives back what went in. */
  cancel() {
    this.c.signedIn();
    const l = this.live;
    if (!l || l.view.stage === 'unknown' || l.view.stage === 'owed') return this.c.refuse('invalid_args');
    if (!l.view.canCancel) return this.c.refuse('checkout_busy', T.settling);
    if (l.kind === 'cashmag') this.mag.cancel();
    else this.link.cancel();
    this.say(l, { canCancel: false, message: l.view.stage === 'insert' || l.view.stage === 'question' ? T.cancelling : l.view.message });
    return undefined;
  }

  /** CashMag's question on the screen (dialogValid / dialogCancel). */
  private async answer(confirm: boolean) {
    this.c.signedIn();
    const l = this.live;
    if (!l || l.kind !== 'cashmag' || !l.view.question) return this.c.refuse('invalid_args');
    this.say(l, { stage: 'insert', question: null, message: T.insert });
    await this.mag.answerQuestion(confirm);
    return undefined;
  }

  /** "בדוק שוב": the station asked again about the payment whose answer was lost. */
  private async recheck() {
    this.c.signedIn();
    const l = this.live;
    if (!l || l.view.stage !== 'unknown') return this.c.refuse('invalid_args');
    await this.settlePaylink(l.docId);
    return undefined;
  }

  /** "סמן כלא שולם" — a manager's code: the document voided (the station keeps what it holds for the staff). */
  private markNotPaid() {
    const user = this.c.signedIn();
    const l = this.live;
    if (!l || l.view.stage !== 'unknown') return this.c.refuse('invalid_args');
    return this.c.gate(
      APPROVE,
      (by) => {
        if (this.live !== l) return undefined;
        this.h.void(l.docId, { device: l.kind, outcome: 'marked_not_paid', by: by?.name ?? user.id });
        this.live = null;
        this.c.log(`device cash: document ${l.docId} marked not paid by ${by?.name ?? user.id}`);
        this.h.failed(T.markedNotPaid);
        return undefined;
      },
      { askOnDeny: true },
    );
  }

  /** "נתתי מהמגירה": the change a CashMag machine owed, given from this drawer — a cash out under the drawer's own rules. */
  private async owedPaid() {
    this.c.signedIn();
    const d = this.doneView;
    if (!d?.done || !d.done.owedFromDrawer || d.done.owedPaid || d.done.owedAgorot <= 0) return this.c.refuse('invalid_args');
    const reason = `עודף חייב ללקוח · ${d.name}${d.txShort ? ` · ${d.txShort}` : ''}`;
    const out = await this.c.run('drawer.movement', { type: 'CASH_OUT', amountAgorot: d.done.owedAgorot, reason, note: d.txShort });
    // The drawer asked a manager first: done once it is answered (the movement records itself then).
    if (this.doneView === d && d.done) this.doneView = { ...d, done: { ...d.done, owedPaid: true, notice: [d.done.notice, T.owedPaidDone].filter(Boolean).join(' · ') } };
    return out;
  }

  /** "טופל": a manager dealt with the fault at the device — CashMag takes payments again. */
  private acknowledge(raw: unknown) {
    const user = this.c.signedIn();
    if (typeof raw !== 'string' || !raw.trim()) return this.c.refuse('invalid_args');
    return this.c.gate(
      APPROVE,
      (by) => {
        const ok = this.mag.acknowledge(raw.trim(), by?.name ?? user.id);
        this.c.toast(ok ? T.acknowledged : 'העסקה לא נמצאה', ok ? 'ok' : 'error');
        return undefined;
      },
      { askOnDeny: true },
    );
  }

  /** "בדיקת חיבור": the device asked now, and what a restart left settled. */
  private async check() {
    this.c.signedIn();
    const kind = this.kind();
    if (kind === 'cashmag') await this.mag.probe();
    if (kind === 'paylink') await this.link.refreshStatus();
    await this.settle();
    const reason = this.reason(kind);
    this.c.toast(reason ?? `${this.name(kind)} זמין`, reason ? 'error' : 'ok');
    return undefined;
  }

  /* ------------------------------------------------------------------ recovery */

  /** What a restart (or a silent station) left of this till's payments, settled by each device's own word. */
  settle(): Promise<void> {
    if (this.settling) return this.settling;
    this.settling = (async () => {
      try {
        await this.settleCashMag();
        await this.settlePaylink(null);
      } finally {
        this.settling = null;
      }
    })();
    return this.settling;
  }

  private async settleCashMag() {
    if (this.mag.inFlight || !this.mag.journal().some((e) => isTillCashRef(e.orderId))) return;
    await this.mag.settle({
      docStatus: (id) => {
        const s = this.c.svc.ledger.doc(id)?.status ?? null;
        return s === 'refunded' || s === 'partial_refund' ? 'completed' : s;
      },
      writePaid: async (e, tx) => {
        const doc = this.h.complete(e.docId, deviceLegOf(tx, tx.changeOwedAgorot > 0 ? 'slip' : null));
        if (!doc || doc.status !== 'completed') return false;
        this.c.log(`cashmag tx ${shortTx(e.txId)}: paid before the restart — till document ${doc.number} written now`);
        this.c.toast(`תשלום במכשיר מלפני ההפעלה נרשם (מסמך ${formatDocNumber(doc.prefix, doc.number)})`, 'ok');
        void this.c.svc.sync.flush();
        return true;
      },
      voidDoc: (e, outcome) => {
        this.h.void(e.docId, { cashTxId: e.txId, device: 'cashmag', outcome });
        void this.c.svc.sync.flush();
      },
      // The kiosk's own, and this till's live payment: left alone.
      live: (e) => !isTillCashRef(e.orderId) || this.live?.docId === e.docId,
    });
    this.c.changed();
  }

  /** The station's word on this till's open payments ([only]: that document's). */
  private async settlePaylink(only: string | null) {
    for (const p of this.link.pending()) {
      if (!isTillCashRef(p.orderId)) continue;
      if (only !== null && p.docId !== only) continue;
      // The live one is followed by its own loop.
      if (this.link.inFlight && this.live?.docId === p.docId && this.live.view.stage !== 'unknown') continue;
      const doc = this.c.svc.ledger.doc(p.docId);
      const r = await this.link.lookUp(p.txId);
      if (r.kind === 'offline') continue;
      if (r.kind === 'none') {
        if (doc?.status === 'pending') this.h.void(p.docId, { cashTxId: p.txId, device: 'paylink', outcome: 'not_started' });
        this.link.forget(p.txId);
        this.endUnknown(p.docId, null);
        continue;
      }
      const tx = r.tx;
      if (tx.state !== 'DONE' && tx.state !== 'HELD') {
        await this.link.cancelAt(tx.txId);
        continue;
      }
      if (doc?.status !== 'pending') {
        await this.link.ack(tx.txId, doc?.status === 'completed' ? doc.id : null, doc?.status === 'completed' ? formatDocNumber(doc.prefix, doc.number) : null);
        continue;
      }
      if (tx.state === 'DONE' && tx.outcome === 'paid') {
        const owedAs: OwedChoice | null = tx.changeOwedAgorot > 0 ? (tx.changeOwedAs ?? 'slip') : null;
        const done = this.h.complete(p.docId, deviceLegOf(tx, owedAs));
        await this.link.ack(tx.txId, done?.status === 'completed' ? done.id : null, done?.status === 'completed' ? formatDocNumber(done.prefix, done.number) : null, null, { changeOwedAs: owedAs });
        if (done?.status === 'completed') this.endUnknown(p.docId, done);
      } else {
        this.h.void(p.docId, { cashTxId: tx.txId, device: 'paylink', outcome: tx.state === 'HELD' ? 'held' : (tx.outcome ?? 'refunded') });
        await this.link.ack(tx.txId, null, null);
        this.endUnknown(p.docId, null);
      }
      void this.c.svc.sync.flush();
    }
    this.c.changed();
  }

  /** The payment whose answer was not known is settled now: the checkout follows (the done screen, or the tenders). */
  private endUnknown(docId: string, doc: DocDraft | null) {
    const l = this.live;
    if (!l || l.docId !== docId || l.view.stage !== 'unknown') return;
    this.live = null;
    if (doc) {
      this.doneView = { ...l.view, stage: 'done', message: '', canCancel: false, done: { notice: null, owedAgorot: 0, owedFromDrawer: false, owedPaid: false } };
      this.h.done(doc);
    } else this.h.failed('העסקה לא שולמה במכשיר');
  }
}
