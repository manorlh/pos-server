/**
 * Smoke test of pairing and sync against a dev API, under plain Node (no Electron, no payment,
 * no printer): pair with a code, pull everything the kiosk keeps, download its media, beat, and
 * record the cloud's answers (tokens removed) as contract fixtures.
 *
 *   npm run smoke -- --server http://localhost:8001 --code AB12CD34 [--data <dir>] [--record test/fixtures/recorded]
 *
 * NEVER charges anything: the payment provider is never asked to sell, and the printer transport
 * here refuses every job.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { KioskService } from '../src/main/service';
import type { Transport } from '../src/main/printer/transports';

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const server = arg('server') ?? 'http://localhost:8001';
const code = arg('code');
const dataDir = arg('data') ?? path.join(os.tmpdir(), 'r2m-kiosk-smoke');
const recordDir = arg('record');

const noPrinter: Transport = {
  send: async () => {
    throw new Error('smoke: printing is disabled');
  },
  status: async () => ({ health: 'unavailable', detail: 'smoke' }),
  list: async () => [],
  dispose: () => undefined,
};

const recorded = new Map<string, unknown>();
const scrub = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(scrub);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = /token|password|secret|pinHash/i.test(k) ? '<redacted>' : scrub(x);
    return out;
  }
  return v;
};

const recordingFetch: typeof fetch = async (input, init) => {
  const res = await fetch(input, init);
  const text = await res.text();
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
  const key = `${init?.method ?? 'GET'} ${url.pathname.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{id}')}`;
  try {
    recorded.set(key, { status: res.status, body: scrub(JSON.parse(text)) });
  } catch {
    /* not JSON */
  }
  return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
};

/** `--bench`: how long the kiosk takes from its local data to the first view (no network). */
function bench() {
  const t0 = performance.now();
  const svc = new KioskService({ dataDir, appVersion: 'bench', deviceInfo: {}, transport: noPrinter, renderer: null, fetch: async () => new Response('{}', { status: 503 }) });
  const t1 = performance.now();
  const v = svc.view();
  const t2 = performance.now();
  const json = JSON.stringify(v);
  const t3 = performance.now();
  svc.stop();
  console.log(JSON.stringify({ openDbAndService_ms: +(t1 - t0).toFixed(1), firstView_ms: +(t2 - t1).toFixed(1), serialize_ms: +(t3 - t2).toFixed(1), viewBytes: json.length, phase: v.phase, products: v.catalog.products.length }));
}

async function main() {
  if (process.argv.includes('--bench')) return bench();
  mkdirSync(dataDir, { recursive: true });
  const svc = new KioskService({
    dataDir,
    appVersion: '0.1.0-smoke',
    deviceInfo: { model: 'Windows kiosk (smoke)', manufacturer: os.hostname(), platform: 'windows', firmware_build: `${os.type()} ${os.release()}` },
    transport: noPrinter,
    renderer: null,
    fetch: recordingFetch,
    log: (m) => console.log(`  · ${m}`),
  });
  try {
    if (!svc.paired) {
      if (!code) throw new Error('not paired: pass --code');
      console.log(`pairing with ${server} …`);
      const r = await svc.pair({ serverUrl: server, code, machineName: 'קיוסק Windows (בדיקת עשן)' });
      if (!r.ok) throw new Error(`pairing failed: ${r.error}`);
      console.log('paired');
    } else {
      console.log('already paired; syncing');
      await svc.sync.fullSync();
    }
    const beat = await svc.sync.heartbeat();
    console.log(`heartbeat: ${beat ? 'ok' : 'failed'}`, svc.cloud.heartbeat());
    await svc.sync.kioskSync();
    await svc.sync.pullCatalog(true);
    await svc.syncMedia();
    await svc.sync.flush();
    const v = svc.view();
    const media = svc.media.getStatus();
    console.log(
      JSON.stringify(
        {
          phase: v.phase,
          machine: v.machine,
          configVersion: v.configVersion,
          uiStyle: (v.config as { theme?: { uiStyle?: string } } | null)?.theme?.uiStyle ?? null,
          categories: v.catalog.categories.length,
          products: v.catalog.products.length,
          productsWithLocalImage: v.catalog.products.filter((p) => p.imageUrl?.startsWith('kiosk://')).length,
          media,
          terminal: v.state.terminal,
          counters: svc.ledger.counters.report(),
          zMode: svc.cloud.heartbeat().zMode,
          outbox: svc.outbox.count(),
          posUsers: svc.cloud.posUsers().length,
        },
        null,
        2,
      ),
    );
    if (recordDir) {
      mkdirSync(recordDir, { recursive: true });
      for (const [key, value] of recorded) {
        const name = key.replace(/^(GET|POST|PUT) \/api\/v1\//, '$1_').replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/_+/g, '_');
        writeFileSync(path.join(recordDir, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
      }
      console.log(`recorded ${recorded.size} answers in ${recordDir}`);
    }
  } finally {
    svc.stop();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
