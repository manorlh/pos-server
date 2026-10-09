/**
 * "נוכחות עובדים" — the shapes the attendance pages read (server: app/routers/attendance.py,
 * docs/SPEC_ATTENDANCE.md) and the pure helpers they share: worked time, notes, export rows.
 *
 * Pure on purpose (relative imports only, no React): `npm test` compiles it on its own.
 * Attendance is not the till login — `currentMachine` is shown, never used to decide.
 */

export type AttendanceStatus = 'working' | 'on_break' | 'finished' | 'pending_approval';

export interface AttendanceBreak {
  id: string;
  startAt: string;
  endAt?: string | null;
  source?: string;
}

export interface MachineLabel {
  id: string;
  name?: string | null;
  posNumber?: string | null;
}

export interface AttendanceShift {
  id: string;
  posUserId: string;
  posUserName?: string | null;
  workerNumber?: string | null;
  shopId: string;
  shopName?: string | null;
  status: AttendanceStatus;
  source: 'till' | 'dashboard';
  roleId?: string | null;
  roleName?: string | null;
  clockInAt: string;
  clockInDeviceAt?: string | null;
  clockInServerAt?: string | null;
  clockOutAt?: string | null;
  clockOutDeviceAt?: string | null;
  clockOutServerAt?: string | null;
  closedBy?: 'self' | 'manager' | null;
  closedByName?: string | null;
  closeReason?: string | null;
  breakSince?: string | null;
  breaks: AttendanceBreak[];
  breakSeconds: number;
  workedSeconds: number;
  clockSkewSeconds?: number | null;
  flags: string[];
  // The live board's extras.
  durationSeconds?: number;
  openTables?: number;
  pendingCorrections?: number;
  currentMachine?: MachineLabel | null;
  signedIn?: boolean;
  clockInMachine?: MachineLabel | null;
  // The report's extras.
  date?: string;
  breakCount?: number;
  notes?: string[];
  correctionCount?: number;
  clockOutMachine?: MachineLabel | null;
}

export interface LiveResponse {
  serverTime: string | null;
  shifts: AttendanceShift[];
  counts: { total: number; byStatus: Record<string, number>; byRole: Record<string, number> };
}

export interface EmployeeTotals {
  posUserId: string;
  posUserName?: string | null;
  workerNumber?: string | null;
  roleName?: string | null;
  shifts: number;
  workedSeconds: number;
  breakSeconds: number;
  openShifts: number;
}

export interface ReportResponse {
  window: { from: string; to: string; timezone?: string; windowStart?: string; windowEnd?: string };
  rows: AttendanceShift[];
  byEmployee: EmployeeTotals[];
  totals: { shifts: number; workedSeconds: number; breakSeconds: number };
}

export type AdjustmentKind = 'missing_in' | 'missing_out' | 'wrong_time' | 'break' | 'manager_close';
export type AdjustmentStatus = 'pending' | 'approved' | 'rejected';

export interface AttendanceAdjustment {
  id: string;
  shopId: string;
  shopName?: string | null;
  shiftId?: string | null;
  breakId?: string | null;
  posUserId: string;
  posUserName?: string | null;
  kind: AdjustmentKind;
  field?: 'clock_in' | 'clock_out' | 'break_start' | 'break_end' | null;
  originalTime?: string | null;
  requestedTime?: string | null;
  requestedEndTime?: string | null;
  approvedTime?: string | null;
  approvedEndTime?: string | null;
  reason?: string | null;
  status: AdjustmentStatus;
  source: 'till' | 'dashboard';
  requestedByName?: string | null;
  requestedAt?: string | null;
  requestedDeviceAt?: string | null;
  decidedByName?: string | null;
  decidedAt?: string | null;
  decisionNote?: string | null;
  oldValue?: Record<string, unknown> | null;
  newValue?: Record<string, unknown> | null;
}

export interface EmployeeRole {
  id: string;
  name: string;
  tipWeight: number;
  sortOrder: number;
  isActive: boolean;
  employees: number;
}

export interface AttendanceEmployee {
  id: string;
  name?: string | null;
  username: string;
  workerNumber?: string | null;
  permissionRole: string;
  roleId?: string | null;
  roleName?: string | null;
}

