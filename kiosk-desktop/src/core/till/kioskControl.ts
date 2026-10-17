/**
 * "קיוסקים" — a controlling till's panel of its kiosks, as the Android till's (pos-android ui/kiosk/KioskControl.kt,
 * KioskControlPanels.kt, KioskZPanel.kt; pos-server app/services/kiosk_control.py `summaries`, routers/kiosks.py
 * `POST /sync/{m}/kiosks/{k}/commands`): the kiosks `kiosk/sync` names in `controls`, each with its state (running or
 * locked — by whom, since, until —, online, the screen it is on, today's orders, its printers, unprinted bons, open alerts)
 * and its actions: "נעילה למכירה" / "פתח עכשיו" (KIOSK_CONTROL — the cloud checks the approving manager again), "הדפס עכשיו"
 * / "סמן כטופל" on an unprinted bon, "הדפס שוב את הבון האחרון" / "הדפס עסקה אחרונה", and by the kiosk's Z mode "סגירת משמרת"
 * (the shop's Z) or "הפקת Z" (its own, a manager's). The schedule ("פתיחה אוטומטית"), the kiosk's history and its blocks are
 * phase 2 (P:/specs/windows-till-menu-parity.md). Pure.
 */

import { formatShekelSign } from '../money';
import type { KioskControlRow } from '../../shared/till/protocol';

export type { KioskControlRow };

export const KIOSK_CONTROL_TEXT = {
  menu: 'קיוסקים',
  menuSub: (n: number) => `${n} בשליטת הקופה`,
  title: 'קיוסקים',
  online: 'מחובר',
  offline: 'לא מחובר',
  lastSeen: (t: string) => `נראה לאחרונה: ${t}`,
  paused: 'מושהה',
  running: 'פעיל',
  orders: (n: number, sum: string) => `היום: ${n} הזמנות · ${sum}`,
  printer: (receipt: string, bon: string) => `קבלות: ${receipt} · בונים: ${bon}`,
  unprinted: (n: number) => `${n} בונים ממתינים או נכשלו`,
  unprintedOrder: (label: string) => `בון לא הודפס: הזמנה ${label}`,
  alerts: (list: string) => `התראות פתוחות: ${list}`,
  printNow: 'הדפס עכשיו',
  markHandled: 'סמן כטופל',
  lastBon: 'הדפס שוב את הבון האחרון',
  lastSale: 'הדפס עסקה אחרונה',
  locked: 'נעול למכירה',
  lockedBy: (who: string, at: string) => `ננעל ע״י ${who} · ${at}`,
  lockedManual: 'עד פתיחה ידנית',
  lockedUntil: (t: string) => `עד ${t}`,
  lockedUntilOpening: (t: string) => `עד הפתיחה האוטומטית: ${t}`,
  reopen: 'פתח עכשיו',
  lock: 'נעילה למכירה',
  lockTitle: 'נעילה למכירה — הקיוסק יפסיק לקבל הזמנות (לקוח באמצע תשלום מסיים קודם)',
  lockModeManual: 'עד פתיחה ידנית',
  lockModeMinutes: 'למשך דקות',
  lockMinutes: 'דקות',
  lockNow: 'נעל עכשיו',
  pauseMessage: 'הודעה ללקוחות (לא חובה)',
  closeShift: 'סגירת משמרת',
  tillZ: 'הפקת Z',
  noOpenShift: 'אין משמרת פתוחה בקיוסק',
  done: 'בוצע',
  sent: 'נשלח לקיוסק — יבוצע כשאין תשלום פתוח',
  sentZ: 'נשלח לקיוסק — ה-Z יופק כשאין תשלום פתוח',
  refused: (why: string) => `הפעולה נדחתה: ${why}`,
  notAllowed: 'הקופה הזו לא מורשית לשלוט בקיוסק הזה',
  offlineError: 'אין חיבור לענן — הפעולה לא בוצעה',
  none: 'אין קיוסקים בשליטת הקופה',
  refresh: 'רענון',
  unknown: 'לא ידוע',
  flowAttract: 'מסך פתיחה',
  flowOrdering: 'לקוח מזמין',
  flowPaying: 'בתשלום',
  approve: 'אישור מנהל לשליטה בקיוסק',
} as const;

export type KioskAction = 'pause' | 'resume' | 'close_shift' | 'till_z' | 'bon_print' | 'bon_handled' | 'reprint_bon' | 'reprint_receipt';


