/**
 * "שחזור שולחן ותשלומים" (pos-server app/services/table_restore.py, P:/specs/table-restore-payments.md
 * §3, §5): the tables page's editor of the eight till parameters per level — the pure helpers. How a
 * level's value reads and is written back, the restore window (`same_z` | `same_shift` | `any` |
 * `hours:N`), the methods list (`cash,card,voucher,external`), and the checks the server makes too.
 * The same card also edits the courses' auto-fire (P:/specs/courses-fire-v2.md §1, §5): `autoFire`
 * (`off` | `after_minutes` | `after_ready`) and `autoFireMinutesOverride`, an integer 1–180 sent as a
 * JSON number (the server refuses the text "15"); empty = each course's own minutes.
 *
 * Self-contained on purpose (no imports): the node test build compiles it alone.
 */

export type RestoreLevel = 'company' | 'shop' | 'area' | 'machine';

export const RESTORE_KEYS = [
  'restoredTablePrefix',
  'restoreWindow',
  'printCreditNote',
  'reverseMethods',
  'cardVoidWhenUntransmitted',
  'reverseAllButton',
  'billTipBase',
  'billShowPaidItems',
] as const;
export type RestoreKey = (typeof RESTORE_KEYS)[number];

export interface RestoreParam {
  key: string;
  label: string;
  description: string | null;
  valueType: 'boolean' | 'integer' | 'decimal' | 'string' | 'enum';
  enumOptions: string[] | null;
  enumLabels: Record<string, string> | null;
  defaultValue: unknown;
  /** The card's group (`staffTables` | `restore` | `mapDisplay` | `send` | `courses`). Absent on an older server. */
  group?: string | null;
}

/** A group of the card ("הגדרות שולחנות"), in the order it shows them. */
export interface ParamGroup {
  key: string;
  label: string;
}

/** `GET /companies/{id}/table-restore-params` — one level. */
export interface RestoreLevelView {
  scopeType: RestoreLevel;
  scopeId: string;
  /** What this level sets itself. */
  own: Record<string, unknown>;
  /** What it gets from the levels above (or the default). */
  inherited: Record<string, unknown>;
  parameters: RestoreParam[];
  /**
   * The staff / managers' tables (`staffTableDiscountCheck`, P:/specs/owner-decisions-1410.md §1), then
   * the restore and payments, the map, the send from the table (`send`: "שגר נבחרים", "שגר והמשך"), then
   * the courses' auto-fire (`courses`). Absent on an older server: one list.
   */
  groups?: ParamGroup[];
  methods: { key: string; label: string }[];
  canEdit: boolean;
}

/**
 * The card's parameters by group, in the groups' order (a group with none left out); a parameter of
 * no known group goes last, under no heading (`group: null`). No groups at all: one list, no heading.
 */
export function groupParams<P extends { group?: string | null }>(
  parameters: readonly P[],
  groups: readonly ParamGroup[] | undefined,
): { group: ParamGroup | null; parameters: P[] }[] {
  if (!groups || groups.length === 0) return parameters.length ? [{ group: null, parameters: [...parameters] }] : [];
  const known = new Set(groups.map((g) => g.key));
  const out: { group: ParamGroup | null; parameters: P[] }[] = groups
    .map((g) => ({ group: g, parameters: parameters.filter((p) => p.group === g.key) }))
    .filter((g) => g.parameters.length > 0);
  const rest = parameters.filter((p) => !p.group || !known.has(p.group));
  if (rest.length) out.push({ group: null, parameters: rest });
  return out;
}

export const PREFIX_MAX = 10;
export const WINDOW_HOURS_MAX = 720;
export const METHODS = ['cash', 'card', 'voucher', 'external'] as const;
export type RestoreMethod = (typeof METHODS)[number];

export type WindowKind = 'same_z' | 'same_shift' | 'any' | 'hours';
export const WINDOW_KINDS: WindowKind[] = ['same_z', 'same_shift', 'hours', 'any'];

/** `"hours:6"` → {kind: 'hours', hours: 6}; anything unknown reads as the default, `same_z`. */
export function parseWindow(value: unknown): { kind: WindowKind; hours: number | null } {
  const text = typeof value === 'string' ? value.trim() : '';
  const m = /^hours:([1-9][0-9]{0,2})$/.exec(text);
  if (m) return { kind: 'hours', hours: Number(m[1]) };
  if (text === 'same_shift' || text === 'any' || text === 'same_z') return { kind: text, hours: null };
  return { kind: 'same_z', hours: null };
}

/** The stored text of a window; null when hours are needed and not valid (1–720). */
export function formatWindow(kind: WindowKind, hours: number | string | null): string | null {
  if (kind !== 'hours') return kind;
  const n = typeof hours === 'string' ? Number(hours.trim()) : hours;
  if (n === null || !Number.isInteger(n) || n < 1 || n > WINDOW_HOURS_MAX) return null;
  return `hours:${n}`;
}

