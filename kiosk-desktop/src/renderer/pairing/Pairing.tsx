/**
 * Pairing, as the Android pairing screen: the server's address and the 8-character code the
 * dashboard shows ("הוספת מכשיר"), and a name. WHAT the device is — kiosk, till, KDS, order status
 * board — is chosen there, in the cloud, with the code; never here (core/roles.ts).
 *
 * P:/specs/foreign-records-upload.md: the last pairing's card ("המכשיר היה: קופה 3 · סניף X · נותק ב-…", §5.1) with
 * its server prefilled; a code bound to another till asks first ("המכשיר הזה היה קופה 5 — לצמד אותו כקופה 3?", §5.2);
 * and "צימוד מהענן" (§6.1) — the device's own code, big, with its QR, claimed on the dashboard (feature-detected).
 */

import { useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { lastPairingLine, PAIRING_TEXT, showDeviceCode } from '../../core/pairingMemory';
import type { PairingScreenView } from '../../shared/bridge';
import { kiosk } from '../bridge';
import { shell } from '../roles/shellBridge';
import { setPairedNotice } from './pairedNotice';

/** A server address worth asking for a device code. */
export const looksLikeServer = (u: string) => /^https?:\/\/([^/\s:]+\.[^/\s]+|localhost(:\d+)?)/i.test(u.trim());

export function Pairing() {
  const [serverUrl, setServerUrl] = useState('https://');
  const [code, setCode] = useState('');
  const [name, setName] = useState('מחשב Windows');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [askBridge, setAskBridge] = useState(false);
  const [screen, setScreen] = useState<PairingScreenView | null>(null);
  /** "המכשיר הזה היה קופה 5 — לצמד אותו כקופה 3?" */
  const [confirm, setConfirm] = useState<string | null>(null);
  const prefilled = useRef(false);
  // The last pairing's card and server; the cloud pairing's state (read again while the screen is up).
  useEffect(() => {
    if (!kiosk.pairingScreen) return;
    let alive = true;
    const read = () =>
      void kiosk.pairingScreen!({ type: 'view' })
        .then((v) => {
          if (!alive) return;
          setScreen(v);
          if (!prefilled.current && v.lastPairing?.serverUrl) {
            prefilled.current = true;
            setServerUrl(v.lastPairing.serverUrl);
          }
        })
        .catch(() => undefined);
    read();
    const t = window.setInterval(read, 2_000);
    return () => {
      alive = false;
      window.clearInterval(t);
      void kiosk.pairingScreen?.({ type: 'cloudStop' }).catch(() => undefined);
    };
  }, []);
  // "קוד מכשיר": registered on the server typed here (again when it changes).
  useEffect(() => {
    if (!kiosk.pairingScreen || !looksLikeServer(serverUrl)) return;
    const t = window.setTimeout(() => void kiosk.pairingScreen!({ type: 'cloudStart', serverUrl: serverUrl.trim() }).then(setScreen).catch(() => undefined), 800);
    return () => window.clearTimeout(t);
  }, [serverUrl]);
  const submit = async (confirmMachine = false) => {
    setBusy(true);
    setError(null);
    const r = await kiosk.pair({ serverUrl: serverUrl.trim(), code: code.trim().toUpperCase(), machineName: name.trim(), ...(confirmMachine ? { confirmMachine: true } : {}) });
    setBusy(false);
    setConfirm(null);
    if (!r.ok && r.confirm) setConfirm(r.confirm);
    else if (!r.ok) setError(r.error);
    // "המכשיר הוגדר: … · סוג רישיון: …" over the first screen of the device (this one is gone by then).
    else if (r.notice || r.warning) setPairedNotice({ text: r.notice ?? null, warning: r.warning ?? null });
  };
  const field = 'w-full rounded-xl border border-neutral-300 bg-white px-4 py-3 text-lg outline-none focus:border-blue-600';
  return (
    // Scrolls on a short window (a 14" laptop at 125%, 960×540 at the kiosk's zoom): centred by its own margins, never cut.
    <div dir="rtl" className="flex h-screen w-screen flex-col items-center overflow-y-auto bg-gradient-to-br from-blue-50 to-white p-6">
      <div className="my-auto w-full max-w-md shrink-0 space-y-4 rounded-3xl bg-white p-8 shadow-xl">
        <div className="text-center">
          <div className="text-3xl font-black tracking-tight">
            R2M <span className="font-bold text-blue-600">POS</span>
          </div>
          <h1 className="mt-2 text-xl font-extrabold">צימוד מכשיר</h1>
          <p className="text-sm text-neutral-500">הזינו את כתובת השרת ואת קוד הצימוד מהדשבורד (הוספת מכשיר).</p>
          <p className="mt-1 text-xs text-neutral-400">סוג המכשיר — קיוסק, קופה, מסך מטבח או מסך מוכן / לא מוכן — נקבע בענן עם הקוד.</p>
          <p className="mt-1 text-xs text-neutral-400">גם סוג הרישיון — קופה בלבד, קיוסק בלבד או משולב — נקבע עם הקוד, ומוצג אחרי הצימוד.</p>
        </div>
        {screen?.lastPairing ? (
          <div className="space-y-1 rounded-2xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950" data-last-pairing>
            <div className="font-bold">{lastPairingLine(screen.lastPairing)}</div>
            {screen.lastPairing.companyName ? <div className="text-xs">{screen.lastPairing.companyName}</div> : null}
            <div className="text-xs">{PAIRING_TEXT.hint}</div>
          </div>
        ) : null}
        {screen?.cloud.phase === 'waiting' && screen.cloud.code ? (
          <div className="flex items-center gap-4 rounded-2xl border border-blue-200 bg-blue-50 p-4" data-device-code>
            <div className="shrink-0 rounded-lg bg-white p-2">
              <QRCodeSVG value={screen.cloud.code} size={96} level="M" />
            </div>
            <div className="min-w-0 space-y-1">
              <div className="text-sm font-semibold">{PAIRING_TEXT.deviceCode}</div>
              <div dir="ltr" className="text-end font-mono text-4xl font-black tracking-widest">
                {showDeviceCode(screen.cloud.code)}
              </div>
              <div className="text-xs text-neutral-600">{PAIRING_TEXT.deviceCodeHint}</div>
              <div className="text-xs text-neutral-500">{PAIRING_TEXT.deviceCodeWaiting}</div>
            </div>
          </div>
        ) : screen?.cloud.phase === 'error' && screen.cloud.error ? (
          <p className="text-center text-xs text-neutral-500">{screen.cloud.error}</p>
        ) : null}
        <label className="block space-y-1">
          <span className="text-sm font-semibold">כתובת השרת</span>
          <input dir="ltr" className={field} value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="https://api.example.com" />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-semibold">קוד צימוד</span>
          <input dir="ltr" className={`${field} text-center font-mono text-2xl tracking-[0.3em]`} maxLength={8} value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="AB12CD34" />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-semibold">שם המכשיר</span>
          <input className={field} value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {error ? <p className="rounded-xl bg-red-50 p-3 text-sm font-medium text-red-700">{error}</p> : null}
        {confirm ? (
          <div className="space-y-2 rounded-xl border border-amber-400 bg-amber-50 p-3 text-sm" data-pair-confirm>
            <div className="font-bold">{confirm}</div>
            <div className="flex gap-2">
              <button type="button" className="rounded-full bg-blue-600 px-4 py-2 text-sm font-bold text-white" disabled={busy} onClick={() => void submit(true)}>
                כן, לצמד
              </button>
              <button type="button" className="rounded-full bg-neutral-100 px-4 py-2 text-sm font-bold" onClick={() => setConfirm(null)}>
                ביטול
              </button>
            </div>
          </div>
        ) : null}
        <button type="button" disabled={busy || code.trim().length < 6} onClick={() => void submit()} className="w-full rounded-full bg-blue-600 py-3 text-lg font-bold text-white disabled:opacity-50">
          {busy ? 'מצמד…' : 'צימוד'}
        </button>
        {shell.becomeBridge ? (
          <div className="border-t border-neutral-200 pt-3 text-center">
            {askBridge ? (
              <div className="space-y-2">
                <p className="text-sm text-neutral-600">
                  המחשב יריץ את הקיוסק, מסך המטבח או מסך המוכן / לא מוכן בדפדפן (Chrome / Edge), והתוכנה תהיה גשר ברקע — מסופון האשראי, המדפסת ופתיחת הדפדפן בהפעלה. בלי מסך משלה.
                </p>
                <div className="flex justify-center gap-2">
                  <button type="button" className="rounded-full bg-neutral-100 px-4 py-2 text-sm font-bold" onClick={() => setAskBridge(false)}>
                    ביטול
                  </button>
                  <button
                    type="button"
                    className="rounded-full bg-neutral-900 px-4 py-2 text-sm font-bold text-white"
                    onClick={async () => {
                      const r = await shell.becomeBridge!();
                      if (!r.ok) setError(r.message ?? 'לא ניתן');
                    }}
                  >
                    הפעלה כגשר
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" className="text-sm font-semibold text-blue-700 underline" onClick={() => setAskBridge(true)}>
                הקיוסק / המסך רץ בדפדפן? הפעלה כגשר לדפדפן
              </button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
