/**
 * "מזומן עם עודף" — the cash step of the Android checkout (CheckoutScreen.kt CashStep / WideCashStep; P:/specs/
 * till-visual-parity): what is owed, what was handed over (big), the change or what is missing, "אשר תשלום מזומן" (or
 * "קבל X במזומן — יישאר Y" for a part); the notes ("מדויק", ₪5…₪200 — each ADDED to what was handed, "נקה") over a keypad
 * that runs left to right. `wide` (a screen on its side, ≥ 840 × 600): the figures on the left and the notes and keys on
 * the right, the whole screen and nothing to scroll; otherwise one column.
 *
 * The amount typed goes to the engine as `checkout.cash {amountAgorot}` (handed over); the change and the documents are
 * the engine's, never computed here as a fact.
 */

import { useState } from 'react';
import { parseAmount } from '../amount';
import { money, T } from '../text';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'back'] as const;

/** The notes and coins offered (Android CASH_DENOMINATIONS), each added to what was handed over. */
export const CASH_DENOMINATIONS = [5, 10, 20, 50, 100, 200] as const;

/** "50" + 20 → "70"; "12.5" + 5 → "17.50": the typed amount and a note added to it, as the pad shows it. */
export function addNote(text: string, shekels: number): string {
  const sum = (parseAmount(text) ?? 0) + shekels * 100;
  return sum % 100 === 0 ? String(sum / 100) : (sum / 100).toFixed(2);
}

export function CashPad({ dueAgorot, onConfirm, onBack, wide = false }: { dueAgorot: number; onConfirm(handedAgorot: number): void; onBack(): void; wide?: boolean }) {
  const [text, setText] = useState('');
  const handed = parseAmount(text) ?? 0;
  const enough = handed >= dueAgorot;
  const partial = handed > 0 && !enough;
  const press = (k: (typeof KEYS)[number]) => {
    if (k === 'back') setText((t) => t.slice(0, -1));
    else if (k === '.') setText((t) => (t.includes('.') || t === '' ? t : `${t}.`));
    else setText((t) => (t.length < 9 && !/\.\d\d$/.test(t) ? t + k : t));
  };
  const notes: Array<{ label: string; onTap(): void }> = [
    { label: T.exactNote, onTap: () => setText((dueAgorot / 100).toFixed(2).replace(/\.00$/, '')) },
    ...CASH_DENOMINATIONS.map((n) => ({ label: `₪${n}`, onTap: () => setText((t) => addNote(t, n)) })),
    { label: T.cartClear, onTap: () => setText('') },
  ];
  const figures = (
    <div className="t-cash-figures">
      <div className="t-cash-due">
        <span>{T.amountDue}</span>
        <strong>{money(dueAgorot)}</strong>
      </div>
      <div className={`t-cash-input${text === '' ? ' t-cash-input-blank' : ''}`} aria-live="polite">
        <span>{T.cashReceived}</span>
        <strong dir="ltr">{text === '' ? '₪0' : `₪${text}`}</strong>
      </div>
      <div className={`t-cash-left ${enough ? 't-cash-left-ok' : 't-cash-left-short'}`}>
        <span>{enough ? T.changeToCustomer : T.missing}</span>
        <strong>{money(enough ? handed - dueAgorot : dueAgorot - handed)}</strong>
      </div>
      {partial ? (
        <button type="button" className="t-btn t-btn-primary t-btn-wide t-cash-confirm" onClick={() => onConfirm(handed)}>
          {T.takePartial(money(handed), money(dueAgorot - handed))}
        </button>
      ) : (
        <button type="button" className="t-btn t-btn-primary t-btn-wide t-cash-confirm" disabled={!enough} onClick={() => onConfirm(handed)}>
          {T.confirmCash}
        </button>
      )}
      <button type="button" className="t-btn t-btn-ghost" onClick={onBack}>
        {T.back}
      </button>
    </div>
  );
  const keys = (
    <div className="t-cash-keys">
      <div className="t-cash-notes">
        {notes.map((n) => (
          <button key={n.label} type="button" className="t-cash-note" onClick={n.onTap}>
            <bdi>{n.label}</bdi>
          </button>
        ))}
      </div>
      <div className="t-cash-keypad">
        {KEYS.map((k) => (
          <button key={k} type="button" className={`t-cash-key${k === 'back' ? ' t-cash-key-back' : ''}`} aria-label={k === 'back' ? 'מחק ספרה' : undefined} onClick={() => press(k)}>
            {k === 'back' ? '⌫' : k}
          </button>
        ))}
      </div>
    </div>
  );
  return (
    <div className={`t-cashpad${wide ? ' t-cashpad-wide' : ''}`}>
      {figures}
      {keys}
    </div>
  );
}
