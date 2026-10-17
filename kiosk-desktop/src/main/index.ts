/**
 * R2M POS for Windows — the Electron shell. One app for every role the cloud gives this device
 * (kiosk, KDS, order status board; till and customer display come next — main/roles/types.ts):
 *
 *  - one full-screen window (no frame, no menu, no shortcuts out), started at login; a manager's
 *    code (DESKTOP_EXIT) takes it out to the Windows desktop and the tray / "חזרה לקיוסק" brings it
 *    back (shell/desktopMode.ts, core/desktopExit.ts);
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

import { windowsDisplayReport } from './displayReport';
import { app, BrowserWindow, ipcMain, Menu, nativeImage, net as enet, powerMonitor, powerSaveBlocker, protocol, safeStorage, screen, shell, Tray, utilityProcess } from 'electron';
import { attachCustomerDisplay } from './shell/customerDisplayWindow';
import { execFile, spawn } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { handleScheme, textReply, type SchemeReply, type SchemeRequest } from './shell/schemeHandler';
import { APP_BUILD } from './appBuild';
import { nativeImageVariantMaker } from './media/nativeVariant';
import { gpuDecision, gpuSettingOf, recentGpuCrashes, updatePlatformOf } from '../core/appBuild';
import { KioskService } from './service';
import type { PageRenderer } from './printer/printQueue';
import { UpdateManager } from './update/updater';
import { RoleManager } from './roles/manager';
import { RollingLog } from './deviceLog';
import { createWorkMode, type WorkModeRuntime } from './workMode';
import { liteHintOf, windowsTillCaps, TillRole } from './roles/till';
import { KioskCoreTillEngine } from './till/engine';
import { APP_SCHEME, attachTillRole, type TillElectron } from './roles/tillElectron';
import { APP_ID, DATA_DIR_NAME, SHELL_NAME } from './shell/identity';
import { BRIDGE_MARKER, shellModeOf } from './shell/mode';
import { startBridgeMode, type BridgeModeHandle } from './bridge/electron';
import { QUICKSUPPORT_PATHS } from '../core/technician';
import { shellAutoZoom } from '../core/windowZoom';
import { IDLE_RETURN_MINUTES } from '../core/desktopExit';
import { DesktopMode } from './shell/desktopMode';
import { parseWindow } from '../core/updatePolicy';
import type { PrintDoc } from '../core/printDocs';
import type { KdsActionInput } from '../shared/roles';
import type { CashStaffAction } from '../shared/cash';
import { cashmagLocalOf } from './kiosk/cashmagPay';
import type { WorkerLink } from './cash/paylinkDevice';
import type { WorkerReply } from './cash/paylinkCore';

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
  // The till role's screens (roles/tillElectron.ts): the one app bundle, verified, at r2m://app/.
  APP_SCHEME,
]);

// Smooth: GPU raster, no throttling, autoplaying videos. The Windows 7 build leaves the GPU to Chromium's blocklist
// (a J1900's old drivers → software compositing) and turns it off after GPU crashes (core/appBuild.ts `gpuDecision`).
const gpuCrashFile = path.join(app.getPath('userData'), 'gpu-crashes.json');
const gpuCrashes = (() => {
  try {
    return recentGpuCrashes(JSON.parse(readFileSync(gpuCrashFile, 'utf8')), Date.now());
  } catch {
    return [];
  }
})();
const gpu = gpuDecision({ build: APP_BUILD, setting: gpuSettingOf(installConfig().hardwareAcceleration), recentCrashes: gpuCrashes.length });
if (gpu.disable) app.disableHardwareAcceleration();
for (const sw of gpu.switches) app.commandLine.appendSwitch(sw);
if (APP_BUILD !== 'standard') console.log(`[shell] build ${APP_BUILD} on ${os.release()}: gpu ${gpu.disable ? 'off' : 'on'} (${gpu.reason})`);
app.on('child-process-gone', (_e, d) => {
  if (d.type !== 'GPU' || d.reason === 'clean-exit') return;
  try {
    writeFileSync(gpuCrashFile, JSON.stringify([...recentGpuCrashes(gpuCrashes, Date.now()), Date.now()]));
  } catch {
    /* a read-only profile: the next start just does not know */
  }
});
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

