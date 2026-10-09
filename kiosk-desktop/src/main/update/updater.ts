/**
 * Updates of the Windows app from OUR cloud ("עדכוני גרסה", the same releases screen as the
 * Android tills) — a small custom updater, not electron-updater: the cloud decides per machine
 * (assignments machine → area → shop → company → tenant, staged rollout, rollback), the download
 * carries the machine's own token, and every step is reported back to the dashboard.
 *
 *  1. Check — at start (after a minute) and every `checkEveryMs` (15 min), and on "בדוק עכשיו":
 *     GET /sync/{m}/app-update?versionCode=&versionName=&platform=windows. Only a Windows offer is
 *     taken (core/updatePolicy.ts `acceptOffer`).
 *  2. Download in the background to %APPDATA%\R2M Kiosk\updates\<release>.exe.part, hashing on the
 *     way; the file must match the cloud's SHA-256 (and size) or it is thrown away. Then
 *     `<release>.exe`. Reported: downloading → downloaded (or failed + reason).
 *  3. Install — automatically only for an `autoInstall` assignment, when the device is quiet and
 *     (if given) inside the install window; "התקן עכשיו" any time except during an order or a
 *     payment. The file is hashed once more, `installing` is reported, the NSIS installer runs
 *     silently (`/S --force-run`: per-user install, no UAC prompt; it replaces the app and starts
 *     it again) and the app quits.
 *  4. Next start: the version that runs now is compared with the one that was installing —
 *     `installed`, or `failed` with the reason.
 *
 * No code signing yet: the installer is unsigned. Windows SmartScreen does not stop it here (it
 * was not downloaded by a browser, so it has no mark-of-the-web); what protects it is HTTPS, the
 * machine's token and the SHA-256 the cloud computed on upload (docs/SPEC_UPDATES.md).
 */

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Api } from '../sync/api';
import type { Kv } from '../db/schema';
import type { UpdateView } from '../../shared/roles';
import {
  acceptOffer,
  autoInstallDecision,
  manualInstallDecision,
  retryDelayMs,
  verifies,
  versionCodeOf,
  type Activity,
  type UpdateOffer,
} from '../../core/updatePolicy';

export type { UpdateOffer } from '../../core/updatePolicy';
export { acceptOffer, newer, versionCodeOf } from '../../core/updatePolicy';

/** The statuses the cloud keeps per machine and release (server APP_UPDATE_STATUSES). */
export type ReportStatus = 'downloading' | 'downloaded' | 'installing' | 'installed' | 'failed' | 'declined';

interface Ready {
  releaseId: string;
  versionName: string;
  file: string;
  sha256: string;
  sizeBytes: number;
  autoInstall: boolean;
  installWindow: { start: string; end: string } | null;
}

interface Pending {
  releaseId: string;
  versionName: string;
  fromVersion: string;
  at: number;
}

export interface UpdaterDeps {
  api: Api;
  kv: Kv;
  machineId(): string | null;
  token(): string | null;
  currentVersion: string;
  /** Where installers are kept (survives a restart; not the temp folder). */
  dir: string;
  activity(): Activity;
  /** kiosk.json `updateWindow` ("02:00-05:00"), used when the assignment has none. */
  localWindow?: { start: string; end: string } | null;
  /** Run the installer, detached. Throws when it cannot start. */
  runInstaller(file: string, args: string[]): void;
  /** Quit the app (the installer restarts it). */
  quit(): void;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (m: string) => void;
  checkEveryMs?: number;
  /** Re-evaluates an automatic install of a downloaded release this often. */
  installTickMs?: number;
}

const K = { ready: 'update.ready', pending: 'update.pending', failures: 'update.failures' } as const;
/** An install that has not come back in this long failed. */
const INSTALL_TIMEOUT_MS = 15 * 60_000;

