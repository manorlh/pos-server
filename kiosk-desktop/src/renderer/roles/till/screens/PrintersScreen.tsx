/**
 * "מדפסות" (core/till/printersView.ts — the Android PrintersScreen): the tickets that need a person, the shop's print
 * server, "מדפסת לקבלות ולמסמכים", every printer this till prints to with its light ("בדיקת תקשורת", "בון בדיקה", "הדפסת
 * ניסיון בעיצוב הזה", "בדיקת רוחב"), what printed in the last 24 hours ("הדפס שוב") and "חיפוש מדפסות ברשת" with
 * "הוספה". The engine tests, prints and asks the codes; this only draws the state and sends the taps.
 */

import { useState } from 'react';
import type { FoundPrinterView, PrinterLight, PrintersState } from '../../../../core/till/printersView';
import { T } from '../text';

export interface PrintersActions {
  check(printerId: string): void;
  test(printerId: string): void;
  designTest(printerId: string): void;
  widthTest(printerId: string): void;
  reprint(jobId: string): void;
  /** The engine's `printQueue.retry`. */
  retry(jobId: string): void;
  /** The engine's `printQueue.handled` (a manager's code). */
  handled(jobId: string): void;
  move(jobId: string): void;
  toTill(jobId: string): void;
  /** This till's receipt printer (null: back to the cloud's setting). */
  receipt(choice: string | null): void;
  scan(): void;
  scanStop(): void;
  add(p: { host: string; port: number; name: string; purpose: 'kitchen' | 'receipt' }): void;
}

function Dot({ light }: { light: PrinterLight }) {
  return <span className={`t-prn-dot t-prn-dot-${light}`} aria-hidden="true" />;
}

function AddForm({ f, view, onAdd, onCancel }: { f: FoundPrinterView; view: NonNullable<PrintersState['discovery']>; onAdd(name: string, purpose: 'kitchen' | 'receipt'): void; onCancel(): void }) {
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState<'kitchen' | 'receipt'>('kitchen');
  return (
    <div className="t-prn-add">
      <p className="t-prn-name">{f.addTitle}</p>
      <label className="t-field">
        <span>{view.add.name}</span>
        <input className="t-input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
      </label>
      <p className="t-small t-muted">{view.add.purpose}</p>
      <div className="t-chips">
        <button type="button" className={`t-chip${purpose === 'kitchen' ? ' t-chip-on' : ''}`} onClick={() => setPurpose('kitchen')}>
          {view.add.kitchen}
        </button>
        <button type="button" className={`t-chip${purpose === 'receipt' ? ' t-chip-on' : ''}`} onClick={() => setPurpose('receipt')}>
          {view.add.receipt}
        </button>
      </div>
      <p className="t-small t-muted">{view.add.hint}</p>
      <div className="t-prn-actions">
        <button type="button" className="t-btn t-btn-primary" onClick={() => onAdd(name, purpose)}>
          {view.add.label}
        </button>
        <button type="button" className="t-btn t-btn-ghost" onClick={onCancel}>
          {view.add.cancel}
        </button>
      </div>
    </div>
  );
}

