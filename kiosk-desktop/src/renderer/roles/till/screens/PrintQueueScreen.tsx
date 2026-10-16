/**
 * "תור הדפסה" (pos-android ui/kitchen/PrintQueueScreen.kt, KitchenPrintBanner.kt; main/till/tillPrintQueue.ts): the kitchen
 * tickets that need a person — each with "הדפס שוב", "העבר למדפסת אחרת" (the printers this till reaches, with their light) and
 * "סמן כטופל" (a manager's code) — and the redirects in force with "בטל הפניה". The engine decides; the screen asks it.
 */

import { useCallback, useEffect, useState } from 'react';
import { FAILOVER_TEXT } from '../../../../core/kitchen/failover';
import { T } from '../text';

export interface QueueRow {
  id: string;
  title: string;
  printer: string;
  state: string;
  error: string | null;
  at: number;
  canMove: boolean;
}

export interface PrintQueueActions {
  list(): Promise<{ rows: QueueRow[]; view: { redirects: Array<{ fromId: string; text: string }> } | null } | undefined>;
  choices(jobId: string): Promise<Array<{ id: string; label: string }> | undefined>;
  retry(jobId: string): Promise<unknown>;
  move(jobId: string, toId: string): Promise<unknown>;
  handled(jobId: string): Promise<unknown>;
  endRedirect(fromId: string): Promise<unknown>;
  back(): void;
}

const two = (n: number) => String(n).padStart(2, '0');

export function PrintQueueScreen({ actions }: { actions: PrintQueueActions }) {
  const [rows, setRows] = useState<QueueRow[] | null>(null);
  const [redirects, setRedirects] = useState<Array<{ fromId: string; text: string }>>([]);
  const [moving, setMoving] = useState<{ jobId: string; choices: Array<{ id: string; label: string }> } | null>(null);
  const load = useCallback(
    () =>
      void actions.list().then((v) => {
        if (!v) return;
        setRows(v.rows);
        setRedirects(v.view?.redirects ?? []);
      }),
    [actions],
  );
  useEffect(() => {
    load();
    const t = window.setInterval(load, 5_000);
    return () => window.clearInterval(t);
  }, [load]);
  const after = (p: Promise<unknown>) => void p.then(load);
  return (
    <div className="t-report">
      <div className="t-report-head">
        <h1 className="t-report-title">{FAILOVER_TEXT.queueTitle}</h1>
        <button type="button" className="t-btn t-btn-ghost" onClick={actions.back}>
          {T.back}
        </button>
      </div>
      {redirects.map((r) => (
        <div key={r.fromId} className="t-notice t-redirect" role="status">
          <span className="t-notice-text">{r.text}</span>
          <button type="button" className="t-pill" onClick={() => after(actions.endRedirect(r.fromId))}>
            {FAILOVER_TEXT.endRedirect}
          </button>
        </div>
      ))}
      {rows && rows.length === 0 ? <p className="t-muted">{FAILOVER_TEXT.empty}</p> : null}
      <ul className="t-menu">
        {(rows ?? []).map((r) => {
          const d = new Date(r.at);
          return (
            <li key={r.id} className="t-block-row">
              <div>
                <strong>{r.title}</strong>
                <span className="t-muted">
                  {' '}
                  · {r.printer} · {two(d.getHours())}:{two(d.getMinutes())}
                </span>
              </div>
              {r.error ? <div className="t-small t-bad">{r.error}</div> : null}
              <div className="t-shift-actions">
                {r.state === 'pending' || r.state === 'failed' ? (
                  <button type="button" className="t-btn t-btn-small" onClick={() => after(actions.retry(r.id))}>
                    {FAILOVER_TEXT.printAgain}
                  </button>
                ) : null}
                {r.canMove ? (
                  <button type="button" className="t-btn t-btn-small" onClick={() => void actions.choices(r.id).then((c) => setMoving({ jobId: r.id, choices: c ?? [] }))}>
                    {FAILOVER_TEXT.moveOther}
                  </button>
                ) : null}
                <button type="button" className="t-btn t-btn-small t-btn-ghost" onClick={() => after(actions.handled(r.id))}>
                  {FAILOVER_TEXT.markHandled}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
      {moving ? (
        <div className="t-overlay" role="dialog" aria-modal="true" aria-label={FAILOVER_TEXT.pickPrinter} onClick={() => setMoving(null)}>
          <div className="t-dialog" onClick={(e) => e.stopPropagation()}>
            <h2 className="t-dialog-title">{FAILOVER_TEXT.pickPrinter}</h2>
            {moving.choices.length === 0 ? <p className="t-muted">{FAILOVER_TEXT.noOther}</p> : null}
            <ul className="t-menu">
              {moving.choices.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className="t-menu-row"
                    onClick={() => {
                      const j = moving.jobId;
                      setMoving(null);
                      after(actions.move(j, c.id));
                    }}
                  >
                    {c.label}
                  </button>
                </li>
              ))}
            </ul>
            <div className="t-dialog-actions">
              <button type="button" className="t-btn t-btn-ghost" onClick={() => setMoving(null)}>
                {FAILOVER_TEXT.close}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
