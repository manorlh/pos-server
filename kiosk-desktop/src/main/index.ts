/**
 * R2M POS for Windows — the Electron shell. One app for every role the cloud gives this device
 * (kiosk, KDS, order status board; till and customer display come next — main/roles/types.ts):
 *
 *  - one full-screen window (no frame, no menu, no shortcuts out), started at login;
 *  - the local service layer (service.ts: pairing, auth, sync, media, printing, payment, logs,
 *    technician tools) and the updater (update/updater.ts), shared by every role;
 *  - the role manager (roles/manager.ts): which role, and its module (KDS / board feeds);
 *  - the screens and every media file served from disk through the `kiosk://` protocol
 *    (`kiosk://app/…` the bundle, `kiosk://media/<sha256>.<ext>` the media, with byte ranges for
 *    video) — the renderer never touches the network;
 *  - a hidden print window that draws receipts and bons on a canvas (Chromium's Hebrew shaping),
 *    handed back as pixels for the ESC/POS raster;
 *  - IPC: shared/bridge.ts (the kiosk, `window.kiosk`) and shared/roles.ts (the shell, `window.r2m`).
 */

import { app, BrowserWindow, ipcMain, net as enet, powerSaveBlocker, protocol, safeStorage, screen, shell } from 'electron';
import { spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { KioskService } from './service';
import type { PageRenderer } from './printer/printQueue';
import { UpdateManager } from './update/updater';
import { RoleManager } from './roles/manager';
import { APP_ID, DATA_DIR_NAME, SHELL_NAME } from './shell/identity';
import { BRIDGE_MARKER, shellModeOf } from './shell/mode';
import { startBridgeMode, type BridgeModeHandle } from './bridge/electron';
import { QUICKSUPPORT_PATHS } from '../core/technician';
import { parseWindow } from '../core/updatePolicy';
import type { PrintDoc } from '../core/printDocs';
import type { KdsActionInput } from '../shared/roles';

const isDev = process.argv.includes('--dev');
const windowedArg = process.argv.includes('--windowed') || isDev;
let windowed = windowedArg;

// The data folder is pinned (shell/identity.ts): the paired machine, its counters and Zs live there.
app.setPath('userData', path.join(app.getPath('appData'), DATA_DIR_NAME));
app.setAppUserModelId(APP_ID);

/** "גשר לדפדפן" (shell/mode.ts): a tray program for a browser kiosk / KDS / board on this PC. */
const shellMode = shellModeOf({
  argv: process.argv,
  markerExists: existsSync(path.join(app.getPath('userData'), BRIDGE_MARKER)),
  config: (() => {
    try {
      return JSON.parse(readFileSync(path.join(app.getPath('userData'), 'kiosk.json'), 'utf8')) as { mode?: unknown };
    } catch {
      return null;
    }
  })(),
});
let bridgeMode: BridgeModeHandle | null = null;

protocol.registerSchemesAsPrivileged([
  { scheme: 'kiosk', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

// Smooth: GPU raster, no throttling, autoplaying videos.
app.commandLine.appendSwitch('enable-gpu-rasterization');
app.commandLine.appendSwitch('ignore-gpu-blocklist');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');

if (!app.requestSingleInstanceLock()) app.quit();

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  img: 'application/octet-stream',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ico: 'image/x-icon',
};

function mimeOf(file: string): string {
  return MIME[path.extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream';
}

/** A file as a Response, honouring a byte range (video seeking). */
function fileResponse(file: string, request: Request, cache: string): Response {
  const size = statSync(file).size;
  const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') ?? '');
  const headers: Record<string, string> = { 'Content-Type': mimeOf(file), 'Accept-Ranges': 'bytes', 'Cache-Control': cache };
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || end < start) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    headers['Content-Length'] = String(end - start + 1);
    return new Response(Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream, { status: 206, headers });
  }
  headers['Content-Length'] = String(size);
  return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { status: 200, headers });
}

let service: KioskService | null = null;
let updater: UpdateManager | null = null;
let roles: RoleManager | null = null;
let main: BrowserWindow | null = null;
let printer: BrowserWindow | null = null;
let printerReady: Promise<void> | null = null;
let printSeq = 0;
const printWaiters = new Map<number, (r: { width: number; height: number; rgba: Uint8Array } | { error: string }) => void>();

function appVersion(): string {
  return app.getVersion();
}

/**
 * The installation's own file (optional): %APPDATA%\R2M Kiosk\kiosk.json —
 * { "windowed": false, "updateWindow": "02:00-05:00", "updateCheckMinutes": 15 }.
 * `updateWindow` is used when the cloud's assignment gives no install window.
 */
function installConfig(): { windowed?: boolean; updateWindow?: string; updateCheckMinutes?: number; bridgePort?: unknown; bridgeOrigins?: unknown } {
  try {
    return JSON.parse(readFileSync(path.join(app.getPath('userData'), 'kiosk.json'), 'utf8'));
  } catch {
    return {};
  }
}

function rendererDir(): string {
  return path.join(__dirname, '..', 'renderer');
}

function ensurePrinterWindow(): Promise<void> {
  if (printerReady && printer && !printer.isDestroyed()) return printerReady;
  printer = new BrowserWindow({
    show: false,
    width: 600,
    height: 800,
    webPreferences: { preload: path.join(__dirname, '..', 'preload', 'index.js'), offscreen: false, backgroundThrottling: false, contextIsolation: true, sandbox: true },
  });
  printerReady = printer.loadURL('kiosk://app/print.html');
  printer.on('closed', () => {
    printer = null;
    printerReady = null;
  });
  return printerReady;
}

const renderPage: PageRenderer = async (doc: PrintDoc, widthDots: number) => {
  await ensurePrinterWindow();
  const id = ++printSeq;
  const result = await new Promise<{ width: number; height: number; rgba: Uint8Array } | { error: string }>((resolve) => {
    const timer = setTimeout(() => {
      printWaiters.delete(id);
      resolve({ error: 'render timeout' });
    }, 15_000);
    printWaiters.set(id, (r) => {
      clearTimeout(timer);
      resolve(r);
    });
    printer!.webContents.send('print:render', { id, doc, widthDots });
  });
  if ('error' in result) throw new Error(result.error);
  return result;
};

function zoomFor(win: BrowserWindow): number {
  const local = service?.localSettings().zoom;
  if (local && local > 0.5 && local < 4) return local;
  // The layout is drawn for ~540 CSS px across a portrait kiosk (a 1080-wide screen at ×2),
  // ~960 across a landscape one; the zoom fills the screen at that size.
  const { width, height } = win.getContentBounds();
  const short = Math.min(width, height);
  return Math.max(1, Math.min(3, short / 540));
}

function createMain() {
  const display = screen.getPrimaryDisplay();
  main = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: windowed ? 540 : display.bounds.width,
    height: windowed ? 960 : display.bounds.height,
    kiosk: !windowed,
    fullscreen: !windowed,
    frame: windowed,
    autoHideMenuBar: true,
    backgroundColor: '#000000',
    title: SHELL_NAME,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
      devTools: isDev,
    },
  });
  main.removeMenu();
  main.once('ready-to-show', () => main?.show());
  main.webContents.on('did-finish-load', () => main?.webContents.setZoomFactor(zoomFor(main)));
  main.on('resize', () => main && main.webContents.setZoomFactor(zoomFor(main)));
  // No way out for a customer: no new windows, no navigation, no reload / devtools / zoom keys.
  main.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  main.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('kiosk://app/')) e.preventDefault();
  });
  main.webContents.on('before-input-event', (e, input) => {
    if (isDev) return;
    const k = input.key.toLowerCase();
    if ((input.control || input.meta) && ['r', 'w', 'q', 'n', 't', 'p', '+', '-', '=', '0', 'shift'].includes(k)) e.preventDefault();
    if (k === 'f5' || k === 'f11' || k === 'f12' || (input.alt && k === 'f4')) e.preventDefault();
  });
  main.webContents.on('render-process-gone', () => {
    // Never a dead screen: the screens come back at once from local data.
    setTimeout(() => main?.reload(), 500);
  });
  void main.loadURL('kiosk://app/index.html');
}

