/**
 * "שליחת לוגים לענן" — a device's logs for support (pos-server app/services/device_logs.py; the
 * contract is specs/device-logs-api.md).
 *
 * The pure half (no React, no `@/` imports — tested by node:test): the wire types, the minutes
 * picker's rules (15–1440, default 120), sizes and time ranges as the list shows them, "חדש",
 * a request's "נשלח / התקבל", the download's file name, the search highlight and the super
 * admin's filters. The React half is components/dashboard/machines/device-logs.tsx and
 * app/dashboard/device-logs/page.tsx; sending a request is lib/deviceCommandsStore.ts
 * `sendDeviceLogsRequest` (fire-and-forget, like every command).
 */

export type LogReason = 'manual' | 'remote' | 'crash';
export const LOG_REASONS: readonly LogReason[] = ['manual', 'remote', 'crash'];

/** One upload, as content readers see it (never its content). */
export interface DeviceLogUpload {
  id: string;
  uploadId: string;
  machineId: string;
  machineName: string | null;
  posNumber: string | null;
  tenantId: string | null;
  tenantName: string | null;
  branchId: string | null;
  branchName: string | null;
  reason: LogReason;
  commandId: string | null;
  requestedBy: string | null;
  note: string | null;
  appVersion: string | null;
  versionCode: number | null;
  deviceModel: string | null;
  os: string | null;
  fromMs: number | null;
  toMs: number | null;
  lineCount: number | null;
  sizeBytes: number;
  inflatedBytes: number | null;
  receivedAt: string;
  openedAt: string | null;
  openedBy: string | null;
  isNew: boolean;
}

export interface DeviceLogList {
  items: DeviceLogUpload[];
  total: number;
  newCount: number;
}

/** A "בקש לוגים" request, as everyone who may request sees it. */
export interface LogsRequest {
  id: string;
  machineId: string;
  status: string;
  detail: string | null;
  minutes: number | null;
  createdBy: string | null;
  createdAt: string | null;
  deliveredAt: string | null;
  doneAt: string | null;
  expiresAt: string | null;
  logId: string | null;
  received: boolean;
}

/** `GET /device-logs/machines/{id}`: the device's "לוגים". `uploads` only for a content reader. */
export interface MachineLogs {
  machineId: string;
  capable: boolean;
  appVersion: string | null;
  canRead: boolean;
  canRequest: boolean;
  minutes: { min: number; max: number; default: number };
  requests: LogsRequest[];
  uploads: DeviceLogList | null;
}

export interface LogLine {
  n: number;
  text: string;
}

export interface LogLines {
  id: string;
  lines: LogLine[];
  more: boolean;
  query: string | null;
  scannedLines: number;
}

// ── The minutes picker ───────────────────────────────────────────────────────

export const MINUTES_MIN = 15;
export const MINUTES_MAX = 1440;
export const MINUTES_DEFAULT = 120;
/** The picker's choices (any whole number 15–1440 is valid). */
export const MINUTE_CHOICES: readonly number[] = [15, 30, 60, 120, 240, 480, 720, 1440];

/** A whole number in 15–1440; anything unreadable is the default. */
export function clampMinutes(value: unknown): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.trim()) : Number.NaN;
  if (!Number.isFinite(n)) return MINUTES_DEFAULT;
  return Math.min(MINUTES_MAX, Math.max(MINUTES_MIN, Math.round(n)));
}

/** "15 דק׳", "שעה", "שעתיים", "4 שעות", "24 שעות", "90 דק׳". */
export function minutesLabel(minutes: number): string {
  if (minutes === 60) return 'שעה';
  if (minutes === 120) return 'שעתיים';
  if (minutes % 60 === 0) return `${minutes / 60} שעות`;
  return `${minutes} דק׳`;
}

// ── How the list shows a row ─────────────────────────────────────────────────

/** "820 B", "12.4 KB", "1.3 MB". */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const TZ = 'Asia/Jerusalem';

function parts(ms: number): { day: string; time: string } {
  const d = new Date(ms);
  const day = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, day: '2-digit', month: '2-digit' }).format(d).replace('/', '.');
  const time = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(d);
  return { day, time };
}

/** The log's time range: "09.10 12:00–14:00", or across days "08.10 23:00 – 09.10 01:00". */
export function rangeLabel(fromMs: number | null | undefined, toMs: number | null | undefined): string {
  if (fromMs == null || toMs == null || !Number.isFinite(fromMs) || !Number.isFinite(toMs)) return '—';
  const a = parts(fromMs);
  const b = parts(toMs);
  return a.day === b.day ? `${a.day} ${a.time}–${b.time}` : `${a.day} ${a.time} – ${b.day} ${b.time}`;
}

