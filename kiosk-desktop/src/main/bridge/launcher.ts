/**
 * "פתיחה בהפעלה" (core/bridgeLauncher.ts): opens Chrome / Edge in kiosk mode on the device's page,
 * in the bridge's own profile, and opens it again when it is closed. Whether the browser is up is
 * read from the profile itself (Chromium holds `<profile>\lockfile` open for writing while it runs),
 * so it holds across a restart of the bridge (an update) without opening a second window.
 * "יציאה ממצב קיוסק" (behind the technician's code) closes it and stops reopening it until the next
 * start of the bridge or "פתח עכשיו".
 */

import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { browserArgs, launchUrl, pickBrowser, QUICK_EXIT_MS, relaunchDelayMs, type LauncherPhase, type LauncherSettings, type WinEnv } from '../../core/bridgeLauncher';

export interface LauncherDeps {
  settings(): LauncherSettings;
  /** The page to open (allowed site), or null. */
  url(): string | null;
  /** The bridge's pairing code while no page is paired (handed to the page in the fragment). */
  bridgeCode(): string | null;
  profileDir: string;
  env: WinEnv;
  exists?: (p: string) => boolean;
  /** Opens the browser (detached); calls `onExit` when that process ends. */
  open?: (exe: string, args: string[], onExit: () => void) => void;
  /** Closes every browser process of the profile. */
  close?: (profileDir: string) => Promise<void>;
  /** Whether a browser runs on the profile. */
  running?: (profileDir: string) => boolean;
  report(phase: LauncherPhase, browser: string | null): void;
  now?: () => number;
  log?: (m: string) => void;
}

/** Chromium keeps `lockfile` open with write access denied to others while it runs. */
export function profileRunning(profileDir: string): boolean {
  const lock = path.join(profileDir, 'lockfile');
  if (!existsSync(lock)) return false;
  try {
    closeSync(openSync(lock, 'r+'));
    return false; // a lockfile left by a crash
  } catch {
    return true;
  }
}

function defaultOpen(exe: string, args: string[], onExit: () => void) {
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false });
  child.on('exit', onExit);
  child.on('error', onExit);
  child.unref();
}

/** Every msedge / chrome process whose command line names the profile (PowerShell, no window). */
function defaultClose(profileDir: string): Promise<void> {
  const dir = profileDir.replace(/'/g, "''");
  const script = `Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains('${dir}') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  return new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, stdio: 'ignore' });
    const done = () => resolve();
    p.on('exit', done);
    p.on('error', done);
    setTimeout(done, 15_000).unref();
  });
}

export class BrowserLauncher {
  private timer: NodeJS.Timeout | null = null;
  private paused = false;
  private childAlive = false;
  private lastLaunchAt = 0;
  private quickExits = 0;
  private notBefore = 0;
  private pairCode: string | null = null;
  private stopped = false;

  constructor(private readonly d: LauncherDeps) {}

  private now(): number {
    return this.d.now?.() ?? Date.now();
  }

  private running(): boolean {
    return this.childAlive || (this.d.running ?? profileRunning)(this.d.profileDir);
  }

  start(firstDelayMs = 4_000) {
    this.stopped = false;
    this.notBefore = this.now() + firstDelayMs;
    this.timer = setInterval(() => this.tick(), 2_000);
    this.timer.unref?.();
    this.tick();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The settings changed: look again now. */
  poke() {
    this.notBefore = Math.min(this.notBefore, this.now());
    this.tick();
  }

  /** A link from the dashboard (`#pair=CODE`): the browser opened (again) on it once. */
  async usePairCode(code: string | null) {
    this.pairCode = code;
    if (this.running()) await (this.d.close ?? defaultClose)(this.d.profileDir);
    this.childAlive = false;
    this.paused = false;
    this.notBefore = this.now();
    this.tick();
  }

  /** "פתח עכשיו": back from a pause, opened at once (when it is not open already). */
  openNow(): { ok: boolean; message?: string } {
    this.paused = false;
    this.notBefore = this.now();
    const r = this.tick(true);
    return r;
  }

  /** "יציאה ממצב קיוסק" (the code was checked): the browser closed, not reopened. */
  async exit(): Promise<void> {
    this.paused = true;
    this.d.report('paused', null);
    await (this.d.close ?? defaultClose)(this.d.profileDir);
    this.childAlive = false;
  }

  tick(force = false): { ok: boolean; message?: string } {
    if (this.stopped) return { ok: false };
    const s = this.d.settings();
    if (!s.enabled && !force) {
      this.d.report('off', null);
      return { ok: false, message: 'פתיחה בהפעלה כבויה' };
    }
    if (this.paused) {
      this.d.report('paused', null);
      return { ok: false };
    }
    const url = this.d.url();
    if (!url) {
      this.d.report('no_url', null);
      return { ok: false, message: 'לא נקבעה כתובת לפתיחה' };
    }
    const browser = pickBrowser(s.browser, this.d.env, this.d.exists ?? existsSync);
    if (!browser) {
      this.d.report('no_browser', null);
      return { ok: false, message: 'לא נמצא Chrome או Edge במחשב' };
    }
    if (this.running()) {
      this.d.report('running', browser.kind);
      return { ok: true, message: 'הדפדפן כבר פתוח' };
    }
    if (this.now() < this.notBefore) {
      this.d.report('waiting', browser.kind);
      return { ok: false };
    }
    mkdirSync(this.d.profileDir, { recursive: true });
    const target = launchUrl(url, { bridgeCode: this.d.bridgeCode(), pairCode: this.pairCode });
    this.pairCode = null;
    this.lastLaunchAt = this.now();
    this.childAlive = true;
    this.d.log?.(`opening ${browser.kind} in kiosk mode on ${url}`);
    this.d.report('starting', browser.kind);
    try {
      (this.d.open ?? defaultOpen)(browser.exe, browserArgs(browser.kind, target, this.d.profileDir), () => this.exited());
    } catch (e) {
      this.childAlive = false;
      this.d.log?.(`browser: ${String(e)}`);
      this.exited();
      return { ok: false, message: String(e) };
    }
    return { ok: true };
  }

  private exited() {
    this.childAlive = false;
    const quick = this.now() - this.lastLaunchAt < QUICK_EXIT_MS;
    this.quickExits = quick ? this.quickExits + 1 : 0;
    this.notBefore = this.now() + relaunchDelayMs(this.quickExits);
    if (!this.paused && !this.stopped) this.d.report('waiting', null);
  }
}
