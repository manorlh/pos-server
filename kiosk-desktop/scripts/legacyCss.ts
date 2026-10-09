/**
 * Tailwind 4's CSS for Chromium 108 — the Windows 7 legacy build (Electron 22) only
 * (P:/specs/web-till-spec-v2.md §13.3). The modern build is not touched by any of this.
 *
 * Why: Tailwind 4 targets Chrome 111. Its palette is `oklch()` in custom properties
 * (`--color-red-50: oklch(…)`), so on Chromium 108 every `var(--color-…)` is invalid at computed
 * time — backgrounds go transparent, text inherits. Gradients interpolate `in oklab` (111) and drop.
 *
 * How (no new dependency): Lightning CSS — already installed, it is Tailwind's own
 * (@tailwindcss/node depends on lightningcss 1.32.0) — at Chrome 108 targets gives every colour an
 * sRGB value first (custom properties included, with the lab() value behind `@supports`), and
 * drops `in <space>` from gradients here.
 *
 * `chrome108View()` models what Chromium 108 keeps of a sheet (a declaration with a colour function
 * or interpolation it does not know is dropped; so is an `@supports` block that needs one), and
 * `coverageGaps()` lists what a modern sheet sets that the legacy sheet, as Chromium 108 sees it,
 * no longer does — the build fails on any gap not explained below. Node only.
 */

import { transform } from 'lightningcss';

export const LEGACY_CHROME = 108;
/** Lightning CSS targets: Electron 22 is Chromium 108; Chrome / Edge 109 on Windows 7. */
export const LEGACY_TARGETS = { chrome: LEGACY_CHROME << 16, edge: LEGACY_CHROME << 16 };

/** Colour functions and syntax Chromium 108 does not parse (they came in 111). */
const UNSUPPORTED = /\b(?:oklch|oklab|lch|color-mix|light-dark)\(|(?<![\w-])lab\(|\bin\s+(?:oklab|oklch|lab|lch|srgb|srgb-linear|xyz|xyz-d50|xyz-d65|display-p3|hsl|hwb)\b|\b(?:rgb|hsl)\(\s*from\b/i;

/**
 * Gaps the legacy sheet may keep, each with its reason. A placeholder's colour mixes `currentcolor`,
 * which no fallback can express: Chromium 108 shows its own placeholder grey.
 */
export const KNOWN_GAPS: ReadonlyArray<{ selector: RegExp; property: string; why: string }> = [
  { selector: /::?placeholder$/, property: 'color', why: 'color-mix() with currentcolor — the browser\'s own placeholder grey' },
];

/* ------------------------------------------------------------------- a small CSS tree */

export interface CssNode {
  /** The selector or at-rule prelude; for a statement (`@layer a,b;`) the whole statement. */
  prelude: string;
  /** null: a statement without a block. */
  items: Array<string | CssNode> | null;
}

function skipString(s: string, i: number): number {
  const q = s[i];
  for (i += 1; i < s.length; i++) {
    if (s[i] === '\\') i += 1;
    else if (s[i] === q) return i;
  }
  return i;
}

function stripComments(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'") {
      const end = skipString(s, i);
      out += s.slice(i, end + 1);
      i = end;
    } else if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end < 0 ? s.length : end + 1;
    } else out += c;
  }
  return out;
}

/** Parses a block's content: declarations (strings) and nested rules / at-rules (nodes). */
function parseItems(s: string, start: number, end: number): Array<string | CssNode> {
  const items: Array<string | CssNode> = [];
  let i = start;
  let tokenStart = start;
  let paren = 0;
  while (i < end) {
    const c = s[i];
    if (c === '"' || c === "'") i = skipString(s, i);
    else if (c === '(') paren += 1;
    else if (c === ')') paren -= 1;
    else if (paren === 0 && c === ';') {
      const text = s.slice(tokenStart, i).trim();
      if (text) items.push(text.startsWith('@') ? { prelude: text, items: null } : text);
      tokenStart = i + 1;
    } else if (paren === 0 && c === '{') {
      const prelude = s.slice(tokenStart, i).trim();
      let depth = 1;
      let j = i + 1;
      for (; j < end && depth > 0; j++) {
        const d = s[j];
        if (d === '"' || d === "'") j = skipString(s, j);
        else if (d === '{') depth += 1;
        else if (d === '}') depth -= 1;
      }
      items.push({ prelude, items: parseItems(s, i + 1, j - 1) });
      i = j;
      tokenStart = j;
      continue;
    }
    i += 1;
  }
  const tail = s.slice(tokenStart, end).trim();
  if (tail) items.push(tail.startsWith('@') ? { prelude: tail, items: null } : tail);
  return items;
}

export function parseCss(css: string): Array<string | CssNode> {
  const s = stripComments(css);
  return parseItems(s, 0, s.length);
}

export function serializeCss(items: Array<string | CssNode>): string {
  const out: string[] = [];
  const decls: string[] = [];
  const flush = () => {
    if (decls.length) out.push(decls.splice(0).join(';'));
  };
  for (const it of items) {
    if (typeof it === 'string') decls.push(it);
    else {
      flush();
      out.push(it.items === null ? `${it.prelude};` : `${it.prelude}{${serializeCss(it.items)}}`);
    }
  }
  flush();
  return out.join('');
}

function declParts(d: string): { property: string; value: string } {
  const at = d.indexOf(':');
  return at < 0 ? { property: d.trim(), value: '' } : { property: d.slice(0, at).trim(), value: d.slice(at + 1).trim() };
}

/* ------------------------------------------------------------------- the legacy pass */

