/**
 * The till role's Electron glue (S0-6): the `r2m://app/` protocol over the verified bundle, the
 * IPC door of `window.r2mApp` (preload/app.ts), and the till's view laid over the main window
 * while the cloud says this device is a till. The logic is roles/till.ts (Electron-free, tested).
 *
 * Same window, same app, same installer as the kiosk: the till is a VIEW the shell shows for the
 * role, with its own preload (no `window.kiosk` there) and a sandboxed renderer. The view's API is chosen by
 * capability in shell/viewCompat.ts: WebContentsView on Electron 30+, BrowserView on Windows 7's build (Electron 22,
 * §13.2), whose experimental WebContentsView has no setBounds.
 */

import { ipcMain, protocol, type BrowserWindow } from 'electron';
import * as electron from 'electron';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { handleScheme, textReply, unhandleScheme } from '../shell/schemeHandler';
import { createOverlayView, electronMajor, type ElectronViewsLike, type OverlayView, type WindowViewsLike } from '../shell/viewCompat';
import { APP_IPC } from '../../shared/till/appBridge';
import type { DeviceRoleName, EngineEvent, HwRequest } from '../../shared/till/protocol';
import type { TillRole } from './till';

/** The till view's own scheme (registered as privileged with the kiosk's, main/index.ts). */
export const APP_SCHEME = { scheme: 'r2m', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } } as const;

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

export interface TillElectronOptions {
  role: TillRole;
  main(): BrowserWindow | null;
  preload: string;
  isDev: boolean;
  /** Whether the till preview is on (kiosk.json `tillPreview`, `--till-preview`). */
  enabled(): boolean;
  log(m: string): void;
  /** The shell's key guard for the till's page too (no Alt+F4 / reload; the support keys): true = the key is taken. */
  onKey?(input: Electron.Input): boolean;
  /** "מקלדת מסך" (the technician's choice on this device). */
  oskMode?(): 'auto' | 'always' | 'off';
  /**
   * "ניהול הקיוסק" from the till's corner: `allowed` — never during a payment (the engine's checkout, a card at the
   * terminal); `open` — the shell's window shows its manager's menu (renderer staff/ShellStaff.tsx) while the till's view
   * is set aside, until `resume`.
   */
  admin?: { allowed(): boolean; open(screen: 'admin' | 'technician'): void };
}

export interface TillElectron {
  /** The role the cloud gives the device (roles/manager.ts view): shows / hides the till. */
  onRole(role: string | null): void;
  /** The manager's menu over the till is closed: the till's view is laid back over the window. */
  resume(): void;
  /** The shell's menu or technician's screen (a keyboard shortcut, the tray): the till's view set aside first. */
  open(screen: 'admin' | 'technician'): boolean;
  /** The window is back from the desktop: the till's view fitted and focused again. */
  refit(): void;
  stop(): void;
}

