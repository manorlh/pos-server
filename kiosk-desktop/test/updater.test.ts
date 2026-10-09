import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  acceptOffer,
  autoInstallDecision,
  inWindow,
  manualInstallDecision,
  newer,
  parseWindow,
  paymentGuard,
  retryDelayMs,
  verifies,
  versionCodeOf,
  type Activity,
  type UpdateOffer,
} from '../src/core/updatePolicy';
import { UpdateManager } from '../src/main/update/updater';
import { Api } from '../src/main/sync/api';
import { openDb } from '../src/main/db/sqlite';
import { Kv, migrate } from '../src/main/db/schema';

const SHA = 'a'.repeat(64);
const offer = (o: Partial<UpdateOffer> = {}): UpdateOffer => ({
  available: true,
  releaseId: 'r1',
  versionCode: 2000,
  versionName: '0.2.0',
  sha256: SHA,
  sizeBytes: 10,
  autoInstall: true,
  platform: 'windows',
  allowDowngrade: false,
  installWindow: null,
  ...o,
});

const quiet: Activity = { role: 'kiosk', screen: 'attract', busy: false, idle: true, cardInFlight: false, cardBlocked: false, lastActivityAt: 0 };
const at = (h: number, m = 0) => new Date(2026, 9, 7, h, m);

describe('update policy (pure)', () => {
  it('takes only a Windows offer, never the version it runs, never lower unless a rollback', () => {
    expect(acceptOffer(offer(), '0.1.0')).toBe(true);
    expect(acceptOffer(offer({ platform: undefined }), '0.1.0')).toBe(false); // an old server: the Android APK
    expect(acceptOffer(offer({ platform: 'android' }), '0.1.0')).toBe(false);
    expect(acceptOffer(offer(), '0.2.0')).toBe(false);
    expect(acceptOffer(offer({ sha256: 'xyz' }), '0.1.0')).toBe(false);
    expect(acceptOffer(offer({ available: false }), '0.1.0')).toBe(false);
    expect(acceptOffer(offer({ versionName: '0.1.5', versionCode: 1005 }), '0.2.0')).toBe(false);
    expect(acceptOffer(offer({ versionName: '0.1.5', versionCode: 1005, allowDowngrade: true }), '0.2.0')).toBe(true);
  });

  it('versions compare numerically, as the cloud computes them', () => {
    expect(versionCodeOf('1.2.3')).toBe(1_002_003);
    expect(versionCodeOf('0.2.0+abc')).toBe(2_000);
    expect(newer('0.9.0', '0.10.0')).toBe(true);
    expect(newer('0.2.0', '0.2.0')).toBe(false);
  });

  it('verifies the SHA-256 (any case) and the size', () => {
    expect(verifies({ sha256: SHA, sizeBytes: 10 }, { sha256: SHA.toUpperCase(), sizeBytes: 10 })).toBe(true);
    expect(verifies({ sha256: SHA, sizeBytes: 10 }, { sha256: 'b'.repeat(64), sizeBytes: 10 })).toBe(false);
    expect(verifies({ sha256: SHA, sizeBytes: 10 }, { sha256: SHA, sizeBytes: 11 })).toBe(false);
    expect(verifies({ sha256: 'short' }, { sha256: 'short', sizeBytes: 1 })).toBe(false);
  });

  it('install windows, also across midnight', () => {
    expect(parseWindow('02:00-05:00')).toEqual({ start: '02:00', end: '05:00' });
    expect(parseWindow('nonsense')).toBe(null);
    const night = { start: '02:00', end: '05:00' };
    expect(inWindow(at(3), night)).toBe(true);
    expect(inWindow(at(5), night)).toBe(false);
    expect(inWindow(at(14), night)).toBe(false);
    const cross = { start: '23:00', end: '04:00' };
    expect(inWindow(at(23, 30), cross)).toBe(true);
    expect(inWindow(at(1), cross)).toBe(true);
    expect(inWindow(at(12), cross)).toBe(false);
    expect(inWindow(at(3), { start: '03:00', end: '03:00' })).toBe(false);
  });

  it('never during an order or a payment — not even "התקן עכשיו"', () => {
    expect(paymentGuard(quiet)).toBe(null);
    expect(paymentGuard({ ...quiet, cardInFlight: true })).toBe('לא בזמן תשלום');
    expect(paymentGuard({ ...quiet, busy: true })).toBe('לא בזמן תשלום');
    expect(paymentGuard({ ...quiet, screen: 'pay' })).toBe('לא בזמן תשלום');
    expect(paymentGuard({ ...quiet, screen: 'success' })).toBe('לא בזמן תשלום');
    expect(paymentGuard({ ...quiet, screen: 'catalog', idle: false })).toBe('יש הזמנה פתוחה');
    expect(manualInstallDecision({ ...quiet, cardInFlight: true })).toEqual({ install: false, wait: 'לא בזמן תשלום' });
    expect(manualInstallDecision({ ...quiet, screen: 'closed' })).toEqual({ install: true });
  });

  it('installs by itself only for autoInstall, when quiet, inside the window', () => {
    const now = at(14);
    const base = { offer: { autoInstall: true, installWindow: null }, activity: { ...quiet, lastActivityAt: now.getTime() - 5 * 60_000 }, now };
    expect(autoInstallDecision(base)).toEqual({ install: true });
    expect(autoInstallDecision({ ...base, offer: { autoInstall: false, installWindow: null } }).install).toBe(false);
    // A customer was here a moment ago.
    expect(autoInstallDecision({ ...base, activity: { ...quiet, lastActivityAt: now.getTime() - 10_000 } }).install).toBe(false);
    // A charge waits for staff.
    expect(autoInstallDecision({ ...base, activity: { ...base.activity, cardBlocked: true } }).install).toBe(false);
    // The assignment's window, else kiosk.json's.
    expect(autoInstallDecision({ ...base, offer: { autoInstall: true, installWindow: { start: '02:00', end: '05:00' } } }).install).toBe(false);
    expect(autoInstallDecision({ ...base, now: at(3), activity: { ...quiet, lastActivityAt: 0 }, offer: { autoInstall: true, installWindow: { start: '02:00', end: '05:00' } } })).toEqual({ install: true });
    expect(autoInstallDecision({ ...base, localWindow: { start: '02:00', end: '05:00' } }).install).toBe(false);
    // A board screen has no customer touching it: no quiet time.
    expect(autoInstallDecision({ ...base, activity: { ...quiet, role: 'order_status_board', screen: '', lastActivityAt: now.getTime() } })).toEqual({ install: true });
  });

  it('backs off after failed downloads', () => {
    expect(retryDelayMs(0)).toBe(0);
    expect(retryDelayMs(1)).toBe(60_000);
    expect(retryDelayMs(3)).toBe(240_000);
    expect(retryDelayMs(30)).toBe(60 * 60_000);
  });
});

