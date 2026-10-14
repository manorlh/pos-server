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
 * The exception kinds the "בעיות" screen lists (pos-server app/services/problems.py `KIND_GROUP`;
 * P:/specs/manager-problems.md §3 "התראת Push שנלחצת פותחת את הכרטיס שלה").
 */
const PROBLEM_KINDS = new Set([
  'till_offline', 'kiosk_offline', 'till_printer', 'kiosk_printer', 'kiosk_terminal', 'device_battery',
  'z_missing', 'shift_open_overdue', 'forced_z_close', 'z_forced_open_shifts', 'z_forced_pending_cloud_refund',
  'shop_z_producer_forced', 'local_shop_z_till_unsynced', 'cloud_closed_shift_late_documents',
  'card_transmission_overdue', 'z_transmission_failed', 'failed_payment', 'card_unresolved', 'terminal_mismatch',
  'card_failures', 'zcredit_recon', 'bon_unprinted',
  // feat/push-detectors' watches (a till not selling; a table open too long, a late KDS ticket; a
  // shop not opened by its hour).
  'till_idle', 'table_open_long', 'kds_ticket_late', 'shop_not_opened',
  // "תמיכה מרחוק": a till's QuickSupport signed by a certificate other than the allowed one.
  'quicksupport_signer_mismatch',
  'document_refused', 'document_number_conflict', 'z_totals_mismatch', 'shift_totals_mismatch',
  'local_shop_z_mismatch', 'offline_z_gap', 'offline_z_conflict',
]);

/**
 * Where a tap on an alert leads. An alert the "בעיות" screen lists opens its own card there
 * (`?focus=<log row>`, and `&code=` for the log entry should it be handled by then) — only when
 * the server let this user open the log entry (`/x/<code>`: the reports, which the screen is
 * part of). Anything else (a digest, a test, an event's target) where the server said.
 */
function notificationUrl(data) {
  const url = data && typeof data.url === 'string' ? data.url : '/dashboard/alerts';
  const code = /^\/x\/([a-z0-9]{1,16})$/.exec(url);
  const entry = data && typeof data.entryId === 'string' && /^[0-9a-fA-F-]{32,36}$/.test(data.entryId) ? data.entryId : null;
  if (code && entry && PROBLEM_KINDS.has(data.kind)) {
    return `/dashboard/problems?focus=${entry}&code=${code[1]}`;
  }
  return url;
}

/**
 * "התראות לטלפון" (Web Push, pos-server app/services/exception_alerts/push.py): show the alert,
 * and a tap opens the dashboard page it names — only ever a page of this origin.
 *
 * "בקשות אישור" pushes (tag `approval:<id>`, url `/dashboard/approvals/<id>`, or `…?quick=approve`)
 * use two more flags: `requireInteraction: true` keeps the request on screen until it is handled,
 * and `renotify: false` replaces the notification of the same tag silently — "טופל על ידי X" once
 * someone else decided.
 */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { title: 'R2M POS', body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'R2M POS';
  const tag = data.tag || undefined;
  event.waitUntil(
    self.registration.showNotification(title, {
      body: data.body || '',
      tag,
      // A replacement of the same tag alerts again, unless the server says it should not.
      renotify: Boolean(tag) && data.renotify !== false,
      dir: 'rtl',
      lang: 'he',
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      // Per category, per level (pos-server app/services/push_policy.py); an older server: high severity.
      // An approval request sends `requireInteraction: true` itself.
      requireInteraction: typeof data.requireInteraction === 'boolean' ? data.requireInteraction : data.severity === 'high',
      // A silent replacement ("טופל על ידי X") never vibrates: `silent` with `vibrate` throws.
      silent: data.renotify === false ? true : undefined,
      vibrate: data.renotify !== false && Array.isArray(data.vibrate) ? data.vibrate : undefined,
      data: { url: notificationUrl(data) },
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
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (list) => {
      // A dashboard window only (the browser kiosk and the KDS have workers of their own).
      const client = list.find((c) => new URL(c.url).pathname.startsWith('/dashboard'));
      if (client) {
        try {
          await client.focus();
          if (client.url !== target.href) await client.navigate(target.href);
          return;
        } catch {
          // Not ours to navigate: open a window instead.
        }
      }
      await self.clients.openWindow(target.href);
    }),
  );
});

// The tests (src/lib/dashboardSw.test.ts) read the rules; a browser has no `module`.
if (typeof module !== 'undefined' && module.exports) module.exports = { notificationUrl, PROBLEM_KINDS };
