/**
 * "הסניף אינו פעיל — פנו לתמיכה" on a Windows screen that sells nothing (KDS, board, the roles not
 * built yet, the waiting screen): the shared lock (client kiosk-shared/shop-lock.tsx), at once.
 * The technician's corner (six taps top-left) and "יציאה לשולחן העבודה" stay, as on every screen
 * here — neither opens the lock; only the shop turned on again in the cloud does.
 */

import { useState } from 'react';
import { ShopLockScreen } from '@kiosk-shared/shop-lock';
import type { ShellView } from '../../shared/roles';
import { DesktopExitButton, DesktopExitPad } from '../desktop/DesktopExit';
import { RoleTechnician, useTechnicianCorner } from './RoleTechnician';

export function ShopLocked({ shellView }: { shellView: ShellView | null }) {
  const [tech, setTech, onCorner] = useTechnicianCorner();
  const [exitOpen, setExitOpen] = useState(false);
  return (
    <ShopLockScreen onPointerDown={onCorner}>
      {tech && shellView ? <RoleTechnician shellView={shellView} onClose={() => setTech(false)} /> : null}
      {!tech && !exitOpen ? <DesktopExitButton onOpen={() => setExitOpen(true)} /> : null}
      {exitOpen ? <DesktopExitPad onClose={() => setExitOpen(false)} /> : null}
    </ShopLockScreen>
  );
}
