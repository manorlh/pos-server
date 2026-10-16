/**
 * "מצב עבודה: קיוסק / קופה" in "ניהול הקיוסק" (the Android app's KioskWorkModeSection): the two modes — the mode now is
 * marked, the other one switches — the refusal in the Android words (and, over a customer's order, "איפוס מסך
 * הלקוח"), and the hint: always a manager's code with KIOSK_TILL_MODE, none again when the manager who opened the menu
 * holds it. In kiosk mode "קופה" switches; opened from the manager's corner over the till (staff/ShellStaff.tsx),
 * "קיוסק" switches back. Only where the owner allowed it (`info.enabled`) — or, in till mode, wherever the way back is
 * offered (`toKiosk`: a kiosk by role is never trapped as a till). The checks and the code itself are the service's
 * (main/service.ts adminAction 'workMode', main/workMode.ts).
 * Presentational only: it imports no bridge, so it renders anywhere (test/workModePanel.test.ts).
 */

import { cardStyle, type PreviewModel } from '@kiosk-shared/index';
import type { AdminWorkMode } from '../../shared/bridge';
import { WORK_TEXT } from '../../core/workMode';

export interface WorkRefusal {
  /** The wire code (`customer_ordering`, `kiosk_payment`…). */
  code: string;
  /** In Hebrew, as said under the buttons. */
  text: string;
}

export function WorkModePanel({
  m,
  info,
  refusal,
  onTill,
  onKiosk,
  onResetCustomer,
}: {
  m: PreviewModel;
  info: AdminWorkMode;
  refusal: WorkRefusal | null;
  /** "קופה": the service checks, then asks for the manager's code when the opener does not hold it. */
  onTill: () => void;
  /** "קיוסק" (till mode): the same, back to the kiosk. */
  onKiosk?: () => void;
  /** "איפוס מסך הלקוח" — offered under "לקוח באמצע הזמנה". */
  onResetCustomer?: () => void;
}) {
  const tillNow = info.mode === 'till';
  if (!info.enabled && !(tillNow && info.toKiosk)) return null;
  const current = { background: m.c.button, color: m.c.buttonText, borderRadius: 10 };
  const other = { background: `${m.c.button}1A`, color: m.c.button, borderRadius: 10 };
  return (
    <section className="space-y-1.5 p-3 text-sm" style={cardStyle(m)} data-work-mode data-mode={info.mode}>
      <h3 className="text-sm font-extrabold">{WORK_TEXT.title}</h3>
      <div className="flex gap-2">
        {tillNow ? (
          <button type="button" disabled={!info.toKiosk || !onKiosk} onClick={onKiosk} className="flex-1 py-3 text-sm font-bold disabled:opacity-40" style={other}>
            {WORK_TEXT.kiosk}
          </button>
        ) : (
          // The kiosk: the mode now (this menu is the kiosk's).
          <div className="flex-1 py-3 text-center text-sm font-bold" style={current} aria-current="true">
            {WORK_TEXT.kiosk}
          </div>
        )}
        {tillNow ? (
          <div className="flex-1 py-3 text-center text-sm font-bold" style={current} aria-current="true">
            {WORK_TEXT.till}
          </div>
        ) : (
          <button type="button" disabled={!info.toTill} onClick={onTill} className="flex-1 py-3 text-sm font-bold disabled:opacity-40" style={other}>
            {WORK_TEXT.till}
          </button>
        )}
      </div>
      {refusal ? (
        <div className="space-y-1.5 pt-1">
          <div className="text-xs font-semibold text-red-600" role="alert">
            {refusal.text}
          </div>
          {refusal.code === 'customer_ordering' && onResetCustomer ? (
            <button type="button" onClick={onResetCustomer} className="px-3 py-1.5 text-xs font-bold" style={{ background: `${m.c.button}1A`, color: m.c.button, borderRadius: 8 }}>
              {WORK_TEXT.resetCustomer}
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="text-xs" style={{ color: m.c.mutedText }}>
        {tillNow ? (info.openerHolds ? WORK_TEXT.hintToKiosk : WORK_TEXT.needsManagerToKiosk) : info.openerHolds ? WORK_TEXT.hint : WORK_TEXT.needsManager}
      </div>
    </section>
  );
}
