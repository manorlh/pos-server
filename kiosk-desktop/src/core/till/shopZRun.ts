/**
 * "סגירת Z סניפי" on the Windows till — the shop's Z run from its master till (pos-android ui/reports/ShopZScreen.kt,
 * ShopZLogic.kt, data/remote/ShopZDtos.kt; pos-server app/routers/till_shop_z.py): every till of the shop and its state; one
 * command closes them all and the cloud produces the shop Z (its run sends each open till the close and waits for it); a till
 * that does not close can be gone without — the operator types "סגור" and its shift moves to the next Z. The Z prints here
 * when built: the summary, then each till's detail apart if asked. Online only: the Z is made — and numbered — in the cloud,
 * so the shop's Z numbers stay strictly in sequence (no jumps, no holes); this till never numbers one.
 *
 *  - The menu row (`shop_z`, Android PosNavigation.kt / domain/MainTill.kt / IndependentTill.showsShopZ): at the top, open
 *    till or closed, on a till that is not independent, not in `zMode = till` (nor in training), and whose parameters say
 *    `mainTill` or `shopZMasterTill` on, or `shopZFrom` = «כל קופה בסניף והדשבורד». No permission of the role: the cloud
 *    decides who may run it (Android DeniedMenu.destPermission: "סגירת Z סניפי" is the cloud's, not the role's).
 *  - "Z לנקודת מכירה" (P:/specs/chain-areas.md §11.2a; pos-android ShopZLogic.kt on the area branch): feature-detected — a
 *    cloud that knows it says `scope` and `areaZ` on `GET shop-z`; the choice "כל הסניף / <נקודה>" is offered only when this
 *    till may run both. An older cloud: the shop's Z only, no choice.
 *  - Local mode (a shop whose Z its main till numbers on the LAN, pos-server SPEC_INDEPENDENT_TILL §8): not on Windows — see
 *    `SHOP_Z_TEXT.localBody`; the cloud refuses its own run there too (409 `shop_z_producer_local`).
 *
 * Pure: the cloud's answers in, the screen's view out.
 */

/* ------------------------------------------------------------------ the words (Android, word for word) */

