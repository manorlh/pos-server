/**
 * "הנחות קבועות" — preset basket discounts (P:/specs/preset-discounts.md §2), as the dashboard
 * edits them: the same rules as the server's `validate_presets` / `validate_buttons`
 * (app/services/preset_discounts.py), so a save is not refused, and the till's reading of which
 * presets are one-tap buttons (`resolve_for_till`).
 *
 * Two settings keys on every layer (company → shop → point of sale → till), the deepest layer that
 * sets each winning as a whole: `presetDiscounts` (the list; `null` = inherit, `[]` = none here)
 * and `presetDiscountButtons` (ids; `null` = inherit, unset everywhere = every active preset whose
 * `button` is on).
 *
 * Pure: no React, no path aliases (tested in node).
 */

export const PRESETS_MAX = 20;
export const PRESET_ID_MAX = 64;
export const PRESET_NAME_MAX = 24;
export const PERCENT_MAX = 100;
export const AMOUNT_MAX = 100000;

export const PRESET_KINDS = ['percent', 'amount'] as const;
export type PresetKind = (typeof PRESET_KINDS)[number];
export const FOR_WHOM = ['none', 'optional', 'required'] as const;
export type ForWhom = (typeof FOR_WHOM)[number];
export const FOR_WHOM_SOURCES = ['free', 'employees', 'club'] as const;
export type ForWhomSource = (typeof FOR_WHOM_SOURCES)[number];

export interface PresetDiscount {
  id: string;
  /** The button's text, printed on the receipt, named in the reports (1–24). */
  name: string;
  kind: PresetKind;
  /** percent: 0.01–100; amount: ₪0.01–100000; two decimals at most. */
  value: number;
  active?: boolean;
  /** `#RRGGBB` or null. */
  color?: string | null;
  /** Always a manager's code, even for a role allowed the rate. */
  requiresManager?: boolean;
  /** A one-tap button on the sell screen (unless `presetDiscountButtons` says otherwise). */
  button?: boolean;
  forWhom?: ForWhom;
  forWhomSource?: ForWhomSource;
}

/** The colours offered (any `#RRGGBB` is accepted). */
export const PRESET_COLORS = ['#2563EB', '#16A34A', '#DC2626', '#D97706', '#7C3AED', '#DB2777', '#0891B2', '#475569'];

const COLOR = /^#[0-9A-Fa-f]{6}$/;

/** A fresh id for a new preset: kept from now on (the documents and the reports name a preset by it). */
export function newPresetId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return 'p-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function newPreset(id: string = newPresetId()): PresetDiscount {
  return {
    id,
    name: '',
    kind: 'percent',
    value: 10,
    active: true,
    color: null,
    requiresManager: false,
    button: true,
    forWhom: 'none',
    forWhomSource: 'free',
  };
}

/** The name as the server keeps it: inner runs of spaces folded, the ends trimmed. */
export function cleanName(name: string): string {
  return name.split(/\s+/).filter(Boolean).join(' ');
}

/** Whether [v] is a valid value for [kind]: above 0, at most the top, two decimals at most. */
export function validValue(kind: PresetKind, v: unknown): boolean {
  if (typeof v !== 'number' || !Number.isFinite(v)) return false;
  if (Math.abs(Math.round(v * 100) - v * 100) > 1e-6) return false;
  return v > 0 && v <= (kind === 'percent' ? PERCENT_MAX : AMOUNT_MAX);
}

export type PresetIssue = 'nameRequired' | 'nameTooLong' | 'valueInvalid' | 'colorInvalid' | 'idRepeats';

/** Per preset, what the server would refuse (an empty list = fine). */
export function presetIssues(list: readonly PresetDiscount[]): PresetIssue[][] {
  const seen = new Set<string>();
  return list.map((p) => {
    const out: PresetIssue[] = [];
    const name = cleanName(p.name ?? '');
    if (!name) out.push('nameRequired');
    else if (name.length > PRESET_NAME_MAX) out.push('nameTooLong');
    if (!validValue(p.kind, p.value)) out.push('valueInvalid');
    if (p.color && !COLOR.test(p.color)) out.push('colorInvalid');
    if (seen.has(p.id)) out.push('idRepeats');
    seen.add(p.id);
    return out;
  });
}

