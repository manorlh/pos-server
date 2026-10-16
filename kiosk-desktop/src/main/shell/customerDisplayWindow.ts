/**
 * "מסך לקוח" on the Windows till's second screen (pos-android ui/customerdisplay/CustomerDisplayPresentation.kt
 * `CustomerDisplayController`): the first display that is not the primary one, while the till's settings want it
 * (main/till/tillCustomerDisplay.ts) — a frameless window over that whole display, never taking the focus from the till,
 * drawn by the dashboard's own `CustomerScreen` (renderer/display). Looked at again when a display is added, removed or
 * changed; no second screen — nothing shown, the sale never waits for it.
 */

import { BrowserWindow, ipcMain, screen } from 'electron';
import type { CustomerDisplayFrame, TillCustomerDisplay } from '../till/tillCustomerDisplay';

export function attachCustomerDisplay(o: { source: TillCustomerDisplay; preload: string; log(m: string): void }): { stop(): void } {
  let win: BrowserWindow | null = null;
  const external = () => {
    const primary = screen.getPrimaryDisplay();
    return screen.getAllDisplays().find((d) => d.id !== primary.id) ?? null;
  };
  const send = (f: CustomerDisplayFrame) => {
    if (win && !win.isDestroyed()) win.webContents.send('display:state', f);
  };
  const evaluate = () => {
    const d = o.source.wanted() ? external() : null;
    o.source.setScreenPresent(!!d);
    if (!d) {
      if (win && !win.isDestroyed()) {
        o.log('customer display: closed');
        win.destroy();
      }
      win = null;
      return;
    }
    if (win && !win.isDestroyed()) {
      win.setBounds(d.bounds);
      return;
    }
    o.log(`customer display: on display ${d.id} (${d.bounds.width}x${d.bounds.height})`);
    const w = new BrowserWindow({
      x: d.bounds.x,
      y: d.bounds.y,
      width: d.bounds.width,
      height: d.bounds.height,
      frame: false,
      show: false,
      skipTaskbar: true,
      focusable: false,
      backgroundColor: '#0D1016',
      webPreferences: { preload: o.preload, contextIsolation: true, sandbox: true, backgroundThrottling: false, spellcheck: false },
    });
    w.setMenu(null);
    w.once('ready-to-show', () => {
      w.setFullScreen(true);
      w.showInactive();
    });
    w.on('closed', () => {
      if (win === w) win = null;
    });
    void w.loadURL('kiosk://app/display.html');
    win = w;
  };
  const onReady = (e: Electron.IpcMainEvent) => {
    if (win && e.sender === win.webContents) send(o.source.frame());
  };
  ipcMain.on('display:ready', onReady);
  const off = o.source.onChange((f) => {
    evaluate();
    send(f);
  });
  screen.on('display-added', evaluate);
  screen.on('display-removed', evaluate);
  screen.on('display-metrics-changed', evaluate);
  evaluate();
  return {
    stop() {
      off();
      ipcMain.removeListener('display:ready', onReady);
      screen.removeListener('display-added', evaluate);
      screen.removeListener('display-removed', evaluate);
      screen.removeListener('display-metrics-changed', evaluate);
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
    },
  };
}
