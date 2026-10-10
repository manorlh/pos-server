/**
 * The browser KDS and board's service worker (docs/SPEC_KDS.md §13): one script, registered once
 * per route — `/screens-sw.js?screen=kds` with scope `/kds`, `?screen=board` with scope `/board`
 * (components/screen-web/screen-shell.ts). Apart from the dashboard's own (sw.js, which never
 * stores a page) and the kiosk's (kiosk-sw.js, scope `/k`): the screen's page is public and the
 * same for every visitor, so it may be kept — a reload or a short network drop never blanks the
 * kitchen or the pickup board.
 *
 * * **The screen's page** (`/kds` or `/board`): the network first (4 s), the copy kept from the
 *   last good load otherwise.
 * * **The app's code** (`/_next/static/…`, hashed): from the cache once fetched. The icons and the
 *   manifest: from the cache, refreshed behind.
 * * **Everything else passes through**: the API (the screen keeps its own copy of the last board
 *   and its waiting actions — lib/screenWebService.ts), non-GET requests, App Router payloads,
 *   Clerk, another route's pages.
 *
 * `&dev=1` (under `next dev`): the app's code from the network first — chunks are not hashed there.
 * Bump VERSION to drop every cache an older worker left.
 */
const VERSION = 'v1';
const NAV_TIMEOUT_MS = 4000;
const SCREENS = ['kds', 'board'];

const scopeSelf = typeof self !== 'undefined' && typeof self.addEventListener === 'function' && typeof caches !== 'undefined' ? self : null;
const PARAMS = scopeSelf ? new URL(self.location.href).searchParams : new URLSearchParams('');
const DEV = PARAMS.has('dev');
const SCREEN = SCREENS.includes(PARAMS.get('screen')) ? PARAMS.get('screen') : 'kds';
const PAGE = `/${SCREEN}`;
const SHELL = `r2m-screen-${SCREEN}-shell-${VERSION}`;
const PRECACHE = [PAGE, `/${SCREEN}.webmanifest`, '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];

/** What the worker does with a request: 'page' | 'static' | 'asset' | 'pass'. `page` is the route ("/kds"). */
function routeOf(req, origin, page) {
  const url = new URL(req.url);
  if (req.method !== 'GET') return 'pass';
  if (req.headers && typeof req.headers.get === 'function' && (req.headers.get('RSC') === '1' || req.headers.get('Next-Router-Prefetch'))) return 'pass';
  if (url.searchParams.has('_rsc')) return 'pass';
  if (url.origin !== origin) return 'pass';
  if (req.mode === 'navigate') return url.pathname === page || url.pathname.startsWith(`${page}/`) ? 'page' : 'pass';
  if (url.pathname.startsWith('/_next/static/')) return 'static';
  if (url.pathname.startsWith('/icons/') || url.pathname === `${page}.webmanifest`) return 'asset';
  return 'pass';
}

if (typeof module !== 'undefined' && module.exports) module.exports = { routeOf, VERSION, SCREENS };

if (scopeSelf) {
  self.addEventListener('install', (event) => {
    event.waitUntil(
      caches
        .open(SHELL)
        .then((cache) => Promise.all(PRECACHE.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => undefined))))
        .then(() => self.skipWaiting()),
    );
  });

  self.addEventListener('activate', (event) => {
    const mine = `r2m-screen-${SCREEN}-`;
    event.waitUntil(
      caches
        .keys()
        .then((keys) => Promise.all(keys.filter((k) => k.startsWith(mine) && k !== SHELL).map((k) => caches.delete(k))))
        .then(() => self.clients.claim()),
    );
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
      if (res.ok && res.type === 'basic' && !res.redirected) cache.put(PAGE, res.clone());
      return res;
    } catch {
      const hit = (await cache.match(PAGE)) || (await cache.match(request, { ignoreSearch: true }));
      if (hit) return hit;
      const offline = await caches.match('/offline.html');
      return offline || Response.error();
    }
  };

  const staticFirst = async (request) => {
    const cache = await caches.open(SHELL);
    if (!DEV) {
      const hit = await cache.match(request);
      if (hit) return hit;
    }
    try {
      const res = await fetch(request);
      if (res.ok && res.type === 'basic') cache.put(request, res.clone());
      return res;
    } catch (e) {
      const hit = await cache.match(request);
      if (hit) return hit;
      throw e;
    }
  };

  const asset = async (request) => {
    const cache = await caches.open(SHELL);
    const hit = await cache.match(request, { ignoreSearch: true });
    const fresh = fetch(request)
      .then((res) => {
        if (res.ok && res.type === 'basic') cache.put(request, res.clone());
        return res;
      })
      .catch(() => null);
    return hit || (await fresh) || Response.error();
  };

  self.addEventListener('fetch', (event) => {
    const route = routeOf(event.request, self.location.origin, PAGE);
    if (route === 'page') event.respondWith(page(event.request));
    else if (route === 'static') event.respondWith(staticFirst(event.request));
    else if (route === 'asset') event.respondWith(asset(event.request));
  });
}
