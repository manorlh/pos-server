/**
 * "מדפסות" on the Windows till (pos-android ui/kitchen/PrintersScreen.kt, KitchenPrintService.kt `printers` / `probe` /
 * `printServerStatus`, ReceiptDefaultCard.kt, PrinterDiscoveryPanel.kt, KitchenPrintBanner.kt `stateText`; strings in
 * strings_kitchen.xml, strings_discovery.xml, strings_ticket_designs.xml): every printer this till prints to — its own (the
 * receipt printer the technician set, or the USB one found by itself) and each kitchen / bar printer from the cloud — with
 * a live light, the shop's print server, the tickets that need a person, what printed in the last 24 hours, "מדפסת לקבלות
 * ולמסמכים" and "חיפוש מדפסות ברשת".
 *
 * The light (Android `probe`): reached the way a job would go, nothing printed — a printer this till prints on directly:
 * a TCP connect (its own: its status); one the cloud relays: the cloud answers ("תקין · דרך הענן"); one the print server
 * prints: the server answers on the LAN ("תקין · דרך שרת ההדפסות"), else straight to it ("שרת ההדפסות לא זמין · מדפיס
 * ישירות", amber), else the cloud (amber). Every 30 s while the screen is open, and on "בדיקת תקשורת".
 *
 * Pure: the service (main/till/tillPrinters.ts) reads the kitchen's settings and queue and the receipt printer, this builds
 * what the screen draws.
 */

import type { KitchenConfig, KitchenPrinter, PrintHost } from '../kitchen/config';
import { ticketTitleOf } from '../kitchen/failover';
import type { KitchenJob } from '../kitchen/queue';
import { connectionOf, routeOf, TILL_PRINTER_ID } from '../kitchen/routing';
import { isTemplate, type TemplateKey } from '../kitchenTicketStyle';

export const PRINTERS_KEY = 'printers';
/** "מדפסת לקבלות ולמסמכים": a manager's change (Android TILL_SETUP_SCOPE = catalog:write). */
export const PRINTERS_SETUP_PERMISSION = 'CATALOG_WRITE';
/** How often the open screen tests every printer's connection. */
export const PROBE_EVERY_MS = 30_000;
/** "הודפסו לאחרונה": Android's `observeRecent(40)`, the last 24 hours. */
export const RECENT_LIMIT = 40;
export const RECENT_WINDOW_MS = 24 * 60 * 60_000;

/** The health's details that are words of their own (KitchenPrintService.VIA_CLOUD …). */
export const VIA_CLOUD = 'via the cloud';
export const VIA_LAN = 'via the print server';
export const LAN_DOWN_VIA_CLOUD = 'print server not reached on the LAN — via the cloud';
export const LAN_DOWN_DIRECT = 'print server not reached on the LAN — printing directly';

