/**
 * "פעולות אשראי" (pos-android ui/reports/TransmissionScreen.kt; core/till/transmission.ts, main/till/tillTransmission.ts):
 * the terminal's deferred mode first ("מצב לא מקוון (Deferred)" — its state, its limits, its switch and "אשר עסקאות ממתינות"),
 * then the transmission ("שדר עסקאות עכשיו") and its history. Every action is the engine's (TRANSMIT, a manager's code where
 * the role asks for one); the screen shows only what the state holds.
 */

import { useEffect, useRef } from 'react';
import type { TransmissionState } from '../../../../shared/till/protocol';
import { TX_TEXT } from '../../../../core/till/transmission';
import { T } from '../text';

export interface TransmissionActions {
  open(): void;
  now(): void;
  offline(on: boolean): void;
  authorize(): void;
  read(): void;
  more(): void;
  back(): void;
}

export function TransmissionScreen({ tx, actions }: { tx: TransmissionState | undefined; actions: TransmissionActions }) {
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    actions.open();
  }, [actions]);
  const o = tx?.offline;
  return (
    <div className="t-report">
      <div className="t-report-head">
        <h1 className="t-report-title">{TX_TEXT.title}</h1>
        <button type="button" className="t-btn t-btn-ghost" onClick={actions.back}>
          {T.back}
        </button>
      </div>
      {tx && !tx.supported ? <p className="t-muted">{TX_TEXT.noTerminal}</p> : null}
      {tx?.deferredSupported ? (
        <section className={`t-menu-group t-tx-card${o?.status?.working ? ' t-tx-card-on' : ''}`}>
          <h2 className="t-menu-title">{TX_TEXT.offlineTitle}</h2>
          {o?.reading && !o.status ? <p className="t-muted">{TX_TEXT.reading}</p> : null}
          {o?.failed && !o.reading ? (
            <p className="t-warn">
              {TX_TEXT.readFailed}{' '}
              <button type="button" className="t-btn t-btn-small" onClick={actions.read}>
                {TX_TEXT.retry}
              </button>
            </p>
          ) : null}
          {o?.stateLine ? <p className="t-strong">{o.stateLine}</p> : null}
          {o?.limitsLine && o.status?.allowed ? <p className="t-muted t-small">{o.limitsLine}</p> : null}
          {o?.status?.allowed ? (
            <div className="t-shift-actions">
              <button type="button" className={`t-btn${o.status.working ? ' t-btn-primary' : ''}`} disabled={o.switching} onClick={() => actions.offline(!o.status!.working)}>
                {o.switching ? TX_TEXT.switching : o.status.working ? TX_TEXT.turnOff : TX_TEXT.turnOn}
              </button>
              {!o.status.working ? (
                <button type="button" className="t-btn t-btn-ghost" disabled={o.switching} onClick={actions.authorize}>
                  {TX_TEXT.authorize}
                </button>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}
      {tx?.supported ? (
        <section className="t-menu-group">
          {tx.pendingLine ? <p className="t-strong">{tx.pendingLine}</p> : null}
          {tx.neverTransmitted && !tx.running ? <p className="t-muted">{TX_TEXT.neverTransmitted}</p> : null}
          {tx.lastFailed ? <p className="t-warn">{TX_TEXT.lastFailed(tx.lastFailed)}</p> : null}
          {tx.message ? (
            <p className="t-muted" role="status">
              {tx.message.split('\n').map((line, i) => (
                <span key={i} style={{ display: 'block' }}>
                  {line}
                </span>
              ))}
            </p>
          ) : null}
          <button type="button" className="t-btn t-btn-primary t-btn-wide" disabled={tx.running} onClick={actions.now}>
            {tx.running ? TX_TEXT.running : TX_TEXT.transmitNow}
          </button>
        </section>
      ) : null}
      <section className="t-menu-group">
        <div className="t-report-head">
          <h2 className="t-menu-title">{TX_TEXT.historyTitle}</h2>
          <button type="button" className="t-btn t-btn-ghost t-btn-small" onClick={actions.open}>
            {TX_TEXT.refresh}
          </button>
        </div>
        {tx?.history.total ? <p className="t-muted t-small">{TX_TEXT.cloudCount(tx.history.total)}</p> : null}
        {tx?.history.error ? <p className="t-warn">{tx.history.error}</p> : null}
        {!tx || (tx.history.loading && tx.history.rows.length === 0) ? <p className="t-muted">{TX_TEXT.loading}</p> : null}
        {tx && !tx.history.loading && tx.history.rows.length === 0 ? <p className="t-muted">{TX_TEXT.empty}</p> : null}
        <ul className="t-menu">
          {(tx?.history.rows ?? []).map((r) => (
            <li key={r.id} className="t-tx-row">
              <div>
                <span className={r.tone === 'ok' ? 't-ok' : r.tone === 'error' ? 't-bad' : 't-muted'}>{r.status}</span>
                <span className="t-muted"> · {r.at ? new Date(r.at).toLocaleString('he-IL') : '—'} · {r.trigger}</span>
              </div>
              {r.facts.length > 0 ? <div className="t-small">{r.facts.join(' · ')}</div> : null}
              {r.detail ? <div className="t-small t-bad">{r.detail}</div> : null}
              {r.unsynced ? <div className="t-small t-muted">{TX_TEXT.unsynced}</div> : null}
            </li>
          ))}
        </ul>
        {tx?.history.more ? (
          <button type="button" className="t-btn t-btn-ghost" disabled={tx.history.loading} onClick={actions.more}>
            {TX_TEXT.more}
          </button>
        ) : null}
      </section>
    </div>
  );
}
