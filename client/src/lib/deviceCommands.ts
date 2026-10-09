/**
 * "פקודות שנשלחו" — every command the dashboard sends to a device is fire-and-forget
 * (the owner: "שליחת פקודה תשלח פקודה ותקרא ברקע").
 *
 * The pure half (no React, no `@/` imports — tested by node:test): what a tracked command is,
 * how each kind's server status maps to one shared phase (נשלח → התקבל במכשיר → בוצע / נכשל /
 * פג תוקף), what the chip and the tray say, and when to poll. The React half — the store, the
 * hook, the chip and the tray — is lib/deviceCommandsStore.ts and
 * components/dashboard/device-commands/.
 */

/** Every kind of device-bound request the dashboard follows in the background. */
export type CommandKind =
  | 'device' //        POST /device-commands (lock, unlock, sync_now, refresh_catalog, sign_out, restart_app, install_update)
  | 'card' //          POST /failed-payments/{id}/card-commands (check, mark_approved, mark_not_approved)
  | 'kiosk' //         POST /kiosks/{id}/commands (pause, resume, close_shift, till_z)
  | 'printer_test' //  POST /printers/{id}/test
  | 'shift_close' //   POST /machines/{id}/close-shift, and a remote close in a till's shop-Z mode
  | 'till_z' //        POST /machines/{id}/till-z, and a remote Z
  | 'transmit' //      POST /machines/{id}/transmit
  | 'reboot' //        POST /machines/{id}/reboot
  | 'till_message'; // POST /till-messages

export type CommandPhase = 'sending' | 'sent' | 'received' | 'done' | 'failed' | 'expired' | 'cancelled';

export interface TrackedCommand {
  /** The client's key: the send's Idempotency-Key, then one per device of its answer. */
  key: string;
  kind: CommandKind;
  /** The server's id (null while sending, or when the send itself failed). */
  id: string | null;
  machineId: string | null;
  machineName: string | null;
  /** The server's action word ("sync_now", "check"…). */
  action: string;
  /** Hebrew: "סנכרון", "בדיקה במסוף"… */
  label: string;
  phase: CommandPhase;
  /** Hebrew detail: a refusal's reason, a terminal's verdict… */
  detail: string | null;
  sentAt: number;
  updatedAt: number;
  /** The send itself failed (network / server): retried with the SAME key — never twice. */
  sendError: string | null;
  /** Extra ids a kind needs to read its status (printerId, jobIds, attemptId…). */
  ref?: Record<string, string>;
  /** What "נסה שוב" re-sends (a new command, with a new key) — kinds the store can resend. */
  resend?: { path: string; body: unknown } | null;
  /** When it entered the small centred popup (null / absent: not in it, or closed by hand). */
  popupAt?: number | null;
}

export const PHASE_LABELS: Record<CommandPhase, string> = {
  sending: 'שולח…',
  sent: 'נשלח',
  received: 'התקבל במכשיר',
  done: 'בוצע',
  failed: 'נכשל',
  expired: 'פג תוקף',
  cancelled: 'בוטל',
};

const FINAL: ReadonlySet<CommandPhase> = new Set(['done', 'failed', 'expired', 'cancelled']);

export function isFinal(phase: CommandPhase): boolean {
  return FINAL.has(phase);
}

export function isOpen(c: TrackedCommand): boolean {
  return !isFinal(c.phase) && c.sendError == null;
}

export function phaseTone(phase: CommandPhase): 'wait' | 'ok' | 'bad' | 'muted' {
  if (phase === 'done') return 'ok';
  if (phase === 'failed' || phase === 'expired') return 'bad';
  if (phase === 'cancelled') return 'muted';
  return 'wait';
}

// ── Labels ───────────────────────────────────────────────────────────────────

