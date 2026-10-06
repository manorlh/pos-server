/**
 * "תפריטים" — sales menus by schedule (pos-server docs/SPEC_MENUS.md), the pure part the
 * dashboard needs. Self-contained, so `npm test` compiles it alone.
 *
 * * **When** (`scheduleActive`) and **which** (`resolve`) are EXACTLY the server's
 *   app/services/catalog_menu_rules.py (`schedule_active`, `resolve`) — the till and the
 *   kiosk run the same rules offline, and the shared golden fixtures
 *   (pos-server tests/fixtures/catalog_menus_golden.json) pin all of them to the same
 *   answers; menuSchedule.test.ts runs every case of it here too. Change one, change all.
 *   - On the local wall clock: a weekday (0 = Sunday א׳ … 6 = Saturday ש׳) and a minute.
 *   - A range `[start, end)` with `end <= start` crosses midnight, and the hours after
 *     midnight belong to the day it started (its weekday and its date); "00:00–00:00" is
 *     the whole day. No ranges: the whole day; ranges none of which reads: never.
 *     `days` null: every day; empty: never. `always`: any hour of any day — the date
 *     range still applies.
 *   - Among the assigned menus active now and offered on the surface, the most specific
 *     level wins (till › point of sale › shop › the till's company › the company above…);
 *     within a level the higher priority, then the name, then the id.
 * * The editor's helpers: a short Hebrew summary ("א׳–ה׳ · 11:30–17:00"), validation,
 *   crossing midnight, and the simulator's "the next date on that weekday".
 * * `menuErrorCode` — the server's error code in a failed request's `detail`.
 */

export type MenuChannel = 'pos' | 'kiosk' | 'both';
export type MenuSurface = 'pos' | 'kiosk';
export type MenuLevel = 'machine' | 'area' | 'shop' | 'company';
export type ResolutionMode = 'menu' | 'catalog' | 'none';
export type FallbackMode = 'catalog' | 'none';

export const MENU_CHANNELS: MenuChannel[] = ['pos', 'kiosk', 'both'];
export const MENU_SURFACES: MenuSurface[] = ['pos', 'kiosk'];
/** Most specific first. */
export const MENU_LEVELS: MenuLevel[] = ['machine', 'area', 'shop', 'company'];
export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
/** א׳ … ש׳ (0 = Sunday). */
export const WEEKDAY_LETTERS = ['א׳', 'ב׳', 'ג׳', 'ד׳', 'ה׳', 'ו׳', 'ש׳'];
/** The server's RANGES_MAX. */
export const MAX_RANGES = 8;
export const NAME_MAX = 80;
export const MENU_PRICE_MAX = 1_000_000;

/** The level's weight in the rank (catalog_menu_rules.LEVEL_RANK). */
export const LEVEL_RANK: Record<MenuLevel, number> = { machine: 3, area: 2, shop: 1, company: 0 };

export interface TimeRange {
  start: string;
  end: string;
}

/**
 * A schedule as either side carries it: the catalog pull's block (`from` / `to`, ranges as
 * `["HH:MM", "HH:MM"]`) or the dashboard's menu (`validFrom` / `validTo`, ranges as
 * `{start, end}`).
 */
export interface ScheduleLike {
  always?: unknown;
  days?: unknown;
  ranges?: unknown;
  from?: unknown;
  to?: unknown;
  validFrom?: unknown;
  validTo?: unknown;
}

/** The dashboard's schedule, as the editor holds it. */
export interface MenuSchedule {
  always: boolean;
  days: number[] | null;
  ranges: TimeRange[];
  validFrom?: string | null;
  validTo?: string | null;
}

export interface BlockMenu {
  id?: unknown;
  name?: unknown;
  channel?: unknown;
  schedule?: ScheduleLike | null;
  [key: string]: unknown;
}

export interface BlockAssignment {
  menuId?: unknown;
  level?: unknown;
  depth?: unknown;
  priority?: unknown;
  [key: string]: unknown;
}

/** The `catalogMenus` block of a till, as the catalog pull carries it. */
export interface MenuBlock {
  fallback?: unknown;
  menus?: unknown;
  assignments?: unknown;
  [key: string]: unknown;
}

export interface MenuResolution {
  mode: ResolutionMode;
  menuId: string | null;
  menuName: string | null;
  level: string | null;
  depth: number | null;
  priority: number | null;
}