/** Android's words. */
export const PRINTERS_TEXT = {
  title: 'מדפסות',
  back: 'חזרה',
  queueTitle: 'בונים שממתינים לטיפול',
  listTitle: 'המדפסות של הקופה',
  historyTitle: 'הודפסו לאחרונה (24 שעות)',
  statusOk: 'תקין',
  statusChecking: 'בודק…',
  statusNoAnswer: 'לא מגיב',
  statusFault: (detail: string) => `תקלה: ${detail}`,
  statusQueue: (n: number) => `ממתין בתור ${n}`,
  statusViaCloud: 'תקין · דרך הענן',
  statusViaHost: 'תקין · דרך שרת ההדפסות',
  statusHostDown: 'שרת ההדפסות לא זמין · נשלח דרך הענן',
  statusDirect: 'שרת ההדפסות לא זמין · מדפיס ישירות',
  check: 'בדיקת תקשורת',
  testTicket: 'בון בדיקה',
  testSent: (name: string) => `בון בדיקה נשלח ל־${name}`,
  reprint: 'הדפס שוב',
  none: 'לא הוגדרו מדפסות בונים לקופה הזו. מגדירים בענן: הגדרות ← מדפסות בונים.',
  own: 'מדפסת הקופה',
  serverTitle: 'שרת הדפסות',
  serverSelf: (address: string) => `הקופה הזו היא שרת ההדפסות של הסניף · מאזינה ב־${address}`,
  serverSelfOff: 'הקופה הזו היא שרת ההדפסות — אבל אינה מחוברת כעת לרשת המקומית (Wi-Fi)',
  serverOther: (name: string, address: string) => `שרת ההדפסות: ${name} · ${address}`,
  serverReachable: 'זמין ברשת — הבונים נשלחים אליו',
  serverUnreachable: 'לא זמין ברשת — מדפיסים ישירות כשאפשר, אחרת דרך הענן',
  serverNotLan: 'הקופה לא מחוברת ל-Wi-Fi — הבונים יוצאים ישירות או דרך הענן',
  serverNoAddress: 'כתובת עוד לא ידועה',
  widthTest: 'בדיקת רוחב',
  widthTestSent: (name: string) => `בדיקת רוחב נשלחה ל-${name}: הרוחב הנכון הוא המסגרת הרחבה ביותר שיצאה ישרה ושלמה (מגדירים בדשבורד: "רוחב הדפסה").`,
  widthDots: (n: number) => `${n} נקודות`,
  testDesign: 'הדפסת ניסיון בעיצוב הזה',
  testDesignSent: (name: string) => `בון לדוגמה נשלח ל־${name}`,
  design: (name: string) => `עיצוב בון: ${name}`,
  designInherit: 'לפי ההגדרה הכללית',
  designs: { classic: 'קלאסי', classic_legacy: 'קלאסי (ישן)', large: 'גדול וברור', compact: 'חסכוני', courses: 'לפי קורסים ומושבים', modern: 'מודרני' } satisfies Record<TemplateKey, string>,
  typeNetwork: (where: string) => `רשת · ${where}`,
  typeBluetooth: (what: string) => `Bluetooth · ${what}`,
  typeBluetoothUnset: 'Bluetooth · לא נבחר מכשיר',
  typeCloud: 'דרך הענן',
  typeCloudHost: 'דרך הענן — הקופה הזו מדפיסה',
  typeTill: 'מדפסת הקופה',
  typeUsb: 'USB · מדפסת על הקופה',
  typeHost: (server: string, reach: string) => `דרך שרת ההדפסות (${server}) · ${reach}`,
  typeHostHere: 'הקופה הזו מדפיסה עבור כל הקופות',
  stateWaiting: (attempt: number) => `ממתין — מנסה שוב (ניסיון ${attempt})`,
  stateFailed: 'לא הודפס',
  stateRelayed: 'נשלח לקופה המארחת',
  stateDone: 'הודפס',
  statePending: 'ממתין',
  stateSlow: 'נשלח לשרת ההדפסות ועוד לא הודפס (יותר מדקה)',
  stateHostSilent: 'שרת ההדפסות לא עונה — לא ידוע אם הודפס',
  actionRetry: 'נסה שוב',
  actionOther: 'מדפסת אחרת',
  actionTill: 'הדפס בקופה',
  actionDismiss: 'בטל בון',
  pickPrinter: 'בחרו מדפסת',
  noOtherPrinter: 'אין מדפסת אחרת לקופה הזו',
  close: 'סגור',
  /* "מדפסת לקבלות ולמסמכים" (ReceiptDefaultCard.kt) */
  receiptTitle: 'מדפסת לקבלות ולמסמכים',
  receiptHint: 'קבלות, העתקים, שוברים וחשבונות שולחן — בקופה הזו. לדוחות יש מדפסת משלהם.',
  receiptAsk: 'לשאול בכל פעם',
  receiptNow: (name: string) => `הקבלות מודפסות כעת: ${name}`,
  receiptOverride: 'נבחר בקופה — עוקף את הגדרת הענן',
  receiptBackToCloud: 'חזור להגדרת הענן',
  receiptFollowsCloud: 'לפי הגדרת הענן',
  receiptGone: 'המדפסת שנבחרה בקופה כבר אינה זמינה — בינתיים לפי הגדרת הענן',
  receiptChangeApproval: (name: string) => `שינוי מדפסת הקבלות של הקופה: ${name}`,
  noReceiptPrinter: 'לא הוגדרה מדפסת לקבלות',
  /* "חיפוש מדפסות ברשת" (PrinterDiscoveryPanel.kt, strings_discovery.xml) */
  discoveryTitle: 'חיפוש מדפסות ברשת',
  discoveryAgain: 'חיפוש מחדש',
  discoveryStop: 'הפסק',
  discoveryHint: 'הקופה סורקת את הרשת המקומית (Wi‑Fi / Ethernet) ומוצאת מדפסות קבלה ומטבח שאפשר להוסיף לסניף.',
  discoveryScanningStart: 'מתחיל סריקה…',
  discoveryNotOnLan: 'הקופה לא מחוברת לרשת מקומית (Wi‑Fi או Ethernet) — אין מה לסרוק.',
  discoveryCancelled: 'הסריקה הופסקה.',
  discoveryFailed: (why: string) => `הסריקה נכשלה: ${why}`,
  discoveryNone: (subnet: string) => `לא נמצאו מדפסות ב-${subnet}. בדקו שהמדפסת דולקת ומחוברת לאותה רשת של הקופה.`,
  discoveryDone: (n: number, subnet: string, sec: number) => `נמצאו ${n} ב-${subnet} (${sec} שנ׳)`,
  discoveryKindEscpos: 'מדפסת ESC/POS',
  discoveryKindUnknown: 'לא ענתה לבדיקת ESC/POS — אפשר לנסות דף בדיקה',
  discoveryPaperOk: 'נייר תקין',
  discoveryPaperNear: 'הנייר עומד להיגמר',
  discoveryPaperOut: 'אין נייר',
  discoveryOffline: 'המדפסת מדווחת על תקלה',
  discoveryConfigured: (name: string) => `כבר מוגדרת: ${name}`,
  discoveryUnnamed: 'מדפסת',
  discoveryAdd: 'הוספה',
  discoveryAddTitle: (host: string) => `הוספת מדפסת ${host}`,
  discoveryAddName: 'שם המדפסת',
  discoveryAddPurpose: 'סוג המדפסת',
  discoveryPurposeKitchen: 'מדפסת מטבח / בר (בונים)',
  discoveryPurposeReceipt: 'מדפסת חשבוניות (קבלות)',
  discoveryAddHint: 'המדפסת תתווסף לכל הקופות בסניף, עם הגדרות ההדפסה של הסניף. מה מודפס בה (ניתוב הבונים) — בדשבורד, בדף "מדפסות".',
  discoveryAdded: (name: string) => `המדפסת ${name} נוספה לסניף`,
  discoveryAddExists: 'המדפסת כבר מוגדרת בסניף',
  discoveryAddOffline: 'אין חיבור לענן — נסו שוב',
  discoveryAddRefused: (why: string) => `לא נוספה: ${why}`,
  discoveryAddReason: 'הוספת מדפסת לסניף',
  managerCode: 'קוד מנהל',
  approve: 'אישור',
  cancel: 'ביטול',
  /* the own printer's faults (the Windows printer's health, in the till's words — core/till/tillAlerts.ts) */
  faultNoPaper: 'אין נייר',
  faultCoverOpen: 'המכסה פתוח',
  faultPaperLow: 'הנייר עומד להיגמר',
  faultError: 'תקלת מדפסת',
  faultNotFound: 'אוטומטי — לא נמצאה מדפסת',
  notReachable: 'המדפסת לא נגישה מהקופה הזו',
} as const;