/* ------------------------------------------------------------------ the manager */

const INSTALLER = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(4096, 7)]);
const INSTALLER_SHA = createHash('sha256').update(INSTALLER).digest('hex');

function world(opts: { offer?: Partial<UpdateOffer> | null; bytes?: Buffer; activity?: Partial<Activity>; now?: Date; version?: string } = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'r2m-upd-'));
  const db = openDb(path.join(dir, 'k.db'));
  migrate(db);
  const kv = new Kv(db);
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const reports: Array<{ status: string; message?: string; releaseId: string }> = [];
  const bytes = opts.bytes ?? INSTALLER;
  const theOffer = opts.offer === null ? { available: false, releaseId: null, versionCode: null, versionName: null, sha256: null, sizeBytes: null, autoInstall: false, platform: 'windows' } : offer({ sha256: INSTALLER_SHA, sizeBytes: INSTALLER.length, ...opts.offer });
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, url, body });
    if (url.includes('/app-update/status')) {
      reports.push(body);
      return new Response('{}', { status: 200 });
    }
    if (url.includes('/app-update?')) return new Response(JSON.stringify(theOffer), { status: 200 });
    if (url.includes('/app-update/r1/apk')) return new Response(new Uint8Array(bytes), { status: 200, headers: { 'Content-Length': String(bytes.length) } });
    return new Response('{"detail":"Not Found"}', { status: 404 });
  };
  const api = new Api('http://cloud.test/api/v1/', () => 'tok', fetchFn);
  const runInstaller = vi.fn();
  const quit = vi.fn();
  const activity: Activity = { ...quiet, lastActivityAt: 0, ...opts.activity };
  const now = opts.now ?? at(14);
  const m = new UpdateManager({
    api,
    kv,
    machineId: () => 'm1',
    token: () => 'tok',
    currentVersion: opts.version ?? '0.1.0',
    dir: path.join(dir, 'updates'),
    activity: () => activity,
    runInstaller,
    quit,
    fetch: fetchFn,
    now: () => now.getTime(),
  });
  return { m, kv, calls, reports, runInstaller, quit, activity, dir };
}