/** A local wall-clock moment: the date and the minute of the day. */
export interface LocalMoment {
  /** Days since 1970-01-01 (the date's own count, no time zone). */
  day: number;
  /** 0–1439. */
  minute: number;
}

// ── Reading ─────────────────────────────────────────────────────────────────

/** `"HH:MM"` (exactly two digits each) → minutes after midnight (0–1439); anything else → null. */
export function minutesOf(value: unknown): number | null {
  if (typeof value !== 'string' || value.length !== 5 || value[2] !== ':') return null;
  const hh = value.slice(0, 2);
  const mm = value.slice(3);
  if (!/^[0-9]{2}$/.test(hh) || !/^[0-9]{2}$/.test(mm)) return null;
  const h = Number(hh);
  const m = Number(mm);
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

const DAY_MS = 86_400_000;

/** `"YYYY-MM-DD…"` → its day number; an unreadable or impossible date → null. */
export function dayNumberOf(value: unknown): number | null {
  if (typeof value !== 'string' || !value) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.slice(0, 10));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const ms = Date.UTC(y, mo - 1, d);
  const back = new Date(ms);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return Math.floor(ms / DAY_MS);
}

/** A day number → `"YYYY-MM-DD"`. */
export function isoOfDay(day: number): string {
  const d = new Date(day * DAY_MS);
  const y = String(d.getUTCFullYear()).padStart(4, '0');
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

/** 0 = Sunday (א׳) … 6 = Saturday (ש׳). */
export function weekdayOfDay(day: number): number {
  return new Date(day * DAY_MS).getUTCDay();
}

/** The weekday of `"YYYY-MM-DD"` (0 = Sunday); null when it is not a date. */
export function weekdayOf(isoDate: string): number | null {
  const day = dayNumberOf(isoDate);
  return day === null ? null : weekdayOfDay(day);
}

/**
 * A naive local `"YYYY-MM-DDTHH:MM"` (seconds and anything after ignored) — never through
 * `new Date(str)`, which would read it in the browser's own zone.
 */
export function parseLocalMoment(value: string): LocalMoment | null {
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})/.exec(value);
  if (!m) return null;
  const day = dayNumberOf(m[1]);
  const h = Number(m[2]);
  const mi = Number(m[3]);
  if (day === null || h > 23 || mi > 59) return null;
  return { day, minute: h * 60 + mi };
}

export function formatLocalMoment(at: LocalMoment): string {
  const h = String(Math.floor(at.minute / 60)).padStart(2, '0');
  const m = String(at.minute % 60).padStart(2, '0');
  return `${isoOfDay(at.day)}T${h}:${m}`;
}

function asMoment(at: string | LocalMoment): LocalMoment {
  if (typeof at !== 'string') return at;
  const parsed = parseLocalMoment(at);
  if (!parsed) throw new Error(`not a local moment: ${at}`);
  return parsed;
}

function readRanges(schedule: ScheduleLike): [number, number][] {
  const raw = schedule.ranges;
  const out: [number, number][] = [];
  if (!Array.isArray(raw)) return out;
  for (const r of raw) {
    let start: number | null;
    let end: number | null;
    if (Array.isArray(r)) {
      if (r.length !== 2) continue;
      start = minutesOf(r[0]);
      end = minutesOf(r[1]);
    } else if (r && typeof r === 'object') {
      start = minutesOf((r as Record<string, unknown>).start);
      end = minutesOf((r as Record<string, unknown>).end);
    } else {
      continue;
    }
    if (start !== null && end !== null) out.push([start, end]);
  }
  return out;
}

function readDays(days: unknown): Set<number> | null {
  if (days === null || days === undefined) return null;
  const out = new Set<number>();
  if (!Array.isArray(days)) return out;
  for (const d of days) {
    if (typeof d === 'number' && Number.isInteger(d)) out.add(d);
    else if (typeof d === 'boolean') out.add(d ? 1 : 0);
    else if (typeof d === 'string' && /^[0-9]+$/.test(d)) out.add(Number(d));
  }
  return out;
}

/** Python truthiness of a JSON value. */
function truthy(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return !!value;
}

/** A menu's channel offered on `surface`. Unknown or empty: both. */
export function channelAccepts(channel: unknown, surface: MenuSurface): boolean {
  const c = typeof channel === 'string' ? channel || 'both' : 'both';
  if (c === 'pos') return surface === 'pos';
  if (c === 'kiosk') return surface === 'kiosk';
  return true;
}