/* ------------------------------------------------------------------ health */

export type HealthLevel = 'ok' | 'warn' | 'error';

/** One printer's last connection test (Android KitchenPrinterHealth). */
export interface PrinterHealthRec {
  level: HealthLevel;
  at: number;
  /** VIA_CLOUD / VIA_LAN / LAN_DOWN_* (their own words), or a fault's words; null — nothing to add. */
  detail: string | null;
}

/** The dot: none (not tested yet) / green / amber / red (PrintersScreen.colorOf). */
export type PrinterLight = 'none' | 'ok' | 'warn' | 'error';

export function lightOf(h: PrinterHealthRec | null | undefined, queued: number): PrinterLight {
  if (!h) return 'none';
  if (h.level === 'error') return 'error';
  if (h.level === 'warn' || queued > 0) return 'warn';
  return 'ok';
}

/** The printer's status in words (PrintersScreen.statusText). */
export function statusTextOf(h: PrinterHealthRec | null | undefined, queued: number): string {
  if (!h) return PRINTERS_TEXT.statusChecking;
  if (h.level === 'error') return h.detail ? PRINTERS_TEXT.statusFault(h.detail) : PRINTERS_TEXT.statusNoAnswer;
  if (queued > 0) return PRINTERS_TEXT.statusQueue(queued);
  if (h.detail === VIA_CLOUD) return PRINTERS_TEXT.statusViaCloud;
  if (h.detail === VIA_LAN) return PRINTERS_TEXT.statusViaHost;
  if (h.detail === LAN_DOWN_DIRECT) return PRINTERS_TEXT.statusDirect;
  if (h.level === 'warn') return PRINTERS_TEXT.statusHostDown;
  return PRINTERS_TEXT.statusOk;
}