/** A file as the scheme's reply, honouring a byte range (video seeking). */
function fileResponse(file: string, request: SchemeRequest, cache: string): SchemeReply {
  const size = statSync(file).size;
  const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get('range') ?? '');
  const headers: Record<string, string> = { 'Content-Type': mimeOf(file), 'Accept-Ranges': 'bytes', 'Cache-Control': cache };
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size || end < start) return { status: 416, headers: { 'Content-Range': `bytes */${size}` }, body: null };
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    headers['Content-Length'] = String(end - start + 1);
    return { status: 206, headers, body: createReadStream(file, { start, end }) };
  }
  headers['Content-Length'] = String(size);
  return { status: 200, headers, body: createReadStream(file) };
}

let service: KioskService | null = null;
let updater: UpdateManager | null = null;
let roles: RoleManager | null = null;
/** "מצב עבודה: קיוסק / קופה" (workMode.ts): the switch between the kiosk and the till, built after the role manager. */
let workMode: WorkModeRuntime | null = null;
/** The till role (roles/till.ts): a preview over the mock engine until the bundled engine (P2). */
let tillRole: TillRole | null = null;
let tillView: TillElectron | null = null;
let tillEngine: KioskCoreTillEngine | null = null;
let main: BrowserWindow | null = null;
let customerDisplay: { stop(): void } | null = null;
let printer: BrowserWindow | null = null;
let printerReady: Promise<void> | null = null;
let printSeq = 0;
/** "יציאה לשולחן העבודה" (shell/desktopMode.ts): the window out of full screen and the ways back. */
let desktop: DesktopMode | null = null;
let returnTray: Tray | null = null;
/** The Windows 7 build's tray, always there (Windows 7 users never find a minimised kiosk window): back / technician. */
let appTray: Tray | null = null;
/** The shell's menu / technician's screen from a key or the tray (set once the till's glue is up). */
let openShellScreen: ((screen: 'admin' | 'technician') => void) | null = null;
let shuttingDown = false;
/**
 * Windows 10/11's own touch keyboard set to come up in desktop mode (TabletTip 1.7, EnableDesktopModeAutoInvoke = 1):
 * then "מקלדת מסך" on `auto` stays down — never two keyboards. Read once at start; Windows 7 has no such thing.
 */
let systemTouchKeyboard = false;
function readSystemTouchKeyboard() {
  if (process.platform !== 'win32' || (Number(os.release().split('.')[0]) || 0) < 10) return;
  execFile('reg', ['query', String.raw`HKCU\Software\Microsoft\TabletTip\1.7`, '/v', 'EnableDesktopModeAutoInvoke'], { windowsHide: true, timeout: 5_000 }, (err, out) => {
    systemTouchKeyboard = !err && /EnableDesktopModeAutoInvoke\s+REG_DWORD\s+0x0*1\s*$/im.test(String(out));
    if (systemTouchKeyboard) console.log('[shell] Windows touch keyboard comes up by itself — "מקלדת מסך" auto stays down');
  });
}
/** "מקלדת מסך" as the pages get it: the technician's choice; `auto` gives way to Windows' own auto keyboard. */
function oskModeNow(): 'auto' | 'always' | 'off' {
  const mode = service?.oskMode() ?? 'auto';
  return mode === 'auto' && systemTouchKeyboard ? 'off' : mode;
}
/** The desktop shortcut "חזרה לקיוסק" launches the app with this; the running one takes it (second-instance). */
const RETURN_ARG = '--return-to-kiosk';
const printWaiters = new Map<number, (r: { width: number; height: number; rgba: Uint8Array } | { error: string }) => void>();

function appVersion(): string {
  return app.getVersion();
}

/**
 * The installation's own file (optional): %APPDATA%\R2M Kiosk\kiosk.json —
 * { "windowed": false, "updateWindow": "02:00-05:00", "updateCheckMinutes": 15 }.
 * `updateWindow` is used when the cloud's assignment gives no install window.
 */
