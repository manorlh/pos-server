/**
 * "איך המסך מדפיס" — a kitchen screen (KDS) or the "מוכן / לא מוכן" board that prints with nothing installed:
 * through a till of the shop, by the cloud's print relay (pos-server app/services/kds_print.py,
 * docs/SPEC_KDS.md §17). One source for the dashboard's "הדפסה" card (components/dashboard/kds/screen-print.tsx)
 * and the screen's own panel (components/screen-web/screen-print.tsx): the paths, the how-to per device,
 * the words for where a bon stands, and the bon a card prints (the cloud's `TicketIn` — the till prints it
 * as it prints any kitchen ticket, in its own "עיצוב בון").
 *
 * Pure, no `@/` imports (the node tests compile it on its own).
 */

import { isCancelled, isHeld, orderTitle } from './kdsBoard';
import type { KdsDeviceInfo, KdsOrder } from './kdsScreenTypes';

export type KdsPrintPath = 'device' | 'none' | 'relay' | 'bridge' | 'app';
/** The four the owner named, in order; `device` (unset) is "as the device did so far". */
export const KDS_PRINT_PATHS: Exclude<KdsPrintPath, 'device'>[] = ['none', 'relay', 'bridge', 'app'];

export const KDS_PRINT_PATH_LABELS: Record<KdsPrintPath, string> = {
  device: 'לפי סוג המכשיר (ברירת מחדל)',
  none: 'ללא הדפסה',
  relay: 'דרך קופה בסניף (ללא התקנה)',
  bridge: 'גשר Windows (מותקן)',
  app: 'אפליקציית אנדרואיד (מובנה)',
};

export const KDS_PRINT_PATH_HINTS: Record<Exclude<KdsPrintPath, 'device'>, string> = {
  none: 'המסך לא מדפיס. כפתור "הדפס" לא מוצג בכרטיסים.',
  relay: 'המסך שולח את הבון לקופה בסניף והיא מדפיסה במדפסת שלה. לא מתקינים כלום — עובד בכל דפדפן.',
  bridge: 'הגשר (R2M POS for Windows במצב גשר) שמותקן במחשב של המסך מדפיס במדפסת שמחוברת אליו.',
  app: 'אפליקציית R2M על טאבלט אנדרואיד או מסוף משמשת כ-KDS ומדפיסה במדפסת המובנית / המחוברת שלה.',
};

/** Where the device stands: for the how-to (pos-server kds_print.device_kind). */
export type KdsDeviceKind = 'ipad' | 'android_browser' | 'windows_browser' | 'browser' | 'android_app' | 'windows_app';

export const KDS_DEVICE_LABELS: Record<KdsDeviceKind, string> = {
  ipad: 'אייפד',
  android_browser: 'טאבלט אנדרואיד (דפדפן)',
  windows_browser: 'מחשב Windows (Chrome / Edge)',
  browser: 'דפדפן',
  android_app: 'אפליקציית אנדרואיד',
  windows_app: 'אפליקציית Windows',
};

export interface KdsHowTo {
  title: string;
  recommended: Exclude<KdsPrintPath, 'device'>;
  steps: string[];
}

/** The how-to per device, in plain Hebrew (the owner, 17.10). */
export const KDS_PRINT_HOW_TO: Record<'ipad' | 'android' | 'windows', KdsHowTo> = {
  ipad: {
    title: 'אייפד',
    recommended: 'relay',
    steps: [
      'באייפד אפשר להדפיס רק דרך קופה בסניף — אין גשר ואין אפליקציה.',
      'בחרו "דרך קופה בסניף" ואת הקופה שמדפיסה (או אוטומטי), ולחצו "הדפסת בדיקה".',
      'פתחו את המסך ב-Safari, שיתוף ← "הוסף למסך הבית", ופתחו אותו מהאייקון.',
      'לנעילת האייפד על המסך: הגדרות ← נגישות ← גישה מודרכת (Guided Access) ← הפעלה; במסך לחיצה משולשת על הכפתור הצדדי ← התחל.',
    ],
  },
  android: {
    title: 'טאבלט אנדרואיד',
    recommended: 'app',
    steps: [
      'מומלץ: אפליקציית R2M כ-KDS — מדפיסה במדפסת המובנית או המחוברת לטאבלט, גם בלי אינטרנט.',
      'בלי האפליקציה (Chrome בטאבלט): בחרו "דרך קופה בסניף" — הקופה מדפיסה, לא מתקינים כלום.',
      'ב-Chrome: תפריט ← "הוספה למסך הבית", ופתחו מהאייקון למסך מלא.',
    ],
  },
  windows: {
    title: 'מחשב Windows (Chrome)',
    recommended: 'relay',
    steps: [
      'יש מדפסת מחוברת למחשב? התקינו את הגשר (R2M POS for Windows במצב גשר) ובחרו "גשר Windows".',
      'בלי התקנה: בחרו "דרך קופה בסניף" — הבון יודפס בקופה שבחרתם.',
      'ב-Chrome / Edge: "התקנת האפליקציה" בשורת הכתובת, ופתחו מסך מלא (F11).',
    ],
  },
};

