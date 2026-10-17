/**
 * The Windows 7 build's floor scan (scripts/build-win7.mjs, test/win7Build.test.ts): nothing in the built output
 * that Electron 22 cannot run — Chromium 108 for the screens, V8 10.8 + Node 16.17 for the main process.
 *
 * Bundlers lower SYNTAX to the target (esbuild node16.17, Vite chrome108) but never add missing BUILT-INS; those are
 * found here by name. A built-in that is only feature-detected carries a `guard` (the detection's text) with the reason.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** JS built-ins newer than Chromium 108 / V8 10.8 (the version that brought them in brackets). */
export const JS_ABOVE_FLOOR = [
  { re: /\.toSorted\(/, what: 'Array.prototype.toSorted (110)' },
  { re: /\.toReversed\(/, what: 'Array.prototype.toReversed (110)' },
  { re: /\.toSpliced\(/, what: 'Array.prototype.toSpliced (110)' },
  { re: /\bObject\.groupBy\(/, what: 'Object.groupBy (117)' },
  { re: /\bMap\.groupBy\(/, what: 'Map.groupBy (117)' },
  { re: /\bPromise\.withResolvers\(/, what: 'Promise.withResolvers (119)' },
  { re: /\bArray\.fromAsync\(/, what: 'Array.fromAsync (121)' },
  // undici 5 (the Windows 7 build's fetch): `var Q=!!String.prototype.toWellFormed; … Q ? s.toWellFormed() : toUSVString(s)`.
  { re: /\.isWellFormed\(|\.toWellFormed\(/, what: 'String.prototype.isWellFormed / toWellFormed (111)', guard: /!!String\.prototype\.(?:toWellFormed|isWellFormed)/ },
  { re: /\.(?:symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\(/, what: 'Set methods (122)' },
  { re: /\bURL\.canParse\(/, what: 'URL.canParse (120)' },
  { re: /\bAbortSignal\.any\(/, what: 'AbortSignal.any (116)' },
];

/** CSS that Chromium 108 drops without a fallback (the app bundle's own list, scripts/build-app-bundle.mjs). */
export const CSS_ABOVE_FLOOR = [
  { re: /@starting-style/i, what: '@starting-style (117)' },
  { re: /field-sizing\s*:/i, what: 'field-sizing (123)' },
  { re: /anchor-name\s*:|position-anchor\s*:/i, what: 'anchor positioning (125)' },
  { re: /@container\s+style\(/i, what: 'container style queries (111)' },
];

/**
 * CSS colours: `oklch(` / `color-mix(` / `lab(` may stay only inside an `@supports` block (Lightning CSS writes an
 * rgb fallback first and keeps the modern colour under `@supports (color: lab(…))` / `(color: color-mix(…))`).
 */
export function unguardedColours(css) {
  let depth = 0;
  let guardDepth = -1;
  const found = new Set();
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '@' && guardDepth < 0 && css.startsWith('@supports', i)) {
      const open = css.indexOf('{', i);
      if (open < 0) break;
      guardDepth = depth;
      depth++;
      i = open;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (guardDepth >= 0 && depth === guardDepth) guardDepth = -1;
    } else if (guardDepth < 0) {
      for (const name of ['oklch(', 'color-mix(', 'oklab(']) {
        if (css.startsWith(name, i)) found.add(name.slice(0, -1));
      }
    }
  }
  return [...found];
}

/** Problems in one file's text (by its extension). */
export function scanText(file, text) {
  const out = [];
  if (/\.(?:m?js|cjs)$/.test(file)) {
    // `guard`: the built-in is only feature-detected there (the code has its own fallback).
    for (const { re, what, guard } of JS_ABOVE_FLOOR) if (re.test(text) && !(guard && guard.test(text))) out.push({ file, what });
  } else if (file.endsWith('.css')) {
    for (const { re, what } of CSS_ABOVE_FLOOR) if (re.test(text)) out.push({ file, what });
    for (const colour of unguardedColours(text)) out.push({ file, what: `${colour}() with no fallback` });
  } else if (file.endsWith('.html')) {
    for (const m of text.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) out.push(...scanText(`${file}#style.css`, m[1]));
  }
  return out;
}

/** Every .js / .css / .html under `dir`. */
export function scanDir(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = path.join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(?:m?js|cjs|css|html)$/.test(name)) out.push(...scanText(path.relative(dir, full), readFileSync(full, 'utf8')));
    }
  };
  walk(dir);
  return out;
}
