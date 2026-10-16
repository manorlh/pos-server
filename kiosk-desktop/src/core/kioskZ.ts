/**
 * A kiosk's shift and Z by its Z mode (pos-server docs/SPEC_KIOSK.md §25, app/services/kiosk_z.py) — the Android
 * kiosk's domain/KioskZ.kt and data/repo/KioskZRunner.kt, with the words of res/values/strings_kiosk_z.xml.
 *
 * The owner: "אם הקיוסק הוא חלק זד עצמאי אז תאפשר להפיק זד כמו שמופיע בקופה וגם בענן, אבל אם הוא חלק מסניפי אז
 * תאפשר לסגור משמרת."
 *
 *  - the mode is the till's (a kiosk is a till), per device: the shop's Z mode, overridden per machine by the
 *    heartbeat's `independentTill` ("לדרוס"). In the shop Z ("Z סניפי") the kiosk is offered "סגירת משמרת" only —
 *    its shift goes into the shop's next Z as its part; with its own Z ("Z עצמאי", the shop's "Z לכל קופה") "הפקת Z"
 *    only — the Z closes the shift itself;
 *  - the kiosk admin's own action (behind the manager's code, "ניהול הקיוסק" → "משמרת ו-Z", [KioskZRunner]): never over
 *    a customer ordering or paying, a card on the terminal, or a payment's document still pending; its own Z: the card
 *    deals transmitted first, the shift closed, the close delivered, the number asked of the cloud (strictly
 *    sequential, its own run) and the Z printed on the kiosk's printer — no connection: the Z is owed and produced by
 *    the kiosk once the cloud answers, never a number guessed here;
 *  - a close or a Z asked from afar waits while a customer is there ([kioskZHold]: the `deferred` ack's code), and a Z
 *    a controlling till asked to print itself is not printed on the kiosk ([kioskZPrintsHere]).
 *
 * Pure but for the runner, which works through [KioskZPort] (tested with fakes; main/service.ts is the device's).
 */

/** The kiosk's Z mode, per device. */
export type KioskZKind = 'shop' | 'independent' | 'own';

/** On the device itself: its Z mode and the heartbeat's `independentTill`. */
export function kioskZKindOfDevice(zMode: unknown, independent: boolean): KioskZKind {
  if (independent) return 'independent';
  return String(zMode ?? '').trim().toLowerCase() === 'till' ? 'own' : 'shop';
}

/** It makes its own Z ("הפקת Z"), never a bare close. */
export const makesOwnZ = (kind: KioskZKind): boolean => kind !== 'shop';

/** The `deferred` ack's codes of a close or a Z asked from afar while a customer is at the kiosk. */
export const KIOSK_Z_HOLD = { PAYING: 'kiosk_paying', ORDERING: 'kiosk_ordering' } as const;

/**
 * KioskZHold.of: `kiosk_paying` while paying, `kiosk_ordering` while ordering or on the success screen; null — not a
 * kiosk (or it works as a till), or nobody there.
 */
export function kioskZHold(kioskActive: boolean, flowState: string | null | undefined): string | null {
  if (!kioskActive) return null;
  if (flowState === 'paying' || flowState === 'pay') return KIOSK_Z_HOLD.PAYING;
  if (flowState === 'ordering' || flowState === 'success') return KIOSK_Z_HOLD.ORDERING;
  return null;
}

/** KioskZPrint.printsHere: from the till-Z answer — false when the controlling till that asked prints the Z itself. */
export function kioskZPrintsHere(answer: unknown): boolean {
  if (!answer || typeof answer !== 'object') return true;
  return (answer as { printOn?: unknown }).printOn !== 'controller';
}

