/**
 * The payment screen — driven by the engine's `checkout` state (tender → card_waiting → done), in the Android checkout's
 * order and words: "מזומן מהיר" (the exact amount), "מזומן עם עודף" (the cash pad), "אשראי" (greyed with the reason when
 * there is no terminal), the legs taken so far ("התקבל · נותר"), a card that did not go through, a card whose answer is
 * not known ("בדוק שוב" / a manager's "סמן כלא אושר"), and at the end the change, the document and the receipt
 * ("להדפיס חשבונית?", "הדפס העתק"). Centred to a readable width on big screens.
 */

import { useState } from 'react';
import type { CheckoutState } from '../../../../shared/till/protocol';
import type { CapabilityTile } from '../../../host/caps';
import type { TillLayout } from '../layout/tillLayout';
import { CashPad } from '../parts/CashPad';
import { money, T } from '../text';

export interface CheckoutActions {
  cash(amountAgorot: number): void;
  card(): void;
  cancel(): void;
  finish(): void;
  print(print: boolean): void;
  copy(): void;
  recheck(): void;
  markNotApproved(): void;
  /** "זיכוי מזומן": a station's credit code (`CC:…` scanned, or typed) towards the goods; absent — not on this engine. */
  credit?(code: string): void;
  removeCredit?(redemptionId: string): void;
  /** Vouchers (main/till/tillVouchers.ts): a code scanned or typed, "הסר", "סיום בדיקה"; absent — not on this engine. */
  voucher?(code: string): void;
  removeVoucher?(id: string): void;
  finishTest?(): void;
  /** A basket with returns: who the money goes back to, an even exchange, the money back. */
  returnCustomer?(c: { name: string; phone: string; address: string }): void;
  exchange?(): void;
  payout?(method: 'cash' | 'card'): void;
}

/**
 * The payment's vouchers (main/till/tillVouchers.ts): the scan box ("שובר" — scanned or typed), what each voucher covers with
 * "הסר", the orange "מצב בדיקה" bar and the entitlement alert, the green / red line of the last scan.
 */