/** "חדש": a manual upload with a note nobody opened yet (the server says it; this is its rule). */
export function isNewUpload(u: Pick<DeviceLogUpload, 'reason' | 'note' | 'openedAt'>): boolean {
  return u.reason === 'manual' && !!u.note?.trim() && !u.openedAt;
}

/** A request's line: "נשלח" until the device took it, "התקבל במכשיר", then "הלוג התקבל". */
export type RequestState = 'sent' | 'delivered' | 'received' | 'failed' | 'expired' | 'cancelled';

export function requestState(r: Pick<LogsRequest, 'status' | 'received'>): RequestState {
  if (r.received) return 'received';
  switch (r.status) {
    case 'pending':
      return 'sent';
    case 'delivered':
      return 'delivered';
    case 'done':
      return 'received';
    case 'refused':
    case 'failed':
      return 'failed';
    case 'expired':
      return 'expired';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'sent';
  }
}

/** Still on its way: the device has not sent the log yet. */
export function isOpenRequest(r: Pick<LogsRequest, 'status' | 'received'>): boolean {
  const s = requestState(r);
  return s === 'sent' || s === 'delivered';
}

// ── Downloads ────────────────────────────────────────────────────────────────

/** "לוגים-קופה_2-20261009-1412.txt": the device's name (file-safe) and when it arrived (Israel time). */
export function logFileName(
  u: Pick<DeviceLogUpload, 'machineName' | 'machineId' | 'receivedAt'>,
  kind: 'txt' | 'gz',
): string {
  const name = (u.machineName ?? '').trim().replace(/[\\/:*?"<>|\s]+/g, '_').replace(/^_+|_+$/g, '') || u.machineId.slice(0, 8);
  const at = new Date(u.receivedAt);
  let stamp = '';
  if (!Number.isNaN(at.getTime())) {
    const f = new Intl.DateTimeFormat('en-GB', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(at);
    const get = (t: string) => f.find((p) => p.type === t)?.value ?? '';
    stamp = `-${get('year')}${get('month')}${get('day')}-${get('hour')}${get('minute')}`;
  }
  return `לוגים-${name}${stamp}.${kind === 'gz' ? 'log.gz' : 'txt'}`;
}

// ── "צפה": the search highlight ──────────────────────────────────────────────

/** The line cut where the query matches (case-insensitive), for <mark>. No query: one plain part. */
export function highlightParts(text: string, query: string | null | undefined): { text: string; match: boolean }[] {
  const q = (query ?? '').trim();
  if (!q) return [{ text, match: false }];
  const out: { text: string; match: boolean }[] = [];
  const hay = text.toLocaleLowerCase();
  const needle = q.toLocaleLowerCase();
  let at = 0;
  while (at <= text.length) {
    const i = hay.indexOf(needle, at);
    if (i < 0) break;
    if (i > at) out.push({ text: text.slice(at, i), match: false });
    out.push({ text: text.slice(i, i + needle.length), match: true });
    at = i + needle.length;
  }
  if (at < text.length) out.push({ text: text.slice(at), match: false });
  return out.length ? out : [{ text, match: false }];
}

// ── The super admin's page ───────────────────────────────────────────────────

export interface LogFilters {
  tenantId?: string | null;
  companyId?: string | null;
  shopId?: string | null;
  machineId?: string | null;
  reason?: LogReason | null;
  /** YYYY-MM-DD, Israel's day. */
  dateFrom?: string | null;
  dateTo?: string | null;
  onlyNew?: boolean;
  limit?: number;
  offset?: number;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The query of `GET /device-logs`: only what is set (a bad date is left out, not sent). */
export function listParams(f: LogFilters): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ['tenantId', 'companyId', 'shopId', 'machineId'] as const) {
    const v = f[key];
    if (v) out[key] = v;
  }
  if (f.reason && LOG_REASONS.includes(f.reason)) out.reason = f.reason;
  if (f.dateFrom && DAY.test(f.dateFrom)) out.dateFrom = f.dateFrom;
  if (f.dateTo && DAY.test(f.dateTo)) out.dateTo = f.dateTo;
  if (f.onlyNew) out.onlyNew = 'true';
  if (f.limit != null) out.limit = String(f.limit);
  if (f.offset) out.offset = String(f.offset);
  return out;
}