function bridge(svc: KioskService) {
  const send = (channel: string, payload: unknown) => {
    if (main && !main.isDestroyed()) main.webContents.send(channel, payload);
  };
  svc.on('view', (v) => send('kiosk:view', v));
  svc.on('pay', (p) => send('kiosk:pay', p));
  svc.on('toast', (t) => send('kiosk:toast', t));
  ipcMain.handle('kiosk:bootstrap', () => svc.view());
  ipcMain.handle('kiosk:pair', (_e, input) => svc.pair(input));
  ipcMain.on('kiosk:reportFlow', (_e, input) => svc.reportFlow(input));
  ipcMain.on('kiosk:funnel', (_e, events) => svc.funnelEvents(events));
  ipcMain.handle('kiosk:battery', (_e, reading) => svc.battery(reading));
  ipcMain.handle('kiosk:startPayment', (_e, input) => svc.startPayment(input));
  ipcMain.handle('kiosk:placeOpenOrder', (_e, input) => svc.placeOpenOrder(input));
  ipcMain.handle('kiosk:redeemVoucher', (_e, input) => svc.redeemVoucher(input));
  ipcMain.handle('kiosk:reverseVoucher', (_e, id: string) => svc.reverseVoucher(id));
  ipcMain.handle('kiosk:cancelPayment', () => svc.cancelPayment());
  ipcMain.handle('kiosk:receiptChoice', (_e, orderId: string, print: boolean) => svc.receiptChoice(orderId, print));
  ipcMain.handle('kiosk:helpRequest', () => svc.helpRequest());
  ipcMain.handle('kiosk:adminUnlock', (_e, pin: string) => svc.adminUnlock(pin));
  ipcMain.handle('kiosk:adminInfo', () => svc.adminInfo());
  ipcMain.handle('kiosk:adminAction', (_e, a) => svc.adminAction(a));
  ipcMain.handle('kiosk:technicianUnlock', (_e, code: string) => svc.technicianUnlock(code));
  ipcMain.handle('kiosk:technicianInfo', () => svc.technicianInfo());
  ipcMain.handle('kiosk:technicianAction', (_e, a) => svc.technicianAction(a));
  // The shell (shared/roles.ts): the role, the update status, the KDS and board screens.
  ipcMain.handle('shell:view', () => roles?.view());
  ipcMain.handle('shell:board', () => roles?.boardView());
  ipcMain.handle('shell:kds', () => roles?.kdsView());
  ipcMain.handle('shell:kdsAction', (_e, a: KdsActionInput) => roles?.kdsAction(a) ?? { ok: false });
  ipcMain.on('shell:activity', () => roles?.touch());
  // "הפעלה כגשר לדפדפן" on the pairing screen (an unpaired device only): the marker, then a restart in bridge mode.
  ipcMain.handle('shell:becomeBridge', () => {
    if (svc.paired) return { ok: false, message: 'המכשיר מצומד — אי אפשר להפוך אותו לגשר' };
    mkdirSync(app.getPath('userData'), { recursive: true });
    writeFileSync(path.join(app.getPath('userData'), BRIDGE_MARKER), 'bridge');
    setTimeout(() => {
      app.relaunch();
      app.exit(0);
    }, 200);
    return { ok: true };
  });
  ipcMain.on('print:result', (_e, r: { id: number; width?: number; height?: number; rgba?: Uint8Array; error?: string }) => {
    const w = printWaiters.get(r.id);
    if (!w) return;
    printWaiters.delete(r.id);
    if (r.error || !r.rgba || !r.width || !r.height) w({ error: r.error ?? 'empty page' });
    else w({ width: r.width, height: r.height, rgba: new Uint8Array(r.rgba) });
  });
}

