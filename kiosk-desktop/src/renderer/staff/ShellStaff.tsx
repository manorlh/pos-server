/**
 * "ניהול הקיוסק" on every screen of the Windows app that is not the kiosk's own (the kiosk draws its own staff layer,
 * KioskApp): pairing, "waiting" (no config yet — offline at the first start), the shop's lock, the KDS, the board, the
 * cash host, and the till role. The owner (16.10.2026): "תוסיף אופציה בלחיצה למעלה בצד ימין להיכנס להגדרות כמו
 * באנדרואיד ולעבוד" — two seconds held in the top-right corner (core/adminCorner.ts, the Android KioskAdminCorner),
 * then a MANAGER's code checked on the device against the cached roster (offline too), then the same menu as the
 * kiosk's: the work mode (kiosk ↔ till, where the owner allowed it), the technician's checks, the connection and the
 * payment's state, reprints, leaving to the desktop. Never during a payment.
 *
 * The till role is a separate view laid over this window (main/roles/tillElectron.ts): its own corner (TillApp) asks
 * the shell, which sets the till's view aside and sends `admin` here; closing the menu gives the till its screen back
 * (`adminClosed`).
 */

import { useEffect, useState, type ReactNode } from 'react';
import type { KioskView } from '../../shared/bridge';
import { shell } from '../roles/shellBridge';
import { StaffLayer } from './StaffLayer';
import { AdminHoldBar, useAdminCornerHold } from './adminHold';
import { staffModel } from './staffParts';

export { staffModel } from './staffParts';

export function ShellStaff({ view, paying = false, children }: { view: KioskView; paying?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState<'none' | 'admin' | 'technician'>('none');
  /** Opened by the till's corner: closing gives the till its screen back. */
  const [forTill, setForTill] = useState(false);
  const hold = useAdminCornerHold({ rtl: true, armed: () => open === 'none' && !paying, onOpen: () => setOpen('admin') });
  useEffect(
    () =>
      // The till's corner (`admin`) or its six taps (`technician` — the technician's code, no manager's).
      shell.on('admin', (p) => {
        setForTill(true);
        setOpen(p?.screen === 'technician' ? 'technician' : 'admin');
      }),
    [],
  );
  const close = () => {
    setOpen('none');
    if (forTill) {
      setForTill(false);
      shell.adminClosed?.();
    }
  };
  return (
    <div
      className="relative h-screen w-screen"
      data-shell-staff
      onPointerDownCapture={hold.handlers.onPointerDownCapture}
      onPointerMoveCapture={hold.handlers.onPointerMoveCapture}
      onPointerUpCapture={hold.handlers.onPointerUpCapture}
      onPointerCancelCapture={hold.handlers.onPointerCancelCapture}
      onClickCapture={hold.handlers.onClickCapture}
      onContextMenuCapture={hold.handlers.onContextMenuCapture}
    >
      {children}
      <StaffLayer m={staffModel()} view={view} open={open} onClose={close} alerts={false} />
      <AdminHoldBar progress={hold.progress} rtl={hold.rtl} />
    </div>
  );
}
