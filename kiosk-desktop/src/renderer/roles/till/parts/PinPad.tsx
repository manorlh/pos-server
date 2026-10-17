/**
 * A digit pad for codes (the lock screen, a manager's approval). The code goes to the ENGINE
 * (`session.login`, `dialog.answer`), which checks it — never this page (§9.6).
 *
 * Drawn as the Android till's (ui/auth/LoginScreen.kt PinEntry / PinPad; P:/specs/till-visual-parity): a dot per digit
 * (four at least — hollow, filled as typed), round keys left to right whatever the language — the digits filled, "C" and
 * "⌫" bare — and the wide "כניסה" under them.
 */

import { useState } from 'react';
import { Icon } from '../theme/icons';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'clear', '0', 'back'] as const;

export function PinPad({ label, submitLabel, onSubmit, minLength = 4 }: { label: string; submitLabel: string; onSubmit(pin: string): void; minLength?: number }) {
  const [pin, setPin] = useState('');
  const press = (k: (typeof KEYS)[number]) => {
    if (k === 'clear') setPin('');
    else if (k === 'back') setPin((p) => p.slice(0, -1));
    else setPin((p) => (p.length < 8 ? p + k : p));
  };
  const dots = Math.max(pin.length, 4);
  return (
    <div className="t-pin">
      <div className="t-pin-label">{label}</div>
      <div className="t-pin-dots" aria-live="polite" aria-label={`${pin.length} ספרות`}>
        {Array.from({ length: dots }, (_, i) => (
          <span key={i} className={`t-pin-dot${i < pin.length ? ' t-pin-dot-on' : ''}`} />
        ))}
      </div>
      <div className="t-pin-keys">
        {KEYS.map((k) => (
          <button key={k} type="button" className={`t-key${k === 'clear' || k === 'back' ? ' t-key-bare' : ''}`} aria-label={k === 'clear' ? 'נקה' : k === 'back' ? 'מחק ספרה' : undefined} onClick={() => press(k)}>
            {k === 'clear' ? 'C' : k === 'back' ? <Icon name="backspace" size={26} /> : k}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="t-btn t-btn-primary t-btn-wide t-pin-submit"
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