/** The Windows receipt printer's health (main/printer/transports.ts PrinterHealth) as a light. */
export function ownHealthOf(health: string, found: boolean): { level: HealthLevel; detail: string | null } {
  if (!found) return { level: 'error', detail: PRINTERS_TEXT.faultNotFound };
  switch (health) {
    case 'ok':
    case 'unknown':
      return { level: 'ok', detail: null };
    case 'paper_low':
      return { level: 'warn', detail: PRINTERS_TEXT.faultPaperLow };
    case 'no_paper':
      return { level: 'error', detail: PRINTERS_TEXT.faultNoPaper };
    case 'cover_open':
      return { level: 'error', detail: PRINTERS_TEXT.faultCoverOpen };
    case 'offline':
    case 'unavailable':
      return { level: 'error', detail: null };
    default:
      return { level: 'error', detail: PRINTERS_TEXT.faultError };
  }
}

/** How a printer is tested from this till (Android `probe`): its route and, printed here, its connection. */
export type ProbePlan =
  | { kind: 'own' }
  | { kind: 'cloud' }
  | { kind: 'lan'; directHost: { host: string; port: number } | null }
  | { kind: 'tcp'; host: string; port: number }
  | { kind: 'unreachable'; why: string };

export function probePlanOf(p: KitchenPrinter, printHost: PrintHost | null): ProbePlan {
  if (p.id === TILL_PRINTER_ID) return { kind: 'own' };
  const route = routeOf(p, printHost);
  // Reached here too (the print server's fallback): a network printer with an address.
  const direct = p.type === 'network' && p.host ? { host: p.host, port: p.port ?? 9100 } : null;
  if (route === 'RELAY') return { kind: 'cloud' };
  if (route === 'LAN') return { kind: 'lan', directHost: direct };
  const c = connectionOf(p);
  if (c === 'network') return p.host ? { kind: 'tcp', host: p.host, port: p.port ?? 9100 } : { kind: 'unreachable', why: 'printer has no address' };
  if (c === 'till' || c === 'usb') return { kind: 'own' };
  return { kind: 'unreachable', why: PRINTERS_TEXT.notReachable };
}

/* ------------------------------------------------------------------ the list */

/** The printers this till prints to (KitchenPrintService.printers): its own, then the cloud's in scope, hosted, or a zone's target. */
export function tillPrinters(config: KitchenConfig, own: KitchenPrinter | null): KitchenPrinter[] {
  const zoneTargets = new Set<string>();
  for (const m of Object.values(config.zoneRedirects ?? {})) for (const to of Object.values(m ?? {})) zoneTargets.add(to);
  return [...(own ? [own] : []), ...config.printers.filter((p) => p.inScope || p.isHost || zoneTargets.has(p.id))];
}

/** "רשת · 192.168.1.40:9100", "דרך שרת ההדפסות (בר) · …", "מדפסת הקופה" (PrintersScreen.describe). */
export function describePrinter(p: KitchenPrinter, printHost: PrintHost | null): string {
  if (p.id === TILL_PRINTER_ID) return PRINTERS_TEXT.own;
  const T = PRINTERS_TEXT;
  const width = p.printWidthDots ? ` · ${T.widthDots(p.printWidthDots)}` : '';
  const addr = `${p.host ?? ''}:${p.port ?? 9100}`;
  let reach: string;
  if (p.type === 'network') reach = T.typeNetwork(addr);
  else if (p.type === 'bluetooth') reach = p.btAddress ? T.typeBluetooth([p.btName, p.btAddress].filter(Boolean).join(' ')) : T.typeBluetoothUnset;
  else if (p.type === 'cloud') {
    const c = connectionOf(p);
    reach = c === 'network' ? T.typeNetwork(addr) : c === 'bluetooth' ? T.typeBluetooth(p.btName ?? p.btAddress ?? '') : c === 'usb' ? T.typeUsb : T.typeTill;
  } else reach = T.typeTill;
  const route = routeOf(p, printHost);
  let text: string;
  if (route === 'RELAY') text = T.typeCloud;
  else if (route === 'LAN') text = T.typeHost((p.type === 'cloud' ? p.hostMachineName : null) ?? printHost?.name ?? '', reach);
  else if (p.type === 'cloud') text = `${T.typeCloudHost} · ${reach}`;
  else if (p.isHost && printHost?.isSelf === true) text = `${reach} · ${T.typeHostHere}`;
  else text = reach;
  return text + width;
}

