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
}

export function CheckoutScreen({ checkout, layout, cardTile, demo, actions }: { checkout: CheckoutState; layout: TillLayout; cardTile: CapabilityTile; demo: boolean; actions: CheckoutActions }) {
  const [padOpen, setPadOpen] = useState(false);
  const style = layout.checkoutMaxWidthDp ? { maxWidth: layout.checkoutMaxWidthDp } : undefined;

  if (checkout.phase === 'done') {
    return (
      <div className="t-checkout" style={style}>
        <h1 className="t-checkout-title t-ok">{T.done}</h1>
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
              {l.method === 'cash' ? T.cash : T.card} · {money(l.amountAgorot)} {l.status === 'pending' ? '· ממתין' : ''}
            </li>
          ))}
        </ul>
      ) : null}
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
          <button type="button" className="t-tender t-tender-main" onClick={() => actions.cash(checkout.dueAgorot)}>
            <span>{T.fastCash}</span>
            <strong>{money(checkout.dueAgorot)}</strong>
          </button>
          <button type="button" className="t-tender" onClick={() => setPadOpen(true)}>
            <span>{T.cashWithChange}</span>
            <small className="t-reason">{T.cashChangeCaption}</small>
          </button>
          <button type="button" className={`t-tender${cardTile.available ? '' : ' t-tender-off'}`} disabled={!cardTile.available} onClick={actions.card} title={cardTile.reason}>
            <span>{T.cardPay}</span>
            <small className="t-reason">{cardTile.available ? (checkout.cardError ? T.retry : money(checkout.dueAgorot)) : cardTile.reason}</small>
          </button>
        </div>
      )}
      <button type="button" className="t-btn t-btn-ghost" onClick={actions.cancel}>
        {waiting ? T.checkoutCancel : hasLegs ? T.checkoutCancelPayment : T.checkoutBack}
      </button>
    </div>
  );
}