/** Whether the list can be saved: every preset fine and not over the cap. */
export function presetsValid(list: readonly PresetDiscount[]): boolean {
  return list.length <= PRESETS_MAX && presetIssues(list).every((i) => i.length === 0);
}

/** The list as it goes to the server: names cleaned, defaults explicit, an empty colour as null. */
export function presetsForSave(list: readonly PresetDiscount[]): PresetDiscount[] {
  return list.map((p) => ({
    id: p.id,
    name: cleanName(p.name),
    kind: p.kind,
    value: Math.round(p.value * 100) / 100,
    active: p.active !== false,
    color: p.color && COLOR.test(p.color) ? p.color.toUpperCase() : null,
    requiresManager: p.requiresManager === true,
    button: p.button !== false,
    forWhom: p.forWhom ?? 'none',
    forWhomSource: p.forWhomSource ?? 'free',
  }));
}

/** Reads a stored list defensively (an older or hand-written layer). Not a list = null (inherits). */
export function readPresets(raw: unknown): PresetDiscount[] | null {
  if (!Array.isArray(raw)) return null;
  const out: PresetDiscount[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== 'string' || !r.id.trim()) continue;
    const kind: PresetKind = r.kind === 'amount' ? 'amount' : 'percent';
    out.push({
      id: r.id.trim(),
      name: typeof r.name === 'string' ? r.name : '',
      kind,
      value: typeof r.value === 'number' ? r.value : Number(r.value) || 0,
      active: r.active !== false,
      color: typeof r.color === 'string' && COLOR.test(r.color) ? r.color.toUpperCase() : null,
      requiresManager: r.requiresManager === true,
      button: r.button !== false,
      forWhom: (FOR_WHOM as readonly unknown[]).includes(r.forWhom) ? (r.forWhom as ForWhom) : 'none',
      forWhomSource: (FOR_WHOM_SOURCES as readonly unknown[]).includes(r.forWhomSource)
        ? (r.forWhomSource as ForWhomSource)
        : 'free',
    });
  }
  return out;
}

/** Reads a stored button list (ids). Not a list = null (inherits). */
export function readButtons(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  return Array.from(new Set(raw.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())));
}

/**
 * The ids a till shows as one-tap buttons (`resolve_for_till`): of the active presets, those
 * [buttons] names (in the presets' order) when it is a list, else those whose `button` is on.
 */
export function resolveButtonIds(presets: readonly PresetDiscount[], buttons: readonly string[] | null | undefined): string[] {
  const active = presets.filter((p) => p.active !== false);
  if (Array.isArray(buttons)) {
    const wanted = new Set(buttons);
    return active.filter((p) => wanted.has(p.id)).map((p) => p.id);
  }
  return active.filter((p) => p.button !== false).map((p) => p.id);
}

/** Up or down by one; out of range = the same list. */
export function movePreset<T>(list: readonly T[], index: number, delta: -1 | 1): T[] {
  const to = index + delta;
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return [...list];
  const next = [...list];
  [next[index], next[to]] = [next[to], next[index]];
  return next;
}

/** "10%" / "₪25" / "₪12.50" — the value as the button and the receipt word it. */
export function formatPresetValue(p: Pick<PresetDiscount, 'kind' | 'value'>): string {
  const v = Math.round(p.value * 100) / 100;
  const text = Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0$/, '');
  return p.kind === 'percent' ? `${text}%` : `₪${text}`;
}

/** Same lists for "anything to save": ids, order and every field. */
export function samePresets(a: readonly PresetDiscount[] | null, b: readonly PresetDiscount[] | null): boolean {
  if (a === null || b === null) return a === b;
  return JSON.stringify(presetsForSave(a)) === JSON.stringify(presetsForSave(b));
}

export function sameButtons(a: readonly string[] | null, b: readonly string[] | null): boolean {
  if (a === null || b === null) return a === b;
  return a.length === b.length && a.every((x, i) => x === b[i]);
}
