/** The locked till: an employee's code, checked by the engine (`session.login`), never here (§9.6). */

import { PinPad } from '../parts/PinPad';
import { T } from '../text';

export function LockScreen({ demo, onLogin }: { demo: boolean; onLogin(pin: string): void }) {
  return (
    <div className="t-lock">
      <h1 className="t-report-title">{T.loginTitle}</h1>
      {demo ? <p className="t-muted">הדגמה: כל קוד של 4 ספרות; 1234 — מנהלת</p> : null}
      <PinPad label={T.enterCode} submitLabel={T.loginSignIn} onSubmit={onLogin} />
    </div>
  );
}
