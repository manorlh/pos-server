/**
 * The Windows 7 build's screens under Chromium 108 — Electron 22's own renderer, hidden windows, a throw-away profile
 * (never the app's data folder, never the packed app):
 *
 *   node scripts/win7-render-check.cjs --run      (copies itself into a temp app folder and starts Electron 22 on it,
 *                                                waits, prints the result; Electron 22's default app does not run .cjs)
 *
 * Every page of legacy/dist/renderer (the shell, print, the customer display, the bridge) and the one app bundle
 * (legacy/dist/app-bundle) is loaded over a stream protocol, as the app serves them. A page passes when its scripts
 * parse and run without a SyntaxError / TypeError / ReferenceError of something Chromium 108 lacks, and it renders
 * something. Errors of the missing preload bridges (`window.kiosk`, `window.r2m`, no host) are expected here and
 * reported apart. Prints one JSON line; exit code 0 only when no page failed.
 */

if (typeof process.versions.electron !== 'string') {
  // Under plain Node: launch Electron 22 on a copy of this file (an app folder with a package.json).
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const kiosk = path.resolve(__dirname, '..');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r2m-win7-render-app-'));
  fs.copyFileSync(__filename, path.join(dir, 'main.js'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'r2m-win7-render-check', main: 'main.js' }));
  const out = path.join(dir, 'result.json');
  const exe = path.join(kiosk, 'legacy', 'node_modules', 'electron', 'dist', 'electron.exe');
  const r = spawnSync(exe, [dir, '--dist', path.join(kiosk, 'legacy', 'dist'), '--out', out], { stdio: 'ignore', timeout: 180_000, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'ELECTRON_RUN_AS_NODE')) });
  const line = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : JSON.stringify({ ok: false, error: `no result (exit ${r.status}, ${r.error ? r.error.message : ''})` });
  console.log(line.trim());
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(JSON.parse(line).ok ? 0 : 1);
}

const { app, BrowserWindow, protocol } = require('electron');
const { createReadStream, existsSync, mkdtempSync, statSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const argOf = (name) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
};
const distRoot = path.resolve(argOf('dist') || path.join(__dirname, '..', 'legacy', 'dist'));
const outFile = argOf('out') || process.env.R2M_CHECK_OUT;
process.on('uncaughtException', (e) => {
  if (outFile) require('node:fs').writeFileSync(outFile, JSON.stringify({ ok: false, error: String((e && e.stack) || e) }));
  process.exit(1);
});
app.setPath('userData', mkdtempSync(path.join(os.tmpdir(), 'r2m-win7-render-')));
app.disableHardwareAcceleration();
// One hidden window at a time: closing it must not end the check.
app.on('window-all-closed', () => undefined);

