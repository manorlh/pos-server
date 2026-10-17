/**
 * The locked till: an employee's code, checked by the engine (`session.login`), never here (§9.6).
 *
 * Drawn as the Android till's sign-in (ui/auth/LoginScreen.kt; P:/specs/till-visual-parity): a faint wash of the brand at
 * the top, "Powered by R2M", the greeting by the hour, the time large and the day and date, then the code — its dots and
 * the round keys — and "כניסה" at the foot, "טכנאי" under it.
 */

import { useEffect, useState } from 'react';
import { PinPad } from '../parts/PinPad';
import { T } from '../text';

/** "בוקר טוב" … "לילה טוב" by the hour (Android greetingRes). */
export function greetingOf(hour: number): string {
  if (hour >= 5 && hour <= 11) return T.greetingMorning;
  if (hour >= 12 && hour <= 16) return T.greetingNoon;
  if (hour >= 17 && hour <= 20) return T.greetingEvening;
  return T.greetingNight;
}

/** "יום שבת, 17 באוקטובר" — the day and date as the Android sign-in writes them. */
export function dayLine(d: Date): string {
  try {
    return new Intl.DateTimeFormat('he-IL', { weekday: 'long', day: 'numeric', month: 'long' }).format(d);
  } catch {
    return d.toLocaleDateString();
  }
}

/**
 * `onTechnician`: "טכנאי" under the pad (Android's login screen `TechnicianButton`) — the technician's code, then the one
 * technician screen of every role (P:/specs/windows-setup-parity.md); absent where the host has none (a browser).
 */
export function LockScreen({ demo, onLogin, onTechnician }: { demo: boolean; onLogin(pin: string): void; onTechnician?: () => void }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 15_000);
    return () => window.clearInterval(t);
  }, []);
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  return (
    <div className="t-lock">
      <div className="t-lock-wash" aria-hidden="true" />
      <div className="t-powered t-lock-powered">
        Powered by <b>R2M</b>
      </div>
      <div className="t-lock-greeting">
        <span className="t-lock-hello">{greetingOf(now.getHours())}</span>
        <span className="t-lock-time" dir="ltr">
          {hh}:{mm}
        </span>
        <span className="t-lock-date">{dayLine(now)}</span>
      </div>
      <h1 className="t-report-title">{T.loginTitle}</h1>
      {demo ? <p className="t-muted">הדגמה: כל קוד של 4 ספרות; 1234 — מנהלת</p> : null}
      <PinPad label={T.loginEnterCode} submitLabel={T.loginSignIn} onSubmit={onLogin} />
      {onTechnician ? (
        <button type="button" className="t-link t-lock-tech" onClick={onTechnician}>
          טכנאי
        </button>
      ) : null}
    </div>
  );
}