export const SHOP_Z_TEXT = {
  title: 'סגירת Z סניפי',
  refresh: 'רענון',
  offline: 'אין חיבור לענן — Z סניפי מופק בענן בלבד.',
  cloudError: (code: number) => `שגיאה מהענן (${code})`,
  tillsOpen: (n: number) => `${n} קופות עם משמרת פתוחה — ייסגרו מרחוק.`,
  allClosed: 'כל הקופות סגורות.',
  empty: 'אין תנועות — לא ניתן לסגור Z על 0',
  start: 'סגור את כל הקופות והפק Z סניפי',
  failedBox: (n: number) => `${n} קופות לא נסגרו (הסיבה ליד כל קופה). אפשר להפיק Z בלי הן, או לתקן ולהתחיל שוב.`,
  waitingCloud: (n: number) => `ממתין לאישור הענן על ${n} קופות…`,
  building: 'מפיק את ה-Z…',
  seconds: (n: number) => `${n} שניות`,
  strictNote: 'ה-Z יופק רק כשהענן מאשר שכל קופה נסגרה וכל עסקאותיה עלו.',
  proceedWaiting: 'הפק Z בלי הקופות שלא אושרו',
  proceedFailed: 'הפק Z בלי הקופות שלא נסגרו',
  produced: (n: number | null) => `Z סניפי מס׳ ${n ?? '—'} הופק`,
  allVerified: 'כל הקופות אושרו בענן.',
  movedNext: 'עברו ל-Z הבא: ',
  approvedBy: (who: string) => ` (אישר/ה: ${who})`,
  printSummaryAgain: 'הדפס סיכום שוב',
  tillDetails: 'פירוט קופות',
  askStartTitle: 'סגירת כל הקופות',
  askStartBody: 'המשמרת בקופה זו תיסגר מיד, ותישלח פקודת סגירה לכל הקופות הפתוחות בסניף. ה-Z יופק כשהענן יאשר שכולן נסגרו. להמשיך?',
  askStartYes: 'כן, סגור והפק',
  cancel: 'ביטול',
  confirmTitle: 'קופות שיישארו מחוץ ל-Z',
  confirmBody: 'הקופות האלה לא ייכללו ב-Z והמשמרת שלהן תעבור ל-Z הבא:',
  blockedTitle: 'חובה לסגור את כל הקופות',
  blockedBody: 'לפי הגדרות הסניף אי אפשר להפיק Z לפני שהקופות האלה נסגרות:',
  understood: 'הבנתי',
  proceedTitle: 'להפיק Z בכל זאת?',
  proceedBody: 'הקופות שהענן עדיין לא אישר לא ייכללו ב-Z הזה — המשמרת שלהן תעבור ל-Z הבא, ויירשם מי אישר.',
  confirmWord: 'סגור',
  typeLabel: 'הקלידו "סגור" לאישור',
  ok: 'אישור',
  detailsTitle: 'להדפיס פירוט מלא לכל קופה בנפרד?',
  detailsBody: 'כל קופה תודפס כדוח נפרד עם כותרת משלה, לפי מספר הקופה.',
  chooseTills: 'בחר קופות',
  printAll: 'הדפס הכל',
  no: 'לא',
  pickerTitle: 'בחירת קופות להדפסה',
  printN: (n: number) => `הדפס (${n})`,
  stopping: 'עוצר…',
  printingSummary: 'מדפיס סיכום Z…',
  detailProgress: (index: number, total: number) => `מדפיס קופה ${index + 1} מתוך ${total}…`,
  printFailed: (why: string) => `ההדפסה נכשלה: ${why}`,
  printedOf: (printed: number, total: number) => ` (הודפסו ${printed} מתוך ${total})`,
  printStopped: (printed: number, total: number) => `ההדפסה הופסקה — הודפסו ${printed} מתוך ${total}`,
  opener: (name: string) => `פתח/ה: ${name}`,
  notConnected: 'לא מחוברת',
  thisTill: '(קופה זו)',
  till: 'קופה',
  runExpired: 'סגירת ה-Z הקודמת פגה — אפשר להתחיל שוב.',
  runCancelled: 'סגירת ה-Z הקודמת בוטלה.',
  runFailed: (m: string | null) => 'הפקת ה-Z נכשלה' + (m ? `: ${m}` : '.'),
  inProgress: 'כבר מתבצעת סגירת Z בסניף — רעננו.',
  nothingToReport: 'אין משמרות לדווח ב-Z.',
  notMaster: 'הקופה הזו אינה מוגדרת כקופה ראשית ל-Z סניפי.',
  onlyMain: 'ה-Z הסניפי מופק בקופה הראשית בלבד — הפיקו אותו שם (או העבירו את השרת לקופה הזו אם הקופה הראשית נפלה, במסך השולחנות).',
  runNotWaiting: 'סגירת ה-Z כבר הסתיימה — רעננו.',
  itemsNotReady: 'יש קופות שהענן עדיין לא אישר.',
  tablesBlocked: (list: string) => `לא ניתן להפיק Z — שולחנות פתוחים: ${list}. יש לשלם או לבטל אותם קודם.`,
  // "Z לנקודת מכירה" (pos-android ShopZLogic.kt on the area branch).
  wholeShop: 'כל הסניף',
  areaTitle: 'Z לנקודת המכירה',
  areaTitleNamed: (name: string) => `Z לנקודת המכירה: ${name}`,
  // Local mode (Android local_shop_z_title; the body is the Windows till's own — see the module's note).
  localTitle: 'סגירת Z סניפי — רשת מקומית',
  localBody:
    'הסניף עובד ברשת מקומית: ה-Z הסניפי מופק וממוספר בקופה הראשית ברשת המקומית. קופת Windows אינה מפיקה Z סניפי ברשת מקומית — יש להפיק אותו בקופה ראשית אנדרואיד, או לכבות את "רשת מקומית" בהגדרות הסניף.',
  // The till's live line (ShopZLogic.tillLiveStatus).
  live: {
    openOff: 'משמרת פתוחה · לא מחוברת',
    open: 'משמרת פתוחה',
    closedWaiting: 'סגורה — ממתינה ל-Z',
    nothing: 'אין מה לדווח',
    offWaiting: 'לא מחוברת — ממתינה',
    closingCard: 'נסגרת… (תשלום באשראי בתהליך)',
    closing: 'נסגרת…',
    waitingDocs: 'ממתינה לעסקאות',
    cloudCounts: (cloud: number, till: number) => ` (בענן ${cloud} מתוך ${till})`,
    done: 'נסגרה ✓ (אושר בענן)',
    nextZBy: (who: string) => `עוברת ל-Z הבא (אישר/ה: ${who})`,
    nextZ: 'עוברת ל-Z הבא',
    expired: 'לא נסגרה בזמן',
    secs: (n: number) => ` · ${n} ש׳`,
  },
  failed: {
    open_tables: 'שולחנות פתוחים בקופה',
    no_open_shift: 'אין משמרת פתוחה בקופה',
    shift_changed: 'המשמרת בקופה השתנתה',
    shift_belongs_to_another_machine: 'משמרת של קופה אחרת',
    other: 'הסגירה נכשלה',
  },
} as const;

/* ------------------------------------------------------------------ the cloud's shapes (ShopZDtos.kt) */

export interface ShopZOpenShift {
  id: string;
  openedAt: string | null;
  openedByName: string | null;
}

export interface ShopZTill {
  id: string;
  posNumber: string | null;
  name: string | null;
  /** This till — the master itself. */
  self: boolean;
  online: boolean;
  lastSeenAt: string | null;
  openShift: ShopZOpenShift | null;
  /** Closed shifts of it waiting for a Z. */
  closedWaiting: number;
}

export interface ShopZRunItem {
  /** The item's id — also the close request the till answers (the master closes its own with it). */
  id: string | null;
  machineId: string;
  machineName: string | null;
  posNumber: string | null;
  /** waiting_close | closing | ready | excluded | failed | expired */
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  closeShiftId: string | null;
  online: boolean | null;
  readyAt: string | null;
  cloudVerified: boolean | null;
  tillDocuments: number | null;
  cloudDocuments: number | null;
  deferredBy: string | null;
}

export interface ShopZRun {
  id: string;
  /** waiting | building | completed | failed | cancelled | expired | empty */
  status: string;
  zReportId: string | null;
  zNumber: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string | null;
  serverTime: string | null;
  strictCloudCheck: boolean;
  items: ShopZRunItem[];
}

