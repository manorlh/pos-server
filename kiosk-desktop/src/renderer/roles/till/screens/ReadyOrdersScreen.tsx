/**
 * "הזמנות להכנה" (pos-android ui/readyorders/ReadyOrdersScreen.kt; core/till/readyOrders.ts, main/till/tillReadyOrders.ts):
 * the shop's orders in three sections — "בהכנה", "מוכן לאיסוף", "נמסרו לאחרונה" — each row with its number, where it came
 * from, how long since it went to the kitchen, its items (what the kitchen has done reads lighter), and big buttons for what
 * its state allows. The list is asked for again every 5 seconds while the screen is up (Android POLL_MS); the engine words
 * everything — this only draws the state and passes the taps on.
 */

import { useEffect } from 'react';
import { READY_TEXT, type ReadyAction, type ReadyOrdersState, type ReadyRowView } from '../../../../core/till/readyOrders';
import { T } from '../text';

/** Android's POLL_MS: the list again while the screen is up. */
export const READY_POLL_MS = 5_000;

export interface ReadyOrdersActions {
  refresh(): void;
  tap(orderId: string, action: ReadyAction): void;
  retry(orderId: string): void;
  discard(orderId: string): void;
  dismiss(): void;
}

function Row({ row, actions }: { row: ReadyRowView; actions: ReadyOrdersActions }) {
  return (
    <li className={`t-ready-card${row.handed ? ' t-ready-handed' : ''}`} data-order={row.orderId}>
      <div className="t-ready-top">
        <span className="t-ready-headline">{row.headlineLtr ? <bdi dir="ltr">{row.headline}</bdi> : row.headline}</span>
        {row.minutes ? <span className="t-ready-minutes">{row.minutes}</span> : null}
      </div>
      {row.meta ? <div className="t-ready-meta">{row.meta}</div> : null}
      <div className="t-ready-items">
        {row.items.length === 0 ? (
          <span className="t-ready-item-done">{READY_TEXT.noItems}</span>
        ) : (
          row.items.map((it, i) => (
            <span key={i} className={it.ready ? 't-ready-item t-ready-item-done' : 't-ready-item'}>
              {it.text}
            </span>
          ))
        )}
      </div>
      {row.mode === 'failed' ? (
        <div className="t-ready-failed">
          <p className="t-bad">{READY_TEXT.failed}</p>
          <div className="t-ready-actions">
            <button type="button" className="t-btn t-btn-primary t-ready-btn" onClick={() => actions.retry(row.orderId)}>
              {READY_TEXT.retry}
            </button>
            <button type="button" className="t-btn t-btn-ghost t-ready-btn t-ready-btn-minor" onClick={() => actions.discard(row.orderId)}>
              {READY_TEXT.discard}
            </button>
          </div>
        </div>
      ) : row.mode === 'sending' ? (
        <div className="t-ready-sending t-muted">{READY_TEXT.sending}</div>
      ) : (
        <div className="t-ready-actions">
          {row.actions.map((a) => (
            <button
              key={a.action}
              type="button"
              className={a.primary ? 't-btn t-btn-primary t-ready-btn' : `t-btn t-ready-btn t-ready-btn-minor${row.actions.length === 1 ? ' t-ready-btn-alone' : ''}`}
              onClick={() => actions.tap(row.orderId, a.action)}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </li>
  );
}

/** "הזמנות להכנה". */
export function ReadyOrdersScreen({ view, actions, back }: { view: ReadyOrdersState | undefined; actions: ReadyOrdersActions; back(): void }) {
  useEffect(() => {
    actions.refresh();
    const t = window.setInterval(() => actions.refresh(), READY_POLL_MS);
    return () => window.clearInterval(t);
  }, [actions]);
  return (
    <div className="t-report t-ready">
      <div className="t-report-head">
        <h1 className="t-report-title">{READY_TEXT.title}</h1>
        <button type="button" className="t-btn t-btn-ghost" onClick={back}>
          {T.back}
        </button>
      </div>
      {!view || !view.loaded ? (
        <p className="t-muted t-ready-center">{READY_TEXT.loading}</p>
      ) : view.blocked ? (
        <p className="t-muted t-ready-center">{view.blocked}</p>
      ) : (
        <>
          {view.hasKds ? <p className="t-muted t-small">{READY_TEXT.hasKds}</p> : null}
          {view.offline ? <p className="t-ready-strip">{READY_TEXT.offline}</p> : null}
          {view.notice ? (
            <div className="t-ready-strip t-ready-strip-close">
              <span>{view.notice}</span>
              <button type="button" className="t-btn t-btn-ghost t-btn-small" aria-label={READY_TEXT.dismiss} onClick={actions.dismiss}>
                ✕
              </button>
            </div>
          ) : null}
          {view.empty ? (
            <div className="t-ready-empty">
              <strong>{READY_TEXT.emptyTitle}</strong>
              <p className="t-muted">{READY_TEXT.emptyBody}</p>
            </div>
          ) : null}
          {view.sections.map((s) => (
            <section key={s.key} className="t-ready-section" data-section={s.key}>
              <h2 className="t-ready-section-title">
                {s.title} <bdi dir="ltr">{s.count}</bdi>
              </h2>
              <ul className="t-ready-list">
                {s.rows.map((r) => (
                  <Row key={r.orderId} row={r} actions={actions} />
                ))}
              </ul>
            </section>
          ))}
        </>
      )}
    </div>
  );
}
