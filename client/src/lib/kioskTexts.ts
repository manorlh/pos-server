/**
 * Every text a kiosk customer sees, editable per language (docs/SPEC_KIOSK_LAYOUTS.md §texts):
 * the registry (`kioskTextRegistryData.ts`, generated from the shared fixture
 * server/tests/fixtures/kiosk_text_registry.json — the same table the server validates with and the
 * Android kiosk looks its strings up through) and the lookup the screens use.
 *
 *     textsByLang[lang][key] → (lang is the kiosk's first language) texts[key] → the registry's default of lang
 *
 * `texts` stays flat (an older kiosk reads only it); `textsByLang` holds the other languages. A
 * layer merges both key by key, so a text set by the company, overridden by a shop, inherits per
 * key and per language with no code of its own. Placeholders are named: "{total}", "{count}".
 *
 * Pure, no React; only TYPES from kioskConfig (no runtime cycle).
 */

import type { KioskConfig, KioskLanguage } from './kioskConfig';
import type { KioskLayout } from './kioskLayout';
import { KIOSK_TEXT_REGISTRY_DATA } from './kioskTextRegistryData';

/** When a text (or its group) is shown: config `layout` keys → allowed values (AND); `any`: OR of such. */
export interface TextShownWhen {
  any?: TextShownWhen[];
  [layoutKey: string]: unknown;
}

export interface KioskTextGroupDef {
  id: string;
  kind: 'screen' | 'layout';
  label: { he: string; en: string };
  shownWhen?: TextShownWhen | null;
}

/** A web key whose text this registry key replaces; `rename`: the web message's placeholder → the registry's. */
export type KioskWebTextRef = string | { key: string; rename?: Record<string, string> };

export interface KioskTextDef {
  key: string;
  group: string;
  /** What it is on the screen (Hebrew, for the editor). */
  label: string;
  defaults: { he: string; en: string; ar?: string; ru?: string };
  max: number;
  /** Named placeholders, in the Android resource's positional order. */
  placeholders: string[];
  android: string[];
  web: KioskWebTextRef[];
  /** One of the flat `texts` keys of before the registry. */
  legacy: boolean;
  shownWhen?: TextShownWhen | null;
}

export interface KioskTextRegistry {
  version: number;
  languages: string[];
  placeholders: string[];
  groups: KioskTextGroupDef[];
  texts: KioskTextDef[];
}

export type KioskTextsByLang = Partial<Record<KioskLanguage, Record<string, string>>>;

export const KIOSK_TEXT_REGISTRY: KioskTextRegistry = KIOSK_TEXT_REGISTRY_DATA;
export const KIOSK_TEXT_GROUPS: KioskTextGroupDef[] = KIOSK_TEXT_REGISTRY.groups;
export const KIOSK_TEXTS: KioskTextDef[] = KIOSK_TEXT_REGISTRY.texts;
export const KIOSK_TEXT_PLACEHOLDERS: string[] = KIOSK_TEXT_REGISTRY.placeholders;

const BY_KEY = new Map(KIOSK_TEXTS.map((d) => [d.key, d] as const));

/** web key → the registry text that replaces it, with the web message's placeholder renames. */
const BY_WEB = new Map<string, { def: KioskTextDef; rename: Record<string, string> }>();
for (const d of KIOSK_TEXTS) {
  for (const w of d.web ?? []) {
    const ref = typeof w === 'string' ? { key: w, rename: {} } : { key: w.key, rename: w.rename ?? {} };
    if (!BY_WEB.has(ref.key)) BY_WEB.set(ref.key, { def: d, rename: ref.rename });
  }
}

export function kioskTextDef(key: string): KioskTextDef | null {
  return BY_KEY.get(key) ?? null;
}

export function isKioskTextKey(key: string): boolean {
  return BY_KEY.has(key);
}

type TextsIn = Pick<KioskConfig, 'texts'> & { textsByLang?: KioskTextsByLang | null; general?: { languages?: readonly string[] } };

/** The kiosk's first language: its `texts` are in it. */
export function primaryLanguage(cfg: TextsIn): string {
  return cfg.general?.languages?.[0] ?? 'he';
}

/** The text a level configured for `key` in `lang` (null: the default). */
export function configuredText(cfg: TextsIn, lang: string, key: string): string | null {
  const byLang = cfg.textsByLang?.[lang as KioskLanguage]?.[key];
  if (typeof byLang === 'string' && byLang.trim() !== '') return byLang;
  if (lang === primaryLanguage(cfg)) {
    const flat = (cfg.texts as Record<string, string | undefined> | undefined)?.[key];
    if (typeof flat === 'string' && flat.trim() !== '') return flat;
  }
  return null;
}

