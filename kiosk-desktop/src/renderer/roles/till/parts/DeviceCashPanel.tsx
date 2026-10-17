/**
 * "מזומן במכשיר" on the payment screen (main/till/tillDeviceCash.ts — the Android till's CashMagCheckout.kt): the tender
 * ("מזומן במכשיר · X ₪", greyed with the reason when the device cannot take it now), the payment while the device takes the
 * money (connecting, the machine someone else's with a small "חזרה", "הכנס מזומן" with what went in, the device's question,
 * an answer not known with "בדוק שוב" / a manager's "סמן כלא שולם"), and on the done screen what the device gave and owes
 * ("נתתי מהמגירה" for a CashMag slip). Only the shared till classes and tokens: the look is the till's.
 */

import type { DeviceCashState, DeviceCashView } from '../../../../core/till/deviceCash';
import { DEVICE_CASH_TEXT as D } from '../../../../core/till/deviceCash';
import { money } from '../text';

export interface DeviceCashActions {
  pay(): void;
  cancel(): void;
  answer(confirm: boolean): void;
  recheck(): void;
  markNotPaid(): void;
  owedPaid(): void;
}

/** The tender: on this till only when it has a cash device. */
export function DeviceCashTender({ state, dueAgorot, onPay }: { state: DeviceCashState; dueAgorot: number; onPay(): void }) {
  if (!state.kind) return null;
  return (
    <button type="button" className={`t-tender t-device-cash${state.available ? '' : ' t-tender-off'}`} disabled={!state.available} onClick={onPay} title={state.reason ?? undefined}>
      <span>{D.button}</span>
      <small className="t-reason">{state.available ? `${state.name} · ${money(dueAgorot)}` : state.reason}</small>
    </button>
  );
}

/** The payment at the device, until it ends. */
export function DeviceCashLive({ view, actions, style }: { view: DeviceCashView; actions: DeviceCashActions; style?: { maxWidth: number } }) {
  const waiting = view.stage === 'connecting' || view.stage === 'busy';
  return (
    <div className="t-checkout t-device-live" style={style} role="status" aria-live="polite">
      <div className="t-amount-row">
        <span>
          {D.button} · {view.name}
        </span>
        <strong className="t-amount">{money(view.dueAgorot)}</strong>
      </div>
      {view.stage === 'busy' ? (
        <div className="t-deferred t-device-busy">
          <p>{view.message}</p>
          <p className="t-small">{D.busyHint}</p>
        </div>
      ) : view.stage === 'unknown' ? (
        <div className="t-warn" role="alert">
          <p>{view.message}</p>
        </div>
      ) : (
        <p className="t-waiting">{view.message}</p>
      )}
      {view.stage === 'insert' || view.stage === 'question' || view.stage === 'settling' ? (
        <div className="t-device-progress">
          <span>{D.inserted(view.insertedAgorot, view.dueAgorot)}</span>
          <div className="t-device-bar" aria-hidden>
            <div style={{ width: `${Math.min(100, view.dueAgorot > 0 ? Math.round((view.insertedAgorot / view.dueAgorot) * 100) : 0)}%` }} />
          </div>
        </div>
      ) : null}
      {view.question ? (
        <div className="t-ask">
          <p>
            <strong>{view.question.title}</strong>
          </p>
          {view.question.text && view.question.text !== view.question.title ? <p>{view.question.text}</p> : null}
          <div className="t-ask-actions">
            <button type="button" className="t-btn t-btn-primary" onClick={() => actions.answer(true)}>
              אישור
            </button>
            <button type="button" className="t-btn" onClick={() => actions.answer(false)}>
              {D.cancel}
            </button>
          </div>
        </div>
      ) : null}
      {view.stage === 'unknown' ? (
        <div className="t-done-actions">
          <button type="button" className="t-btn t-btn-primary t-btn-wide" onClick={actions.recheck}>
            {D.recheck}
          </button>
          <button type="button" className="t-btn t-btn-wide" onClick={actions.markNotPaid}>
            {D.markNotPaid}
          </button>
        </div>
      ) : view.canCancel ? (
        // First come first served: while waiting for the machine only a small "חזרה" — nothing reached the device.
        <button type="button" className={waiting ? 't-btn t-btn-ghost t-btn-small' : 't-btn t-btn-wide'} onClick={actions.cancel}>
          {view.cancelLabel}
        </button>
      ) : null}
      {view.txShort ? <p className="t-small t-muted">עסקה {view.txShort}</p> : null}
    </div>
  );
}

/** The done screen's words: the change the device gave and owes, and the slip given from the drawer. */
export function DeviceCashDone({ view, onOwedPaid }: { view: DeviceCashView; onOwedPaid(): void }) {
  const d = view.done;
  if (!d || (!d.notice && d.owedAgorot <= 0)) return null;
  return (
    <div className={d.owedAgorot > 0 && !d.owedPaid ? 't-warn t-device-done' : 't-deferred t-device-done'} role="status">
      {d.notice ? <p>{d.notice}</p> : null}
      {d.owedFromDrawer && !d.owedPaid ? (
        <button type="button" className="t-btn t-btn-primary" onClick={onOwedPaid}>
          {D.owedPaidFromDrawer} · {money(d.owedAgorot)}
        </button>
      ) : null}
    </div>
  );
}