function installConfig(): {
  windowed?: boolean;
  updateWindow?: string;
  updateCheckMinutes?: number;
  bridgePort?: unknown;
  bridgeOrigins?: unknown;
  /**
   * Back from the desktop by itself after this many idle minutes (0 = never) — only when the
   * cloud's setting "חזרה אוטומטית לקיוסק" (`desktopIdleReturnMinutes`) has not reached the device.
   */
  desktopIdleReturnMinutes?: number;
  /** "שרת מזומן": the LAN API's port (default 47630, core/cash/lanProtocol.ts). */
  cashPort?: number;
  /** "auto" (default) / "on" / "off" — off = software rendering (core/appBuild.ts `gpuDecision`; old PCs, Windows 7). */
  hardwareAcceleration?: unknown;
  /**
   * CashMag (P:/specs/cashmag-windows.md §2): this kiosk's own server address / name / user code over the cloud's,
   * and function names — { "cashmag": { "host": "192.168.1.40", "port": 65000, "terminal": "קיוסק 1" } }.
   */
  cashmag?: unknown;
} {
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

/** The window's automatic zoom: ~540 CSS px across a portrait kiosk, the landscape rule (core/windowZoom.ts). */
function autoZoomFor(win: BrowserWindow): number {
  const { width, height } = win.getContentBounds();
  // The till (and the whole Windows 7 build) at 100%, as the Android tablet; the kiosk its ~540-px design.
  return shellAutoZoom({ build: APP_BUILD, role: roles?.role() ?? null, width, height });
}

/**
 * The window's page zoom — the kiosk's and the till's (one window): the automatic one × "גודל תצוגה" (the
 * technician's preview or saved local choice, else an old "זום", else the cloud's `displayScale` —
 * KioskService.windowZoom, core/displayScale.ts).
 */
function zoomFor(win: BrowserWindow): number {
  const auto = autoZoomFor(win);
  return service ? service.windowZoom(auto) : auto;
}

/** The zoom again — only when it changed (a preview, a save, the cloud's value on a sync, a resize). */
function applyZoom() {
  if (!main || main.isDestroyed()) return;
  const z = zoomFor(main);
  if (Math.abs(main.webContents.getZoomFactor() - z) > 1e-6) main.webContents.setZoomFactor(z);
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
  main.on('resize', () => applyZoom());
  // Out on the desktop, the taskbar button brings the kiosk back — in full screen.
  main.on('restore', () => {
    desktop?.onWindowRestored();
    tillView?.refit();
  });
  // No way out for a customer: no new windows, no navigation, no reload / devtools / zoom keys.
  main.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  main.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('kiosk://app/')) e.preventDefault();
  });
  main.webContents.on('before-input-event', (e, input) => {
    if (guardKey(input)) e.preventDefault();
  });
  // The window back up (the taskbar, the desktop): the till's view fitted and focused again.
  main.on('show', () => tillView?.refit());
  // The kiosk's window gone (the taskbar's "close", Alt+F4 where it slipped through): the app ends — never a process
  // left running behind the hidden print window with no window to come back to.
  main.on('closed', () => {
    main = null;
    if (shellMode !== 'bridge') shutdown();
  });
  main.webContents.on('render-process-gone', () => {
    // Never a dead screen: the screens come back at once from local data.
    setTimeout(() => main?.reload(), 500);
  });
  void main.loadURL('kiosk://app/index.html');
}

/**
 * Keys on the app's pages (the kiosk's window and the till's view alike): no reload / devtools / zoom / Alt+F4 for a
 * customer, and the support keys — Ctrl+Alt+Shift+T or Q: the technician's code and screen; Ctrl+Alt+Shift+M: the
 * manager's menu. True when the key was taken.
 */
function guardKey(input: { type?: string; key: string; control: boolean; meta: boolean; alt: boolean; shift: boolean }): boolean {
  const k = input.key.toLowerCase();
  if (input.control && input.alt && input.shift && (k === 't' || k === 'q' || k === 'm')) {
    if (input.type === undefined || input.type === 'keyDown') {
      console.log(`[shell] support key Ctrl+Alt+Shift+${k.toUpperCase()}`);
      bringBack();
      openShellScreen?.(k === 'm' ? 'admin' : 'technician');
    }
    return true;
  }
  if (isDev) return false;
  if ((input.control || input.meta) && ['r', 'w', 'q', 'n', 't', 'p', '+', '-', '=', '0', 'shift'].includes(k)) return true;
  return k === 'f5' || k === 'f11' || k === 'f12' || (input.alt && k === 'f4');
}