// ── When ────────────────────────────────────────────────────────────────────

/** Whether a menu with `schedule` is active at the local wall-clock moment `at`. */
export function scheduleActive(schedule: ScheduleLike | null | undefined, at: string | LocalMoment): boolean {
  const s: ScheduleLike = schedule ?? {};
  const { day, minute: t } = asMoment(at);
  const daySet = readDays(s.days);
  const startDate = dayNumberOf(s.from !== undefined ? s.from : s.validFrom);
  const endDate = dayNumberOf(s.to !== undefined ? s.to : s.validTo);
  const dateOk = (d: number) => (startDate === null || d >= startDate) && (endDate === null || d <= endDate);
  const dayOk = (d: number) => (daySet === null || daySet.has(weekdayOfDay(d))) && dateOk(d);

  if (truthy(s.always)) return dateOk(day);
  const ranges = readRanges(s);
  if (ranges.length === 0) {
    // No ranges: the whole day. Ranges none of which reads: never (not all day).
    return dayOk(day) && !truthy(s.ranges);
  }
  const yesterday = day - 1;
  for (const [start, end] of ranges) {
    if (end > start) {
      if (start <= t && t < end && dayOk(day)) return true;
    } else {
      // Crosses midnight: from `start` to the end of the day it started, and on to `end`
      // the next morning — which still belongs to that day.
      if (t >= start && dayOk(day)) return true;
      if (t < end && dayOk(yesterday)) return true;
    }
  }
  return false;
}

// ── Which ───────────────────────────────────────────────────────────────────

/** Python's `int(x)` for what JSON can carry; null when it would raise. */
function pyInt(value: unknown): number | null {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : null;
  if (typeof value === 'string' && /^\s*[-+]?[0-9]+\s*$/.test(value)) return Number.parseInt(value.trim(), 10);
  return null;
}

export function rankOf(assignment: BlockAssignment): number {
  const level = typeof assignment.level === 'string' && assignment.level in LEVEL_RANK
    ? LEVEL_RANK[assignment.level as MenuLevel]
    : -1;
  const raw = truthy(assignment.depth) ? assignment.depth : 0;
  const parsed = pyInt(raw);
  const depth = parsed === null ? 0 : Math.max(0, Math.min(99, parsed));
  return level * 100 - depth;
}

function priorityOf(assignment: BlockAssignment): number {
  const raw = truthy(assignment.priority) ? assignment.priority : 0;
  return pyInt(raw) ?? 0;
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : truthy(value) ? String(value) : '';
}

/** Python's `str < str` (by code point; the same as by UTF-16 unit for these names). */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function fallbackOf(block: MenuBlock | null | undefined): FallbackMode {
  return block?.fallback === 'none' ? 'none' : 'catalog';
}

/** The menu active at local `at` on `surface` — catalog_menu_rules.resolve. */
export function resolve(
  block: MenuBlock | null | undefined,
  at: string | LocalMoment,
  surface: MenuSurface = 'pos',
): MenuResolution {
  const b: MenuBlock = block ?? {};
  const moment = asMoment(at);
  const menus = new Map<unknown, BlockMenu>();
  for (const m of Array.isArray(b.menus) ? b.menus : []) {
    if (m && typeof m === 'object' && !Array.isArray(m) && truthy((m as BlockMenu).id)) menus.set((m as BlockMenu).id, m as BlockMenu);
  }
  const candidates: { key: [number, number, string, string]; a: BlockAssignment; m: BlockMenu }[] = [];
  for (const a of Array.isArray(b.assignments) ? b.assignments : []) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) continue;
    const assignment = a as BlockAssignment;
    const m = menus.get(assignment.menuId);
    if (m === undefined || !channelAccepts(m.channel, surface)) continue;
    if (!scheduleActive(m.schedule && typeof m.schedule === 'object' ? m.schedule : null, moment)) continue;
    candidates.push({ key: [-rankOf(assignment), -priorityOf(assignment), textOf(m.name), textOf(m.id)], a: assignment, m });
  }
  if (candidates.length === 0) {
    return { mode: fallbackOf(b), menuId: null, menuName: null, level: null, depth: null, priority: null };
  }
  candidates.sort((x, y) => {
    for (let i = 0; i < 4; i++) {
      const p = x.key[i];
      const q = y.key[i];
      const c = typeof p === 'number' && typeof q === 'number' ? p - q : compareText(String(p), String(q));
      if (c !== 0) return c;
    }
    return 0;
  });
  const { a, m } = candidates[0];
  const depth = truthy(a.depth) ? a.depth : 0;
  return {
    mode: 'menu',
    menuId: (m.id as string) ?? null,
    menuName: (m.name as string | null | undefined) ?? null,
    level: (a.level as string | null | undefined) ?? null,
    depth: typeof depth === 'number' ? depth : pyInt(depth) ?? 0,
    priority: priorityOf(a),
  };
}

