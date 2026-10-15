/**
 * "שרת מזומן" — the cash host's own screen (when a screen is attached to the box at all): every
 * cash station's state, its change per denomination, its alerts and journal, and the staff's local
 * maintenance (P:/specs/cash-paylink.md §5 "מסך צוות"): float, refill (by hand or through the
 * acceptor), count, empty the cashbox, dump a recycler, deliver bills held after a power cut —
 * behind a manager's code. A station run by the simulator also gets the customer's buttons.
 */

import { useEffect, useState } from 'react';
import type { CashHostView, CashStaffAction, CashStationStaffView } from '../../../shared/cash';
import type { ShellView } from '../../../shared/roles';
import { DesktopExitButton, DesktopExitPad } from '../../desktop/DesktopExit';
import { RoleTechnician, useTechnicianCorner } from '../RoleTechnician';
import { shell } from '../shellBridge';
import { updateLine } from '../updateText';

const nis = (agorot: number) => {
  const v = agorot / 100;
  return `${Number.isInteger(v) ? v : v.toFixed(2)} ₪`;
};

const STATE_TEXT: Record<string, { text: string; tone: string }> = {
  ready: { text: 'פנויה', tone: 'bg-emerald-100 text-emerald-800' },
  busy: { text: 'בשימוש', tone: 'bg-blue-100 text-blue-800' },
  maintenance: { text: 'בתחזוקה', tone: 'bg-amber-100 text-amber-800' },
  fault: { text: 'תקלה', tone: 'bg-red-100 text-red-800' },
  starting: { text: 'עולה…', tone: 'bg-neutral-200 text-neutral-700' },
};

const TX_TEXT: Record<string, string> = {
  LEASED: 'נפתחה',
  ACCEPTING: 'מקבל כסף',
  SETTLING: 'מסיים',
  PAYING_CHANGE: 'מחזיר עודף',
  REFUNDING: 'מחזיר כסף',
  DONE: 'הסתיימה',
  HELD: 'זיכוי מוחזק',
};

