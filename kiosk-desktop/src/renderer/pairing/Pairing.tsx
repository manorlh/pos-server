/**
 * Pairing, as the Android pairing screen: the server's address and the 8-character code the
 * dashboard shows ("הוספת מכשיר"), and a name. WHAT the device is — kiosk, till, KDS, order status
 * board — is chosen there, in the cloud, with the code; never here (core/roles.ts).
 */

import { useState } from 'react';
import { kiosk } from '../bridge';

export function Pairing() {
  const [serverUrl, setServerUrl] = useState('https://');
  const [code, setCode] = useState('');
  const [name, setName] = useState('מחשב Windows');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    setError(null);
    const r = await kiosk.pair({ serverUrl: serverUrl.trim(), code: code.trim().toUpperCase(), machineName: name.trim() });
    setBusy(false);
    if (!r.ok) setError(r.error);
  };
  const field = 'w-full rounded-xl border border-neutral-300 bg-white px-4 py-3 text-lg outline-none focus:border-blue-600';
  return (
    <div dir="rtl" className="flex h-screen w-screen items-center justify-center bg-gradient-to-br from-blue-50 to-white p-6">
      <div className="w-full max-w-md space-y-4 rounded-3xl bg-white p-8 shadow-xl">
        <div className="text-center">
          <div className="text-3xl font-black tracking-tight">
            R2M <span className="font-bold text-blue-600">POS</span>
          </div>
          <h1 className="mt-2 text-xl font-extrabold">צימוד מכשיר</h1>
          <p className="text-sm text-neutral-500">הזינו את כתובת השרת ואת קוד הצימוד מהדשבורד (הוספת מכשיר).</p>
          <p className="mt-1 text-xs text-neutral-400">סוג המכשיר — קיוסק, קופה, מסך מטבח או מסך מוכן / לא מוכן — נקבע בענן עם הקוד.</p>
        </div>
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
        <button type="button" disabled={busy || code.trim().length < 6} onClick={submit} className="w-full rounded-full bg-blue-600 py-3 text-lg font-bold text-white disabled:opacity-50">
          {busy ? 'מצמד…' : 'צימוד'}
        </button>
      </div>
    </div>
  );
}
