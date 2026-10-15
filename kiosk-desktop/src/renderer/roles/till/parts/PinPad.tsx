/**
 * A digit pad for codes (the lock screen, a manager's approval). The code goes to the ENGINE
 * (`session.login`, `dialog.answer`), which checks it — never this page (§9.6).
 */

import { useState } from 'react';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'] as const;

export function PinPad({ label, submitLabel, onSubmit, minLength = 4 }: { label: string; submitLabel: string; onSubmit(pin: string): void; minLength?: number }) {
  const [pin, setPin] = useState('');
  const press = (k: (typeof KEYS)[number]) => {
    if (k === 'clear') setPin('');
    else if (k === 'back') setPin((p) => p.slice(0, -1));
    else setPin((p) => (p.length < 8 ? p + k : p));
  };
  return (
    <div className="t-pin">
      <div className="t-pin-label">{label}</div>
      <div className="t-pin-dots" aria-live="polite" aria-label={`${pin.length} ספרות`}>
        {pin.length === 0 ? <span className="t-muted">—</span> : '•'.repeat(pin.length)}
      </div>
      <div className="t-pin-keys">
        {KEYS.map((k) => (
          <button key={k} type="button" className="t-key" onClick={() => press(k)}>
            {k === 'clear' ? 'נקה' : k === 'back' ? '⌫' : k}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="t-btn t-btn-primary t-btn-wide"
        disabled={pin.length < minLength}
        onClick={() => {
          onSubmit(pin);
          setPin('');
        }}
      >
        {submitLabel}
      </button>
    </div>
  );
}
