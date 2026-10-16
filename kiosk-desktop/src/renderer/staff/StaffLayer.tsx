/**
 * Staff on the kiosk (never in a customer's way, never during a payment):
 *  - a long press (2 s) in the top-right corner (detected by the kiosk's root, nothing drawn over it) → the PIN of a
 *    manager whose role allows "יציאה מנעילת קופה (קיוסק)" (KIOSK_UNLOCK, checked offline against the
 *    synced POS users) → "ניהול הקיוסק": status, payment and unresolved charges, printer, sync,
 *    media, "היסטוריית עסקאות" (today / the week kept / older from the cloud, searched; per sale "שובר פריט" — all or only
 *    what did not print — "חשבונית (העתק)", "בון למטבח", each "הדפסה חוזרת" under REPRINT, staff/KioskHistoryPanel.tsx;
 *    never a charge), "משמרת ו-Z" (the kiosk's close or its own Z by
 *    its Z mode, staff/KioskZPanel.tsx), the Zs, pause, and — for a
 *    manager who also holds DESKTOP_EXIT — "יציאה לשולחן העבודה" and "יציאה מהתוכנה";
 *  - six taps in the top-left corner + the technician code (1995 unless the cloud set one) →
 *    "בדיקות ומידע קיוסק": assignment, network, printer test and choice, a read-only pinpad check,
 *    updates, remote support (TeamViewer QuickSupport when installed);
 *  - "מצב עבודה: קיוסק / קופה" at the top of "ניהול הקיוסק", only where the owner allowed it
 *    (core/workMode.ts): the device works as a till until it is switched back; refused over a customer's
 *    order or payment; always a manager's code with KIOSK_TILL_MODE (the one that opened the menu counts
 *    when it holds it);
 *  - a small red label in the corner when something needs staff (no internet, the pinpad, a bon
 *    or an item ticket that did not print, a payment to check) — no internet never blocks a sale;
 *  - "יציאה לשולחן העבודה" (desktop/DesktopExit.tsx): a quiet icon in the bottom-right corner of the
 *    resting screens (`home`), and a button in both menus → a manager's code (DESKTOP_EXIT).
 */

import { useEffect, useState } from 'react';
import { Delete, X } from 'lucide-react';
import { cardStyle, type PreviewModel } from '@kiosk-shared/index';
import type { AdminActionResult, AdminInfo, KioskView, SynqpayAdminInfo, SynqpayPairingView, TechnicianInfo } from '../../shared/bridge';
import { DISPLAY_SCALE_TEXT, DisplayScaleControl } from '../roles/DisplayScaleControl';
import { TERMINAL_CHECK_BYPASS_WARNING } from '../../core/terminalCheckBypass';
import { kiosk } from '../bridge';
import { t } from '../i18n';
import { updateLine } from '../roles/updateText';
import { DESKTOP_EXIT_LABEL, DesktopExitButton, DesktopExitMenuButton, DesktopExitPad } from '../desktop/DesktopExit';
import { PERMISSION_LABEL } from '../../core/desktopExit';
import { WORK_TEXT } from '../../core/workMode';
import { WorkModePanel } from './WorkModePanel';
import { KioskZPanel } from './KioskZPanel';
import { KioskHistoryPanel } from './KioskHistoryPanel';

/** CashMag on the manager's screen: where the server's address came from, what an unclear payment was. */
const CASHMAG_SOURCE: Record<string, string> = { cloud: 'מהענן', local: 'מקומי (kiosk.json)', default: 'לא מוגדר' };
const CASHMAG_OUTCOME: Record<string, string> = {
  held: 'נשאר כסף במכשיר בלי מכירה',
  unknown: 'התשובה מהשרת אבדה — לא ידוע מה המכשיר עשה',
  interrupted: 'הקיוסק נסגר באמצע התשלום',
};

