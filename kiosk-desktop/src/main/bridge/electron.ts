/**
 * Bridge mode of R2M POS for Windows (shell/mode.ts; docs/SPEC_KIOSK.md §28): no kiosk window — a
 * tray icon, a small window (renderer/bridge), the local API (server.ts) over the runtime
 * (runtime.ts), "פתיחה בהפעלה" (launcher.ts), started at login, and the same updater as the app
 * (the linked machine's assignment, installed silently when the page is idle).
 */

import { app, BrowserWindow, globalShortcut, ipcMain, Menu, nativeImage, net as enet, Tray } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BRIDGE_PORT } from '../../core/bridgeProtocol';
import { parseWindow } from '../../core/updatePolicy';
import type { BridgeActionResult, BridgeWindowAction } from '../../shared/bridgeWindow';
import type { PageRenderer } from '../printer/printQueue';
import type { SecretBox } from '../sync/cloud';
import { UpdateManager } from '../update/updater';
import { BrowserLauncher } from './launcher';
import { BridgeRuntime } from './runtime';
import { BridgeServer } from './server';

export interface BridgeModeOptions {
  appVersion: string;
  userData: string;
  rendererDir: string;
  preload: string;
  renderPage: PageRenderer;
  deviceInfo: Record<string, string>;
  secretBox?: SecretBox;
  install: { bridgePort?: unknown; bridgeOrigins?: unknown; updateWindow?: string; updateCheckMinutes?: number };
  isDev: boolean;
  /** `kiosk://media/<file>` for the receipt's logo: the linked kiosk's media. */
  setMediaResolver(fn: (name: string) => string | null): void;
  log(m: string): void;
}

export interface BridgeModeHandle {
  show(): void;
  quitting(): boolean;
}

