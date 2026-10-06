/**
 * Staff on the kiosk (never in a customer's way, never during a payment):
 *  - a long press (2 s) in the top-right corner (detected by the kiosk's root, nothing drawn over it) → a shop manager's PIN (checked offline against the
 *    synced POS users) → "ניהול הקיוסק": status, payment and unresolved charges, printer, sync,
 *    media, today's orders (re-print a bon / a receipt — never a charge), the Zs, pause, exit;
 *  - six taps in the top-left corner + the technician code (1995 unless the cloud set one) →
 *    "בדיקות ומידע קיוסק": assignment, network, printer test and choice, a read-only pinpad check,
 *    updates, remote support (TeamViewer QuickSupport when installed);
 *  - a small red label in the corner when something needs staff (no internet, the pinpad, a bon
 *    that did not print, a payment to check) — no internet never blocks a sale.
 */

import { useEffect, useState } from 'react';
import { Delete, X } from 'lucide-react';
import { cardStyle, type PreviewModel } from '@kiosk-shared/index';
import type { AdminInfo, KioskView, SynqpayAdminInfo, SynqpayPairingView, TechnicianInfo } from '../../shared/bridge';
import { kiosk } from '../bridge';
import { t } from '../i18n';
import { updateLine } from '../roles/updateText';

export function StaffLayer({ m, view, open, onClose }: { m: PreviewModel; view: KioskView; open: 'none' | 'admin' | 'technician'; onClose: () => void }) {
  const [unlocked, setUnlocked] = useState(false);
  useEffect(() => {
    if (open === 'none') setUnlocked(false);
  }, [open]);
  const alerts = [
    view.state.offline ? t('staffOffline') : null,
    view.state.noPayment ? t('staffTerminal') : null,
    view.state.cardBlocked ? t('staffCard') : null,
    view.staff.unprintedBons > 0 ? `${t('staffBons')} (${view.staff.unprintedBons})` : null,
    view.staff.printer !== 'ok' && view.staff.printer !== 'unknown' ? t('staffPrinter') : null,
  ].filter(Boolean);
  return (
    <>
      {alerts.length > 0 ? (
        <div className="pointer-events-none absolute bottom-4 left-2 z-[65] rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold text-white shadow" dir="rtl">
          {alerts.join(' · ')}
        </div>
      ) : null}
      {open !== 'none' && !unlocked ? (
        <PinPad
          m={m}
          title={open === 'admin' ? 'כניסה לניהול הקיוסק — קוד מנהל' : 'בדיקות ומידע קיוסק — קוד טכנאי'}
          onCancel={onClose}
          onSubmit={async (code) => {
            if (open === 'admin') {
              const r = await kiosk.adminUnlock(code);
              if (r.ok) setUnlocked(true);
              return r.ok ? null : r.error;
            }
            const r = await kiosk.technicianUnlock(code);
            if (r.outcome === 'granted') setUnlocked(true);
            return r.outcome === 'granted'
              ? null
              : r.outcome === 'wrong'
                ? `קוד שגוי — נותרו ${r.triesLeft} ניסיונות`
                : `נעול ל-${Math.ceil(r.lockedForMs / 60_000)} דקות`;
          }}
        />
      ) : null}
      {open === 'admin' && unlocked ? <AdminScreen m={m} onClose={onClose} /> : null}
      {open === 'technician' && unlocked ? <TechnicianScreen m={m} onClose={onClose} /> : null}
    </>
  );
}