export interface ShopZActivity {
  hasActivity: boolean;
  documents: number;
  pendingDocuments: number;
  message: string | null;
}

/** `areaZ` (§11.2a): may this till close its point of sale's Z, and why not. Absent from an older cloud. */
export interface ShopZAreaInfo {
  available: boolean;
  areaId: string | null;
  areaName: string | null;
  reason: string | null;
  message: string | null;
}

export interface ShopZStatus {
  shopId: string | null;
  shopName: string | null;
  /** "block" | "confirm" | null — the shop's rule for tills left out. */
  rule: string | null;
  serverTime: string | null;
  activity: ShopZActivity | null;
  tills: ShopZTill[];
  run: ShopZRun | null;
  /** "area" — this screen is the till's point of sale's Z; "shop" or null (an older cloud) — the shop's. */
  scope: string | null;
  areaZ: ShopZAreaInfo | null;
}

/** A Z's till, from its summary's `tills`: to print its detail apart. */
export interface CloudZTill {
  machineId: string;
  posNumber: string | null;
  name: string | null;
}

/* ------------------------------------------------------------------ reading the cloud's JSON */

const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const list = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(obj).filter((x): x is Record<string, unknown> => x !== null) : []);

export function runItemOf(raw: Record<string, unknown>): ShopZRunItem | null {
  const machineId = str(raw.machineId);
  const status = str(raw.status);
  if (!machineId || !status) return null;
  return {
    id: str(raw.id),
    machineId,
    machineName: str(raw.machineName),
    posNumber: str(raw.posNumber),
    status,
    errorCode: str(raw.errorCode),
    errorMessage: str(raw.errorMessage),
    closeShiftId: str(raw.closeShiftId),
    online: bool(raw.online),
    readyAt: str(raw.readyAt),
    cloudVerified: bool(raw.cloudVerified),
    tillDocuments: num(raw.tillDocuments),
    cloudDocuments: num(raw.cloudDocuments),
    deferredBy: str(raw.deferredBy),
  };
}

/** A run as `ZRunOut` says it; null — not one. */
export function runOf(raw: unknown): ShopZRun | null {
  const r = obj(raw);
  const id = r ? str(r.id) : null;
  const status = r ? str(r.status) : null;
  if (!r || !id || !status) return null;
  return {
    id,
    status,
    zReportId: str(r.zReportId),
    zNumber: num(r.zNumber),
    errorCode: str(r.errorCode),
    errorMessage: str(r.errorMessage),
    createdAt: str(r.createdAt),
    serverTime: str(r.serverTime),
    strictCloudCheck: r.strictCloudCheck === true,
    items: list(r.items)
      .map(runItemOf)
      .filter((x): x is ShopZRunItem => x !== null),
  };
}

/** `GET sync/{m}/shop-z`. A server that predates the activity rule sends none: read as "has activity" (the start stays its to refuse). */
export function statusOf(raw: unknown): ShopZStatus | null {
  const b = obj(raw);
  if (!b) return null;
  const act = obj(b.activity);
  const area = obj(b.areaZ);
  return {
    shopId: str(b.shopId),
    shopName: str(b.shopName),
    rule: str(b.rule),
    serverTime: str(b.serverTime),
    activity: act
      ? { hasActivity: act.hasActivity !== false, documents: num(act.documents) ?? 0, pendingDocuments: num(act.pendingDocuments) ?? 0, message: str(act.message) }
      : null,
    tills: list(b.tills)
      .map((t): ShopZTill | null => {
        const id = str(t.id);
        if (!id) return null;
        const s = obj(t.openShift);
        const sid = s ? str(s.id) : null;
        return {
          id,
          posNumber: str(t.posNumber),
          name: str(t.name),
          self: t.self === true,
          online: t.online === true,
          lastSeenAt: str(t.lastSeenAt),
          openShift: s && sid ? { id: sid, openedAt: str(s.openedAt), openedByName: str(s.openedByName) } : null,
          closedWaiting: num(t.closedWaiting) ?? 0,
        };
      })
      .filter((x): x is ShopZTill => x !== null),
    run: b.run ? runOf(b.run) : null,
    scope: str(b.scope),
    areaZ: area
      ? { available: area.available === true, areaId: str(area.areaId), areaName: str(area.areaName), reason: str(area.reason), message: str(area.message) }
      : null,
  };
}

/* ------------------------------------------------------------------ the run (ShopZLogic.kt) */

/** Item statuses still waiting for the till. */
export const SHOP_Z_PENDING: ReadonlySet<string> = new Set(['waiting_close', 'closing']);
/** Run statuses still under way. */
export const SHOP_Z_LIVE: ReadonlySet<string> = new Set(['waiting', 'building']);
export const SHOP_Z_FAILED: ReadonlySet<string> = new Set(['failed', 'expired']);
/** Run statuses after which a new run may start (the start button again, the end said). */
export const SHOP_Z_ENDED: ReadonlySet<string> = new Set(['failed', 'cancelled', 'expired', 'empty']);

export type TillTone = 'working' | 'done' | 'waiting' | 'off' | 'muted' | 'failed';

export interface TillLive {
  text: string;
  tone: TillTone;
}

