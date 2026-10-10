#!/usr/bin/env node
/**
 * Builds the ONE app bundle (`r2m-app`, P:/specs/web-till-spec-v2.md §8.1):
 *
 *   npm run build:app-bundle
 *   npm run build:app-bundle -- --version-name 2026.10.10-test --version-code 924000
 *
 * Out: dist/app-bundle/ (the files + manifest.json) and dist/web-app-bundle-<version>.zip (also
 * dist/web-app-bundle.zip, the latest) — deterministic, like the Android kiosk bundle. The Windows
 * installer carries dist/app-bundle as its built-in fallback (main/roles/till.ts).
 *
 * The build FAILS when the CSS still holds what Chromium 108 cannot draw without a fallback
 * (`oklch(`, `color-mix(`) or a blur — the floor of S0-12 (§13.3).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { bundleVersion, zipFiles } from './androidBundle.ts';
import { APP_MANIFEST, buildAppManifest, verifyAppBundleDir } from '../src/main/roles/appBundle.ts';

// npm runs this from the package folder: keep that spelling of the path. Node resolves its own
// location through a mapped drive (subst) to the long path, and Vite then finds the entry
// "outside" its root.
const root = existsSync(path.join(process.cwd(), 'vite.app.config.mts')) ? process.cwd() : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist/app-bundle');
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const builtAt = new Date();
const auto = bundleVersion(builtAt);
const version = opt('version-name') ?? auto.versionName;
const versionCode = opt('version-code') ? Number(opt('version-code')) : auto.versionCode;
if (!Number.isInteger(versionCode) || versionCode < 1) {
  console.error('--version-code must be a positive integer');
  process.exit(2);
}
process.env.APP_BUNDLE_VERSION = version;
process.env.APP_BUNDLE_CODE = String(versionCode);

await build({ configFile: path.join(root, 'vite.app.config.mts'), mode: 'production', logLevel: 'warn' });

function walk(dir, prefix = '') {
  const files = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) files.push(...walk(full, rel));
    else if (rel !== APP_MANIFEST) files.push({ path: rel, bytes: new Uint8Array(readFileSync(full)) });
  }
  return files;
}

const files = walk(out);

// The floor (§13.3): nothing in the CSS that Chromium 108 drops without a fallback.
const FORBIDDEN = [/oklch\(/i, /color-mix\(/i, /backdrop-filter/i, /filter:\s*blur/i, /@starting-style/i];
for (const f of files.filter((x) => x.path.endsWith('.css'))) {
  const css = new TextDecoder().decode(f.bytes);
  for (const re of FORBIDDEN) {
    if (re.test(css)) {
      console.error(`${f.path}: ${re} is above the Chromium 108 floor (S0-12)`);
      process.exit(3);
    }
  }
}

// The bundle stands on its own (the Windows installer ships it as resources/app-bundle, the APK in its assets):
// nothing may point at the kiosk window's public pictures (`/kiosk/card_terminals.png`... copied into dist/renderer
// by vite.config.mts's kiosk-public plugin, which this build leaves out) or at the bridge's tray.png.
const NOT_IN_THIS_BUNDLE = [/["'`(=]\.?\/kiosk\/[\w./-]+\.(?:png|webp|jpe?g|gif|svg)/i, /tray\.png/i];
for (const f of files.filter((x) => /\.(?:js|css|html)$/.test(x.path))) {
  const text = new TextDecoder().decode(f.bytes);
  for (const re of NOT_IN_THIS_BUNDLE) {
    const m = re.exec(text);
    if (m) {
      console.error(`${f.path}: refers to ${m[0].slice(0, 80)} - a file that is not part of the app bundle (kiosk public pictures / tray icon)`);
      process.exit(3);
    }
  }
}

const manifest = buildAppManifest(files, {
  version,
  versionCode,
  builtAt,
  roles: ['till'],
  protocol: 1,
  shellApi: { electron: 1, android: 1, ios: 1 },
  bridgeApi: 1,
  minChrome: 108,
  minSafari: '16.4',
});
const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(path.join(out, APP_MANIFEST), manifestBytes);

const check = verifyAppBundleDir(out, { protocols: [1], role: 'till' });
if (!check.ok) {
  console.error('the bundle does not verify:', check.problems.join(', '));
  process.exit(4);
}

const zip = zipFiles([{ path: APP_MANIFEST, bytes: manifestBytes }, ...manifest.files.map((f) => ({ path: f.path, bytes: files.find((x) => x.path === f.path).bytes }))]);
mkdirSync(path.join(root, 'dist'), { recursive: true });
writeFileSync(path.join(root, 'dist', `web-app-bundle-${version}.zip`), zip);
writeFileSync(path.join(root, 'dist', 'web-app-bundle.zip'), zip);
const total = manifest.files.reduce((s, f) => s + f.size, 0);
console.log(`r2m-app ${version} (${versionCode}): ${manifest.files.length} files, ${(total / 1024).toFixed(0)} KB, zip ${(zip.byteLength / 1024).toFixed(0)} KB`);