const ACTION_LABELS: Record<string, string> = {
  lock: 'נעילה',
  unlock: 'שחרור',
  sync_now: 'סנכרון',
  refresh_catalog: 'רענון קטלוג',
  sign_out: 'ניתוק משתמש',
  restart_app: 'הפעלה מחדש',
  install_update: 'התקנת עדכון',
  check: 'בדיקה במסוף',
  mark_approved: 'אשר והכנס',
  mark_not_approved: 'ביטול עסקה',
  pause: 'עצירת קיוסק',
  resume: 'הפעלת קיוסק',
  close_shift: 'סגירת משמרת',
  till_z: 'הפקת Z',
  printer_test: 'דף בדיקה',
  transmit: 'שידור עסקאות',
  reboot: 'הפעלה מחדש של המכשיר',
  till_message: 'הודעה לקופות',
};

export function actionLabelOf(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

const REASONS: Record<string, string> = {
  sale_in_progress: 'באמצע מכירה',
  payment_in_progress: 'באמצע תשלום',
  no_update: 'אין עדכון מוכן',
  not_supported: 'המכשיר לא תומך בפעולה',
  kiosk: 'קיוסק — השתמשו בעצירת קיוסק',
  needs_permission: 'נדרש אישור התקנה במכשיר',
  superseded: 'הוחלף בפקודה חדשה',
  manager_code: 'שוחרר בקוד מנהל בקופה',
  after_sale: 'אחרי המכירה',
  not_answered: 'נמסר ולא נענה',
};

export function reasonLabel(detail: string | null | undefined): string | null {
  if (!detail) return null;
  return REASONS[detail] ?? detail;
}

/** "פקודה נשלחה: סנכרון · ממתין" / "… · התקבל במכשיר" / "… · בוצע" / "… · נכשל: באמצע מכירה". */
export function chipText(c: Pick<TrackedCommand, 'label' | 'phase' | 'detail' | 'sendError'>): string {
  if (c.sendError) return `פקודה לא נשלחה: ${c.label} · ${c.sendError}`;
  const state =
    c.phase === 'sending' || c.phase === 'sent'
      ? 'ממתין'
      : c.phase === 'failed' && c.detail
        ? `${PHASE_LABELS.failed}: ${c.detail}`
        : PHASE_LABELS[c.phase];
  return `פקודה נשלחה: ${c.label} · ${state}`;
}

// ── Each kind's status → the shared phase ────────────────────────────────────

export interface PhaseUpdate {
  phase: CommandPhase;
  detail: string | null;
}

/** `device_commands`: pending → delivered → done / refused / failed; cancelled / expired. */
export function phaseOfDevice(status: string, detail?: string | null): PhaseUpdate {
  const why = reasonLabel(detail);
  switch (status) {
    case 'pending':
      return { phase: 'sent', detail: null };
    case 'delivered':
      return { phase: 'received', detail: null };
    case 'done':
      return { phase: 'done', detail: why };
    case 'refused':
      return { phase: 'failed', detail: why ? `נדחה — ${why}` : 'נדחה' };
    case 'failed':
      return { phase: 'failed', detail: why };
    case 'expired':
      return { phase: 'expired', detail: detail === 'not_answered' ? 'נמסר ולא נענה' : 'לא נמסר' };
    case 'cancelled':
      return { phase: 'cancelled', detail: why };
    default:
      return { phase: 'sent', detail: null };
  }
}

/** `card_attempt_commands`: pending (delivered or not) → done / failed / not_found / busy; expired / cancelled. */
export function phaseOfCard(c: {
  status: string;
  deliveredAt?: string | null;
  statusLabel?: string | null;
  verdictLabel?: string | null;
  resultLabel?: string | null;
  resultMessage?: string | null;
}): PhaseUpdate {
  switch (c.status) {
    case 'pending':
      return { phase: c.deliveredAt ? 'received' : 'sent', detail: null };
    case 'done':
      return { phase: 'done', detail: c.verdictLabel ?? c.resultLabel ?? null };
    case 'failed':
    case 'not_found':
    case 'busy':
      return { phase: 'failed', detail: c.statusLabel ?? c.resultMessage ?? null };
    case 'expired':
      return { phase: 'expired', detail: c.statusLabel ?? null };
    case 'cancelled':
      return { phase: 'cancelled', detail: null };
    default:
      return { phase: 'sent', detail: null };
  }
}

/** A shift close / transmit / till-Z request: waiting → in progress → completed / failed / expired / cancelled. */
export function phaseOfRequest(status: string, errorMessage?: string | null): PhaseUpdate {
  switch (status) {
    case 'waiting':
    case 'waiting_close':
      return { phase: 'sent', detail: null };
    case 'closing':
    case 'transmitting':
    case 'in_progress':
      return { phase: 'received', detail: null };
    case 'completed':
      return { phase: 'done', detail: null };
    case 'failed':
      return { phase: 'failed', detail: errorMessage ?? null };
    case 'expired':
      return { phase: 'expired', detail: null };
    case 'cancelled':
      return { phase: 'cancelled', detail: null };
    default:
      return { phase: 'sent', detail: null };
  }
}

/** A kiosk command's answer: applied at once / requested (a close or Z the kiosk runs) / refused. */
export function phaseOfKiosk(status: string, detail?: string | null): PhaseUpdate {
  if (status === 'applied') return { phase: 'done', detail: null };
  if (status === 'refused') return { phase: 'failed', detail: reasonLabel(detail) };
  return { phase: 'sent', detail: null };
}

/** A printer test's jobs (one per till that prints it): all done → done; any failed → failed. */
export function phaseOfPrintJobs(jobs: { status: string; error?: string | null }[]): PhaseUpdate {
  if (jobs.length === 0) return { phase: 'sent', detail: null };
  const failed = jobs.find((j) => j.status === 'failed');
  if (failed) return { phase: 'failed', detail: failed.error ?? null };
  if (jobs.every((j) => j.status === 'done')) return { phase: 'done', detail: null };
  if (jobs.every((j) => j.status === 'done' || j.status === 'expired')) return { phase: 'expired', detail: null };
  if (jobs.some((j) => j.status === 'printing' || j.status === 'done')) return { phase: 'received', detail: null };
  return { phase: 'sent', detail: null };
}

/** A device reboot request (lib/deviceManagement.ts `RebootRequest`). */
export function phaseOfReboot(status: string, reason?: string | null): PhaseUpdate {
  switch (status) {
    case 'pending':
      return { phase: 'sent', detail: null };
    case 'deferred':
      return { phase: 'received', detail: reason ? reasonLabel(reason) : 'ממתין שהמכשיר יתפנה' };
    case 'rebooting':
    case 'done':
    case 'completed':
      return { phase: 'done', detail: null };
    case 'refused':
    case 'failed':
      return { phase: 'failed', detail: reason ? reasonLabel(reason) : null };
    case 'expired':
      return { phase: 'expired', detail: null };
    case 'cancelled':
      return { phase: 'cancelled', detail: null };
    default:
      return { phase: 'sent', detail: null };
  }
}

/** A till message: sent to N tills → delivered to some → acknowledged by all ("קראתי"). */
export function phaseOfTillMessage(counts: { total: number; delivered: number; acknowledged: number; cancelled?: boolean }): PhaseUpdate {
  if (counts.cancelled) return { phase: 'cancelled', detail: null };
  if (counts.total > 0 && counts.acknowledged >= counts.total) return { phase: 'done', detail: null };
  if (counts.delivered > 0 || counts.acknowledged > 0) {
    return { phase: 'received', detail: `${counts.acknowledged}/${counts.total} אישרו` };
  }
  return { phase: 'sent', detail: null };
}

// ── The list ─────────────────────────────────────────────────────────────────

/** At most this many in the tray; a finished one leaves after an hour. */
export const MAX_TRACKED = 40;
export const KEEP_FINAL_MS = 60 * 60 * 1000;

export function newKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Add (newest first), replacing an entry with the same key. */
export function upsert(list: readonly TrackedCommand[], ...items: TrackedCommand[]): TrackedCommand[] {
  const keys = new Set(items.map((i) => i.key));
  return [...items, ...list.filter((c) => !keys.has(c.key))].slice(0, MAX_TRACKED);
}

/** A send's answer replaces its "sending" entry with one entry per command the server made. */
export function resolveSend(list: readonly TrackedCommand[], key: string, made: TrackedCommand[]): TrackedCommand[] {
  const at = list.findIndex((c) => c.key === key);
  const rest = list.filter((c) => c.key !== key && !made.some((m) => m.key === c.key));
  if (at < 0) return [...made, ...rest].slice(0, MAX_TRACKED);
  const out = [...rest];
  out.splice(Math.min(at, out.length), 0, ...made);
  return out.slice(0, MAX_TRACKED);
}

export function markSendFailed(list: readonly TrackedCommand[], key: string, error: string, now: number): TrackedCommand[] {
  return list.map((c) => (c.key === key ? { ...c, phase: 'failed' as const, sendError: error, updatedAt: now } : c));
}

/**
 * The background read's answers, by (kind, id). A final phase is kept (a late answer never
 * turns "בוצע" back into "נשלח"); returns the list and the entries whose phase changed.
 */
export function applyUpdates(
  list: readonly TrackedCommand[],
  kind: CommandKind,
  updates: ReadonlyMap<string, PhaseUpdate>,
  now: number,
): { list: TrackedCommand[]; changed: TrackedCommand[] } {
  const changed: TrackedCommand[] = [];
  const out = list.map((c) => {
    if (c.kind !== kind || c.id == null || isFinal(c.phase)) return c;
    const u = updates.get(c.id);
    if (!u || (u.phase === c.phase && u.detail === c.detail)) return c;
    const next = { ...c, phase: u.phase, detail: u.detail, updatedAt: now };
    if (u.phase !== c.phase) changed.push(next);
    return next;
  });
  return { list: out, changed };
}

/** The open ids of one kind — what the background read asks for. */
export function openIds(list: readonly TrackedCommand[], kind: CommandKind): string[] {
  return list.filter((c) => c.kind === kind && c.id != null && isOpen(c)).map((c) => c.id as string);
}

/**
 * How soon to read again: quickly while something was sent within the last minute, slower
 * after; null when nothing is open (no polling at all).
 */
export function pollDelayMs(list: readonly TrackedCommand[], now: number): number | null {
  const open = list.filter(isOpen);
  if (open.length === 0) return null;
  const youngest = Math.min(...open.map((c) => now - c.sentAt));
  if (youngest < 60_000) return 2_500;
  if (youngest < 10 * 60_000) return 8_000;
  return 30_000;
}

/** Drop finished entries older than an hour; keep at most MAX_TRACKED. */
export function prune(list: readonly TrackedCommand[], now: number): TrackedCommand[] {
  return list.filter((c) => !(isFinal(c.phase) && now - c.updatedAt > KEEP_FINAL_MS)).slice(0, MAX_TRACKED);
}

/** How long a finished command still shows on its device's row. */
export const CHIP_FINAL_MS = 2 * 60 * 1000;

/** The chip on a device's row: its newest open command, else one that finished in the last 2 minutes. */
export function latestForMachine(list: readonly TrackedCommand[], machineId: string, now: number): TrackedCommand | null {
  const mine = list.filter((c) => c.machineId === machineId);
  const open = mine.filter((c) => !isFinal(c.phase) || c.sendError != null);
  const pick = open.length > 0 ? open : mine.filter((c) => now - c.updatedAt <= CHIP_FINAL_MS);
  if (pick.length === 0) return null;
  return pick.reduce((a, b) => (b.sentAt > a.sentAt ? b : a));
}

// ── The centred popup ("חלון קטן באמצע המסך") ───────────────────────────────
//
// The immediate feedback of a send (the tray is the history): one small popup in the middle of
// the screen, no backdrop, listing what was just sent. A command still waiting after 5 s shrinks
// into the tray; one that finished while shown stays 3 s after "בוצע" (a failure 8 s, with
// "נסה שוב"); closed by hand at any time.

export const POPUP_PENDING_MS = 5_000;
export const POPUP_DONE_MS = 3_000;
export const POPUP_FAILED_MS = 8_000;

function lingerOf(c: Pick<TrackedCommand, 'phase' | 'sendError'>): number {
  return c.phase === 'done' && !c.sendError ? POPUP_DONE_MS : POPUP_FAILED_MS;
}

/** Whether a command is in the popup now. */
export function inPopup(c: TrackedCommand, now: number): boolean {
  if (c.popupAt == null) return false;
  if (isFinal(c.phase) || c.sendError) {
    // Only one that finished while it was still shown; then a few seconds more.
    return c.updatedAt - c.popupAt < POPUP_PENDING_MS && now < c.updatedAt + lingerOf(c);
  }
  return now - c.popupAt < POPUP_PENDING_MS;
}

/** The popup's lines, oldest first (a list in one popup, never several windows). */
export function popupItems(list: readonly TrackedCommand[], now: number): TrackedCommand[] {
  return list.filter((c) => inPopup(c, now)).sort((a, b) => (a.popupAt ?? 0) - (b.popupAt ?? 0));
}

/** When the popup next changes on its own (an item leaves it), or null when it is empty. */
export function popupNextChangeMs(list: readonly TrackedCommand[], now: number): number | null {
  const ends = popupItems(list, now).map((c) =>
    isFinal(c.phase) || c.sendError ? c.updatedAt + lingerOf(c) : (c.popupAt ?? now) + POPUP_PENDING_MS,
  );
  if (ends.length === 0) return null;
  return Math.max(0, Math.min(...ends) - now);
}

/** "נשלחה פקודה: סנכרון → קופה 2" */
export function popupLine(c: Pick<TrackedCommand, 'label' | 'machineName'>): string {
  return c.machineName ? `נשלחה פקודה: ${c.label} → ${c.machineName}` : `נשלחה פקודה: ${c.label}`;
}

/** "ממתין" → "התקבל" → "בוצע ✓" (or "נכשל"). */
export function popupStatus(c: Pick<TrackedCommand, 'phase' | 'detail' | 'sendError'>): string {
  if (c.sendError) return `לא נשלח — ${c.sendError}`;
  switch (c.phase) {
    case 'sending':
    case 'sent':
      return 'ממתין';
    case 'received':
      return 'התקבל';
    case 'done':
      return 'בוצע ✓';
    case 'failed':
      return c.detail ? `נכשל — ${c.detail}` : 'נכשל';
    case 'expired':
      return 'פג תוקף';
    case 'cancelled':
      return 'בוטל';
  }
}

/** Closed by hand: out of the popup (still in the tray). */
export function closePopup(list: readonly TrackedCommand[], key?: string): TrackedCommand[] {
  return list.map((c) => (key == null || c.key === key ? { ...c, popupAt: null } : c));
}

/** How many are still waiting (the tray's badge). */
export function openCount(list: readonly TrackedCommand[]): number {
  return list.filter(isOpen).length;
}

/** "לפני 3 דק׳" */
export function agoLabel(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 10) return 'עכשיו';
  if (s < 60) return `לפני ${s} שנ׳`;
  const m = Math.round(s / 60);
  if (m < 60) return `לפני ${m} דק׳`;
  return `לפני ${Math.round(m / 60)} שע׳`;
}

/** Whether a send's error is worth retrying with the same key (no answer, or the server failed). */
export function retryableSendError(status: number | null | undefined): boolean {
  return status == null || status === 0 || status === 408 || status === 429 || status >= 500;
}
