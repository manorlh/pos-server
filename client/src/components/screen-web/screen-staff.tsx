'use client';

/**
 * The staff sheet of the browser KDS / board (`/kds`, `/board`): opened as on the kiosk — six taps
 * within ~3 s in the physical top-left corner — then the technician code (1995 unless the cloud's
 * parameter `technicianCode` says otherwise; components/kiosk-web/web-staff.tsx checks it). A board
 * faces customers, so nothing here opens without the code.
 *
 * What it shows and does: the screen and the shop, the link to the cloud, the actions waiting to be
 * sent, where the screen keeps its data, the version; install as an app, full screen, reload,
 * "ניתוק" (this browser forgets the screen; the cloud keeps the machine); and the Windows bridge on
 * this PC, when there is one (screen-bridge.tsx — pairing, printer, kiosk mode).
 */

import { useEffect, useState } from 'react';
import { Download, Expand, LogOut, RotateCw, X } from 'lucide-react';
import type { BridgeAgent } from '@/lib/kioskBridge';
import type { ScreenWebService, ScreenWebView } from '@/lib/screenWebService';
import { technicianCodeMatches } from '@/components/kiosk-web/web-staff';
import { isStandalone, useInstallPrompt } from '@/components/kiosk-web/web-shell';
import { ScreenBridgeSection } from './screen-bridge';

const MAX_FAILURES = 5;
const LOCKOUT_MS = 5 * 60_000;
const ROLE_TEXT: Record<string, string> = { kds: 'מסך מטבח (KDS)', order_status_board: 'מסך מוכן / לא מוכן' };

function timeText(ms: number | null): string {
  return ms ? new Date(ms).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—';
}

