/**
 * The till role's Electron glue (S0-6): the `r2m://app/` protocol over the verified bundle, the
 * IPC door of `window.r2mApp` (preload/app.ts), and the till's view laid over the main window
 * while the cloud says this device is a till. The logic is roles/till.ts (Electron-free, tested).
 *
 * Same window, same app, same installer as the kiosk: the till is a VIEW the shell shows for the
 * role, with its own preload (no `window.kiosk` there) and a sandboxed renderer. Windows 7's build
 * (Electron 22, §13.2) has no WebContentsView: it falls back to BrowserView there.
 */

import { ipcMain, protocol, type BrowserWindow } from 'electron';
import * as electron from 'electron';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
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

interface ViewLike {
  webContents: Electron.WebContents;
  setBounds(b: { x: number; y: number; width: number; height: number }): void;
}

export interface TillElectronOptions {
  role: TillRole;
  main(): BrowserWindow | null;
  preload: string;
  isDev: boolean;
  /** Whether the till preview is on (kiosk.json `tillPreview`, `--till-preview`). */
  enabled(): boolean;
  log(m: string): void;
}

export interface TillElectron {
  /** The role the cloud gives the device (roles/manager.ts view): shows / hides the till. */
  onRole(role: string | null): void;
  stop(): void;
}

function makeView(preload: string, isDev: boolean): ViewLike {
  const webPreferences = { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false, backgroundThrottling: false, devTools: isDev };
  const e = electron as unknown as {
    WebContentsView?: new (o: { webPreferences: typeof webPreferences }) => ViewLike;
    BrowserView?: new (o: { webPreferences: typeof webPreferences }) => ViewLike;
  };
  if (e.WebContentsView) return new e.WebContentsView({ webPreferences });
  if (e.BrowserView) return new e.BrowserView({ webPreferences });
  throw new Error('no view class in this Electron');
}

function attach(win: BrowserWindow, view: ViewLike) {
  const w = win as unknown as { contentView?: { addChildView(v: ViewLike): void }; setBrowserView?(v: ViewLike): void };
  if (w.contentView?.addChildView) w.contentView.addChildView(view);
  else w.setBrowserView?.(view);
}

function detach(win: BrowserWindow, view: ViewLike) {
  const w = win as unknown as { contentView?: { removeChildView(v: ViewLike): void }; setBrowserView?(v: ViewLike | null): void };
  if (w.contentView?.removeChildView) w.contentView.removeChildView(view);
  else w.setBrowserView?.(null);
}

export function attachTillRole(o: TillElectronOptions): TillElectron {
  let view: ViewLike | null = null;
  let watchdog: NodeJS.Timeout | null = null;
  const role = o.role;

  protocol.handle('r2m', (request) => {
    const url = new URL(request.url);
    if (url.host !== 'app') return new Response('not found', { status: 404 });
    const hit = role.serve(url.pathname);
    if (!hit) return new Response('not found', { status: 404 });
    const ext = path.extname(hit.file).slice(1).toLowerCase();
    return new Response(Readable.toWeb(createReadStream(hit.file)) as ReadableStream, {
      status: 200,
      headers: { ...hit.headers, 'Content-Type': MIME[ext] ?? 'application/octet-stream', 'Content-Length': String(statSync(hit.file).size) },
    });
  });

  const fromTill = (e: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent) => !!view && e.sender === view.webContents;
  ipcMain.handle(APP_IPC.info, (e) => (fromTill(e) ? role.info() : null));
  ipcMain.handle(APP_IPC.hello, (e, since: unknown) => (fromTill(e) ? role.hello(typeof since === 'number' ? since : undefined) : null));
  ipcMain.handle(APP_IPC.call, (e, c: unknown) => (fromTill(e) ? role.call(c) : { id: -1, ok: false, error: { code: 'permission_denied', message: 'אין הרשאה' } }));
  ipcMain.on(APP_IPC.ready, (e) => {
    if (!fromTill(e)) return;
    role.reportReady();
    if (watchdog) clearTimeout(watchdog);
    watchdog = null;
  });
  ipcMain.on(APP_IPC.idle, (e, idle: unknown, busy: unknown) => fromTill(e) && role.reportIdle(idle === true, busy === true));
  ipcMain.on(APP_IPC.keepAwake, () => undefined); // the shell already keeps the display on (powerSaveBlocker)

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
    view.setBounds({ x: 0, y: 0, width: b.width, height: b.height });
  };

  const show = () => {
    const win = o.main();
    if (!win || view) return;
    const chosen = role.chooseBundle();
    if (!chosen) {
      o.log('till: no verified bundle — the placeholder stays');
      return;
    }
    view = makeView(o.preload, o.isDev);
    attach(win, view);
    fit();
    win.on('resize', fit);
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
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
      detach(win, view);
    }
    // Electron 22 (Windows 7) has no webContents.close(): destroy() there.
    const wc = view.webContents as unknown as { close?(): void; destroy?(): void };
    if (wc.close) wc.close();
    else wc.destroy?.();
    view = null;
  };

  return {
    onRole: (r) => {
      const wanted = r === 'till' && o.enabled();
      if (wanted) show();
      else hide();
      if (view && r) view.webContents.send(APP_IPC.role, r as DeviceRoleName);
    },
    stop: () => {
      hide();
      offEngine();
      for (const ch of Object.values(APP_IPC)) {
        ipcMain.removeHandler(ch);
        ipcMain.removeAllListeners(ch);
      }
      protocol.unhandle('r2m');
    },
  };
}
