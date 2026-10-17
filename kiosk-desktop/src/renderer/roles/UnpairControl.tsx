/**
 * "ניתוק המכשיר מהענן" on both technician screens (staff/StaffLayer.tsx, roles/RoleTechnician.tsx): the button, and
 * right under it — where the technician is looking — why it was refused, what waits for the cloud, and, where
 * core/unpairGuard.ts allows it, "ניתוק בכל זאת": the technician's code again, a confirmation, and a second explicit
 * one when money records wait. Everything pending is backed up by the service before the pairing is forgotten.
 */

import { useState } from 'react';
import { FOREIGN_TEXT, UNPAIR_TEXT, type UnpairCheck } from '../../core/unpairGuard';
import type { TechnicianActionResult, TechnicianInfo } from '../../shared/bridge';
import { kiosk } from '../bridge';

export function UnpairControl({ label, buttonClassName, buttonStyle, onDone }: { label: string; buttonClassName: string; buttonStyle?: React.CSSProperties; onDone?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [check, setCheck] = useState<UnpairCheck | null>(null);
  const [forcing, setForcing] = useState(false);
  const [code, setCode] = useState('');
  const [confirm, setConfirm] = useState(false);
  const [confirmMoney, setConfirmMoney] = useState(false);

  const run = async (a: Parameters<typeof kiosk.technicianAction>[0]) => {
    setBusy(true);
    const r: TechnicianActionResult = await kiosk.technicianAction(a).catch((e: unknown) => ({ ok: false, message: `שגיאה: ${String(e)}` }));
    setBusy(false);
    setResult({ ok: r.ok, message: r.message ?? (r.ok ? 'בוצע' : 'הניתוק נכשל') });
    if (r.unpair) setCheck(r.unpair);
    if (r.ok) {
      setCheck(null);
      setForcing(false);
      onDone?.();
    }
    setCode('');
  };

  const start = () => {
    setForcing(false);
    setConfirm(false);
    setConfirmMoney(false);
    void run({ type: 'unpair' });
  };
  const force = () => void run({ type: 'unpair', force: true, code, confirm, confirmMoney });
  const small = 'rounded-lg px-3 py-1.5 text-xs font-bold disabled:opacity-40';

  return (
    <div className="space-y-2">
      <button type="button" disabled={busy} className={buttonClassName} style={buttonStyle} onClick={start}>
        {busy ? '…' : label}
      </button>
      {result ? (
        <div
          role={result.ok ? 'status' : 'alert'}
          className={`whitespace-pre-wrap break-words rounded-lg p-2 text-start text-xs font-semibold ${result.ok ? 'bg-emerald-50 text-emerald-900' : 'bg-red-50 text-red-900'}`}
        >
          {result.message}
        </div>
      ) : null}
      {check?.canForce && !forcing ? (
        <div className="space-y-1">
          <div className="text-xs text-neutral-600">{UNPAIR_TEXT.forceHint}</div>
          <button type="button" className={`${small} bg-red-100 text-red-800`} disabled={busy} onClick={() => setForcing(true)}>
            {UNPAIR_TEXT.force}…
          </button>
        </div>
      ) : null}
      {check?.canForce && forcing ? (
        <div className="space-y-2 rounded-lg border border-red-300 bg-white p-3 text-xs text-neutral-900">
          <div className="font-bold">{UNPAIR_TEXT.force}</div>
          <div>{UNPAIR_TEXT.forceHint}</div>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 12))}
            className="w-full rounded-lg border px-3 py-2 text-center font-mono text-base tracking-[0.3em]"
            placeholder="קוד טכנאי"
          />
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} className="mt-0.5" />
            <span>מאשר/ת לנתק את המכשיר מהענן למרות שיש נתונים שלא נשלחו ({check.money + check.events})</span>
          </label>
          {check.needsMoneyConfirm ? (
            <label className="flex items-start gap-2 rounded-md bg-red-50 p-2 font-semibold text-red-900">
              <input type="checkbox" checked={confirmMoney} onChange={(e) => setConfirmMoney(e.target.checked)} className="mt-0.5" />
              <span>{UNPAIR_TEXT.moneyWarn(check.money)} אני מאשר/ת שוב.</span>
            </label>
          ) : null}
          <div className="flex gap-2">
            <button
              type="button"
              className={`${small} bg-red-600 text-white`}
              disabled={busy || code.length < 4 || !confirm || (check.needsMoneyConfirm && !confirmMoney)}
              onClick={force}
            >
              {busy ? '…' : 'גיבוי וניתוק'}
            </button>
            <button type="button" className={`${small} bg-neutral-200 text-neutral-900`} disabled={busy} onClick={() => setForcing(false)}>
              ביטול
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/**
 * "רשומות מהמכשיר הקודם (N) — לא נשלחו, נשמרו בגיבוי" (TechnicianInfo.foreignRows): rows of another pairing, held —
 * never sent under this one; "ייצוא לקובץ" writes them (with their records and a copy of the database) to unpair-backups.
 */
export function ForeignRowsPanel({ rows, className, onDone }: { rows: NonNullable<TechnicianInfo['foreignRows']>; className?: string; onDone?: () => void }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const exportNow = async () => {
    setBusy(true);
    const r: TechnicianActionResult = await kiosk.technicianAction({ type: 'exportForeign' }).catch((e: unknown) => ({ ok: false, message: `שגיאה: ${String(e)}` }));
    setBusy(false);
    setResult({ ok: r.ok, message: r.message ?? (r.ok ? 'בוצע' : 'הייצוא נכשל') });
    onDone?.();
  };
  return (
    <div className={className ?? 'space-y-1 rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950'} data-foreign-rows>
      <div className="font-bold">{rows.title}</div>
      {rows.lines.map((l) => (
        <div key={l}>{l}</div>
      ))}
      <div className="text-amber-800">{FOREIGN_TEXT.hint}</div>
      <button type="button" disabled={busy} className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-bold text-white disabled:opacity-40" onClick={() => void exportNow()}>
        {busy ? '…' : FOREIGN_TEXT.export}
      </button>
      {result ? <div className={`whitespace-pre-wrap break-words font-semibold ${result.ok ? 'text-emerald-800' : 'text-red-800'}`}>{result.message}</div> : null}
    </div>
  );
}