/** 27720 → "7:42" — hours and minutes, as a timesheet writes them. */
export function formatHours(seconds: number | null | undefined): string {
  const total = Math.max(0, Math.floor((seconds ?? 0) / 60));
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return `${hours}:${String(minutes).padStart(2, '0')}`;
}

/** Hours as a decimal for a spreadsheet: 27720 → 7.7. */
export function decimalHours(seconds: number | null | undefined): number {
  return Math.round(((seconds ?? 0) / 3600) * 100) / 100;
}

/**
 * The live board's clock: the server's figures at `serverTime`, moved on by the time since —
 * so a card ticks between refreshes without trusting the browser's clock for the start.
 */
export function liveSeconds(serverSeconds: number, serverTime: string | null | undefined, nowMs: number): number {
  if (!serverTime) return serverSeconds;
  const base = Date.parse(serverTime);
  if (Number.isNaN(base)) return serverSeconds;
  return serverSeconds + Math.max(0, Math.floor((nowMs - base) / 1000));
}

/**
 * The live status a card shows: on break, waiting for a manager (a pending correction), or
 * working. Distinct from the alerts shown beside it (open tables, a wrong clock…).
 */
export function cardStatus(shift: Pick<AttendanceShift, 'status' | 'pendingCorrections'>): 'working' | 'on_break' | 'pending' {
  if (shift.status === 'on_break') return 'on_break';
  if (shift.status === 'pending_approval' || (shift.pendingCorrections ?? 0) > 0) return 'pending';
  return 'working';
}

/** The alerts beside the status, as message keys under `attendance.flags`. */
export function cardAlerts(shift: Pick<AttendanceShift, 'flags' | 'openTables'>): string[] {
  const out: string[] = [];
  if ((shift.openTables ?? 0) > 0) out.push('openTablesNow');
  for (const f of shift.flags ?? []) {
    if (['clock_skew', 'overlap', 'open_tables', 'approval_unverified', 'late_event'].includes(f)) out.push(f);
  }
  return Array.from(new Set(out));
}

/** The report's notes, as message keys under `attendance.notes`, in a fixed order. */
const NOTE_ORDER = ['open', 'closed_by_manager', 'corrected', 'open_tables', 'clock_skew', 'overlap', 'approval_unverified', 'late_event'];

export function noteKeys(row: Pick<AttendanceShift, 'notes'>): string[] {
  const notes = new Set(row.notes ?? []);
  return NOTE_ORDER.filter((n) => notes.has(n));
}

export interface ExportLabels {
  note: (key: string) => string;
  status: (status: AttendanceStatus) => string;
  time: (iso: string | null | undefined) => string;
}

export const REPORT_HEADER_KEYS = [
  'date', 'employee', 'workerNumber', 'role', 'shop', 'in', 'out', 'breaks', 'breakTime', 'hours', 'status', 'notes',
] as const;

/** One spreadsheet row per shift, in the order of [REPORT_HEADER_KEYS]. */
export function reportExportRows(rows: AttendanceShift[], labels: ExportLabels): (string | number | null)[][] {
  return rows.map((r) => [
    r.date ?? null,
    r.posUserName ?? '',
    r.workerNumber ?? '',
    r.roleName ?? '',
    r.shopName ?? '',
    labels.time(r.clockInAt),
    r.clockOutAt ? labels.time(r.clockOutAt) : '',
    r.breakCount ?? r.breaks.length,
    formatHours(r.breakSeconds),
    decimalHours(r.workedSeconds),
    labels.status(r.status),
    [
      ...noteKeys(r).map(labels.note),
      r.closeReason ? r.closeReason : null,
    ].filter(Boolean).join(' · '),
  ]);
}

/** The time a correction is about, then and now: "16:40 → 16:05". */
export function adjustmentTimes(a: AttendanceAdjustment): { before: string | null; after: string | null } {
  const after = a.status === 'approved' ? (a.approvedTime ?? a.requestedTime ?? null) : (a.requestedTime ?? null);
  return { before: a.originalTime ?? null, after };
}

/**
 * An ISO instant as a `datetime-local` input value in the browser's zone
 * ("2026-10-06T16:05"), and back. A manager edits times in their own wall clock.
 */
export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function localInputToIso(value: string | null | undefined): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
