/**
 * "קיוסקים" — a controlling till's kiosks (the Android KioskControl panel; core/till/kioskControl.ts): each kiosk's state,
 * today, its printers, unprinted bons ("הדפס עכשיו" / "סמן כטופל"), the last bon / sale again, "נעילה למכירה" (until reopened
 * or for some minutes, with a message) / "פתח עכשיו", and its shift or Z. The engine sends the commands and asks the manager's
 * code where the role needs one ("שליטה בקיוסק"); this only draws what the state says.
 */

import { useEffect, useRef, useState } from 'react';
import type { KiosksState, OpArgs } from '../../../../shared/till/protocol';
import { KIOSK_CONTROL_TEXT as K, type KioskControlRow } from '../../../../core/till/kioskControl';
import { T } from '../text';

type Command = OpArgs['kiosks.command'];

function LockForm({ busy, onLock }: { busy: boolean; onLock(minutes: number | null, message: string): void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'manual' | 'minutes'>('manual');
  const [minutes, setMinutes] = useState('30');
  const [message, setMessage] = useState('');
  if (!open) {
    return (
      <button type="button" className="t-btn" disabled={busy} onClick={() => setOpen(true)}>
        {K.lock}
      </button>
    );
  }
  const m = Number(minutes);
  return (
    <div className="t-kiosk-lock">
      <p className="t-small">{K.lockTitle}</p>
      <div className="t-chips">
        <button type="button" className={`t-chip${mode === 'manual' ? ' t-chip-on' : ''}`} onClick={() => setMode('manual')}>
          {K.lockModeManual}
        </button>
        <button type="button" className={`t-chip${mode === 'minutes' ? ' t-chip-on' : ''}`} onClick={() => setMode('minutes')}>
          {K.lockModeMinutes}
        </button>
      </div>
      {mode === 'minutes' ? (
        <label className="t-field">
          <span>{K.lockMinutes}</span>
          <input className="t-input" inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value.replace(/\D+/g, '').slice(0, 4))} />
        </label>
      ) : null}
      <label className="t-field">
        <span>{K.pauseMessage}</span>
        <input className="t-input" value={message} maxLength={300} onChange={(e) => setMessage(e.target.value)} />
      </label>
      <div className="t-shift-actions">
        <button type="button" className="t-btn t-btn-primary" disabled={busy || (mode === 'minutes' && !(m >= 1 && m <= 1440))} onClick={() => onLock(mode === 'minutes' ? m : null, message)}>
          {K.lockNow}
        </button>
        <button type="button" className="t-btn t-btn-ghost" onClick={() => setOpen(false)}>
          {T.cancel}
        </button>
      </div>
    </div>
  );
}

function KioskCard({ k, busy, send }: { k: KioskControlRow; busy: boolean; send(c: Omit<Command, 'kioskId'>): void }) {
  return (
    <section className="t-menu-group t-kiosk" data-kiosk={k.machineId}>
      <h2 className="t-menu-title t-kiosk-name">{k.name}</h2>
      <div className="t-kiosk-card">
        <p className={k.online ? 't-ok' : 't-muted'}>{k.stateLine}</p>
        <p>{k.ordersLine}</p>
        <p className="t-muted t-small">{k.printerLine}</p>
        {k.unprintedLine ? <p className="t-bad">{k.unprintedLine}</p> : null}
        {k.alertsLine ? <p className="t-warn">{k.alertsLine}</p> : null}
        {k.unprintedOrders.map((o) => (
          <div key={o.localId} className="t-kiosk-row">
            <span className="t-bad">{o.text}</span>
            <button type="button" className="t-btn t-btn-small" disabled={busy} onClick={() => send({ action: 'bon_print', message: o.localId })}>
              {K.printNow}
            </button>
            <button type="button" className="t-btn t-btn-small" disabled={busy} onClick={() => send({ action: 'bon_handled', message: o.localId })}>
              {K.markHandled}
            </button>
          </div>
        ))}
        <div className="t-shift-actions">
          <button type="button" className="t-btn" disabled={busy} onClick={() => send({ action: 'reprint_bon', message: 'last' })}>
            {K.lastBon}
          </button>
          <button type="button" className="t-btn" disabled={busy} onClick={() => send({ action: 'reprint_receipt', message: 'last' })}>
            {K.lastSale}
          </button>
        </div>
        {k.locked ? (
          <div className="t-kiosk-lock">
            <p className="t-strong">{K.locked}</p>
            <p className="t-muted t-small">
              {k.locked.by} · {k.locked.until}
            </p>
            <button type="button" className="t-btn t-btn-primary" disabled={busy} onClick={() => send({ action: 'resume' })}>
              {K.reopen}
            </button>
          </div>
        ) : (
          <LockForm busy={busy} onLock={(minutes, message) => send({ action: 'pause', minutes, message: message || null })} />
        )}
        {k.z ? (
          <button type="button" className="t-btn" disabled={busy} onClick={() => send({ action: k.z!.action })}>
            {k.z.label}
          </button>
        ) : k.zNote ? (
          <p className="t-muted t-small">{k.zNote}</p>
        ) : null}
      </div>
    </section>
  );
}

export function KiosksScreen({ kiosks, refresh, command, back }: { kiosks: KiosksState | undefined; refresh(): void; command(c: Command): void; back(): void }) {
  const asked = useRef(false);
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    refresh();
  }, [refresh]);
  const rows = kiosks?.rows ?? [];
  const busy = kiosks?.busy === true;
  return (
    <div className="t-report">
      <div className="t-report-head">
        <h1 className="t-report-title">{K.title}</h1>
        <button type="button" className="t-btn t-btn-ghost" disabled={busy} onClick={refresh}>
          {K.refresh}
        </button>
        <button type="button" className="t-btn t-btn-ghost" onClick={back}>
          {T.back}
        </button>
      </div>
      {kiosks?.note ? (
        <p className={kiosks.note.ok ? 't-ok' : 't-warn'} role="status">
          {kiosks.note.text}
        </p>
      ) : null}
      {rows.length === 0 ? <p className="t-muted">{K.none}</p> : null}
      {rows.map((k) => (
        <KioskCard key={k.machineId} k={k} busy={busy} send={(c) => command({ kioskId: k.machineId, ...c })} />
      ))}
    </div>
  );
}
