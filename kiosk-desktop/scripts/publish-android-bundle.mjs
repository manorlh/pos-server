#!/usr/bin/env node
/**
 * Upload the Android kiosk's web bundle to the cloud's releases ("עדכוני גרסה" → מסכי קיוסק (ווב)) —
 * the same as the dashboard's upload with that platform. Then send it from the dashboard (or with
 * --assign): the kiosks it reaches download it in the background, check every file, and switch to
 * it when idle (pos-server docs/SPEC_UPDATES.md).
 *
 *   npm run build:android-bundle
 *   R2M_ADMIN_TOKEN=<super admin token> npm run publish:android-bundle -- --server https://api.example.com \
 *       [--file dist/kiosk-web-bundle.zip] [--notes "מה חדש"] \
 *       [--assign shop:<uuid> [--auto-install] [--percent 20] [--rollback]]
 *
 * The token is a super admin's dashboard session token (Clerk): in the dashboard's DevTools
 * console, `await window.Clerk.session.getToken()` — read from the environment, never the command
 * line. The cloud reads the version from the bundle's manifest and checks every file's SHA-256.
 */

import { createHash } from 'node:crypto';
import { existsSync, openAsBlob, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name) => args.includes(`--${name}`);

const server = opt('server');
const token = process.env.R2M_ADMIN_TOKEN;
const file = path.resolve(root, opt('file') ?? path.join('dist', 'kiosk-web-bundle.zip'));
if (!server || !token) {
  console.error('usage: R2M_ADMIN_TOKEN=… npm run publish:android-bundle -- --server https://api.example.com [--file …] [--notes …] [--assign level:id]');
  process.exit(2);
}
if (!existsSync(file)) {
  console.error(`no bundle at ${file} — run npm run build:android-bundle first`);
  process.exit(2);
}

let base = server.trim().replace(/\/+$/, '');
if (!/\/api\/v\d+$/.test(base)) base = `${base}/api/v1`;
const headers = { Authorization: `Bearer ${token}` };

const sha256 = createHash('sha256').update(readFileSync(file)).digest('hex');
console.log(`${path.basename(file)} · ${(statSync(file).size / 1024).toFixed(0)} KB · sha256 ${sha256}`);

const form = new FormData();
form.set('file', await openAsBlob(file), path.basename(file));
form.set('platform', 'kiosk_web');
const notes = opt('notes');
if (notes) form.set('notes', notes);

const res = await fetch(`${base}/app-releases`, { method: 'POST', headers, body: form });
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`upload refused: HTTP ${res.status}`, JSON.stringify(body.detail ?? body));
  process.exit(1);
}
console.log(`release ${body.id} · kiosk_web ${body.versionName} (code ${body.versionCode}, bridgeApi ${body.bridgeApi ?? '?'})`);
if (String(body.sha256).toLowerCase() !== sha256) {
  console.error(`the cloud computed another SHA-256 (${body.sha256}) — do not assign this release`);
  process.exit(1);
}

const assign = opt('assign');
if (assign) {
  const [level, targetId] = assign.split(':');
  const percent = opt('percent') ? Number(opt('percent')) : 100;
  const r = await fetch(`${base}/app-releases/${body.id}/assignments`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ level, targetId, autoInstall: flag('auto-install'), rolloutPercent: percent, allowDowngrade: flag('rollback') }),
  });
  const a = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.error(`assignment refused: HTTP ${r.status}`, JSON.stringify(a.detail ?? a));
    process.exit(1);
  }
  console.log(`sent to ${level} ${a.targetName ?? targetId} · ${a.machineCount ?? '?'} devices · ${percent}%`);
}
