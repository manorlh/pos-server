/**
 * "סגירת Z סניפי" — the shop's Z from its master till (core/till/shopZRun.ts; pos-android ui/reports/ShopZScreen.kt): every
 * till and its live line, one button that closes them all and has the cloud produce the Z, the typed "סגור" to go on without
 * a till, the Z's number when built, its summary and each till's detail on paper. The engine (main/till/tillShopZ.ts) talks to
 * the cloud; this draws its state and ticks the seconds while a run waits.
 */

import { useEffect, useRef, useState } from 'react';
import { SHOP_Z_TEXT as Z, confirmTyped, shopZView, type CloudZTill, type ShopZState, type TillTone } from '../../../../core/till/shopZRun';
import { T } from '../text';

export interface ShopZActions {
  /** Opened: the tills read (and kept fresh while the screen is up). */
  open(): void;
  /** The screen went away. */
  leave(): void;
  refresh(): void;
  scope(area: boolean): void;
  start(confirm: boolean): void;
  proceed(): void;
  dismiss(): void;
  printSummary(): void;
  details(answer: 'all' | 'choose' | 'no'): void;
  printDetails(machineIds: string[]): void;
  cancelDetails(): void;
}

const TONE: Record<TillTone, string> = {
  working: 't-shopz-working',
  waiting: 't-shopz-waiting',
  done: 't-shopz-done',
  off: 't-shopz-off',
  muted: 't-shopz-muted',
  failed: 't-shopz-failed',
};

