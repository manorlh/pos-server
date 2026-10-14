/**
 * "מצב סנכרון של מכשיר" (P:/specs/device-sync-status.md §3, §5.7; pos-server
 * app/services/sync_status.py): the types of `GET /machines/{id}/sync-status` and the pure rules
 * of the screens — a domain's mark and note, the devices list's "סנכרון" cell, the outbox line,
 * and "סנכרן עכשיו": each domain's progress (ממתין → נמשך → ✓ / ✗) and how a run ends ("הכל
 * התקבל ✓", what is still missing and why, "המכשיר לא ענה"), for one device or a whole shop.
 *
 * Pure (no React, no network, relative imports only) so `npm test` runs it with node:test.
 */

export type SyncState = 'up_to_date' | 'pending' | 'error' | 'unknown' | 'not_reported';

export interface SyncKeyRow {
  key: string;
  label: string;
  status: SyncState;
  version: string | null;
  cloudVersion: string | null;
  pulledAt: string | null;
  changedAt: string | null;
  since: string | null;
  error: string | null;
}

export interface SyncDomainRow {
  domain: string;
  label: string;
  status: SyncState;
  pulledAt: string | null;
  changedAt: string | null;
  pendingSince: string | null;
  error: string | null;
  stale: boolean;
  keys: SyncKeyRow[];
}

export interface SyncOutbox {
  documents: number;
  events: number;
  attendance: number;
  refunds: number;
  total: number;
  oldestAt: string | null;
  reportedAt: string | null;
}

export interface DeviceSyncStatus {
  machineId: string;
  machineName?: string | null;
  posNumber?: string | null;
  shopId?: string | null;
  online: boolean;
  reported: boolean;
  reportedAt: string | null;
  status: SyncState;
  pendingCount: number;
  errorCount: number;
  stale: boolean;
  staleSince: string | null;
  staleMinutes: number;
  domains: SyncDomainRow[];
  outbox: SyncOutbox | null;
  generatedAt?: string;
}

export interface SyncStatusList {
  generatedAt: string;
  items: DeviceSyncStatus[];
}

/** A `sync_now` command as `GET /device-commands/status` says it. */
export interface CommandView {
  id?: string;
  machineId?: string;
  status: string;
  detail?: string | null;
}

/** "סנכרן עכשיו" waits this long for every domain to arrive (§3). */
export const SYNC_RUN_TIMEOUT_MS = 60_000;
/** How often a run asks. */
export const SYNC_POLL_MS = 2_500;
/** The most devices one `GET /machines/sync-status` reads (the server's own cap). */
export const SYNC_STATUS_MAX_DEVICES = 200;

export const STATE_LABEL: Record<SyncState, string> = {
  up_to_date: 'מעודכן',
  pending: 'ממתין לעדכון',
  error: 'שגיאה',
  unknown: 'לא ידוע',
  not_reported: 'לא מדווח',
};

export type Tone = 'ok' | 'wait' | 'error' | 'muted';

export function markOf(status: SyncState | null | undefined): { mark: string; tone: Tone } {
  switch (status) {
    case 'up_to_date':
      return { mark: '✓', tone: 'ok' };
    case 'pending':
      return { mark: '⏳', tone: 'wait' };
    case 'error':
      return { mark: '✗', tone: 'error' };
    case 'unknown':
      return { mark: '?', tone: 'muted' };
    default:
      return { mark: '—', tone: 'muted' };
  }
}

