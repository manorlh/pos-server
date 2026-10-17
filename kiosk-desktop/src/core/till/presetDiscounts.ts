/**
 * "הנחות קבועות" — preset basket discounts (P:/specs/preset-discounts.md): the cloud's `presetDiscounts` /
 * `presetDiscountButtons` as the till reads them (`resolvePresetDiscounts`, lenient: what is not a preset is dropped, never
 * refused) and what one takes off a basket (`applyPreset`, §4). Byte for byte pos-server
 * app/services/preset_discounts.py `resolve_for_till` / `apply_preset`, pinned by the shared golden
 * test/fixtures/preset_discounts_golden.json.
 *
 * A preset lands on the cart as an ordinary basket discount (a percentage in hundredths, or the fixed sum), so the totals,
 * the X and the Z are what they were; the document only names it (`basketDiscountKind` "preset").
 *
 * Pure.
 */

import type { DiscountType } from './discounts';

export const PRESET_DISCOUNTS_KEY = 'presetDiscounts';
export const PRESET_DISCOUNT_BUTTONS_KEY = 'presetDiscountButtons';
/** `basketDiscountKind` of a sale whose basket discount is a preset's. */
export const KIND_PRESET = 'preset';

export const PRESETS_MAX = 20;
export const PRESET_ID_MAX = 64;
export const PRESET_NAME_MAX = 24;
/** "עבור" on the document (the cloud's column). */
export const PRESET_FOR_MAX = 200;
export const PRESET_FOR_REF_MAX = 100;

export type PresetKind = 'percent' | 'amount';
export type PresetForWhom = 'none' | 'optional' | 'required';
export type PresetForWhomSource = 'free' | 'employees' | 'club';
/** `presetDiscountForKind`: picked from the employees, the sale's customer, or typed. */
export type PresetForKind = 'employee' | 'customer' | 'typed';

export interface PresetDiscount {
  id: string;
  name: string;
  kind: PresetKind;
  /** Percent (12.5) or shekels (20), two decimals at most. */
  value: number;
  color: string | null;
  requiresManager: boolean;
  button: boolean;
  forWhom: PresetForWhom;
  forWhomSource: PresetForWhomSource;
}

export interface ResolvedPresets {
  presets: PresetDiscount[];
  /** The ids of the one-tap buttons, in the presets' order. */
  buttons: string[];
}

const KINDS: readonly string[] = ['percent', 'amount'];
const FOR_WHOM: readonly PresetForWhom[] = ['none', 'optional', 'required'];
const FOR_WHOM_SOURCES: readonly PresetForWhomSource[] = ['free', 'employees', 'club'];
const COLOR = /^#[0-9A-Fa-f]{6}$/;
const DECIMAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/* ------------------------------------------------------------------ values */

/**
 * A value in hundredths, HALF_UP (Python `Decimal(str(v)).quantize(0.01, ROUND_HALF_UP)`), or null when it is not a finite
 * number. Exact: the decimal text is scaled, never multiplied as a float.
 */
function hundredthsOf(raw: unknown): bigint | null {
  let text: string;
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return null;
    text = String(raw);
  } else if (typeof raw === 'string') {
    text = raw.trim();
  } else return null;
  const m = DECIMAL.exec(text);
  if (!m) return null;
  const negative = text.startsWith('-');
  const unsigned = text.replace(/^[+-]/, '');
  const [mantissa, expText] = unsigned.split(/[eE]/);
  const [whole, frac = ''] = mantissa.split('.');
  const exp = expText ? Number(expText) : 0;
  if (!Number.isSafeInteger(exp) || Math.abs(exp) > 400) return null;
  // digits × 10^(exp − frac.length), as hundredths: digits × 10^(exp − frac.length + 2).
  const digits = BigInt((whole || '0') + frac);
  const shift = exp - frac.length + 2;
  let out: bigint;
  if (shift >= 0) out = digits * 10n ** BigInt(shift);
  else {
    const div = 10n ** BigInt(-shift);
    const q = digits / div;
    const r = digits % div;
    out = r * 2n >= div ? q + 1n : q;
  }
  return negative ? -out : out;
}