/** An ISO timestamp from the cloud, in epoch ms (one with no offset is UTC, as the Android till reads it); null if unreadable. */
export function isoMillis(value: string | null | undefined): number | null {
  if (!value || !value.trim()) return null;
  let v = value.trim().replace(/(\.\d{3})\d+/, '$1');
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(v)) v += 'Z';
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * When the run started, on this till's clock: the cloud's `createdAt`, moved by the difference between the cloud's clock
 * (`serverTime`) and this till's when the answer came. A till whose clock is a minute off still counts seconds right.
 */
export function runStartOnTillClock(run: ShopZRun, receivedAtMs: number): number | null {
  const created = isoMillis(run.createdAt);
  if (created === null) return null;
  const server = isoMillis(run.serverTime);
  if (server === null) return created;
  return receivedAtMs - Math.max(0, server - created);
}

/** Whole seconds from `fromMs` to `toMs`, never negative. */
export function secondsBetween(fromMs: number | null, toMs: number | null): number | null {
  return fromMs === null || toMs === null ? null : Math.floor(Math.max(0, toMs - fromMs) / 1000);
}

/** The seconds a ready till took: from the run's start to the cloud confirming it. */
export function secondsToReady(run: ShopZRun, item: ShopZRunItem): number | null {
  return secondsBetween(isoMillis(run.createdAt), isoMillis(item.readyAt));
}

function failedText(code: string | null): string {
  const F = SHOP_Z_TEXT.failed;
  switch (code) {
    case 'open_tables':
      return F.open_tables;
    case 'no_open_shift':
      return F.no_open_shift;
    case 'unknown_shift':
    case 'shift_changed':
      return F.shift_changed;
    case 'shift_belongs_to_another_machine':
      return F.shift_belongs_to_another_machine;
    default:
      return F.other;
  }
}

/** A till's live line on the master during a shop Z (ShopZLogic.tillLiveStatus). `elapsedSec`: for a till still waited on. */
export function tillLiveStatus(till: ShopZTill, item: ShopZRunItem | null, run: ShopZRun | null, elapsedSec: number | null): TillLive {
  const L = SHOP_Z_TEXT.live;
  const secs = elapsedSec !== null ? L.secs(elapsedSec) : '';
  if (!item) {
    if (till.openShift && !till.online) return { text: L.openOff, tone: 'off' };
    if (till.openShift) return { text: L.open, tone: 'waiting' };
    if (till.closedWaiting > 0) return { text: L.closedWaiting, tone: 'done' };
    return { text: L.nothing, tone: 'muted' };
  }
  const online = item.online ?? till.online;
  switch (item.status) {
    case 'waiting_close':
    case 'closing':
      if (!online) return { text: L.offWaiting + secs, tone: 'off' };
      if (item.errorCode === 'card_in_flight') return { text: L.closingCard + secs, tone: 'working' };
      return { text: L.closing + secs, tone: 'working' };
    case 'ready': {
      if (item.cloudVerified === false) {
        const counts = item.tillDocuments !== null && item.cloudDocuments !== null ? L.cloudCounts(item.cloudDocuments, item.tillDocuments) : '';
        return { text: L.waitingDocs + counts + secs, tone: 'waiting' };
      }
      const took = run ? secondsToReady(run, item) : null;
      return { text: L.done + (took !== null ? L.secs(took) : ''), tone: 'done' };
    }
    case 'excluded':
      if (item.deferredBy !== null) return { text: L.nextZBy(item.deferredBy), tone: 'muted' };
      if (item.errorCode === 'excluded_by_operator' || (item.errorMessage ?? '').includes('Z הבא')) return { text: L.nextZ, tone: 'muted' };
      return { text: L.nothing, tone: 'muted' };
    case 'failed':
      return { text: failedText(item.errorCode), tone: 'failed' };
    case 'expired':
      return { text: L.expired, tone: 'failed' };
    default:
      return { text: item.status, tone: 'muted' };
  }
}

/** The item is still waited on: not closed yet, or closed but missing transactions. */
export function waitedOn(item: ShopZRunItem | null | undefined): boolean {
  return !!item && (SHOP_Z_PENDING.has(item.status) || (item.status === 'ready' && item.cloudVerified === false));
}

/** The tills the run still waits for. */
export function shopZWaitingCount(run: ShopZRun): number {
  return run.items.filter(waitedOn).length;
}

/** The tills that refused or ran out of time while the run still waits. */
export function shopZFailedCount(run: ShopZRun): number {
  return run.items.filter((i) => SHOP_Z_FAILED.has(i.status)).length;
}

/** This till's own item while the run still waits for it to close — the master closes it itself. */
export function ownPendingItem(run: ShopZRun, machineId: string | null): ShopZRunItem | null {
  return run.items.find((i) => i.machineId === machineId && SHOP_Z_PENDING.has(i.status) && i.id !== null) ?? null;
}

const posInt = (p: string | null): number | null => {
  const t = (p ?? '').trim();
  return /^-?\d+$/.test(t) ? Number(t) : null;
};

/** A Z's tills in till-number order (numbers as numbers), then the unnumbered by name. */
export function tillsInOrder<T extends CloudZTill>(tills: readonly T[]): T[] {
  return [...tills].sort((a, b) => {
    const na = posInt(a.posNumber);
    const nb = posInt(b.posNumber);
    if ((na === null) !== (nb === null)) return na === null ? 1 : -1;
    if (na !== null && nb !== null && na !== nb) return na - nb;
    return (a.name ?? '').localeCompare(b.name ?? '');
  });
}

