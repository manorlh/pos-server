/**
 * "תפריט" — the Android ☰ drawer, in its groups ("משמרת", "דוחות", "ניהול") and its words. What this version of the Windows
 * till has works; every other row of the Android menu is shown with "בקרוב" (the parity backlog, one place), never a button
 * that does nothing. The user's session (switch user) and the work mode ("מעבר לקיוסק" / "חזרה למצב קיוסק") are at the end.
 */

import type { TillState } from '../../../../shared/till/protocol';
import { T } from '../text';

export type MenuTarget = 'shift' | 'history' | 'caps';

interface Row {
  label: string;
  sub?: string;
  to?: MenuTarget;
  /** The right a user needs to see it (the engine's `session.permissions`); absent: everyone. */
  perm?: string;
  /** Built here, but only where the owner turned it on (zMode = till). */
  onlyTillZ?: boolean;
  /** A shift row: not on an independent till (no shifts in its UI). */
  shiftRow?: boolean;
}

const GROUPS: Array<{ title: string; rows: Row[] }> = [
  {
    title: 'משמרת',
    rows: [
      { label: 'משמרת (דו״ח X)', to: 'shift', shiftRow: true },
      { label: 'סגירת משמרת', to: 'shift', perm: 'SHIFT_CLOSE', shiftRow: true },
      { label: 'הפק Z', to: 'shift', perm: 'Z', onlyTillZ: true },
      { label: 'פתיחת מגירה' },
      { label: 'מזומן במגירה', sub: 'הכנסת מזומן · הוצאת מזומן · הפקדה · ספירת מגירה · לוג פתיחות' },
      { label: 'זיכוי' },
      { label: 'נוכחות' },
      { label: 'סנכרון מול הענן' },
      { label: 'הזמנות קיוסק לתשלום' },
      { label: 'מכירות בהמתנה' },
      { label: 'שולחנות' },
    ],
  },
  {
    title: 'דוחות',
    rows: [
      { label: 'היסטוריה', to: 'history' },
      { label: 'מכירות לפי מוצר' },
      { label: 'דוח לפי עובד' },
      { label: 'דוח תשר' },
      { label: 'דוחות שולחנות' },
    ],
  },
  {
    title: 'ניהול',
    rows: [{ label: 'עריכת מסך' }, { label: 'הגדרות' }, { label: 'אבחון' }, { label: 'תמיכה מרחוק' }],
  },
];

export function MenuScreen({ state, go, signOut, switchTo, back }: { state: TillState; go(to: MenuTarget): void; signOut(): void; switchTo(): void; back(): void }) {
  const perms = state.session.permissions;
  const tillZ = state.z.zMode === 'till';
  // An independent till has no shifts: no "משמרת (דו״ח X)", no "סגירת משמרת" — only "הפק Z".
  const noShifts = state.shift.hidden === true;
  const canSwitch = state.mode.rolesAllowed.includes('kiosk');
  return (
    <div className="t-report">
      <div className="t-report-head">
        <h1 className="t-report-title">{T.menu}</h1>
        <button type="button" className="t-btn t-btn-ghost" onClick={back}>
          {T.back}
        </button>
      </div>
      {GROUPS.map((g) => (
        <section key={g.title} className="t-menu-group">
          <h2 className="t-menu-title">{g.title}</h2>
          <ul className="t-menu">
            {g.rows
              .filter((r) => (!r.perm || perms.includes(r.perm)) && (!r.onlyTillZ || tillZ) && !(noShifts && r.shiftRow))
              .map((r) => (
                <li key={r.label}>
                  {r.to ? (
                    <button type="button" className="t-menu-row" onClick={() => go(r.to!)}>
                      <span>{r.label}</span>
                    </button>
                  ) : (
                    <div className="t-menu-row t-menu-off" aria-disabled="true">
                      <span>{r.label}</span>
                      <small className="t-soon">{T.soon}</small>
                      {r.sub ? <small className="t-reason">{r.sub}</small> : null}
                    </div>
                  )}
                </li>
              ))}
          </ul>
        </section>
      ))}
      <section className="t-menu-group">
        <ul className="t-menu">
          <li>
            <button type="button" className="t-menu-row" onClick={() => go('caps')}>
              <span>{T.caps}</span>
            </button>
          </li>
          {canSwitch ? (
            <li>
              <button type="button" className="t-menu-row" onClick={switchTo}>
                <span>{state.mode.switchLabel ?? 'מעבר לקיוסק'}</span>
              </button>
            </li>
          ) : null}
          <li>
            <button type="button" className="t-menu-row t-menu-danger" onClick={signOut}>
              <span>{T.signOut}</span>
            </button>
          </li>
        </ul>
      </section>
    </div>
  );
}
