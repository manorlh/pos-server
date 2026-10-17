#!/usr/bin/env node
/**
 * The Windows 7 installer (P:/specs/windows7-till.md): the same app on Electron 22 (Chromium 108, Node 16.17),
 * till only, packed from kiosk-desktop/legacy/ (its own package.json, lockfile and node_modules — the standard
 * build's node_modules and Electron 44 are not touched).
 *
 *   npm run win7:setup     legacy/node_modules: npm ci (no scripts), the Electron 22 binary, better-sqlite3's
 *                          prebuilt binary for Electron 22 (ABI 110, win32-x64). Once per checkout.
 *   npm run dist:win7      checks + builds + legacy/release/R2M-POS-Win7-Till-setup-<version>.exe
 *   npm run build:win7     the same without the installer (legacy/dist only)
 *
 * Steps: the Node 16 / Electron 22 type check (tsconfig.legacy.json) → the screens for Chromium 108
 * (R2M_WIN7=1 vite build → legacy/dist/renderer) → the main process for Node 16 (build-main.mjs --win7) → the
 * one app bundle (already Chromium 108, copied to legacy/dist/app-bundle) → the floor scan (nothing newer than
 * Chromium 108 / V8 10.8 in the output, scripts/win7Floor.mjs) → the runtime checks under Electron 22
 * (scripts/win7-check.ts in its Node, scripts/win7-render-check.cjs in its Chromium) → electron-builder --projectDir legacy.
 *
 * Run it from bash (`npm run dist:win7`): from PowerShell Vite once failed on an "absolute path" (memory note).
 */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scanDir } from './win7Floor.mjs';
import { scanMainSources } from './win7MainApis.mjs';

const root = existsSync(path.join(process.cwd(), 'vite.config.mts')) ? process.cwd() : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const legacy = path.join(root, 'legacy');
const args = process.argv.slice(2);
const setupOnly = args.includes('--setup');
const noInstaller = args.includes('--no-installer');

export const ELECTRON_WIN7 = '22.3.27';

function run(cmd, cmdArgs, opts = {}) {
  console.log(`\n> ${cmd} ${cmdArgs.join(' ')}`);
  const r = spawnSync(cmd, cmdArgs, { stdio: 'inherit', shell: process.platform === 'win32', cwd: root, ...opts, env: { ...process.env, ...(opts.env ?? {}) } });
  if (r.status !== 0) {
    console.error(`failed (${r.status}): ${cmd} ${cmdArgs.join(' ')}`);
    process.exit(r.status || 1);
  }
}

function setup() {
  run('npm', ['ci', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: legacy });
  run('node', ['node_modules/electron/install.js'], { cwd: legacy });
  run('node', ['../prebuild-install/bin.js', '--runtime', 'electron', '--target', ELECTRON_WIN7, '--arch', 'x64', '--platform', 'win32'], { cwd: path.join(legacy, 'node_modules', 'better-sqlite3') });
}

const sqliteBinary = path.join(legacy, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');
const electronVersionFile = path.join(legacy, 'node_modules', 'electron', 'dist', 'version');
const ready = () => existsSync(sqliteBinary) && existsSync(electronVersionFile) && readFileSync(electronVersionFile, 'utf8').trim() === ELECTRON_WIN7;

if (setupOnly) {
  setup();
  process.exit(0);
}
if (!ready()) {
  console.log('legacy/node_modules is not set up for Electron 22 yet: running the setup first');
  setup();
}

// The version: the standard build's (the cloud keeps windows7 releases apart, so the same name is fine).
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const legacyPkgFile = path.join(legacy, 'package.json');
const legacyPkg = JSON.parse(readFileSync(legacyPkgFile, 'utf8'));
if (legacyPkg.version !== pkg.version) {
  legacyPkg.version = pkg.version;
  writeFileSync(legacyPkgFile, `${JSON.stringify(legacyPkg, null, 2)}\n`);
}

rmSync(path.join(legacy, 'dist'), { recursive: true, force: true });
run('npx', ['tsc', '-p', 'tsconfig.legacy.json', '--noEmit']);
run('npx', ['vite', 'build'], { env: { R2M_WIN7: '1' } });
run('node', ['scripts/build-main.mjs', '--win7']);
run('node', ['--experimental-strip-types', 'scripts/build-app-bundle.mjs']);
cpSync(path.join(root, 'dist', 'app-bundle'), path.join(legacy, 'dist', 'app-bundle'), { recursive: true });

const problems = scanDir(path.join(legacy, 'dist'));
if (problems.length) {
  for (const p of problems) console.error(`${p.file}: ${p.what} — above the Chromium 108 / V8 10.8 floor`);
  process.exit(3);
}
console.log('floor scan: nothing above Chromium 108 / V8 10.8 in legacy/dist');

// Electron APIs newer than 22 in the main process / preloads only behind a feature test (scripts/win7MainApis.mjs).
const apiProblems = scanMainSources(root);
if (apiProblems.length) {
  for (const p of apiProblems) console.error(`${p.file}:${p.line}: ${p.what} — Electron 22 needs a fallback`);
  process.exit(3);
}
console.log('main API scan: every Electron API newer than 22 is feature-tested');

// Under Electron 22 itself (never the packed app, never the app's data folder): the main process's Node 16 parts
// (polyfills, better-sqlite3, the service and its schema, fetch, serialport) and every screen in Chromium 108.
const electron22 = path.join(legacy, 'node_modules', 'electron', 'dist', 'electron.exe');
run('node', ['scripts/build-main.mjs', '--win7-check']);
run(electron22, [path.join(legacy, 'dist-check', 'win7-check.js')], { env: { ELECTRON_RUN_AS_NODE: '1' }, shell: false });
run('node', ['scripts/win7-render-check.cjs']);

if (noInstaller) process.exit(0);
run('npx', ['electron-builder', '--win', '--x64', '--publish', 'never', '--projectDir', 'legacy']);
console.log(`\nlegacy/release/R2M-POS-Win7-Till-setup-${pkg.version}.exe`);
