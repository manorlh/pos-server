/**
 * The dashboard's service worker: enough for the app to install and to open without a
 * network, and the phone / computer notifications ("התראות").
 *
 * * **Static assets** (`/_next/static/…` — hashed, so never stale — and the icons) are
 *   served from the cache once fetched.
 * * **Pages** go to the network first. A page is never stored: it is rendered for the
 *   signed-in user, and a stored copy would outlive a sign-out. With no network, the
 *   offline page is shown instead.
 * * **Everything else passes through untouched**: the API (another origin, and `/api`
 *   here), Clerk's own requests, RSC payloads, non-GET requests. A response for a
 *   signed-in user is never cached here.
 * * **Push** (fix/pwa-push): every message shows a notification — with the options this
 *   platform refuses dropped rather than nothing at all (Chrome takes the permission away from a
 *   site whose pushes show nothing) — and the open dashboard pages are told it arrived ("בדיקת
 *   התראות" waits for that). `pushsubscriptionchange` moves the device to the browser's new
 *   subscription (`POST /push/devices/renew`), with what the page told the worker in
 *   `r2m-push-config` (the API, the server's key).
 *
 * Bump VERSION to drop every cache an older worker left (the push config is kept).
 */
const VERSION = 'v3';
const STATIC_CACHE = `r2m-static-${VERSION}`;
/** What the page told the worker (lib/pushAlertsApi.ts `tellWorker`): survives worker restarts and VERSION bumps. */
const CONFIG_CACHE = 'r2m-push-config';
const CONFIG_URL = '/__r2m/push-config';
const OFFLINE_URL = '/offline.html';
const PRECACHE = [OFFLINE_URL, '/icons/icon-192.png', '/icons/icon-512.png'];
const ICON = '/icons/icon-192.png';
/** Android's status bar shows the badge as a white mask: a transparent icon with a white glyph. */
const BADGE = '/icons/badge-96.png';

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
      .then((keys) => Promise.all(keys.filter((k) => k !== STATIC_CACHE && k !== CONFIG_CACHE).map((k) => caches.delete(k))))
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
  // "הדפסה בקופה אחרת": a bill relayed to another till's printer that did not print there.
  'document_unprinted',
  // "מכשיר מזומן" (P:/specs/cash-paylink.md §11.9): a cash station's alerts (offline, jam, low change, held credit…).
  'cash_unit',
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

/** The message's JSON; plain text (or nothing) still makes a notification. */
function readPayload(event) {
  if (!event || !event.data) return {};
  try {
    const parsed = event.data.json();
    return parsed && typeof parsed === 'object' ? parsed : { body: String(parsed) };
  } catch {
    try {
      return { body: event.data.text() };
    } catch {
      return {};
    }
  }
}

/**
 * "התראות לטלפון" (Web Push, pos-server app/services/exception_alerts/push.py): the title and the
 * options of one notification (pure — dashboardSw.test.ts).
 *
 * "בקשות אישור" pushes (tag `approval:<id>`, url `/dashboard/approvals/<id>`, or `…?quick=approve`)
 * use two more flags: `requireInteraction: true` keeps the request on screen until it is handled,
 * and `renotify: false` replaces the notification of the same tag silently — "טופל על ידי X" once
 * someone else decided.
 */
function notificationOptions(data) {
  const d = data && typeof data === 'object' ? data : {};
  const title = typeof d.title === 'string' && d.title ? d.title : 'R2M POS';
  const tag = typeof d.tag === 'string' && d.tag ? d.tag : undefined;
  const at = typeof d.at === 'string' ? Date.parse(d.at) : NaN;
  const silentReplace = d.renotify === false;
  const options = {
    body: typeof d.body === 'string' ? d.body : '',
    tag,
    // A replacement of the same tag alerts again, unless the server says it should not. Chrome
    // throws on `renotify` without a tag.
    renotify: Boolean(tag) && d.renotify !== false,
    dir: 'rtl',
    lang: 'he',
    icon: ICON,
    badge: BADGE,
    // Per category, per level (pos-server app/services/push_policy.py); an older server: high severity.
    // An approval request sends `requireInteraction: true` itself.
    requireInteraction: typeof d.requireInteraction === 'boolean' ? d.requireInteraction : d.severity === 'high',
    data: { url: notificationUrl(d), kind: typeof d.kind === 'string' ? d.kind : null, testId: typeof d.testId === 'string' ? d.testId : null },
  };
  if (Number.isFinite(at)) options.timestamp = at;
  // A silent replacement ("טופל על ידי X") never vibrates: `silent` with `vibrate` throws.
  if (silentReplace) options.silent = true;
  else if (Array.isArray(d.vibrate) && d.vibrate.every((n) => Number.isFinite(n) && n >= 0)) options.vibrate = d.vibrate.slice(0, 20);
  return { title: title.slice(0, 200), options };
}