/** "#4 קופה 1": a till as the print prompts name it. */
export function tillLabel(t: { posNumber: string | null; name: string | null }): string {
  const parts = [t.posNumber && t.posNumber.trim() ? `#${t.posNumber}` : null, t.name && t.name.trim() ? t.name : null].filter(Boolean);
  return parts.length ? parts.join(' ') : SHOP_Z_TEXT.till;
}

/** How a run of separate prints ended. */
export interface PrintSequenceOutcome {
  printed: number;
  total: number;
  cancelled: boolean;
  /** The failure's words (already "ההדפסה נכשלה: …"), or null. */
  error: string | null;
}

/** Print `items` one after another; a cancel takes effect between documents, a failure stops the rest. */
export async function printInSequence<T>(
  items: readonly T[],
  isCancelled: () => boolean,
  onProgress: (index: number, total: number, item: T) => void,
  printOne: (item: T) => Promise<string | null>,
): Promise<PrintSequenceOutcome> {
  let printed = 0;
  for (let i = 0; i < items.length; i++) {
    if (isCancelled()) return { printed, total: items.length, cancelled: true, error: null };
    onProgress(i, items.length, items[i]);
    const error = await printOne(items[i]);
    if (error !== null) return { printed, total: items.length, cancelled: false, error };
    printed++;
  }
  return { printed, total: items.length, cancelled: false, error: null };
}

/** What a run of separate prints says when it is over (null: all printed). */
export function printSequenceMessage(o: PrintSequenceOutcome): string | null {
  if (o.error !== null) return o.error + SHOP_Z_TEXT.printedOf(o.printed, o.total);
  if (o.cancelled) return SHOP_Z_TEXT.printStopped(o.printed, o.total);
  return null;
}

/** What the screen says of a run that ended without a Z. */
export function runEndedText(run: ShopZRun): string {
  switch (run.status) {
    case 'expired':
      return SHOP_Z_TEXT.runExpired;
    case 'cancelled':
      return SHOP_Z_TEXT.runCancelled;
    case 'empty':
      return run.errorMessage ?? SHOP_Z_TEXT.empty;
    default:
      return SHOP_Z_TEXT.runFailed(run.errorMessage);
  }
}

/* ------------------------------------------------------------------ the cloud's refusals */

/** FastAPI's `detail`: a string, an object, or nothing. */
function detailOf(body: unknown): unknown {
  const b = obj(body);
  return b ? b.detail : null;
}

/** A refusal's `detail` as the Android till reads it (JSONObject.opt("detail").toString()). */
function detailString(body: unknown): string {
  const d = detailOf(body);
  if (d === null || d === undefined) return '';
  return typeof d === 'string' ? d : JSON.stringify(d);
}

/** Any other refusal of the start / the proceed, in the till's words (ShopZViewModel.describe). */
export function describeRefusal(body: unknown, status: number): string {
  const detail = detailString(body);
  const d = obj(detailOf(body));
  // Local mode: the cloud says why in its own words (the Windows till has no local shop Z — the module's note).
  if (d && d.code === 'shop_z_producer_local' && typeof d.message === 'string' && d.message.trim()) return d.message;
  if (detail.startsWith('z_run_in_progress')) return SHOP_Z_TEXT.inProgress;
  if (detail === 'nothing_to_report') return SHOP_Z_TEXT.nothingToReport;
  if (detail === 'not_master_till') return SHOP_Z_TEXT.notMaster;
  if (detail === 'z_only_from_main_till') return SHOP_Z_TEXT.onlyMain;
  if (detail === 'run_not_waiting') return SHOP_Z_TEXT.runNotWaiting;
  if (detail.includes('items_not_ready')) return SHOP_Z_TEXT.itemsNotReady;
  return SHOP_Z_TEXT.cloudError(status);
}

/** The tables of the cloud's 409 `{code: open_tables_block_z, tables}` (Android openTablesOf), by number. */
export function openTablesOf(detail: Record<string, unknown> | null): string {
  const tables = list(detail?.tables)
    .map((t) => ({ number: num(t.number) ?? 0, name: str(t.name), label: str(t.label) }))
    .sort((a, b) => a.number - b.number);
  return tables.map((t) => (t.name && t.name.trim() ? t.name.trim() : t.label && t.label.trim() ? t.label.trim() : String(t.number))).join(', ');
}

/** A till of a 409's `tills`, named "#2 בר". */
function refusedTillName(t: Record<string, unknown>): string {
  const pos = str(t.posNumber);
  const name = str(t.name);
  return [pos && pos.trim() && pos !== 'null' ? `#${pos}` : null, name && name.trim() ? name : null].filter(Boolean).join(' ');
}

/** What the start's refusal leads to (ShopZViewModel.start's `when (code)`). */
export type StartRefusal =
  | { kind: 'needs_confirm'; tills: string[] }
  | { kind: 'blocked'; tills: string[] }
  | { kind: 'error'; text: string };