/** `kiosk://media/<file>`: the kiosk's media (the app), or the linked kiosk's receipt logo (the bridge). */
let mediaFile: (name: string) => string | null = (name) => service?.media.resolveFile(name) ?? null;

function registerKioskProtocol() {
  protocol.handle('kiosk', (request) => {
    const url = new URL(request.url);
    if (url.host === 'media') {
      const file = mediaFile(decodeURIComponent(url.pathname.slice(1)));
      if (!file) return new Response('not found', { status: 404 });
      return fileResponse(file, request, 'public, max-age=31536000, immutable');
    }
    if (url.host === 'app') {
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.normalize(path.join(rendererDir(), rel));
      if (!file.startsWith(rendererDir()) || !existsSync(file)) return new Response('not found', { status: 404 });
      return fileResponse(file, request, 'no-cache');
    }
    return new Response('not found', { status: 404 });
  });
}

function deviceInfoOf(model: string): Record<string, string> {
  return {
    model,
    manufacturer: os.hostname(),
    platform: 'windows',
    serial: KioskService.deviceSerial(`${os.hostname()}|${os.userInfo().username}|${os.cpus()[0]?.model ?? ''}`),
    firmware_build: `${os.type()} ${os.release()}`,
  };
}

function secretBoxOf() {
  return safeStorage.isEncryptionAvailable()
    ? { seal: (s: string) => safeStorage.encryptString(s).toString('base64'), open: (s: string) => safeStorage.decryptString(Buffer.from(s, 'base64')) }
    : undefined;
}