export function StaffLayer({
  m,
  view,
  open,
  onClose,
  home = false,
  onResetCustomer,
  alerts: showAlerts = true,
}: {
  m: PreviewModel;
  view: KioskView;
  open: 'none' | 'admin' | 'technician';
  onClose: () => void;
  /** A resting screen (attract, closed, paused…) with nothing in flight: the desktop-exit icon shows. */
  home?: boolean;
  /** "איפוס מסך הלקוח": the customer's order started over (never over a payment) — the way past "לקוח באמצע הזמנה" on the way to the till. */
  onResetCustomer?: () => void;
  /** The small red label of what needs staff (the kiosk's screens); off on the screens around it (staff/ShellStaff.tsx). */
  alerts?: boolean;
}) {
  const [unlocked, setUnlocked] = useState(false);
  const [exitOpen, setExitOpen] = useState(false);
  /** "בדיקות ומידע" from the manager's menu: the technician's own pad and screen, then back out. */
  const [techFromAdmin, setTechFromAdmin] = useState(false);
  useEffect(() => {
    if (open === 'none') {
      setUnlocked(false);
      setTechFromAdmin(false);
    }
  }, [open]);
  const openNow: 'none' | 'admin' | 'technician' = open === 'admin' && techFromAdmin ? 'technician' : open;
  const alerts = !showAlerts ? [] : [
    view.state.offline ? t('staffOffline') : null,
    view.state.noPayment ? t('staffTerminal') : null,
    view.state.cardBlocked ? t('staffCard') : null,
    view.staff.unprintedBons > 0 ? `${t('staffBons')} (${view.staff.unprintedBons})` : null,
    (view.staff.unprintedTickets ?? 0) > 0 ? `${t('staffTickets')} (${view.staff.unprintedTickets})` : null,
    view.staff.printer !== 'ok' && view.staff.printer !== 'unknown' ? t('staffPrinter') : null,
  ].filter(Boolean);
  return (
    <>
      {alerts.length > 0 ? (
        <div className="pointer-events-none absolute bottom-4 left-2 z-[65] rounded-full bg-red-600 px-2 py-0.5 text-[10px] font-bold text-white shadow" dir="rtl">
          {alerts.join(' · ')}
        </div>
      ) : null}
      {openNow !== 'none' && !unlocked ? (
        <PinPad
          m={m}
          title={openNow === 'admin' ? 'כניסה לניהול הקיוסק — קוד מנהל' : 'בדיקות ומידע קיוסק — קוד טכנאי'}
          onCancel={onClose}
          onSubmit={async (code) => {
            if (openNow === 'admin') {
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
      {openNow === 'admin' && unlocked ? (
        <AdminScreen
          m={m}
          onClose={onClose}
          onDesktopExit={() => setExitOpen(true)}
          onResetCustomer={onResetCustomer}
          onTechnician={() => {
            // The technician's checks ask for the technician's own code, as from the corner's six taps.
            setUnlocked(false);
            setTechFromAdmin(true);
          }}
        />
      ) : null}
      {openNow === 'technician' && unlocked ? <TechnicianScreen m={m} onClose={onClose} onDesktopExit={() => setExitOpen(true)} /> : null}
      {home && open === 'none' && !exitOpen ? <DesktopExitButton onOpen={() => setExitOpen(true)} /> : null}
      {exitOpen ? (
        <DesktopExitPad
          onClose={() => setExitOpen(false)}
          // Out: the menu that opened it is closed too, so the way back lands on the kiosk.
          onExited={() => onClose()}
        />
      ) : null}
    </>
  );
}

export function PinPad({ m, title, onSubmit, onCancel }: { m: PreviewModel; title: string; onSubmit: (code: string) => Promise<string | null>; onCancel: () => void }) {
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
    <button type="button" onClick={onClick} className="min-w-[var(--k-target,0px)] px-3 py-1.5 text-xs font-bold" style={{ background: danger ? '#DC2626' : `${m.c.button}1A`, color: danger ? '#fff' : m.c.buttonInk, borderRadius: 8 }}>
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
    // `k-staff`: every control of the manager's screens at least 48 dp tall at this window's zoom (kiosk-shared PREVIEW_CSS).
    <div className="k-staff absolute inset-0 z-[80] flex flex-col" style={{ background: m.c.background, color: m.c.text }} dir="rtl">
      <div className="flex shrink-0 items-center gap-2 border-b px-4 py-3" style={{ borderColor: m.c.border }}>
        <h2 className="flex-1 text-lg font-extrabold">{title}</h2>
        <button type="button" aria-label="סגירה" onClick={onClose} className="k-hit flex h-9 w-9 items-center justify-center rounded-full" style={{ background: `${m.c.button}1A`, color: m.c.buttonInk }}>
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

function AdminScreen({
  m,
  onClose,
  onDesktopExit,
  onResetCustomer,
  onTechnician,
}: {
  m: PreviewModel;
  onClose: () => void;
  onDesktopExit: () => void;
  onResetCustomer?: () => void;
  onTechnician?: () => void;
}) {
  const [info, setInfo] = useState<AdminInfo | null>(null);
  const [note, show] = useNote();
  const [exiting, setExiting] = useState(false);
  /** "מצב עבודה": the manager's code pad, when the switch needs one (to the till, or back to the kiosk). */
  const [workPad, setWorkPad] = useState<'none' | 'till' | 'kiosk'>('none');
  const [workRefusal, setWorkRefusal] = useState<{ code: string; text: string } | null>(null);
  const refresh = () => void kiosk.adminInfo().then(setInfo).catch(() => undefined);
  useEffect(refresh, []);
  const act = async (a: Parameters<typeof kiosk.adminAction>[0]) => {
    show(await kiosk.adminAction(a));
    refresh();
  };
  if (!info) return <Shell m={m} title="ניהול הקיוסק" onClose={onClose}>…</Shell>;
  /**
   * To the till (or, from the corner over the till, back to the kiosk): refused → its words; a code is needed → the pad;
   * done → this menu closes (the screen is the other mode's now).
   */
  const switchMode = async (mode: 'till' | 'kiosk', code?: string): Promise<string | null> => {
    const r: AdminActionResult = await kiosk.adminAction({ type: 'workMode', mode, ...(code ? { code } : {}) }).catch((e: unknown) => ({ ok: false, message: String(e) }));
    if (r.ok) {
      setWorkPad('none');
      onClose();
      return null;
    }
    if (r.needsCode) {
      setWorkRefusal(null);
      setWorkPad(mode);
      // Asked for the first time: the pad says it; a code that was refused: why.
      return code ? (r.message ?? 'קוד שגוי') : null;
    }
    setWorkPad('none');
    setWorkRefusal({ code: r.refusal ?? '', text: r.message ?? 'המעבר נכשל' });
    return null;
  };
  const goTill = (code?: string) => switchMode('till', code);
  const goKiosk = (code?: string) => switchMode('kiosk', code);
  return (
    <Shell m={m} title="ניהול הקיוסק" onClose={onClose}>
      {note ? <div className="rounded-lg bg-black/5 p-2 text-center text-xs font-semibold">{note}</div> : null}
      {info.workMode ? (
        <WorkModePanel
          m={m}
          info={info.workMode}
          refusal={workRefusal}
          onTill={() => void goTill()}
          onKiosk={() => void goKiosk()}
          onResetCustomer={
            onResetCustomer
              ? () => {
                  onResetCustomer();
                  setWorkRefusal(null);
                }
              : undefined
          }
        />
      ) : null}
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
      {info.kioskZ ? (
        <KioskZPanel
          m={m}
          info={info.kioskZ}
          onRun={async () => {
            const r = await kiosk.adminAction({ type: 'kioskZ' });
            refresh();
            return r;
          }}
        />
      ) : null}
      <Panel m={m} title="מסופון אשראי">
        <div>סוג: {info.terminal.kind ?? 'לא מוגדר'}</div>
        <div dir="ltr" className="text-end">
          {info.terminal.address ?? ''}
        </div>
        <div>
          מצב: {info.terminal.state} · תשובה תקינה אחרונה: {time(info.terminal.lastOkAt)}
        </div>
        {info.terminal.lastError ? <div className="text-xs text-red-600">{info.terminal.lastError}</div> : null}
        {info.terminal.numberCheckBypass ? <div className="text-xs font-semibold text-amber-700">{TERMINAL_CHECK_BYPASS_WARNING}</div> : null}
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
      {info.cash ? (
        <Panel m={m} title="מכשיר מזומן">
          <div>
            {info.cash.station ?? 'עמדה לא ידועה'} {info.cash.address ? <span dir="ltr">({info.cash.address})</span> : null}
          </div>
          <div className={info.cash.usable ? 'text-emerald-700' : 'text-red-600'}>{info.cash.usable ? 'זמין' : (info.cash.reason ?? 'לא זמין')}</div>
          {info.cash.pending.map((p) => (
            <div key={p.txShort} className="rounded-lg bg-amber-50 p-2 text-xs text-amber-900">
              תשלום מזומן לבירור · {shekels(p.amountAgorot)} · {new Date(p.startedAt).toLocaleTimeString('he-IL')} · עסקה <span dir="ltr">{p.txShort}</span>
            </div>
          ))}
          <Btn m={m} onClick={() => act({ type: 'cashRecheck' })}>
            בדיקה מול מכשיר המזומן
          </Btn>
        </Panel>
      ) : null}
      {info.cashmag ? (
        <Panel m={m} title="מכשיר מזומן CashMag">
          <div>
            שרת <span dir="ltr">{info.cashmag.address}</span> · {CASHMAG_SOURCE[info.cashmag.sources.host] ?? ''}
          </div>
          <div className="text-xs">
            שם הקיוסק בשרת: {info.cashmag.terminal} · קוד משתמש: {info.cashmag.userCodeSet ? 'מוגדר' : 'לא מוגדר'} · פרוטוקול {info.cashmag.protocol}
          </div>
          <div className={info.cashmag.usable ? 'text-emerald-700' : 'text-red-600'}>{info.cashmag.usable ? 'זמין' : (info.cashmag.reason ?? 'לא זמין')}</div>
          {info.cashmag.lastError ? <div className="text-xs text-red-600">{info.cashmag.lastError}</div> : null}
          {info.cashmag.unresolved.map((u) => (
            <div key={u.txId} className="space-y-1 rounded-lg bg-amber-50 p-2 text-xs text-amber-900">
              <div className="font-bold">
                תשלום CashMag לבירור · {shekels(u.amountAgorot)} · {new Date(u.startedAt).toLocaleTimeString('he-IL')} · עסקה <span dir="ltr">{u.txShort}</span>
              </div>
              <div>
                {CASHMAG_OUTCOME[u.outcome ?? ''] ?? u.outcome}
                {u.heldAgorot > 0 ? ` · במכשיר ${shekels(u.heldAgorot)}` : ''}
                {u.reason ? <span dir="ltr"> ({u.reason})</span> : null}
              </div>
              <div>בדקו במכשיר אם נשאר כסף, טפלו בלקוח, ואז סמנו "טופל" — עד אז אין תשלום ב-CashMag בקיוסק.</div>
              <Btn m={m} onClick={() => act({ type: 'cashmagAcknowledge', txId: u.txId })}>
                טופל
              </Btn>
            </div>
          ))}
          <Btn m={m} onClick={() => act({ type: 'cashmagCheck' })}>
            בדיקת חיבור לשרת CashMag
          </Btn>
        </Panel>
      ) : null}
      <Panel m={m} title="מדפסת">
        {info.printer.usb ? <div className="font-semibold">{info.printer.usb}</div> : null}
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
      {/* "היסטוריית עסקאות" and every "הדפסה חוזרת" (staff/KioskHistoryPanel.tsx, core/kioskReprint.ts): under REPRINT, recorded. */}
      <KioskHistoryPanel m={m} onDone={refresh} />
      <Panel m={m} title="דוחות Z">
        {info.zs.length === 0 ? <div>אין</div> : null}
        {info.zs.map((z) => (
          <div key={z.number} className="text-xs">
            Z מס׳ {z.number} · {new Date(z.closedAt).toLocaleString('he-IL')} · {z.state}
          </div>
        ))}
      </Panel>
      {onTechnician ? (
        <Panel m={m} title="טכנאי">
          <div className="text-xs" style={{ color: m.c.mutedText }}>
            שיוך המכשיר, רשת, מדפסת, בדיקת מסופון, עדכונים ותמיכה מרחוק — בקוד טכנאי.
          </div>
          <Btn m={m} onClick={onTechnician}>
            בדיקות ומידע קיוסק (טכנאי)
          </Btn>
        </Panel>
      ) : null}
      {/* Leaving the kiosk: the manager who opened this menu, if their role holds DESKTOP_EXIT —
          no second code; otherwise another manager's code on the pad (the desktop only). */}
      {info.desktopExit?.allowed ? (
        <div className="flex flex-wrap gap-2">
          <DesktopExitMenuButton
            label={DESKTOP_EXIT_LABEL}
            disabled={exiting}
            onOpen={async () => {
              setExiting(true);
              const r = await kiosk.adminAction({ type: 'desktopExit' }).catch((e: unknown) => ({ ok: false, message: String(e) }));
              setExiting(false);
              if (r.ok) onClose();
              else show(r);
            }}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold disabled:opacity-40"
            style={{ background: `${m.c.button}1A`, color: m.c.buttonInk, borderRadius: 8 }}
          />
          <Btn m={m} danger onClick={() => act({ type: 'exitKiosk' })}>
            יציאה מהקיוסק (סגירת התוכנה)
          </Btn>
        </div>
      ) : (
        <div className="space-y-1.5">
          <div className="text-xs" style={{ color: m.c.mutedText }}>
            {info.desktopExit?.reason ?? `נדרשת הרשאת "${PERMISSION_LABEL}"`} — יציאה מהתוכנה אינה זמינה.
          </div>
          <DesktopExitMenuButton onOpen={onDesktopExit} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold" style={{ background: `${m.c.button}1A`, color: m.c.buttonInk, borderRadius: 8 }} />
        </div>
      )}
      {/* "מצב עבודה": always a manager's code with KIOSK_TILL_MODE (checked on the device, five wrong codes lock it for a minute). */}
      {workPad !== 'none' ? (
        <div className="contents">
          <PinPad
            m={m}
            title={`${workPad === 'kiosk' ? WORK_TEXT.approveToKiosk : WORK_TEXT.approve} — קוד מנהל`}
            onCancel={() => setWorkPad('none')}
            onSubmit={(code) => (workPad === 'kiosk' ? goKiosk(code) : goTill(code))}
          />
        </div>
      ) : null}
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

function TechnicianScreen({ m, onClose, onDesktopExit }: { m: PreviewModel; onClose: () => void; onDesktopExit: () => void }) {
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
      {/* Several lines at times ("בדיקת מסופון USB": the raw replies and the framing). */}
      {note ? <div className="whitespace-pre-wrap break-words rounded-lg bg-black/5 p-2 text-center text-xs font-semibold">{note}</div> : null}
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
            {info.printer.usb ? <div className="font-semibold">{info.printer.usb}</div> : null}
            <div>{info.printer.target} · {info.printer.health}</div>
            <div className="text-xs">מדפסות Windows: {info.printer.queues.join(' · ') || '—'}</div>
            <div className="flex flex-wrap items-center gap-2">
              <Btn m={m} onClick={() => act({ type: 'setPrinter', transport: 'spooler', queueName: '' })}>
                אוטומטי (USB)
              </Btn>
              {info.printer.auto ? <span className="text-xs">נבחר: אוטומטי — מדפסת ה-USB המחוברת</span> : null}
            </div>
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
            {info.receipts ? (
              // "מדפסת לקבלות ולמסמכים": another till's printer the cloud offers this one (bill-print-other-till).
              <div className="flex flex-col gap-1">
                <div className="font-semibold">מדפסת לקבלות ולמסמכים</div>
                {info.receipts.scope ? <div className="text-xs">{info.receipts.scope}</div> : null}
                <div className="flex flex-wrap items-center gap-2">
                  {info.receipts.options.map((o) => (
                    <Btn key={o.id} m={m} onClick={() => act({ type: 'setReceiptPrinter', id: o.id })}>
                      {info.receipts!.choice === o.id ? `✓ ${o.label}` : o.label}
                    </Btn>
                  ))}
                  <Btn m={m} onClick={() => act({ type: 'setReceiptPrinter', id: null })}>
                    {info.receipts.choice === null ? '✓ ' : ''}חזור להגדרת הענן
                  </Btn>
                </div>
              </div>
            ) : null}
          </Panel>
          <Panel m={m} title="מסופון (בדיקה בלבד — בלי חיוב)">
            <div>
              {info.terminal.kind ?? 'לא מוגדר'} · {info.terminal.state}
            </div>
            <div dir="ltr" className="text-end text-xs">
              {info.terminal.address}
            </div>
            {info.terminal.numberCheckBypass ? <div className="text-xs font-semibold text-amber-700">{TERMINAL_CHECK_BYPASS_WARNING}</div> : null}
            <Btn m={m} onClick={() => act({ type: 'pinpadCheck' })}>
              {info.terminal.kind === 'nayax_usb' ? 'בדיקת מסופון USB' : 'בדיקת מסופון'}
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
          {/* "גודל תצוגה" (P:/specs/display-scale.md): the one size control, saved on this kiosk over the cloud. */}
          {info.displayScale ? (
            <Panel m={m} title={DISPLAY_SCALE_TEXT.title}>
              <DisplayScaleControl
                view={info.displayScale}
                act={(a) => void act(a)}
                button={(label, onClick, disabled) => (
                  <button
                    key={label}
                    type="button"
                    disabled={disabled}
                    onClick={onClick}
                    className="min-w-[var(--k-target,0px)] px-3 py-1.5 text-xs font-bold disabled:opacity-40"
                    style={{ background: `${m.c.button}1A`, color: m.c.buttonInk, borderRadius: 8 }}
                  >
                    {label}
                  </button>
                )}
              />
            </Panel>
          ) : null}
          <DesktopExitMenuButton onOpen={onDesktopExit} className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold" style={{ background: `${m.c.button}1A`, color: m.c.buttonInk, borderRadius: 8 }} />
          <Btn m={m} danger onClick={() => act({ type: 'unpair' })}>
            ניתוק הקיוסק מהענן
          </Btn>
        </>
      )}
    </Shell>
  );
}
