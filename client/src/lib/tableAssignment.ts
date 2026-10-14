/**
 * "שיוך שולחנות ואזורים למלצר" and "שולחן תפוס" on the dashboard (P:/specs/table-waiter-assignment.md §3,
 * §4, §8; pos-server app/services/table_assignments.py): the pure pieces of the live floor's assignment
 * mode — who a table is assigned to, what a tap does, the waiter filter, the holder's line, the copy
 * buttons, a waiter's colour and the parameters' warnings.
 *
 * Self-contained on purpose (no imports): the node test build compiles it alone.
 */

/** A live assignment row, as the server sends it (`row_out`). */
export interface AssignmentRow {
  id: string;
  zoneId: string | null;
  tableId: string | null;
  posUserId: string;
  businessDay: string | null;
  assignedBy: string | null;
  source: string;
  createdAt: string | null;
}

/** A waiter to assign, with the colour the floor shows them in. */
export interface AssignmentWaiter {
  posUserId: string;
  name: string | null;
  initials: string | null;
  color: string;
  ownColor?: string | null;
  onShift: boolean;
}

/** A table's effective assignment: its own (`table`) or its zone's (`zone`); the main waiter first. */
export interface TableAssignmentRef {
  via: 'table' | 'zone';
  posUserIds: string[];
}

export type AssignmentMode = 'off' | 'highlight' | 'restrict';

/** The parameters of the block (`config_out`). */
export interface AssignmentConfig {
  mode: AssignmentMode;
  unassigned: 'open' | 'restricted';
  owner: 'assigned' | 'opener';
  reset: 'z' | 'day' | 'never';
  onClockOut: 'keep' | 'release';
  multi: 'single' | 'multi';
  notify: boolean;
}

/** One tap of the assignment mode, as `POST /tables/assignments` takes it. */
export interface AssignmentChange {
  action: 'assign' | 'unassign';
  posUserId?: string | null;
  tableId?: string | null;
  zoneId?: string | null;
}

/** The waiters a table is assigned to, as the floor shows them (unknown ids dropped). */
export function assignedWaiters(
  ref: TableAssignmentRef | null | undefined,
  waiters: AssignmentWaiter[],
): AssignmentWaiter[] {
  if (!ref) return [];
  const byId = new Map(waiters.map((w) => [w.posUserId, w]));
  return ref.posUserIds.map((id) => byId.get(id)).filter((w): w is AssignmentWaiter => !!w);
}

/** "ד.כ" from "דנה כהן" (the server sends it; this is its fallback for a name alone). */
export function initialsOf(name: string | null | undefined): string {
  const parts = (name ?? '').replace(/\./g, ' ').split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  if (parts.length === 1) return parts[0].charAt(0);
  return `${parts[0].charAt(0)}.${parts[parts.length - 1].charAt(0)}`;
}

/** Whether the target carries this waiter's own row (a zone's row, or a table's own — never a zone's on a table). */
export function hasOwnRow(
  rows: AssignmentRow[],
  posUserId: string,
  target: { tableId?: string | null; zoneId?: string | null },
): boolean {
  return rows.some(
    (r) =>
      r.posUserId === posUserId &&
      ((target.tableId && r.tableId === target.tableId) || (target.zoneId && r.zoneId === target.zoneId)),
  );
}

/**
 * A tap in the assignment mode with `posUserId` picked: on a target already theirs — taken back; else
 * theirs (under `single` the server replaces whoever had it).
 */
export function tapChange(
  rows: AssignmentRow[],
  posUserId: string,
  target: { tableId?: string | null; zoneId?: string | null },
): AssignmentChange {
  const tableId = target.tableId ?? null;
  const zoneId = tableId ? null : target.zoneId ?? null;
  const action = hasOwnRow(rows, posUserId, { tableId, zoneId }) ? 'unassign' : 'assign';
  return { action, posUserId, tableId, zoneId };
}

/** Whether a table is (also) assigned to this waiter — the "לפי מלצר משויך" filter. */
export function isAssignedTo(ref: TableAssignmentRef | null | undefined, posUserId: string | null): boolean {
  if (!posUserId) return true;
  return !!ref && ref.posUserIds.includes(posUserId);
}

/** How many tables each waiter covers on the floor (zone-wide ones counted per table). */
export function assignedCounts(refs: (TableAssignmentRef | null | undefined)[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const ref of refs) {
    for (const id of ref?.posUserIds ?? []) out[id] = (out[id] ?? 0) + 1;
  }
  return out;
}

/** "פתוח כעת: קופה 3 · דנה" (§8) — the device and the employee inside a busy table, or null. */
export function holderLine(holder: { text?: string | null } | null | undefined): string | null {
  const text = holder?.text?.trim();
  return text ? `פתוח כעת: ${text}` : null;
}

/** "המכשיר לא מדווח מאז 20:31" — a lock that ran out unreleased; null when there is none. */
export function staleLine(
  stale: { lastSeenAt?: string | null; holderText?: string | null } | null | undefined,
  clock: (iso: string) => string,
): string | null {
  if (!stale?.lastSeenAt) return null;
  const at = clock(stale.lastSeenAt);
  return stale.holderText ? `${stale.holderText} — המכשיר לא מדווח מאז ${at}` : `המכשיר לא מדווח מאז ${at}`;
}

/** A copy source (`copySources.yesterday` / `.previous_shift`), as its button says it. */
export interface CopySource {
  businessDay: string | null;
  count: number;
  endedAt?: string | null;
  kind?: string;
}

/** "העתק מאתמול (6)" — or null when there is nothing to copy (the button is off). */
export function copyLabel(kind: 'yesterday' | 'previous_shift', source: CopySource | null | undefined): string | null {
  if (!source || source.count <= 0) return null;
  const word = kind === 'yesterday' ? 'העתק שיוך מאתמול' : 'העתק מהמשמרת הקודמת';
  return `${word} (${source.count})`;
}

/** `#rrggbb` lower case, or null (empty: automatic); undefined — not a colour. */
export function cleanColor(value: string | null | undefined): string | null | undefined {
  const text = (value ?? '').trim();
  if (!text) return null;
  return /^#[0-9a-fA-F]{6}$/.test(text) ? text.toLowerCase() : undefined;
}

/** The palette the server chooses colours from (app/services/table_assignments.py `PALETTE`). */
export const WAITER_PALETTE = [
  '#e11d48', '#2563eb', '#16a34a', '#d97706', '#7c3aed', '#0891b2',
  '#db2777', '#65a30d', '#ea580c', '#4f46e5', '#0d9488', '#a16207',
] as const;

/** Black or white text over a colour (initials on a waiter's badge). */
export function inkOn(color: string): string {
  const m = /^#([0-9a-f]{6})$/i.exec(color);
  if (!m) return '#ffffff';
  const n = parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return 0.299 * r + 0.587 * g + 0.114 * b > 160 ? '#0f172a' : '#ffffff';
}

/** The warning next to a parameter's chosen option (`optionWarnings`: `tableBusyEntry` = off), or null. */
export function optionWarning(
  warnings: Record<string, string> | null | undefined,
  value: unknown,
): string | null {
  if (!warnings || typeof value !== 'string') return null;
  return warnings[value] ?? null;
}