function ms(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** "HH:MM" by default; injected by the tests. */
export type TimeFormat = (iso: string) => string;

/**
 * The line under a domain: what changed in the cloud and when ("קטלוג השתנה ב-10:42"), the device's
 * error, or nothing.
 */
export function domainNote(d: SyncDomainRow, time: TimeFormat): string | null {
  if (d.status === 'pending') {
    return d.changedAt ? `${d.label} השתנה ב-${time(d.changedAt)}` : 'יש גרסה חדשה בענן';
  }
  if (d.status === 'error') return d.error ? `שגיאה: ${d.error}` : 'שגיאה במשיכה';
  if (d.status === 'unknown') return 'הענן לא הצליח לחשב את הגרסה';
  return null;
}

/** The devices list's "סנכרון": ✓, ⏳ with how many domains wait, ✗, or — (not reported). */
export function listCell(s: DeviceSyncStatus | null | undefined): { mark: string; count: number | null; tone: Tone; title: string } {
  if (!s || !s.reported || s.status === 'not_reported') {
    return { mark: '—', count: null, tone: 'muted', title: 'המכשיר לא מדווח מצב סנכרון' };
  }
  if (s.status === 'error') {
    const failing = s.domains.filter((d) => d.status === 'error').map((d) => d.label);
    return { mark: '✗', count: s.errorCount || null, tone: 'error', title: `שגיאה: ${failing.join(', ')}` };
  }
  if (s.status === 'pending') {
    const waiting = s.domains.filter((d) => d.status === 'pending').map((d) => d.label);
    return { mark: '⏳', count: s.pendingCount, tone: 'wait', title: `ממתין: ${waiting.join(', ')}` };
  }
  if (s.status === 'unknown') return { mark: '?', count: null, tone: 'muted', title: STATE_LABEL.unknown };
  return { mark: '✓', count: null, tone: 'ok', title: 'הכל מעודכן' };
}

const OUTBOX_WORDS: Array<[keyof Pick<SyncOutbox, 'documents' | 'events' | 'attendance' | 'refunds'>, string, string]> = [
  ['documents', 'מסמך', 'מסמכים'],
  ['refunds', 'זיכוי', 'זיכויים'],
  ['attendance', 'דיווח נוכחות', 'דיווחי נוכחות'],
  ['events', 'אירוע', 'אירועים'],
];

/** "3 מסמכים, הישן מ-10:31" — what the device holds and has not uploaded; "הכל הועלה" when nothing. */
export function outboxLine(o: SyncOutbox | null | undefined, time: TimeFormat): string | null {
  if (!o) return null;
  const parts = OUTBOX_WORDS.filter(([k]) => (o[k] ?? 0) > 0).map(([k, one, many]) =>
    o[k] === 1 ? `${one} אחד` : `${o[k]} ${many}`,
  );
  if (parts.length === 0) return 'הכל הועלה לענן';
  return o.oldestAt ? `${parts.join(', ')}, הישן מ-${time(o.oldestAt)}` : parts.join(', ');
}

// ── "סנכרן עכשיו" ──────────────────────────────────────────────────────────

export type DomainProgress = 'waiting' | 'pulling' | 'done' | 'error';

export const PROGRESS_LABEL: Record<DomainProgress, string> = {
  waiting: 'ממתין',
  pulling: 'נמשך',
  done: '✓',
  error: '✗',
};

const FINAL_COMMAND = new Set(['done', 'refused', 'failed', 'expired', 'cancelled']);
const ANSWERED_COMMAND = new Set(['delivered', 'done', 'refused', 'failed']);

/** The device said something since the run began: its report, or its command was taken / answered. */
export function deviceAnswered(s: DeviceSyncStatus | null | undefined, startedAt: number, command?: CommandView | null): boolean {
  const reported = ms(s?.reportedAt);
  return (reported !== null && reported >= startedAt) || (!!command && ANSWERED_COMMAND.has(command.status));
}

export function domainProgress(
  d: SyncDomainRow,
  s: DeviceSyncStatus,
  startedAt: number,
  command?: CommandView | null,
): DomainProgress {
  if (d.status === 'up_to_date') return 'done';
  if (!deviceAnswered(s, startedAt, command)) return 'waiting';
  const reported = ms(s.reportedAt);
  if (d.status === 'error' && reported !== null && reported >= startedAt) return 'error';
  return 'pulling';
}

export interface MissingItem {
  domain: string;
  label: string;
  reason: string;
}

export type RunOutcome =
  | { kind: 'running' }
  | { kind: 'all_received' }
  | { kind: 'incomplete'; missing: MissingItem[] }
  | { kind: 'no_answer' }
  | { kind: 'not_reporting' }
  | { kind: 'refused'; detail: string | null };

const REFUSAL_REASON: Record<string, string> = {
  sale_in_progress: 'יש מכירה פתוחה',
  payment_in_progress: 'יש תשלום באמצע',
  not_supported: 'הגרסה במכשיר לא תומכת',
  kiosk: 'קיוסק',
};

function missingOf(s: DeviceSyncStatus, time: TimeFormat): MissingItem[] {
  return s.domains
    .filter((d) => d.status !== 'up_to_date')
    .map((d) => ({
      domain: d.domain,
      label: d.label,
      reason:
        d.status === 'error'
          ? d.error
            ? `שגיאה: ${d.error}`
            : 'שגיאה במשיכה'
          : d.status === 'unknown'
            ? 'הענן לא הצליח לחשב את הגרסה'
            : d.changedAt
              ? `עוד לא התקבל (השתנה ב-${time(d.changedAt)})`
              : 'עוד לא התקבל',
    }));
}

/**
 * How a run stands now:
 *
 * * every reported domain up to date → "הכל התקבל ✓" (the device holds the cloud's current version
 *   of each — true whenever it pulled it);
 * * the device refused, or the command expired / was cancelled → said at once;
 * * the device answered and its sync is over (`done` / `failed`) and it reported after the run
 *   began → what is still missing and why;
 * * 60 seconds without everything: "המכשיר לא ענה" when nothing came from it at all; "לא מדווח"
 *   when it answered but its build does not report; else what is still missing.
 */
export function runOutcome(
  s: DeviceSyncStatus | null | undefined,
  startedAt: number,
  now: number,
  command: CommandView | null | undefined,
  time: TimeFormat,
  timeoutMs: number = SYNC_RUN_TIMEOUT_MS,
): RunOutcome {
  const reportedAfter = (() => {
    const r = ms(s?.reportedAt);
    return r !== null && r >= startedAt;
  })();
  if (s && s.reported && s.domains.length > 0 && s.domains.every((d) => d.status === 'up_to_date')) {
    return { kind: 'all_received' };
  }
  if (command && (command.status === 'refused' || command.status === 'cancelled')) {
    return { kind: 'refused', detail: command.detail ? REFUSAL_REASON[command.detail] ?? command.detail : null };
  }
  const answered = deviceAnswered(s, startedAt, command);
  if (command && command.status === 'expired' && !answered) return { kind: 'no_answer' };
  const commandOver = !!command && FINAL_COMMAND.has(command.status);
  if (commandOver && answered && s && !s.reported) return { kind: 'not_reporting' };
  if (commandOver && reportedAfter && s && s.reported) return { kind: 'incomplete', missing: missingOf(s, time) };
  if (now - startedAt < timeoutMs) return { kind: 'running' };
  if (!answered) return { kind: 'no_answer' };
  if (!s || !s.reported) return { kind: 'not_reporting' };
  return { kind: 'incomplete', missing: missingOf(s, time) };
}

export function outcomeText(o: RunOutcome): string {
  switch (o.kind) {
    case 'running':
      return 'מסנכרן…';
    case 'all_received':
      return 'הכל התקבל ✓';
    case 'no_answer':
      return 'המכשיר לא ענה';
    case 'not_reporting':
      return 'המכשיר סנכרן, אבל הגרסה שלו לא מדווחת מה התקבל';
    case 'refused':
      return o.detail ? `המכשיר דחה את הסנכרון: ${o.detail}` : 'המכשיר דחה את הסנכרון';
    case 'incomplete':
      return o.missing.length === 0 ? 'עוד לא התקבל הכל' : `עוד לא התקבל: ${o.missing.map((m) => m.label).join(', ')}`;
  }
}

// ── "סנכרן את כל הסניף" ────────────────────────────────────────────────────

export interface BranchRow {
  machineId: string;
  name: string;
  outcome: RunOutcome;
}

export interface BranchSummary {
  rows: BranchRow[];
  /** Every device's run is over. */
  done: boolean;
  counts: { received: number; incomplete: number; noAnswer: number; notReporting: number; refused: number; running: number };
  text: string;
}

export function branchSummary(
  items: readonly DeviceSyncStatus[],
  commands: ReadonlyMap<string, CommandView>,
  startedAt: number,
  now: number,
  time: TimeFormat,
  names: ReadonlyMap<string, string> = new Map(),
): BranchSummary {
  const counts = { received: 0, incomplete: 0, noAnswer: 0, notReporting: 0, refused: 0, running: 0 };
  // Only the devices the command went to: the shop's screens and the rest were never asked.
  const asked = items.filter((s) => commands.has(s.machineId));
  const rows = asked.map((s) => {
    const outcome = runOutcome(s, startedAt, now, commands.get(s.machineId), time);
    if (outcome.kind === 'all_received') counts.received += 1;
    else if (outcome.kind === 'incomplete') counts.incomplete += 1;
    else if (outcome.kind === 'no_answer') counts.noAnswer += 1;
    else if (outcome.kind === 'not_reporting') counts.notReporting += 1;
    else if (outcome.kind === 'refused') counts.refused += 1;
    else counts.running += 1;
    return { machineId: s.machineId, name: names.get(s.machineId) ?? s.machineName ?? s.machineId, outcome };
  });
  const done = counts.running === 0;
  const parts = [
    counts.received ? `${counts.received} קיבלו הכל` : null,
    counts.incomplete ? `${counts.incomplete} עוד לא קיבלו הכל` : null,
    counts.noAnswer ? `${counts.noAnswer} לא ענו` : null,
    counts.notReporting ? `${counts.notReporting} לא מדווחים` : null,
    counts.refused ? `${counts.refused} דחו` : null,
    counts.running ? `${counts.running} עוד מסנכרנים` : null,
  ].filter(Boolean);
  const text = rows.length === 0 ? 'אין מכשירים לסנכרן' : `${rows.length} מכשירים: ${parts.join(', ')}`;
  return { rows, done, counts, text };
}

/** `GET /machines/sync-status` in chunks the server takes. */
export function chunkIds(ids: readonly string[], size: number = SYNC_STATUS_MAX_DEVICES): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}