const INTERPOLATION = /\s*\bin\s+(?:oklab|oklch|lab|lch|srgb|srgb-linear|xyz|xyz-d50|xyz-d65|display-p3|hsl|hwb)(?:\s+(?:shorter|longer|increasing|decreasing)\s+hue)?/gi;

/** `linear-gradient(to right in oklab, …)` → `linear-gradient(to right, …)`; `(in oklab, …)` → `(…)`. */
export function dropInterpolationInGradients(value: string): string {
  return value.replace(/((?:repeating-)?(?:linear|radial|conic)-gradient\()([^,()]*)(,\s*)/gi, (_m, fn: string, first: string, comma: string) => {
    if (!INTERPOLATION.test(first)) return `${fn}${first}${comma}`;
    INTERPOLATION.lastIndex = 0;
    const rest = first.replace(INTERPOLATION, '').trim();
    return rest ? `${fn}${rest}${comma}` : fn;
  });
}

/** Tailwind's `--tw-gradient-position` without the interpolation; never empty (it is followed by a comma). */
function gradientPosition(value: string, siblings: string[]): string {
  const rest = value.replace(INTERPOLATION, '').trim();
  INTERPOLATION.lastIndex = 0;
  if (rest) return rest;
  const image = siblings.map(declParts).find((d) => d.property === 'background-image')?.value ?? '';
  if (/radial-gradient/.test(image)) return 'ellipse';
  if (/conic-gradient/.test(image)) return 'from 0deg';
  return 'to bottom';
}

function fixGradients(items: Array<string | CssNode>): Array<string | CssNode> {
  const decls = items.filter((x): x is string => typeof x === 'string');
  return items.map((it) => {
    if (typeof it !== 'string') return it.items === null ? it : { prelude: it.prelude, items: fixGradients(it.items) };
    const { property, value } = declParts(it);
    if (property === '--tw-gradient-position' && INTERPOLATION.test(value)) {
      INTERPOLATION.lastIndex = 0;
      return `${property}:${gradientPosition(value, decls)}`;
    }
    INTERPOLATION.lastIndex = 0;
    if (/-gradient\(/i.test(value)) return `${property}:${dropInterpolationInGradients(value)}`;
    return it;
  });
}

/** A modern Tailwind 4 sheet → the same look on Chromium 108. */
export function legacyCss(css: string, filename = 'style.css'): string {
  const lowered = Buffer.from(transform({ filename, code: Buffer.from(css), targets: LEGACY_TARGETS, minify: true, errorRecovery: true }).code).toString('utf8');
  return serializeCss(fixGradients(parseCss(lowered)));
}

/* ---------------------------------------------------------- what Chromium 108 keeps */

function supportsNeeds111(prelude: string): boolean {
  if (!/^@supports\b/i.test(prelude)) return false;
  if (/\bnot\s*\(/i.test(prelude)) return false; // Tailwind's own feature sniffs: harmless either way
  return UNSUPPORTED.test(prelude);
}

/** The sheet as Chromium 108 keeps it (a model: unknown colour syntax dropped, as the parser does). */
export function chrome108View(css: string): string {
  const walk = (items: Array<string | CssNode>): Array<string | CssNode> => {
    const out: Array<string | CssNode> = [];
    for (const it of items) {
      if (typeof it === 'string') {
        if (!UNSUPPORTED.test(declParts(it).value)) out.push(it);
      } else if (it.items === null) out.push(it);
      else if (!supportsNeeds111(it.prelude)) out.push({ prelude: it.prelude, items: walk(it.items) });
    }
    return out;
  };
  return serializeCss(walk(parseCss(css)));
}

/** A selector list split at its top-level commas (a minifier may merge or split rules). */
export function splitSelectors(list: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === '"' || c === "'") i = skipString(list, i);
    else if (c === '(' || c === '[') depth += 1;
    else if (c === ')' || c === ']') depth -= 1;
    else if (c === ',' && depth === 0) {
      out.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(list.slice(start).trim());
  return out.filter(Boolean);
}

/** "context|selector|property" for every declaration, one per selector (@supports left out of the context). */
export function declarationKeys(css: string): Set<string> {
  const keys = new Set<string>();
  const walk = (items: Array<string | CssNode>, ctx: string, selectors: string[]) => {
    for (const it of items) {
      if (typeof it === 'string') {
        const property = declParts(it).property;
        for (const sel of selectors) keys.add(`${ctx}|${sel}|${property}`);
        continue;
      }
      if (it.items === null) continue;
      if (/^@supports\b/i.test(it.prelude)) walk(it.items, ctx, selectors);
      else if (it.prelude.startsWith('@')) walk(it.items, `${ctx}${it.prelude.replace(/\s+/g, ' ')};`, selectors);
      else walk(it.items, ctx, splitSelectors(it.prelude.replace(/\s+/g, ' ')));
    }
  };
  walk(parseCss(css), '', ['']);
  return keys;
}

/** What `modern` sets (on 111+) that `legacy`, as Chromium 108 keeps it, does not set at all. */
export function coverageGaps(modern: string, legacy: string): string[] {
  const have = declarationKeys(chrome108View(legacy));
  const normalise = (k: string) => k.replace(/\s+/g, '');
  const haveN = new Set(Array.from(have, normalise));
  return Array.from(declarationKeys(modern))
    .filter((k) => !haveN.has(normalise(k)))
    .filter((k) => {
      const [, selector, property] = k.split('|');
      return !KNOWN_GAPS.some((g) => g.property === property && g.selector.test(selector));
    });
}
