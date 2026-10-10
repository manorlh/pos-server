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
  | 'till_message' //  POST /till-messages
  | 'device_logs'; //  POST /device-logs/requests ("בקש לוגים": an upload_logs command)

/** `unknown`: followed for hours with no answer — the tray gives up ("לא ידוע — בדוק במכשיר"). */
export type CommandPhase = 'sending' | 'sent' | 'received' | 'done' | 'failed' | 'expired' | 'cancelled' | 'unknown';

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
  /** Who sent it, in which tenant: a shared PC never shows (or polls) another user's / tenant's commands. */
  userId?: string | null;
  tenantId?: string | null;
}

export const PHASE_LABELS: Record<CommandPhase, string> = {
  sending: 'שולח…',
  sent: 'נשלח',
  received: 'התקבל במכשיר',
  done: 'בוצע',
  failed: 'נכשל',
  expired: 'פג תוקף',
  cancelled: 'בוטל',
  unknown: 'לא ידוע — בדוק במכשיר',
};

const FINAL: ReadonlySet<CommandPhase> = new Set(['done', 'failed', 'expired', 'cancelled', 'unknown']);

export function isFinal(phase: CommandPhase): boolean {
  return FINAL.has(phase);
}

export function isOpen(c: TrackedCommand): boolean {
  return !isFinal(c.phase) && c.sendError == null;
}

