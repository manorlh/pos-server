/**
 * Run with `npm test`. The browser kiosk's service worker (public/kiosk-sw.js, scope /k): what it
 * keeps and what it leaves to the browser — the kiosk page (kept, network first), the app's code,
 * the kiosk's media (CORS copies, a video's byte ranges from the cache) — and never the API,
 * App Router payloads, a POST or a dashboard page.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

interface Sw {
  routeOf(req: { url: string; method: string; mode?: string; destination?: string; headers?: { get(n: string): string | null } }, origin: string): string;
  parseRange(header: string, size: number): [number, number] | null;
  mediaKey(u: string): string | null;
}

// eslint-disable-next-line @typescript-eslint/no-require-imports
const sw = require(join(process.cwd(), 'public', 'kiosk-sw.js')) as Sw;
const ORIGIN = 'https://pos-cloud-app.vercel.app';
const req = (url: string, over: Partial<{ method: string; mode: string; destination: string; rsc: boolean }> = {}) => ({
  url,
  method: over.method ?? 'GET',
  mode: over.mode ?? 'no-cors',
  destination: over.destination ?? '',
  headers: { get: (n: string) => (n === 'RSC' && over.rsc ? '1' : null) },
});

describe('the kiosk worker', () => {
  it('keeps the kiosk page, never a dashboard page', () => {
    assert.equal(sw.routeOf(req(`${ORIGIN}/k`, { mode: 'navigate' }), ORIGIN), 'page');
    assert.equal(sw.routeOf(req(`${ORIGIN}/k?demo=1`, { mode: 'navigate' }), ORIGIN), 'page');
    assert.equal(sw.routeOf(req(`${ORIGIN}/dashboard`, { mode: 'navigate' }), ORIGIN), 'pass');
    assert.equal(sw.routeOf(req(`${ORIGIN}/kiosks`, { mode: 'navigate' }), ORIGIN), 'pass');
  });

  it("keeps the app's code, the icons and the manifest", () => {
    assert.equal(sw.routeOf(req(`${ORIGIN}/_next/static/chunks/app/k/page-abc.js`), ORIGIN), 'static');
    assert.equal(sw.routeOf(req(`${ORIGIN}/icons/icon-192.png`), ORIGIN), 'asset');
    assert.equal(sw.routeOf(req(`${ORIGIN}/k.webmanifest`), ORIGIN), 'asset');
    assert.equal(sw.routeOf(req(`${ORIGIN}/kiosk/card_terminals.png`), ORIGIN), 'asset');
  });

  it("keeps the kiosk's media from the cloud", () => {
    assert.equal(sw.routeOf(req('https://res.cloudinary.com/demo/image/upload/v1/a.jpg', { destination: 'image' }), ORIGIN), 'media');
    assert.equal(sw.routeOf(req('https://api.example.com/media/abc.mp4', { destination: 'video' }), ORIGIN), 'media');
    assert.equal(sw.routeOf(req('https://raw.githubusercontent.com/google/fonts/main/ofl/heebo/Heebo.ttf', { destination: 'font' }), ORIGIN), 'media');
  });

  it('leaves the API, App Router payloads and writes to the browser', () => {
    assert.equal(sw.routeOf(req('https://api.example.com/api/v1/sync/m/kiosk/sync', { method: 'POST' }), ORIGIN), 'pass');
    assert.equal(sw.routeOf(req('https://api.example.com/api/v1/machines/me'), ORIGIN), 'pass');
    assert.equal(sw.routeOf(req(`${ORIGIN}/k?_rsc=abc`), ORIGIN), 'pass');
    assert.equal(sw.routeOf(req(`${ORIGIN}/k`, { rsc: true }), ORIGIN), 'pass');
    assert.equal(sw.routeOf(req(`${ORIGIN}/api/anything`), ORIGIN), 'pass');
  });

  it("answers a video's byte ranges from the kept copy", () => {
    assert.deepEqual(sw.parseRange('bytes=0-', 1000), [0, 999]);
    assert.deepEqual(sw.parseRange('bytes=100-199', 1000), [100, 199]);
    assert.deepEqual(sw.parseRange('bytes=900-5000', 1000), [900, 999]);
    assert.deepEqual(sw.parseRange('bytes=-100', 1000), [900, 999]);
    assert.equal(sw.parseRange('bytes=1000-', 1000), null);
    assert.equal(sw.parseRange('items=0-1', 1000), null);
    assert.equal(sw.mediaKey('https://x/a.png#frag'), 'https://x/a.png');
  });
});
