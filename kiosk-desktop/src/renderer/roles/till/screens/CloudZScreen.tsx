/**
 * "דוחות Z" from the cloud (core/till/cloudZ.ts — the Android CloudZScreen): the shop's Zs, newest first, each with a tick
 * for "הדפס רצף" and its own "הדפס"; a shop Z over tills asks what to print (its summary, one till's detail, every till's
 * detail apart) and a run of details shows "מדפיס קופה 2 מתוך 3…" with "ביטול". The engine loads and prints (behind
 * "דוחות בקופה"); this only draws the state and sends the taps.
 */

import type { CloudZState } from '../../../../core/till/cloudZ';
import { T } from '../text';

export interface CloudZActions {
  toggle(id: string): void;
  selectAll(): void;
  print(id: string): void;
  printSequence(): void;
  printSummary(id: string): void;
  /** One till's detail. */
  printTill(id: string, machineId: string): void;
  /** Every till's detail, each apart. */
  printAllTills(id: string): void;
  dismissChoice(): void;
  cancelTills(): void;
}

export function CloudZScreen({ view, actions, back }: { view: CloudZState | null; actions: CloudZActions; back(): void }) {
  return (
    <div className="t-report t-cloudz">
      <div className="t-report-head">
        <h1 className="t-report-title">{view?.title ?? 'דוחות Z'}</h1>
        <button type="button" className="t-btn t-btn-ghost" onClick={back}>
          {T.back}
        </button>
      </div>
      {!view ? <p className="t-muted">…</p> : null}
      {view?.message ? (
        <p className="t-small t-cloudz-message" role="status">
          {view.message}
        </p>
      ) : null}
      {view?.loadingText ? <p className="t-muted t-small">{view.loadingText}</p> : null}
      {view?.progress ? (
        <div className="t-cloudz-progress" role="status">
          <div className="t-cloudz-progress-text">
            <span>{view.progress.text}</span>
            {view.progress.detail ? <span className="t-small t-muted">{view.progress.detail}</span> : null}
          </div>
          <button type="button" className="t-btn t-btn-small" disabled={view.progress.cancelling} onClick={actions.cancelTills}>
            {view.progress.cancelLabel}
          </button>
        </div>
      ) : null}
      {view?.choice ? (
        <section className="t-menu-group t-cloudz-choice" aria-label={view.choice.title}>
          <h2 className="t-menu-title">{view.choice.title}</h2>
          <div className="t-cloudz-choice-list">
            <button type="button" className="t-btn t-btn-primary" onClick={() => actions.printSummary(view.choice!.id)}>
              {view.choice.summaryLabel}
            </button>
            {view.choice.tills.map((t) => (
              <button key={t.machineId} type="button" className="t-btn" onClick={() => actions.printTill(view.choice!.id, t.machineId)}>
                {t.label}
              </button>
            ))}
            {view.choice.allLabel ? (
              <button type="button" className="t-btn" onClick={() => actions.printAllTills(view.choice!.id)}>
                {view.choice.allLabel}
              </button>
            ) : null}
            <button type="button" className="t-btn t-btn-ghost" onClick={actions.dismissChoice}>
              {view.cancelLabel}
            </button>
          </div>
        </section>
      ) : null}
      {view && view.rows.length > 0 ? (
        <div className="t-cloudz-bar">
          <button type="button" className="t-btn" onClick={actions.selectAll}>
            {view.selectAllLabel}
          </button>
          <button type="button" className="t-btn t-btn-primary t-cloudz-sequence" disabled={!view.canSequence} onClick={actions.printSequence}>
            {view.sequenceLabel}
          </button>
        </div>
      ) : null}
      {view?.empty ? <p className="t-muted">{view.empty}</p> : null}
      {view && view.rows.length > 0 ? (
        <ul className="t-list t-cloudz-list">
          {view.rows.map((r) => (
            <li key={r.id} className="t-list-row t-cloudz-row" data-z={r.id}>
              <label className="t-cloudz-tick">
                <input type="checkbox" checked={r.checked} disabled={view.busy} onChange={() => actions.toggle(r.id)} />
                <span className="t-cloudz-text">
                  <span className="t-cloudz-title">{r.title}</span>
                  {r.line ? <span className="t-small t-muted">{r.line}</span> : null}
                </span>
              </label>
              <button type="button" className="t-btn t-btn-small t-cloudz-print" disabled={view.busy} onClick={() => actions.print(r.id)}>
                {r.printing ? view.printingLabel : view.printLabel}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