export async function startBridgeMode(o: BridgeModeOptions): Promise<BridgeModeHandle> {
  let quitting = false;
  let win: BrowserWindow | null = null;
  let tray: Tray | null = null;
  let updater: UpdateManager | null = null;

  const runtime = new BridgeRuntime({
    dataDir: path.join(o.userData, 'bridge'),
    appVersion: o.appVersion,
    deviceInfo: o.deviceInfo,
    secretBox: o.secretBox,
    renderer: o.renderPage,
    extraOrigins: Array.isArray(o.install.bridgeOrigins) ? (o.install.bridgeOrigins as unknown[]).filter((x): x is string => typeof x === 'string') : [],
    platform: {
      quit: () => undefined,
      networkUp: () => enet.isOnline(),
      interfaces: () =>
        Object.entries(os.networkInterfaces()).flatMap(([name, list]) => (list ?? []).filter((a) => a.family === 'IPv4' && !a.internal).map((a) => ({ name, address: a.address }))),
      checkUpdate: async () => (updater ? updater.checkNow() : { available: null, status: 'not_linked' }),
      installUpdate: async () => (updater ? updater.installNow() : { ok: false, message: 'הגשר עוד לא מקושר למכשיר' }),
      updateStatus: () => updater?.view() ?? { current: o.appVersion, phase: 'idle', available: null, progress: null, message: 'עדכונים יתחילו אחרי קישור מכשיר', lastCheckAt: null, autoInstall: false, installWindow: null },
    },
    log: o.log,
  });
  await runtime.start();
  o.setMediaResolver((name) => runtime.service?.media.resolveFile(name) ?? null);
  runtime.setUpdateView(() => updater?.view() ?? null);

  /* ------------------------------------------------------------ the API */

  const port = typeof o.install.bridgePort === 'number' && o.install.bridgePort > 1024 && o.install.bridgePort < 65_536 ? o.install.bridgePort : BRIDGE_PORT;
  const server = new BridgeServer(runtime, { port });
  try {
    runtime.setListening(await server.listen(), null);
  } catch (e) {
    const msg = (e as { code?: string }).code === 'EADDRINUSE' ? `הפורט ${port} תפוס על ידי תוכנה אחרת` : String(e);
    o.log(`[bridge] listen: ${msg}`);
    runtime.setListening(null, msg);
  }
  runtime.on('pairing', () => server.dropSockets());

  /* ------------------------------------------------------------ updates */

  const buildUpdater = () => {
    updater?.stop();
    updater = null;
    const ctx = runtime.updaterContext();
    if (!ctx) return;
    updater = new UpdateManager({
      api: ctx.api,
      kv: runtime.kv,
      machineId: () => runtime.updaterContext()?.machineId ?? null,
      token: () => runtime.updaterContext()?.token ?? null,
      currentVersion: o.appVersion,
      dir: path.join(o.userData, 'updates'),
      activity: () => runtime.activity(),
      localWindow: parseWindow(o.install.updateWindow),
      checkEveryMs: Math.max(5, Number(o.install.updateCheckMinutes) || 15) * 60_000,
      runInstaller: (file, args) => {
        if (!existsSync(file)) throw new Error('קובץ ההתקנה חסר');
        spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', (e) => o.log(`[update] installer: ${e.message}`)).unref();
      },
      quit: () => {
        quitting = true;
        app.quit();
      },
      log: (m) => o.log(`[update] ${m}`),
    });
    updater.onChange(() => runtime.emit('view'));
    if (app.isPackaged && !o.isDev) updater.start();
    else void updater.confirmInstalled();
  };
  buildUpdater();
  runtime.on('link', buildUpdater);

  /* ----------------------------------------------------- "פתיחה בהפעלה" */

  const launcher = new BrowserLauncher({
    settings: () => runtime.launcherSettings(),
    url: () => runtime.launcherUrl(),
    bridgeCode: () => (runtime.health().paired ? null : runtime.currentCode()),
    profileDir: path.join(o.userData, 'bridge', 'browser-profile'),
    env: { programFiles: process.env.ProgramFiles, programFilesX86: process.env['ProgramFiles(x86)'], localAppData: process.env.LOCALAPPDATA },
    report: (phase, browser) => runtime.setLauncherState(phase, browser),
    log: (m) => o.log(`[launcher] ${m}`),
  });
  runtime.on('launcher', (opts?: { pairCode?: string | null }) => {
    if (opts?.pairCode) void launcher.usePairCode(opts.pairCode);
    else launcher.poke();
  });
  runtime.on('launcherExit', () => void launcher.exit());
  launcher.start();

  /* ------------------------------------------------------------- window */

  const showWindow = () => {
    if (!win || win.isDestroyed()) {
      win = new BrowserWindow({
        width: 860,
        height: 760,
        minWidth: 560,
        minHeight: 520,
        title: 'R2M POS · גשר לדפדפן',
        autoHideMenuBar: true,
        show: false,
        webPreferences: { preload: o.preload, contextIsolation: true, sandbox: true, devTools: o.isDev, spellcheck: false },
      });
      win.removeMenu();
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', (e, url) => {
        if (!url.startsWith('kiosk://app/')) e.preventDefault();
      });
      win.on('close', (e) => {
        // Closing the window hides it: the bridge keeps running in the tray.
        if (!quitting) {
          e.preventDefault();
          win?.hide();
        }
      });
      win.once('ready-to-show', () => win?.show());
      void win.loadURL('kiosk://app/bridge.html');
      return;
    }
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  };

  const pushView = () => {
    if (win && !win.isDestroyed()) win.webContents.send('bridge:view', runtime.view());
  };
  runtime.on('view', pushView);
  // The code's countdown and the launcher's state, once a second while the window is open.
  setInterval(() => {
    if (win && !win.isDestroyed() && win.isVisible()) pushView();
  }, 1_000).unref();

  const glueAction = async (a: BridgeWindowAction): Promise<BridgeActionResult> => {
    switch (a.type) {
      case 'openBrowserNow':
        return launcher.openNow();
      case 'exitKioskMode': {
        const check = runtime.checkTechnician(a.pin);
        if (!check.ok) return check;
        await launcher.exit();
        return { ok: true, message: 'יצאתם ממצב קיוסק. "פתח עכשיו" מחזיר אותו.' };
      }
      case 'checkUpdate': {
        if (!updater) return { ok: false, message: 'עדכונים יתחילו אחרי קישור מכשיר' };
        const r = await updater.checkNow();
        return { ok: r.status !== 'failed' && r.status !== 'offline', message: r.available ? `גרסה ${r.available}: ${r.status}` : 'הגרסה עדכנית' };
      }
      case 'installUpdate':
        return updater ? updater.installNow() : { ok: false, message: 'אין עדכון' };
      case 'hide':
        win?.hide();
        return { ok: true };
      case 'quit': {
        const check = runtime.checkTechnician(a.pin);
        if (!check.ok) return check;
        quitting = true;
        setTimeout(() => app.quit(), 200);
        return { ok: true };
      }
      default:
        return { ok: false, message: 'פעולה לא מוכרת' };
    }
  };

  ipcMain.handle('bridge:view', () => runtime.view());
  ipcMain.handle('bridge:action', async (_e, a: BridgeWindowAction) => {
    try {
      return (await runtime.windowAction(a)) ?? (await glueAction(a));
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  });

  /* --------------------------------------------------------------- tray */

  const iconFile = path.join(o.rendererDir, 'tray.png');
  const icon = existsSync(iconFile) ? nativeImage.createFromPath(iconFile).resize({ width: 16, height: 16 }) : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('R2M POS · גשר לדפדפן');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'פתיחת חלון הגשר', click: showWindow },
      { label: 'פתיחת הדפדפן עכשיו', click: () => void launcher.openNow() },
      { type: 'separator' },
      { label: 'יציאה… (קוד טכנאי בחלון)', click: showWindow },
    ]),
  );
  tray.on('click', showWindow);
  tray.on('double-click', showWindow);

  // From inside the kiosk browser (no taskbar): Ctrl+Alt+Shift+B brings the window up.
  globalShortcut.register('CommandOrControl+Alt+Shift+B', showWindow);

  if (app.isPackaged && !o.isDev) app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });

  // Not paired yet: the window with the code is the first thing the installer sees.
  if (!runtime.health().paired) showWindow();

  app.on('before-quit', () => {
    quitting = true;
    launcher.stop();
    updater?.stop();
    globalShortcut.unregisterAll();
    void server.close();
    runtime.stop();
    tray?.destroy();
  });

  return { show: showWindow, quitting: () => quitting };
}