export function CashHostScreen({ shellView }: { shellView: ShellView }) {
  const [view, setView] = useState<CashHostView | null>(null);
  const [tech, setTech, onCorner] = useTechnicianCorner();
  const [exitOpen, setExitOpen] = useState(false);
  const [pinOpen, setPinOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void shell.cash?.().then((v) => alive && v && setView(v));
    const off = shell.on('cash', setView);
    return () => {
      alive = false;
      off();
    };
  }, []);
  const act = async (a: CashStaffAction) => {
    if (!shell.cashAction) return;
    const r = await shell.cashAction(a);
    setMessage(r.message);
    if (!r.ok && r.message === 'נדרש קוד מנהל') setPinOpen(true);
  };
  return (
    <div dir="rtl" className="relative flex h-screen w-screen flex-col overflow-auto bg-neutral-100 p-4 text-neutral-900" onPointerDown={onCorner}>
      <header className="mb-3 flex flex-wrap items-center gap-3">
        <div className="text-2xl font-black">
          R2M <span className="text-blue-600">שרת מזומן</span>
        </div>
        <span className="text-sm text-neutral-500">
          {shellView.machineName ?? ''} {shellView.shopName ? `· ${shellView.shopName}` : ''}
        </span>
        <span className="text-sm text-neutral-500">{view?.lanAddress ? `${view.lanAddress}:${view.port}` : 'אין כתובת ברשת'}</span>
        <span className={`rounded px-2 py-0.5 text-xs font-bold ${view?.cloudOnline ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>
          {view?.cloudOnline ? 'מחובר לענן' : 'אין ענן — עובד ברשת המקומית'}
        </span>
        {view && view.pendingUploads > 0 ? <span className="text-xs text-neutral-500">ממתינים לענן: {view.pendingUploads}</span> : null}
        <span className="flex-1" />
        {view?.unlocked ? (
          <span className="text-sm font-bold text-emerald-700">צוות: {view.staffName}</span>
        ) : (
          <button type="button" className="rounded-lg bg-neutral-900 px-3 py-1.5 text-sm font-bold text-white" onClick={() => setPinOpen(true)}>
            כניסת צוות
          </button>
        )}
      </header>
      {message ? (
        <div className="mb-3 rounded-lg bg-white px-3 py-2 text-sm shadow" onClick={() => setMessage(null)}>
          {message}
        </div>
      ) : null}
      {!view || view.stations.length === 0 ? (
        <div className="m-auto max-w-md text-center text-neutral-600">
          <h1 className="mb-2 text-xl font-extrabold">אין עמדות מזומן</h1>
          <p>מגדירים עמדות בדשבורד ("עמדות מזומן"): מספר סידורי של PayLink, השרת הזה, והקיוסקים שמשויכים לכל עמדה.</p>
        </div>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {view.stations.map((s) => (
            <StationCard key={s.stationId} s={s} unlocked={view.unlocked} act={act} />
          ))}
        </div>
      )}
      <footer className="mt-4 text-xs text-neutral-400">
        גרסה {shellView.appVersion} · {updateLine(shellView.update)}
      </footer>
      {pinOpen ? <PinPad onClose={() => setPinOpen(false)} /> : null}
      {tech ? <RoleTechnician shellView={shellView} onClose={() => setTech(false)} /> : null}
      {!tech && !exitOpen ? <DesktopExitButton onOpen={() => setExitOpen(true)} /> : null}
      {exitOpen ? <DesktopExitPad onClose={() => setExitOpen(false)} /> : null}
    </div>
  );
}

function StationCard({ s, unlocked, act }: { s: CashStationStaffView; unlocked: boolean; act: (a: CashStaffAction) => void }) {
  const st = STATE_TEXT[s.status.state] ?? STATE_TEXT.starting;
  const [counts, setCounts] = useState<Record<number, string>>({});
  const [counted, setCounted] = useState('');
  const pieces = () =>
    Object.entries(counts)
      .map(([v, n]) => ({ valueAgorot: Number(v), count: Number(n) }))
      .filter((p) => Number.isInteger(p.count) && p.count >= 0 && String(counts[p.valueAgorot] ?? '').trim() !== '');
  const btn = 'rounded-lg border border-neutral-300 bg-white px-2.5 py-1 text-sm font-semibold disabled:opacity-40';
  return (
    <section className="rounded-2xl bg-white p-4 shadow">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h2 className="text-lg font-extrabold">{s.name}</h2>
        {s.location ? <span className="text-sm text-neutral-500">({s.location})</span> : null}
        <span className={`rounded px-2 py-0.5 text-xs font-bold ${st.tone}`}>{st.text}</span>
        {s.simulator ? <span className="rounded bg-violet-100 px-2 py-0.5 text-xs font-bold text-violet-800">סימולטור</span> : null}
        <span className="flex-1" />
        <span className="text-xs text-neutral-400">{s.serial || 'יחידת ברירת מחדל'}</span>
      </div>
      {s.status.reason ? <p className="mb-2 text-sm text-red-700">{s.status.reason}</p> : null}
      <div className="mb-2 flex flex-wrap gap-3 text-sm">
        <span>
          עודף זמין: <b>{nis(s.changeAvailableAgorot)}</b>
        </span>
        {s.status.exactOnly ? <span className="font-bold text-amber-700">סכום מדויק בלבד</span> : null}
        <span>בתור: {s.status.queue.length}</span>
        {s.cashbox ? (
          <span>
            קופסה: {s.cashbox.notes} שטרות · {s.cashbox.coins} מטבעות · {nis(s.cashbox.valueAgorot)}
            {s.cashbox.nearFull ? ' · כמעט מלאה' : ''}
          </span>
        ) : null}
      </div>
      {s.alerts.length > 0 ? (
        <ul className="mb-2 space-y-0.5 text-sm text-red-700">
          {s.alerts.map((a) => (
            <li key={`${a.code}|${a.unit}`}>• {a.message}</li>
          ))}
        </ul>
      ) : null}
      <table className="mb-3 w-full text-sm">
        <thead>
          <tr className="text-right text-xs text-neutral-500">
            <th className="font-semibold">ערך</th>
            <th className="font-semibold">כמות</th>
            <th className="font-semibold">מקור</th>
            {unlocked ? <th className="font-semibold">ספירה / מילוי</th> : null}
          </tr>
        </thead>
        <tbody>
          {s.denominations.map((d) => (
            <tr key={d.valueAgorot} className={d.isLow ? 'text-amber-700' : ''}>
              <td>{nis(d.valueAgorot)}</td>
              <td className="font-bold">{d.count}</td>
              <td className="text-xs">{d.accurate ? 'ספירת המכשיר' : `הערכה${d.level ? ` · חיישן ${d.level}` : ''}`}</td>
              {unlocked ? (
                <td>
                  <input
                    className="w-20 rounded border px-1 text-left"
                    inputMode="numeric"
                    value={counts[d.valueAgorot] ?? ''}
                    onChange={(e) => setCounts({ ...counts, [d.valueAgorot]: e.target.value.replace(/\D/g, '') })}
                  />
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {unlocked ? (
        <div className="mb-3 flex flex-wrap gap-2">
          <button type="button" className={btn} onClick={() => act({ stationId: s.stationId, op: 'refill', pieces: pieces() })}>
            מילוי (מוסיף)
          </button>
          <button type="button" className={btn} onClick={() => act({ stationId: s.stationId, op: 'float', pieces: pieces() })}>
            קרן פתיחה (קובע)
          </button>
          <button type="button" className={btn} onClick={() => act({ stationId: s.stationId, op: 'count', pieces: pieces(), countedAgorot: counted ? Math.round(Number(counted) * 100) : null })}>
            ספירה
          </button>
          <span className="flex items-center gap-1 text-sm">
            בקופסה (₪):
            <input className="w-20 rounded border px-1 text-left" inputMode="decimal" value={counted} onChange={(e) => setCounted(e.target.value.replace(/[^\d.]/g, ''))} />
          </span>
          <button type="button" className={btn} onClick={() => act({ stationId: s.stationId, op: 'collect', countedAgorot: counted ? Math.round(Number(counted) * 100) : null })}>
            ריקון קופסה
          </button>
          <button type="button" className={btn} onClick={() => act({ stationId: s.stationId, op: 'dump' })}>
            ריקון מחזיר לקופסה
          </button>
          <button type="button" className={btn} onClick={() => act({ stationId: s.stationId, op: s.refillVia ? 'refill_via_stop' : 'refill_via_start' })}>
            {s.refillVia ? 'סיום מילוי דרך המקבל' : 'מילוי דרך המקבל'}
          </button>
          <button type="button" className={btn} onClick={() => act({ stationId: s.stationId, op: 'deliver_pending' })}>
            מסירת שטרות ממתינים
          </button>
          <button type="button" className={btn} onClick={() => act({ stationId: s.stationId, op: s.maintenance ? 'maintenance_off' : 'maintenance_on' })}>
            {s.maintenance ? 'החזרה לשירות' : 'העברה לתחזוקה'}
          </button>
          <button type="button" className={btn} onClick={() => act({ stationId: s.stationId, op: 'reset_alerts' })}>
            איפוס התראות
          </button>
        </div>
      ) : null}
      {s.simulator ? (
        <div className="mb-3 flex flex-wrap items-center gap-1.5 rounded-lg bg-violet-50 p-2 text-sm">
          <span className="font-bold text-violet-800">הכנסה (סימולטור):</span>
          {[...s.status.accepts.coins, ...s.status.accepts.notes].map((v) => (
            <button key={v} type="button" className={btn} onClick={() => act({ stationId: s.stationId, op: 'sim_insert', valueAgorot: v })}>
              {nis(v)}
            </button>
          ))}
          <button type="button" className={btn} onClick={() => act({ stationId: s.stationId, op: 'sim_take' })}>
            לקחת שטר
          </button>
        </div>
      ) : null}
      <h3 className="mb-1 text-sm font-bold text-neutral-600">עסקאות אחרונות</h3>
      <ul className="max-h-56 space-y-0.5 overflow-auto text-xs">
        {s.recent.map((t) => (
          <li key={t.txId} className={t.state === 'HELD' || t.changeOwedAgorot > 0 ? 'text-red-700' : ''}>
            {new Date(t.createdAt).toLocaleTimeString('he-IL')} · {TX_TEXT[t.state] ?? t.state} · {nis(t.dueAgorot)} · הוכנס {nis(t.insertedAgorot)}
            {t.changePaidAgorot ? ` · עודף ${nis(t.changePaidAgorot)}` : ''}
            {t.changeOwedAgorot ? ` · עודף חייב ${nis(t.changeOwedAgorot)} (${t.slipCode})` : ''}
            {t.heldAgorot ? ` · מוחזק ${nis(t.heldAgorot)}` : ''} · {t.txId.slice(0, 8).toUpperCase()}
          </li>
        ))}
      </ul>
    </section>
  );
}

function PinPad({ onClose }: { onClose: () => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    const r = await shell.cashUnlock?.(pin);
    if (r?.ok) onClose();
    else {
      setError(r?.message ?? 'קוד שגוי');
      setPin('');
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
      <div className="w-72 rounded-2xl bg-white p-4 text-center shadow-xl" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-2 text-lg font-extrabold">קוד מנהל</h2>
        <input
          autoFocus
          className="mb-2 w-full rounded-lg border px-3 py-2 text-center text-2xl tracking-widest"
          type="password"
          inputMode="numeric"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 12))}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
        />
        {error ? <p className="mb-2 text-sm text-red-700">{error}</p> : null}
        <button type="button" className="w-full rounded-lg bg-blue-600 py-2 font-bold text-white" onClick={() => void submit()}>
          כניסה
        </button>
      </div>
    </div>
  );
}