const pad = (n: number) => String(n).padStart(2, '0');
/** `14:05`, or `17/10 14:05` with the day. */
export function kioskClock(iso: unknown, withDay = false): string | null {
  if (typeof iso !== 'string' || !iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return withDay ? `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${hm}` : hm;
}

function flowText(flow: unknown): string {
  switch (flow) {
    case 'attract':
    case 'paused':
    case 'closed':
    case 'setup':
      return KIOSK_CONTROL_TEXT.flowAttract;
    case 'paying':
    case 'pay':
      return KIOSK_CONTROL_TEXT.flowPaying;
    default:
      return KIOSK_CONTROL_TEXT.flowOrdering;
  }
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** The kiosks `kiosk/sync` says this till controls (its `controls`), as rows. Anything unreadable is left out. */
export function kioskControlRows(controls: unknown): KioskControlRow[] {
  if (!Array.isArray(controls)) return [];
  const rows: KioskControlRow[] = [];
  for (const raw of controls) {
    if (!raw || typeof raw !== 'object') continue;
    const k = raw as Record<string, unknown>;
    const id = str(k.machineId);
    if (!id) continue;
    const paused = k.paused === true;
    const online = k.online === true;
    const seen = kioskClock(k.lastSeenAt);
    const stateLine = [paused ? KIOSK_CONTROL_TEXT.paused : KIOSK_CONTROL_TEXT.running, online ? KIOSK_CONTROL_TEXT.online : KIOSK_CONTROL_TEXT.offline, online && !paused ? flowText(k.flowState) : null, !online && seen ? KIOSK_CONTROL_TEXT.lastSeen(seen) : null]
      .filter(Boolean)
      .join(' · ');
    const unprinted = num(k.unprintedBons);
    const alerts = Array.isArray(k.alerts) ? (k.alerts as unknown[]).map((a) => (a && typeof a === 'object' ? str((a as Record<string, unknown>).text) ?? str((a as Record<string, unknown>).kind) : str(a))).filter((x): x is string => !!x) : [];
    const orders = Array.isArray(k.unprintedOrders)
      ? (k.unprintedOrders as unknown[]).flatMap((o) => {
          if (!o || typeof o !== 'object') return [];
          const r = o as Record<string, unknown>;
          const localId = str(r.localId);
          if (!localId) return [];
          return [{ localId, text: KIOSK_CONTROL_TEXT.unprintedOrder(str(r.label) ?? str(r.pickupLabel) ?? localId) }];
        })
      : [];
    const until = paused
      ? k.pausedUntil == null
        ? KIOSK_CONTROL_TEXT.lockedManual
        : k.pausedMode === 'next_open'
          ? KIOSK_CONTROL_TEXT.lockedUntilOpening(kioskClock(k.pausedUntil, true) ?? '')
          : KIOSK_CONTROL_TEXT.lockedUntil(kioskClock(k.pausedUntil, true) ?? '')
      : null;
    const ownZ = k.zMode === 'till';
    const shiftOpen = k.shiftOpen === true;
    rows.push({
      machineId: id,
      name: str(k.name) ?? str(k.machineName) ?? id,
      online,
      stateLine,
      ordersLine: KIOSK_CONTROL_TEXT.orders(num(k.ordersToday), formatShekelSign(num(k.salesTodayAgorot))),
      printerLine: KIOSK_CONTROL_TEXT.printer(str(k.printerStatus) ?? KIOSK_CONTROL_TEXT.unknown, str(k.bonPrinter) ?? KIOSK_CONTROL_TEXT.unknown),
      unprintedLine: unprinted > 0 ? KIOSK_CONTROL_TEXT.unprinted(unprinted) : null,
      alertsLine: alerts.length > 0 ? KIOSK_CONTROL_TEXT.alerts(alerts.join(' · ')) : null,
      unprintedOrders: orders,
      locked: paused ? { by: KIOSK_CONTROL_TEXT.lockedBy(str(k.pausedBy) ?? '—', kioskClock(k.pausedAt) ?? '—'), until: until ?? '' } : null,
      z: shiftOpen || ownZ ? { action: ownZ ? 'till_z' : 'close_shift', label: ownZ ? KIOSK_CONTROL_TEXT.tillZ : KIOSK_CONTROL_TEXT.closeShift } : null,
      zNote: !shiftOpen && !ownZ ? KIOSK_CONTROL_TEXT.noOpenShift : null,
    });
  }
  return rows;
}

/** The cloud's answer to a command, in the panel's words. */
export function kioskCommandText(action: KioskAction, reply: { kind: 'ok' } | { kind: 'offline' } | { kind: 'refused'; status: number; code: string | null; message: string | null }): { text: string; ok: boolean } {
  if (reply.kind === 'offline') return { text: KIOSK_CONTROL_TEXT.offlineError, ok: false };
  if (reply.kind === 'refused') {
    if (reply.code === 'not_kiosk_controller') return { text: KIOSK_CONTROL_TEXT.notAllowed, ok: false };
    return { text: KIOSK_CONTROL_TEXT.refused(reply.message ?? reply.code ?? String(reply.status)), ok: false };
  }
  if (action === 'pause' || action === 'resume') return { text: KIOSK_CONTROL_TEXT.done, ok: true };
  return { text: action === 'till_z' ? KIOSK_CONTROL_TEXT.sentZ : KIOSK_CONTROL_TEXT.sent, ok: true };
}

/** A refusal's code and words, from the body the cloud sent (`{code, message}` or FastAPI's `{detail: …}`). */
export function refusalOf(body: unknown, detail: string | null): { code: string | null; message: string | null } {
  const b = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const d = b.detail && typeof b.detail === 'object' ? (b.detail as Record<string, unknown>) : b;
  return { code: str(d.code) ?? str(b.code), message: str(d.message) ?? str(b.message) ?? (typeof b.detail === 'string' ? b.detail : null) ?? detail };
}
