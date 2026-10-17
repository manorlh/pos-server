/**
 * The Windows 7 build (P:/specs/windows7-till.md): the pure rules (core/appBuild.ts — the till-only lock, the update
 * platform, the GPU), the role manager locking every other role, the Electron 22 adapters (stream protocols,
 * better-sqlite3 behind db/sqlite.ts, nativeImage variants), the floor scan, and the legacy package's config.
 */

import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  appBuildOf,
  applyBuildRoles,
  gpuDecision,
  gpuSettingOf,
  GPU_CRASH_WINDOW_MS,
  licenseProductFor,
  ntMajorOf,
  recentGpuCrashes,
  rolesOf,
  updatePlatformOf,
  WIN7_TILL_ONLY_TITLE,
} from '../src/core/appBuild';
import { paramsOf } from '../src/core/workMode';
import { RoleManager } from '../src/main/roles/manager';
import { KioskService } from '../src/main/service';
import type { Transport } from '../src/main/printer/transports';
import { handleScheme, legacyReplyOf, schemeRequestOf, textReply, unhandleScheme, type LegacyReply, type ProtocolLike } from '../src/main/shell/schemeHandler';
import { betterSqliteEngine } from '../src/main/db/sqlite';
import { nativeImageVariantMaker } from '../src/main/media/nativeVariant';
import { APP_ID, DATA_DIR_NAME } from '../src/main/shell/identity';
// @ts-expect-error a plain .mjs build script (no types)
import { scanText, unguardedColours } from '../scripts/win7Floor.mjs';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const root = path.resolve(here, '..');

describe('the build and its roles (core/appBuild.ts)', () => {
  it('knows the build only from the bundle define', () => {
    expect(appBuildOf('win7')).toBe('win7');
    expect(appBuildOf(' WIN7 ')).toBe('win7');
    expect(appBuildOf(undefined)).toBe('standard');
    expect(appBuildOf('standard')).toBe('standard');
    expect(appBuildOf('windows7')).toBe('standard');
  });

  it('the Windows 7 build runs the till only; the standard build every role', () => {
    expect(rolesOf('win7')).toEqual(['till']);
    expect(rolesOf('standard')).toBe('all');
    expect(applyBuildRoles('win7', 'till')).toEqual({ role: 'till', lock: null });
    expect(applyBuildRoles('win7', null)).toEqual({ role: null, lock: null });
    for (const role of ['kiosk', 'kds', 'order_status_board', 'customer_display', 'cash_host'] as const) {
      const r = applyBuildRoles('win7', role);
      expect(r.role).toBe(null);
      expect(r.lock?.role).toBe(role);
      expect(r.lock?.title).toBe('גרסת Windows 7 תומכת בקופה בלבד');
      expect(applyBuildRoles('standard', role)).toEqual({ role, lock: null });
    }
    expect(WIN7_TILL_ONLY_TITLE).toBe('גרסת Windows 7 תומכת בקופה בלבד');
  });

  it('the kiosk mode of "מצב עבודה" never opens on the Windows 7 build, whatever the license', () => {
    expect(licenseProductFor('win7', 'kiosk_till')).toBe('till');
    expect(licenseProductFor('win7', null)).toBe('till');
    expect(licenseProductFor('standard', 'kiosk_till')).toBe('kiosk_till');
    expect(paramsOf({ kioskTillModeEnabled: true }, licenseProductFor('win7', 'kiosk_till')).enabled).toBe(false);
    expect(paramsOf({ kioskTillModeEnabled: true }, licenseProductFor('standard', 'kiosk_till')).enabled).toBe(true);
  });

  it('asks the cloud for windows7 on Windows 7 / 8.1, windows once the PC runs Windows 10+', () => {
    expect(ntMajorOf('6.1.7601')).toBe(6);
    expect(ntMajorOf('10.0.19045')).toBe(10);
    expect(ntMajorOf('')).toBe(null);
    expect(updatePlatformOf('win7', '6.1.7601')).toBe('windows7');
    expect(updatePlatformOf('win7', '6.3.9600')).toBe('windows7');
    expect(updatePlatformOf('win7', '10.0.19045')).toBe('windows');
    // Unknown: never risk an Electron 44 installer on Windows 7.
    expect(updatePlatformOf('win7', null)).toBe('windows7');
    expect(updatePlatformOf('standard', '6.1.7601')).toBe('windows');
    expect(updatePlatformOf('standard', '10.0.26100')).toBe('windows');
  });

  it('the GPU: unchanged on the standard build; on Windows 7 Chromium decides, off after crashes or by setting', () => {
    expect(gpuSettingOf('OFF')).toBe('off');
    expect(gpuSettingOf(false)).toBe('off');
    expect(gpuSettingOf(true)).toBe('on');
    expect(gpuSettingOf('x')).toBe('auto');
    expect(gpuSettingOf(undefined)).toBe('auto');
    const smooth = ['enable-gpu-rasterization', 'ignore-gpu-blocklist'];
    expect(gpuDecision({ build: 'standard', setting: 'auto', recentCrashes: 5 })).toMatchObject({ disable: false, switches: smooth });
    expect(gpuDecision({ build: 'standard', setting: 'off', recentCrashes: 0 })).toMatchObject({ disable: true, switches: [] });
    expect(gpuDecision({ build: 'win7', setting: 'auto', recentCrashes: 0 })).toMatchObject({ disable: false, switches: [] });
    expect(gpuDecision({ build: 'win7', setting: 'auto', recentCrashes: 1 })).toMatchObject({ disable: false });
    expect(gpuDecision({ build: 'win7', setting: 'auto', recentCrashes: 2 })).toMatchObject({ disable: true });
    expect(gpuDecision({ build: 'win7', setting: 'on', recentCrashes: 9 })).toMatchObject({ disable: false, switches: smooth });
    expect(gpuDecision({ build: 'win7', setting: 'off', recentCrashes: 0 })).toMatchObject({ disable: true });
    const now = 10 * GPU_CRASH_WINDOW_MS;
    expect(recentGpuCrashes([now - GPU_CRASH_WINDOW_MS - 1, now - 1000, 'x', now + 5, now - 10], now)).toEqual([now - 1000, now - 10]);
    expect(recentGpuCrashes(null, now)).toEqual([]);
  });
});