/** The printer's ticket design (Android KitchenTicketStyles.templateOf): its own, or "לפי ההגדרה הכללית". */
export function designNameOf(p: KitchenPrinter): string {
  const t = p.ticketStyle && typeof p.ticketStyle.template === 'string' ? p.ticketStyle.template : p.ticketDesign;
  return isTemplate(t) ? PRINTERS_TEXT.designs[t] : PRINTERS_TEXT.designInherit;
}

/** "בדיקת רוחב": on a printer this till reaches itself over the network (Windows prints no kitchen ticket by Bluetooth / USB). */
export function widthTestOffered(p: KitchenPrinter): boolean {
  return p.id !== TILL_PRINTER_ID && connectionOf(p) === 'network' && !!p.host;
}

/** A ticket's state in words (KitchenPrintBanner.stateText). */
export function jobStateText(job: Pick<KitchenJob, 'state' | 'lastError' | 'attempts'>): string {
  const T = PRINTERS_TEXT;
  switch (job.state) {
    case 'failed':
      return T.stateFailed;
    case 'relayed':
      return job.lastError === 'slow' ? T.stateSlow : job.lastError !== null ? T.stateHostSilent : T.stateRelayed;
    case 'done':
      return T.stateDone;
    default:
      return job.attempts > 0 ? T.stateWaiting(job.attempts + 1) : T.statePending;
  }
}

const two = (n: number) => String(n).padStart(2, '0');
export const hhmmOf = (ms: number) => {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
};

/** printer id → jobs still to print for it (Android `waiting`). */
export function waitingByPrinter(open: readonly KitchenJob[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const j of open) {
    if (j.dismissed !== 0 || !(j.state === 'pending' || j.state === 'printing' || j.state === 'sending')) continue;
    m.set(j.printerId, (m.get(j.printerId) ?? 0) + 1);
  }
  return m;
}

/* ------------------------------------------------------------------ the print server */

export interface PrintServerFacts {
  name: string | null;
  self: boolean;
  /** "192.168.1.20:8399"; null — unknown. */
  address: string | null;
  onLan: boolean;
  reachable: boolean;
}

export interface PrintServerView {
  light: PrinterLight;
  title: string;
  text: string;
  /** Another till's server: whether the tickets reach it. */
  sub: string | null;
}

export function printServerView(s: PrintServerFacts): PrintServerView {
  const T = PRINTERS_TEXT;
  const address = s.address ?? T.serverNoAddress;
  const light: PrinterLight = s.reachable ? 'ok' : s.self || !s.onLan ? 'warn' : 'error';
  const text = s.self && s.onLan ? T.serverSelf(address) : s.self ? T.serverSelfOff : T.serverOther(s.name ?? '', address);
  const sub = s.self ? null : !s.onLan ? T.serverNotLan : s.reachable ? T.serverReachable : T.serverUnreachable;
  return { light, title: T.serverTitle, text, sub };
}

/* ------------------------------------------------------------------ discovery */

export interface FoundPrinterFacts {
  host: string;
  port: number;
  /** The status asked over DLE EOT (main/printer/transports.ts PrinterHealth); `unknown` — no ESC/POS answer. */
  health: string;
  /** The shop's printer at that address already, by name. */
  known: string | null;
}

export interface FoundPrinterView {
  key: string;
  host: string;
  port: number;
  title: string;
  kind: string;
  paper: string | null;
  known: string | null;
  canAdd: boolean;
  /** "הוספת מדפסת 192.168.1.40". */
  addTitle: string;
}

export function foundPrinterView(f: FoundPrinterFacts): FoundPrinterView {
  const T = PRINTERS_TEXT;
  const escpos = f.health !== 'unknown';
  const paper = !escpos
    ? null
    : f.health === 'ok'
      ? T.discoveryPaperOk
      : f.health === 'paper_low'
        ? T.discoveryPaperNear
        : f.health === 'no_paper'
          ? T.discoveryPaperOut
          : T.discoveryOffline;
  return {
    key: `${f.host}:${f.port}`,
    host: f.host,
    port: f.port,
    title: `${T.discoveryUnnamed} · ${f.host}:${f.port}`,
    kind: escpos ? T.discoveryKindEscpos : T.discoveryKindUnknown,
    paper,
    known: f.known ? T.discoveryConfigured(f.known) : null,
    canAdd: !f.known,
    addTitle: T.discoveryAddTitle(f.host),
  };
}

