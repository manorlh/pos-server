'use client';

/**
 * Pairing the browser kiosk (`/k`): the 8-character code the dashboard shows ("הוספת מכשיר" →
 * קיוסק → פלטפורמה "דפדפן (Web)"), and a name. The server is the dashboard's own API — asked only
 * under "מתקדם". Opened from the dashboard's QR (`/k#pair=CODE`) the code is filled in and paired
 * at once; the fragment never reaches a server and is wiped from the address bar.
 */

import { useEffect, useRef, useState } from 'react';
import { describeBrowser, normalizePairingCode } from '@/lib/kioskWebApi';

/** `#pair=AB12CD34` (the dashboard's QR) → the code, else null. */
export function pairingCodeFromHash(hash: string): string | null {
  const m = /(?:^#|&)pair=([A-Za-z0-9-]{4,16})/.exec(hash);
  return m ? normalizePairingCode(m[1]) : null;
}

/** The words of the pairing screen (the kiosk's by default; the browser KDS / board give theirs). */
export interface PairingTexts {
  title: string;
  hint: string;
  /** The device's name before the model ("קיוסק דפדפן · SM-T220"). */
  namePrefix: string;
  after: string;
}

const KIOSK_TEXTS: PairingTexts = {
  title: 'צימוד קיוסק בדפדפן',
  hint: 'הזינו את קוד הצימוד מהדשבורד: מכשירים ← הוספת מכשיר ← קיוסק, בפלטפורמה דפדפן.',
  namePrefix: 'קיוסק דפדפן',
  after: 'אחרי הצימוד: התקינו כאפליקציה (Chrome / Edge: "התקנת האפליקציה"; iPad: שיתוף ← "הוסף למסך הבית") ונעלו את המכשיר על הקיוסק.',
};

export function WebPairing({
  defaultServer,
  onPair,
  texts = KIOSK_TEXTS,
}: {
  defaultServer: string;
  onPair: (input: { code: string; machineName: string; serverUrl: string | null }) => Promise<{ ok: true } | { ok: false; error: string }>;
  texts?: PairingTexts;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState(() => {
    const d = describeBrowser(typeof navigator === 'undefined' ? '' : navigator.userAgent);
    return `${texts.namePrefix} · ${d.model}`;
  });
  const [server, setServer] = useState(defaultServer);
  const [advanced, setAdvanced] = useState(!defaultServer);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const auto = useRef(false);

  const submit = async (value = code) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const r = await onPair({ code: value, machineName: name.trim(), serverUrl: server.trim() && server.trim() !== defaultServer ? server.trim() : null });
    setBusy(false);
    if (!r.ok) setError(r.error);
  };

  // From the dashboard's QR: the code in the fragment, paired at once.
  useEffect(() => {
    if (auto.current) return;
    auto.current = true;
    const fromHash = pairingCodeFromHash(window.location.hash);
    if (!fromHash) return;
    try {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch {
      /* the address stays */
    }
    setCode(fromHash);
    void submit(fromHash);
    // Once, on arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const field = 'w-full rounded-xl border border-neutral-300 bg-white px-4 py-3 text-lg text-neutral-900 outline-none focus:border-blue-600';
  return (
    <div dir="rtl" className="flex min-h-dvh w-full items-center justify-center bg-gradient-to-br from-blue-50 to-white p-4 text-neutral-900">
      <form
        className="w-full max-w-md space-y-4 rounded-3xl bg-white p-6 shadow-xl sm:p-8"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div className="text-center">
          <div className="text-3xl font-black tracking-tight">
            R2M <span className="font-bold text-blue-600">POS</span>
          </div>
          <h1 className="mt-2 text-xl font-extrabold">{texts.title}</h1>
          <p className="text-sm text-neutral-500">{texts.hint}</p>
        </div>
        <label className="block space-y-1">
          <span className="text-sm font-semibold">קוד צימוד</span>
          <input
            dir="ltr"
            autoFocus
            autoComplete="off"
            autoCapitalize="characters"
            spellCheck={false}
            className={`${field} text-center font-mono text-2xl tracking-[0.3em]`}
            maxLength={9}
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="AB12CD34"
          />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-semibold">שם המכשיר</span>
          <input className={field} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
        </label>
        {advanced ? (
          <label className="block space-y-1">
            <span className="text-sm font-semibold">כתובת השרת</span>
            <input dir="ltr" className={field} value={server} onChange={(e) => setServer(e.target.value)} placeholder="https://api.example.com" />
          </label>
        ) : (
          <button type="button" onClick={() => setAdvanced(true)} className="text-xs text-neutral-400 underline">
            מתקדם
          </button>
        )}
        {error ? <p className="rounded-xl bg-red-50 p-3 text-sm font-medium text-red-700">{error}</p> : null}
        <button type="submit" disabled={busy || normalizePairingCode(code).length < 6} className="w-full rounded-full bg-blue-600 py-3 text-lg font-bold text-white disabled:opacity-50">
          {busy ? 'מצמד…' : 'צימוד'}
        </button>
        <p className="text-center text-xs leading-relaxed text-neutral-400">{texts.after}</p>
      </form>
    </div>
  );
}
