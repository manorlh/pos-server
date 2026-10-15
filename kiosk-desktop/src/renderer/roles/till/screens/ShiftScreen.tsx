/**
 * The shift (Android "משמרת"): open with the opening float counted into the drawer, the X (printed by the engine), close with
 * the counted cash (the X frozen into the close, the difference said), and the Z — only where this till makes its own Z
 * (zMode = till; in the shop's Z mode closing the shift is all this till does, and the Z button is not there). The Z is
 * always the engine's, through the one path that numbers it. The role switch appears ONLY when the owner allowed one
 * (`mode.rolesAllowed` empty: no button at all, §6.2).
 */

import { useState } from 'react';
import type { DeviceRoleName, TillState, XReport } from '../../../../shared/till/protocol';
import { parseAmount } from '../amount';
import type { TillLayout } from '../layout/tillLayout';
import { money, T } from '../text';

export { parseAmount };

export interface CloseResult extends XReport {
  countedCashAgorot?: number;
  differenceAgorot?: number;
  message?: string;
}

export interface ShiftActions {
  open(openingCashAgorot: number): void;
  close(countedCashAgorot: number): Promise<CloseResult | undefined> | void;
  x(): Promise<XReport | undefined>;
  z(countedCashAgorot?: number): Promise<{ message?: string } | undefined> | void;
  switchTo(role: DeviceRoleName): void;
  back(): void;
}