/** The cloud's refusal of "הוספה" in Android's words. */
export function addRefusalText(status: number | null, detail: string | null): string {
  if (status === null) return PRINTERS_TEXT.discoveryAddOffline;
  if (detail === 'printer_already_configured' || status === 409) return PRINTERS_TEXT.discoveryAddExists;
  return PRINTERS_TEXT.discoveryAddRefused(detail ?? `HTTP ${status}`);
}

/* ------------------------------------------------------------------ the screen's state */

export interface PrinterRowView {
  id: string;
  name: string;
  light: PrinterLight;
  /** "רשת · 192.168.1.40:9100" / "מדפסת הקופה · Windows: EPSON TM-T20 (USB · אוטומטי)". */
  where: string;
  /** "מדפסת USB: …" under this till's own printer. */
  usb: string | null;
  /** "עיצוב בון: גדול וברור" — a kitchen printer only. */
  design: string | null;
  status: string;
  checking: boolean;
  widthTest: boolean;
  designTest: boolean;
}

export interface QueueRowView {
  id: string;
  /** "שולחן 12 · בר". */
  title: string;
  /** "לא הודפס — no_paper: …". */
  state: string;
  canMove: boolean;
  /** "הדפס בקופה": not on this till's printer already. */
  canTill: boolean;
}

export interface ReceiptChoiceView {
  title: string;
  hint: string;
  now: string;
  /** "נבחר בקופה — עוקף את הגדרת הענן" with "חזור להגדרת הענן"; null — "לפי הגדרת הענן". */
  override: string | null;
  followsCloud: string | null;
  backLabel: string;
  gone: string | null;
  options: Array<{ id: string; label: string; on: boolean }>;
}

export interface DiscoveryView {
  title: string;
  hint: string;
  scanning: boolean;
  startLabel: string;
  stopLabel: string;
  text: string | null;
  found: FoundPrinterView[];
  add: {
    label: string;
    name: string;
    purpose: string;
    kitchen: string;
    receipt: string;
    hint: string;
    cancel: string;
  };
}

/** What the "מדפסות" screen draws (the TillState's `printers`). */
export interface PrintersState {
  title: string;
  queue: { title: string; rows: QueueRowView[] } | null;
  server: PrintServerView | null;
  receipt: ReceiptChoiceView;
  listTitle: string;
  rows: PrinterRowView[];
  /** "לא הוגדרו מדפסות בונים לקופה הזו…" — none but this till's own. */
  none: string | null;
  message: string | null;
  history: { title: string; rows: Array<{ id: string; text: string }> } | null;
  discovery: DiscoveryView | null;
  labels: {
    check: string;
    testTicket: string;
    testDesign: string;
    widthTest: string;
    reprint: string;
    retry: string;
    other: string;
    till: string;
    dismiss: string;
  };
}

export const PRINTERS_LABELS: PrintersState['labels'] = {
  check: PRINTERS_TEXT.check,
  testTicket: PRINTERS_TEXT.testTicket,
  testDesign: PRINTERS_TEXT.testDesign,
  widthTest: PRINTERS_TEXT.widthTest,
  reprint: PRINTERS_TEXT.reprint,
  retry: PRINTERS_TEXT.actionRetry,
  other: PRINTERS_TEXT.actionOther,
  till: PRINTERS_TEXT.actionTill,
  dismiss: PRINTERS_TEXT.actionDismiss,
};

/** The tickets that need a person, the oldest first, with what can be done about each. */
export function queueRowsOf(attention: readonly KitchenJob[], mayMove: (j: KitchenJob) => boolean): QueueRowView[] {
  return attention
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((j) => ({
      id: j.id,
      title: `${ticketTitleOf(j)} · ${j.printerName}`,
      state: jobStateText(j) + (j.lastError ? ` — ${j.lastError}` : ''),
      canMove: mayMove(j),
      canTill: mayMove(j) && j.printerId !== TILL_PRINTER_ID,
    }));
}

/** "הודפסו לאחרונה (24 שעות)": printed tickets, newest first — "<title> · <printer> · 21:14". */
export function historyRowsOf(recent: readonly KitchenJob[], now: number): Array<{ id: string; text: string }> {
  return recent
    .filter((j) => j.state === 'done' && now - (j.finishedAt ?? j.updatedAt) <= RECENT_WINDOW_MS)
    .slice(0, RECENT_LIMIT)
    .map((j) => ({ id: j.id, text: `${ticketTitleOf(j)} · ${j.printerName} · ${hhmmOf(j.finishedAt ?? j.updatedAt)}` }));
}
