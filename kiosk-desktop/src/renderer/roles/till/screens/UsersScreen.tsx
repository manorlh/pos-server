/**
 * "עובדים מחוברים" (P:/specs/exclusive-login-v2.md §8א; Android ui/auth/SignedInUsersUi.kt): who is signed in at which device of
 * the shop — since when, "לא מדווח", their open tables — and "שחרור" by a manager from here. Opening it asks a manager's code
 * when the employee signed in may not release (the engine's dialog); the release is confirmed, and done by the cloud.
 */

import { useEffect } from 'react';
import type { UsersState } from '../../../../shared/till/protocol';
import { T } from '../text';

const hm = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

export function UsersScreen({ users, actions }: { users: UsersState | undefined; actions: { open(): void; refresh(): void; release(sessionId: string): void; close(): void } }) {
  useEffect(() => {
    actions.open();
    // Opened once per visit; the engine keeps the list until the screen closes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const list = users?.list;
  return (
    <div className="t-report">
      <div className="t-report-head">
        <h1 className="t-report-title">עובדים מחוברים</h1>
        <button type="button" className="t-btn t-btn-ghost" onClick={actions.refresh} disabled={!list || users?.busy}>
          רענון
        </button>
        <button type="button" className="t-btn t-btn-ghost" onClick={actions.close}>
          {T.back}
        </button>
      </div>
      {users?.error ? <p className="t-warn">{users.error}</p> : null}
      {!list ? (
        <p className="t-muted">{users?.busy ? 'טוען…' : ''}</p>
      ) : list.sessions.length === 0 ? (
        <p className="t-muted">אין עובדים מחוברים כרגע.</p>
      ) : (
        <ul className="t-menu">
          {list.sessions.map((s) => (
            <li key={s.id}>
              <div className="t-menu-row">
                <span>
                  {s.posUserName ?? ''} · {s.posNumber ? `קופה ${s.posNumber}` : ''}
                  {s.machineName ? ` (${s.machineName})` : ''}
                  {s.here ? ' · המכשיר הזה' : ''}
                </span>
                <small className="t-reason">
                  {s.silentSince ? `לא מדווח מאז ${hm(s.silentSince)}` : `מאז ${hm(s.startedAt)}`}
                  {s.openTables > 0 ? ` · שולחנות פתוחים: ${s.openTables}` : ''}
                </small>
                {s.here ? null : (
                  <button type="button" className="t-btn t-btn-small" onClick={() => actions.release(s.id)}>
                    שחרור
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