export function howToFor(kind: KdsDeviceKind | null | undefined): KdsHowTo[] {
  if (kind === 'ipad') return [KDS_PRINT_HOW_TO.ipad];
  if (kind === 'android_browser' || kind === 'android_app') return [KDS_PRINT_HOW_TO.android];
  if (kind === 'windows_browser' || kind === 'windows_app') return [KDS_PRINT_HOW_TO.windows];
  return [KDS_PRINT_HOW_TO.ipad, KDS_PRINT_HOW_TO.android, KDS_PRINT_HOW_TO.windows];
}

/** `GET /sync/{m}/kds/print` (the screen) — also the dashboard card's `status`. */
export interface KdsPrintStatus {
  path: KdsPrintPath;
  /** The path on this device (`device` resolved). */
  effectivePath: Exclude<KdsPrintPath, 'device'>;
  devicePath: 'bridge' | 'app';
  deviceKind: KdsDeviceKind;
  platform: string;
  timeoutSec: number;
  relay: KdsRelayStatus | null;
}

export interface KdsRelayStatus {
  ready: boolean;
  why: string | null;
  automatic: boolean;
  hostMachineId: string | null;
  hostName: string | null;
  hostOnline: boolean | null;
  printerId: string | null;
  printerName: string | null;
  connection: string | null;
}

/** A job as the cloud tells it (`job_view`). */
export interface KdsPrintJob {
  id: string;
  kind: string;
  status: 'pending' | 'printing' | 'done' | 'failed' | 'expired' | string;
  error: string | null;
  printerName: string | null;
  targetMachineId: string | null;
  targetMachineName: string | null;
  createdAt: string | null;
  completedAt: string | null;
  taken: boolean;
  test?: boolean;
}

const WHY: Record<string, string> = {
  off: 'המסך לא מוגדר להדפיס דרך קופה',
  kds_print_not_relay: 'המסך לא מוגדר להדפיס דרך קופה',
  remote_print_off: '"הדפסה בקופה אחרת" כבויה למסך הזה',
  no_host: 'אין בסניף קופה עם מדפסת',
  host_not_found: 'הקופה שנבחרה לא נמצאה בסניף (או שאין לה מדפסת)',
  host_not_allowed: 'הקופה לא ברשימת הקופות שמותר לשלוח אליהן',
  printer_not_found: 'המדפסת שנבחרה לא נמצאה',
  printer_out_of_scope: 'המדפסת שנבחרה שייכת לנקודת מכירה אחרת',
  not_a_screen: 'המכשיר לא מוגדר כמסך מטבח',
};

export function relayWhyText(why: string | null | undefined): string {
  return (why && WHY[why]) || 'לא ניתן להדפיס דרך קופה כרגע';
}

/** One line: where the screen's bons go now. */
export function relayLine(s: KdsPrintStatus | null): string {
  if (!s) return 'טוען…';
  if (s.effectivePath !== 'relay') return KDS_PRINT_PATH_LABELS[s.effectivePath];
  const r = s.relay;
  if (!r || !r.ready) return `דרך קופה בסניף — ${relayWhyText(r?.why)}`;
  const where = [r.hostName, r.printerName && r.printerName !== r.hostName ? r.printerName : null].filter(Boolean).join(' · ');
  return `דרך ${where}${r.automatic ? ' (אוטומטי)' : ''}${r.hostOnline === false ? ' — הקופה לא מחוברת כרגע' : ''}`;
}