/** strings_kiosk_z.xml — the kiosk admin's words. */
export const KZ_TEXT = {
  kind: { shop: 'Z סניפי', independent: 'Z עצמאי', own: 'Z לכל קופה' } as Record<KioskZKind, string>,
  shopHint: 'הקיוסק חלק מה-Z הסניפי: סוגרים לו משמרת, והיא נכללת ב-Z הסניפי הבא.',
  ownHint: 'הקיוסק מפיק Z משלו, במספור משלו. ה-Z סוגר את המשמרת בעצמו.',
  closeShift: 'סגירת משמרת',
  tillZ: 'הפקת Z',
  closeConfirm: 'לסגור את המשמרת של הקיוסק? הסגירה מתבצעת כשאין לקוח באמצע הזמנה או תשלום.',
  zConfirm: 'להפיק Z לקיוסק? הקיוסק ישדר את עסקאות האשראי, יסגור את המשמרת ויפיק את ה-Z שלו — כשאין לקוח באמצע הזמנה או תשלום.',
  confirm: 'אישור',
  cancel: 'ביטול',
  title: 'משמרת ו-Z',
  shiftOpen: 'משמרת פתוחה',
  shiftClosed: 'אין משמרת פתוחה',
  owed: 'Z ממתין להפקה אוטומטית (כשיש חיבור לענן)',
  working: 'מבצע…',
  blockedCustomer: 'לקוח באמצע הזמנה או תשלום — נסו שוב כשיסיים',
  blockedCard: 'פעולת אשראי במסופון — נסו שוב כשתסתיים',
  blockedPending: 'יש תשלום שעוד לא הוכרע — נסו שוב בעוד רגע',
  blockedChanged: 'המשמרת השתנתה — נסו שוב',
  blockedRunning: 'הפקת Z כבר מתבצעת — נסו שוב בעוד רגע',
  closed: 'המשמרת נסגרה ✓ — היא תיכלל ב-Z הסניפי הבא',
  noShift: 'אין משמרת פתוחה לסגירה',
  zDone: (n: number) => `Z מס׳ ${n} הופק והודפס ✓`,
  zDonePrintFailed: (n: number, why: string) => `Z מס׳ ${n} הופק, אבל ההדפסה נכשלה: ${why}`,
  zDoneElsewhere: (n: number) => `Z מס׳ ${n} הופק ✓`,
  zNothing: 'אין מה לדווח — אין משמרות שלא נכללו ב-Z',
  zEmpty: 'אין מסמכים — אין צורך ב-Z',
  zOffline: 'אין חיבור לענן — ה-Z יופק אוטומטית כשהחיבור יחזור (המספר מהענן, ברצף)',
  zWaiting: 'סגירת המשמרת עוד לא נקלטה בענן — ה-Z יופק אוטומטית מיד כשתיקלט',
  zRefused: (why: string) => `ה-Z לא הופק: ${why}`,
  failed: (why: string) => `הפעולה נכשלה: ${why}`,
} as const;

/* ------------------------------------------------------------- the kiosk admin's own close / Z (KioskZRunner) */

/** Why the kiosk admin's close or Z cannot run now. */
export type KioskZLocalBlock = 'customer' | 'card' | 'pending_documents' | 'shift_changed' | 'running';

/** What the kiosk admin's "סגירת משמרת" / "הפקת Z" came to. */
export type KioskAdminZOutcome =
  | { kind: 'blocked'; block: KioskZLocalBlock }
  | { kind: 'no_open_shift' }
  | { kind: 'shift_closed'; shiftId: string }
  /** `printedHere` false: the controlling till that asked prints it. */
  | { kind: 'z_produced'; number: number; printError: string | null; printedHere?: boolean }
  /** Nothing to report: no closed shift waits for a Z. */
  | { kind: 'z_nothing' }
  /** No connection: owed, produced by the kiosk once the cloud answers. */
  | { kind: 'z_offline' }
  /** The close is not in the cloud yet: owed, produced by the kiosk once it is. */
  | { kind: 'z_waiting'; closing: number }
  | { kind: 'z_refused'; detail: string | null }
  | { kind: 'failed'; detail: string | null };

/** The shift close as the runner hears it. */
export type KioskZClose = { kind: 'closed'; shiftId: string } | { kind: 'pending'; count: number } | { kind: 'no_shift' } | { kind: 'changed' };

/** Whether the Z can be asked for: every close of the kiosk in the cloud. */
export type KioskZReady = { kind: 'ready' } | { kind: 'offline' } | { kind: 'waiting'; closing: number };

/** Asking the cloud for the Z, and printing it. */
export type KioskZAsk =
  | { kind: 'produced'; number: number; printError: string | null; printedHere?: boolean }
  | { kind: 'nothing' }
  | { kind: 'offline' }
  | { kind: 'waiting'; closing: number }
  | { kind: 'refused'; detail: string | null }
  | { kind: 'failed'; detail: string | null };

/** What the runner needs of the device. */
export interface KioskZPort {
  cardInFlight(): boolean;
  openShiftId(): string | null;
  pendingDocuments(shiftId: string): number;
  closeShift(shiftId: string, closedByName: string): Promise<KioskZClose> | KioskZClose;
  /** The card deals (doPeriodic), before the shift closes; kept for the Z. */
  transmit(): Promise<void>;
  prepare(): Promise<KioskZReady>;
  requestAndPrint(userId: string | null, userName: string | null): Promise<KioskZAsk>;
  /** The Z is owed: the kiosk produces it on its next idle tick the cloud answers. */
  oweZ(): void;
}

export const KIOSK_Z_PREPARE_TRIES = 8;
export const KIOSK_Z_PREPARE_PAUSE_MS = 1_500;

export class KioskZRunner {
  constructor(
    private readonly port: KioskZPort,
    private readonly pause: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly warn: (m: string) => void = () => undefined,
  ) {}