// ── The editor ──────────────────────────────────────────────────────────────

/** "00:00–00:00": the whole day. */
export function isWholeDayRange(r: TimeRange): boolean {
  return r.start === '00:00' && r.end === '00:00';
}

/** End at or before start (and not "00:00–00:00"): runs on into the next morning ("עד למחרת"). */
export function crossesMidnight(r: TimeRange): boolean {
  const s = minutesOf(r.start);
  const e = minutesOf(r.end);
  if (s === null || e === null || isWholeDayRange(r)) return false;
  return e <= s;
}

export function isValidTime(value: string): boolean {
  return minutesOf(value) !== null;
}

export type ScheduleProblem = 'no_days' | 'bad_time' | 'too_many_ranges' | 'dates_reversed' | 'bad_date';

/** What keeps the server from taking the schedule (MenuIn's checks), in the order shown. */
export function scheduleProblems(s: MenuSchedule): ScheduleProblem[] {
  const out: ScheduleProblem[] = [];
  if (!s.always && s.days !== null && s.days.length === 0) out.push('no_days');
  if (s.ranges.some((r) => !isValidTime(r.start) || !isValidTime(r.end))) out.push('bad_time');
  if (s.ranges.length > MAX_RANGES) out.push('too_many_ranges');
  const from = s.validFrom ? dayNumberOf(s.validFrom) : null;
  const to = s.validTo ? dayNumberOf(s.validTo) : null;
  if ((s.validFrom && from === null) || (s.validTo && to === null)) out.push('bad_date');
  else if (from !== null && to !== null && from > to) out.push('dates_reversed');
  return out;
}

/** Days as the server stores them: sorted, unique; every day → null ("כל יום"). */
export function normalizeDays(days: number[] | null): number[] | null {
  if (days === null) return null;
  const set = Array.from(new Set(days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))).sort((a, b) => a - b);
  return set.length === 7 ? null : set;
}

/** "א׳–ה׳", "א׳ ג׳ ה׳", "א׳–ג׳ ה׳"; null → "כל יום". */
export function daysSummary(days: number[] | null): string {
  if (days === null) return 'כל יום';
  const sorted = Array.from(new Set(days.filter((d) => d >= 0 && d <= 6))).sort((a, b) => a - b);
  if (sorted.length === 0) return 'אף יום';
  if (sorted.length === 7) return 'כל יום';
  const runs: [number, number][] = [];
  for (const d of sorted) {
    const last = runs[runs.length - 1];
    if (last && d === last[1] + 1) last[1] = d;
    else runs.push([d, d]);
  }
  return runs
    .flatMap(([a, b]) =>
      b - a >= 2
        ? [`${WEEKDAY_LETTERS[a]}–${WEEKDAY_LETTERS[b]}`]
        : b === a
          ? [WEEKDAY_LETTERS[a]]
          : [WEEKDAY_LETTERS[a], WEEKDAY_LETTERS[b]],
    )
    .join(' ');
}

/** "11:30–17:00", "22:00–02:00 (למחרת)", "00:00–00:00" → "כל היום". */
export function rangeSummary(r: TimeRange): string {
  if (isWholeDayRange(r)) return 'כל היום';
  return crossesMidnight(r) ? `${r.start}–${r.end} (למחרת)` : `${r.start}–${r.end}`;
}

