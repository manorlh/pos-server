/**
 * The technician's screen on the role screens that are not the kiosk (KDS, order status board, the cash host, the
 * placeholders) — the same gesture and code as the kiosk's (staff/StaffLayer.tsx): six taps in the top-left corner
 * within 3 s → the technician code (1995 unless the cloud set one) → the ONE technician screen of every role
 * (technician/TechnicianScreen.tsx — P:/specs/windows-setup-parity.md), so a KDS, a till and a kiosk never drift apart.
 */

import { useRef, useState } from 'react';
import { inTechnicianZone, TapSequence } from '../../core/technician';
import type { ShellView } from '../../shared/roles';
import { kiosk } from '../bridge';
import { DesktopExitPad } from '../desktop/DesktopExit';
import { PinPad, staffModel } from '../staff/staffParts';
import { TechnicianScreen } from '../technician/TechnicianScreen';

/** The hidden corner: put it anywhere a role screen fills the window. */
export function useTechnicianCorner(): [boolean, (open: boolean) => void, (e: React.PointerEvent) => void] {
  const [open, setOpen] = useState(false);
  const taps = useRef(new TapSequence());
  const onPointerDown = (e: React.PointerEvent) => {
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (inTechnicianZone(e.clientX - rect.left, e.clientY - rect.top) && taps.current.tap(Date.now())) setOpen(true);
  };
  return [open, setOpen, onPointerDown];
}

export function RoleTechnician({ onClose }: { shellView?: ShellView; onClose: () => void }) {
  const [unlocked, setUnlocked] = useState(false);
  const [exitOpen, setExitOpen] = useState(false);
  const m = staffModel();
  return (
    <div className="fixed inset-0 z-[90]" onPointerDown={(e) => e.stopPropagation()}>
      {!unlocked ? (
        <PinPad
          m={m}
          title="בדיקות ומידע — קוד טכנאי"
          onCancel={onClose}
          onSubmit={async (code) => {
            const r = await kiosk.technicianUnlock(code);
            if (r.outcome === 'granted') setUnlocked(true);
            return r.outcome === 'granted' ? null : r.outcome === 'wrong' ? `קוד שגוי — נותרו ${r.triesLeft} ניסיונות` : `נעול ל-${Math.ceil(r.lockedForMs / 60_000)} דקות`;
          }}
        />
      ) : (
        <TechnicianScreen m={m} onClose={onClose} onDesktopExit={() => setExitOpen(true)} />
      )}
      {exitOpen ? <DesktopExitPad onClose={() => setExitOpen(false)} onExited={() => onClose()} /> : null}
    </div>
  );
}