export function ShiftScreen({ state, layout, actions }: { state: TillState; layout: TillLayout; actions: ShiftActions }) {
  const [cash, setCash] = useState('');
  const [x, setX] = useState<XReport | null>(null);
  const [closed, setClosed] = useState<CloseResult | null>(null);
  const [zNote, setZNote] = useState<string | null>(null);
  const s = state.shift;
  const amount = parseAmount(cash);
  const others = state.mode.rolesAllowed.filter((r) => r !== state.mode.current);
  const tillZ = state.z.zMode === 'till';
  const perms = state.session.permissions;
  const can = (code: string) => perms.includes(code);
  const figures = x ?? closed;
  // An independent till has no shifts: only "הפק Z" (count the cash, the internal shift closes, the Z, the paper).
  if (s.hidden) {
    const zOk = tillZ && can('Z');
    return (
      <div className="t-report" style={layout.reportMaxWidthDp ? { maxWidth: layout.reportMaxWidthDp } : undefined}>
        <div className="t-report-head">
          <h1 className="t-report-title">{T.zTitle}</h1>
          <button type="button" className="t-btn t-btn-ghost" onClick={actions.back}>
            {T.back}
          </button>
        </div>
        <div className={`t-report-body${layout.reportTwoColumns ? ' t-two-cols' : ''}`}>
          <dl className="t-figures">
            <dt>{T.sales}</dt>
            <dd>
              {s.salesCount} · {money(s.salesAgorot)}
            </dd>
            <dt>{T.cash}</dt>
            <dd>{money(s.cashAgorot)}</dd>
            <dt>{T.card}</dt>
            <dd>{money(s.cardAgorot)}</dd>
          </dl>
          <div className="t-shift-actions">
            <p className="t-muted t-small">{T.zConfirmNote}</p>
            {s.open ? (
              <label className="t-field">
                <span>{T.countedCash}</span>
                <input className="t-input" inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} placeholder="0.00" />
              </label>
            ) : null}
            {zOk ? (
              <button
                type="button"
                className="t-btn t-btn-primary"
                disabled={s.open && amount === null}
                onClick={() =>
                  void Promise.resolve(actions.z(s.open ? (amount ?? undefined) : undefined)).then((r) => {
                    if (r) {
                      setZNote(r.message ?? null);
                      setCash('');
                    }
                  })
                }
              >
                {T.produceZ}
              </button>
            ) : null}
            {zNote ? <p className="t-ok t-small">{zNote}</p> : null}
            {state.z.lastNumber !== null ? <p className="t-muted t-small">Z אחרון: {state.z.lastNumber}</p> : null}
          </div>
        </div>
      </div>
    );
  }
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
          {s.open ? (
            <>
              <dt>{T.openingFloat}</dt>
              <dd>{money(s.openingCashAgorot)}</dd>
              <dt>{T.sales}</dt>
              <dd>
                {s.salesCount} · {money(s.salesAgorot)}
              </dd>
              <dt>{T.cash}</dt>
              <dd>{money(s.cashAgorot)}</dd>
              <dt>{T.card}</dt>
              <dd>{money(s.cardAgorot)}</dd>
            </>
          ) : (
            <>
              <dt>{T.noShift}</dt>
              <dd>—</dd>
            </>
          )}
          {figures ? (
            <>
              {figures.vatAgorot !== undefined ? (
                <>
                  <dt>מע״מ</dt>
                  <dd>{money(figures.vatAgorot)}</dd>
                </>
              ) : null}
              <dt>{T.expectedCash}</dt>
              <dd>{money(figures.expectedCashAgorot)}</dd>
              {closed && closed.countedCashAgorot !== undefined ? (
                <>
                  <dt>{T.countedCash}</dt>
                  <dd>{money(closed.countedCashAgorot)}</dd>
                  <dt>{T.difference}</dt>
                  <dd>{money(closed.differenceAgorot ?? 0)}</dd>
                </>
              ) : null}
            </>
          ) : null}
        </dl>
        <div className="t-shift-actions">
          {s.open ? (
            <>
              {can('X') ? (
                <button
                  type="button"
                  className="t-btn"
                  onClick={() =>
                    void actions.x().then((r) => {
                      if (r) {
                        setX(r);
                        setClosed(null);
                      }
                    })
                  }
                >
                  {T.xReport}
                </button>
              ) : null}
              <p className="t-muted t-small">{tillZ ? T.shiftCloseNoteTill : T.shiftCloseNote}</p>
              <label className="t-field">
                <span>{T.countedCash}</span>
                <input className="t-input" inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} placeholder="0.00" />
              </label>
              {can('SHIFT_CLOSE') ? (
                <button
                  type="button"
                  className="t-btn t-btn-primary"
                  disabled={amount === null}
                  onClick={() =>
                    amount !== null &&
                    void Promise.resolve(actions.close(amount)).then((r) => {
                      if (r) {
                        setClosed(r);
                        setX(null);
                        setCash('');
                      }
                    })
                  }
                >
                  {T.closeShift}
                </button>
              ) : null}
              {tillZ && can('Z') ? (
                <>
                  <p className="t-muted t-small">{T.zConfirmOpenShift(s.number ?? '')}</p>
                  <button
                    type="button"
                    className="t-btn"
                    disabled={amount === null}
                    onClick={() =>
                      amount !== null &&
                      void Promise.resolve(actions.z(amount)).then((r) => {
                        if (r) {
                          setZNote(r.message ?? null);
                          setCash('');
                        }
                      })
                    }
                  >
                    {T.closeAndProduceZ}
                  </button>
                </>
              ) : null}
            </>
          ) : (
            <>
              <p className="t-muted">{T.shiftNone}</p>
              <p className="t-muted t-small">{T.openShiftWhy}</p>
              {can('SHIFT_OPEN') ? (
                <>
                  <label className="t-field">
                    <span>{T.openingFloat}</span>
                    <input className="t-input" inputMode="decimal" value={cash} onChange={(e) => setCash(e.target.value)} placeholder="0.00" />
                  </label>
                  <button
                    type="button"
                    className="t-btn t-btn-primary"
                    disabled={cash.trim() !== '' && amount === null}
                    onClick={() => {
                      actions.open(amount ?? 0);
                      setCash('');
                      setClosed(null);
                      setX(null);
                    }}
                  >
                    {T.openShift}
                  </button>
                </>
              ) : null}
              {tillZ && can('Z') ? (
                <button
                  type="button"
                  className="t-btn"
                  onClick={() =>
                    void Promise.resolve(actions.z()).then((r) => {
                      if (r) setZNote(r.message ?? null);
                    })
                  }
                >
                  {T.produceZ}
                </button>
              ) : null}
            </>
          )}
          {closed?.message ? <p className="t-ok t-small">{closed.message}</p> : null}
          {zNote ? <p className="t-ok t-small">{zNote}</p> : null}
          {state.z.lastNumber !== null && tillZ ? <p className="t-muted t-small">Z אחרון: {state.z.lastNumber}</p> : null}
          {!tillZ && state.z.reason ? <p className="t-muted t-small">{state.z.reason}</p> : null}
          {others.map((r) => (
            <button key={r} type="button" className="t-btn" onClick={() => actions.switchTo(r)}>
              {state.mode.switchLabel ?? `מעבר ל${r === 'kiosk' ? 'קיוסק' : r}`}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
