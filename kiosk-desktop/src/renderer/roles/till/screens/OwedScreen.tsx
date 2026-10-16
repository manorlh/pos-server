/**
 * "עודף חייב ללקוח" / "זיכוי מוחזק" on the till (P:/specs/cash-paylink.md §9א, §11.8; Android ui/alerts/TillAlertsUi.kt): the
 * change a cash station could not give, routed by the cloud to this till, each named by its station — and "שולם ללקוח", which
 * the engine pays out of this till's drawer (the drawer's rules first, a manager's code when they ask, then the cloud, then
 * the cash out). The screen only shows the list and sends the tap.
 */

import { useEffect } from 'react';
import type { TillState } from '../../../../shared/till/protocol';
import { T } from '../text';

export function OwedScreen({ owed, actions }: { owed: TillState['owed']; actions: { refresh(): void; pay(id: string): void; back(): void } }) {
  useEffect(() => {
    actions.refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const items = owed?.items ?? [];
  return (
    <div className="t-report">
      <div className="t-report-head">
        <h1 className="t-report-title">עודף חייב ללקוח</h1>
        <button type="button" className="t-btn t-btn-ghost" onClick={actions.refresh}>
          רענון
        </button>
        <button type="button" className="t-btn t-btn-ghost" onClick={actions.back}>
          {T.back}
        </button>
      </div>
      {items.length === 0 ? (
        <p className="t-muted">אין עודף חייב ללקוחות</p>
      ) : (
        <ul className="t-menu">
          {items.map((n) => (
            <li key={n.id}>
              <div className="t-menu-row t-owed-row">
                <span>{n.line}</span>
                <button type="button" className="t-btn t-btn-primary" onClick={() => actions.pay(n.id)}>
                  שולם ללקוח
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
