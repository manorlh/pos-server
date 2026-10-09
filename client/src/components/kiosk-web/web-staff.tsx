'use client';

/**
 * "ניהול הקיוסק" on the browser kiosk — the staff's screen, opened as on the Windows / Android kiosk:
 * six taps within ~3 s in the physical top-left corner (an L along the edges), or a 2 s press in
 * the top-right corner, then the technician code (1995 unless the cloud's parameter
 * `technicianCode` says otherwise — a PBKDF2 hash salted with the machine id, checked here with
 * WebCrypto); five wrong codes lock the pad for five minutes; never during a payment.
 *
 * What a browser kiosk has to show and do: the machine and the shop, the link to the cloud, the
 * orders it sent today (number, sum, delivered or waiting), install as an app, full screen,
 * "סנכרון עכשיו", reload, and "ניתוק" (this browser forgets the kiosk).
 */

import { useEffect, useState } from 'react';
import { Download, Expand, LogOut, RefreshCw, RotateCw, X } from 'lucide-react';
import type { PreviewModel } from '@/kiosk-shared';
import { formatTime } from '@/lib/format';
import type { PaymentMethod } from '@/lib/kioskConfig';
import type { WebKioskService, WebKioskView } from '@/lib/kioskWebService';
import { orderDue, orderNeedsUpload } from '@/lib/kioskWebOrders';
import { isStandalone, useInstallPrompt } from './web-shell';
import { WebBridgeSection } from './web-bridge';
import { formatMoney } from './web-i18n';

export const TAPS = 6;
export const WINDOW_MS = 3_000;
export const DEFAULT_CODE = '1995';
const MAX_FAILURES = 5;
const LOCKOUT_MS = 5 * 60_000;
/** "אמצעי תשלום כאן": what this browser takes (split_card never — one card per document here). */
const USABLE_LABEL: Record<PaymentMethod, string> = { cash_at_till: 'מזומן בקופה', card: 'אשראי (גשר)', voucher: 'שובר', split_card: 'פיצול בין כרטיסים' };
const SCHEME = 'pbkdf2-sha256';
const SALT_PREFIX = 'r2m-kiosk-technician:';

/** The zone (CSS px from the physical top-left corner): an L along the edges, where no screen draws. */
export function inTechnicianZone(x: number, y: number): boolean {
  return x >= 0 && y >= 0 && ((x < 20 && y < 72) || (y < 12 && x < 72));
}

export class TapSequence {
  private times: number[] = [];

  tap(nowMs: number): boolean {
    this.times.push(nowMs);
    while (this.times.length > 0 && nowMs - this.times[0] > WINDOW_MS) this.times.shift();
    if (this.times.length >= TAPS) {
      this.times = [];
      return true;
    }
    return false;
  }
}

