/**
 * The shift: open / close, the X report, the Z (greyed with the engine's reason — the demo never
 * produces one, and a real Z is only ever the engine's), and the role switch ONLY when the owner
 * allowed one (`rolesAllowed` empty: no button at all, §6.2).
 */

import { useState } from 'react';
import type { DeviceRoleName, TillState, XReport } from '../../../../shared/till/protocol';
import type { TillLayout } from '../layout/tillLayout';
import { money, T } from '../text';

const ROLE_LABEL: Record<DeviceRoleName, string> = { till: 'קופה', kiosk: 'קיוסק', kds: 'מסך מטבח', board: 'מסך מוכן', display: 'מסך לקוח' };

/** "123.40" / "123" → agorot; null when it is not an amount. */
export function parseAmount(text: string): number | null {
  const t = text.trim().replace(/[₪,\s]/g, '');
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) return null;
  const [whole, frac = ''] = t.split('.');
  return Number(whole) * 100 + Number((frac + '00').slice(0, 2));
}

export function ShiftScreen({
  state,
  layout,
  actions,
}: {
  state: TillState;
  layout: TillLayout;
  actions: { open(openingCashAgorot: number): void; close(countedCashAgorot: number): void; x(): Promise<XReport | undefined>; switchTo(role: DeviceRoleName): void; back(): void };
}) {
  const [cash, setCash] = useState('');
  const [x, setX] = useState<XReport | null>(null);
  const s = state.shift;
  const amount = parseAmount(cash);
  const others = state.mode.rolesAllowed.filter((r) => r !== state.mode.current);
  return (
    <div className="t-report" style={layout.reportMaxWidthDp ? { maxWidth: layout.reportMaxWidthDp } : undefined}>
      <div className="t-report-head">
        <h1 className="t-report-title">{s.open ? `${T.shiftOpen} · ${s.number ?? ''}` : T.shiftClosed}</h1>
        <button type="button" className="t-btn t-btn-ghost" onClick={actions.back}>
          {T.back}
        </button>
      </div>
      <div className={`t-report-body${layout.reportTwoColumns ? ' t-two-cols' : ''}`}>
        <dl className="t-figures">
          <dt>{T.openingCash}</dt>
          <dd>{money(s.openingCashAgorot)}</dd>
          <dt>{T.sales}</dt>
          <dd>
            {s.salesCount} · {money(s.salesAgorot)}
          </dd>
          <dt>{T.cash}</dt>
          <dd>{money(s.cashAgorot)}</dd>
          <dt>{T.card}</dt>
          <dd>{money(s.cardAgorot)}</dd>
          {x ? (
            <>
              <dt>{T.expectedCash}</dt>
              <dd>{money(x.expectedCashAgorot)}</dd>
            </>
          ) : null}
        </dl>
        <div className="t-shift-actions">
          {s.open ? (
            <>
              <button type="button" className="t-btn" onClick={() => void actions.x().then((r) => r && setX(r))}>
                {T.xReport}
              </button>
              <label className="t-field">
                <span>{T.countedCash}</span>
                <input className="t-input" inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} placeholder="0.00" />
              </label>
              <button type="button" className="t-btn t-btn-primary" disabled={amount === null} onClick={() => amount !== null && actions.close(amount)}>
                {T.closeShift}
              </button>
            </>
          ) : (
            <>
              <label className="t-field">
                <span>{T.openingCash}</span>
                <input className="t-input" inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} placeholder="0.00" />
              </label>
              <button type="button" className="t-btn t-btn-primary" disabled={amount === null} onClick={() => amount !== null && actions.open(amount)}>
                {T.openShift}
              </button>
            </>
          )}
          <button type="button" className="t-btn t-tender-off" disabled={!state.z.canProduce} title={state.z.reason ?? ''}>
            {T.zReport}
          </button>
          {!state.z.canProduce && state.z.reason ? <p className="t-reason">{state.z.reason}</p> : null}
          {others.map((r) => (
            <button key={r} type="button" className="t-btn" onClick={() => actions.switchTo(r)}>
              מעבר ל{ROLE_LABEL[r]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
