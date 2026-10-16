/**
 * "תפריט" — the Android ☰ drawer, in its groups ("משמרת", "דוחות", "ניהול") and its words. What this version of the Windows
 * till has works; every other row of the Android menu is shown with "בקרוב" (the parity backlog, one place), never a button
 * that does nothing. The user's session (switch user) and the work mode ("מעבר לקיוסק" / "חזרה למצב קיוסק") are at the end.
 */

import type { TillState } from '../../../../shared/till/protocol';
import { T } from '../text';

export type MenuTarget = 'shift' | 'history' | 'caps' | 'shopx' | 'drawer' | 'drawerOpen' | 'users';

interface Row {
  /** The Android till's menu key (core/till/menuHide.ts): `hiddenMenuItems` hides the row. */
  key?: string;
  label: string;
  sub?: string;
  to?: MenuTarget;
  /** The right a user needs to see it (the engine's `session.permissions`); absent: everyone. */
  perm?: string;
  /** Built here, but only where the owner turned it on (zMode = till). */
  onlyTillZ?: boolean;
  /** A shift row: not on an independent till (no shifts in its UI). */
  shiftRow?: boolean;
  /** "דוח X סניפי": only where the till's parameters put it (`shopXTills`). */
  onlyShopX?: boolean;
  /**
   * Shown only when the engine says so (the drawer's rows: its mode, the role — Android's `offered`); an engine that does not
   * say (the demo) shows the row as "בקרוב".
   */
  when?: (s: TillState) => boolean | undefined;
}

const GROUPS: Array<{ title: string; rows: Row[] }> = [
  {
    title: 'משמרת',
    rows: [
      { key: 'shift', label: 'משמרת (דו״ח X)', to: 'shift', shiftRow: true },
      { key: 'shift_close', label: 'סגירת משמרת', to: 'shift', perm: 'SHIFT_CLOSE', shiftRow: true },
      { key: 'till_z', label: 'הפק Z', to: 'shift', perm: 'Z', onlyTillZ: true },
      { key: 'open_cash_drawer', label: 'פתיחת מגירה', to: 'drawerOpen', when: (s) => s.drawer?.offered.open },
      {
        key: 'cash_menu',
        label: 'מזומן במגירה',
        sub: 'הכנסת מזומן · הוצאת מזומן · הפקדה · ספירת מגירה · לוג פתיחות',
        to: 'drawer',
        when: (s) => (s.drawer ? Object.entries(s.drawer.offered).some(([k, v]) => k !== 'open' && v) : undefined),
      },
      { key: 'refund', label: 'זיכוי' },
      { key: 'attendance', label: 'נוכחות' },
      { key: 'sync_now', label: 'סנכרון מול הענן' },
      { key: 'kiosk_orders', label: 'הזמנות קיוסק לתשלום' },
      { label: 'מכירות בהמתנה' },
      { key: 'tables', label: 'שולחנות' },
    ],
  },
  {
    title: 'דוחות',
    rows: [
      { key: 'history', label: 'היסטוריה', to: 'history' },
      { key: 'shop_x', label: 'דוח X סניפי', to: 'shopx', perm: 'SHOP_X_REPORT', onlyShopX: true },
      { key: 'product_sales', label: 'מכירות לפי מוצר' },
      { key: 'workers', label: 'דוח לפי עובד' },
      { key: 'tips', label: 'דוח תשר' },
      { key: 'tables_reports', label: 'דוחות שולחנות' },
    ],
  },
  {
    title: 'ניהול',
    // "הגדרות" hidden stays reachable: the manager's corner → "ניהול הקיוסק" → the technician (the Android safety rule).
    rows: [
      { key: 'screen_edit', label: 'עריכת מסך' },
      // "עובדים מחוברים" (exclusive-login-v2 §8א): where the rule is on; a manager's code opens it for anyone else.
      { key: 'signed_in_users', label: 'עובדים מחוברים', to: 'users', when: (s) => (s.users ? s.users.offered : undefined) },
      { key: 'settings', label: 'הגדרות' },
      { key: 'diagnostics', label: 'אבחון' },
      { key: 'support', label: 'תמיכה מרחוק' },
    ],
  },
];

export function MenuScreen({ state, go, signOut, switchTo, back }: { state: TillState; go(to: MenuTarget): void; signOut(): void; switchTo(): void; back(): void }) {
  const perms = state.session.permissions;
  const tillZ = state.z.zMode === 'till';
  // An independent till has no shifts: no "משמרת (דו״ח X)", no "סגירת משמרת" — only "הפק Z".
  const noShifts = state.shift.hidden === true;
  const hidden = new Set(state.menuHidden ?? []);
  const canSwitch = state.mode.rolesAllowed.includes('kiosk') && !hidden.has('kiosk_mode');
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
              .filter((r) => (!r.perm || perms.includes(r.perm)) && (!r.onlyTillZ || tillZ) && (!r.onlyShopX || state.shopX?.offered === true) && !(noShifts && r.shiftRow) && !(r.key && hidden.has(r.key)))
              .filter((r) => !r.when || r.when(state) !== false)
              .map((r) => (
                <li key={r.label}>
                  {r.to && (!r.when || r.when(state) === true) ? (
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
          {hidden.has('switch_user') ? null : (
            <li>
              <button type="button" className="t-menu-row t-menu-danger" onClick={signOut}>
                <span>{T.signOut}</span>
              </button>
            </li>
          )}
        </ul>
      </section>
    </div>
  );
}
