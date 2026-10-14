/**
 * "שחזור שולחן ותשלומים" (pos-server app/services/table_restore.py, P:/specs/table-restore-payments.md
 * §3, §5): the tables page's editor of the eight till parameters per level — the pure helpers. How a
 * level's value reads and is written back, the restore window (`same_z` | `same_shift` | `any` |
 * `hours:N`), the methods list (`cash,card,voucher,external`), and the checks the server makes too.
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
  methods: { key: string; label: string }[];
  canEdit: boolean;
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

/** Back to the value the server takes: null clears the level's own value. */
export function fromText(valueType: string, text: string): unknown {
  if (text === '') return null;
  if (valueType === 'boolean') return text === 'true';
  return text;
}

/**
 * Why an edited text would be refused (the server refuses it too), or null. `INHERIT` (an empty
 * text) is always fine; an empty methods list is written as the empty list, not as inherit.
 */
export function editError(key: string, text: string): 'prefix' | 'window' | null {
  if (text === '') return null;
  if (key === 'restoredTablePrefix') return text.trim() === '' || text.length > PREFIX_MAX ? 'prefix' : null;
  if (key === 'restoreWindow') {
    const { kind, hours } = parseWindow(text);
    return formatWindow(kind, hours) === text.trim() ? null : 'window';
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