function PinPad({ m, title, onSubmit, onCancel }: { m: PreviewModel; title: string; onSubmit: (code: string) => Promise<string | null>; onCancel: () => void }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const id = window.setTimeout(onCancel, 45_000);
    return () => window.clearTimeout(id);
  }, [code, onCancel]);
  const key = (k: string) => {
    setError(null);
    if (k === 'del') setCode((c) => c.slice(0, -1));
    else if (code.length < 8) setCode((c) => c + k);
  };
  return (
    <div className="absolute inset-0 z-[80] flex items-center justify-center bg-black/60 p-6">
      <div className="w-full max-w-[320px] space-y-3 p-5 text-center" style={{ ...cardStyle(m), background: m.c.surface, color: m.c.text }}>
        <div className="text-base font-extrabold">{title}</div>
        <div className="flex h-8 items-center justify-center gap-2" dir="ltr">
          {Array.from({ length: Math.max(4, code.length) }, (_, i) => (
            <span key={i} className="h-3 w-3 rounded-full" style={{ background: i < code.length ? m.c.text : m.c.border }} />
          ))}
        </div>
        {error ? <div className="text-xs font-semibold text-red-600">{error}</div> : null}
        <div className="grid grid-cols-3 gap-2" dir="ltr">
          {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'].map((k) => (
            <button
              key={k}
              type="button"
              disabled={busy}
              onClick={async () => {
                if (k !== 'ok') return key(k);
                setBusy(true);
                const err = await onSubmit(code).catch((e) => String(e));
                setBusy(false);
                setCode('');
                setError(err);
              }}
              className="flex h-12 items-center justify-center text-lg font-bold"
              style={k === 'ok' ? { background: m.c.button, color: m.c.buttonText, borderRadius: 10 } : { background: '#0000000D', borderRadius: 10 }}
            >
              {k === 'del' ? <Delete className="h-5 w-5" /> : k === 'ok' ? 'אישור' : k}
            </button>
          ))}
        </div>
        <button type="button" onClick={onCancel} className="text-sm underline" style={{ color: m.c.mutedText }}>
          ביטול
        </button>
      </div>
    </div>
  );
}

const time = (ms: number | null | undefined) => (ms ? new Date(ms).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' }) : 'עדיין לא');
const shekels = (agorot: number) => `₪${(agorot / 100).toFixed(2)}`;

function Panel({ m, title, children }: { m: PreviewModel; title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5 p-3 text-sm" style={cardStyle(m)}>
      <h3 className="text-sm font-extrabold">{title}</h3>
      {children}
    </section>
  );
}

function Btn({ m, onClick, children, danger = false }: { m: PreviewModel; onClick: () => void; children: React.ReactNode; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick} className="px-3 py-1.5 text-xs font-bold" style={{ background: danger ? '#DC2626' : `${m.c.button}1A`, color: danger ? '#fff' : m.c.button, borderRadius: 8 }}>
      {children}
    </button>
  );
}

function Shell({ m, title, onClose, children }: { m: PreviewModel; title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const id = window.setTimeout(onClose, 5 * 60_000);
    return () => window.clearTimeout(id);
  }, [onClose]);
  return (
    <div className="absolute inset-0 z-[80] flex flex-col" style={{ background: m.c.background, color: m.c.text }} dir="rtl">
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-3" style={{ borderColor: m.c.border }}>
        <h2 className="flex-1 text-lg font-extrabold">{title}</h2>
        <button type="button" aria-label="סגירה" onClick={onClose} className="flex h-9 w-9 items-center justify-center rounded-full" style={{ background: `${m.c.button}1A`, color: m.c.button }}>
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4">{children}</div>
    </div>
  );
}

function useNote(): [string | null, (r: { ok: boolean; message?: string }) => void] {
  const [note, setNote] = useState<string | null>(null);
  return [note, (r) => setNote(r.message ?? (r.ok ? 'בוצע' : 'לא בוצע'))];
}