export function startRefusal(body: unknown, status: number): StartRefusal {
  const d = obj(detailOf(body));
  const code = d ? str(d.code) ?? '' : '';
  const tills = d ? list(d.tills).map(refusedTillName) : [];
  switch (code) {
    case 'open_tills_need_confirmation':
      return { kind: 'needs_confirm', tills };
    case 'open_tills_block_z':
      return { kind: 'blocked', tills };
    case 'open_tables_block_z':
      return { kind: 'error', text: SHOP_Z_TEXT.tablesBlocked(openTablesOf(d)) };
    case 'empty_z':
      return { kind: 'error', text: d && typeof d.message === 'string' && d.message.trim() ? d.message : SHOP_Z_TEXT.empty };
    default:
      return { kind: 'error', text: describeRefusal(body, status) };
  }
}

/* ------------------------------------------------------------------ "Z לנקודת מכירה" (§11.2a, feature-detected) */

export const SHOP_Z_SCOPE_AREA = 'area';

/** The screen is the till's point of sale's Z (asked for, or the cloud switched it: its area's master, not the shop's). */
export function shopZIsArea(status: ShopZStatus | null): boolean {
  return status?.scope === SHOP_Z_SCOPE_AREA;
}

/** `scope` of `POST shop-z`: "area" on a point of sale's screen; null — the shop's, as before (an older cloud never sees it). */
export function shopZStartScope(status: ShopZStatus | null): string | null {
  return shopZIsArea(status) ? SHOP_Z_SCOPE_AREA : null;
}

/** The path of `GET shop-z`: `?scope=area` when the operator picked the point of sale; none lets the cloud decide. */
export function shopZStatusPath(machineId: string, wantArea: boolean): string {
  return `sync/${machineId}/shop-z${wantArea ? '?scope=area' : ''}`;
}

/** May this till run the whole shop's Z, read off a status it did not ask a scope for. */
export function shopZShopOffered(unasked: ShopZStatus | null): boolean {
  return unasked !== null && !shopZIsArea(unasked);
}

/** "כל הסניף" / "<נקודה>": offered when the point of sale's Z is available here and the shop's is too. */
export function shopZOffersScopeChoice(status: ShopZStatus | null, shopOffered: boolean): boolean {
  return shopOffered && status?.areaZ?.available === true && !!status.areaZ.areaName && status.areaZ.areaName.trim() !== '';
}

/** The screen's header. */
export function shopZTitle(status: ShopZStatus | null): string {
  if (!shopZIsArea(status)) return SHOP_Z_TEXT.title;
  const name = status?.areaZ?.areaName?.trim();
  return name ? SHOP_Z_TEXT.areaTitleNamed(name) : SHOP_Z_TEXT.areaTitle;
}

/* ------------------------------------------------------------------ the menu row */

export const SHOP_Z_MENU_KEY = 'shop_z';
export const PARAM_MAIN_TILL = 'mainTill';
export const PARAM_SHOP_Z_MASTER = 'shopZMasterTill';
export const PARAM_SHOP_Z_FROM = 'shopZFrom';
export const SHOP_Z_FROM_ANY = 'כל קופה בסניף והדשבורד';

const on = (v: unknown): boolean => v === true || v === 1 || (typeof v === 'string' && ['true', '1', 'yes', 'כן'].includes(v.trim().toLowerCase()));

/** domain/MainTill.showsShopZ: the main till, a till marked master the old way, or every till when the shop opened it to all. */
export function paramsShowShopZ(params: Record<string, unknown> | null | undefined): boolean {
  const p = params ?? {};
  return on(p[PARAM_MAIN_TILL]) || on(p[PARAM_SHOP_Z_MASTER]) || (typeof p[PARAM_SHOP_Z_FROM] === 'string' && (p[PARAM_SHOP_Z_FROM] as string).trim() === SHOP_Z_FROM_ANY);
}

/**
 * "סגירת Z סניפי" in the ☰ menu (PosNavigation.kt): not independent, not `zMode = till` (nor in training — the Windows till
 * has none), the parameters say so, and `shop_z` not hidden. Open till or closed; no permission of the role.
 */
export function shopZMenuShown(f: {
  zMode: string | null | undefined;
  independent: boolean;
  training?: boolean;
  params: Record<string, unknown> | null | undefined;
  hidden: readonly string[];
}): boolean {
  const tillZ = (f.zMode ?? '').trim().toLowerCase() === 'till' || f.training === true;
  return !f.independent && !tillZ && paramsShowShopZ(f.params) && !f.hidden.includes(SHOP_Z_MENU_KEY);
}

/** Local mode, as the cloud's shop-Z history says it: the shop's Z is the main till's on the LAN, and this till is it. */
export function localMasterOf(history: unknown, machineId: string | null): boolean {
  const h = obj(history);
  if (!h || !machineId || h.localMode !== true) return false;
  const main = obj(h.mainTill);
  return !!main && main.machineId === machineId;
}

/* ------------------------------------------------------------------ printing the cloud's Z (CloudZScreen.PrintDocumentRenderer) */

export interface CloudPrintDocument {
  title: string | null;
  number: number | null;
  copyMark: string | null;
  businessName: string | null;
  subtitle: string[];
  sections: Array<{ title: string | null; key: string | null; rows: Array<{ label: string; value: string; emphasis: boolean }> }>;
  footer: string[];
  tills: CloudZTill[];
}

const lines = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter((x): x is string => x !== null) : typeof v === 'string' && v ? [v] : []);

