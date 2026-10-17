/**
 * The Windows 7 build runs only the till (core/appBuild.ts, P:/specs/windows7-till.md): the cloud gave this device
 * another role (a kiosk, a KDS, a board, a customer display, a cash host). Nothing of that role runs — the screen
 * says why and how to fix it (make it a till in the dashboard, or pair it again with a till code). The technician's
 * corner (unpairing, the update, the logs) and "יציאה לשולחן העבודה" stay, as on every role screen.
 */

import { useState } from 'react';
import { ROLE_INFO } from '../../core/roles';
import type { ShellView } from '../../shared/roles';
import { DesktopExitButton, DesktopExitPad } from '../desktop/DesktopExit';
import { RoleTechnician, useTechnicianCorner } from './RoleTechnician';
import { updateLine } from './updateText';

export function RoleLocked({ lock, shellView }: { lock: NonNullable<ShellView['roleLock']>; shellView: ShellView }) {
  const [tech, setTech, onCorner] = useTechnicianCorner();
  const [exitOpen, setExitOpen] = useState(false);
  return (
    <div dir="rtl" className="relative flex h-screen w-screen flex-col items-center justify-center gap-4 bg-neutral-50 p-8 text-center" onPointerDown={onCorner}>
      <div className="text-3xl font-black tracking-tight">
        R2M <span className="font-bold text-blue-600">POS</span>
      </div>
      <h1 className="text-2xl font-extrabold">{lock.title}</h1>
      <p className="max-w-lg text-neutral-600">
        המכשיר הוגדר בענן כ<b>{ROLE_INFO[lock.role]?.label ?? lock.role}</b>.
      </p>
      <p className="max-w-lg text-sm text-neutral-500">{lock.message}</p>
      <p className="text-xs text-neutral-400">
        {shellView.machineName ?? ''} {shellView.shopName ? `· ${shellView.shopName}` : ''} · גרסה {shellView.appVersion} (Windows 7) · {updateLine(shellView.update)}
      </p>
      {tech ? <RoleTechnician shellView={shellView} onClose={() => setTech(false)} /> : null}
      {!tech && !exitOpen ? <DesktopExitButton onOpen={() => setExitOpen(true)} /> : null}
      {exitOpen ? <DesktopExitPad onClose={() => setExitOpen(false)} /> : null}
    </div>
  );
}
