#!/usr/bin/env node
/**
 * Builds the Android kiosk's web bundle — the kiosk's screens for the APK's WebView (pos-android
 * ui/kiosk/web; pos-server docs/SPEC_UPDATES.md "מסכי קיוסק מהענן"):
 *
 *   npm run build:android-bundle
 *   npm run build:android-bundle -- --apk ../../pos-android     also the APK's built-in fallback
 *   npm run build:android-bundle -- --version-name 2026.10.07-hotfix --version-code 913600
 *
 * Out: dist/android-bundle/ (the files + manifest.json) and dist/kiosk-web-bundle-<version>.zip
 * (also dist/kiosk-web-bundle.zip, the latest) — the file to upload in the dashboard ("עדכוני
 * גרסה" → מסכי קיוסק (ווב)) or with `npm run publish:android-bundle`.
 *
 * `--apk <pos-android>` copies the zip to <pos-android>/app/kiosk-web-bundle/kiosk-web/bundle.zip,
 * the APK's assets source for its fallback bundle (app/build.gradle.kts): the Android build never
 * runs npm — it takes whatever zip is there (none: the APK has no fallback bundle and a kiosk set
 * to "web" stays on the built-in screens until the cloud sends one).
 *
 * The version is the build's time (scripts/androidBundle.ts bundleVersion) unless given.
 */

import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { ANDROID_BRIDGE_API } from '../src/renderer/bridges/androidWire.ts';
import { MANIFEST, buildManifest, bundleVersion, bundleZip, sha256Hex, unzipFiles, verifyManifest } from './androidBundle.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist/android-bundle');
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

process.env.KIOSK_BUNDLE_VERSION = version;
process.env.KIOSK_BUNDLE_CODE = String(versionCode);
process.env.KIOSK_BUNDLE_BRIDGE_API = String(ANDROID_BRIDGE_API);

await build({ configFile: path.join(root, 'vite.android.config.mts'), mode: 'production', logLevel: 'warn' });

/** Every file under dir, as "a/b.js" paths. */
function walk(dir, prefix = '') {
  const files = [];
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) files.push(...walk(full, rel));
    else if (rel !== MANIFEST) files.push({ path: rel, bytes: new Uint8Array(readFileSync(full)) });
  }
  return files;
}

const files = walk(out);
const manifest = buildManifest(files, { version, versionCode, bridgeApi: ANDROID_BRIDGE_API, builtAt });
writeFileSync(path.join(out, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
const byPath = new Map(files.map((f) => [f.path, f.bytes]));
const zip = bundleZip(manifest, byPath);

// The zip read back and checked as the APK will check it.
const back = unzipFiles(zip);
const backManifest = JSON.parse(new TextDecoder().decode(back.get(MANIFEST)));
const problems = verifyManifest(backManifest, back);
if (problems.length > 0) {
  console.error(`the built zip does not hold: ${problems.join(', ')}`);
  process.exit(1);
}

const named = path.join(root, 'dist', `kiosk-web-bundle-${version}.zip`);
const latest = path.join(root, 'dist', 'kiosk-web-bundle.zip');
writeFileSync(named, zip);
writeFileSync(latest, zip);
const kb = (zip.byteLength / 1024).toFixed(0);
console.log(`kiosk web bundle ${version} (code ${versionCode}, bridgeApi ${ANDROID_BRIDGE_API}, minChrome ${manifest.minChrome})`);
console.log(`  ${manifest.files.length} files · ${kb} KB · sha256 ${sha256Hex(zip)}`);
console.log(`  ${path.relative(root, named)}`);

const apk = opt('apk');
if (apk) {
  const target = path.resolve(root, apk, 'app/kiosk-web-bundle/kiosk-web/bundle.zip');
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(latest, target);
  console.log(`  → the APK's fallback: ${target}`);
}