async function pbkdf2Hex(code: string, salt: string, iterations: number): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(code), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations }, key, 256);
  return Array.from(new Uint8Array(bits), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Whether `entered` is the code (the cloud's hash, or the default) — the kiosks' codeMatches. */
export async function technicianCodeMatches(entered: string, stored: string | null, machineId: string): Promise<boolean> {
  const digits = entered.trim();
  if (!/^[0-9]{4,8}$/.test(digits)) return false;
  const held = stored?.trim() || null;
  if (!held) return digits === DEFAULT_CODE;
  const parts = held.split('$');
  if (parts.length !== 3 || parts[0] !== SCHEME) return held === digits;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 1_000 || iterations > 1_000_000 || !crypto?.subtle) return false;
  try {
    const hex = await pbkdf2Hex(digits, SALT_PREFIX + machineId.trim().toLowerCase(), iterations);
    return hex === parts[2];
  } catch {
    return false;
  }
}

export function WebStaff({ m, view, svc, onClose }: { m: PreviewModel; view: WebKioskView; svc: WebKioskService; onClose: () => void }) {
  const [unlocked, setUnlocked] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [failures, setFailures] = useState(0);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [askUnpair, setAskUnpair] = useState(false);
  const [busy, setBusy] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const install = useInstallPrompt();

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);
  // Left open, it closes by itself (5 minutes).
  useEffect(() => {
    const id = window.setTimeout(onClose, 5 * 60_000);
    return () => window.clearTimeout(id);
  }, [onClose]);

  const check = async () => {
    if (nowMs < lockedUntil) return;
    const ok = await technicianCodeMatches(code, view.technicianCode, view.machine?.machineId ?? '');
    if (ok) {
      setUnlocked(true);
      setError(null);
      setFailures(0);
      return;
    }
    const f = failures + 1;
    setFailures(f);
    setCode('');
    if (f >= MAX_FAILURES) {
      setLockedUntil(Date.now() + LOCKOUT_MS);
      setFailures(0);
      setError('יותר מדי ניסיונות. נסו שוב בעוד 5 דקות.');
    } else setError(`קוד שגוי (נותרו ${MAX_FAILURES - f} ניסיונות)`);
  };

  const card = { background: m.c.surface, color: m.c.text, borderRadius: 18, border: `1px solid ${m.c.border}` };
  const btn = 'flex items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-sm font-bold active:scale-[0.98]';
  const soft = { background: `${m.c.button}14`, color: m.c.button };
  const fmtTime = (ms: number | null) => (ms ? formatTime(ms, { seconds: true }) : '—');
  const orders = svc.todaysOrders();

  return (
    <div dir="rtl" className="absolute inset-0 z-[80] flex items-center justify-center bg-black/60 p-4" onPointerDown={(e) => e.stopPropagation()}>
      <div className="flex max-h-full w-full max-w-[560px] flex-col overflow-hidden shadow-2xl" style={card}>
        <div className="flex items-center justify-between gap-2 border-b px-4 py-3" style={{ borderColor: m.c.border }}>
          <span className="text-lg font-extrabold">ניהול הקיוסק</span>
          <button type="button" aria-label="סגירה" onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-full" style={soft}>
            <X className="h-5 w-5" />
          </button>
        </div>
        {!unlocked ? (
          <div className="space-y-3 p-5 text-center">
            <p className="text-sm" style={{ color: m.c.mutedText }}>
              קוד טכנאי
            </p>
            <input
              autoFocus
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={8}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void check();
              }}
              className="mx-auto block w-48 rounded-xl border px-3 py-3 text-center font-mono text-2xl tracking-[0.4em] outline-none"
              style={{ borderColor: m.c.border, background: m.c.background, color: m.c.text }}
              disabled={nowMs < lockedUntil}
            />
            {error ? <p className="text-sm font-semibold text-red-600">{error}</p> : null}
            <button type="button" onClick={() => void check()} disabled={code.length < 4 || nowMs < lockedUntil} className={`${btn} mx-auto w-48 disabled:opacity-50`} style={{ background: m.c.button, color: m.c.buttonText }}>
              כניסה
            </button>
          </div>
        ) : (
          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4 text-sm">
            <section className="space-y-1">
              <div className="font-bold">{view.machine?.name ?? 'קיוסק'}</div>
              <div style={{ color: m.c.mutedText }}>
                {[view.machine?.companyName, view.machine?.shopName].filter(Boolean).join(' · ') || '—'}
              </div>
              <div className="text-xs" style={{ color: m.c.mutedText }} dir="ltr">
                {view.machine?.serverUrl} · {view.machine?.machineId.slice(0, 8)} · web {view.appVersion}
              </div>
            </section>
            <section className="grid grid-cols-2 gap-2 rounded-xl p-3" style={{ background: `${m.c.primary}0D` }}>
              <span>חיבור לענן</span>
              <span className="font-semibold">{view.state.offline ? `אין חיבור (מ-${fmtTime(view.state.offlineSince)})` : 'מחובר'}</span>
              <span>סנכרון אחרון</span>
              <span className="font-semibold">{fmtTime(view.staff.lastSyncOkAt)}</span>
              <span>הזמנות שממתינות לענן</span>
              <span className="font-semibold">{view.staff.pendingOrders}</span>
              <span>אמצעי תשלום כאן</span>
              <span className="font-semibold">{view.pay.usable.length > 0 ? view.pay.usable.map((x) => USABLE_LABEL[x]).join(' · ') : 'אין — הפעילו "מזומן בקופה" או גשר ל-Windows'}</span>
              <span>אחסון</span>
              <span className="font-semibold" dir="ltr">
                {view.staff.storage}
              </span>
              <span>מותקן כאפליקציה</span>
              <span className="font-semibold">{isStandalone() ? 'כן' : 'לא (בדפדפן)'}</span>
            </section>
            {view.state.noPayment ? (
              <p className="rounded-xl p-3 font-semibold" style={{ background: '#FEF3C7', color: '#92400E' }}>
                קיוסק בדפדפן גובה אשראי רק דרך גשר ל-Windows במחשב. כדי למכור, צמדו גשר, או הפעילו בדשבורד ← קיוסקים ← תשלום את &quot;מזומן בקופה&quot; (ואם תרצו גם &quot;שובר&quot;).
              </p>
            ) : null}
            <WebBridgeSection m={m} view={view} svc={svc} />
            {view.staff.lastError ? (
              <p className="text-xs" style={{ color: m.c.mutedText }} dir="ltr">
                {view.staff.lastError}
              </p>
            ) : null}
            <section className="space-y-1">
              <div className="font-bold">הזמנות היום ({orders.length})</div>
              {orders.length === 0 ? <div style={{ color: m.c.mutedText }}>אין עדיין</div> : null}
              {orders.slice(0, 30).map((o) => (
                <div key={o.localId} className="flex items-center justify-between gap-2 border-b py-1.5" style={{ borderColor: m.c.border }}>
                  <span className="font-bold tabular-nums" dir="ltr">
                    {o.pickupLabel}
                  </span>
                  <span className="tabular-nums">{formatMoney(orderDue(o) / 100)}</span>
                  <span className="text-xs" style={{ color: o.rejected ? '#B91C1C' : orderNeedsUpload(o) ? '#92400E' : m.c.mutedText }}>
                    {o.rejected ? `נדחתה (${o.rejected})` : orderNeedsUpload(o) ? 'ממתינה לסנכרון' : 'בקופות'}
                  </span>
                  <span className="text-xs tabular-nums" style={{ color: m.c.mutedText }}>
                    {formatTime(o.createdAtMs)}
                  </span>
                </div>
              ))}
            </section>
            <section className="grid grid-cols-2 gap-2">
              <button
                type="button"
                className={btn}
                style={soft}
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  await svc.syncNow().catch(() => undefined);
                  setBusy(false);
                }}
              >
                <RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} /> סנכרון עכשיו
              </button>
              <button type="button" className={btn} style={soft} onClick={() => window.location.reload()}>
                <RotateCw className="h-4 w-4" /> טעינה מחדש
              </button>
              <button
                type="button"
                className={btn}
                style={soft}
                onClick={() => {
                  void document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => undefined);
                }}
              >
                <Expand className="h-4 w-4" /> מסך מלא
              </button>
              <button type="button" className={`${btn} disabled:opacity-50`} style={soft} disabled={!install.canInstall} onClick={() => void install.install()}>
                <Download className="h-4 w-4" /> התקנה כאפליקציה
              </button>
            </section>
            {!install.canInstall && !isStandalone() ? (
              <p className="text-xs" style={{ color: m.c.mutedText }}>
                iPad / iPhone: שיתוף ← &quot;הוסף למסך הבית&quot;. Chrome / Edge: תפריט ← &quot;התקנת האפליקציה&quot;.
              </p>
            ) : null}
            {askUnpair ? (
              <div className="space-y-2 rounded-xl p-3" style={{ background: '#FEE2E2', color: '#7F1D1D' }}>
                <p className="font-semibold">
                  לנתק את הדפדפן הזה מהקיוסק? {view.staff.pendingOrders > 0 ? `יש ${view.staff.pendingOrders} הזמנות שעוד לא הגיעו לענן — הן יאבדו.` : ''} לחיבור מחדש צריך קוד צימוד חדש מהדשבורד.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <button type="button" className={btn} style={soft} onClick={() => setAskUnpair(false)}>
                    ביטול
                  </button>
                  <button
                    type="button"
                    className={btn}
                    style={{ background: '#B91C1C', color: '#fff' }}
                    onClick={async () => {
                      await svc.unpair();
                      onClose();
                    }}
                  >
                    ניתוק
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className={`${btn} w-full`} style={{ background: '#FEE2E2', color: '#B91C1C' }} onClick={() => setAskUnpair(true)}>
                <LogOut className="h-4 w-4" /> ניתוק המכשיר
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
