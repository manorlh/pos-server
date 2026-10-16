/**
 * The engine's dialog (manager approval, a confirmation, a choice): part of the engine's STATE, answered with
 * `dialog.answer` — so when to ask stays the APK's flow, never the screen's (§3.3). A dialog the engine answers by itself
 * when its time is up ("לפתוח מגירה?") shows the seconds left.
 */

import { useEffect, useState } from 'react';
import type { EngineDialog as Dialog } from '../../../../shared/till/protocol';
import { PinPad } from './PinPad';

function useSecondsLeft(expiresAt: number | undefined): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt) return;
    const t = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(t);
  }, [expiresAt]);
  return expiresAt ? Math.max(0, Math.ceil((expiresAt - now) / 1000)) : null;
}

export function EngineDialog({ dialog, answer }: { dialog: Dialog; answer(action: string, answers?: Record<string, string>): void }) {
  const pinField = dialog.fields.find((f) => f.kind === 'pin');
  const checks = dialog.fields.filter((f) => f.kind === 'check');
  const [ticked, setTicked] = useState<Record<string, boolean>>({});
  // Every action carries the boxes' answers ("לשלוח לשם גם את הבאים").
  const withChecks = (more?: Record<string, string>) => (checks.length ? { ...Object.fromEntries(checks.map((f) => [f.name, ticked[f.name] ? 'true' : 'false'])), ...(more ?? {}) } : more);
  const primary = dialog.actions.find((a) => a.primary) ?? dialog.actions[0];
  const others = dialog.actions.filter((a) => a !== primary);
  const left = useSecondsLeft(dialog.expiresAt);
  return (
    <div className="t-overlay" role="dialog" aria-modal="true" aria-labelledby={`dlg-${dialog.id}`}>
      <div className="t-dialog">
        <h2 id={`dlg-${dialog.id}`} className="t-dialog-title">
          {dialog.title}
        </h2>
        {dialog.body
          ? dialog.body.split('\n').map((line, i) => (
              <p key={i} className="t-dialog-body">
                {line}
              </p>
            ))
          : null}
        {checks.map((f) => (
          <label key={f.name} className="t-check">
            <input type="checkbox" checked={!!ticked[f.name]} onChange={(e) => setTicked((t) => ({ ...t, [f.name]: e.target.checked }))} />
            <span>{f.label}</span>
          </label>
        ))}
        {left !== null ? <p className="t-countdown">{left}</p> : null}
        {pinField && primary ? (
          <PinPad label={pinField.label} submitLabel={primary.label} onSubmit={(pin) => answer(primary.id, withChecks({ [pinField.name]: pin }))} />
        ) : primary ? (
          <button type="button" className="t-btn t-btn-primary t-btn-wide" onClick={() => answer(primary.id, withChecks())}>
            {primary.label}
          </button>
        ) : null}
        <div className="t-dialog-actions">
          {others.map((a) => (
            <button key={a.id} type="button" className="t-btn t-btn-ghost" onClick={() => answer(a.id, withChecks())}>
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