function VoucherPanel({
  vouchers,
  actions,
  code,
  setCode,
  open,
}: {
  vouchers: NonNullable<CheckoutState['vouchers']>;
  actions: CheckoutActions;
  code: string;
  setCode(v: string): void;
  open: boolean;
}) {
  return (
    <div className="t-vouchers">
      {vouchers.testBar ? (
        <div className="t-voucher-test" role="status">
          <p>{vouchers.testBar}</p>
          {vouchers.testDue ? <p className="t-small">{vouchers.testDue}</p> : null}
        </div>
      ) : null}
      {vouchers.items.length > 0 ? (
        <ul className="t-legs">
          {vouchers.items.map((v) => (
            <li key={v.id}>
              {v.label}
              {v.what ? ` — ${v.what}` : ''} · {money(v.amountAgorot)}
              {open && actions.removeVoucher ? (
                <button type="button" className="t-btn t-btn-ghost t-btn-small" onClick={() => actions.removeVoucher!(v.id)}>
                  הסר
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {vouchers.deductionAgorot > 0 ? <p className="t-small">קיזוז שוברי הפקה: −{money(vouchers.deductionAgorot)}</p> : null}
      {vouchers.goodsValueAgorot > 0 ? <p className="t-small t-muted">שווי הפריטים בשובר: {money(vouchers.goodsValueAgorot)} · שולם בשובר הפקה</p> : null}
      {vouchers.entitlement ? (
        <div className="t-voucher-test" role="status">
          <p>{vouchers.entitlement}</p>
        </div>
      ) : null}
      {vouchers.applied ? <p className="t-ok">{vouchers.applied}</p> : null}
      {vouchers.error ? (
        <div className="t-warn" role="alert">
          <p>{vouchers.error}</p>
        </div>
      ) : null}
      {open && actions.voucher ? (
        <form
          className="t-credit"
          onSubmit={(e) => {
            e.preventDefault();
            if (code.trim() && !vouchers.busy) {
              actions.voucher!(code.trim());
              setCode('');
            }
          }}
        >
          <label className="t-field">
            <span>שובר</span>
            <input className="t-input" value={code} maxLength={120} onChange={(e) => setCode(e.target.value)} placeholder="סריקה או הקלדה של קוד השובר" />
          </label>
          <button type="submit" className="t-btn" disabled={!code.trim() || vouchers.busy}>
            {vouchers.busy ? 'בודק…' : 'מימוש'}
          </button>
        </form>
      ) : null}
    </div>
  );
}

/** A basket with returns (core/till/basket.ts): its own steps before (or instead of) the tenders. */
function BasketStep({ checkout, actions, noCard, style }: { checkout: CheckoutState; actions: CheckoutActions; noCard: boolean; style?: { maxWidth: number } }) {
  const b = checkout.basket!;
  const [name, setName] = useState(b.customer.name);
  const [phone, setPhone] = useState(b.customer.phone);
  const [address, setAddress] = useState(b.customer.address);
  const complete = name.trim() !== '' && (phone.trim() !== '' || address.trim() !== '');
  const figures = (
    <dl className="t-figures">
      <dt>{T.basketSold}</dt>
      <dd>{money(b.saleAgorot)}</dd>
      <dt>{T.basketReturned}</dt>
      <dd>−{money(b.refundAgorot)}</dd>
    </dl>
  );
  if (b.step === 'return_customer') {
    return (
      <div className="t-checkout" style={style}>
        <h1 className="t-checkout-title">{T.basketCustomerTitle}</h1>
        {figures}
        <p className="t-small t-muted">{b.customer.required ? T.basketCustomerRequired : T.basketCustomerOptional}</p>
        <label className="t-field">
          <span>{T.basketCustomerName}</span>
          <input className="t-input" value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="t-field">
          <span>{T.basketCustomerPhone}</span>
          <input className="t-input" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
        </label>
        <label className="t-field">
          <span>{T.basketCustomerAddress}</span>
          <input className="t-input" value={address} onChange={(e) => setAddress(e.target.value)} />
        </label>
        <button type="button" className="t-btn t-btn-primary t-btn-wide" disabled={b.customer.required && !complete} onClick={() => actions.returnCustomer?.({ name, phone, address })}>
          {T.continue}
        </button>
        <button type="button" className="t-btn t-btn-ghost" onClick={actions.cancel}>
          {T.checkoutBack}
        </button>
      </div>
    );
  }
  if (b.step === 'exchange') {
    return (
      <div className="t-checkout" style={style}>
        <h1 className="t-checkout-title">{T.basketEven}</h1>
        {figures}
        <p>{T.basketEvenBody}</p>
        <button type="button" className="t-btn t-btn-primary t-btn-wide t-btn-big" onClick={actions.exchange}>
          {T.basketConfirmExchange}
        </button>
        <button type="button" className="t-btn t-btn-ghost" onClick={actions.cancel}>
          {T.checkoutBack}
        </button>
      </div>
    );
  }
  // payout
  const waiting = checkout.phase === 'card_waiting';
  const cardLabel = b.payoutRoute === 'linked' ? T.basketPayoutCardLinked : b.payoutRoute === 'unlinked' ? T.basketPayoutCardUnlinked : T.basketPayoutCardUnavailable;
  return (
    <div className="t-checkout" style={style}>
      <div className="t-amount-row">
        <span>{T.basketHandBack('')}</span>
        <strong className="t-amount">{money(b.payoutAgorot)}</strong>
      </div>
      {figures}
      {checkout.cardError ? (
        <div className="t-warn" role="alert">
          <p>{checkout.cardError}</p>
        </div>
      ) : null}
      {waiting ? (
        <p className="t-waiting" role="status">
          {checkout.cardStatus ?? T.cardWaiting}
        </p>
      ) : (
        <div className="t-tenders">
          <button type="button" className="t-tender t-tender-main" onClick={() => actions.payout?.('cash')}>
            <span>{T.basketPayoutCash}</span>
            <strong>{money(b.payoutAgorot)}</strong>
          </button>
          {noCard ? null : (
            <button type="button" className={`t-tender${b.payoutRoute === 'unavailable' ? ' t-tender-off' : ''}`} disabled={b.payoutRoute === 'unavailable'} onClick={() => actions.payout?.('card')}>
              <span>{cardLabel}</span>
            </button>
          )}
        </div>
      )}
      <button type="button" className="t-btn t-btn-ghost" onClick={actions.cancel}>
        {waiting ? T.checkoutCancel : T.checkoutBack}
      </button>
    </div>
  );
}

export function CheckoutScreen({
  checkout,
  layout,
  cardTile,
  demo,
  actions,
  noCard = false,
}: {
  checkout: CheckoutState;
  layout: TillLayout;
  cardTile: CapabilityTile;
  demo: boolean;
  actions: CheckoutActions;
  /** "ללא אשראי": the business takes no card (payment integration none). */
  noCard?: boolean;
}) {
  const [padOpen, setPadOpen] = useState(false);
  const [creditCode, setCreditCode] = useState('');
  const [voucherCode, setVoucherCode] = useState('');
  const style = layout.checkoutMaxWidthDp ? { maxWidth: layout.checkoutMaxWidthDp } : undefined;

  // "סיום בדיקה": the simulation's end — what would have been covered and left to pay; nothing was written.
  if (checkout.phase === 'done' && checkout.testEnd) {
    return (
      <div className="t-checkout" style={style}>
        <div className="t-voucher-test" role="status">
          {checkout.testEnd.map((line, i) => (
            <p key={i} className={i === 0 ? 't-ok' : 't-small'}>
              {line}
            </p>
          ))}
        </div>
        <div className="t-done-actions">
          <button type="button" className="t-btn t-btn-primary t-btn-wide t-btn-big" onClick={actions.finish}>
            {T.newSaleBtn}
          </button>
        </div>
      </div>
    );
  }

  if (checkout.phase === 'done') {
    const handBack = checkout.basket?.handedBackAgorot ?? 0;
    return (
      <div className="t-checkout" style={style}>
        <h1 className="t-checkout-title t-ok">{handBack > 0 ? T.refundDoneScreen : T.done}</h1>
        {checkout.voucherSuccess ? (
          // "מסך הצלחה במימוש שובר": the vouchers redeemed, and (amber) what the customer did not take.
          <div className="t-voucher-success" role="status">
            <p className="t-voucher-success-title">✓ {checkout.voucherSuccess.title}</p>
            {checkout.voucherSuccess.detail ? <p>{checkout.voucherSuccess.detail}</p> : null}
            {checkout.voucherSuccess.notTaken ? <p className="t-voucher-test">{checkout.voucherSuccess.notTaken}</p> : null}
          </div>
        ) : null}
        {handBack > 0 ? (
          <div className="t-change-big">
            <span>{T.basketHandBack('')}</span>
            <strong className="t-amount">{money(handBack)}</strong>
          </div>
        ) : null}
        {checkout.documentRefs && checkout.documentRefs.length > 1 ? (
          <p className="t-muted t-small">
            {T.documents}: {checkout.documentRefs.join(' · ')}
          </p>
        ) : null}
        {checkout.changeAgorot > 0 ? (
          <div className="t-change-big">
            <span>{T.changeToCustomer}</span>
            <strong className="t-amount">{money(checkout.changeAgorot)}</strong>
          </div>
        ) : null}
        {checkout.tenderedAgorot ? (
          <div className="t-amount-row t-small">
            <span>
              {T.tendered} {money(checkout.tenderedAgorot)}
            </span>
            <span>
              {T.toPay} {money(checkout.totalAgorot)}
            </span>
          </div>
        ) : null}
        {checkout.documentRef ? (
          <p className="t-muted">
            {T.document}: {checkout.documentRef}
            {demo ? ' (הדגמה — לא מסמך אמיתי)' : ''}
          </p>
        ) : null}
        {checkout.askPrint ? (
          <div className="t-ask">
            <p>{T.askPrint}</p>
            <div className="t-ask-actions">
              <button type="button" className="t-btn t-btn-primary" onClick={() => actions.print(true)}>
                {T.askPrintYes}
              </button>
              <button type="button" className="t-btn" onClick={() => actions.print(false)}>
                {T.askPrintNo}
              </button>
            </div>
          </div>
        ) : null}
        {checkout.kitchenWarning ? (
          <div className="t-warn" role="status">
            <p>{checkout.kitchenWarning}</p>
          </div>
        ) : null}
        {checkout.printWarning ? (
          <div className="t-warn" role="alert">
            <p>{checkout.printWarning}</p>
            <button type="button" className="t-btn" onClick={() => actions.print(true)}>
              {T.printRetry}
            </button>
          </div>
        ) : null}
        <div className="t-done-actions">
          <button type="button" className="t-btn t-btn-primary t-btn-wide t-btn-big" onClick={actions.finish}>
            {T.newSaleBtn}
          </button>
          {!demo && !checkout.askPrint ? (
            <button type="button" className="t-btn t-btn-ghost" onClick={actions.copy}>
              {T.printCopy}
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  const waiting = checkout.phase === 'card_waiting';
  const hasLegs = checkout.legs.some((l) => l.status === 'approved');
  const vouchers = checkout.vouchers ?? null;
  const simulation = !!vouchers?.testBar;
  const realLegs = checkout.legs.some((l) => l.method !== 'production_voucher');

  if (checkout.basket && checkout.basket.step !== 'tender' && !checkout.cardUnknown) {
    return <BasketStep checkout={checkout} actions={actions} noCard={noCard} style={style} />;
  }

  if (checkout.cardUnknown) {
    return (
      <div className="t-checkout" style={style}>
        <div className="t-amount-row">
          <span>{T.toPay}</span>
          <strong className="t-amount">{money(checkout.totalAgorot)}</strong>
        </div>
        <div className="t-warn" role="alert">
          <p>{checkout.cardError ?? T.cardUnknownHelp}</p>
          <p className="t-small">{T.cardUnknownHelp}</p>
        </div>
        <div className="t-done-actions">
          <button type="button" className="t-btn t-btn-primary t-btn-wide" onClick={actions.recheck}>
            {T.recheck}
          </button>
          <button type="button" className="t-btn t-btn-wide" onClick={actions.markNotApproved}>
            {T.markNotApproved}
          </button>
        </div>
      </div>
    );
  }

  if (padOpen && !waiting) {
    return (
      <div className="t-checkout" style={style}>
        <CashPad
          dueAgorot={checkout.dueAgorot}
          onConfirm={(handed) => {
            actions.cash(handed);
            if (handed >= checkout.dueAgorot) setPadOpen(false);
          }}
          onBack={() => setPadOpen(false)}
        />
      </div>
    );
  }

  return (
    <div className="t-checkout" style={style}>
      <div className="t-amount-row">
        <span>{T.amountDue}</span>
        <strong className="t-amount">{money(checkout.totalAgorot)}</strong>
      </div>
      {hasLegs ? (
        <div className="t-amount-row t-small">
          <span>{T.splitProgress(money(checkout.paidAgorot), money(checkout.dueAgorot))}</span>
        </div>
      ) : null}
      {checkout.legs.length > 0 ? (
        <ul className="t-legs">
          {checkout.legs.map((l, i) => (
            <li key={i}>
              {l.method === 'cash' ? T.cash : l.method === 'cash_credit' ? `זיכוי ${l.credit?.code ?? ''}` : l.method === 'production_voucher' ? `שובר הפקה${l.voucher ? ` #${l.voucher.serial}` : ''}` : T.card} · {money(l.amountAgorot)}{' '}
              {l.status === 'pending' ? '· ממתין' : ''}
              {l.method === 'cash_credit' && l.credit && actions.removeCredit && !waiting ? (
                <button type="button" className="t-btn t-btn-ghost t-btn-small" onClick={() => actions.removeCredit!(l.credit!.redemptionId)}>
                  הסרת הזיכוי
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {checkout.cardError ? (
        <div className="t-warn" role="alert">
          <p>{checkout.cardError}</p>
        </div>
      ) : null}
      {vouchers ? <VoucherPanel vouchers={vouchers} actions={actions} code={voucherCode} setCode={setVoucherCode} open={!waiting && !realLegs} /> : null}
      {waiting ? (
        <p className="t-waiting" role="status">
          {checkout.cardStatus ?? T.cardWaiting}
        </p>
      ) : simulation ? (
        // "מצב בדיקה": no real money in a test voucher's sale — only its end.
        <div className="t-tenders">
          <button type="button" className="t-tender t-tender-main" onClick={() => actions.finishTest?.()}>
            <span>סיום בדיקה</span>
          </button>
        </div>
      ) : (
        <div className="t-tenders">
          <button type="button" className="t-tender t-tender-main" onClick={() => actions.cash(checkout.dueAgorot)}>
            <span>{checkout.dueAgorot === 0 && (vouchers?.items.length ?? 0) > 0 ? 'סגור עסקה וממש שובר' : checkout.totalAgorot === 0 ? 'סגור עסקה' : T.fastCash}</span>
            <strong>{money(checkout.dueAgorot)}</strong>
          </button>
          <button type="button" className="t-tender" onClick={() => setPadOpen(true)}>
            <span>{T.cashWithChange}</span>
            <small className="t-reason">{T.cashChangeCaption}</small>
          </button>
          {/* "ללא אשראי" (payment integration none): no card tender at all, as the Android till. */}
          {noCard ? null : (
            <button type="button" className={`t-tender${cardTile.available ? '' : ' t-tender-off'}`} disabled={!cardTile.available} onClick={actions.card} title={cardTile.reason}>
              <span>{T.cardPay}</span>
              <small className="t-reason">{cardTile.available ? (checkout.cardError ? T.retry : money(checkout.dueAgorot)) : cardTile.reason}</small>
            </button>
          )}
        </div>
      )}
      {!waiting && !simulation && actions.credit && !checkout.basket ? (
        // "זיכוי מזומן" (P:/specs/cash-paylink.md §11.15א): the code of a station's credit — scanned (`CC:…`) or typed.
        <form
          className="t-credit"
          onSubmit={(e) => {
            e.preventDefault();
            if (creditCode.trim()) {
              actions.credit!(creditCode.trim());
              setCreditCode('');
            }
          }}
        >
          <label className="t-field">
            <span>זיכוי מזומן</span>
            <input className="t-input" value={creditCode} maxLength={80} onChange={(e) => setCreditCode(e.target.value)} placeholder="C-XXXXXX" />
          </label>
          <button type="submit" className="t-btn" disabled={!creditCode.trim()}>
            מימוש
          </button>
        </form>
      ) : null}
      <button type="button" className="t-btn t-btn-ghost" onClick={actions.cancel}>
        {waiting ? T.checkoutCancel : hasLegs ? T.checkoutCancelPayment : T.checkoutBack}
      </button>
    </div>
  );
}