/** The window up and in front (from the desktop, a second launch, the tray), the till's view fitted again. */
function bringBack(via: 'tray' | 'relaunch' | 'shortcut' = 'tray') {
  if (desktop?.active) desktop.back(via);
  else if (main && !main.isDestroyed()) {
    if (main.isMinimized()) main.restore();
    main.show();
    main.focus();
  }
  tillView?.refit();
}

/** The Windows 7 build's own tray: "חזרה לקופה", "מסך טכנאי", "יציאה מהתוכנה" (in the technician's screen, by code). */
function showAppTray() {
  if (appTray || process.platform !== 'win32') return;
  const file = path.join(rendererDir(), 'tray.png');
  const icon = existsSync(file) ? nativeImage.createFromPath(file).resize({ width: 16, height: 16 }) : nativeImage.createEmpty();
  appTray = new Tray(icon);
  appTray.setToolTip(`${SHELL_NAME} · קופה`);
  appTray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'חזרה לקופה', click: () => bringBack('tray') },
      { label: 'מסך טכנאי (קוד טכנאי)', click: () => (bringBack('tray'), openShellScreen?.('technician')) },
      { label: 'יציאה מהתוכנה (במסך הטכנאי)', click: () => (bringBack('tray'), openShellScreen?.('technician')) },
    ]),
  );
  appTray.on('click', () => bringBack('tray'));
  appTray.on('double-click', () => bringBack('tray'));
}

/** Everything stopped once, then the app ends (the last window closed, or the kiosk's window closed while others stay). */
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  desktop?.stop();
  hideReturnTray();
  appTray?.destroy();
  appTray = null;
  updater?.stop();
  tillView?.stop();
  customerDisplay?.stop();
  tillEngine?.stop();
  workMode?.stop();
  roles?.stop();
  service?.stop();
  app.quit();
}

/** "חזרה לקיוסק" next to the clock while the kiosk is out on the desktop. */
function showReturnTray(onReturn: () => void) {
  if (returnTray) return;
  if (appTray) {
    // The Windows 7 build's tray is already there: it says where the way back is.
    appTray.displayBalloon({ title: SHELL_NAME, content: 'הקופה ממוזערת. חזרה: האייקון כאן (חזרה לקופה), או הפעלת התוכנה שוב.', iconType: 'info' });
    return;
  }
  const file = path.join(rendererDir(), 'tray.png');
  const icon = existsSync(file) ? nativeImage.createFromPath(file).resize({ width: 16, height: 16 }) : nativeImage.createEmpty();
  returnTray = new Tray(icon);
  returnTray.setToolTip(`${SHELL_NAME} · חזרה לקיוסק`);
  returnTray.setContextMenu(Menu.buildFromTemplate([{ label: 'חזרה לקיוסק', click: onReturn }]));
  returnTray.on('click', onReturn);
  returnTray.on('double-click', onReturn);
  // Windows 11 tucks new tray icons away: say where the way back is.
  returnTray.displayBalloon({ title: SHELL_NAME, content: 'הקיוסק ממוזער. חזרה: האייקון כאן, "חזרה לקיוסק" בשולחן העבודה, או הכפתור בשורת המשימות.', iconType: 'info' });
}

function hideReturnTray() {
  returnTray?.destroy();
  returnTray = null;
}

/** The desktop shortcut "חזרה לקיוסק" (an installed app only): created once, kept. */
function ensureReturnShortcut() {
  if (process.platform !== 'win32' || !app.isPackaged) return;
  const file = path.join(app.getPath('desktop'), 'חזרה לקיוסק.lnk');
  if (existsSync(file)) return;
  shell.writeShortcutLink(file, 'create', { target: process.execPath, args: RETURN_ARG, description: `${SHELL_NAME} — חזרה למסך המלא`, icon: process.execPath, iconIndex: 0 });
}