  /** A shop-Z kiosk's "סגירת משמרת": the shift closed here, uploaded, taken by the shop's next Z. */
  async closeShift(customerBusy: boolean, closedByName: string): Promise<KioskAdminZOutcome> {
    const g = this.gate(customerBusy);
    if (g) return { kind: 'blocked', block: g };
    const open = this.port.openShiftId();
    if (!open) return { kind: 'no_open_shift' };
    if (this.port.pendingDocuments(open) > 0) return { kind: 'blocked', block: 'pending_documents' };
    const closed = await this.port.closeShift(open, closedByName);
    switch (closed.kind) {
      case 'closed':
        return { kind: 'shift_closed', shiftId: closed.shiftId };
      case 'pending':
        return { kind: 'blocked', block: 'pending_documents' };
      case 'no_shift':
        return { kind: 'no_open_shift' };
      case 'changed':
        return { kind: 'blocked', block: 'shift_changed' };
    }
  }

  /** A kiosk with its own Z: card deals, the shift, the close delivered, the Z asked and printed. */
  async produceZ(customerBusy: boolean, closedByName: string, userId: string | null, userName: string | null): Promise<KioskAdminZOutcome> {
    const g = this.gate(customerBusy);
    if (g) return { kind: 'blocked', block: g };
    const before = this.port.openShiftId();
    if (before && this.port.pendingDocuments(before) > 0) return { kind: 'blocked', block: 'pending_documents' };
    // The card deals first, before the shift closes; a failure does not stop the Z — it is kept on it and reported.
    try {
      await this.port.transmit();
    } catch (e) {
      this.warn(`kiosk Z: transmission threw: ${String(e)}`);
    }
    const open = this.port.openShiftId();
    if (open) {
      const closed = await this.port.closeShift(open, closedByName);
      if (closed.kind === 'pending') return { kind: 'blocked', block: 'pending_documents' };
      if (closed.kind === 'changed') return { kind: 'blocked', block: 'shift_changed' };
    }
    // The close has to be in the cloud before the Z can include it: a few short tries.
    let ready = await this.port.prepare();
    for (let tries = 0; ready.kind === 'waiting' && tries < KIOSK_Z_PREPARE_TRIES; tries++) {
      await this.pause(KIOSK_Z_PREPARE_PAUSE_MS);
      ready = await this.port.prepare();
    }
    if (ready.kind === 'offline') {
      this.port.oweZ();
      return { kind: 'z_offline' };
    }
    if (ready.kind === 'waiting') {
      this.port.oweZ();
      return { kind: 'z_waiting', closing: ready.closing };
    }
    const asked = await this.port.requestAndPrint(userId, userName);
    switch (asked.kind) {
      case 'produced':
        return { kind: 'z_produced', number: asked.number, printError: asked.printError, ...(asked.printedHere === false ? { printedHere: false } : {}) };
      case 'nothing':
        return { kind: 'z_nothing' };
      case 'offline':
        this.port.oweZ();
        return { kind: 'z_offline' };
      case 'waiting':
        this.port.oweZ();
        return { kind: 'z_waiting', closing: asked.closing };
      case 'refused':
        return { kind: 'z_refused', detail: asked.detail };
      case 'failed':
        return { kind: 'failed', detail: asked.detail };
    }
  }

  private gate(customerBusy: boolean): KioskZLocalBlock | null {
    if (this.port.cardInFlight()) return 'card';
    if (customerBusy) return 'customer';
    return null;
  }
}

/** The admin's outcome, in words (adminOutcomeText). */
export function kioskZOutcomeText(o: KioskAdminZOutcome): string {
  switch (o.kind) {
    case 'blocked':
      return {
        customer: KZ_TEXT.blockedCustomer,
        card: KZ_TEXT.blockedCard,
        pending_documents: KZ_TEXT.blockedPending,
        shift_changed: KZ_TEXT.blockedChanged,
        running: KZ_TEXT.blockedRunning,
      }[o.block];
    case 'no_open_shift':
      return KZ_TEXT.noShift;
    case 'shift_closed':
      return KZ_TEXT.closed;
    case 'z_produced':
      if (o.printError) return KZ_TEXT.zDonePrintFailed(o.number, o.printError);
      return o.printedHere === false ? KZ_TEXT.zDoneElsewhere(o.number) : KZ_TEXT.zDone(o.number);
    case 'z_nothing':
      return KZ_TEXT.zNothing;
    case 'z_offline':
      return KZ_TEXT.zOffline;
    case 'z_waiting':
      return KZ_TEXT.zWaiting;
    case 'z_refused':
      return KZ_TEXT.zRefused(o.detail ?? '—');
    case 'failed':
      return KZ_TEXT.failed(o.detail ?? '—');
  }
}

/** A good outcome (the screen's note is not an error). */
export const kioskZOutcomeOk = (o: KioskAdminZOutcome): boolean =>
  o.kind === 'shift_closed' || o.kind === 'z_produced' || o.kind === 'z_nothing' || o.kind === 'z_offline' || o.kind === 'z_waiting';