export function PrintersScreen({ view, actions, back }: { view: PrintersState | null; actions: PrintersActions; back(): void }) {
  const [adding, setAdding] = useState<string | null>(null);
  const L = view?.labels;
  return (
    <div className="t-report t-prn">
      <div className="t-report-head">
        <h1 className="t-report-title">{view?.title ?? 'מדפסות'}</h1>
        <button type="button" className="t-btn t-btn-ghost" onClick={back}>
          {T.back}
        </button>
      </div>
      {!view || !L ? <p className="t-muted">…</p> : null}

      {view && L && view.queue ? (
        <section className="t-menu-group">
          <h2 className="t-menu-title t-bad">{view.queue.title}</h2>
          {view.queue.rows.map((r) => (
            <div key={r.id} className="t-prn-card t-prn-attention" data-job={r.id}>
              <p className="t-prn-name">{r.title}</p>
              <p className="t-small t-bad">{r.state}</p>
              <div className="t-prn-actions">
                <button type="button" className="t-btn t-btn-small" onClick={() => actions.retry(r.id)}>
                  {L.retry}
                </button>
                {r.canMove ? (
                  <button type="button" className="t-btn t-btn-small" onClick={() => actions.move(r.id)}>
                    {L.other}
                  </button>
                ) : null}
                {r.canTill ? (
                  <button type="button" className="t-btn t-btn-small" onClick={() => actions.toTill(r.id)}>
                    {L.till}
                  </button>
                ) : null}
                <button type="button" className="t-btn t-btn-small t-btn-ghost" onClick={() => actions.handled(r.id)}>
                  {L.dismiss}
                </button>
              </div>
            </div>
          ))}
        </section>
      ) : null}

      {view?.server ? (
        <div className="t-prn-card">
          <p className="t-prn-name">
            <Dot light={view.server.light} />
            {view.server.title}
          </p>
          <p>{view.server.text}</p>
          {view.server.sub ? <p className="t-small t-muted">{view.server.sub}</p> : null}
        </div>
      ) : null}

      {view ? (
        <div className="t-prn-card">
          <p className="t-prn-name">{view.receipt.title}</p>
          <p className="t-small t-muted">{view.receipt.hint}</p>
          <p className="t-strong">{view.receipt.now}</p>
          {view.receipt.override ? (
            <div className="t-prn-actions">
              <span className="t-small">{view.receipt.override}</span>
              <button type="button" className="t-btn t-btn-small t-btn-ghost" onClick={() => actions.receipt(null)}>
                {view.receipt.backLabel}
              </button>
            </div>
          ) : null}
          {view.receipt.followsCloud ? <p className="t-small t-muted">{view.receipt.followsCloud}</p> : null}
          {view.receipt.gone ? <p className="t-small t-bad">{view.receipt.gone}</p> : null}
          {view.receipt.options.length > 0 ? (
            <div className="t-chips" role="radiogroup" aria-label={view.receipt.title}>
              {view.receipt.options.map((o) => (
                <button key={o.id} type="button" role="radio" aria-checked={o.on} className={`t-chip${o.on ? ' t-chip-on' : ''}`} onClick={() => actions.receipt(o.id)}>
                  {o.label}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {view && L ? (
        <section className="t-menu-group">
          <h2 className="t-menu-title">{view.listTitle}</h2>
          {view.none ? <p className="t-small t-muted">{view.none}</p> : null}
          {view.rows.map((p) => (
            <div key={p.id} className="t-prn-card" data-printer={p.id}>
              <p className="t-prn-name">
                <Dot light={p.light} />
                {p.name}
              </p>
              <p className="t-small t-muted">{p.where}</p>
              {p.usb ? <p className="t-small t-muted">{p.usb}</p> : null}
              {p.design ? <p className="t-small t-muted">{p.design}</p> : null}
              <p className={p.light === 'error' ? 't-bad' : p.light === 'ok' ? 't-ok' : undefined}>{p.status}</p>
              <div className="t-prn-actions">
                <button type="button" className="t-btn t-btn-small" disabled={p.checking} onClick={() => actions.check(p.id)}>
                  {L.check}
                </button>
                <button type="button" className="t-btn t-btn-small" onClick={() => actions.test(p.id)}>
                  {L.testTicket}
                </button>
                {p.designTest ? (
                  <button type="button" className="t-btn t-btn-small" onClick={() => actions.designTest(p.id)}>
                    {L.testDesign}
                  </button>
                ) : null}
                {p.widthTest ? (
                  <button type="button" className="t-btn t-btn-small" onClick={() => actions.widthTest(p.id)}>
                    {L.widthTest}
                  </button>
                ) : null}
              </div>
            </div>
          ))}
        </section>
      ) : null}

      {view?.message ? (
        <p className="t-small t-prn-message" role="status">
          {view.message}
        </p>
      ) : null}

      {view && L && view.history ? (
        <section className="t-menu-group">
          <h2 className="t-menu-title">{view.history.title}</h2>
          <ul className="t-list t-prn-history">
            {view.history.rows.map((r) => (
              <li key={r.id} className="t-list-row t-prn-history-row">
                <span className="t-prn-history-text">{r.text}</span>
                <button type="button" className="t-btn t-btn-small t-btn-ghost" onClick={() => actions.reprint(r.id)}>
                  {L.reprint}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {view?.discovery ? (
        <div className="t-prn-card t-prn-discovery">
          <div className="t-prn-actions">
            <span className="t-prn-name t-prn-grow">{view.discovery.title}</span>
            {view.discovery.scanning ? (
              <button type="button" className="t-btn t-btn-small" onClick={actions.scanStop}>
                {view.discovery.stopLabel}
              </button>
            ) : (
              <button type="button" className="t-btn t-btn-small t-btn-primary" onClick={actions.scan}>
                {view.discovery.startLabel}
              </button>
            )}
          </div>
          <p className="t-small t-muted">{view.discovery.hint}</p>
          {view.discovery.text ? <p className="t-small">{view.discovery.text}</p> : null}
          {view.discovery.found.map((f) => (
            <div key={f.key} className="t-prn-found">
              <p className="t-prn-name">{f.title}</p>
              <p className="t-small t-muted">{[f.kind, f.paper].filter(Boolean).join(' · ')}</p>
              {f.known ? <p className="t-small t-ok">{f.known}</p> : null}
              {f.canAdd && adding !== f.key ? (
                <button type="button" className="t-btn t-btn-small" onClick={() => setAdding(f.key)}>
                  {view.discovery!.add.label}
                </button>
              ) : null}
              {f.canAdd && adding === f.key ? (
                <AddForm
                  f={f}
                  view={view.discovery!}
                  onCancel={() => setAdding(null)}
                  onAdd={(name, purpose) => {
                    setAdding(null);
                    actions.add({ host: f.host, port: f.port, name, purpose });
                  }}
                />
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
