/**
 * The service worker of `/app` — the one web entry (till, kiosk, KDS, board), installed as a PWA
 * (P:/specs/web-till-spec-v2.md §8.1, §8.2). A SKELETON: app-shell caching only.
 *
 * * **Kept:** the `/app` page (network first, the last good copy when the network is down), the
 *   app's hashed code (`/_next/static/…`), the manifest and the icons, and the bundle's files at
 *   their content addresses (`/web-app/b/<sha256>/…`, immutable — §8.1).
 * * **NEVER kept:** the API, the engine, the cloud — any other origin; anything not GET; App
 *   Router payloads; any answer marked `no-store`, `private`, or set with a cookie. Fiscal state
 *   lives in the engine, never in a cache: a document, a total or a Z is never served from here.
 * * **Updates never land mid-sale:** a new worker WAITS (no skipWaiting on install). The page
 *   asks it to take over (`activate-request`) only when its till is at rest; the worker takes
 *   over only if EVERY open window of `/app` last said "at rest, not busy" (`sale-state`). A
 *   window that never said is busy. Then the page reloads.
 *
 * Scope `/app` (registered by client/src/lib/appPwa.ts). Apart from the dashboard's sw.js (which
 * skips `/app`), the kiosk's kiosk-sw.js (`/k`) and the screens' screens-sw.js (`/kds`, `/board`).
 * Bump VERSION to drop every cache an older worker left. Chromium 108 / Safari 16.4 floor: plain
 * ES2020, nothing newer.
 */
const VERSION = 'v1';
const SHELL = `r2m-app-shell-${VERSION}`;
const PAGE = '/app';
const PRECACHE = [PAGE, '/app.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];
const NAV_TIMEOUT_MS = 4000;
const BUNDLE_RE = /^\/web-app\/b\/[0-9a-f]{64}\//;

const scopeSelf = typeof self !== 'undefined' && typeof self.addEventListener === 'function' && typeof caches !== 'undefined' ? self : null;

/** What the worker does with a request: 'page' | 'static' | 'asset' | 'bundle' | 'pass'. */
function routeOf(req, origin) {
  const url = new URL(req.url);
  if (req.method !== 'GET') return 'pass';
  if (req.headers && typeof req.headers.get === 'function' && (req.headers.get('RSC') === '1' || req.headers.get('Next-Router-Prefetch'))) return 'pass';
  if (url.searchParams.has('_rsc')) return 'pass';
  // Another origin is the API, the engine, the media cloud: never kept here.
  if (url.origin !== origin) return 'pass';
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/sync/')) return 'pass';
  if (req.mode === 'navigate') return url.pathname === PAGE || url.pathname.startsWith(`${PAGE}/`) ? 'page' : 'pass';
  if (url.pathname.startsWith('/_next/static/')) return 'static';
  if (BUNDLE_RE.test(url.pathname)) return 'bundle';
  if (url.pathname === '/app.webmanifest' || url.pathname.startsWith('/icons/')) return 'asset';
  return 'pass';
}

/** Whether an answer may be kept: ours, whole, and not marked private / no-store / cookie-bearing. */
function keepable(res) {
  if (!res || !res.ok || res.type !== 'basic' || res.status !== 200) return false;
  const h = res.headers;
  const cc = ((h && h.get('Cache-Control')) || '').toLowerCase();
  if (cc.includes('no-store') || cc.includes('private')) return false;
  if (h && h.get('Set-Cookie')) return false;
  return true;
}

/**
 * Whether the waiting worker may take over: every open `/app` window reported at rest and not
 * busy. `states` maps a client id to its last report; `clientIds` are the windows open now.
 */
function canActivate(clientIds, states) {
  for (const id of clientIds) {
    const s = states.get(id);
    if (!s || s.busy !== false || s.idle !== true) return false;
  }
  return true;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { routeOf, keepable, canActivate, VERSION, PRECACHE };

if (scopeSelf) {
  /** The windows' last "sale-state" (client id → {idle, busy, at}). */
  const states = new Map();

  self.addEventListener('install', (event) => {
    // No skipWaiting: an update waits for every window to be at rest (activate-request).
    event.waitUntil(caches.open(SHELL).then((cache) => Promise.all(PRECACHE.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => undefined)))));
  });

  self.addEventListener('activate', (event) => {
    event.waitUntil(
      caches
        .keys()
        .then((keys) => Promise.all(keys.filter((k) => k.startsWith('r2m-app-') && k !== SHELL).map((k) => caches.delete(k))))
        .then(() => self.clients.claim()),
    );
  });

  self.addEventListener('message', (event) => {
    const data = event.data || {};
    const source = event.source;
    if (data.type === 'sale-state' && source && source.id) {
      states.set(source.id, { idle: data.idle === true, busy: data.busy !== false, at: Date.now() });
      return;
    }
    if (data.type === 'activate-request') {
      const run = self.clients.matchAll({ type: 'window' }).then((list) => {
        const open = list.filter((c) => new URL(c.url).pathname.startsWith(PAGE)).map((c) => c.id);
        for (const id of Array.from(states.keys())) if (!open.includes(id)) states.delete(id);
        if (canActivate(open, states)) return self.skipWaiting();
        if (source && source.postMessage) source.postMessage({ type: 'activate-deferred' });
        return undefined;
      });
      if (event.waitUntil) event.waitUntil(run);
    }
  });

  const fetchWithTimeout = (req, ms) =>
    new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('timeout')), ms);
      fetch(req).then(
        (r) => {
          clearTimeout(t);
          resolve(r);
        },
        (e) => {
          clearTimeout(t);
          reject(e);
        },
      );
    });

  const page = async (request) => {
    const cache = await caches.open(SHELL);
    try {
      const res = await fetchWithTimeout(request, NAV_TIMEOUT_MS);
      if (keepable(res) && !res.redirected) cache.put(PAGE, res.clone());
      return res;
    } catch {
      const hit = (await cache.match(PAGE)) || (await cache.match(request, { ignoreSearch: true }));
      if (hit) return hit;
      const offline = await caches.match('/offline.html');
      return offline || Response.error();
    }
  };

  /** Hashed / content-addressed: from the cache once fetched. */
  const immutable = async (request) => {
    const cache = await caches.open(SHELL);
    const hit = await cache.match(request);
    if (hit) return hit;
    const res = await fetch(request);
    if (keepable(res)) cache.put(request, res.clone());
    return res;
  };

  /** The manifest and icons: from the cache, refreshed behind. */
  const asset = async (request) => {
    const cache = await caches.open(SHELL);
    const hit = await cache.match(request, { ignoreSearch: true });
    const fresh = fetch(request)
      .then((res) => {
        if (keepable(res)) cache.put(request, res.clone());
        return res;
      })
      .catch(() => null);
    return hit || (await fresh) || Response.error();
  };

  self.addEventListener('fetch', (event) => {
    const route = routeOf(event.request, self.location.origin);
    if (route === 'page') event.respondWith(page(event.request));
    else if (route === 'static' || route === 'bundle') event.respondWith(immutable(event.request));
    else if (route === 'asset') event.respondWith(asset(event.request));
    // 'pass': the browser's own network — the API and the engine are never touched here.
  });
}