function dmy(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

/** The date range: "24/12/2026–26/12/2026", "מ-24/12/2026", "עד 26/12/2026"; none → "". */
export function datesSummary(validFrom?: string | null, validTo?: string | null): string {
  if (validFrom && validTo) return validFrom === validTo ? dmy(validFrom) : `${dmy(validFrom)}–${dmy(validTo)}`;
  if (validFrom) return `מ-${dmy(validFrom)}`;
  if (validTo) return `עד ${dmy(validTo)}`;
  return '';
}

/** A schedule in a line: "א׳–ה׳ · 11:30–17:00", "תמיד", "כל יום · כל היום · 24/12/2026–26/12/2026". */
export function scheduleSummary(s: MenuSchedule): string {
  const parts: string[] = [];
  if (s.always) {
    parts.push('תמיד');
  } else {
    parts.push(daysSummary(s.days));
    parts.push(s.ranges.length ? s.ranges.map(rangeSummary).join(', ') : 'כל היום');
  }
  const dates = datesSummary(s.validFrom, s.validTo);
  if (dates) parts.push(dates);
  return parts.join(' · ');
}

// ── The simulator ───────────────────────────────────────────────────────────

/**
 * The first date on or after `fromIso` (`"YYYY-MM-DD"`) that falls on `weekday`
 * (0 = Sunday) — "ביום ג׳" in the simulator is the coming Tuesday, today if it is one.
 */
export function nextDateOnWeekday(fromIso: string, weekday: number): string {
  const day = dayNumberOf(fromIso);
  if (day === null) throw new Error(`not a date: ${fromIso}`);
  const w = ((Math.trunc(weekday) % 7) + 7) % 7;
  return isoOfDay(day + ((w - weekdayOfDay(day) + 7) % 7));
}

/** The simulator's `at`: a naive local `"YYYY-MM-DDTHH:MM"`. */
export function simulatorAt(todayIso: string, weekday: number, time: string, exactDate?: string | null): string {
  const date = exactDate && dayNumberOf(exactDate) !== null ? exactDate.slice(0, 10) : nextDateOnWeekday(todayIso, weekday);
  return `${date}T${time}`;
}

/** The wall clock in `timeZone` at `now`: `"YYYY-MM-DDTHH:MM"`. An unknown zone: UTC. */
export function localNowIn(timeZone: string, now: Date = new Date()): string {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(now);
  } catch {
    return now.toISOString().slice(0, 16);
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  const hour = get('hour') === '24' ? '00' : get('hour');
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`;
}

// ── Errors ──────────────────────────────────────────────────────────────────

/** The codes the menus API answers with (catalog_menus.py, app/services/menu.py, MenuIn). */
export const MENU_ERROR_CODES = [
  'catalog_menu_unknown_category',
  'catalog_menu_unknown_product',
  'catalog_menu_out_of_reach',
  'catalog_menu_bad_time',
  'catalog_menu_forbidden',
  'catalog_menu_not_found',
  'menu_whole_org_forbidden',
  'menu_unknown_company',
  'menu_forbidden',
  'menu_no_days',
  'menu_dates_reversed',
  'menu_duplicate_category',
  'menu_duplicate_product',
  'menu_duplicate_assignment',
  'till_message_target_not_found',
  'till_message_target_forbidden',
] as const;
export type MenuErrorCode = (typeof MENU_ERROR_CODES)[number] | 'menu_bad_hhmm' | 'menu_bad_color' | 'menu_bad_price';

/** Longest first, so "catalog_menu_forbidden" is never read as "menu_forbidden". */
const BY_LENGTH = [...MENU_ERROR_CODES].sort((a, b) => b.length - a.length);

function codeInText(text: string): MenuErrorCode | null {
  for (const code of BY_LENGTH) {
    if (text === code) return code;
  }
  for (const code of BY_LENGTH) {
    if (text.includes(code)) return code;
  }
  if (text.includes('time must be HH:MM')) return 'menu_bad_hhmm';
  if (text.includes('color must be #RRGGBB')) return 'menu_bad_color';
  return null;
}

/**
 * The server's code in a FastAPI `detail`: a string ("catalog_menu_out_of_reach"), or a
 * 422's list whose messages carry it ("Value error, menu_no_days"). Null: none we know.
 */
export function menuErrorCode(detail: unknown): MenuErrorCode | null {
  if (typeof detail === 'string') return codeInText(detail);
  if (Array.isArray(detail)) {
    for (const item of detail) {
      if (typeof item === 'string') {
        const c = codeInText(item);
        if (c) return c;
      } else if (item && typeof item === 'object') {
        const msg = (item as { msg?: unknown }).msg;
        const c = typeof msg === 'string' ? codeInText(msg) : null;
        if (c) return c;
        const loc = (item as { loc?: unknown }).loc;
        if (Array.isArray(loc) && loc.includes('price')) return 'menu_bad_price';
      }
    }
  }
  return null;
}
