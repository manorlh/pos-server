/**
 * "מזומן עם עודף" — the cash pad of the Android checkout (CheckoutScreen: the note handed over, the change or what is
 * missing, "אשר תשלום מזומן", and "קבל X במזומן — יישאר Y" for a part). The amount typed goes to the engine as
 * `checkout.cash {amountAgorot}` (handed over); the change and the documents are the engine's, never computed here as a fact.
 */

import { useState } from 'react';
import { parseAmount } from '../amount';
import { money, quickCash, T } from '../text';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back'] as const;

export function CashPad({ dueAgorot, onConfirm, onBack }: { dueAgorot: number; onConfirm(handedAgorot: number): void; onBack(): void }) {
  const [text, setText] = useState('');
  const handed = parseAmount(text) ?? 0;
  const enough = handed >= dueAgorot;
  const press = (k: (typeof KEYS)[number]) => {
    if (k === 'back') setText((t) => t.slice(0, -1));
    else if (k === '.') setText((t) => (t.includes('.') || t === '' ? t : `${t}.`));
    else setText((t) => (t.length < 9 && !/\.\d\d$/.test(t) ? t + k : t));
  };
  return (
    <div className="t-cashpad">
      <div className="t-amount-row">
        <span>{T.amountDue}</span>
        <strong className="t-amount">{money(dueAgorot)}</strong>
      </div>
      <div className="t-cash-input" aria-live="polite">
        <span className="t-muted">{T.tendered}</span>
        <strong className="t-amount">{text === '' ? '₪0.00' : `₪${text}`}</strong>
      </div>
      <div className={`t-change-line${handed > 0 && !enough ? ' t-change-short' : ''}`}>
        {handed === 0 ? ' ' : enough ? `${T.changeToCustomer}: ${money(handed - dueAgorot)}` : `${T.missing}: ${money(dueAgorot - handed)}`}
      </div>
      <div className="t-quick">
        <button type="button" className="t-chip" onClick={() => setText((dueAgorot / 100).toFixed(2).replace(/\.00$/, ''))}>
          {T.cashExact}
        </button>
        {quickCash(dueAgorot).map((v) => (
          <button key={v} type="button" className="t-chip" onClick={() => setText(String(v / 100))}>
            {money(v)}
          </button>
        ))}
      </div>
      <div className="t-pin-keys">
        {KEYS.map((k) => (
          <button key={k} type="button" className="t-key" onClick={() => press(k)}>
            {k === 'back' ? '⌫' : k}
          </button>
        ))}
      </div>
      <div className="t-cash-actions">
        <button type="button" className="t-btn t-btn-primary t-btn-wide t-btn-big" disabled={!enough} onClick={() => onConfirm(handed)}>
          {T.confirmCash}
        </button>
        {handed > 0 && !enough ? (
          <button type="button" className="t-btn t-btn-wide" onClick={() => onConfirm(handed)}>
            {T.takePartial(money(handed), money(dueAgorot - handed))}
          </button>
        ) : null}
        <button type="button" className="t-btn t-btn-ghost" onClick={onBack}>
          {T.back}
        </button>
      </div>
    </div>
  );
}
