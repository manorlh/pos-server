/**
 * "הזמנות קיוסק ממתינות לתשלום" (pos-android ui/sell/KioskOpenOrdersUi.kt — the strip, the list, the cancel sheet;
 * core/till/kioskOrders.ts, main/till/tillKioskOrders.ts): each order's number big, name · kiosk, service · items · how long
 * ago, what is left to pay ("שובר: …"), its lines, "בטיפול ב…" when another till holds it; "לתשלום" opens it on the payment
 * (the engine locks it and rebuilds its basket), "ביטול הזמנה" asks a reason. Draws only what the engine says.
 */

import { useEffect, useState } from 'react';
import { CANCEL_REASONS, KPAY_TEXT as K, type KioskOrdersState } from '../../../../core/till/kioskOrders';
import { money } from '../text';

export interface KioskOrdersActions {
  refresh(): void;
  pay(id: string): void;
  cancel(id: string, reason: string): void;
}

/** The orange strip on the sell screen: "הזמנות קיוסק ממתינות לתשלום (N)" — a tap opens the list. */
export function KioskOrdersStrip({ count, onOpen }: { count: number; onOpen(): void }) {
  if (count <= 0) return null;
  return (
    <button type="button" className="t-kpay-strip" onClick={onOpen}>
      <span className="t-kpay-strip-text">{K.badge(count)}</span>
      <span>{K.openList}</span>
    </button>
  );
}

function CancelSheet({ label, onCancel, onClose }: { label: string; onCancel(reason: string): void; onClose(): void }) {
  const [reason, setReason] = useState('');
  return (
    <div className="t-overlay" role="dialog" aria-modal="true" aria-label={K.cancelTitle(label)} onClick={onClose}>
      <div className="t-dialog" onClick={(e) => e.stopPropagation()}>
        <h2 className="t-dialog-title">{K.cancelTitle(label)}</h2>
        <p className="t-dialog-body">{K.cancelBody}</p>
        <div className="t-chips">
          {CANCEL_REASONS.map((r) => (
            <button key={r} type="button" className={`t-chip${reason === r ? ' t-chip-on' : ''}`} onClick={() => setReason(r)}>
              {r}
            </button>
          ))}
        </div>
        <label className="t-field">
          <span>{K.cancelReason}</span>
          <input className="t-input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
        </label>
        <div className="t-shift-actions">
          <button type="button" className="t-btn t-btn-danger" disabled={!reason.trim()} onClick={() => onCancel(reason.trim())}>
            {K.cancelConfirm}
          </button>
          <button type="button" className="t-btn t-btn-ghost" onClick={onClose}>
            {K.close}
          </button>
        </div>
      </div>
    </div>
  );
}

/** The list (a sheet over the till): refreshed when it opens. */
export function KioskOrdersSheet({ view, actions, onClose }: { view: KioskOrdersState | undefined; actions: KioskOrdersActions; onClose(): void }) {
  const [cancelling, setCancelling] = useState<{ id: string; label: string } | null>(null);
  useEffect(() => {
    actions.refresh();
    // Once, as it opens (Android refreshIfDue(force) when the list shows).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const rows = view?.rows ?? [];
  return (
    <div className="t-overlay" role="dialog" aria-modal="true" aria-label={K.listTitle} onClick={onClose}>
      <div className="t-dialog t-dialog-wide t-kpay" onClick={(e) => e.stopPropagation()}>
        <h2 className="t-dialog-title">{K.listTitle}</h2>
        {rows.length === 0 ? <p className="t-dialog-body">{K.empty}</p> : null}
        <ul className="t-kpay-list">
          {rows.map((o) => (
            <li key={o.id} className="t-kpay-card" data-order={o.id}>
              <div className="t-kpay-top">
                <span className="t-kpay-label" dir="ltr">
                  {o.label}
                </span>
                <span className="t-kpay-who">
                  <b>{o.title}</b>
                  <span className="t-small">{o.sub}</span>
                </span>
                <span className="t-kpay-due">
                  <b dir="ltr">{money(o.dueAgorot)}</b>
                  {o.voucherNote ? <span className="t-small">{o.voucherNote}</span> : null}
                </span>
              </div>
              {o.linesText ? <p className="t-small t-muted t-kpay-lines">{o.linesText}</p> : null}
              {o.lockedBy ? <p className="t-warn t-small">{o.lockedBy}</p> : null}
              <div className="t-kpay-actions">
                <button type="button" className="t-btn t-btn-primary" disabled={!o.actionable || view?.busyId === o.id || !!view?.busyId} onClick={() => actions.pay(o.id)}>
                  {view?.busyId === o.id ? '…' : K.pay}
                </button>
                <button type="button" className="t-btn t-btn-ghost t-bad" disabled={!o.actionable || !!view?.busyId} onClick={() => setCancelling({ id: o.id, label: o.label })}>
                  {K.cancel}
                </button>
              </div>
            </li>
          ))}
        </ul>
        <div className="t-dialog-actions">
          <button type="button" className="t-btn t-btn-ghost t-btn-wide" onClick={onClose}>
            {K.close}
          </button>
        </div>
      </div>
      {cancelling ? (
        <CancelSheet
          label={cancelling.label}
          onCancel={(reason) => {
            actions.cancel(cancelling.id, reason);
            setCancelling(null);
          }}
          onClose={() => setCancelling(null)}
        />
      ) : null}
    </div>
  );
}
