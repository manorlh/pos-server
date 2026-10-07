#!/usr/bin/env node
/**
 * Upload a Windows build to the cloud's releases ("עדכוני גרסה" in the dashboard) — the same as
 * the dashboard's upload with "Windows" chosen. Then send it from the dashboard (or with --assign).
 *
 *   npm run dist
 *   R2M_ADMIN_TOKEN=<super admin token> npm run publish:release -- --server https://api.example.com \
 *       [--file release/R2M-POS-Windows-0.2.0-setup.exe] [--notes "מה חדש"] \
 *       [--assign shop:<uuid> [--auto-install] [--percent 20] [--window 02:00-05:00]]
 *
 * The token is a super admin's dashboard session token (Clerk): in the dashboard's DevTools
 * console, `await window.Clerk.session.getToken()`. It lives about a minute — run this right after
 * copying it. It is read from the environment, never from the command line (shell history).
 *
 * The cloud computes the SHA-256 and the size itself; this prints both and checks the SHA-256
 * against the local file. The version is package.json's (the installer's own).
 */

import { createHash } from 'node:crypto';
import { createReadStream, existsSync, openAsBlob, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name) => args.includes(`--${name}`);

const server = opt('server');
const token = process.env.R2M_ADMIN_TOKEN;
const file = path.resolve(root, opt('file') ?? path.join('release', `R2M-POS-Windows-${pkg.version}-setup.exe`));
if (!server || !token) {
  console.error('usage: R2M_ADMIN_TOKEN=… npm run publish:release -- --server https://api.example.com [--file …] [--notes …] [--assign level:id]');
  process.exit(2);
}
if (!existsSync(file)) {
  console.error(`no installer at ${file} — run npm run dist first`);
  process.exit(2);
}

let base = server.trim().replace(/\/+$/, '');
if (!/\/api\/v\d+$/.test(base)) base = `${base}/api/v1`;
const headers = { Authorization: `Bearer ${token}` };

const sha256 = await new Promise((resolve, reject) => {
  const h = createHash('sha256');
  createReadStream(file)
    .on('data', (c) => h.update(c))
    .on('error', reject)
    .on('end', () => resolve(h.digest('hex')));
});
console.log(`${path.basename(file)} · ${(statSync(file).size / 1024 / 1024).toFixed(1)} MB · sha256 ${sha256}`);

const form = new FormData();
form.set('file', await openAsBlob(file), path.basename(file));
form.set('platform', 'windows');
form.set('versionName', pkg.version);
const notes = opt('notes');
if (notes) form.set('notes', notes);

const res = await fetch(`${base}/app-releases`, { method: 'POST', headers, body: form });
const body = await res.json().catch(() => ({}));
if (!res.ok) {
  console.error(`upload refused: HTTP ${res.status}`, JSON.stringify(body.detail ?? body));
  process.exit(1);
}
console.log(`release ${body.id} · ${body.platform ?? 'windows'} ${body.versionName} (code ${body.versionCode})`);
if (String(body.sha256).toLowerCase() !== sha256) {
  console.error(`the cloud computed another SHA-256 (${body.sha256}) — do not assign this release`);
  process.exit(1);
}

const assign = opt('assign');
if (assign) {
  const [level, targetId] = assign.split(':');
  const window = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(opt('window') ?? '');
  const a = await fetch(`${base}/app-releases/${body.id}/assignments`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      level,
      targetId,
      autoInstall: flag('auto-install'),
      ...(opt('percent') ? { rolloutPercent: Number(opt('percent')) } : {}),
      ...(window ? { installWindow: { start: window[1], end: window[2] } } : {}),
    }),
  });
  const ab = await a.json().catch(() => ({}));
  if (!a.ok) {
    console.error(`assignment refused: HTTP ${a.status}`, JSON.stringify(ab.detail ?? ab));
    process.exit(1);
  }
  console.log(`sent to ${level} ${ab.targetName ?? targetId}: ${ab.machineCount ?? '?'} device(s)`);
}
