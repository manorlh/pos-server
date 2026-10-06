/**
 * The technician's screen on the role screens that are not the kiosk (KDS, order status board,
 * the placeholders) — the same gesture, code and service actions as the kiosk's
 * (staff/StaffLayer.tsx): six taps in the top-left corner within 3 s → the technician code (1995
 * unless the cloud set one) → what this device is (read-only: the cloud decides the role),
 * network, version and updates ("בדוק עכשיו" / "התקן עכשיו"), remote support, zoom, unpair.
 */

import { useEffect, useRef, useState } from 'react';
import { inTechnicianZone, TapSequence } from '../../core/technician';
import { ROLE_INFO } from '../../core/roles';
import type { TechnicianInfo } from '../../shared/bridge';
import type { ShellView } from '../../shared/roles';
import { kiosk } from '../bridge';
import { updateLine } from './updateText';

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

export function RoleTechnician({ shellView, onClose }: { shellView: ShellView; onClose: () => void }) {
  const [unlocked, setUnlocked] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<TechnicianInfo | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => void kiosk.technicianInfo().then(setInfo).catch(() => undefined);
  useEffect(() => {
    if (unlocked) refresh();
  }, [unlocked]);
  // Closes by itself when left open.
  useEffect(() => {
    const t = setTimeout(onClose, 5 * 60_000);
    return () => clearTimeout(t);
  }, [onClose, unlocked, note]);
  const act = async (a: Parameters<typeof kiosk.technicianAction>[0]) => {
    setBusy(true);
    const r = await kiosk.technicianAction(a).catch(() => ({ ok: false, message: 'שגיאה' }));
    setBusy(false);
    setNote(r.message ?? (r.ok ? 'בוצע' : 'נכשל'));
    refresh();
  };
  const btn = 'rounded-xl bg-neutral-900 px-4 py-2 text-sm font-bold text-white disabled:opacity-40';
  const panel = 'space-y-1 rounded-2xl bg-white p-4 text-sm shadow';
  return (
    <div dir="rtl" className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4" onPointerDown={(e) => e.stopPropagation()}>
      <div className="max-h-full w-full max-w-lg space-y-3 overflow-y-auto rounded-3xl bg-neutral-100 p-5 text-neutral-900">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-extrabold">בדיקות ומידע — טכנאי</h2>
          <button type="button" className="rounded-full bg-neutral-200 px-3 py-1 text-sm font-bold" onClick={onClose}>
            סגירה
          </button>
        </div>
        {!unlocked ? (
          <div className="space-y-3">
            <input
              autoFocus
              type="password"
              inputMode="numeric"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 12))}
              className="w-full rounded-xl border px-4 py-3 text-center font-mono text-2xl tracking-[0.4em]"
              placeholder="קוד טכנאי"
            />
            {error ? <p className="text-sm font-semibold text-red-700">{error}</p> : null}
            <button
              type="button"
              className={btn}
              disabled={code.length < 4}
              onClick={async () => {
                const r = await kiosk.technicianUnlock(code);
                setCode('');
                if (r.outcome === 'granted') setUnlocked(true);
                else setError(r.outcome === 'wrong' ? `קוד שגוי — נותרו ${r.triesLeft} ניסיונות` : `נעול ל-${Math.ceil(r.lockedForMs / 60_000)} דקות`);
              }}
            >
              כניסה
            </button>
          </div>
        ) : (
          <>
            {note ? <div className="rounded-xl bg-white p-2 text-center text-sm font-semibold">{note}</div> : null}
            <div className={panel}>
              <div className="font-bold">שיוך</div>
              <div>
                תפקיד: <b>{shellView.role ? ROLE_INFO[shellView.role].label : 'לא ידוע עדיין'}</b> (נקבע בענן, בהוספת המכשיר)
              </div>
              <div>{shellView.fiscal ? 'מכשיר קופתי' : 'מסך — לא קופה: בלי מכירות, משמרות, Z או תשלומים'}</div>
              <div>
                {info?.machine?.name ?? shellView.machineName ?? '—'} · {info?.shopName ?? shellView.shopName ?? '—'}
              </div>
              <div dir="ltr" className="text-end text-xs text-neutral-500">
                {info?.machine?.machineId}
              </div>
            </div>
            <div className={panel}>
              <div className="font-bold">רשת</div>
              <div>{shellView.online ? 'מחובר לענן' : 'אין חיבור לענן'}</div>
              <div dir="ltr" className="text-end text-xs text-neutral-500">
                {info?.network.serverUrl}
              </div>
              {info?.network.interfaces.map((i) => (
                <div key={i.name + i.address} dir="ltr" className="text-end text-xs">
                  {i.name}: {i.address}
                </div>
              ))}
            </div>
            <div className={panel}>
              <div className="font-bold">גרסה ועדכונים</div>
              <div>
                גרסה {shellView.update.current} · {updateLine(shellView.update)}
              </div>
              <div className="text-xs text-neutral-500">
                {shellView.update.autoInstall
                  ? shellView.update.installWindow
                    ? `התקנה אוטומטית בחלון ${shellView.update.installWindow.start}–${shellView.update.installWindow.end}`
                    : 'התקנה אוטומטית כשהמכשיר פנוי'
                  : 'התקנה ידנית בלבד'}
              </div>
              <div className="flex gap-2 pt-1">
                <button type="button" className={btn} disabled={busy} onClick={() => act({ type: 'updateCheck' })}>
                  בדוק עכשיו
                </button>
                <button type="button" className={btn} disabled={busy} onClick={() => act({ type: 'updateInstall' })}>
                  התקן עכשיו
                </button>
              </div>
            </div>
            <div className={panel}>
              <div className="font-bold">תמיכה ותצוגה</div>
              <div className="flex flex-wrap gap-2">
                <button type="button" className={btn} onClick={() => act({ type: 'quickSupport' })}>
                  TeamViewer QuickSupport
                </button>
                {[1, 1.5, 2].map((z) => (
                  <button key={z} type="button" className={btn} onClick={() => act({ type: 'setZoom', zoom: z })}>
                    ×{z}
                  </button>
                ))}
              </div>
            </div>
            <button type="button" className="w-full rounded-xl bg-red-600 py-2 text-sm font-bold text-white" onClick={() => act({ type: 'unpair' })}>
              ניתוק המכשיר מהענן
            </button>
          </>
        )}
      </div>
    </div>
  );
}
