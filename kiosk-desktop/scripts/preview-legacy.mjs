#!/usr/bin/env node
/**
 * The visual check of the Windows 7 legacy CSS (P:/specs/web-till-spec-v2.md §13.3):
 *
 *   node --experimental-strip-types scripts/preview-legacy.mjs [--port 5187]
 *
 * Builds the renderer with the demo bridge (`--mode web`) twice — modern (vite.config.mts) and
 * legacy (vite.legacy.config.mts) — into dist/legacy-preview/, adds two copies whose CSS is cut to
 * what Chromium 108 keeps of it (scripts/legacyCss.ts chrome108View), and serves the four:
 *
 *   /modern/      today's build, as Chrome 111+ draws it
 *   /modern108/   today's build as Chromium 108 keeps its CSS — what Windows 7 would show
 *   /legacy/      the legacy build
 *   /legacy108/   the legacy build as Chromium 108 keeps its CSS — must look like /modern/
 *
 * (The modern config's own picture copy also refreshes dist/renderer/kiosk — the same files.)
 *
 * Each with `index.html?style=…` for the kiosk, `?role=kds`, `?role=board`. No Chromium 108 is
 * downloaded: the "108" copies model its parser (a declaration with a colour function or gradient
 * interpolation it does not know is dropped; so is an @supports block that needs one).
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chrome108View } from './legacyCss.ts';

// npm runs this from the package folder: keep that spelling of the path (a mapped drive resolves
// to the long path through this file's own URL, and Vite then finds the entries "outside" its root).
const root = existsSync(path.join(process.cwd(), 'vite.legacy.config.mts')) ? process.cwd() : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const out = path.join(root, 'dist', 'legacy-preview');
const args = process.argv.slice(2);
const port = Number(args[args.indexOf('--port') + 1]) || 5187;

/**
 * One build in demo mode, in a plain child `node`: Vite loads the config file itself. (Inside this
 * process — started with --experimental-strip-types — Vite resolves the mapped drive differently and
 * the build fails.) Only the output folder differs from a normal build.
 */
function variant(configFile, name) {
  const dir = path.join(out, name);
  const code = `import('vite').then((v) => v.build({ configFile: ${JSON.stringify(path.join(root, configFile))}, mode: 'web', logLevel: 'warn', build: { outDir: ${JSON.stringify(dir)}, emptyOutDir: true } }))`;
  execFileSync(process.execPath, ['-e', code], { cwd: root, stdio: 'inherit' });
  const pictures = path.resolve(root, '../client/public/kiosk');
  if (existsSync(pictures)) cpSync(pictures, path.join(dir, 'kiosk'), { recursive: true });
  return dir;
}

function cssFiles(dir) {
  const res = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) res.push(...cssFiles(full));
    else if (name.endsWith('.css')) res.push(full);
  }
  return res;
}

function as108(from, name) {
  const dir = path.join(out, name);
  rmSync(dir, { recursive: true, force: true });
  cpSync(from, dir, { recursive: true });
  for (const f of cssFiles(dir)) writeFileSync(f, chrome108View(readFileSync(f, 'utf8')));
  return dir;
}

mkdirSync(out, { recursive: true });
const modern = variant('vite.config.mts', 'modern');
const legacy = variant('vite.legacy.config.mts', 'legacy');
as108(modern, 'modern108');
as108(legacy, 'legacy108');

const MIME = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json', png: 'image/png', webp: 'image/webp', svg: 'image/svg+xml', woff2: 'font/woff2', woff: 'font/woff', jpg: 'image/jpeg', mp4: 'video/mp4' };
http
  .createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (rel === '' || rel.endsWith('/')) rel += 'index.html';
    const file = path.normalize(path.join(out, rel));
    if (!file.startsWith(out) || !existsSync(file) || statSync(file).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).slice(1)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(readFileSync(file));
  })
  .listen(port, '127.0.0.1', () => console.log(`legacy preview: http://localhost:${port}/{modern,modern108,legacy,legacy108}/index.html`));