function AdminScreen({ m, onClose }: { m: PreviewModel; onClose: () => void }) {
  const [info, setInfo] = useState<AdminInfo | null>(null);
  const [note, show] = useNote();
  const refresh = () => void kiosk.adminInfo().then(setInfo).catch(() => undefined);
  useEffect(refresh, []);
  const act = async (a: Parameters<typeof kiosk.adminAction>[0]) => {
    show(await kiosk.adminAction(a));
    refresh();
  };
  if (!info) return <Shell m={m} title="ניהול הקיוסק" onClose={onClose}>…</Shell>;
  return (
    <Shell m={m} title="ניהול הקיוסק" onClose={onClose}>
      {note ? <div className="rounded-lg bg-black/5 p-2 text-center text-xs font-semibold">{note}</div> : null}
      <Panel m={m} title="מצב">
        <div>פועל בשם: {info.operator?.name ?? '—'} (הקיוסק עצמו — בלי עובד אחראי)</div>
        <div>{info.shift.open ? `משמרת פתוחה #${info.shift.number}` : 'אין משמרת פתוחה'}</div>
        <div>
          Z: {info.zMode === 'till' ? 'Z לכל קופה' : 'Z סניפי'}
          {info.zOwed ? ' · Z ממתין להפקה' : ''}
        </div>
        {info.offlineSince ? <div className="font-semibold text-red-600">אין אינטרנט מאז {time(info.offlineSince)} (המכירות ממשיכות)</div> : null}
        <div className="flex flex-wrap gap-2 pt-1">
          <Btn m={m} onClick={() => act({ type: 'pause', paused: true })}>
            השהיית הקיוסק
          </Btn>
          <Btn m={m} onClick={() => act({ type: 'pause', paused: false })}>
            חידוש הקיוסק
          </Btn>
        </div>
      </Panel>
      <Panel m={m} title="מסופון אשראי">
        <div>סוג: {info.terminal.kind ?? 'לא מוגדר'}</div>
        <div dir="ltr" className="text-end">
          {info.terminal.address ?? ''}
        </div>
        <div>
          מצב: {info.terminal.state} · תשובה תקינה אחרונה: {time(info.terminal.lastOkAt)}
        </div>
        {info.terminal.lastError ? <div className="text-xs text-red-600">{info.terminal.lastError}</div> : null}
        <Btn m={m} onClick={() => act({ type: 'checkTerminal' })}>
          בדיקת חיבור
        </Btn>
        {info.terminal.synqpay ? <SynqpayPairing m={m} info={info.terminal.synqpay} onDone={refresh} /> : null}
        {info.terminal.unresolved.map((u) => (
          <div key={u.reference} className="space-y-1 rounded-lg bg-amber-50 p-2 text-xs text-amber-900">
            <div className="font-bold">
              תשלום לבירור · {shekels(u.amountAgorot)} · {new Date(u.startedAt).toLocaleTimeString('he-IL')}
            </div>
            <div dir="ltr">vuid {u.reference}</div>
            {u.note ? <div>{u.note}</div> : null}
            <div className="flex gap-2">
              <Btn m={m} onClick={() => act({ type: 'recheckPayment', reference: u.reference })}>
                בדוק שוב
              </Btn>
              <Btn m={m} danger onClick={() => act({ type: 'markNotApproved', reference: u.reference })}>
                סמן כלא אושר והמשך
              </Btn>
            </div>
          </div>
        ))}
      </Panel>
      <Panel m={m} title="מדפסת">
        <div>{info.printer.target}</div>
        <div>מצב: {info.printer.health}</div>
        {info.printer.lastError ? <div className="text-xs text-red-600">{info.printer.lastError}</div> : null}
        <div className="flex gap-2">
          <Btn m={m} onClick={() => act({ type: 'testPrint' })}>
            הדפסת בדיקה
          </Btn>
          <Btn m={m} onClick={() => act({ type: 'retryPrints' })}>
            הדפסה חוזרת של מה שנכשל
          </Btn>
        </div>
      </Panel>
      <Panel m={m} title="סנכרון">
        <div>סנכרון קיוסק אחרון: {time(info.sync.lastKioskSyncAt)}</div>
        <div>ממתינים לשליחה לענן: {info.sync.outbox}</div>
        <div>גרסת הגדרות: {info.sync.configVersion ?? '—'}</div>
        <div>
          מדיה בקיוסק: {info.media.files} קבצים · {(info.media.bytes / 1_048_576).toFixed(1)}MB · חסרים {info.media.missing}
        </div>
        {info.sync.lastError ? <div className="text-xs text-red-600">{info.sync.lastError}</div> : null}
        <Btn m={m} onClick={() => act({ type: 'syncNow' })}>
          סנכרון עכשיו
        </Btn>
      </Panel>
      <Panel m={m} title="הזמנות היום">
        {info.orders.length === 0 ? <div>אין הזמנות היום</div> : null}
        {info.orders.map((o) => (
          <div key={o.localId} className="flex items-center gap-2 border-t py-1 text-xs" style={{ borderColor: m.c.border }}>
            <span className="w-12 font-bold" dir="ltr">
              {o.label ?? '—'}
            </span>
            <span className="flex-1">
              {new Date(o.at).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' })} · {shekels(o.totalAgorot)} · בון: {o.bon}
            </span>
            <Btn m={m} onClick={() => act({ type: 'reprintBon', orderId: o.localId })}>
              בון
            </Btn>
            <Btn m={m} onClick={() => act({ type: 'reprintReceipt', orderId: o.localId })}>
              קבלה
            </Btn>
          </div>
        ))}
      </Panel>
      <Panel m={m} title="דוחות Z">
        {info.zs.length === 0 ? <div>אין</div> : null}
        {info.zs.map((z) => (
          <div key={z.number} className="text-xs">
            Z מס׳ {z.number} · {new Date(z.closedAt).toLocaleString('he-IL')} · {z.state}
          </div>
        ))}
      </Panel>
      <Btn m={m} danger onClick={() => act({ type: 'exitKiosk' })}>
        יציאה מהקיוסק (סגירת התוכנה)
      </Btn>
    </Shell>
  );
}

/**
 * "צימוד מסוף SynqPay" (pos-server docs/SPEC_SYNQPAY.md §2.2) — in the manager's admin, so the
 * manager's PIN is the pairing's authority: the kiosk asks the terminal for a code, the code shown
 * on the terminal is typed here, and the key is kept on the kiosk and sent to the cloud. Nobody
 * types an API key.
 */
function SynqpayPairing({ m, info, onDone }: { m: PreviewModel; info: SynqpayAdminInfo; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [pairing, setPairing] = useState<SynqpayPairingView | null>(null);
  const [serial, setSerial] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const phase = pairing?.phase ?? 'idle';
  useEffect(() => {
    if (phase !== 'awaiting_code') return;
    const id = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [phase]);
  const left = pairing ? Math.max(0, Math.ceil((pairing.expiresAtMs - now) / 1000)) : 0;
  const expired = phase === 'expired' || (phase === 'awaiting_code' && left === 0);
  const run = async (a: Parameters<typeof kiosk.adminAction>[0]) => {
    setBusy(true);
    const r = await kiosk.adminAction(a).catch((e: unknown) => ({ ok: false, message: String(e), pairing: undefined }));
    setBusy(false);
    if (r.pairing) setPairing(r.pairing);
    setNote(r.message ?? null);
    if (r.pairing?.phase === 'awaiting_code') setCode('');
    if (r.pairing?.phase === 'paired') onDone();
    return r;
  };
  const sendCode = () => run({ type: 'synqpayPair', serialNumber: serial.trim() || null });
  const status = !info.paired
    ? 'טרם צומד — המסוף דורש צימוד'
    : info.needsPairing
      ? 'המפתח נדחה במסוף — המסוף דורש צימוד'
      : info.pendingUpload
        ? 'צומד · המפתח עוד לא נשלח לענן'
        : 'צומד';
  const error = note ?? pairing?.error ?? null;
  return (
    <div className="mt-2 space-y-1.5 rounded-lg border p-2" style={{ borderColor: m.c.border }}>
      <div className={info.needsPairing ? 'font-bold text-red-600' : 'font-semibold'}>מסוף SynqPay: {status}</div>
      {info.serialNumber ? (
        <div className="text-xs" dir="ltr">
          S/N {info.serialNumber}
        </div>
      ) : null}
      {!open ? (
        <Btn
          m={m}
          danger={info.needsPairing}
          onClick={() => {
            setOpen(true);
            setPairing(null);
            setNote(null);
            void sendCode();
          }}
        >
          צימוד מסוף SynqPay
        </Btn>
      ) : (
        <div className="space-y-2">
          {busy ? <div className="text-xs">…</div> : null}
          {phase === 'need_serial' ? (
            <div className="space-y-1">
              <div className="text-xs">המספר הסידורי של המסוף (על גב המסוף, על האריזה או בתפריט המסוף)</div>
              <div className="flex gap-2">
                <input
                  value={serial}
                  onChange={(e) => setSerial(e.target.value.replace(/[^A-Za-z0-9-]/g, '').slice(0, 32))}
                  dir="ltr"
                  className="min-w-0 flex-1 rounded border px-2 py-1 text-xs"
                  style={{ borderColor: m.c.border, background: m.c.surface }}
                />
                <Btn m={m} onClick={() => void sendCode()}>
                  שלח קוד
                </Btn>
              </div>
            </div>
          ) : null}
          {phase === 'awaiting_code' || phase === 'expired' ? (
            <div className="space-y-1.5">
              <div className="text-sm font-extrabold">הקוד מופיע עכשיו במסך המסוף — הקלידו אותו</div>
              <div className={left <= 5 ? 'text-xs font-bold text-red-600' : 'text-xs'}>
                {expired ? 'הקוד פג תוקף — לחצו "שלח קוד חדש"' : `הקוד בתוקף עוד ${left} שניות`}
              </div>
              <div className="flex justify-center gap-1.5" dir="ltr">
                {Array.from({ length: 6 }, (_, i) => (
                  <span key={i} className="flex h-9 w-8 items-center justify-center rounded border text-lg font-bold" style={{ borderColor: m.c.border }}>
                    {code[i] ?? ''}
                  </span>
                ))}
              </div>
              <div className="mx-auto grid max-w-[220px] grid-cols-3 gap-1.5" dir="ltr">
                {['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok'].map((k) => (
                  <button
                    key={k}
                    type="button"
                    disabled={busy || expired || (k === 'ok' && code.length !== 6)}
                    onClick={() => {
                      if (k === 'del') setCode((c) => c.slice(0, -1));
                      else if (k === 'ok') void run({ type: 'synqpayCode', otp: code });
                      else setCode((c) => (c.length < 6 ? c + k : c));
                    }}
                    className="flex h-10 items-center justify-center text-base font-bold disabled:opacity-40"
                    style={k === 'ok' ? { background: m.c.button, color: m.c.buttonText, borderRadius: 8 } : { background: '#0000000D', borderRadius: 8 }}
                  >
                    {k === 'del' ? <Delete className="h-4 w-4" /> : k === 'ok' ? 'אישור' : k}
                  </button>
                ))}
              </div>
              <Btn m={m} onClick={() => void sendCode()}>
                שלח קוד חדש
              </Btn>
            </div>
          ) : null}
          {phase === 'failed' ? (
            <Btn m={m} onClick={() => void sendCode()}>
              נסו שוב
            </Btn>
          ) : null}
          {phase === 'paired' ? (
            <div className="space-y-1">
              <div className="font-bold text-green-700">המסוף צומד — המפתח נשמר בקיוסק ונמצא בשימוש</div>
              <div className="text-xs">
                {pairing?.upload === 'uploaded'
                  ? 'המפתח נשמר גם בענן (מוצפן)'
                  : pairing?.upload === 'needs_approval'
                    ? 'נדרש אישור מנהל כדי לשמור את המפתח בענן'
                    : 'המפתח עוד לא נשלח לענן — יישלח אוטומטית בסנכרון הבא'}
              </div>
              {pairing?.upload !== 'uploaded' ? (
                <Btn m={m} onClick={() => void run({ type: 'synqpayRetryUpload' })}>
                  שליחה חוזרת לענן
                </Btn>
              ) : null}
            </div>
          ) : null}
          {error ? <div className="text-xs font-semibold text-red-600">{error}</div> : null}
          <button type="button" className="text-xs underline" style={{ color: m.c.mutedText }} onClick={() => setOpen(false)}>
            סגירה
          </button>
        </div>
      )}
    </div>
  );
}

function TechnicianScreen({ m, onClose }: { m: PreviewModel; onClose: () => void }) {
  const [info, setInfo] = useState<TechnicianInfo | null>(null);
  const [note, show] = useNote();
  const [queue, setQueue] = useState('');
  const [host, setHost] = useState('');
  const refresh = () => void kiosk.technicianInfo().then(setInfo).catch(() => undefined);
  useEffect(refresh, []);
  const act = async (a: Parameters<typeof kiosk.technicianAction>[0]) => {
    show(await kiosk.technicianAction(a));
    refresh();
  };
  return (
    <Shell m={m} title="בדיקות ומידע קיוסק" onClose={onClose}>
      {note ? <div className="rounded-lg bg-black/5 p-2 text-center text-xs font-semibold">{note}</div> : null}
      {!info ? (
        <div>…</div>
      ) : (
        <>
          <Panel m={m} title="שיוך">
            <div>קיוסק: {info.machine?.name ?? '—'}</div>
            <div>סניף: {info.shopName ?? '—'} · חברה: {info.companyName ?? '—'}</div>
            <div>קופה מס׳ {info.machine?.posNumber ?? '—'} · תפקיד: {info.deviceRole ?? '—'}</div>
            <div dir="ltr" className="text-end text-xs">
              {info.machine?.machineId}
            </div>
          </Panel>
          <Panel m={m} title="רשת">
            <div>{info.network.online ? 'מחובר לענן' : 'אין חיבור לענן'} · heartbeat אחרון: {time(info.network.lastBeatOkAt)}</div>
            <div dir="ltr" className="text-end text-xs">
              {info.network.serverUrl}
            </div>
            {info.network.interfaces.map((i) => (
              <div key={i.name + i.address} className="text-xs" dir="ltr">
                {i.name}: {i.address}
              </div>
            ))}
          </Panel>
          <Panel m={m} title="מדפסת (SNBC BTP-880)">
            <div>{info.printer.target} · {info.printer.health}</div>
            <div className="text-xs">מדפסות Windows: {info.printer.queues.join(' · ') || '—'}</div>
            <div className="flex flex-wrap items-center gap-2">
              <input value={queue} onChange={(e) => setQueue(e.target.value)} placeholder="שם תור המדפסת" className="min-w-0 flex-1 rounded border px-2 py-1 text-xs" style={{ borderColor: m.c.border, background: m.c.surface }} />
              <Btn m={m} onClick={() => act({ type: 'setPrinter', transport: 'spooler', queueName: queue.trim() })}>
                USB / Windows
              </Btn>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.50" dir="ltr" className="min-w-0 flex-1 rounded border px-2 py-1 text-xs" style={{ borderColor: m.c.border, background: m.c.surface }} />
              <Btn m={m} onClick={() => act({ type: 'setPrinter', transport: 'tcp', host: host.trim(), port: 9100 })}>
                רשת 9100
              </Btn>
            </div>
            <Btn m={m} onClick={() => act({ type: 'printerTest' })}>
              הדפסת בדיקה
            </Btn>
          </Panel>
          <Panel m={m} title="מסופון (בדיקה בלבד — בלי חיוב)">
            <div>
              {info.terminal.kind ?? 'לא מוגדר'} · {info.terminal.state}
            </div>
            <div dir="ltr" className="text-end text-xs">
              {info.terminal.address}
            </div>
            <Btn m={m} onClick={() => act({ type: 'pinpadCheck' })}>
              בדיקת מסופון
            </Btn>
          </Panel>
          <Panel m={m} title="עדכונים">
            <div>
              גרסה: {info.update.current} · {updateLine(info.update)}
            </div>
            <div className="text-xs">
              {info.update.autoInstall
                ? info.update.installWindow
                  ? `התקנה אוטומטית בחלון ${info.update.installWindow.start}–${info.update.installWindow.end}, כשאין הזמנה`
                  : 'התקנה אוטומטית כשהקיוסק פנוי'
                : 'התקנה ידנית ("התקן עכשיו"); לעולם לא בזמן תשלום'}
            </div>
            <div className="flex gap-2">
              <Btn m={m} onClick={() => act({ type: 'updateCheck' })}>
                בדוק עכשיו
              </Btn>
              <Btn m={m} onClick={() => act({ type: 'updateInstall' })}>
                התקן עכשיו
              </Btn>
            </div>
          </Panel>
          <Panel m={m} title="תמיכה מרחוק">
            <Btn m={m} onClick={() => act({ type: 'quickSupport' })}>
              פתיחת TeamViewer QuickSupport
            </Btn>
          </Panel>
          <Panel m={m} title="תצוגה">
            <div className="flex gap-2">
              {[1, 1.5, 2, 2.5].map((z) => (
                <Btn key={z} m={m} onClick={() => act({ type: 'setZoom', zoom: z })}>
                  ×{z}
                </Btn>
              ))}
            </div>
          </Panel>
          <Btn m={m} danger onClick={() => act({ type: 'unpair' })}>
            ניתוק הקיוסק מהענן
          </Btn>
        </>
      )}
    </Shell>
  );
}