/** Where a bon stands, in the screen's words. */
export type JobPhase = 'sending' | 'waiting' | 'done' | 'failed';

export function jobPhase(j: Pick<KdsPrintJob, 'status'> | null): JobPhase {
  if (!j) return 'sending';
  if (j.status === 'done') return 'done';
  if (j.status === 'failed' || j.status === 'expired') return 'failed';
  return 'waiting';
}

export function jobText(phase: JobPhase, host: string | null, error?: string | null): string {
  if (phase === 'done') return host ? `הודפס בקופה ${host}` : 'הודפס';
  if (phase === 'failed') return `לא הודפס — נסו שוב${error && error !== 'expired' && error !== 'cancelled' ? ` (${error})` : ''}`;
  if (phase === 'sending') return 'שולח להדפסה…';
  return host ? `ממתין למדפסת — ${host}` : 'ממתין למדפסת';
}

// ── The bon a KDS card prints (the cloud's `TicketIn`) ───────────────────────

export interface RelayTicketLine {
  name: string;
  quantity: number;
  notes: string | null;
  mods: string[];
  removals: string[];
  important: boolean;
  allergies: string[];
  seat: string | null;
  course: string | null;
  mealName: string | null;
}

export interface RelayTicket {
  source: 'table' | 'sale';
  tableName: string | null;
  zoneName: string | null;
  guests: number | null;
  waiterName: string | null;
  createdAt: string;
  isAddition: boolean;
  lines: RelayTicketLine[];
  orderRef: string | null;
  customerName: string | null;
  dining: 'eat_in' | 'take_away' | null;
  notice: string | null;
}

const TEXT_MAX = 200;
const NOTES_MAX = 500;
const LINES_MAX = 300;
const LIST_MAX = 40;

const clip = (s: string | null | undefined, n: number = TEXT_MAX): string | null => {
  const t = (s ?? '').trim();
  return t ? t.slice(0, n) : null;
};
const clipList = (xs: string[] | null | undefined, n: number): string[] =>
  (xs ?? []).map((x) => clip(x)).filter((x): x is string => !!x).slice(0, n);

/**
 * A card of the KDS as the till's kitchen ticket: the same lines the bridge's bon has (held and cancelled ones left
 * out), the table or the order's name as its headline, the station(s) of this screen and the order's note in the band.
 * The screen's name goes as `sourceName` from the cloud (who sent it).
 */
export function kdsRelayTicket(order: KdsOrder, ctx: { device: KdsDeviceInfo | null; now: Date }): RelayTicket {
  const table = order.source === 'table' && !!order.tableRef;
  const stations = ctx.device?.role === 'station' ? (ctx.device.stations ?? []).map((s) => s.name).filter(Boolean) : [];
  const note = clip(order.orderNote);
  const notice = clip([stations.join(' · '), note ? `הערה: ${note}` : ''].filter(Boolean).join(' · '));
  const lines = order.tasks
    .filter((t) => !isHeld(t) && !isCancelled(t))
    .slice(0, LINES_MAX)
    .map((t) => ({
      name: clip(t.name) ?? '—',
      quantity: t.activeQty,
      notes: clip(t.notes, NOTES_MAX),
      mods: clipList(t.mods, LIST_MAX),
      removals: clipList(t.removals, LIST_MAX),
      important: !!t.important,
      allergies: clipList(t.allergies, 20),
      seat: clip(t.seat),
      course: clip(t.course),
      mealName: clip(t.mealName),
    }));
  const service = order.serviceType === 'eat_in' || order.serviceType === 'take_away' ? order.serviceType : null;
  return {
    source: table ? 'table' : 'sale',
    tableName: table ? clip(order.tableRef) : null,
    zoneName: clip(order.zoneName),
    guests: order.guests && order.guests > 0 ? order.guests : null,
    waiterName: clip(order.waiterName),
    createdAt: ctx.now.toISOString(),
    isAddition: false,
    lines,
    orderRef: clip(order.displayRef ?? order.id, 100),
    customerName: table ? clip(order.pickupName) : clip(order.pickupName ?? orderTitle(order)),
    dining: service,
    notice,
  };
}