/** `"card, cash"` → ['cash', 'card'] (the catalogue's order); unknown names are dropped. */
export function parseMethods(value: unknown): RestoreMethod[] {
  if (typeof value !== 'string') return [];
  const parts = new Set(value.split(',').map((p) => p.trim().toLowerCase()));
  return METHODS.filter((m) => parts.has(m));
}

export function formatMethods(methods: readonly string[]): string {
  const on = new Set(methods);
  return METHODS.filter((m) => on.has(m)).join(',');
}

export function toggleMethod(value: string, method: RestoreMethod): string {
  const list = parseMethods(value);
  return formatMethods(list.includes(method) ? list.filter((m) => m !== method) : [...list, method]);
}

/** The editor's text for a value: '' = inherit. */
export function toText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

/**
 * Back to the value the server takes: null clears the level's own value. An integer goes as a JSON
 * number ("15" → 15, "100" → 100: the server's integer check refuses the text); text that is not a whole
 * number stays text, and `editError` stops it before it is sent.
 */
export function fromText(valueType: string, text: string): unknown {
  if (text === '') return null;
  if (valueType === 'boolean') return text === 'true';
  if (valueType === 'integer') {
    const trimmed = text.trim();
    return /^-?[0-9]+$/.test(trimmed) ? Number(trimmed) : text;
  }
  return text;
}

/** The symbols' size on the till's map, percent (pos-server app/services/table_map_display.py). */
export const MAP_SYMBOL_SCALE_RANGE = { min: 70, max: 150 } as const;

/** `autoFireMinutesOverride`: the minutes for every course at the level, 1–180 (as a course's own). */
export const AUTO_FIRE_MINUTES_MIN = 1;
export const AUTO_FIRE_MINUTES_MAX = 180;

/**
 * Why an edited text would be refused (the server refuses it too), or null. `INHERIT` (an empty
 * text) is always fine; an empty methods list is written as the empty list, not as inherit.
 */
export function editError(key: string, text: string): 'prefix' | 'window' | 'scale' | 'minutes' | null {
  if (text === '') return null;
  if (key === 'restoredTablePrefix') return text.trim() === '' || text.length > PREFIX_MAX ? 'prefix' : null;
  if (key === 'restoreWindow') {
    const { kind, hours } = parseWindow(text);
    return formatWindow(kind, hours) === text.trim() ? null : 'window';
  }
  if (key === 'mapSymbolScale') {
    const n = Number(text.trim());
    const { min, max } = MAP_SYMBOL_SCALE_RANGE;
    return /^\d+$/.test(text.trim()) && n >= min && n <= max ? null : 'scale';
  }
  if (key === 'autoFireMinutesOverride') {
    const trimmed = text.trim();
    const n = Number(trimmed);
    return /^[0-9]{1,3}$/.test(trimmed) && n >= AUTO_FIRE_MINUTES_MIN && n <= AUTO_FIRE_MINUTES_MAX ? null : 'minutes';
  }
  return null;
}

/** An empty methods list ("none allowed") is a value, not "inherit": its own marker in the editor. */
export const NO_METHODS = '__none__';

/** The value to send for a key's edited text (null clears the level's own value). */
export function valueOf(key: string, valueType: string, text: string): unknown {
  if (key === 'reverseMethods') return text === '' ? null : text === NO_METHODS ? '' : text;
  return fromText(valueType, text);
}

/** The editor's text for a stored value of `key`. */
export function textOf(key: string, value: unknown): string {
  if (key === 'reverseMethods' && value === '') return NO_METHODS;
  return toText(value);
}

/** Only the keys whose edited text differs from the level's own value, as the server takes them. */
export function changedValues(
  own: Record<string, unknown>,
  edits: Record<string, string>,
  valueTypes: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, text] of Object.entries(edits)) {
    if (text === textOf(key, own[key])) continue;
    out[key] = valueOf(key, valueTypes[key] ?? 'string', text);
  }
  return out;
}

/** The keys a level sets itself. */
export function ownKeys(own: Record<string, unknown>): string[] {
  return RESTORE_KEYS.filter((k) => own[k] !== undefined && own[k] !== null);
}

/**
 * How a table reads on the floor: its number, big, and its name under it — or, for a restored table
 * made beside its taken original (`labelOnly`, pos-server app/services/tables.py), its label alone
 * ("ש-12"), never "9012 · ש-12". `text` is the one-line form ("12 · VIP", "ש-12").
 */
export function tableDisplay(t: { number: number; name?: string | null; labelOnly?: boolean | null }): {
  main: string;
  sub: string | null;
  text: string;
} {
  const name = (t.name ?? '').trim();
  if (t.labelOnly && name) return { main: name, sub: null, text: name };
  return { main: String(t.number), sub: name || null, text: name ? `${t.number} · ${name}` : String(t.number) };
}
