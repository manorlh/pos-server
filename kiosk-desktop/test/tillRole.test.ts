/**
 * S0-6: the Windows till role, Electron-free — the one app bundle verified file by file (and by
 * its Ed25519 signature once a release key is pinned) before anything is served at r2m://app/,
 * the downloaded bundle preferred, a bad one never chosen again, the page's door that refuses
 * hardware answers, the updater kept off a busy till, and the bundled engine's command line.
 */
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { APP_MANIFEST, APP_SIGNATURE, buildAppManifest, ed25519Valid, resolveAppPath, safeBundlePath, verifyAppBundleDir } from '../src/main/roles/appBundle';
import { APP_CSP, engineCommand, liteHintOf, PREVIEW_CAPS, TillRole } from '../src/main/roles/till';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tmp(): string {
  const d = mkdtempSync(path.join(os.tmpdir(), 'till-role-'));
  dirs.push(d);
  return d;
}

const INFO = { version: '2026.10.09-2200', versionCode: 931500, builtAt: new Date('2026-10-09T22:00:00Z'), roles: ['till'], protocol: 1, shellApi: { electron: 1 }, bridgeApi: 1, minChrome: 108, minSafari: '16.4' };

function writeBundle(dir: string, files: Record<string, string>, info = INFO): Buffer {
  mkdirSync(dir, { recursive: true });
  const list = Object.entries(files).map(([p, text]) => ({ path: p, bytes: new TextEncoder().encode(text) }));
  for (const f of list) {
    mkdirSync(path.dirname(path.join(dir, f.path)), { recursive: true });
    writeFileSync(path.join(dir, f.path), f.bytes);
  }
  const raw = Buffer.from(`${JSON.stringify(buildAppManifest(list, info), null, 2)}\n`);
  writeFileSync(path.join(dir, APP_MANIFEST), raw);
  return raw;
}

const FILES = { 'index.html': '<!doctype html><title>R2M POS</title>', 'assets/app.js': 'console.log(1)', 'assets/app.css': '.t-root{}' };

describe('the app bundle on disk', () => {
  it('verifies a good bundle, file by file', () => {
    const d = tmp();
    writeBundle(d, FILES);
    const r = verifyAppBundleDir(d, { protocols: [1], role: 'till' });
    expect(r.ok).toBe(true);
  });

  it('refuses a changed file, an extra file, a missing one, another protocol, a bundle without the role', () => {
    const d = tmp();
    writeBundle(d, FILES);
    writeFileSync(path.join(d, 'assets/app.js'), 'console.log(2)');
    writeFileSync(path.join(d, 'assets/evil.js'), 'x');
    rmSync(path.join(d, 'assets/app.css'));
    const r = verifyAppBundleDir(d, { protocols: [2], role: 'kds' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems).toEqual(expect.arrayContaining(['protocol 1', 'role kds', 'sha256 assets/app.js', 'missing assets/app.css', 'unlisted assets/evil.js']));
  });

  it('safe paths only; r2m://app/ serves only listed files, never outside', () => {
    expect(safeBundlePath('assets/app.js')).toBe(true);
    for (const bad of ['../x', '/etc/passwd', 'a\\b', 'C:/x', 'a//b', './a', '']) expect(safeBundlePath(bad)).toBe(false);
    const d = tmp();
    writeBundle(d, FILES);
    const r = verifyAppBundleDir(d, { protocols: [1] });
    if (!r.ok) throw new Error('setup');
    expect(resolveAppPath(d, r.manifest, '/')).toBe(path.join(d, 'index.html'));
    expect(resolveAppPath(d, r.manifest, '/assets/app.js')).toBe(path.join(d, 'assets', 'app.js'));
    expect(resolveAppPath(d, r.manifest, '/manifest.json')).toBeNull();
    expect(resolveAppPath(d, r.manifest, '/%2e%2e/secret')).toBeNull();
    expect(resolveAppPath(d, r.manifest, '/assets/other.js')).toBeNull();
  });

  it('with a pinned release key: only a bundle whose manifest carries a good Ed25519 signature', () => {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x as string, 'base64url');
    const d = tmp();
    const manifest = writeBundle(d, FILES);
    expect(verifyAppBundleDir(d, { protocols: [1], publicKey: raw })).toMatchObject({ ok: false, problems: ['no signature'] });
    const sig = sign(null, manifest, privateKey);
    expect(ed25519Valid(manifest, sig, raw)).toBe(true);
    writeFileSync(path.join(d, APP_SIGNATURE), sig.toString('base64'));
    expect(verifyAppBundleDir(d, { protocols: [1], publicKey: raw }).ok).toBe(true);
    // Another key's signature, or a manifest changed after signing: refused.
    const other = generateKeyPairSync('ed25519');
    writeFileSync(path.join(d, APP_SIGNATURE), sign(null, manifest, other.privateKey));
    expect(verifyAppBundleDir(d, { protocols: [1], publicKey: raw })).toMatchObject({ ok: false, problems: ['bad signature'] });
    expect(ed25519Valid(manifest, sig, new Uint8Array(31))).toBe(false);
  });
});

function role(userData: string, builtIn: string) {
  const logs: string[] = [];
  const r = new TillRole({
    userData,
    builtInBundleDir: builtIn,
    appVersion: '0.5.0',
    device: () => ({ model: 'Windows', os: 'Windows_NT 6.1.7601', screen: { width: 1366, height: 768, dpr: 1 }, installationId: null, shellVersion: '0.5.0', lite: true }),
    caps: () => PREVIEW_CAPS,
    log: (m) => logs.push(m),
  });
  return { r, logs };
}