export function attachTillRole(o: TillElectronOptions): TillElectron {
  let view: OverlayView<Electron.WebContents> | null = null;
  let watchdog: NodeJS.Timeout | null = null;
  /** Set aside (zero size, no input) while the shell's manager's menu is up; the renderer and its state stay. */
  let parked = false;
  const role = o.role;

  // `protocol.handle` on Electron 44; Electron 22 (the Windows 7 build) has only stream protocols (shell/schemeHandler.ts).
  handleScheme(protocol, 'r2m', (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app') return textReply(404, 'not found');
    const hit = role.serve(url.pathname);
    if (!hit) return textReply(404, 'not found');
    const ext = path.extname(hit.file).slice(1).toLowerCase();
    return {
      status: 200,
      headers: { ...hit.headers, 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Content-Length': String(statSync(hit.file).size) },
      body: createReadStream(hit.file),
    };
  }, o.log);

  const fromTill = (e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => !!view && e.sender === view.webContents;
  ipcMain.handle(APP_IPC.info, (e) => (fromTill(e) ? role.info() : null));
  ipcMain.handle(APP_IPC.hello, (e, since: unknown) => (fromTill(e) ? role.hello(typeof since === 'number' ? since : undefined) : null));
  ipcMain.handle(APP_IPC.call, (e, c: unknown) => (fromTill(e) ? role.call(c) : { id: -1, ok: false, error: { code: 'permission_denied', message: 'אין הרשאה' } }));
  ipcMain.handle(APP_IPC.osk, (e) => (fromTill(e) ? (o.oskMode?.() ?? 'auto') : 'off'));
  ipcMain.on(APP_IPC.ready, (e) => {
    if (!fromTill(e)) return;
    role.reportReady();
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
  });
  ipcMain.on(APP_IPC.idle, (e, idle: unknown, busy: unknown) => fromTill(e) && role.reportIdle(idle === true, busy === true));
  ipcMain.on(APP_IPC.keepAwake, () => undefined); // the shell already keeps the display on (powerSaveBlocker)
  // The till's corner: the shell's manager's menu, never during a payment.
  // The till's six taps (top-left, the PIN screen too): the shell's technician's screen, never during a payment either.
  const openShell = (e: Electron.IpcMainEvent, screen: 'admin' | 'technician') => {
    if (!fromTill(e)) return;
    openScreen(screen);
  };
  /** The shell's menu / technician's screen over the till: the view is set aside (zero size) first. */
  const openScreen = (screen: 'admin' | 'technician'): boolean => {
    if (!o.admin) return false;
    if (parked) return true;
    if (!o.admin.allowed()) {
      o.log(`till: the ${screen === 'admin' ? 'manager corner' : 'technician taps'} wait — a payment is on`);
      return false;
    }
    if (view) {
      parked = true;
      fit();
    }
    o.admin.open(screen);
    return true;
  };
  ipcMain.on(APP_IPC.admin, (e) => openShell(e, 'admin'));
  ipcMain.on(APP_IPC.technician, (e) => openShell(e, 'technician'));

  const offEngine = role.onEngineEvent(
    (ev: EngineEvent) => view?.webContents.send(APP_IPC.event, ev),
    (req: HwRequest) => {
      // P2: printer/transports.ts and payment/* carry these out in the main process (§3.4).
      o.log(`till: hw ${req.type} not carried out in the skeleton`);
      role.hwResult({ requestId: req.requestId, ok: false, code: 'unsupported', message: 'החומרה של הקופה מגיעה בשלב P2' });
    },
  );

  const fit = () => {
    const win = o.main();
    if (!win || !view) return;
    const b = win.getContentBounds();
    view.fit(parked ? { x: 0, y: 0, width: 0, height: 0 } : { x: 0, y: 0, width: b.width, height: b.height });
  };

  const show = () => {
    const win = o.main();
    if (!win || view) return;
    const chosen = role.chooseBundle();
    if (!chosen) {
      o.log('till: no verified bundle — the placeholder stays');
      return;
    }
    const webPreferences = { preload: o.preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false, devTools: o.isDev };
    try {
      view = createOverlayView<Electron.WebContents>(electron as unknown as ElectronViewsLike, win as unknown as WindowViewsLike, webPreferences, electronMajor(), o.log);
      view.attach();
    } catch (err) {
      o.log(`till: the view could not be created — ${err instanceof Error ? err.message : String(err)}`);
      view = null;
      return;
    }
    fit();
    win.on('resize', fit);
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    view.webContents.on('before-input-event', (e, input) => {
      if (o.onKey?.(input)) e.preventDefault();
    });
    view.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith('r2m://app/')) e.preventDefault();
    });
    view.webContents.on('render-process-gone', () => {
      o.log('till: renderer gone — reloading');
      role.loading();
      setTimeout(() => view?.webContents.reload(), 500);
    });
    role.loading();
    watchdog = setTimeout(() => {
      if (role.isReady || !role.bundle) return;
      // No "ready" in time: this bundle is bad here; the next choice (the built-in one) loads.
      role.markBad(role.bundle.dir);
      hide();
      show();
    }, 25_000);
    void view.webContents.loadURL('r2m://app/index.html');
    o.log(`till: ${chosen.source} bundle ${chosen.manifest.version}`);
  };

  const hide = () => {
    const win = o.main();
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
    if (!view) return;
    if (win) {
      win.removeListener('resize', fit);
      view.detach();
    }
    // Electron 22 (Windows 7) has no webContents.close(): destroy() there.
    const wc = view.webContents as unknown as { close?(): void; destroy?(): void };
    if (wc.close) wc.close();
    else wc.destroy?.();
    view = null;
    parked = false;
  };

  return {
    onRole: (r) => {
      const wanted = r === 'till' && o.enabled();
      if (wanted) show();
      else hide();
      if (view && r) view.webContents.send(APP_IPC.role, r as DeviceRoleName);
    },
    open: (screen) => openScreen(screen),
    refit: () => {
      fit();
      if (!parked) view?.webContents.focus();
    },
    resume: () => {
      if (!parked) return;
      parked = false;
      fit();
      view?.webContents.focus();
    },
    stop: () => {
      hide();
      offEngine();
      for (const ch of Object.values(APP_IPC)) {
        ipcMain.removeHandler(ch);
        ipcMain.removeAllListeners(ch);
      }
      unhandleScheme(protocol, 'r2m');
    },
  };
}
