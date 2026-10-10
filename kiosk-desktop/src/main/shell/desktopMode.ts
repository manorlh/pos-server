/**
 * "יציאה לשולחן העבודה" — the window's part (core/desktopExit.ts decides who and when; the service
 * checks the PIN and records it). No Electron import: main/index.ts hands in the window and the
 * desktop's doors, so the choreography is tested under plain Node (test/desktopExit.test.ts).
 *
 *  - Out: kiosk mode and full screen off, then the window is MINIMISED (not hidden) — a taskbar
 *    button, and with no Explorer shell at all (a Shell Launcher device) the classic minimised title
 *    bar, so there is always a way back. A tray icon "חזרה לקיוסק" and a desktop shortcut
 *    "חזרה לקיוסק" (`--return-to-kiosk`) are offered.
 *  - Back, without a code: the tray, the shortcut (a second launch reaches the running app), the
 *    taskbar button (a restore), or by itself after `idleMinutes` with nobody at the keyboard or
 *    mouse — the cloud's setting "חזרה אוטומטית לקיוסק" (`desktopIdleReturnMinutes`, default 10,
 *    0 = never), kiosk.json only when the cloud sent none. Kiosk mode and full screen come back;
 *    the tray goes away.
 *  - Keys: the app holds no system-wide hook (no Alt+Tab / Win block — the window's own
 *    before-input-event filter only guards its own page), so nothing is released or re-armed; the
 *    lockdown proper is Windows' (Assigned Access / Shell Launcher, README).
 */

import { IDLE_RETURN_MINUTES, shouldAutoReturn, type ReturnVia } from '../../core/desktopExit';

/** The parts of a BrowserWindow this needs. */
export interface DesktopWindow {
  isDestroyed(): boolean;
  isKiosk(): boolean;
  setKiosk(flag: boolean): void;
  isFullScreen(): boolean;
  setFullScreen(flag: boolean): void;
  isMinimized(): boolean;
  minimize(): void;
  restore(): void;
  show(): void;
  focus(): void;
  moveTop(): void;
}

export interface DesktopDoors {
  /** The window to act on (null before it exists). */
  window(): DesktopWindow | null;
  /** The app runs windowed (`--windowed`, dev, kiosk.json): never kiosk / full screen. */
  windowed(): boolean;
  /** The tray icon with "חזרה לקיוסק" (its click calls back with 'tray'). */
  showTray(onReturn: () => void): void;
  hideTray(): void;
  /** The desktop shortcut "חזרה לקיוסק" (created once, kept). */
  ensureShortcut(): void;
  /** Windows' own idle time (powerMonitor.getSystemIdleTime), seconds. */
  systemIdleSec(): number;
  /** The way back is recorded (KioskService.desktopReturned). */
  returned(via: ReturnVia): void;
  /** Leaving full screen settles asynchronously on Windows: the minimise waits for it. */
  wait(ms: number): Promise<void>;
  log(m: string): void;
  now?(): number;
}

export class DesktopMode {
  private since: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private readonly minutes: () => number;

  /**
   * `idleMinutes`: the minutes, or where to read them each time — the cloud's setting
   * `desktopIdleReturnMinutes` (KioskService.desktopIdleReturnMinutes), so a change made on the
   * dashboard while the device is out applies at once.
   */
  constructor(
    private readonly doors: DesktopDoors,
    idleMinutes: number | (() => number) = IDLE_RETURN_MINUTES,
  ) {
    this.minutes = typeof idleMinutes === 'function' ? idleMinutes : () => idleMinutes;
  }

  /** On the desktop now. */
  get active(): boolean {
    return this.since !== null;
  }

  private now(): number {
    return this.doors.now?.() ?? Date.now();
  }

  /** Out of full screen, minimised, the ways back offered. */
  async exit(): Promise<{ ok: boolean; message?: string }> {
    const win = this.doors.window();
    if (!win || win.isDestroyed()) return { ok: false, message: 'חלון האפליקציה אינו זמין' };
    if (this.since !== null) return { ok: true };
    this.since = this.now();
    try {
      // The ways back first: a tray and a shortcut that fail never strand the manager (the taskbar stays).
      try {
        this.doors.showTray(() => this.back('tray'));
      } catch (e) {
        this.doors.log(`desktop: tray: ${String(e)}`);
      }
      try {
        this.doors.ensureShortcut();
      } catch (e) {
        this.doors.log(`desktop: shortcut: ${String(e)}`);
      }
      if (win.isKiosk()) win.setKiosk(false);
      if (win.isFullScreen()) win.setFullScreen(false);
      await this.doors.wait(150);
      if (!win.isDestroyed()) win.minimize();
    } catch (e) {
      this.since = null;
      this.doors.hideTray();
      this.restoreWindow(win);
      return { ok: false, message: `היציאה לשולחן העבודה נכשלה: ${String(e)}` };
    }
    this.watchIdle();
    this.doors.log('desktop: out of full screen');
    return { ok: true };
  }

  /** Back to the kiosk (no code): full screen again, the tray gone, the return recorded. */
  back(via: ReturnVia): void {
    const win = this.doors.window();
    if (this.since === null) {
      // Not on the desktop: a second launch only brings the window up.
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.focus();
      }
      return;
    }
    this.since = null;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.doors.hideTray();
    if (win && !win.isDestroyed()) this.restoreWindow(win);
    this.doors.returned(via);
    this.doors.log(`desktop: back to the kiosk (${via})`);
  }

  /** The window's own `restore` (its taskbar button): that is a way back too. */
  onWindowRestored(): void {
    if (this.since !== null) this.back('taskbar');
  }

  /** One look at the idle time (every 30 s while out). */
  idleTick(): void {
    if (this.since === null) return;
    if (shouldAutoReturn({ systemIdleSec: this.doors.systemIdleSec(), exitedAtMs: this.since, nowMs: this.now(), limitMinutes: this.minutes() })) this.back('idle');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private watchIdle() {
    if (this.timer) clearInterval(this.timer);
    // Always while out: the minutes may be turned on (or changed) from the cloud meanwhile.
    this.timer = setInterval(() => this.idleTick(), 30_000);
    this.timer.unref?.();
  }

  private restoreWindow(win: DesktopWindow) {
    if (win.isMinimized()) win.restore();
    win.show();
    if (!this.doors.windowed()) {
      win.setKiosk(true);
      if (!win.isFullScreen()) win.setFullScreen(true);
    }
    win.focus();
    win.moveTop();
  }
}
