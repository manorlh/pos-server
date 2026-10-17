/**
 * The Windows 7 build's runtime check, under Electron 22's own Node (16.17.1) — no window, nothing shown, the app
 * never started (P:/specs/windows7-till.md §6):
 *
 *   node scripts/build-main.mjs --win7-check
 *   ELECTRON_RUN_AS_NODE=1 legacy/node_modules/electron/dist/electron.exe legacy/dist-check/win7-check.js
 *   ELECTRON_RUN_AS_NODE=1 "<win-unpacked>/R2M Kiosk.exe" <copy outside legacy>/win7-check.js --modules "<win-unpacked>/resources/app.asar/node_modules"
 *
 * It loads Node 16's polyfills as the app does (src/legacy/polyfills.ts), opens the real service on a throw-away data
 * folder (better-sqlite3 behind db/sqlite.ts, every schema migration, the kv, the first view), runs fetch / Response
 * through undici against a local HTTP server, lists the COM ports through serialport, and prints one JSON line.
 * Exit code 0 only when every step passed.
 */

import { LEGACY_POLYFILLED } from '../src/legacy/polyfills';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import Module from 'node:module';
import os from 'node:os';
import path from 'node:path';

const results: Record<string, unknown> = {
  node: process.versions.node,
  electron: process.versions.electron ?? null,
  modules: process.versions.modules,
  polyfilled: LEGACY_POLYFILLED,
};
let ok = true;
const fail = (step: string, e: unknown) => {
  ok = false;
  results[step] = `FAIL: ${e instanceof Error ? e.message : String(e)}`;
};

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

// The packed app's node_modules (inside app.asar: Electron's Node reads it, natives from app.asar.unpacked).
const modules = arg('modules');
if (modules) {
  process.env.NODE_PATH = modules;
  (Module as unknown as { _initPaths(): void })._initPaths();
  results.modulesFrom = modules;
}

async function main() {
  // 1. better-sqlite3 directly: the prebuilt binary for this Electron's ABI.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Better = require('better-sqlite3') as new (p: string) => { prepare(s: string): { get(): unknown }; close(): void };
    const db = new Better(':memory:');
    results.sqlite = db.prepare('select sqlite_version() as v').get();
    db.close();
  } catch (e) {
    fail('sqlite', e);
  }

  // 2. The service itself on a throw-away folder: db/sqlite.ts picks better-sqlite3, the schema migrates, a view is made.
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'r2m-win7-check-'));
  try {
    const { KioskService } = await import('../src/main/service');
    const { openDb } = await import('../src/main/db/sqlite');
    const t0 = Date.now();
    const svc = new KioskService({
      dataDir,
      appVersion: 'win7-check',
      deviceInfo: { platform: 'windows', appBuild: 'win7' },
      transport: { send: async () => Promise.reject(new Error('no printer')), status: async () => ({ health: 'unavailable', detail: 'check' }), list: async () => [], dispose: () => undefined },
      renderer: null,
      fetch: async () => new Response('{}', { status: 503 }),
    });
    const view = svc.view();
    svc.kv.setJson('win7.check', { at: 1 });
    const back = svc.kv.getJson<{ at: number }>('win7.check');
    svc.stop();
    if (back?.at !== 1) throw new Error('kv round trip');
    const db = openDb(path.join(dataDir, 'probe.db'));
    db.exec('CREATE TABLE t (a INTEGER, b BLOB)');
    db.run('INSERT INTO t (a, b) VALUES (?, ?)', 7, new Uint8Array([1, 2, 3]));
    const row = db.get<{ a: number; b: Uint8Array }>('SELECT a, b FROM t');
    const none = db.get('UPDATE t SET a = a + 1');
    db.tx(() => db.run('UPDATE t SET a = a + 1'));
    const after = db.get<{ a: number }>('SELECT a FROM t');
    db.close();
    if (row?.a !== 7 || row.b.length !== 3 || none !== undefined || after?.a !== 9) throw new Error(`db adapter: ${JSON.stringify({ row, none, after })}`);
    results.service = { ms: Date.now() - t0, phase: view.phase, dbAdapter: 'ok' };
  } catch (e) {
    fail('service', e);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }

  // 3. fetch / Response / ReadableStream (undici on Node 16) against a local server.
  try {
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ path: req.url, ok: true }));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/ping`, { signal: AbortSignal.timeout(5_000) });
    const body = (await res.json()) as { ok?: boolean };
    const text = await new Response(new ReadableStream({ start: (c) => (c.enqueue(new TextEncoder().encode('hi')), c.close()) })).text();
    server.close();
    if (!res.ok || body.ok !== true || text !== 'hi') throw new Error('fetch answer');
    results.fetch = 'ok';
    results.structuredClone = structuredClone({ a: [1, { b: 2 }] });
    results.crypto = typeof crypto.randomUUID();
  } catch (e) {
    fail('fetch', e);
  }

  // 4. serialport (N-API prebuild): list the COM ports.
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { SerialPort } = require('serialport') as { SerialPort: { list(): Promise<unknown[]> } };
    results.serialPorts = (await SerialPort.list()).length;
  } catch (e) {
    fail('serialport', e);
  }

  results.ok = ok;
  console.log(JSON.stringify(results));
  process.exit(ok ? 0 : 1);
}

void main();