/** The preset's value in hundredths (of a percent / of a shekel = agorot), or null when out of range. */
export function presetValueHundredths(kind: string, raw: unknown): number | null {
  if (typeof raw === 'boolean' || raw === null || raw === undefined) return null;
  const h = hundredthsOf(raw);
  if (h === null) return null;
  const top = kind === 'percent' ? 10_000n : 10_000_000n;
  return h > 0n && h <= top ? Number(h) : null;
}

function nameOf(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const collapsed = raw.split(/\s+/).filter(Boolean).join(' ');
  return Array.from(collapsed).slice(0, PRESET_NAME_MAX).join('').trimEnd();
}

const flagOf = (raw: unknown, dflt: boolean) => (typeof raw === 'boolean' ? raw : dflt);
const choiceOf = <T extends string>(raw: unknown, choices: readonly T[]): T => (typeof raw === 'string' && (choices as readonly string[]).includes(raw) ? (raw as T) : choices[0]);
const colorOf = (raw: unknown) => (typeof raw === 'string' && COLOR.test(raw) ? raw.toUpperCase() : null);

/* ------------------------------------------------- the till's reading (§2) */

function tillPreset(raw: unknown): PresetDiscount | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === 'string' ? r.id.trim() : '';
  if (!id || Array.from(id).length > PRESET_ID_MAX) return null;
  const name = nameOf(r.name);
  const kind = r.kind;
  if (!name || typeof kind !== 'string' || !KINDS.includes(kind)) return null;
  const value = presetValueHundredths(kind, r.value);
  if (value === null || !flagOf(r.active, true)) return null;
  return {
    id,
    name,
    kind: kind as PresetKind,
    value: value / 100,
    color: colorOf(r.color),
    requiresManager: flagOf(r.requiresManager, false),
    button: flagOf(r.button, true),
    forWhom: choiceOf(r.forWhom, FOR_WHOM),
    forWhomSource: choiceOf(r.forWhomSource, FOR_WHOM_SOURCES),
  };
}

/**
 * The presets a till offers, in order, and the ids of the one-tap buttons. A preset not active or not well formed is
 * dropped; a repeated id keeps its first; at most [PRESETS_MAX]. Buttons: the presets [buttons] names (in the presets'
 * order) when it is a list, else every preset whose `button` is on.
 */