/* ------------------------------------------------------------------ the role manager */

const noPrinter: Transport = { send: async () => undefined, status: async () => ({ health: 'ok', detail: null }), list: async () => [], dispose: () => undefined };
const MACHINE = '549e903c-4aba-4528-bc4a-c61b4019a64e';
const SHOP = '2b67dd9e-6541-43eb-b2f3-6d26b6ecb03d';
const UPDATE = { current: '0.5.11', phase: 'idle' as const, available: null, progress: null, message: null, lastCheckAt: null, autoInstall: false, installWindow: null };

function device(deviceRole: string, kioskSnapshot: Record<string, unknown> | null, build: 'win7' | 'standard') {
  const fetchFn: typeof fetch = async () => new Response(JSON.stringify(kioskSnapshot ?? { kiosk: false }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  const svc = new KioskService({
    dataDir: mkdtempSync(path.join(os.tmpdir(), 'kd-win7-')),
    appVersion: '0.5.11',
    deviceInfo: { model: 'Windows kiosk', platform: 'windows', appBuild: 'win7' },
    transport: noPrinter,
    fetch: fetchFn,
    downloader: async () => {
      throw new Error('no media here');
    },
  });
  svc.cloud.setCredentials({ serverUrl: 'http://localhost:8001/api/v1/', accessToken: 't', machineId: MACHINE, machineCode: null, tenantId: null, shopId: SHOP, mqttClientId: null, realtimeChannel: null, pairedAt: '2026-10-17T00:00:00Z' });
  svc.api.setBase('http://localhost:8001/api/v1/');
  svc.cloud.setMachine({ machineId: MACHINE, machineName: 'קופה 1', deviceRole, shopId: SHOP });
  if (kioskSnapshot) svc.cloud.setKioskSnapshot(kioskSnapshot);
  const roles = new RoleManager(svc, () => UPDATE, () => undefined, {}, build);
  roles.recompute();
  return { svc, roles };
}

const KIOSK = { kiosk: true, homeRole: 'kiosk', configVersion: 'v1', machineId: MACHINE, name: 'קיוסק 1', config: {}, workMode: null };

describe('the role manager on the Windows 7 build', () => {
  it('a till runs as a till', () => {
    const { svc, roles } = device('till', null, 'win7');
    expect(roles.role()).toBe('till');
    expect(roles.roleLock()).toBe(null);
    expect(roles.view().roleLock).toBe(null);
    expect(svc.fiscal).toBe(true);
    svc.stop();
  });

  it('a kiosk is refused: no role, the lock in the view, nothing fiscal', () => {
    const { svc, roles } = device('kiosk', KIOSK, 'win7');
    expect(roles.role()).toBe(null);
    expect(roles.roleLock()?.role).toBe('kiosk');
    const v = roles.view();
    expect(v.role).toBe(null);
    expect(v.fiscal).toBe(false);
    expect(v.roleLock?.title).toBe('גרסת Windows 7 תומכת בקופה בלבד');
    expect(svc.fiscal).toBe(false);
    svc.stop();
  });

  it('a KDS / board / cash server is refused too; the same device on the standard build runs it', () => {
    for (const role of ['kds', 'order_status_board', 'cash_host']) {
      const w7 = device(role, null, 'win7');
      expect(w7.roles.role()).toBe(null);
      expect(w7.roles.roleLock()?.role).toBe(role);
      w7.roles.stop();
      w7.svc.stop();
    }
    const std = device('kiosk', KIOSK, 'standard');
    expect(std.roles.role()).toBe('kiosk');
    expect(std.roles.roleLock()).toBe(null);
    std.svc.stop();
  });
});

/* ------------------------------------------------------------------ Electron 22 adapters */

async function drain(r: Readable): Promise<string> {
  const parts: Buffer[] = [];
  for await (const c of r) parts.push(Buffer.from(c as Buffer));
  return Buffer.concat(parts).toString('utf8');
}

describe('the URL schemes on Electron 22 (shell/schemeHandler.ts)', () => {
  it('uses registerStreamProtocol where protocol.handle is missing', async () => {
    let registered: ((req: { url: string; method?: string; headers?: Record<string, string> }, cb: (r: LegacyReply) => void) => void) | null = null;
    const unregistered: string[] = [];
    const legacy: ProtocolLike = {
      registerStreamProtocol: (_scheme, h) => {
        registered = h;
      },
      unregisterProtocol: (s) => {
        unregistered.push(s);
      },
    };
    const how = handleScheme(legacy, 'kiosk', (req) => ({ status: 206, headers: { 'X-Range': req.headers.get('range') ?? '' }, body: Readable.from([Buffer.from(`${req.method} ${req.url}`)]) }));
    expect(how).toBe('stream');
    const reply = await new Promise<LegacyReply>((resolve) => registered!({ url: 'kiosk://app/index.html', headers: { Range: 'bytes=0-1' } }, resolve));
    expect(reply.statusCode).toBe(206);
    expect(reply.headers['X-Range']).toBe('bytes=0-1');
    expect(await drain(reply.data)).toBe('GET kiosk://app/index.html');
    // A handler that throws answers 500, never hangs the page.
    handleScheme(legacy, 'r2m', () => {
      throw new Error('boom');
    });
    const failed = await new Promise<LegacyReply>((resolve) => registered!({ url: 'r2m://app/x' }, resolve));
    expect(failed.statusCode).toBe(500);
    unhandleScheme(legacy, 'r2m');
    expect(unregistered).toEqual(['r2m']);
  });

  it('uses protocol.handle (Response) where it exists', async () => {
    let handler: ((req: Request) => Promise<Response>) | null = null;
    const modern = { handle: (_s: string, h: unknown) => (handler = h as (req: Request) => Promise<Response>) } as unknown as ProtocolLike;
    expect(handleScheme(modern, 'kiosk', () => textReply(404, 'not found'))).toBe('handle');
    const res = await handler!(new Request('kiosk://media/x'));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe('not found');
  });

  it('reads headers in any case and turns text / nothing into streams', async () => {
    const req = schemeRequestOf({ url: 'kiosk://media/a.mp4', headers: { RANGE: 'bytes=5-' } });
    expect(req.headers.get('range')).toBe('bytes=5-');
    expect(req.method).toBe('GET');
    expect(await drain(legacyReplyOf(textReply(404, 'nope')).data)).toBe('nope');
    expect(await drain(legacyReplyOf({ status: 416, headers: {}, body: null }).data)).toBe('');
  });
});

describe('better-sqlite3 behind db/sqlite.ts (the Windows 7 engine)', () => {
  it('binds a Uint8Array as a Buffer, answers get / all of a statement with no rows as node:sqlite does', () => {
    const calls: Array<{ sql: string; op: string; params: unknown[] }> = [];
    class FakeBetter {
      constructor(readonly path: string) {}
      exec(sql: string) {
        calls.push({ sql, op: 'exec', params: [] });
      }
      prepare(sql: string) {
        const reader = /^\s*select/i.test(sql);
        return {
          reader,
          run: (...params: unknown[]) => (calls.push({ sql, op: 'run', params }), { changes: 1, lastInsertRowid: 3 }),
          get: (...params: unknown[]) => {
            if (!reader) throw new TypeError('This statement does not return data. Use run() instead');
            calls.push({ sql, op: 'get', params });
            return { a: 1 };
          },
          all: (...params: unknown[]) => {
            if (!reader) throw new TypeError('This statement does not return data. Use run() instead');
            calls.push({ sql, op: 'all', params });
            return [{ a: 1 }];
          },
        };
      }
      close() {}
    }
    const Ctor = betterSqliteEngine(FakeBetter);
    const db = new Ctor('x.db');
    const bytes = new Uint8Array([1, 2, 3]);
    expect(db.prepare('INSERT INTO t VALUES (?, ?)').run(1, bytes)).toEqual({ changes: 1, lastInsertRowid: 3 });
    const bound = calls[0].params[1];
    expect(Buffer.isBuffer(bound)).toBe(true);
    expect([...(bound as Buffer)]).toEqual([1, 2, 3]);
    expect(db.prepare('UPDATE t SET a = 1').get()).toBe(undefined);
    expect(db.prepare('DELETE FROM t').all()).toEqual([]);
    expect(calls.filter((c) => c.op === 'run').length).toBe(3);
    expect(db.prepare('SELECT a FROM t').get()).toEqual({ a: 1 });
  });
});

describe('picture variants without sharp (media/nativeVariant.ts)', () => {
  it('resizes what nativeImage reads, leaves narrow and unreadable pictures alone', async () => {
    const written: string[] = [];
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kd-variant-'));
    const fake = {
      createFromPath: (p: string) => ({
        isEmpty: () => p.endsWith('.webp'),
        getSize: () => ({ width: p.includes('wide') ? 2000 : 300, height: 100 }),
        resize: (o: { width: number }) => ({ toPNG: () => (written.push(`${p}@${o.width}`), Buffer.from('png')) }),
      }),
    };
    const make = nativeImageVariantMaker(fake);
    expect(await make('wide.jpg', 480, path.join(dir, 'a.w480.webp'))).toBe(true);
    expect(await make('narrow.jpg', 480, path.join(dir, 'b.w480.webp'))).toBe(false);
    expect(await make('pic.webp', 480, path.join(dir, 'c.w480.webp'))).toBe(false);
    expect(written).toEqual(['wide.jpg@480']);
  });
});

/* ------------------------------------------------------------------ the floor scan and the package */

describe('the floor scan (scripts/win7Floor.mjs)', () => {
  it('finds built-ins newer than Chromium 108 / V8 10.8, unless only feature-detected', () => {
    expect(scanText('a.js', 'x.toSorted((a,b)=>a-b)')).toHaveLength(1);
    expect(scanText('a.js', 'Object.groupBy(xs, f); Promise.withResolvers()')).toHaveLength(2);
    expect(scanText('a.js', 'xs.slice().sort()')).toEqual([]);
    expect(scanText('a.js', 'var Q=!!String.prototype.toWellFormed;function T(t){return Q?`${t}`.toWellFormed():t}')).toEqual([]);
    expect(scanText('a.js', 's.toWellFormed()')).toHaveLength(1);
  });

  it('CSS: modern colours only behind @supports, no @starting-style', () => {
    expect(unguardedColours('.a{color:#f00}@supports (color:lab(0% 0 0)){.a{color:oklch(60% .2 20)}}')).toEqual([]);
    expect(unguardedColours('.a{color:oklch(60% .2 20)}')).toEqual(['oklch']);
    expect(unguardedColours('@media (min-width:1px){.a{background:color-mix(in srgb,red,blue)}}')).toEqual(['color-mix']);
    expect(scanText('a.css', '@starting-style{.a{opacity:0}}')).toHaveLength(1);
    expect(scanText('p.html', '<style>.a{color:oklch(1 0 0)}</style>')).toHaveLength(1);
  });
});

describe('the legacy package (kiosk-desktop/legacy)', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'legacy', 'package.json'), 'utf8'));
  const main = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const script = readFileSync(path.join(root, 'scripts', 'build-win7.mjs'), 'utf8');

  it('Electron 22.3.x, pinned in one place and the same in the build script', () => {
    expect(pkg.devDependencies.electron).toMatch(/^22\.3\.\d+$/);
    expect(pkg.build.electronVersion).toBe(pkg.devDependencies.electron);
    expect(script).toContain(`ELECTRON_WIN7 = '${pkg.devDependencies.electron}'`);
  });

  it('the same app identity and data folder as the standard build (a Windows 10 upgrade keeps the data)', () => {
    expect(pkg.build.appId).toBe(APP_ID);
    expect(pkg.build.productName).toBe(DATA_DIR_NAME);
    expect(pkg.productName).toBe(main.productName);
    expect(pkg.build.win.artifactName).toBe('R2M-POS-Win7-Till-setup-${version}.${ext}');
  });

  it('natives that run on Electron 22 / Node 16 only — no sharp (Node 18+), no koffi (the cash host is not a Windows 7 role)', () => {
    expect(Object.keys(pkg.dependencies).sort()).toEqual(['better-sqlite3', 'serialport']);
    expect(pkg.dependencies['better-sqlite3']).toBe('9.6.0');
    expect(pkg.devDependencies.undici).toMatch(/^5\./);
    expect(pkg.devDependencies['@types/node']).toMatch(/^16\./);
    expect(pkg.build.npmRebuild).toBe(false);
  });

  it('the Node 16 type check keeps to ES2022 and the Node 16 / Electron 22 types', () => {
    const ts = JSON.parse(readFileSync(path.join(root, 'tsconfig.legacy.json'), 'utf8'));
    expect(ts.compilerOptions.lib).toEqual(['ES2022']);
    expect(ts.compilerOptions.paths.electron[0]).toContain('legacy/node_modules/electron');
    expect(main.scripts['dist:win7']).toBe('node scripts/build-win7.mjs');
  });
});