export class UpdateManager {
  private state: UpdateView;
  private ready: Ready | null = null;
  private offer: UpdateOffer | null = null;
  private checking: Promise<{ available: string | null; status: string }> | null = null;
  private timers: NodeJS.Timeout[] = [];
  private listeners = new Set<(v: UpdateView) => void>();
  private installing = false;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly d: UpdaterDeps) {
    this.now = d.now ?? Date.now;
    this.log = d.log ?? (() => undefined);
    this.fetchFn = d.fetch ?? ((...a) => fetch(...a));
    this.state = {
      current: d.currentVersion,
      phase: 'idle',
      available: null,
      progress: null,
      message: null,
      lastCheckAt: null,
      autoInstall: false,
      installWindow: d.localWindow ?? null,
    };
    mkdirSync(d.dir, { recursive: true });
    const saved = d.kv.getJson<Ready>(K.ready);
    if (saved && saved.versionName !== d.currentVersion && existsSync(saved.file)) {
      this.ready = saved;
      this.set({ phase: 'ready', available: saved.versionName, autoInstall: saved.autoInstall, installWindow: saved.installWindow ?? d.localWindow ?? null });
    } else if (saved) {
      d.kv.delete(K.ready);
    }
  }

  /* ----------------------------------------------------------------- view */

  view(): UpdateView {
    return { ...this.state };
  }

  onChange(fn: (v: UpdateView) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private set(patch: Partial<UpdateView>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.view());
  }

  /* ------------------------------------------------------------ lifecycle */

  start() {
    void this.confirmInstalled();
    const every = this.d.checkEveryMs ?? 15 * 60_000;
    this.timers.push(setTimeout(() => void this.checkNow().catch(() => undefined), 60_000));
    this.timers.push(setInterval(() => void this.checkNow().catch(() => undefined), every));
    this.timers.push(setInterval(() => void this.autoTick(), this.d.installTickMs ?? 30_000));
  }

  stop() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  /* --------------------------------------------------------------- report */

  private async report(releaseId: string, status: ReportStatus, message?: string): Promise<boolean> {
    const id = this.d.machineId();
    if (!id) return false;
    const reply = await this.d.api.post(`sync/${id}/app-update/status`, {
      releaseId,
      status,
      versionName: this.d.currentVersion,
      ...(message ? { message: message.slice(0, 500) } : {}),
    });
    return reply.kind === 'ok';
  }

  /** After a restart: did the installer take? Reported once the cloud hears it. */
  async confirmInstalled(): Promise<void> {
    const p = this.d.kv.getJson<Pending>(K.pending);
    if (!p) return;
    if (p.versionName === this.d.currentVersion) {
      if (await this.report(p.releaseId, 'installed')) this.d.kv.delete(K.pending);
      this.clearReady();
      this.cleanup(null);
      return;
    }
    if (this.now() - p.at < INSTALL_TIMEOUT_MS) return;
    const why = `ההתקנה לא הושלמה: רצה ${this.d.currentVersion} במקום ${p.versionName}`;
    if (await this.report(p.releaseId, 'failed', why)) this.d.kv.delete(K.pending);
    this.set({ phase: 'failed', message: why });
  }

  /* ---------------------------------------------------------------- check */

  /** "בדוק עכשיו", the timer, and "התקן עכשיו" when nothing is ready yet. Never two at once. */
  checkNow(): Promise<{ available: string | null; status: string }> {
    if (!this.checking) {
      this.checking = this.doCheck().finally(() => {
        this.checking = null;
      });
    }
    return this.checking;
  }

  private async doCheck(): Promise<{ available: string | null; status: string }> {
    const id = this.d.machineId();
    if (!id) return { available: null, status: 'not_paired' };
    if (this.installing) return { available: this.state.available, status: 'installing' };
    // An "installed" the cloud did not hear at start (offline then).
    if (this.d.kv.getJson<Pending>(K.pending)) await this.confirmInstalled();
    const prevPhase = this.state.phase;
    if (prevPhase !== 'downloading') this.set({ phase: 'checking' });
    const v = this.d.currentVersion;
    const q = `versionCode=${versionCodeOf(v)}&versionName=${encodeURIComponent(v)}&platform=windows`;
    const reply = await this.d.api.get<UpdateOffer>(`sync/${id}/app-update?${q}`, { timeoutMs: 20_000 });
    this.set({ lastCheckAt: this.now() });
    if (reply.kind !== 'ok') {
      const message = reply.kind === 'offline' ? 'אין חיבור לענן' : `השרת השיב ${reply.status}`;
      this.set({ phase: this.ready ? 'ready' : prevPhase === 'checking' ? 'idle' : prevPhase, message });
      return { available: this.ready?.versionName ?? null, status: 'offline' };
    }
    const offer = reply.body;
    if (!acceptOffer(offer, v)) {
      this.offer = null;
      this.clearReady();
      this.cleanup(null);
      this.set({ phase: 'up_to_date', available: null, progress: null, message: null, autoInstall: false, installWindow: this.d.localWindow ?? null });
      return { available: null, status: 'up_to_date' };
    }
    this.offer = offer;
    const releaseId = offer.releaseId!;
    const window = offer.installWindow ?? this.d.localWindow ?? null;
    this.set({ available: offer.versionName, autoInstall: offer.autoInstall === true, installWindow: window });
    if (this.ready?.releaseId === releaseId && existsSync(this.ready.file)) {
      // The assignment may have changed its install rules since.
      this.ready = { ...this.ready, autoInstall: offer.autoInstall === true, installWindow: offer.installWindow ?? null };
      this.d.kv.setJson(K.ready, this.ready);
      this.set({ phase: 'ready', message: null });
      return { available: offer.versionName, status: 'ready' };
    }
    const fails = this.d.kv.getJson<{ releaseId: string; count: number; at: number }>(K.failures);
    if (fails?.releaseId === releaseId && this.now() - fails.at < retryDelayMs(fails.count)) {
      this.set({ phase: 'failed' });
      return { available: offer.versionName, status: 'failed' };
    }
    return this.download(offer);
  }

  private async download(offer: UpdateOffer): Promise<{ available: string | null; status: string }> {
    const id = this.d.machineId()!;
    const releaseId = offer.releaseId!;
    const part = path.join(this.d.dir, `${releaseId}.exe.part`);
    const file = path.join(this.d.dir, `${releaseId}.exe`);
    // Another release replaces whatever was waiting.
    if (this.ready && this.ready.releaseId !== releaseId) this.clearReady();
    this.cleanup(releaseId);
    this.set({ phase: 'downloading', progress: 0, message: null });
    void this.report(releaseId, 'downloading');
    try {
      const res = await this.fetchFn(this.d.api.url(`sync/${id}/app-update/${releaseId}/apk`), {
        headers: { Authorization: `Bearer ${this.d.token() ?? ''}`, 'Accept-Encoding': 'identity' },
        signal: AbortSignal.timeout(30 * 60_000),
      });
      if (!res.ok || !res.body) throw new Error(`הורדה נכשלה: HTTP ${res.status}`);
      const total = offer.sizeBytes ?? Number(res.headers.get('content-length') ?? 0);
      const out = createWriteStream(part);
      const hash = createHash('sha256');
      let size = 0;
      let head = Buffer.alloc(0);
      let lastShown = 0;
      const reader = res.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          hash.update(value);
          size += value.byteLength;
          if (head.length < 2) head = Buffer.concat([head, Buffer.from(value.subarray(0, 2))]);
          if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
          if (total > 0 && size - lastShown > total / 50) {
            lastShown = size;
            this.set({ progress: Math.min(1, size / total) });
          }
        }
      } finally {
        await new Promise<void>((r) => out.end(() => r()));
      }
      if (head[0] !== 0x4d || head[1] !== 0x5a) throw new Error('הקובץ אינו מתקין Windows');
      if (!verifies({ sha256: offer.sha256!, sizeBytes: offer.sizeBytes }, { sha256: hash.digest('hex'), sizeBytes: size })) throw new Error('בדיקת SHA-256 נכשלה — הקובץ נמחק');
      rmSync(file, { force: true });
      renameSync(part, file);
      this.ready = {
        releaseId,
        versionName: offer.versionName!,
        file,
        sha256: offer.sha256!.toLowerCase(),
        sizeBytes: size,
        autoInstall: offer.autoInstall === true,
        installWindow: offer.installWindow ?? null,
      };
      this.d.kv.setJson(K.ready, this.ready);
      this.d.kv.delete(K.failures);
      this.set({ phase: 'ready', progress: 1, message: null });
      await this.report(releaseId, 'downloaded');
      this.log(`update ${offer.versionName} downloaded and verified`);
      return { available: offer.versionName, status: 'ready' };
    } catch (e) {
      rmSync(part, { force: true });
      const why = e instanceof Error ? e.message : String(e);
      const prev = this.d.kv.getJson<{ releaseId: string; count: number }>(K.failures);
      this.d.kv.setJson(K.failures, { releaseId, count: prev?.releaseId === releaseId ? prev.count + 1 : 1, at: this.now() });
      this.set({ phase: 'failed', progress: null, message: why });
      await this.report(releaseId, 'failed', why);
      this.log(`update ${offer.versionName} failed: ${why}`);
      return { available: offer.versionName, status: 'failed' };
    }
  }

  /* -------------------------------------------------------------- install */

  /** The timer: an `autoInstall` release that is ready goes in when the rules allow. */
  async autoTick(): Promise<boolean> {
    if (!this.ready || this.installing) return false;
    const decision = autoInstallDecision({
      offer: { autoInstall: this.ready.autoInstall, installWindow: this.ready.installWindow },
      localWindow: this.d.localWindow ?? null,
      activity: this.d.activity(),
      now: new Date(this.now()),
    });
    if (!decision.install) {
      if (this.state.message !== decision.wait) this.set({ message: decision.wait });
      return false;
    }
    const r = await this.install();
    return r.ok;
  }

  /** "התקן עכשיו" (technician). Refused during an order or a payment. */
  async installNow(): Promise<{ ok: boolean; message?: string }> {
    const guard = manualInstallDecision(this.d.activity());
    if (!guard.install) return { ok: false, message: guard.wait };
    if (!this.ready || !existsSync(this.ready.file)) {
      const r = await this.checkNow();
      if (r.status !== 'ready' || !this.ready) return { ok: false, message: r.status === 'up_to_date' ? 'הגרסה עדכנית' : (this.state.message ?? 'אין עדכון מוכן') };
    }
    // The download took time: the rule once more.
    const again = manualInstallDecision(this.d.activity());
    if (!again.install) return { ok: false, message: again.wait };
    return this.install();
  }

  private async install(): Promise<{ ok: boolean; message?: string }> {
    const r = this.ready!;
    this.installing = true;
    try {
      const sha = await sha256File(r.file);
      if (!verifies({ sha256: r.sha256, sizeBytes: r.sizeBytes }, { sha256: sha, sizeBytes: statSync(r.file).size })) {
        this.clearReady();
        rmSync(r.file, { force: true });
        this.set({ phase: 'failed', message: 'הקובץ השתנה בדיסק — יורד מחדש' });
        await this.report(r.releaseId, 'failed', 'checksum mismatch before install');
        return { ok: false, message: 'בדיקת SHA-256 נכשלה' };
      }
      this.set({ phase: 'installing', message: null });
      await this.report(r.releaseId, 'installing');
      this.d.kv.setJson(K.pending, { releaseId: r.releaseId, versionName: r.versionName, fromVersion: this.d.currentVersion, at: this.now() } satisfies Pending);
      try {
        // NSIS (electron-builder, per-user): silent, replaces the app, starts it again.
        this.d.runInstaller(r.file, ['/S', '--force-run']);
      } catch (e) {
        this.d.kv.delete(K.pending);
        const why = `ההתקנה לא התחילה: ${e instanceof Error ? e.message : String(e)}`;
        this.set({ phase: 'failed', message: why });
        await this.report(r.releaseId, 'failed', why);
        return { ok: false, message: why };
      }
      this.log(`installing ${r.versionName}; quitting`);
      setTimeout(() => this.d.quit(), 1_000);
      return { ok: true, message: `מתקין ${r.versionName}…` };
    } finally {
      // Stays "installing" until the app quits; a failure above frees it.
      if (this.state.phase !== 'installing') this.installing = false;
    }
  }

  /* --------------------------------------------------------------- files */

  private clearReady() {
    this.ready = null;
    this.d.kv.delete(K.ready);
  }

  /** Every installer but `keep`'s goes. */
  private cleanup(keep: string | null) {
    try {
      for (const f of readdirSync(this.d.dir)) {
        if (keep && f.startsWith(keep)) continue;
        rmSync(path.join(this.d.dir, f), { force: true });
      }
    } catch {
      /* nothing to clean */
    }
  }
}

export function sha256File(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha256');
    createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('error', reject)
      .on('end', () => resolve(h.digest('hex')));
  });
}