describe('the updater', () => {
  it('asks as a Windows app, downloads in the background, verifies, reports', async () => {
    const w = world({ offer: { autoInstall: false } });
    const r = await w.m.checkNow();
    expect(r).toEqual({ available: '0.2.0', status: 'ready' });
    const ask = w.calls.find((c) => c.url.includes('/app-update?'))!;
    expect(ask.url).toContain('platform=windows');
    expect(ask.url).toContain('versionCode=1000');
    expect(ask.url).toContain('versionName=0.1.0');
    expect(w.reports.map((x) => x.status)).toEqual(['downloading', 'downloaded']);
    expect(w.m.view()).toMatchObject({ phase: 'ready', available: '0.2.0', autoInstall: false });
    expect(existsSync(path.join(w.dir, 'updates', 'r1.exe'))).toBe(true);
    // Not autoInstall: the timer never installs it.
    expect(await w.m.autoTick()).toBe(false);
    expect(w.runInstaller).not.toHaveBeenCalled();
  });

  it('throws away a file whose SHA-256 is not the cloud’s, and reports why', async () => {
    const w = world({ bytes: Buffer.concat([Buffer.from('MZ'), Buffer.alloc(4096, 8)]) });
    const r = await w.m.checkNow();
    expect(r.status).toBe('failed');
    expect(w.reports.at(-1)).toMatchObject({ status: 'failed', releaseId: 'r1' });
    expect(w.reports.at(-1)!.message).toContain('SHA-256');
    expect(existsSync(path.join(w.dir, 'updates', 'r1.exe'))).toBe(false);
    expect(existsSync(path.join(w.dir, 'updates', 'r1.exe.part'))).toBe(false);
    expect(w.m.view().phase).toBe('failed');
  });

  it('ignores an Android offer (an old server) and says it is up to date', async () => {
    const w = world({ offer: { platform: undefined } });
    expect((await w.m.checkNow()).status).toBe('up_to_date');
    expect(w.calls.some((c) => c.url.includes('/apk'))).toBe(false);
  });

  it('installs an autoInstall release when the kiosk is quiet: silently, then quits', async () => {
    const w = world();
    await w.m.checkNow();
    expect(await w.m.autoTick()).toBe(true);
    expect(w.runInstaller).toHaveBeenCalledWith(path.join(w.dir, 'updates', 'r1.exe'), ['/S', '--force-run']);
    expect(w.reports.map((x) => x.status)).toEqual(['downloading', 'downloaded', 'installing']);
    expect(w.kv.getJson<{ versionName: string }>('update.pending')?.versionName).toBe('0.2.0');
    await vi.waitFor(() => expect(w.quit).toHaveBeenCalled(), { timeout: 3_000 });
  });

  it('never installs during a payment — neither by itself nor by "התקן עכשיו"', async () => {
    const w = world({ activity: { cardInFlight: true, screen: 'pay', busy: true } });
    await w.m.checkNow();
    expect(await w.m.autoTick()).toBe(false);
    expect(w.m.view().message).toBe('לא בזמן תשלום');
    expect(await w.m.installNow()).toEqual({ ok: false, message: 'לא בזמן תשלום' });
    expect(w.runInstaller).not.toHaveBeenCalled();
    expect(w.reports.some((x) => x.status === 'installing')).toBe(false);
  });

  it('waits for the night window', async () => {
    const day = world({ offer: { installWindow: { start: '02:00', end: '05:00' } }, now: at(14) });
    await day.m.checkNow();
    expect(await day.m.autoTick()).toBe(false);
    expect(day.m.view().message).toContain('02:00');
    const night = world({ offer: { installWindow: { start: '02:00', end: '05:00' } }, now: at(3) });
    await night.m.checkNow();
    expect(await night.m.autoTick()).toBe(true);
  });

  it('"התקן עכשיו" downloads first when nothing is ready, outside any window', async () => {
    const w = world({ offer: { autoInstall: false, installWindow: { start: '02:00', end: '05:00' } } });
    const r = await w.m.installNow();
    expect(r.ok).toBe(true);
    expect(w.runInstaller).toHaveBeenCalledTimes(1);
  });

  it('after the restart: installed when the new version runs, failed when it does not', async () => {
    const ok = world({ version: '0.2.0' });
    ok.kv.setJson('update.pending', { releaseId: 'r1', versionName: '0.2.0', fromVersion: '0.1.0', at: at(13).getTime() });
    await ok.m.confirmInstalled();
    expect(ok.reports).toEqual([{ releaseId: 'r1', status: 'installed', versionName: '0.2.0' }]);
    expect(ok.kv.getJson('update.pending')).toBe(null);

    const bad = world({ version: '0.1.0' });
    bad.kv.setJson('update.pending', { releaseId: 'r1', versionName: '0.2.0', fromVersion: '0.1.0', at: at(13).getTime() });
    await bad.m.confirmInstalled();
    expect(bad.reports[0]).toMatchObject({ releaseId: 'r1', status: 'failed' });
    expect(bad.m.view().phase).toBe('failed');
  });
});