/** The same notification with only what every platform takes. */
function minimalOptions(options) {
  return { body: options.body, tag: options.tag, icon: ICON, data: options.data, dir: 'rtl', lang: 'he' };
}

async function tellPages(message) {
  try {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of list) client.postMessage(message);
  } catch {
    // No page to tell.
  }
}

async function show(data) {
  const { title, options } = notificationOptions(data);
  let shown = 'full';
  try {
    await self.registration.showNotification(title, options);
  } catch {
    // An option this platform refuses: the alert itself must still show.
    shown = 'minimal';
    await self.registration.showNotification(title, minimalOptions(options));
  }
  // "בדיקת התראות": the page waits for this to say the message reached this browser.
  await tellPages({ type: 'r2m-push', kind: options.data.kind, testId: options.data.testId, tag: options.tag || null, shown });
}

self.addEventListener('push', (event) => {
  event.waitUntil(show(readPayload(event)));
});

/** A dashboard window to reuse: the focused one, else a visible one, else any. */
function pickClient(list) {
  const dashboard = list.filter((c) => {
    try {
      return new URL(c.url).pathname.startsWith('/dashboard');
    } catch {
      return false;
    }
  });
  return dashboard.find((c) => c.focused) || dashboard.find((c) => c.visibilityState === 'visible') || dashboard[0] || null;
}

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
      const client = pickClient(list);
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

// ── The page's config, and pushsubscriptionchange ────────────────────────────

/** `apiBase` is the API the page talks to: https, or a local development server. */
function cleanConfig(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const apiBase = typeof raw.apiBase === 'string' ? raw.apiBase.replace(/\/+$/, '') : '';
  const okBase = /^https:\/\/[^\s/]+/.test(apiBase) || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(apiBase);
  const publicKey = typeof raw.publicKey === 'string' && /^[A-Za-z0-9_-]{80,100}$/.test(raw.publicKey) ? raw.publicKey : null;
  if (!okBase && !publicKey) return null;
  return { apiBase: okBase ? apiBase : null, publicKey };
}

async function saveConfig(config) {
  const cache = await caches.open(CONFIG_CACHE);
  await cache.put(CONFIG_URL, new Response(JSON.stringify(config), { headers: { 'Content-Type': 'application/json' } }));
}

async function readConfig() {
  try {
    const cache = await caches.open(CONFIG_CACHE);
    const hit = await cache.match(CONFIG_URL);
    return hit ? cleanConfig(await hit.json()) : null;
  } catch {
    return null;
  }
}

self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'r2m-push-config') return;
  const config = cleanConfig(msg);
  if (config) event.waitUntil(saveConfig(config));
});

function b64uToBytes(text) {
  const padded = (text + '='.repeat((4 - (text.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

function bytesToB64u(buffer) {
  if (!buffer) return null;
  const bytes = new Uint8Array(buffer);
  let raw = '';
  for (let i = 0; i < bytes.length; i += 1) raw += String.fromCharCode(bytes[i]);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * The browser replaced the subscription while no page was open (Firefox does; Chrome and Edge
 * mostly do not fire it — there the dashboard registers again on its next open, lib/pushAlertsApi.ts
 * `keepThisBrowser`). Subscribe again with the same key when the browser did not, and move the device
 * on the server: the old endpoint and its auth secret are the proof (no sign-in in a worker).
 */
async function renewSubscription(oldSub, newSub) {
  const config = await readConfig();
  let sub = newSub;
  if (!sub) {
    const key =
      (oldSub && oldSub.options && oldSub.options.applicationServerKey) ||
      (config && config.publicKey ? b64uToBytes(config.publicKey) : null);
    if (!key) return;
    sub = await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  }
  const oldAuth = oldSub && typeof oldSub.getKey === 'function' ? bytesToB64u(oldSub.getKey('auth')) : null;
  if (!config || !config.apiBase || !oldSub || !oldAuth) return;
  const json = sub.toJSON();
  await fetch(`${config.apiBase}/push/devices/renew`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ oldEndpoint: oldSub.endpoint, oldAuth, endpoint: json.endpoint, keys: json.keys }),
  });
}

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(renewSubscription(event.oldSubscription || null, event.newSubscription || null).catch(() => {}));
});

// The tests (src/lib/dashboardSw.test.ts) read the rules; a browser has no `module`.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { notificationUrl, notificationOptions, minimalOptions, pickClient, cleanConfig, readPayload, PROBLEM_KINDS, BADGE };
}
