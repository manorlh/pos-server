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
import type { PreviewModel } from '@kiosk-shared/index';
import type { AdminActionResult, AdminInfo, KioskView } from '../../shared/bridge';
import { TERMINAL_CHECK_BYPASS_WARNING } from '../../core/terminalCheckBypass';
import { kiosk } from '../bridge';
import { t } from '../i18n';
import { DESKTOP_EXIT_LABEL, DesktopExitButton, DesktopExitMenuButton, DesktopExitPad } from '../desktop/DesktopExit';
import { PERMISSION_LABEL } from '../../core/desktopExit';
import { WORK_TEXT } from '../../core/workMode';
import { WorkModePanel } from './WorkModePanel';
import { KioskZPanel } from './KioskZPanel';
import { KioskHistoryPanel } from './KioskHistoryPanel';
import { answered, Btn, NoteBar, Panel, PinPad, Shell, SynqpayPairing, shekels, time, useNote } from './staffParts';
import { TechnicianScreen } from '../technician/TechnicianScreen';

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
    // "אין נייר במדפסת" (core/printerPaper.ts) said as it is; any other fault as "תקלת מדפסת".
    view.staff.printer === 'no_paper' ? t('staffNoPaper') : view.staff.printer !== 'ok' && view.staff.printer !== 'unknown' && view.staff.printer !== 'paper_low' ? t('staffPrinter') : null,
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
    show(await answered(kiosk.adminAction(a)));
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
      <NoteBar m={m} note={note} />
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