function bridge(svc: KioskService) {
  const send = (channel: string, payload: unknown) => {
    if (main && !main.isDestroyed()) main.webContents.send(channel, payload);
  };
  svc.on('view', (v) => {
    send('kiosk:view', v);
    // "גודל תצוגה": the cloud's `displayScale` may have come with a sync.
    applyZoom();
  });
  svc.on('pay', (p) => send('kiosk:pay', p));
  svc.on('toast', (t) => send('kiosk:toast', t));
  ipcMain.handle('kiosk:bootstrap', () => svc.view());
  ipcMain.handle('kiosk:pair', (_e, input) => svc.pair(input));
  ipcMain.handle('kiosk:pairingScreen', (_e, a) => svc.pairingScreen(a ?? { type: 'view' }));
  ipcMain.on('kiosk:reportFlow', (_e, input) => svc.reportFlow(input));
  ipcMain.on('kiosk:funnel', (_e, events) => svc.funnelEvents(events));
  ipcMain.handle('kiosk:battery', (_e, reading) => svc.battery(reading));
  ipcMain.handle('kiosk:startPayment', (_e, input) => svc.startPayment(input));
  ipcMain.handle('kiosk:placeOpenOrder', (_e, input) => svc.placeOpenOrder(input));
  ipcMain.handle('kiosk:redeemVoucher', (_e, input) => svc.redeemVoucher(input));
  ipcMain.handle('kiosk:reverseVoucher', (_e, id: string) => svc.reverseVoucher(id));
  ipcMain.handle('kiosk:releaseDiscounts', (_e, vouchers: Array<{ reservationId: string }>) => svc.releaseDiscounts(vouchers));
  ipcMain.handle('kiosk:cancelPayment', () => svc.cancelPayment());
  ipcMain.handle('kiosk:cashOwedChoice', (_e, choice: unknown) => svc.cashOwedChoice(choice));
  ipcMain.handle('kiosk:cashSplit', () => svc.cashSplit());
  ipcMain.handle('kiosk:cashQuestion', (_e, confirm: unknown) => svc.cashQuestion(confirm));
  ipcMain.handle('kiosk:redeemCashCredit', (_e, input: unknown) => svc.redeemCashCredit(input));
  ipcMain.handle('kiosk:releaseCashCredit', (_e, id: unknown) => svc.releaseCashCredit(typeof id === 'string' ? id : ''));
  ipcMain.handle('kiosk:receiptChoice', (_e, orderId: string, print: boolean) => svc.receiptChoice(orderId, print));
  ipcMain.handle('kiosk:helpRequest', () => svc.helpRequest());
  ipcMain.handle('kiosk:adminUnlock', (_e, pin: string) => svc.adminUnlock(pin));
  ipcMain.handle('kiosk:adminInfo', () => svc.adminInfo());
  ipcMain.handle('kiosk:adminAction', (_e, a) => svc.adminAction(a));
  ipcMain.handle('kiosk:adminHistory', (_e, input) => svc.adminHistory(input));
  ipcMain.handle('kiosk:technicianUnlock', (_e, code: string) => svc.technicianUnlock(code));
  ipcMain.handle('kiosk:technicianInfo', () => svc.technicianInfo());
  // "מקלדת מסך" on the shell's screens — never on the kiosk's (it draws its own keyboard for the customer).
  ipcMain.handle('kiosk:oskMode', () => (roles?.role() === 'kiosk' ? 'off' : oskModeNow()));
  readSystemTouchKeyboard();
  ipcMain.handle('kiosk:technicianAction', (_e, a) => svc.technicianAction(a));
  ipcMain.handle('kiosk:shopLockCloseDay', (_e, pin: unknown) => svc.shopLockCloseDay(typeof pin === 'string' ? pin.slice(0, 12) : ''));
  // The shell (shared/roles.ts): the role, the update status, the KDS and board screens.
  ipcMain.handle('shell:view', () => roles?.view());
  ipcMain.handle('shell:board', () => roles?.boardView());
  ipcMain.handle('shell:kds', () => roles?.kdsView());
  ipcMain.handle('shell:kdsAction', (_e, a: KdsActionInput) => roles?.kdsAction(a) ?? { ok: false });
  ipcMain.on('shell:activity', () => roles?.touch());
  // The manager's menu opened from the till's corner is closed: the till's view comes back over the window.
  ipcMain.on('shell:adminClosed', () => tillView?.resume());
  // "שרת מזומן": the staff screen (shared/cash.ts) — its view, a manager's code, an action.
  ipcMain.handle('shell:cash', () => roles?.cashView() ?? null);
  ipcMain.handle('shell:cashUnlock', (_e, pin: unknown) => roles?.cashUnlock(typeof pin === 'string' ? pin.slice(0, 12) : '') ?? { ok: false });
  ipcMain.handle('shell:cashAction', (_e, a: CashStaffAction) => roles?.cashAction(a) ?? { ok: false, message: 'אין שרת מזומן' });
  // "יציאה לשולחן העבודה": the PIN and the rules in the service (core/desktopExit.ts), the window in shell/desktopMode.ts.
  ipcMain.handle('shell:desktopExit', (_e, pin: unknown) => svc.desktopExit(typeof pin === 'string' ? pin : '', roles?.activity() ?? svc.activity()));
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
  // `protocol.handle` on Electron 44; Electron 22 (the Windows 7 build) has only stream protocols (shell/schemeHandler.ts).
  handleScheme(protocol, 'kiosk', (request) => {
    const url = new URL(request.url);
    if (url.host === 'media') {
      const file = mediaFile(decodeURIComponent(url.pathname.slice(1)));
      if (!file) return textReply(404, 'not found');
      return fileResponse(file, request, 'public, max-age=31536000, immutable');
    }
    if (url.host === 'app') {
      const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
      const file = path.normalize(path.join(rendererDir(), rel));
      if (!file.startsWith(rendererDir()) || !existsSync(file)) return textReply(404, 'not found');
      return fileResponse(file, request, 'no-cache');
    }
    return textReply(404, 'not found');
  }, (m) => console.log(`[shell] ${m}`));
}

