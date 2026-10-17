/**
 * The Windows 7 build's main-process API scan (test/win7MainApis.test.ts, scripts/build-win7.mjs): the main process
 * and the preloads run on Electron 22 there, so an Electron API that came later (or changed shape later) may be used
 * only behind a capability check. Two kinds of rule:
 *
 *  - `only`: the API may appear only in its compat module (the one place that picks the API by capability) —
 *    views (WebContentsView / contentView / BaseWindow → shell/viewCompat.ts), protocol.handle (shell/schemeHandler.ts).
 *  - `guard`: every use needs a feature test of that name on the same line or the 3 lines before it:
 *    `typeof x.name === 'function'`, `if (x.name)`, `x.name?.(` / `x?.name(`.
 *
 * Electron 22 really is the floor here: net.fetch (28), session.fetch (25), protocol.handle (25), webUtils (29),
 * navigationHistory (30), WebContentsView/BaseWindow stable (30; 22 has an experimental one with no setBounds),
 * webContents.close (25), safeStorage async (35), contextBridge.executeInMainWorld (35), nativeTheme
 * prefersReducedTransparency (30), app.getPreferredSystemLanguages (23), utilityProcess (22, guarded anyway).
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** Main-process / preload sources (relative to kiosk-desktop) the Windows 7 build runs on Electron 22. */
export const MAIN_SOURCE_DIRS = ['src/main', 'src/preload', 'src/legacy', 'src/core'];

export const MAIN_API_RULES = [
  { re: /\bWebContentsView\b/, what: 'WebContentsView (stable in 30; Electron 22 has one with no setBounds)', only: ['src/main/shell/viewCompat.ts'] },
  { re: /\bBaseWindow\b/, what: 'BaseWindow (30)', only: ['src/main/shell/viewCompat.ts'] },
  { re: /\.contentView\b|\baddChildView\b|\bremoveChildView\b/, what: 'win.contentView / addChildView (30)', only: ['src/main/shell/viewCompat.ts'] },
  { re: /\bImageView\b/, what: 'ImageView (30)', only: ['src/main/shell/viewCompat.ts'] },
  { re: /\bprotocol\.(?:handle|unhandle|isProtocolHandled)\(|\.handle\?\.\(|\.unhandle\?\.\(/, what: 'protocol.handle / unhandle (25)', only: ['src/main/shell/schemeHandler.ts'] },
  { re: /\b(?:net|enet)\.fetch\(/, what: 'net.fetch (28)', name: 'fetch' },
  { re: /\b(?:session|ses|defaultSession)\.fetch\(/, what: 'session.fetch (25)', name: 'fetch' },
  { re: /\bnavigationHistory\b/, what: 'webContents.navigationHistory (30)', name: 'navigationHistory' },
  { re: /\bwebContents\.close\(/, what: 'webContents.close (25)', name: 'close' },
  { re: /\bwebUtils\b/, what: 'webUtils (29)', name: 'webUtils' },
  { re: /\b(?:encryptStringAsync|decryptStringAsync|isAsyncEncryptionAvailable)\b/, what: 'safeStorage async (35)', name: '(?:encryptStringAsync|decryptStringAsync|isAsyncEncryptionAvailable)' },
  { re: /\bexecuteInMainWorld\b/, what: 'contextBridge.executeInMainWorld (35)', name: 'executeInMainWorld' },
  { re: /\bprefersReducedTransparency\b/, what: 'nativeTheme.prefersReducedTransparency (30)', name: 'prefersReducedTransparency' },
  { re: /\bgetPreferredSystemLanguages\(/, what: 'app.getPreferredSystemLanguages (23)', name: 'getPreferredSystemLanguages' },
  { re: /\butilityProcess\.fork\(/, what: 'utilityProcess (22)', name: 'fork' },
  { re: /\bsetLoginItemSettings\([^)]*\b(?:type|serviceName)\s*:/, what: 'setLoginItemSettings type/serviceName (28)', name: 'setLoginItemSettings' },
];

function guarded(lines, i, name) {
  const near = lines.slice(Math.max(0, i - 3), i + 1).join('\n');
  const n = `(?:${name})`;
  return (
    new RegExp(`typeof\\s+[\\w.?\\[\\]'"]*\\b${n}\\b`).test(near) ||
    new RegExp(`if\\s*\\(\\s*!?[\\w.?]*\\b${n}\\s*\\)`).test(near) ||
    new RegExp(`\\b${n}\\?\\.\\(|\\?\\.${n}\\b`).test(near)
  );
}

/** Problems in one source file (`file` relative to kiosk-desktop, forward slashes). */
export function scanMainSource(file, text) {
  const out = [];
  if (/\.(?:test|spec)\.ts$/.test(file)) return out;
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '').replace(/^\s*\/\*.*$/, '');
    if (!code.trim()) return;
    for (const rule of MAIN_API_RULES) {
      if (!rule.re.test(code)) continue;
      if (rule.only) {
        if (!rule.only.includes(file)) out.push({ file, line: i + 1, what: `${rule.what} — only in ${rule.only.join(', ')}` });
      } else if (!guarded(lines, i, rule.name)) {
        out.push({ file, line: i + 1, what: `${rule.what} without a feature test` });
      }
    }
  });
  return out;
}

/** Every .ts / .mts / .tsx / .js under the main-process dirs of `root` (kiosk-desktop). */
export function scanMainSources(root) {
  const out = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const full = path.join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(?:ts|mts|tsx|js|mjs|cjs)$/.test(name) && !name.endsWith('.d.ts')) {
        out.push(...scanMainSource(path.relative(root, full).split(path.sep).join('/'), readFileSync(full, 'utf8')));
      }
    }
  };
  for (const dir of MAIN_SOURCE_DIRS) {
    try {
      if (statSync(path.join(root, dir)).isDirectory()) walk(path.join(root, dir));
    } catch {
      /* not in this checkout */
    }
  }
  return out;
}

// `node scripts/win7MainApis.mjs`: exit 1 on a finding (CI / build-win7.mjs).
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
  const found = scanMainSources(root);
  for (const p of found) console.error(`${p.file}:${p.line}: ${p.what} — Electron 22 (the Windows 7 build) needs a fallback`);
  if (found.length) process.exit(1);
  console.log('main API scan: every Electron API newer than 22 is feature-tested');
}
