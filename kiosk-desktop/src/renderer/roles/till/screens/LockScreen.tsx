/** The locked till: an employee's code, checked by the engine (`session.login`), never here (§9.6). */

import type { ReactNode } from 'react';
import { PinPad } from '../parts/PinPad';
import { T } from '../text';

/**
 * `onTechnician`: "טכנאי" under the pad (Android's login screen `TechnicianButton`) — the technician's code, then the one
 * technician screen of every role (P:/specs/windows-setup-parity.md); absent where the host has none (a browser).
 */
export function LockScreen({ demo, onLogin, onTechnician, extra }: { demo: boolean; onLogin(pin: string): void; onTechnician?: () => void; /** "שעון נוכחות" and the like, under the pad. */ extra?: ReactNode }) {
  return (
    <div className="t-lock">
      <h1 className="t-report-title">{T.loginTitle}</h1>
      {demo ? <p className="t-muted">הדגמה: כל קוד של 4 ספרות; 1234 — מנהלת</p> : null}
      <PinPad label={T.enterCode} submitLabel={T.loginSignIn} onSubmit={onLogin} />
      {extra}
      {onTechnician ? (
        <button type="button" className="t-link" onClick={onTechnician}>
          טכנאי
        </button>
      ) : null}
    </div>
  );
}
