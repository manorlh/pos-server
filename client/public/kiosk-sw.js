/**
 * The browser kiosk's service worker (scope `/k`, docs/SPEC_KIOSK.md §27). Apart from the
 * dashboard's own (sw.js, which never stores a page): the kiosk's page is public and the same for
 * every visitor, so it may be kept — a reload or a short network drop never blanks the kiosk.
 *
 * * **The kiosk page** (`/k`): the network first (4 s), the copy kept from the last good load
 *   otherwise.
 * * **The app's code** (`/_next/static/…`, hashed): from the cache once fetched. The icons, the
 *   manifest and the kiosk's public pictures: from the cache, refreshed behind.
 * * **The kiosk's media** (pictures, videos, fonts — the cloud's URLs, Cloudinary or the API's
 *   `/media`): the page posts the list it shows (`kiosk-media`); the worker fetches what it lacks
 *   (CORS, so nothing opaque is stored), serves it from the cache (a video's byte ranges too) and
 *   drops what the kiosk no longer shows.
 * * **Everything else passes through**: the API (the kiosk keeps its own copies of the cloud's
 *   answers), non-GET requests, App Router payloads, Clerk.
 *
 * `?dev=1` (under `next dev`): the app's code from the network first — chunks are not hashed there.
 * Bump VERSION to drop every cache an older worker left.
 */
const VERSION = 'v1';
const SHELL = `r2m-kiosk-shell-${VERSION}`;
const MEDIA = `r2m-kiosk-media-${VERSION}`;
const PAGE = '/k';
const PRECACHE = [PAGE, '/k.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];
const NAV_TIMEOUT_MS = 4000;

const scopeSelf = typeof self !== 'undefined' && typeof self.addEventListener === 'function' && typeof caches !== 'undefined' ? self : null;
const DEV = scopeSelf ? new URL(self.location.href).searchParams.has('dev') : false;

/** What the worker does with a request: 'page' | 'static' | 'asset' | 'media' | 'pass'. */
function routeOf(req, origin) {
  const url = new URL(req.url);
  if (req.method !== 'GET') return 'pass';
  if (req.headers && typeof req.headers.get === 'function' && (req.headers.get('RSC') === '1' || req.headers.get('Next-Router-Prefetch'))) return 'pass';
  if (url.searchParams.has('_rsc')) return 'pass';
  if (url.origin === origin) {
    if (req.mode === 'navigate') return url.pathname === PAGE || url.pathname.startsWith(`${PAGE}/`) ? 'page' : 'pass';
    if (url.pathname.startsWith('/_next/static/')) return 'static';
    if (url.pathname.startsWith('/icons/') || url.pathname.startsWith('/kiosk/') || url.pathname === '/k.webmanifest') return 'asset';
    if (url.pathname.startsWith('/media/')) return 'media';
    return 'pass';
  }
  // Another origin: the API passes; its /media files, Cloudinary and fonts are the kiosk's media.
  if (url.pathname.includes('/api/')) return 'pass';
  const dest = req.destination || '';
  if (dest === 'image' || dest === 'video' || dest === 'audio' || dest === 'font') return 'media';
  if (url.pathname.startsWith('/media/') || url.hostname === 'res.cloudinary.com' || url.hostname === 'raw.githubusercontent.com') return 'media';
  return 'pass';
}

/** The media list as the cache's keys (no fragment). */
function mediaKey(u) {
  try {
    const url = new URL(u);
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/** "bytes=100-" / "bytes=100-199" against `size` → [start, end] (inclusive), or null. */
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec((header || '').trim());
  if (!m) return null;
  let start;
  let end;
  if (m[1] === '') {
    const n = Number(m[2]);
    if (!Number.isFinite(n) || n <= 0) return null;
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return [start, end];
}

if (typeof module !== 'undefined' && module.exports) module.exports = { routeOf, parseRange, mediaKey, VERSION };

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
    event.waitUntil(
      caches
        .keys()
        .then((keys) => Promise.all(keys.filter((k) => k.startsWith('r2m-kiosk-') && k !== SHELL && k !== MEDIA).map((k) => caches.delete(k))))
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

  /** A CORS copy of a media URL (never an opaque one, which costs ~7 MB of quota each in Chrome). */
  const fetchMedia = async (url) => {
    const res = await fetch(new Request(url, { mode: 'cors', credentials: 'omit' }));
    if (!res.ok || res.status === 206 || res.type === 'opaque') throw new Error(`media ${res.status}`);
    return res;
  };

  const rangeOf = async (cached, rangeHeader) => {
    const blob = await cached.blob();
    const r = parseRange(rangeHeader, blob.size);
    if (!r) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${blob.size}` } });
    const [start, end] = r;
    const headers = new Headers(cached.headers);
    headers.set('Content-Range', `bytes ${start}-${end}/${blob.size}`);
    headers.set('Content-Length', String(end - start + 1));
    headers.set('Accept-Ranges', 'bytes');
    return new Response(blob.slice(start, end + 1), { status: 206, statusText: 'Partial Content', headers });
  };

  const media = async (request) => {
    const key = mediaKey(request.url);
    const cache = await caches.open(MEDIA);
    const hit = key ? await cache.match(key) : null;
    const range = request.headers.get('range');
    if (hit) return range ? rangeOf(hit, range) : hit;
    // A video's first range before it is kept: straight to the network (it is fetched whole on the list).
    if (range) return fetch(request);
    try {
      const res = await fetchMedia(request.url);
      if (key) cache.put(key, res.clone()).catch(() => undefined);
      return res;
    } catch {
      return fetch(request);
    }
  };

  self.addEventListener('fetch', (event) => {
    const route = routeOf(event.request, self.location.origin);
    if (route === 'page') event.respondWith(page(event.request));
    else if (route === 'static') event.respondWith(staticFirst(event.request));
    else if (route === 'asset') event.respondWith(asset(event.request));
    else if (route === 'media') event.respondWith(media(event.request));
  });

  /** The kiosk's media list: fetch what is missing (3 at a time), drop what is no longer shown. */
  let syncing = Promise.resolve();
  const syncMedia = async (urls) => {
    const keep = new Set(urls.map(mediaKey).filter(Boolean));
    const cache = await caches.open(MEDIA);
    for (const req of await cache.keys()) if (!keep.has(req.url)) await cache.delete(req);
    const missing = [];
    for (const u of keep) if (!(await cache.match(u))) missing.push(u);
    const worker = async () => {
      while (missing.length > 0) {
        const u = missing.shift();
        try {
          const res = await fetchMedia(u);
          await cache.put(u, res);
        } catch {
          /* not reachable now: tried again on the next list */
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  };

  self.addEventListener('message', (event) => {
    const data = event.data || {};
    if (data.type === 'kiosk-media' && Array.isArray(data.urls)) {
      const urls = data.urls.filter((u) => typeof u === 'string' && /^https?:\/\//i.test(u)).slice(0, 2000);
      syncing = syncing.then(() => syncMedia(urls)).catch(() => undefined);
      if (event.waitUntil) event.waitUntil(syncing);
    }
  });
}