/** One PayLink unit's utility process (the vendor's DLL never loads in the main process). */
function paylinkWorker(): WorkerLink {
  // utilityProcess came in Electron 22 (the Windows 7 build's line); guarded so an older/odd runtime fails here, not at start.
  if (typeof utilityProcess?.fork !== 'function') throw new Error('utilityProcess is missing in this Electron — PayLink needs it');
  const child = utilityProcess.fork(path.join(__dirname, 'paylinkWorker.js'), [], { serviceName: 'R2M PayLink', stdio: 'ignore' });
  return {
    post: (msg) => child.postMessage(msg),
    onMessage: (fn) => child.on('message', (m: WorkerReply) => fn(m)),
    onExit: (fn) => child.on('exit', (code) => fn(code)),
    kill: () => void child.kill(),
  };
}

function deviceInfoOf(model: string): Record<string, string> {
  return {
    model,
    manufacturer: os.hostname(),
    platform: 'windows',
    // "win7": the Windows 7 build — the cloud lets it pair only as a till and sends it `windows7` releases.
    ...(APP_BUILD === 'win7' ? { appBuild: 'win7' } : {}),
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
  // "חזרה אוטומטית לקיוסק": the cloud's setting, read on every look; kiosk.json only when the cloud sent none.
  const idleMinutes = () => service?.desktopIdleReturnMinutes(install.desktopIdleReturnMinutes) ?? IDLE_RETURN_MINUTES;
  desktop = new DesktopMode(
    {
      window: () => main,
      windowed: () => windowed,
      showTray: showReturnTray,
      hideTray: hideReturnTray,
      ensureShortcut: ensureReturnShortcut,
      systemIdleSec: () => powerMonitor.getSystemIdleTime(),
      returned: (via) => service?.desktopReturned(via),
      wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      log: (m) => console.log(`[shell] ${m}`),
    },
    idleMinutes,
  );
  const dataDir = path.join(app.getPath('userData'), 'data');
  // The app's rolling log on the disk ("בקש לוגים", P:/specs/device-logs-api.md): every console line, 4 × 1 MB.
  const rollingLog = new RollingLog(path.join(app.getPath('userData'), 'logs'));
  rollingLog.install();
  service = new KioskService({
    // "שיתאים את עצמו": the primary display, for the dashboard (displayReport.ts).
    displayInfo: () => {
      const d = screen.getPrimaryDisplay();
      return windowsDisplayReport(d.size.width, d.size.height, d.scaleFactor);
    },
    dataDir,
    appVersion: appVersion(),
    deviceInfo: deviceInfoOf('Windows kiosk'),
    // The Windows 7 build has no sharp: picture variants through Electron's nativeImage (media/nativeVariant.ts).
    ...(APP_BUILD === 'win7' ? { variantMaker: nativeImageVariantMaker(nativeImage) } : {}),
    secretBox: secretBoxOf(),
    // "שלח לוגים לתמיכה" / "יומן אפליקציה" on the technician's screen.
    logs: rollingLog,
    renderer: renderPage,
    // "מזומן" at a CashMag machine: kiosk.json `cashmag` over the cloud's (never synced).
    cashmagLocal: cashmagLocalOf(install.cashmag),
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
      quickSupportPath: () => QUICKSUPPORT_PATHS.find((p) => existsSync(p)) ?? null,
      // "הפעלה מחדש של האפליקציה" (the technician's screen).
      restartApp: () => {
        app.relaunch();
        app.exit(0);
      },
      // "הפעלה אוטומטית": the login item the packaged app sets at every start (below); a dev build has none.
      autostart: () => (app.isPackaged && !isDev ? { enabled: app.getLoginItemSettings({ path: process.execPath }).openAtLogin } : null),
      setAutostart: (on) => {
        if (app.isPackaged && !isDev) app.setLoginItemSettings({ openAtLogin: on, path: process.execPath });
      },
      autoZoom: () => (main && !main.isDestroyed() ? autoZoomFor(main) : 1),
      refreshZoom: () => applyZoom(),
      checkUpdate: () => updater!.checkNow(),
      installUpdate: () => updater!.installNow(),
      updateStatus: () => updater!.view(),
      exitToDesktop: () => desktop!.exit(),
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
    // Out on the desktop: an automatic install waits for the way back (core/updatePolicy.ts).
    // The till: busy / at rest as its screens say (never an install mid-sale).
    activity: () => ({ ...(roles?.activity() ?? svc.activity()), ...(tillRole && roles?.role() === 'till' ? tillRole.activity() : {}), desktop: desktop?.active === true }),
    localWindow: parseWindow(install.updateWindow),
    checkEveryMs: Math.max(5, Number(install.updateCheckMinutes) || 15) * 60_000,
    runInstaller: (file, args) => {
      if (!existsSync(file)) throw new Error('קובץ ההתקנה חסר');
      spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', (e) => console.log(`[update] installer: ${e.message}`)).unref();
    },
    quit: () => app.quit(),
    // The Windows 7 build asks for `windows7` releases (never an Electron 44 installer) — `windows` once the PC runs Windows 10+.
    platform: updatePlatformOf(APP_BUILD, os.release()),
    log: (m) => console.log(`[update] ${m}`),
  });
  roles = new RoleManager(svc, () => updater!.view(), (m) => console.log(`[shell] ${m}`), {
    // "שרת מזומן": the vendor's DLL in a utility process per PayLink unit (main/cash/paylinkWorker.ts).
    spawnWorker: paylinkWorker,
    port: typeof install.cashPort === 'number' ? install.cashPort : undefined,
    // "שליטה מרחוק" (P:/specs/cash-paylink.md §11.15ד): a restart and a logs request from the dashboard.
    logs: rollingLog,
    restartApp: () => {
      app.relaunch();
      app.exit(0);
    },
  });
  updater.onChange(() => roles?.emitView());
  const sendShell = (channel: string, payload: unknown) => {
    if (main && !main.isDestroyed()) main.webContents.send(channel, payload);
  };
  roles.on('view', (v) => sendShell('shell:view', v));
  roles.on('board', (v) => sendShell('shell:board', v));
  roles.on('kds', (v) => sendShell('shell:kds', v));
  roles.on('cash', (v) => sendShell('shell:cash', v));
  // work mode: its changes reach the screens through the service's view (the role follows), the shell's view carries what the till shows of it.
  workMode = createWorkMode(svc, (m) => console.log(`[shell] ${m}`));
  workMode.onChange(() => roles?.emitView());

  // The till role: the same app and installer — the cloud's role decides (a till by role, or a kiosk working as a
  // till). The screens are the one app bundle; the engine behind them is the kiosk core (main/till/engine.ts):
  // the same ledger, numbering, terminals, printer and Z the kiosk already runs.
  tillEngine = new KioskCoreTillEngine({ svc, workMode: () => workMode, log: (m) => console.log(`[till] ${m}`) });
  tillRole = new TillRole({
    engine: tillEngine,
    userData: app.getPath('userData'),
    builtInBundleDir: app.isPackaged ? path.join(process.resourcesPath, 'app-bundle') : path.join(__dirname, '..', 'app-bundle'),
    appVersion: appVersion(),
    device: () => {
      const d = screen.getPrimaryDisplay();
      return {
        model: 'Windows',
        os: `${os.type()} ${os.release()}`,
        screen: { width: d.size.width, height: d.size.height, dpr: d.scaleFactor },
        installationId: null,
        shellVersion: appVersion(),
        lite: liteHintOf({ release: os.release(), totalMemBytes: os.totalmem() }),
      };
    },
    caps: () => windowsTillCaps(svc, { secondScreen: screen.getAllDisplays().length > 1 }),
    log: (m) => console.log(`[shell] ${m}`),
  });
  tillView = attachTillRole({
    role: tillRole,
    main: () => main,
    preload: path.join(__dirname, '..', 'preload', 'app.js'),
    isDev,
    enabled: () => true,
    onKey: (input) => guardKey(input),
    oskMode: () => oskModeNow(),
    log: (m) => console.log(`[shell] ${m}`),
    // "ניהול הקיוסק" from the till's corner: never during a payment; the shell's window shows the menu (staff/ShellStaff.tsx).
    admin: {
      allowed: () => !tillEngine?.paying(),
      open: (screen) => sendShell('shell:admin', { from: 'till', screen }),
    },
  });
  openShellScreen = (screen) => {
    if (roles?.role() === 'till' && tillView) tillView.open(screen);
    else sendShell('shell:admin', { from: 'shortcut', screen });
  };
  if (APP_BUILD === 'win7') {
    try {
      showAppTray();
    } catch (e) {
      console.log(`[shell] tray: ${String(e)}`);
    }
  }
  roles.on('view', (v) => {
    tillView?.onRole(v.role);
    applyZoom();
  });
  // "מסך לקוח": the till's second screen, when its settings want it and a second display is there.
  customerDisplay = attachCustomerDisplay({ source: tillEngine.customerDisplay, preload: path.join(__dirname, '..', 'preload', 'index.js'), log: (m) => console.log(`[shell] ${m}`) });

  registerKioskProtocol();

  bridge(service);
  powerSaveBlocker.start('prevent-display-sleep');
  if (!isDev && app.isPackaged) app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
  createMain();
  await service.start();
  // Restarted while out on the desktop (a crash, an update, a reboot): back in full screen, and said so.
  if (service.desktopExitState()) service.desktopReturned('restart');
  roles.start();
  workMode?.start();
  // Development builds check only on "בדוק עכשיו"; an installed app on its own timer too.
  if (app.isPackaged && !isDev) updater.start();
  else void updater.confirmInstalled();
});

app.on('second-instance', (_e, argv) => {
  if (bridgeMode) {
    bridgeMode.show();
    return;
  }
  // "חזרה לקיוסק" (the desktop shortcut), or the app launched again from the Start menu: the running one comes back,
  // the till's view with it.
  bringBack(argv.includes(RETURN_ARG) ? 'shortcut' : 'relaunch');
});

app.on('window-all-closed', () => {
  // The bridge lives in the tray: its window is hidden, never the end of the app.
  if (shellMode === 'bridge') return;
  shutdown();
});
