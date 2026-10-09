/**
 * The payment screen — driven by the engine's `checkout` state (tender → card_waiting → done):
 * exact cash, the likely notes, card (greyed with the reason when this host has no terminal),
 * cancel (refused by the engine once a card is in), the change and the document at the end.
 * Centred to a readable width on big screens.
 */

import type { CheckoutState } from '../../../../shared/till/protocol';
import type { CapabilityTile } from '../../../host/caps';
import type { TillLayout } from '../layout/tillLayout';
import { money, quickCash, T } from '../text';

export interface CheckoutActions {
  cash(amountAgorot: number): void;
  card(): void;
  cancel(): void;
  finish(): void;
}

export function CheckoutScreen({ checkout, layout, cardTile, demo, actions }: { checkout: CheckoutState; layout: TillLayout; cardTile: CapabilityTile; demo: boolean; actions: CheckoutActions }) {
  const style = layout.checkoutMaxWidthDp ? { maxWidth: layout.checkoutMaxWidthDp } : undefined;
  if (checkout.phase === 'done') {
    return (
      <div className="t-checkout" style={style}>
        <h1 className="t-checkout-title t-ok">{T.saleDone}</h1>
        <div className="t-amount-row">
          <span>{T.change}</span>
          <strong className="t-amount">{money(checkout.changeAgorot)}</strong>
        </div>
        {checkout.documentRef ? (
          <p className="t-muted">
            {T.document}: {checkout.documentRef}
            {demo ? ' (הדגמה — לא מסמך אמיתי)' : ''}
          </p>
        ) : null}
        <button type="button" className="t-btn t-btn-primary t-btn-wide t-btn-big" onClick={actions.finish}>
          {T.newSale}
        </button>
      </div>
    );
  }
  const waiting = checkout.phase === 'card_waiting';
  const hasCard = checkout.legs.some((l) => l.method === 'card');
  return (
    <div className="t-checkout" style={style}>
      <div className="t-amount-row">
        <span>{T.toPay}</span>
        <strong className="t-amount">{money(checkout.totalAgorot)}</strong>
      </div>
      {checkout.paidAgorot > 0 ? (
        <div className="t-amount-row t-small">
          <span>
            {T.paid} {money(checkout.paidAgorot)}
          </span>
          <span>
            {T.due} {money(checkout.dueAgorot)}
          </span>
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
      {waiting ? (
        <p className="t-waiting" role="status">
          {T.cardWaiting}
        </p>
      ) : (
        <div className="t-tenders">
          <button type="button" className="t-tender t-tender-main" onClick={() => actions.cash(checkout.dueAgorot)}>
            <span>{T.cashExact}</span>
            <strong>{money(checkout.dueAgorot)}</strong>
          </button>
          {quickCash(checkout.dueAgorot).map((v) => (
            <button key={v} type="button" className="t-tender" onClick={() => actions.cash(v)}>
              <span>{T.cash}</span>
              <strong>{money(v)}</strong>
            </button>
          ))}
          <button type="button" className={`t-tender${cardTile.available ? '' : ' t-tender-off'}`} disabled={!cardTile.available} onClick={actions.card} title={cardTile.reason}>
            <span>{T.card}</span>
            <small className="t-reason">{cardTile.reason}</small>
          </button>
        </div>
      )}
      <button type="button" className="t-btn t-btn-ghost" disabled={waiting || hasCard} onClick={actions.cancel}>
        {T.cancel}
      </button>
    </div>
  );
}