export function phaseTone(phase: CommandPhase): 'wait' | 'ok' | 'bad' | 'muted' {
  if (phase === 'done') return 'ok';
  if (phase === 'failed' || phase === 'expired') return 'bad';
  if (phase === 'cancelled' || phase === 'unknown') return 'muted';
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
  upload_logs: 'בקשת לוגים',
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

/** A close done in the forced mode ("כפה סגירה", pos-server remote_close_force.py): its words say it all. */
const FORCED_DONE = 'נסגר בכפייה מרחוק';

/**
 * "פקודה נשלחה: סנכרון · ממתין" / "… · התקבל במכשיר" / "… · בוצע" / "… · נכשל: באמצע מכירה" /
 * "… · נסגר בכפייה מרחוק ע״י דנה".
 */
export function chipText(c: Pick<TrackedCommand, 'label' | 'phase' | 'detail' | 'sendError'>): string {
  if (c.sendError) return `פקודה לא נשלחה: ${c.label} · ${c.sendError}`;
  const state =
    c.phase === 'sending' || c.phase === 'sent'
      ? 'ממתין'
      : c.phase === 'failed' && c.detail
        ? `${PHASE_LABELS.failed}: ${c.detail}`
        : c.phase === 'done' && c.detail?.startsWith(FORCED_DONE)
          ? c.detail
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

/**
 * "בקש לוגים" (`GET /device-logs/requests/status`): an `upload_logs` command — נשלח → התקבל במכשיר →
 * "הלוג התקבל" once its upload arrived (`received`), never the log's content.
 */
export function phaseOfDeviceLogs(status: string, received: boolean, detail?: string | null): PhaseUpdate {
  if (received) return { phase: 'done', detail: 'הלוג התקבל' };
  return phaseOfDevice(status, detail);
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

/**
 * A shift close / transmit / till-Z request: waiting → in progress → completed / failed / expired / cancelled.
 * [forcedWords]: the server's "נסגר בכפייה מרחוק ע״י …" for a remote close done in the forced mode.
 */
export function phaseOfRequest(status: string, errorMessage?: string | null, forcedWords?: string | null): PhaseUpdate {
  switch (status) {
    case 'waiting':
    case 'waiting_close':
      return { phase: 'sent', detail: null };
    case 'closing':
    case 'transmitting':
    case 'in_progress':
      return { phase: 'received', detail: null };
    case 'completed':
      return { phase: 'done', detail: forcedWords ?? null };
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

/**
 * A kiosk command's answer: applied at once / refused / requested — a close or Z handed to the
 * kiosk's own request channel. `requested` is final here: the cloud took it and the kiosk runs it
 * when free (its Z / close follows on the kiosks' page); the tray does not keep polling it.
 */
export function phaseOfKiosk(status: string, detail?: string | null): PhaseUpdate {
  if (status === 'applied') return { phase: 'done', detail: null };
  if (status === 'refused') return { phase: 'failed', detail: reasonLabel(detail) };
  if (status === 'requested') return { phase: 'done', detail: 'הועבר לקיוסק — יבוצע כשיתפנה' };
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

/**
 * A device reboot, read from the machine's `rebootRequest`: [current] is the machine's request
 * now (null: none). Another request in its place means ours was replaced — final.
 */
export function phaseOfRebootRead(id: string, current: { id?: string | null; status: string; reason?: string | null } | null): PhaseUpdate {
  if (current == null) return { phase: 'unknown', detail: null };
  if (current.id && current.id !== id) return { phase: 'cancelled', detail: 'הוחלפה בבקשה חדשה' };
  return phaseOfReboot(current.status, current.reason);
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

/**
 * A till message: sent to N tills → delivered to some → acknowledged by all ("קראתי"); its end
 * (`expiresAt`, or an expired status) ends it too.
 */
export function phaseOfTillMessage(
  counts: { total: number; delivered: number; acknowledged: number; cancelled?: boolean },
  end?: { expiresAt?: string | null; status?: string | null; now?: number },
): PhaseUpdate {
  if (counts.cancelled) return { phase: 'cancelled', detail: null };
  if (counts.total > 0 && counts.acknowledged >= counts.total) return { phase: 'done', detail: null };
  const endsAt = end?.expiresAt ? Date.parse(end.expiresAt) : Number.NaN;
  if (end?.status === 'expired' || (Number.isFinite(endsAt) && end?.now != null && endsAt <= end.now)) {
    return { phase: 'expired', detail: `${counts.acknowledged}/${counts.total} אישרו` };
  }
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

/**
 * One Idempotency-Key per user action: the same request retried (a network error, a second click)
 * gets the same key — so the server answers with the first command, never a second one — while a
 * changed request (an edited body, another action) gets a new key. `forget()` after a success (the
 * next action is a new command) or on `idempotency_key_reused`.
 */
export interface KeyRing {
  keyFor(request: unknown): string;
  forget(request?: unknown): void;
}

export function keyRing(make: () => string = newKey): KeyRing {
  const keys = new Map<string, string>();
  const idOf = (request: unknown) => JSON.stringify(request ?? null);
  return {
    keyFor(request) {
      const id = idOf(request);
      let key = keys.get(id);
      if (!key) {
        key = make();
        keys.set(id, key);
      }
      return key;
    },
    forget(request) {
      if (request === undefined) keys.clear();
      else keys.delete(idOf(request));
    },
  };
}

/** The server refused a key already used for another request (422 `idempotency_key_reused`). */
export function isKeyReused(err: unknown): boolean {
  const r = (err as { response?: { status?: number; data?: { detail?: { code?: string } } } })?.response;
  return r?.status === 422 && r?.data?.detail?.code === 'idempotency_key_reused';
}

/**
 * At most MAX_TRACKED: when trimming, the oldest FINISHED entries go first; an open one (still
 * followed) only when there are more than MAX_TRACKED open ones.
 */
export function cap(list: readonly TrackedCommand[]): TrackedCommand[] {
  if (list.length <= MAX_TRACKED) return list as TrackedCommand[];
  let excess = list.length - MAX_TRACKED;
  const drop = new Set<string>();
  for (let i = list.length - 1; i >= 0 && excess > 0; i--) {
    if (isFinal(list[i].phase) || list[i].sendError != null) {
      drop.add(list[i].key);
      excess--;
    }
  }
  const kept = list.filter((c) => !drop.has(c.key));
  return kept.slice(0, MAX_TRACKED);
}

/** Add (newest first), replacing an entry with the same key. */
export function upsert(list: readonly TrackedCommand[], ...items: TrackedCommand[]): TrackedCommand[] {
  const keys = new Set(items.map((i) => i.key));
  return cap([...items, ...list.filter((c) => !keys.has(c.key))]);
}

/** A send's answer replaces its "sending" entry with one entry per command the server made. */
export function resolveSend(list: readonly TrackedCommand[], key: string, made: TrackedCommand[]): TrackedCommand[] {
  const at = list.findIndex((c) => c.key === key);
  const rest = list.filter((c) => c.key !== key && !made.some((m) => m.key === c.key));
  if (at < 0) return cap([...made, ...rest]);
  const out = [...rest];
  out.splice(Math.min(at, out.length), 0, ...made);
  return cap(out);
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
  let touched = false;
  const out = list.map((c) => {
    if (c.kind !== kind || c.id == null || isFinal(c.phase)) return c;
    const u = updates.get(c.id);
    if (!u || (u.phase === c.phase && u.detail === c.detail)) return c;
    touched = true;
    const next = { ...c, phase: u.phase, detail: u.detail, updatedAt: now };
    if (u.phase !== c.phase) changed.push(next);
    return next;
  });
  // Nothing moved: the same array (no re-render of every chip).
  return { list: touched ? out : (list as TrackedCommand[]), changed };
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
  const open = list.filter((c) => isOpen(c) && now - c.sentAt < GIVE_UP_MS);
  if (open.length === 0) return null;
  const youngest = Math.min(...open.map((c) => now - c.sentAt));
  if (youngest < 60_000) return 2_500;
  if (youngest < 10 * 60_000) return 8_000;
  if (youngest < 60 * 60_000) return 30_000;
  return 2 * 60_000; // backed off to minutes before giving up
}

/** An open command followed this long with no final answer: the tray gives up ("לא ידוע — בדוק במכשיר"). */
export const GIVE_UP_MS = 4 * 60 * 60 * 1000;

/** Open commands past GIVE_UP_MS become `unknown` (final: no more polling). Same array when none. */
export function giveUp(list: readonly TrackedCommand[], now: number): TrackedCommand[] {
  if (!list.some((c) => isOpen(c) && now - c.sentAt >= GIVE_UP_MS)) return list as TrackedCommand[];
  return list.map((c) => (isOpen(c) && now - c.sentAt >= GIVE_UP_MS ? { ...c, phase: 'unknown' as const, detail: null, updatedAt: now } : c));
}

/** Drop finished entries older than an hour, give up on very old open ones; at most MAX_TRACKED. Same array when nothing changes. */
export function prune(list: readonly TrackedCommand[], now: number): TrackedCommand[] {
  const given = giveUp(list, now);
  const stale = given.some((c) => isFinal(c.phase) && now - c.updatedAt > KEEP_FINAL_MS);
  const kept = stale ? given.filter((c) => !(isFinal(c.phase) && now - c.updatedAt > KEEP_FINAL_MS)) : given;
  return cap(kept);
}

/**
 * After a reload (sessionStorage): a send still "sending" never got its answer in this page — it
 * is offered again with its own key ("נסה שוב": the server answers with the first command if it
 * did arrive, never a second one).
 */
export function afterRehydrate(list: readonly TrackedCommand[], now: number): TrackedCommand[] {
  if (!list.some((c) => c.phase === 'sending')) return list as TrackedCommand[];
  return list.map((c) =>
    c.phase === 'sending'
      ? { ...c, phase: 'failed' as const, sendError: 'החיבור נקטע לפני שהתקבלה תשובה', updatedAt: now, popupAt: null }
      : c,
  );
}

/** Only the signed-in user's commands in the active tenant (a shared PC, a tenant switch). */
export function visibleTo(list: readonly TrackedCommand[], userId: string | null | undefined, tenantId: string | null | undefined): TrackedCommand[] {
  if (!userId || !tenantId) return [];
  return list.filter((c) => c.userId === userId && c.tenantId === tenantId);
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
    case 'unknown':
      return PHASE_LABELS.unknown;
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