export function resolvePresetDiscounts(presets: unknown, buttons: unknown): ResolvedPresets {
  const out: PresetDiscount[] = [];
  const seen = new Set<string>();
  for (const raw of Array.isArray(presets) ? presets : []) {
    const p = tillPreset(raw);
    if (!p || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
    if (out.length >= PRESETS_MAX) break;
  }
  const ids = Array.isArray(buttons) ? new Set(buttons.filter((b): b is string => typeof b === 'string')) : null;
  return { presets: out, buttons: out.filter((p) => (ids ? ids.has(p.id) : p.button)).map((p) => p.id) };
}

/* -------------------------------------------------------------- the rule (§4) */

export interface PresetApplication {
  canApply: boolean;
  discountAgorot: number;
  totalAgorot: number;
  /** The rate DISCOUNT's `maxPercent` is held to; null when it cannot apply. */
  ratePercent: number | null;
}

/**
 * What a preset takes off a basket. [payableAgorot]: the sale lines after their own discounts, with no basket discount;
 * [nonDiscountableAgorot]: what of it takes no discount. A percent of the rest (hundredths of a percent, truncated to the
 * agora), or the amount — capped at the rest, never refused.
 */
export function applyPreset(payableAgorot: number, nonDiscountableAgorot: number, kind: string, value: unknown): PresetApplication {
  const excluded = nonDiscountableAgorot > 0 ? nonDiscountableAgorot : 0;
  const base = payableAgorot - excluded;
  const v = KINDS.includes(kind) ? presetValueHundredths(kind, value) : null;
  if (base <= 0 || v === null) return { canApply: false, discountAgorot: 0, totalAgorot: payableAgorot, ratePercent: null };
  let discount: number;
  let rate: number;
  if (kind === 'percent') {
    discount = Math.floor((base * v) / 10_000);
    rate = v / 100;
  } else {
    discount = Math.min(v, base);
    // discount × 100 / payable, HALF_UP to two decimals — in integers.
    const num = discount * 10_000;
    const q = Math.floor(num / payableAgorot);
    const r = num - q * payableAgorot;
    rate = (r * 2 >= payableAgorot ? q + 1 : q) / 100;
  }
  return { canApply: discount > 0, discountAgorot: discount, totalAgorot: payableAgorot - discount, ratePercent: rate };
}

/** The basket discount the cart is given for a preset: a percentage in hundredths, or the preset's full sum (the cart caps it). */
export function presetCartDiscount(p: Pick<PresetDiscount, 'kind' | 'value'>): { type: DiscountType; value: number } | null {
  const h = presetValueHundredths(p.kind, p.value);
  if (h === null) return null;
  return p.kind === 'percent' ? { type: 'percentage', value: h } : { type: 'fixed', value: h };
}

/** "הנחת עובדים 40%" / "הנחת מנוי" — the receipt's and the cart's words for a preset. */
export function presetLabel(name: string, kind: PresetKind, value: number): string {
  return kind === 'percent' ? `${name} ${Math.round(value * 100) / 100}%` : name;
}

/* --------------------------------------------------------------- for whom */

/** What makes a basket discount a preset's (on the cart, a held sale, the document). */
export interface PresetMark {
  id: string;
  name: string;
  kind: PresetKind;
  /** "עבור": the name; null when none was given. */
  for: string | null;
  forKind: PresetForKind | null;
  forRef: string | null;
}

/** Free text as the document keeps it: whitespace collapsed, cut; blank is null. */
export function cleanPresetText(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const t = Array.from(raw.split(/\s+/).filter(Boolean).join(' ')).slice(0, max).join('');
  return t || null;
}

export type PresetForRefusal = 'required';

/**
 * "עבור מי" as given at the till: ignored when the preset asks none; `required` with no name refuses. The kind defaults to
 * typed; a ref is kept only with a picked employee / customer.
 */
export function presetForOf(preset: Pick<PresetDiscount, 'forWhom'>, raw: { for?: unknown; forKind?: unknown; forRef?: unknown }): { for: string | null; forKind: PresetForKind | null; forRef: string | null } | PresetForRefusal {
  if (preset.forWhom === 'none') return { for: null, forKind: null, forRef: null };
  const name = cleanPresetText(raw.for, PRESET_FOR_MAX);
  if (!name) return preset.forWhom === 'required' ? 'required' : { for: null, forKind: null, forRef: null };
  const kind: PresetForKind = raw.forKind === 'employee' || raw.forKind === 'customer' ? raw.forKind : 'typed';
  const ref = kind === 'typed' ? null : cleanPresetText(raw.forRef, PRESET_FOR_REF_MAX);
  return { for: name, forKind: kind, forRef: ref };
}

/** The document's preset fields (spec §5), only for a preset's basket discount. */
export function presetDocFields(kind: string | null | undefined, mark: PresetMark | null | undefined): Record<string, string> {
  if (kind !== KIND_PRESET || !mark) return {};
  return {
    presetDiscountId: mark.id,
    presetDiscountName: mark.name,
    ...(mark.for ? { presetDiscountFor: mark.for, presetDiscountForKind: mark.forKind ?? 'typed' } : {}),
    ...(mark.for && mark.forRef ? { presetDiscountForRef: mark.forRef } : {}),
  };
}
