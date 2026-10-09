/**
 * Run with `npm test`. `/app` as a PWA (lib/appPwa.ts, public/app-sw.js, public/app.webmanifest):
 * the update never takes over mid-sale (the page's gate and the worker's check of every window),
 * the worker keeps only the app shell — never the API, the engine or a fiscal answer — and the
 * manifest installs a standalone, right-to-left R2M POS from `/app`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_MANIFEST_URL, APP_SCOPE, APP_SW_URL, appPwaMetadata, createUpdateGate, listenSaleState, SALE_STATE_EVENT, updateDecision } from './appPwa';

interface Sw {
  routeOf(req: { url: string; method: string; mode?: string; headers?: { get(n: string): string | null } }, origin: string): string;
  keepable(res: { ok: boolean; type: string; status: number; headers: { get(n: string): string | null } } | null): boolean;
  canActivate(clientIds: string[], states: Map<string, { idle: boolean; busy: boolean }>): boolean;
  PRECACHE: string[];
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sw = require(join(process.cwd(), 'public', 'app-sw.js')) as Sw;
const ORIGIN = 'https://pos-cloud-app.vercel.app';
const req = (url: string, over: Partial<{ method: string; mode: string; rsc: boolean }> = {}) => ({
  url,
  method: over.method ?? 'GET',
  mode: over.mode ?? 'no-cors',
  headers: { get: (n: string) => (n === 'RSC' && over.rsc ? '1' : null) },
});
const res = (over: Partial<{ ok: boolean; type: string; status: number; cc: string; cookie: boolean }> = {}) => ({
  ok: over.ok ?? true,
  type: over.type ?? 'basic',
  status: over.status ?? 200,
  headers: { get: (n: string) => (n === 'Cache-Control' ? (over.cc ?? null) : n === 'Set-Cookie' && over.cookie ? 'sid=1' : null) },
});

describe('the update gate: never mid-sale', () => {
  it('decides from the sale state; unknown is busy', () => {
    assert.equal(updateDecision({ waiting: false, state: { idle: true, busy: false } }), 'none');
    assert.equal(updateDecision({ waiting: true, state: null }), 'wait');
    assert.equal(updateDecision({ waiting: true, state: { idle: true, busy: true } }), 'wait');
    assert.equal(updateDecision({ waiting: true, state: { idle: false, busy: false } }), 'wait');
    assert.equal(updateDecision({ waiting: true, state: { idle: true, busy: false } }), 'activate');
  });

  it('asks once when at rest, again only after a new sale; reloads only at rest', () => {
    const calls: string[] = [];
    const gate = createUpdateGate({ activate: () => calls.push('activate'), reload: () => calls.push('reload') });
    gate.setWaiting(true);
    assert.deepEqual(calls, []); // nothing said yet = busy
    gate.report({ idle: false, busy: true });
    gate.report({ idle: true, busy: false });
    gate.report({ idle: true, busy: false });
    assert.deepEqual(calls, ['activate']);
    gate.report({ idle: false, busy: true }); // a sale started before the worker took over
    gate.controllerChanged();
    assert.deepEqual(calls, ['activate']); // no reload mid-sale
    gate.report({ idle: true, busy: false });
    assert.deepEqual(calls, ['activate', 'reload']);
  });

  it('passes the state to the workers', () => {
    const posted: unknown[] = [];
    const gate = createUpdateGate({ activate: () => undefined, reload: () => undefined, post: (s) => posted.push(s) });
    gate.report({ idle: true, busy: false });
    assert.deepEqual(posted, [{ idle: true, busy: false }]);
  });

  it('the mock hook: the till bundle\'s DOM event', () => {
    const target = new EventTarget();
    const seen: unknown[] = [];
    const off = listenSaleState(target, (s) => seen.push(s));
    const ev = new Event(SALE_STATE_EVENT) as Event & { detail?: unknown };
    Object.defineProperty(ev, 'detail', { value: { idle: true, busy: false } });
    target.dispatchEvent(ev);
    target.dispatchEvent(new Event(SALE_STATE_EVENT)); // no detail = busy
    off();
    target.dispatchEvent(ev);
    assert.deepEqual(seen, [
      { idle: true, busy: false },
      { idle: false, busy: true },
    ]);
    assert.equal(SALE_STATE_EVENT, 'r2m:sale-state');
  });
});

describe('the /app worker', () => {
  it('takes over only when EVERY open window is at rest; a silent window is busy', () => {
    const states = new Map([
      ['a', { idle: true, busy: false }],
      ['b', { idle: true, busy: false }],
    ]);
    assert.equal(sw.canActivate(['a', 'b'], states), true);
    assert.equal(sw.canActivate(['a', 'b', 'c'], states), false);
    states.set('b', { idle: true, busy: true });
    assert.equal(sw.canActivate(['a', 'b'], states), false);
    assert.equal(sw.canActivate([], states), true);
  });

  it('keeps the app shell: the page, the hashed code, the manifest, the icons, the bundle files', () => {
    assert.equal(sw.routeOf(req(`${ORIGIN}/app`, { mode: 'navigate' }), ORIGIN), 'page');
    assert.equal(sw.routeOf(req(`${ORIGIN}/app/settings`, { mode: 'navigate' }), ORIGIN), 'page');
    assert.equal(sw.routeOf(req(`${ORIGIN}/_next/static/chunks/app/page-abc.js`), ORIGIN), 'static');
    assert.equal(sw.routeOf(req(`${ORIGIN}/app.webmanifest`), ORIGIN), 'asset');
    assert.equal(sw.routeOf(req(`${ORIGIN}/icons/icon-192.png`), ORIGIN), 'asset');
    assert.equal(sw.routeOf(req(`${ORIGIN}/web-app/b/${'a'.repeat(64)}/assets/app.js`), ORIGIN), 'bundle');
    assert.ok(sw.PRECACHE.includes('/app'));
  });

  it('NEVER the API, the engine, the cloud, a write, an App Router payload or another page', () => {
    assert.equal(sw.routeOf(req('https://api.example.com/api/v1/sync/m/transactions', { method: 'POST' }), ORIGIN), 'pass');
    assert.equal(sw.routeOf(req('https://api.example.com/api/v1/sync/m/till-z'), ORIGIN), 'pass');
    assert.equal(sw.routeOf(req('wss://engine.example.com/v1/till/m'), ORIGIN), 'pass');
    assert.equal(sw.routeOf(req(`${ORIGIN}/api/anything`), ORIGIN), 'pass');
    assert.equal(sw.routeOf(req(`${ORIGIN}/sync/m/shifts`), ORIGIN), 'pass');
    assert.equal(sw.routeOf(req(`${ORIGIN}/app`, { method: 'POST' }), ORIGIN), 'pass');
    assert.equal(sw.routeOf(req(`${ORIGIN}/app?_rsc=1`), ORIGIN), 'pass');
    assert.equal(sw.routeOf(req(`${ORIGIN}/app`, { rsc: true }), ORIGIN), 'pass');
    assert.equal(sw.routeOf(req(`${ORIGIN}/dashboard`, { mode: 'navigate' }), ORIGIN), 'pass');
    assert.equal(sw.routeOf(req(`${ORIGIN}/k`, { mode: 'navigate' }), ORIGIN), 'pass');
    assert.equal(sw.routeOf(req(`${ORIGIN}/web-app/b/not-a-hash/app.js`), ORIGIN), 'pass');
  });

  it('never stores an answer marked no-store / private, one that sets a cookie, or a partial one', () => {
    assert.equal(sw.keepable(res()), true);
    assert.equal(sw.keepable(res({ cc: 'no-store' })), false);
    assert.equal(sw.keepable(res({ cc: 'private, max-age=60' })), false);
    assert.equal(sw.keepable(res({ cookie: true })), false);
    assert.equal(sw.keepable(res({ status: 206 })), false);
    assert.equal(sw.keepable(res({ type: 'opaque' })), false);
    assert.equal(sw.keepable(null), false);
  });

  it('never calls skipWaiting on install (an update always waits for the gate)', () => {
    const src = readFileSync(join(process.cwd(), 'public', 'app-sw.js'), 'utf8');
    const install = src.slice(src.indexOf("addEventListener('install'"), src.indexOf("addEventListener('activate'"));
    assert.ok(!install.includes('skipWaiting('));
    assert.ok(src.includes("data.type === 'activate-request'"));
  });
});

describe('the /app manifest', () => {
  const m = JSON.parse(readFileSync(join(process.cwd(), 'public', 'app.webmanifest'), 'utf8')) as Record<string, unknown>;

  it('installs R2M POS from /app: standalone, any orientation, Hebrew right to left, the existing icons', () => {
    assert.equal(m.name, 'R2M POS');
    assert.equal(m.id, APP_SCOPE);
    assert.equal(m.start_url, APP_SCOPE);
    assert.equal(m.scope, APP_SCOPE);
    assert.equal(m.display, 'standalone');
    assert.equal(m.orientation, 'any');
    assert.equal(m.lang, 'he');
    assert.equal(m.dir, 'rtl');
    const icons = m.icons as Array<{ src: string; purpose: string }>;
    for (const i of icons) assert.ok(readFileSync(join(process.cwd(), 'public', i.src)).length > 0, i.src);
    assert.ok(icons.some((i) => i.purpose === 'maskable'));
  });

  it('the names the /app layout uses', () => {
    assert.equal(appPwaMetadata.manifest, APP_MANIFEST_URL);
    assert.equal(APP_SW_URL, '/app-sw.js');
  });
});