/** A confirmation the operator must type ("סגור") — a tap is too easy for this. */
function TypeToConfirm({ title, text, names, onConfirm, onDismiss }: { title: string; text: string; names?: string[]; onConfirm(): void; onDismiss(): void }) {
  const [typed, setTyped] = useState('');
  return (
    <div className="t-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="t-dialog">
        <h2 className="t-dialog-title">{title}</h2>
        <p className="t-dialog-body">{text}</p>
        {names?.length ? (
          <ul className="t-shopz-list">
            {names.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        ) : null}
        <label className="t-field">
          <span>{Z.typeLabel}</span>
          <input className="t-input" value={typed} autoFocus onChange={(e) => setTyped(e.target.value)} />
        </label>
        <div className="t-shift-actions">
          <button type="button" className="t-btn t-btn-danger" disabled={!confirmTyped(typed)} onClick={onConfirm}>
            {Z.ok}
          </button>
          <button type="button" className="t-btn t-btn-ghost" onClick={onDismiss}>
            {Z.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}

function Ask({ title, text, names, yes, no, onYes, onNo }: { title: string; text: string; names?: string[]; yes: string; no?: string; onYes(): void; onNo?(): void }) {
  return (
    <div className="t-overlay" role="dialog" aria-modal="true" aria-label={title}>
      <div className="t-dialog">
        <h2 className="t-dialog-title">{title}</h2>
        <p className="t-dialog-body">{text}</p>
        {names?.length ? (
          <ul className="t-shopz-list">
            {names.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        ) : null}
        <div className="t-shift-actions">
          <button type="button" className="t-btn t-btn-primary" onClick={onYes}>
            {yes}
          </button>
          {no && onNo ? (
            <button type="button" className="t-btn t-btn-ghost" onClick={onNo}>
              {no}
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/** Right after the summary prints: each till's detail apart — all, a choice, or none. */
function DetailsPrompt({ onAll, onChoose, onNo }: { onAll(): void; onChoose(): void; onNo(): void }) {
  return (
    <div className="t-overlay" role="dialog" aria-modal="true" aria-label={Z.detailsTitle}>
      <div className="t-dialog">
        <h2 className="t-dialog-title">{Z.detailsTitle}</h2>
        <p className="t-dialog-body">{Z.detailsBody}</p>
        <div className="t-shift-actions">
          <button type="button" className="t-btn t-btn-primary" onClick={onAll}>
            {Z.printAll}
          </button>
          <button type="button" className="t-btn" onClick={onChoose}>
            {Z.chooseTills}
          </button>
          <button type="button" className="t-btn t-btn-ghost" onClick={onNo}>
            {Z.no}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Which tills' details to print; all ticked to start with. */
function TillPicker({ tills, onPrint, onDismiss }: { tills: CloudZTill[]; onPrint(ids: string[]): void; onDismiss(): void }) {
  const [chosen, setChosen] = useState<string[]>(() => tills.map((t) => t.machineId));
  const toggle = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  return (
    <div className="t-overlay" role="dialog" aria-modal="true" aria-label={Z.pickerTitle}>
      <div className="t-dialog">
        <h2 className="t-dialog-title">{Z.pickerTitle}</h2>
        <div className="t-shopz-picks">
          {tills.map((t) => (
            <label key={t.machineId} className="t-shopz-pick">
              <input type="checkbox" checked={chosen.includes(t.machineId)} onChange={() => toggle(t.machineId)} />
              <span>{[t.posNumber && t.posNumber.trim() ? `#${t.posNumber}` : null, t.name && t.name.trim() ? t.name : null].filter(Boolean).join(' ') || Z.till}</span>
            </label>
          ))}
        </div>
        <div className="t-shift-actions">
          <button type="button" className="t-btn t-btn-primary" disabled={chosen.length === 0} onClick={() => onPrint(tills.filter((t) => chosen.includes(t.machineId)).map((t) => t.machineId))}>
            {Z.printN(chosen.length)}
          </button>
          <button type="button" className="t-btn t-btn-ghost" onClick={onDismiss}>
            {Z.cancel}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ShopZScreen({ view, actions, back, nowMs }: { view: ShopZState | undefined; actions: ShopZActions; back(): void; /** Tests: a fixed clock. */ nowMs?: number }) {
  const act = useRef(actions);
  act.current = actions;
  useEffect(() => {
    act.current.open();
    return () => act.current.leave();
  }, []);
  const [askStart, setAskStart] = useState(false);
  const [askProceed, setAskProceed] = useState(false);
  const live = view?.run ? view.run.status === 'waiting' || view.run.status === 'building' : false;
  // The seconds tick while the run waits.
  const [tick, setTick] = useState(() => Date.now());
  useEffect(() => {
    if (!live || nowMs !== undefined) return;
    const t = setInterval(() => setTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, [live, nowMs]);

  if (!view) {
    return (
      <div className="t-report">
        <div className="t-report-head">
          <h1 className="t-report-title">{Z.title}</h1>
          <button type="button" className="t-btn t-btn-ghost" onClick={back}>
            {T.back}
          </button>
        </div>
      </div>
    );
  }
  const v = shopZView(view, nowMs ?? tick);
  const p = v.phase;
  return (
    <div className="t-report t-shopz">
      <div className="t-report-head">
        <div>
          <h1 className="t-report-title">{v.title}</h1>
          {v.shopName ? <p className="t-muted">{v.shopName}</p> : null}
        </div>
        <div className="t-shift-actions">
          <button type="button" className="t-btn" disabled={!v.refreshEnabled} onClick={actions.refresh}>
            {Z.refresh}
          </button>
          <button type="button" className="t-btn t-btn-ghost" onClick={back}>
            {T.back}
          </button>
        </div>
      </div>

      {v.scope ? (
        <div className="t-chips" role="group">
          {v.scope.options.map((o) => (
            <button key={String(o.area)} type="button" className={`t-chip${o.on ? ' t-chip-on' : ''}`} disabled={!v.scope!.enabled} onClick={() => (o.on ? undefined : actions.scope(o.area))}>
              {o.label}
            </button>
          ))}
        </div>
      ) : null}

      {v.error ? (
        <p className="t-shopz-error" role="alert">
          {v.error}
        </p>
      ) : null}
      {v.message ? (
        <p className="t-shopz-error" role="alert">
          {v.message}
        </p>
      ) : null}
      {v.progress ? (
        <div className="t-shopz-progress" aria-live="polite">
          <div>
            <p>{v.progress.text}</p>
            {v.progress.detail ? <p className="t-small">{v.progress.detail}</p> : null}
          </div>
          {v.progress.cancellable ? (
            <button type="button" className="t-btn" disabled={v.progress.cancelling} onClick={actions.cancelDetails}>
              {v.progress.cancelling ? Z.stopping : Z.cancel}
            </button>
          ) : null}
        </div>
      ) : null}

      {p.kind === 'loading' ? <p className="t-muted">…</p> : null}

      {v.rows.length ? (
        <div className="t-shopz-rows">
          {v.rows.map((r) => (
            <div key={r.id} className="t-shopz-row" data-till={r.id}>
              <span className={`t-shopz-dot${r.online ? ' t-shopz-dot-on' : ''}`} aria-hidden="true" />
              <div className="t-shopz-name">
                <p className="t-shopz-till">{r.label}</p>
                {r.opener ? <p className="t-muted t-small">{r.opener}</p> : null}
                {!r.online ? <p className="t-bad t-small">{Z.notConnected}</p> : null}
              </div>
              <span className={`t-shopz-live ${TONE[r.live.tone]}`}>{r.live.text}</span>
            </div>
          ))}
        </div>
      ) : null}

      {p.kind === 'idle' ? (
        <>
          {p.ended ? <p className="t-shopz-error">{p.ended}</p> : null}
          <p>{p.openLine}</p>
          {p.nothing ? <p className="t-shopz-error">{p.nothing}</p> : null}
          {p.local ? <p className="t-shopz-error">{p.local}</p> : null}
          <button type="button" className="t-btn t-btn-primary t-shopz-big" disabled={!p.startEnabled} onClick={() => setAskStart(true)}>
            {p.busy ? '…' : Z.start}
          </button>
        </>
      ) : null}

      {p.kind === 'live' ? (
        <>
          {p.failedBox ? (
            <p className="t-shopz-error">{p.failedBox}</p>
          ) : (
            <div className="t-shopz-box" aria-live="polite">
              <p>{p.waitingLine}</p>
              {p.elapsed ? <p className="t-muted t-small">{p.elapsed}</p> : null}
            </div>
          )}
          <p className="t-muted t-small">{p.note}</p>
          {p.proceed ? (
            <button type="button" className="t-btn t-shopz-big" disabled={!p.proceedEnabled} onClick={() => setAskProceed(true)}>
              {p.proceed}
            </button>
          ) : null}
        </>
      ) : null}

      {p.kind === 'completed' ? (
        <>
          <div className="t-shopz-done-box">
            <h2>{p.title}</h2>
            <p>{p.sub}</p>
            {p.left ? <p>{p.left}</p> : null}
          </div>
          {p.zReportId ? (
            <div className="t-shopz-pair">
              <button type="button" className="t-btn" disabled={!p.printEnabled} onClick={actions.printSummary}>
                {Z.printSummaryAgain}
              </button>
              <button type="button" className="t-btn" disabled={!p.detailsEnabled} onClick={() => actions.details('choose')}>
                {Z.tillDetails}
              </button>
            </div>
          ) : null}
        </>
      ) : null}

      {askStart ? (
        <Ask
          title={Z.askStartTitle}
          text={Z.askStartBody}
          yes={Z.askStartYes}
          no={Z.cancel}
          onYes={() => {
            setAskStart(false);
            actions.start(false);
          }}
          onNo={() => setAskStart(false)}
        />
      ) : null}
      {v.needsConfirm ? <TypeToConfirm title={Z.confirmTitle} text={Z.confirmBody} names={v.needsConfirm} onConfirm={() => actions.start(true)} onDismiss={actions.dismiss} /> : null}
      {v.blockedBy ? <Ask title={Z.blockedTitle} text={Z.blockedBody} names={v.blockedBy} yes={Z.understood} onYes={actions.dismiss} /> : null}
      {askProceed ? (
        <TypeToConfirm
          title={Z.proceedTitle}
          text={Z.proceedBody}
          onConfirm={() => {
            setAskProceed(false);
            actions.proceed();
          }}
          onDismiss={() => setAskProceed(false)}
        />
      ) : null}
      {v.askDetails ? <DetailsPrompt onAll={() => actions.details('all')} onChoose={() => actions.details('choose')} onNo={() => actions.details('no')} /> : null}
      {v.choosing ? <TillPicker tills={v.choosing} onPrint={actions.printDetails} onDismiss={() => actions.details('no')} /> : null}
    </div>
  );
}
