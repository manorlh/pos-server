/**
 * "מצב הדגמה" of the installed app — the Electron side (the rules: core/demoMode.ts). Started by main/index.ts
 * instead of the real app when the command line says `--demo=kiosk|till` (the pairing screen's restart), with the
 * data folder already moved to `<userData>\demo`:
 *
 *  - NO local service, no SQLite, no pairing credentials, no cloud, no updater, no terminal, no print queue — none of
 *    them is even constructed here;
 *  - the main window: the shell's screens (`kiosk://app/index.html?demo=1&role=…`) with preload/demo.ts, so they take
 *    the web demo's bridges (renderer/bridge.ts, renderer/roles/shellBridge.ts);
 *  - the till: the built-in app bundle (verified, as roles/till.ts does) at `r2m://app/`, laid over the main window as
 *    in the real app (roles/tillElectron.ts), on the mock engine with a simulated terminal (renderer/app/pickHost.ts);
 *    its corner asks the shell's manager menu (the main window), which gives it back when closed;
 *  - kiosk ↔ till: the main window reloads as the other role; exit: a restart as the real app.
 */

import { ipcMain, protocol, type BrowserWindow } from 'electron';
import * as electron from 'electron';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { DEMO_IPC, DEMO_TILL_URL, demoNavigationAllowed, demoShellUrl, isDemoRole, type DemoRole } from '../../core/demoMode';
import { handleScheme, textReply } from '../shell/schemeHandler';
import { resolveAppPath, verifyAppBundleDir, type AppBundleManifest } from '../roles/appBundle';
import { APP_CSP, ENGINE_PROTOCOLS } from '../roles/till';
import { createOverlayView, electronMajor, type ElectronViewsLike, type OverlayView, type WindowViewsLike } from '../shell/viewCompat';

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  png: 'image/png',
  svg: 'image/svg+xml',
  woff: 'font/woff',
  woff2: 'font/woff2',
};

export interface DemoShellOptions {
  role: DemoRole;
  /** The main window, built by main/index.ts (full screen, no way out) with this preload. */
  createWindow(preload: string): BrowserWindow;
  /** preload/demo.js */
  preload: string;
  /** The till's screens inside the installer (resources/app-bundle), or dist/app-bundle in development. */
  builtInBundleDir: string;
  isDev: boolean;
  /** A restart with these arguments (core/demoMode.ts demoRelaunchArgs): the real app, or the other demo. */
  relaunch(role: DemoRole | null): void;
  log(m: string): void;
}

export interface DemoShell {
  stop(): void;
}

export function startDemoShell(o: DemoShellOptions): DemoShell {
  let role: DemoRole = o.role;
  let view: OverlayView<Electron.WebContents> | null = null;
  let parked = false;
  o.log(`demo: ${role} (no service, no cloud, no terminal)`);

  // The till's screens: the bundle inside the installer, checked file by file before any is served.
  const checked = verifyAppBundleDir(o.builtInBundleDir, { protocols: ENGINE_PROTOCOLS, role: 'till', publicKey: null });
  const manifest: AppBundleManifest | null = checked.ok ? checked.manifest : null;
  if (!checked.ok) o.log(`demo: no till bundle (${checked.problems.slice(0, 3).join(', ')})`);
  handleScheme(protocol, 'r2m', (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app' || !manifest) return textReply(404, 'not found');
    const file = resolveAppPath(o.builtInBundleDir, manifest, url.pathname);
    if (!file) return textReply(404, 'not found');
    const ext = path.extname(file).slice(1).toLowerCase();
    return {
      status: 200,
      headers: { 'Content-Security-Policy': APP_CSP, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-cache', 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Content-Length': String(statSync(file).size) },
      body: createReadStream(file),
    };
  }, o.log);

  const win = o.createWindow(o.preload);
  const guard = (wc: Electron.WebContents) => {
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e, url) => {
      if (!demoNavigationAllowed(url)) e.preventDefault();
    });
  };
  guard(win.webContents);

  const fit = () => {
    if (!view || win.isDestroyed()) return;
    const b = win.getContentBounds();
    view.fit(parked ? { x: 0, y: 0, width: 0, height: 0 } : { x: 0, y: 0, width: b.width, height: b.height });
  };

  const showTill = () => {
    if (view || !manifest) return;
    // The same view as the real till's (shell/viewCompat.ts): WebContentsView, or BrowserView on Windows 7's Electron 22.
    const webPreferences = { preload: o.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false, devTools: o.isDev };
    try {
      view = createOverlayView<Electron.WebContents>(electron as unknown as ElectronViewsLike, win as unknown as WindowViewsLike, webPreferences, electronMajor(), o.log);
      view.attach();
    } catch (err) {
      o.log(`demo: the till view could not be created — ${err instanceof Error ? err.message : String(err)}`);
      view = null;
      return;
    }
    guard(view.webContents);
    view.webContents.on('render-process-gone', () => setTimeout(() => view?.webContents.reload(), 500));
    fit();
    win.on('resize', fit);
    void view.webContents.loadURL(DEMO_TILL_URL);
  };

  const hideTill = () => {
    if (!view) return;
    win.removeListener('resize', fit);
    if (!win.isDestroyed()) view.detach();
    const wc = view.webContents as unknown as { close?(): void; destroy?(): void };
    if (wc.close) wc.close();
    else wc.destroy?.();
    view = null;
    parked = false;
  };

  const show = (r: DemoRole) => {
    role = r;
    void win.loadURL(demoShellUrl(r));
    if (r === 'till') showTill();
    else hideTill();
  };

  const fromDemo = (e: Electron.IpcMainEvent) => e.sender === win.webContents || (!!view && e.sender === view.webContents);
  ipcMain.on(DEMO_IPC.switchTo, (e, r: unknown) => {
    if (!fromDemo(e) || !isDemoRole(r) || r === role) return;
    o.log(`demo: switch to ${r}`);
    show(r);
  });
  ipcMain.on(DEMO_IPC.exit, (e) => {
    if (!fromDemo(e)) return;
    o.log('demo: exit — back to the real app');
    o.relaunch(null);
  });
  // The till's corner: its view set aside, the shell's manager menu over the window (as roles/tillElectron.ts).
  ipcMain.on(DEMO_IPC.openAdmin, (e, screen: unknown) => {
    if (!view || e.sender !== view.webContents || parked) return;
    parked = true;
    fit();
    win.webContents.send(DEMO_IPC.admin, { from: 'till', screen: screen === 'technician' ? 'technician' : 'admin' });
  });
  ipcMain.on(DEMO_IPC.adminClosed, (e) => {
    if (e.sender !== win.webContents || !parked) return;
    parked = false;
    fit();
    view?.webContents.focus();
  });

  show(role);
  return {
    stop: () => {
      hideTill();
      for (const ch of Object.values(DEMO_IPC)) ipcMain.removeAllListeners(ch);
    },
  };
}