export function cloudPrintDocumentOf(raw: unknown): CloudPrintDocument | null {
  const d = obj(raw);
  if (!d) return null;
  return {
    title: str(d.title),
    number: num(d.number),
    copyMark: str(d.copyMark),
    businessName: str(d.businessName),
    subtitle: lines(d.subtitle),
    sections: list(d.sections).map((s) => ({
      title: str(s.title),
      key: str(s.key),
      rows: list(s.rows).map((r) => ({ label: str(r.label) ?? '', value: str(r.value) ?? '', emphasis: r.emphasis === true })),
    })),
    footer: lines(d.footer),
    tills: list(d.tills)
      .map((t) => {
        const machineId = str(t.machineId);
        return machineId ? { machineId, posNumber: str(t.posNumber), name: str(t.name) } : null;
      })
      .filter((x): x is CloudZTill => x !== null),
  };
}

const FAILED_PAYMENT_SECTION_KEYS = new Set(['failed_payments', 'cancelled_sales']);

/** "עסקאות שלא הושלמו" / "מכירות שבוטלו" off the paper unless `printFailedPaymentsWithReports` (FailedPaymentsUi.kt). */
export function withoutFailedPaymentSections(doc: CloudPrintDocument, params: Record<string, unknown> | null | undefined): CloudPrintDocument {
  if (on((params ?? {}).printFailedPaymentsWithReports)) return doc;
  return { ...doc, sections: doc.sections.filter((s) => !s.key || !FAILED_PAYMENT_SECTION_KEYS.has(s.key)) };
}

/** The paper's ops, as the Android renderer draws the cloud's document (core/printDocs.ts ZDoc ops). */
export function cloudZOps(d: CloudPrintDocument): Array<{ t: 'centred'; text: string; size: number; bold: boolean } | { t: 'row'; label: string; value: string; bold: boolean } | { t: 'divider' }> {
  const ops: ReturnType<typeof cloudZOps> = [];
  if (d.businessName && d.businessName.trim()) ops.push({ t: 'centred', text: d.businessName, size: 24, bold: true });
  ops.push({ t: 'centred', text: [d.title, d.number !== null ? `#${d.number}` : null].filter(Boolean).join(' '), size: 28, bold: true });
  if (d.copyMark && d.copyMark.trim()) ops.push({ t: 'centred', text: d.copyMark, size: 18, bold: false });
  for (const s of d.subtitle) ops.push({ t: 'centred', text: s, size: 18, bold: false });
  for (const s of d.sections) {
    ops.push({ t: 'divider' });
    if (s.title && s.title.trim()) ops.push({ t: 'centred', text: s.title, size: 21, bold: true });
    for (const r of s.rows) ops.push({ t: 'row', label: r.label, value: r.value, bold: r.emphasis });
  }
  if (d.footer.length) {
    ops.push({ t: 'divider' });
    for (const f of d.footer) ops.push({ t: 'centred', text: f, size: 17, bold: false });
  }
  return ops;
}

/* ------------------------------------------------------------------ the state the screen draws */

/** The engine's `shopZ` slice (the Android ShopZUiState, plus the Windows till's local-mode notice). */
export interface ShopZState {
  loading: boolean;
  status: ShopZStatus | null;
  run: ShopZRun | null;
  /** When the run started, on this till's clock (epoch ms): the elapsed seconds count from it. */
  runStartedAtMs: number | null;
  busy: boolean;
  error: string | null;
  /** The cloud wants the operator's typed "סגור" for these tills. */
  needsConfirm: string[] | null;
  /** The shop's rule refuses: these tills must be closed first. */
  blockedBy: string[] | null;
  /** The Z whose summary was printed here (once per Z). */
  printedZId: string | null;
  /** The Z's tills, from its summary, for printing their details apart. */
  zTills: CloudZTill[];
  askDetails: boolean;
  choosing: boolean;
  /** A print under way: "מדפיס סיכום Z…" / "מדפיס קופה 3 מתוך 5…", and which till. */
  progress: string | null;
  progressDetail: string | null;
  cancelling: boolean;
  message: string | null;
  /** "Z לנקודת מכירה": the operator picked the point of sale. */
  wantArea: boolean;
  /** This till may run the whole shop's Z too (read off a status asked with no scope). */
  shopOffered: boolean;
  /** Local mode with this till the main till: no start here (the module's note). */
  localMode: boolean;
}

export function emptyShopZState(): ShopZState {
  return {
    loading: true,
    status: null,
    run: null,
    runStartedAtMs: null,
    busy: false,
    error: null,
    needsConfirm: null,
    blockedBy: null,
    printedZId: null,
    zTills: [],
    askDetails: false,
    choosing: false,
    progress: null,
    progressDetail: null,
    cancelling: false,
    message: null,
    wantArea: false,
    shopOffered: false,
    localMode: false,
  };
}

/* ------------------------------------------------------------------ the screen's view */

export interface ShopZTillRowView {
  id: string;
  label: string;
  opener: string | null;
  online: boolean;
  live: TillLive;
}

export type ShopZPhaseView =
  | { kind: 'loading' }
  | { kind: 'idle'; ended: string | null; openLine: string; nothing: string | null; local: string | null; startEnabled: boolean; busy: boolean }
  | { kind: 'live'; failedBox: string | null; waitingLine: string | null; elapsed: string | null; note: string; proceed: string | null; proceedEnabled: boolean }
  | { kind: 'completed'; title: string; sub: string; left: string | null; zReportId: string | null; printEnabled: boolean; detailsEnabled: boolean }
  | { kind: 'other' };