const MIME = { html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', json: 'application/json', png: 'image/png', svg: 'image/svg+xml', woff: 'font/woff', woff2: 'font/woff2', webp: 'image/webp' };
protocol.registerSchemesAsPrivileged([{ scheme: 'chk', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);

/** Errors a page shows only because this check gives it no preload bridge / host. */
const BRIDGE = /kiosk|r2m|bridge|preload|ipcRenderer|host|contextBridge|shell|electron|Cannot read properties of undefined|is not a function|null/i;
/** Errors that mean Chromium 108 cannot run the code. */
const FLOOR = /SyntaxError|Unexpected token|Invalid regular expression|is not defined|toSorted|toReversed|toSpliced|groupBy|withResolvers|fromAsync|isWellFormed|canParse|AbortSignal\.any/;

const PAGES = [
  ['renderer', 'index.html'],
  ['renderer', 'print.html'],
  ['renderer', 'display.html'],
  ['renderer', 'bridge.html'],
  ['app-bundle', 'index.html'],
];

async function check(dir, page) {
  const win = new BrowserWindow({ show: false, width: 1280, height: 800, webPreferences: { sandbox: true, contextIsolation: true } });
  const messages = [];
  win.webContents.on('console-message', (_e, level, message) => {
    if (level >= 2) messages.push(message);
  });
  let loadError = null;
  win.webContents.on('did-fail-load', (_e, code, desc) => {
    loadError = `${code} ${desc}`;
  });
  try {
    await win.loadURL(`chk://${dir}/${page}`);
  } catch (e) {
    loadError = loadError || String(e && e.message);
  }
  await new Promise((r) => setTimeout(r, 2500));
  const rendered = await win.webContents.executeJavaScript('document.body ? document.body.innerText.length + document.body.querySelectorAll("*").length : 0').catch(() => -1);
  const ua = await win.webContents.executeJavaScript('navigator.userAgent').catch(() => '');
  win.destroy();
  const floor = messages.filter((m) => FLOOR.test(m) && !/kiosk is not defined|r2m is not defined/.test(m));
  const bridge = messages.filter((m) => !floor.includes(m) && BRIDGE.test(m));
  const other = messages.filter((m) => !floor.includes(m) && !bridge.includes(m));
  return { page: `${dir}/${page}`, ok: !loadError && floor.length === 0, rendered, loadError, floor, bridgeOnly: bridge.length, other, chrome: (/Chrome\/([\d.]+)/.exec(ua) || [])[1] || null };
}

app.whenReady().then(async () => {
  protocol.registerStreamProtocol('chk', (request, callback) => {
    const url = new URL(request.url);
    const file = path.normalize(path.join(distRoot, url.host, decodeURIComponent(url.pathname)));
    if (!file.startsWith(distRoot) || !existsSync(file) || statSync(file).isDirectory()) {
      callback({ statusCode: 404, headers: { 'Content-Type': 'text/plain' }, data: require('node:stream').Readable.from([Buffer.from('not found')]) });
      return;
    }
    const ext = path.extname(file).slice(1).toLowerCase();
    callback({ statusCode: 200, headers: { 'Content-Type': MIME[ext] || 'application/octet-stream' }, data: createReadStream(file) });
  });
  const results = [];
  for (const [dir, page] of PAGES) {
    if (!existsSync(path.join(distRoot, dir, page))) continue;
    results.push(await check(dir, page));
  }
  // The memory of the shell's window and the till's view together (the app's layout: one window, the till over it),
  // idle on their first screens — a floor for the J1900 / 4 GB budget, not the busy till (that needs the real PC).
  const shellWin = new BrowserWindow({ show: false, width: 1366, height: 768, webPreferences: { sandbox: true, contextIsolation: true } });
  const tillWin = new BrowserWindow({ show: false, width: 1366, height: 768, webPreferences: { sandbox: true, contextIsolation: true } });
  await shellWin.loadURL('chk://renderer/index.html').catch(() => undefined);
  await tillWin.loadURL('chk://app-bundle/index.html').catch(() => undefined);
  await new Promise((r) => setTimeout(r, 4000));
  const metrics = app.getAppMetrics();
  const memory = {
    processes: metrics.map((m) => ({ type: m.type, workingSetMB: Math.round(m.memory.workingSetSize / 1024), privateMB: Math.round((m.memory.privateBytes || 0) / 1024) })),
    totalWorkingSetMB: Math.round(metrics.reduce((s, m) => s + m.memory.workingSetSize, 0) / 1024),
    totalPrivateMB: Math.round(metrics.reduce((s, m) => s + (m.memory.privateBytes || 0), 0) / 1024),
  };
  shellWin.destroy();
  tillWin.destroy();
  const ok = results.length > 0 && results.every((r) => r.ok);
  const line = JSON.stringify({ electron: process.versions.electron, chrome: process.versions.chrome, ok, results, memory });
  // A GUI process on Windows has no console: the line also goes to --out <file> (or R2M_CHECK_OUT).
  if (outFile) require('node:fs').writeFileSync(outFile, `${line}
`);
  console.log(line);
  app.exit(ok ? 0 : 1);
});