export function ScreenStaff({ view, svc, bridge = null, onClose }: { view: ScreenWebView; svc: ScreenWebService; bridge?: BridgeAgent | null; onClose: () => void }) {
  const [unlocked, setUnlocked] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [failures, setFailures] = useState(0);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [askUnpair, setAskUnpair] = useState(false);
  const install = useInstallPrompt();

  // Closes by itself when left open.
  useEffect(() => {
    const t = setTimeout(onClose, 3 * 60_000);
    return () => clearTimeout(t);
  }, [onClose, unlocked, askUnpair]);

  const check = async () => {
    const now = Date.now();
    if (now < lockedUntil) {
      setError('יותר מדי ניסיונות — נסו שוב בעוד כמה דקות');
      return;
    }
    const ok = await technicianCodeMatches(code, view.technicianCode, view.machine?.machineId ?? '');
    if (ok) {
      setUnlocked(true);
      setError(null);
      return;
    }
    const n = failures + 1;
    setFailures(n);
    setCode('');
    if (n >= MAX_FAILURES) {
      setLockedUntil(now + LOCKOUT_MS);
      setFailures(0);
      setError('יותר מדי ניסיונות — הלוח ננעל לחמש דקות');
    } else setError('קוד שגוי');
  };

  const btn = 'inline-flex items-center gap-2 rounded-xl bg-neutral-900 px-4 py-2.5 text-sm font-bold text-white active:scale-[0.97] disabled:opacity-40';
  const row = 'flex justify-between gap-3 border-b border-neutral-100 py-1.5 text-sm last:border-0';
  return (
    <div dir="rtl" className="fixed inset-0 z-[95] flex items-center justify-center bg-black/60 p-4" onPointerDown={(e) => e.stopPropagation()}>
      <div className="max-h-full w-full max-w-md space-y-3 overflow-y-auto rounded-3xl bg-neutral-100 p-5 text-neutral-900 shadow-2xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-extrabold">ניהול המסך</h2>
          <button type="button" aria-label="סגירה" className="rounded-full bg-neutral-200 p-2" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        {!unlocked ? (
          <form
            className="space-y-3 rounded-2xl bg-white p-4"
            onSubmit={(e) => {
              e.preventDefault();
              void check();
            }}
          >
            <label className="block space-y-1">
              <span className="text-sm font-semibold">קוד טכנאי</span>
              <input
                dir="ltr"
                autoFocus
                inputMode="numeric"
                type="password"
                autoComplete="off"
                maxLength={8}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                className="w-full rounded-xl border border-neutral-300 px-4 py-3 text-center font-mono text-2xl tracking-[0.4em] outline-none focus:border-blue-600"
              />
            </label>
            {error ? <p className="rounded-xl bg-red-50 p-2 text-sm font-medium text-red-700">{error}</p> : null}
            <button type="submit" className={`${btn} w-full justify-center`} disabled={code.length < 4}>
              כניסה
            </button>
          </form>
        ) : (
          <>
            <div className="rounded-2xl bg-white p-4">
              <div className={row}>
                <span className="text-neutral-500">מסך</span>
                <b>{view.machine?.name ?? '—'}</b>
              </div>
              <div className={row}>
                <span className="text-neutral-500">סניף</span>
                <b>{view.machine?.shopName ?? '—'}</b>
              </div>
              <div className={row}>
                <span className="text-neutral-500">תפקיד</span>
                <b>{ROLE_TEXT[view.machine?.deviceRole ?? ''] ?? (view.shows === 'board' ? ROLE_TEXT.order_status_board : ROLE_TEXT.kds)}</b>
              </div>
              <div className={row}>
                <span className="text-neutral-500">חיבור לענן</span>
                <b className={view.online ? 'text-emerald-700' : 'text-red-700'}>{view.online ? 'מחובר' : 'אין חיבור'}</b>
              </div>
              <div className={row}>
                <span className="text-neutral-500">דיווח אחרון לענן</span>
                <b className="tabular-nums">{timeText(view.lastBeatOkAt)}</b>
              </div>
              <div className={row}>
                <span className="text-neutral-500">פעולות שממתינות לשליחה</span>
                <b className="tabular-nums">{view.pendingActions}</b>
              </div>
              <div className={row}>
                <span className="text-neutral-500">אחסון</span>
                <b dir="ltr">{view.storage}</b>
              </div>
              <div className={row}>
                <span className="text-neutral-500">גרסה</span>
                <b dir="ltr">{view.appVersion}</b>
              </div>
              <div className={row}>
                <span className="text-neutral-500">שרת</span>
                <b dir="ltr" className="truncate">
                  {view.machine?.serverUrl ?? '—'}
                </b>
              </div>
            </div>
            {bridge ? <ScreenBridgeSection agent={bridge} route={view.route} technicianCode={code} /> : null}
            <div className="flex flex-wrap gap-2">
              {install.canInstall && !isStandalone() ? (
                <button type="button" className={btn} onClick={() => void install.install()}>
                  <Download size={16} /> התקנה כאפליקציה
                </button>
              ) : null}
              <button
                type="button"
                className={btn}
                onClick={() => {
                  try {
                    void document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => undefined);
                  } catch {
                    /* not offered */
                  }
                }}
              >
                <Expand size={16} /> מסך מלא
              </button>
              <button type="button" className={btn} onClick={() => window.location.reload()}>
                <RotateCw size={16} /> טעינה מחדש
              </button>
            </div>
            {askUnpair ? (
              <div className="space-y-2 rounded-2xl bg-red-50 p-3">
                <p className="text-sm font-semibold text-red-800">
                  {view.pendingActions > 0 ? `${view.pendingActions} פעולות עוד לא נשלחו לענן ויימחקו. ` : ''}הדפדפן ישכח את המסך; המכשיר נשאר בענן, וצימוד מחדש — בקוד חדש מהדשבורד.
                </p>
                <div className="flex gap-2">
                  <button type="button" className="rounded-xl bg-neutral-200 px-4 py-2 text-sm font-bold" onClick={() => setAskUnpair(false)}>
                    ביטול
                  </button>
                  <button type="button" className="rounded-xl bg-red-600 px-4 py-2 text-sm font-bold text-white" onClick={() => void svc.unpair().then(onClose)}>
                    ניתוק
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="inline-flex items-center gap-2 text-sm font-bold text-red-700" onClick={() => setAskUnpair(true)}>
                <LogOut size={16} /> ניתוק המסך מהדפדפן
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