export interface ShopZView {
  title: string;
  shopName: string | null;
  refreshEnabled: boolean;
  error: string | null;
  message: string | null;
  progress: { text: string; detail: string | null; cancellable: boolean; cancelling: boolean } | null;
  scope: { options: Array<{ area: boolean; label: string; on: boolean }>; enabled: boolean } | null;
  rows: ShopZTillRowView[];
  phase: ShopZPhaseView;
  needsConfirm: string[] | null;
  blockedBy: string[] | null;
  askDetails: boolean;
  choosing: CloudZTill[] | null;
}

/** What the screen shows of the state, `nowMs` on this till's clock (the seconds tick in the screen). */
export function shopZView(s: ShopZState, nowMs: number): ShopZView {
  const run = s.run;
  const runLive = !!run && SHOP_Z_LIVE.has(run.status);
  const elapsed = runLive ? secondsBetween(s.runStartedAtMs, nowMs) : null;
  const tills = s.status?.tills ?? [];
  const area = shopZIsArea(s.status);
  const scope = shopZOffersScopeChoice(s.status, s.shopOffered)
    ? {
        options: [
          { area: false, label: SHOP_Z_TEXT.wholeShop, on: !area },
          { area: true, label: s.status?.areaZ?.areaName ?? '', on: area },
        ],
        enabled: !s.busy && !runLive,
      }
    : null;
  const rows: ShopZTillRowView[] = tills.map((till) => {
    const item = run?.items.find((i) => i.machineId === till.id) ?? null;
    return {
      id: till.id,
      label: [till.posNumber ? `#${till.posNumber}` : null, till.name, till.self ? SHOP_Z_TEXT.thisTill : null].filter(Boolean).join(' '),
      opener: till.openShift?.openedByName ? SHOP_Z_TEXT.opener(till.openShift.openedByName) : null,
      online: till.online,
      live: tillLiveStatus(till, item, run, runLive && waitedOn(item) ? elapsed : null),
    };
  });
  let phase: ShopZPhaseView;
  if (s.loading) phase = { kind: 'loading' };
  else if (!run || SHOP_Z_ENDED.has(run.status)) {
    const open = tills.filter((t) => t.openShift !== null).length;
    const nothing = s.status?.activity?.hasActivity === false ? s.status.activity.message ?? SHOP_Z_TEXT.empty : null;
    phase = {
      kind: 'idle',
      ended: run ? runEndedText(run) : null,
      openLine: open > 0 ? SHOP_Z_TEXT.tillsOpen(open) : SHOP_Z_TEXT.allClosed,
      nothing,
      local: s.localMode ? SHOP_Z_TEXT.localBody : null,
      startEnabled: !s.busy && tills.length > 0 && nothing === null && !s.localMode,
      busy: s.busy,
    };
  } else if (runLive) {
    const waiting = shopZWaitingCount(run);
    const failed = shopZFailedCount(run);
    const stuck = waiting === 0 && failed > 0;
    phase = {
      kind: 'live',
      failedBox: stuck ? SHOP_Z_TEXT.failedBox(failed) : null,
      waitingLine: stuck ? null : waiting > 0 ? SHOP_Z_TEXT.waitingCloud(waiting) : SHOP_Z_TEXT.building,
      elapsed: !stuck && elapsed !== null ? SHOP_Z_TEXT.seconds(elapsed) : null,
      note: SHOP_Z_TEXT.strictNote,
      proceed: waiting > 0 ? SHOP_Z_TEXT.proceedWaiting : failed > 0 ? SHOP_Z_TEXT.proceedFailed : null,
      proceedEnabled: !s.busy,
    };
  } else if (run.status === 'completed') {
    const left = run.items.filter((i) => i.status === 'excluded' && (i.deferredBy !== null || i.errorCode === 'excluded_by_operator'));
    phase = {
      kind: 'completed',
      title: SHOP_Z_TEXT.produced(run.zNumber),
      sub: SHOP_Z_TEXT.allVerified,
      left: left.length ? SHOP_Z_TEXT.movedNext + left.map((i) => (i.machineName ?? '') + (i.deferredBy !== null ? SHOP_Z_TEXT.approvedBy(i.deferredBy) : '')).join(', ') : null,
      zReportId: run.zReportId,
      printEnabled: s.progress === null,
      detailsEnabled: s.progress === null && s.zTills.length > 0,
    };
  } else phase = { kind: 'other' };
  return {
    title: s.localMode ? SHOP_Z_TEXT.localTitle : shopZTitle(s.status),
    shopName: s.status?.shopName ?? null,
    refreshEnabled: !s.busy,
    error: s.error,
    message: s.message,
    // The tills' details only can be stopped: the summary is one document.
    progress: s.progress ? { text: s.progress, detail: s.progressDetail, cancellable: s.progressDetail !== null, cancelling: s.cancelling } : null,
    scope,
    rows: s.loading ? [] : rows,
    phase,
    needsConfirm: s.needsConfirm,
    blockedBy: s.blockedBy,
    askDetails: s.askDetails,
    choosing: s.choosing ? s.zTills : null,
  };
}

/** The typed word: "סגור", spaces around it forgiven. */
export function confirmTyped(typed: string): boolean {
  return typed.trim() === SHOP_Z_TEXT.confirmWord;
}