describe('the spooler helper on PowerShell 2.0 (Windows 7)', () => {
  it('falls back to JavaScriptSerializer and Get-WmiObject below PowerShell 3, and only there', async () => {
    const { SPOOLER_HELPER_PS1 } = await import('../src/main/printer/transports');
    expect(SPOOLER_HELPER_PS1).toContain("$R2mLegacy = ($PSVersionTable.PSVersion.Major -lt 3) -or ($env:R2M_PS_LEGACY -eq '1')");
    expect(SPOOLER_HELPER_PS1).toContain('System.Web.Script.Serialization.JavaScriptSerializer');
    expect(SPOOLER_HELPER_PS1).toContain('Get-WmiObject -Class $class');
    // Every PowerShell 3+ call sits in the R2mFromJson / R2mToJson / R2mWmi wrappers (their `return` lines), none in the loop.
    const direct = SPOOLER_HELPER_PS1.split('\n').filter((l) => /ConvertFrom-Json|ConvertTo-Json|Get-CimInstance/.test(l) && !l.includes('return'));
    expect(direct).toEqual([]);
  });

  it.skipIf(process.platform !== 'win32')('answers list / send the same way on the PowerShell 2 path (forced here)', async () => {
    const { spawn } = await import('node:child_process');
    const { SPOOLER_HELPER_PS1 } = await import('../src/main/printer/transports');
    const run = (legacy: boolean) =>
      new Promise<Array<Record<string, unknown>>>((resolve) => {
        const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(SPOOLER_HELPER_PS1, 'utf16le').toString('base64')], {
          windowsHide: true,
          env: { ...process.env, R2M_PS_LEGACY: legacy ? '1' : '' },
        });
        let out = '';
        p.stdout.on('data', (d) => (out += String(d)));
        p.stdin.write(`${JSON.stringify({ id: 'l', op: 'list' })}\n${JSON.stringify({ id: 's', op: 'send', printer: 'R2M no such printer', data: Buffer.from('x').toString('base64') })}\n`);
        p.stdin.end();
        p.on('exit', () => resolve(out.split(/\r?\n/).filter((l) => l.startsWith('{')).map((l) => JSON.parse(l) as Record<string, unknown>)));
      });
    const [modern, legacy] = await Promise.all([run(false), run(true)]);
    const shape = (rows: Array<Record<string, unknown>>) => rows.map((r) => ({ id: r.id ?? null, ok: r.ok ?? null, ready: r.ready ?? null, n: Array.isArray(r.printers) ? r.printers.length : null, error: r.error ?? null }));
    expect(shape(legacy)).toEqual(shape(modern));
    expect(legacy.find((r) => r.id === 's')).toMatchObject({ ok: false, error: 'open:1801' });
  }, 60_000);
});
