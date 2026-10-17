/**
 * "בירור יתרת שובר" (the Android VoucherBalanceScreen; core/till/voucherBalance.ts): the field takes the scanner (it types the
 * "PV:" code and Enter) or the code typed by hand; the answer — the voucher's card, its status in its colour, what is left on
 * it and its history — or why it could not be checked. Read only: nothing here holds or redeems the voucher. This only draws
 * what the state says.
 */

import { useEffect, useRef, useState } from 'react';
import { VOUCHER_BALANCE_TEXT as V, typedByHand, type VoucherBalanceCard, type VoucherBalanceState, type VoucherTone } from '../../../../core/till/voucherBalance';

export interface VoucherBalanceActions {
  /** A scan or "בדוק שובר": [typed] — typed by hand (a 16-character code), else a scan ("PV:…"). */
  lookup(code: string, typed: boolean): void;
  /** "בדיקת שובר נוסף". */
  again(): void;
  /** "מימוש השובר": absent — not offered here (no voucher station on, or the voucher cannot be redeemed now). */
  redeem?(code: string): void;
}

function Toned({ text, tone, detail }: { text: string; tone: VoucherTone; detail?: string | null }) {
  return (
    <div className={`vbal-box vbal-${tone}`} role="status">
      <p className="vbal-box-text">{text}</p>
      {detail ? <p className="vbal-box-detail">{detail}</p> : null}
    </div>
  );
}

function Card({ card }: { card: VoucherBalanceCard }) {
  return (
    <>
      {card.testBar ? <div className="vbal-test">{card.testBar}</div> : null}
      <section className="vbal-card">
        <p className="vbal-serial">{card.serial}</p>
        {card.typeName ? <p className="vbal-type">{card.typeName}</p> : null}
        {card.event ? <p>{card.event}</p> : null}
        {card.production ? <p className="t-small">{card.production}</p> : null}
        {card.validFrom ? <p className="t-small t-muted">{card.validFrom}</p> : null}
        {card.validUntil ? <p className="t-small t-muted">{card.validUntil}</p> : null}
        {card.note ? <p className="t-small t-muted">{card.note}</p> : null}
      </section>
      <Toned text={card.status.text} tone={card.status.tone} detail={card.status.detail} />
      {card.left.map((line, i) => (
        <p key={i} className="vbal-left">
          {line}
        </p>
      ))}
      {card.lastRedeemed ? <p className="vbal-last">{card.lastRedeemed}</p> : null}
      {card.first ? <p className="t-small t-muted">{card.first}</p> : null}
      {card.historyTitle ? (
        <section className="vbal-history">
          <h2 className="t-menu-title">{card.historyTitle}</h2>
          <ul className="t-list">
            {card.history.map((h, i) => (
              <li key={i} className={`t-list-row vbal-history-row${h.reversed ? ' t-muted' : ''}`}>
                {h.text}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

export function VoucherBalanceScreen({ view, actions, back }: { view: VoucherBalanceState; actions: VoucherBalanceActions; back(): void }) {
  const [typed, setTyped] = useState('');
  const field = useRef<HTMLInputElement>(null);
  const answer = view.answer;
  // The scanner types into the field: it is always focused while it is shown.
  useEffect(() => {
    if (!answer && !view.busy) field.current?.focus();
  }, [answer, view.busy]);
  const submit = () => {
    const text = typed.trim();
    if (!text || view.busy) return;
    actions.lookup(text, typedByHand(text));
  };
  const found = answer?.kind === 'found' ? answer : null;
  return (
    <div className="t-report vbal" dir="rtl">
      <div className="t-report-head">
        <h1 className="t-report-title">{V.title}</h1>
      </div>
      <div className="t-report-body vbal-body">
        {!answer ? (
          <>
            <p>{V.codeHint}</p>
            <label className="t-field">
              <span>{V.codeLabel}</span>
              <input
                ref={field}
                className="t-input vbal-input"
                value={typed}
                maxLength={40}
                autoComplete="off"
                spellCheck={false}
                disabled={view.busy}
                onChange={(e) => setTyped(e.target.value.slice(0, 40))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submit();
                }}
              />
            </label>
            <button type="button" className="t-btn t-btn-primary t-btn-big" disabled={view.busy || !typed.trim()} onClick={submit}>
              {view.busy ? '…' : V.lookup}
            </button>
          </>
        ) : answer.kind === 'offline' ? (
          <Toned text={answer.text} tone="orange" />
        ) : answer.kind === 'refused' ? (
          <Toned text={answer.text} tone="red" />
        ) : (
          <Card card={answer.card} />
        )}
        {view.error ? <Toned text={view.error} tone="red" /> : null}
        {found && found.card.redeemable && actions.redeem ? (
          <button type="button" className="t-btn t-btn-primary t-btn-big" onClick={() => actions.redeem!(found.code)}>
            {V.redeem}
          </button>
        ) : null}
        <div className="vbal-actions">
          {answer ? (
            <button
              type="button"
              className="t-btn"
              onClick={() => {
                setTyped('');
                actions.again();
              }}
            >
              {V.another}
            </button>
          ) : null}
          <button type="button" className="t-btn t-btn-ghost" onClick={back}>
            {V.close}
          </button>
        </div>
      </div>
    </div>
  );
}