describe('the till role (main process)', () => {
  it('prefers the verified downloaded bundle, falls back to the installer\'s, never a bad one', () => {
    const userData = tmp();
    const builtIn = path.join(userData, 'resources', 'app-bundle');
    writeBundle(builtIn, FILES);
    const { r } = role(userData, builtIn);
    expect(r.chooseBundle()).toMatchObject({ source: 'built-in' });

    const dl = path.join(userData, 'till', 'bundles', '931600');
    writeBundle(dl, FILES, { ...INFO, versionCode: 931600, version: 'new' });
    writeFileSync(path.join(userData, 'till', 'bundles', 'active.json'), JSON.stringify({ dir: '931600' }));
    expect(r.chooseBundle()).toMatchObject({ source: 'downloaded', manifest: { version: 'new' } });

    r.markBad(dl);
    expect(r.chooseBundle()).toMatchObject({ source: 'built-in' });
    // A pointer out of the bundles folder is ignored.
    writeFileSync(path.join(userData, 'till', 'bundles', 'active.json'), JSON.stringify({ dir: '../../elsewhere' }));
    expect(r.chooseBundle()).toMatchObject({ source: 'built-in' });
  });

  it('a tampered installer bundle and nothing else: no screens (the placeholder stays)', () => {
    const userData = tmp();
    const builtIn = path.join(userData, 'app-bundle');
    writeBundle(builtIn, FILES);
    writeFileSync(path.join(builtIn, 'assets/app.js'), 'console.log(9)'); // same size, other bytes
    const { r, logs } = role(userData, builtIn);
    expect(r.chooseBundle()).toBeNull();
    expect(logs.join('\n')).toContain('sha256 assets/app.js');
    expect(r.serve('/index.html')).toBeNull();
  });

  it('serves with the strict CSP; the page is told its host, and gets no hardware answer to give', async () => {
    const userData = tmp();
    const builtIn = path.join(userData, 'app-bundle');
    writeBundle(builtIn, FILES);
    const { r } = role(userData, builtIn);
    r.chooseBundle();
    const hit = r.serve('/index.html')!;
    expect(hit.headers['Content-Security-Policy']).toBe(APP_CSP);
    expect(APP_CSP).toContain("script-src 'self'");
    expect(APP_CSP).toContain("connect-src 'self'");
    const info = r.info();
    expect(info).toMatchObject({ role: 'till', shellApi: 1, demo: true, bundle: { versionCode: 931500, protocol: 1 } });
    expect(info.caps.print.tcp).toBe(false);
    expect(await r.call({ id: 3, op: 'hw.result', args: { requestId: 'x', ok: true } })).toMatchObject({ ok: false, error: { code: 'permission_denied' } });
    expect(await r.call('nonsense')).toMatchObject({ ok: false, error: { code: 'invalid_args' } });
    expect(await r.call({ id: 4, op: 'sell.add', args: { productId: 'p1' }, clientOpId: 'a' })).toMatchObject({ ok: true });
    expect((await r.hello()).state.sell.lines).toHaveLength(1);
  });

  it('keeps the updater off the till until it drew and while it is busy', () => {
    const { r } = role(tmp(), 'nowhere');
    expect(r.activity()).toMatchObject({ busy: true, idle: false });
    r.reportReady();
    r.reportIdle(false, true, 1000);
    expect(r.activity()).toEqual({ busy: true, idle: false, lastActivityAt: 1000 });
    r.reportIdle(true, false, 2000);
    expect(r.activity()).toEqual({ busy: false, idle: true, lastActivityAt: 2000 });
    r.loading();
    expect(r.activity().busy).toBe(true);
  });
});

describe('the bundled engine (P2) — Java inside the installer, nothing to set up', () => {
  it('runs javaw from the installer\'s jlink image, the lite flags on an old PC', () => {
    const c = engineCommand({ resourcesPath: 'C:\\Program Files\\R2M\\resources', tillDir: 'C:\\Users\\u\\AppData\\Roaming\\R2M Kiosk\\till', machineId: 'm1', lite: true, javaFeature: 17 });
    expect(c.exe).toBe(path.join('C:\\Program Files\\R2M\\resources', 'engine', 'bin', 'javaw.exe'));
    expect(c.args).toEqual(expect.arrayContaining(['-Xmx192m', '-XX:+UseSerialGC', '-XX:TieredStopAtLevel=1', '-XX:ReservedCodeCacheSize=48m', '-Xss512k', '--stdio']));
    // Java 17 makes its class archive on the first run, then uses it.
    expect(c.args.some((a) => a.startsWith('-XX:ArchiveClassesAtExit='))).toBe(true);
    const modern = engineCommand({ resourcesPath: 'R', tillDir: 'T', machineId: 'm1', lite: false, javaFeature: 21 });
    expect(modern.args).toEqual(expect.arrayContaining(['-Xmx256m', '-XX:+AutoCreateSharedArchive']));
  });

  it('the lite hint: Windows 7 / 8.1 or 4 GB', () => {
    expect(liteHintOf({ release: '6.1.7601', totalMemBytes: 8 * 1024 ** 3 })).toBe(true);
    expect(liteHintOf({ release: '6.3.9600', totalMemBytes: 8 * 1024 ** 3 })).toBe(true);
    expect(liteHintOf({ release: '10.0.19045', totalMemBytes: 4 * 1024 ** 3 })).toBe(true);
    expect(liteHintOf({ release: '10.0.22631', totalMemBytes: 16 * 1024 ** 3 })).toBe(false);
  });
});