/** The registry's default of `key` in `lang` (Hebrew when that language has none), or null for an unknown key. */
export function defaultText(lang: string, key: string): string | null {
  const d = BY_KEY.get(key);
  if (!d) return null;
  const own = (d.defaults as Record<string, string | undefined>)[lang];
  return own && own !== '' ? own : d.defaults.he;
}

/** "{total}" → its value; an unknown name stays as written. */
export function fillPlaceholders(text: string, values?: Record<string, string | number>): string {
  if (!values) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (values[k] === undefined ? m : String(values[k])));
}

/** The text the customer sees: configured, else the default, with the placeholders filled. */
export function kioskTextOf(cfg: TextsIn, lang: string, key: string, values?: Record<string, string | number>): string {
  return fillPlaceholders(configuredText(cfg, lang, key) ?? defaultText(lang, key) ?? key, values);
}

/**
 * A web screen's own label (`m.t('viewCart')`) as the business set it: the registry text that
 * replaces that web key, configured in `lang` — null when nobody configured it (the label stays).
 */
export function webTextOverride(cfg: TextsIn, lang: string, webKey: string, values?: Record<string, string | number>): string | null {
  const hit = BY_WEB.get(webKey);
  if (!hit) return null;
  const own = configuredText(cfg, lang, hit.def.key);
  if (own === null) return null;
  const named: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(values ?? {})) named[hit.rename[k] ?? k] = v;
  return fillPlaceholders(own, named);
}

/** Whether a text (or a group) is shown under `layout` (`shownWhen`; none — always). */
export function textShownUnder(when: TextShownWhen | null | undefined, layout: Partial<KioskLayout> | null | undefined): boolean {
  if (!when) return true;
  if (Array.isArray(when.any) && when.any.length > 0) {
    if (!when.any.some((w) => textShownUnder(w, layout))) return false;
  }
  for (const [k, allowed] of Object.entries(when)) {
    if (k === 'any') continue;
    if (!Array.isArray(allowed)) continue;
    const v = (layout as Record<string, unknown> | null | undefined)?.[k];
    if (!allowed.includes(v as never)) return false;
  }
  return true;
}

/** The placeholders a text uses ("{total}" → total). */
export function placeholdersIn(text: string): string[] {
  return Array.from(new Set(Array.from(text.matchAll(/\{(\w+)\}/g), (m) => m[1])));
}

export interface TextIssue {
  path: string;
  code: string;
  params?: Record<string, string | number>;
}

const LANGS = ['he', 'en', 'ar', 'ru'];

/**
 * `textsByLang`: known languages, registry keys, each within its `max`, and only the placeholders
 * the text has (an unknown one would print as written). The flat `texts` keep their own rules
 * (validateKioskConfig) — an older kiosk reads them.
 */
export function validateKioskTexts(cfg: Partial<Pick<KioskConfig, 'texts'>> & { textsByLang?: unknown }): TextIssue[] {
  const out: TextIssue[] = [];
  const byLang = cfg.textsByLang;
  if (byLang === undefined || byLang === null) return out;
  if (typeof byLang !== 'object' || Array.isArray(byLang)) return [{ path: 'textsByLang', code: 'enum' }];
  for (const [lang, map] of Object.entries(byLang as Record<string, unknown>)) {
    if (!LANGS.includes(lang)) {
      out.push({ path: `textsByLang.${lang}`, code: 'unknownKey', params: { key: lang } });
      continue;
    }
    if (map === null || map === undefined) continue;
    if (typeof map !== 'object' || Array.isArray(map)) {
      out.push({ path: `textsByLang.${lang}`, code: 'enum' });
      continue;
    }
    for (const [key, value] of Object.entries(map as Record<string, unknown>)) {
      const path = `textsByLang.${lang}.${key}`;
      const def = BY_KEY.get(key);
      if (!def) {
        out.push({ path, code: 'unknownTextKey', params: { key } });
        continue;
      }
      if (value === null || value === undefined) continue;
      if (typeof value !== 'string') {
        out.push({ path, code: 'enum' });
        continue;
      }
      if (value.length > def.max) out.push({ path, code: 'tooLong', params: { max: def.max } });
      const unknown = placeholdersIn(value).filter((p) => !def.placeholders.includes(p));
      if (unknown.length > 0) out.push({ path, code: 'textPlaceholder', params: { name: unknown[0] } });
    }
  }
  return out;
}

/** Where a level's value of a text comes from, for the editor's badge. */
export type TextSource = 'default' | 'inherited' | 'here';

/** The texts of a group, in order (the editor's list). */
export function textsOfGroup(group: string): KioskTextDef[] {
  return KIOSK_TEXTS.filter((d) => d.group === group);
}
