/**
 * The dashboard's service worker: enough for the app to install and to open without a
 * network, and nothing more.
 *
 * * **Static assets** (`/_next/static/…` — hashed, so never stale — and the icons) are
 *   served from the cache once fetched.
 * * **Pages** go to the network first. A page is never stored: it is rendered for the
 *   signed-in user, and a stored copy would outlive a sign-out. With no network, the
 *   offline page is shown instead.
 * * **Everything else passes through untouched**: the API (another origin, and `/api`
 *   here), Clerk's own requests, RSC payloads, non-GET requests. A response for a
 *   signed-in user is never cached here.
 *
 * Bump VERSION to drop every cache an older worker left.
 */
const VERSION = 'v2';
const STATIC_CACHE = `r2m-static-${VERSION}`;
const OFFLINE_URL = '/offline.html';
const PRECACHE = [OFFLINE_URL, '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== STATIC_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** Requests the worker must leave to the browser. */
function bypass(request, url) {
  if (request.method !== 'GET') return true;
  if (url.origin !== self.location.origin) return true;
  if (url.pathname.startsWith('/api/') || url.pathname === '/api') return true;
  // Clerk's proxied frontend API and its sign-in/up pages and handshakes.
  if (url.pathname.startsWith('/__clerk') || url.pathname.startsWith('/sign-in') || url.pathname.startsWith('/sign-up')) {
    return true;
  }
  if (url.searchParams.has('__clerk_handshake') || url.searchParams.has('__clerk_db_jwt')) return true;
  // App Router payloads of a signed-in render.
  if (request.headers.get('RSC') === '1' || url.searchParams.has('_rsc')) return true;
  if (url.pathname.startsWith('/_next/image') || url.pathname.startsWith('/_next/data')) return true;
  return false;
}

function isStaticAsset(url) {
  return url.pathname.startsWith('/_next/static/') || url.pathname.startsWith('/icons/');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (bypass(request, url)) return;

  if (request.mode === 'navigate') {
    // Network first, never stored; the offline page only when there is no network.
    event.respondWith(
      fetch(request).catch(() => caches.match(OFFLINE_URL).then((r) => r || Response.error())),
    );
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const hit = await cache.match(request);
        if (hit) return hit;
        const res = await fetch(request);
        // Only a plain same-origin 200: never a redirect to sign-in, an error, or an opaque response.
        if (res.ok && res.type === 'basic') cache.put(request, res.clone());
        return res;
      }),
    );
  }
});

/**
 * "התראות לטלפון" (Web Push, pos-server app/services/exception_alerts/push.py): show the alert,
 * and a tap opens the dashboard page it names — only ever a page of this origin.
 */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'R2M POS', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'R2M POS';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      tag: data.tag || undefined,
      renotify: Boolean(data.tag),
      dir: 'rtl',
      lang: 'he',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      requireInteraction: data.severity === 'high',
      data: { url: typeof data.url === 'string' ? data.url : '/dashboard/alerts' },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const raw = (event.notification.data && event.notification.data.url) || '/dashboard/alerts';
  let target = new URL('/dashboard/alerts', self.location.origin);
  try {
    const candidate = new URL(raw, self.location.origin);
    if (candidate.origin === self.location.origin) target = candidate;
  } catch {
    // keep the alerts page
  }
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const client of list) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          return client.navigate(target.href).then((c) => (c || client).focus());
        }
      }
      return self.clients.openWindow(target.href);
    }),
  );
});
