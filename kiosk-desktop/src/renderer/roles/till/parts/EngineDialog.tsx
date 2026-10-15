/**
 * The engine's dialog (manager approval, a confirmation): part of the engine's STATE, answered
 * with `dialog.answer` — so when to ask stays the APK's flow, never the screen's (§3.3).
 */

import type { EngineDialog as Dialog } from '../../../../shared/till/protocol';
import { PinPad } from './PinPad';

export function EngineDialog({ dialog, answer }: { dialog: Dialog; answer(action: string, answers?: Record<string, string>): void }) {
  const pinField = dialog.fields.find((f) => f.kind === 'pin');
  const primary = dialog.actions.find((a) => a.primary) ?? dialog.actions[0];
  const others = dialog.actions.filter((a) => a !== primary);
  return (
    <div className="t-overlay" role="dialog" aria-modal="true" aria-labelledby={`dlg-${dialog.id}`}>
      <div className="t-dialog">
        <h2 id={`dlg-${dialog.id}`} className="t-dialog-title">
          {dialog.title}
        </h2>
        <p className="t-dialog-body">{dialog.body}</p>
        {pinField && primary ? (
          <PinPad label={pinField.label} submitLabel={primary.label} onSubmit={(pin) => answer(primary.id, { [pinField.name]: pin })} />
        ) : primary ? (
          <button type="button" className="t-btn t-btn-primary t-btn-wide" onClick={() => answer(primary.id)}>
            {primary.label}
          </button>
        ) : null}
        <div className="t-dialog-actions">
          {others.map((a) => (
            <button key={a.id} type="button" className="t-btn t-btn-ghost" onClick={() => answer(a.id)}>
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