void app.whenReady().then(async () => {
  const install = installConfig();
  if (shellMode === 'bridge') {
    // "גשר לדפדפן": no kiosk window — the tray, the local API, the hidden print window when printing.
    registerKioskProtocol();
    ipcMain.on('print:result', (_e, r: { id: number; width?: number; height?: number; rgba?: Uint8Array; error?: string }) => {
      const w = printWaiters.get(r.id);
      if (!w) return;
      printWaiters.delete(r.id);
      if (r.error || !r.rgba || !r.width || !r.height) w({ error: r.error ?? 'empty page' });
      else w({ width: r.width, height: r.height, rgba: new Uint8Array(r.rgba) });
    });
    bridgeMode = await startBridgeMode({
      appVersion: appVersion(),
      userData: app.getPath('userData'),
      rendererDir: rendererDir(),
      preload: path.join(__dirname, '..', 'preload', 'index.js'),
      renderPage,
      deviceInfo: deviceInfoOf('Windows bridge'),
      secretBox: secretBoxOf(),
      install,
      isDev,
      setMediaResolver: (fn) => {
        mediaFile = fn;
      },
      log: (m) => console.log(m),
    });
    return;
  }
  windowed = windowedArg || install.windowed === true;
  const dataDir = path.join(app.getPath('userData'), 'data');
  service = new KioskService({
    dataDir,
    appVersion: appVersion(),
    deviceInfo: deviceInfoOf('Windows kiosk'),
    secretBox: secretBoxOf(),
    renderer: renderPage,
    platform: {
      quit: () => app.quit(),
      networkUp: () => enet.isOnline(),
      interfaces: () =>
        Object.entries(os.networkInterfaces()).flatMap(([name, list]) => (list ?? []).filter((a) => a.family === 'IPv4' && !a.internal).map((a) => ({ name, address: a.address }))),
      launchQuickSupport: async () => {
        const exe = QUICKSUPPORT_PATHS.find((p) => existsSync(p));
        if (!exe) return null;
        const err = await shell.openPath(exe);
        return err ? null : exe;
      },
      setZoom: (z) => main?.webContents.setZoomFactor(z),
      checkUpdate: () => updater!.checkNow(),
      installUpdate: () => updater!.installNow(),
      updateStatus: () => updater!.view(),
    },
    log: (m) => console.log(`[kiosk] ${m}`),
  });
  const svc = service;
  updater = new UpdateManager({
    api: svc.api,
    kv: svc.kv,
    machineId: () => svc.machineId,
    token: () => svc.cloud.credentials()?.accessToken ?? null,
    currentVersion: appVersion(),
    dir: path.join(app.getPath('userData'), 'updates'),
    activity: () => roles?.activity() ?? svc.activity(),
    localWindow: parseWindow(install.updateWindow),
    checkEveryMs: Math.max(5, Number(install.updateCheckMinutes) || 15) * 60_000,
    runInstaller: (file, args) => {
      if (!existsSync(file)) throw new Error('קובץ ההתקנה חסר');
      spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', (e) => console.log(`[update] installer: ${e.message}`)).unref();
    },
    quit: () => app.quit(),
    log: (m) => console.log(`[update] ${m}`),
  });
  roles = new RoleManager(svc, () => updater!.view(), (m) => console.log(`[shell] ${m}`));
  updater.onChange(() => roles?.emitView());
  const sendShell = (channel: string, payload: unknown) => {
    if (main && !main.isDestroyed()) main.webContents.send(channel, payload);
  };
  roles.on('view', (v) => sendShell('shell:view', v));
  roles.on('board', (v) => sendShell('shell:board', v));
  roles.on('kds', (v) => sendShell('shell:kds', v));

  registerKioskProtocol();

  bridge(service);
  powerSaveBlocker.start('prevent-display-sleep');
  if (!isDev && app.isPackaged) app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
  createMain();
  await service.start();
  roles.start();
  // Development builds check only on "בדוק עכשיו"; an installed app on its own timer too.
  if (app.isPackaged && !isDev) updater.start();
  else void updater.confirmInstalled();
});

app.on('second-instance', () => {
  if (bridgeMode) {
    bridgeMode.show();
    return;
  }
  if (main) {
    if (main.isMinimized()) main.restore();
    main.focus();
  }
});

app.on('window-all-closed', () => {
  // The bridge lives in the tray: its window is hidden, never the end of the app.
  if (shellMode === 'bridge') return;
  updater?.stop();
  roles?.stop();
  service?.stop();
  app.quit();
});
