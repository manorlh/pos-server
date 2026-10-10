/**
 * A role the cloud gave this device that this version does not run yet (a Windows till, a
 * customer display): the module boundary is in place (main/roles/types.ts), the screen says so.
 * Nothing fiscal happens here — no shift, no document, no payment.
 */

import { useState } from 'react';
import { ROLE_INFO } from '../../core/roles';
import type { AppRole, ShellView } from '../../shared/roles';
import { DesktopExitButton, DesktopExitPad } from '../desktop/DesktopExit';
import { RoleTechnician, useTechnicianCorner } from './RoleTechnician';
import { updateLine } from './updateText';

export function RolePlaceholder({ role, shellView }: { role: AppRole; shellView: ShellView }) {
  const [tech, setTech, onCorner] = useTechnicianCorner();
  const [exitOpen, setExitOpen] = useState(false);
  return (
    <div dir="rtl" className="relative flex h-screen w-screen flex-col items-center justify-center gap-4 bg-neutral-50 p-8 text-center" onPointerDown={onCorner}>
      <div className="text-3xl font-black tracking-tight">
        R2M <span className="font-bold text-blue-600">POS</span>
      </div>
      <h1 className="text-2xl font-extrabold">תפקיד זה יגיע בגרסה הבאה</h1>
      <p className="max-w-md text-neutral-600">
        המכשיר הוגדר בענן כ<b>{ROLE_INFO[role].label}</b>. בגרסה הזו של R2M POS ל-Windows פועלים הקיוסק, מסך המטבח ומסך מוכן / לא מוכן; המכשיר
        יתעדכן לבד כשהתפקיד יהיה זמין.
      </p>
      {role === 'till' ? (
        <p className="max-w-md text-sm text-neutral-500">אם המכשיר אמור להיות קיוסק — הפכו אותו לקיוסק בדשבורד (קיוסקים ← &quot;הפוך קופה לקיוסק&quot;).</p>
      ) : null}
      <p className="text-xs text-neutral-400">
        {shellView.machineName ?? ''} {shellView.shopName ? `· ${shellView.shopName}` : ''} · גרסה {shellView.appVersion} · {updateLine(shellView.update)}
      </p>
      {tech ? <RoleTechnician shellView={shellView} onClose={() => setTech(false)} /> : null}
      {!tech && !exitOpen ? <DesktopExitButton onOpen={() => setExitOpen(true)} /> : null}
      {exitOpen ? <DesktopExitPad onClose={() => setExitOpen(false)} /> : null}
    </div>
  );
}
