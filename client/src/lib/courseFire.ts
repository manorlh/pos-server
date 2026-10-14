/**
 * "שלבי הגשה": a course's auto-fire minutes (P:/specs/courses-fire-v2.md §1, §5; pos-server
 * `menu_courses.auto_fire_minutes`). When the till parameter `autoFire` is "after_minutes" (or
 * "after_ready" with no KDS) the next course goes out by itself this many minutes after the previous
 * one went out; the till parameter `autoFireMinutesOverride` replaces it for every course. The
 * courses editor's pure helpers: the server refuses what these refuse.
 *
 * Self-contained on purpose (no imports): the node test build compiles it alone.
 */

export const FIRE_MINUTES_MIN = 1;
export const FIRE_MINUTES_MAX = 180;
/** A new course's minutes, and the course of an older server that does not send them. */
export const FIRE_MINUTES_DEFAULT = 15;

/** The minutes of an edited text: an integer 1–180, else null (refused on save). */
export function parseFireMinutes(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[0-9]{1,3}$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return n >= FIRE_MINUTES_MIN && n <= FIRE_MINUTES_MAX ? n : null;
}

/** The editor's text of a course's stored minutes; absent or not a whole number: the default. */
export function fireMinutesText(value: unknown): string {
  return typeof value === 'number' && Number.isInteger(value) ? String(value) : String(FIRE_MINUTES_DEFAULT);
}

/** What the minutes input keeps of a keystroke: digits only, at most three. */
export function fireMinutesInput(text: string): string {
  return text.replace(/[^0-9]/g, '').slice(0, 3);
}
