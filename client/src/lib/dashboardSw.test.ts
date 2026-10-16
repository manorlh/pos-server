/**
 * Run with `npm test`. The dashboard's service worker (public/sw.js): where a tap on a phone alert
 * leads — the "בעיות" screen's own card for a problem the user may read in the log, the page the
 * server named for anything else.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

interface Options {
  body: string;
  tag?: string;
  renotify?: boolean;
  silent?: boolean;
  vibrate?: number[];
  requireInteraction?: boolean;
  icon: string;
  badge?: string;
  timestamp?: number;
  dir?: string;
  data: { url: string; kind: string | null; testId: string | null };
}

interface FakeClient {
  url: string;
  focused?: boolean;
  visibilityState?: string;
}

interface Sw {
  notificationUrl(data: unknown): string;
  notificationOptions(data: unknown): { title: string; options: Options };
  minimalOptions(options: Options): Partial<Options>;
  pickClient(list: FakeClient[]): FakeClient | null;
  cleanConfig(raw: unknown): { apiBase: string | null; publicKey: string | null } | null;
  readPayload(event: unknown): Record<string, unknown>;
  PROBLEM_KINDS: Set<string>;
  BADGE: string;
}

// The worker registers its listeners on `self` when it loads; a stand-in that ignores them.
(globalThis as unknown as { self: unknown }).self = { addEventListener: () => undefined, location: { origin: 'https://x' } };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sw = require(join(process.cwd(), 'public', 'sw.js')) as Sw;

const ENTRY = '6f1c2d3e-4b5a-4c6d-8e7f-901234567890';

describe('a tap on a phone alert', () => {
  it("opens a problem's own card on the problems screen", () => {
    assert.equal(
      sw.notificationUrl({ url: '/x/abc123', entryId: ENTRY, kind: 'till_offline' }),
      `/dashboard/problems?focus=${ENTRY}&code=abc123`,
    );
    for (const kind of ['bon_unprinted', 'zcredit_recon', 'z_missing', 'till_printer', 'document_refused']) {
      assert.ok(sw.PROBLEM_KINDS.has(kind), kind);
    }
    // push-detectors' kinds the screen lists (pos-server problems.py KIND_GROUP); a daily summary is
    // information, never a problem card.
    for (const kind of ['till_idle', 'table_open_long', 'kds_ticket_late', 'shop_not_opened']) {
      assert.ok(sw.PROBLEM_KINDS.has(kind), kind);
    }
    for (const kind of ['daily_summary', 'sales_pace_low', 'payment_reversed', 'table_restored']) {
      assert.equal(sw.PROBLEM_KINDS.has(kind), false, kind);
    }
    assert.equal(sw.notificationUrl({ url: '/x/abc123', entryId: ENTRY, kind: 'daily_summary' }), '/x/abc123');
  });

  it('keeps the page the server named for anything else', () => {
    // Not a problem (a large refund): its log entry, as before.
    assert.equal(sw.notificationUrl({ url: '/x/abc123', entryId: ENTRY, kind: 'refund' }), '/x/abc123');
    // A user who may not open the log: the alerts page, as the server said.
    assert.equal(sw.notificationUrl({ url: '/dashboard/alerts', entryId: ENTRY, kind: 'till_offline' }), '/dashboard/alerts');
    // An event's target, a digest, a test.
    assert.equal(sw.notificationUrl({ url: '/dashboard/live-event/e1', kind: 'target_reached' }), '/dashboard/live-event/e1');
    assert.equal(sw.notificationUrl({ url: '/dashboard/alerts', kind: 'digest' }), '/dashboard/alerts');
    // No entry id, or not an id: as the server said.
    assert.equal(sw.notificationUrl({ url: '/x/abc123', kind: 'till_offline' }), '/x/abc123');
    assert.equal(sw.notificationUrl({ url: '/x/abc123', entryId: '../../evil', kind: 'till_offline' }), '/x/abc123');
    // Nothing usable: the alerts page.
    assert.equal(sw.notificationUrl({}), '/dashboard/alerts');
    assert.equal(sw.notificationUrl(null), '/dashboard/alerts');
  });
});

describe('a push message (fix/pwa-push)', () => {
  it('always has a title, a body and the icons that exist', () => {
    const { title, options } = sw.notificationOptions({});
    assert.equal(title, 'R2M POS');
    assert.equal(options.body, '');
    assert.equal(options.icon, '/icons/icon-192.png');
    assert.equal(options.badge, '/icons/badge-96.png');
    assert.equal(options.dir, 'rtl');
    // No tag: never `renotify` (Chrome throws on it).
    assert.equal(options.renotify, false);
    assert.equal(options.data.url, '/dashboard/alerts');
    assert.equal(sw.notificationOptions(null).title, 'R2M POS');
  });

  it("keeps the server's behaviour, and never `silent` with `vibrate`", () => {
    const alert = sw.notificationOptions({
      title: 'קופה התנתקה · קופה 1', body: 'סניף 1 · 19:00', tag: 'till_offline:m1', severity: 'high',
      vibrate: [300, 120, 300], at: '2026-10-16T09:00:00+00:00', kind: 'till_offline',
    });
    assert.equal(alert.options.renotify, true);
    assert.equal(alert.options.requireInteraction, true);
    assert.deepEqual(alert.options.vibrate, [300, 120, 300]);
    assert.equal(alert.options.silent, undefined);
    assert.equal(alert.options.timestamp, Date.parse('2026-10-16T09:00:00+00:00'));
    // "טופל על ידי X": replaced silently — silent, so no vibration.
    const handled = sw.notificationOptions({ title: 'טופל', tag: 'approval:1', renotify: false, vibrate: [100], requireInteraction: false });
    assert.equal(handled.options.silent, true);
    assert.equal(handled.options.vibrate, undefined);
    assert.equal(handled.options.renotify, false);
    assert.equal(handled.options.requireInteraction, false);
    // A broken pattern is left out rather than thrown on.
    assert.equal(sw.notificationOptions({ vibrate: [100, 'x'] }).options.vibrate, undefined);
    assert.equal(sw.notificationOptions({ at: 'not a date' }).options.timestamp, undefined);
  });

  it('carries the test id so the page knows the test arrived', () => {
    const test = sw.notificationOptions({ title: 'התראת בדיקה', kind: 'test', testId: 'abc123', tag: 'test' });
    assert.deepEqual(test.options.data, { url: '/dashboard/alerts', kind: 'test', testId: 'abc123' });
  });

  it('falls back to what every platform takes', () => {
    const { options } = sw.notificationOptions({ title: 't', body: 'b', tag: 'x', vibrate: [1], requireInteraction: true });
    const min = sw.minimalOptions(options);
    assert.deepEqual(Object.keys(min).sort(), ['body', 'data', 'dir', 'icon', 'lang', 'tag']);
    assert.equal(min.body, 'b');
  });

  it('reads JSON, text, or nothing', () => {
    const event = (json: () => unknown, text: () => string) => ({ data: { json, text } });
    assert.deepEqual(sw.readPayload(event(() => ({ title: 'a' }), () => '')), { title: 'a' });
    assert.deepEqual(sw.readPayload(event(() => { throw new Error('x'); }, () => 'plain')), { body: 'plain' });
    assert.deepEqual(sw.readPayload(event(() => 'str', () => 'str')), { body: 'str' });
    assert.deepEqual(sw.readPayload({ data: null }), {});
    assert.deepEqual(sw.readPayload(null), {});
  });
});

describe('a tap reuses the right window', () => {
  it('the focused dashboard, else a visible one, else any dashboard — never the kiosk', () => {
    const kiosk = { url: 'https://x/k/menu', focused: true };
    const hidden = { url: 'https://x/dashboard/alerts', visibilityState: 'hidden' };
    const visible = { url: 'https://x/dashboard/problems', visibilityState: 'visible' };
    const focused = { url: 'https://x/dashboard', focused: true, visibilityState: 'visible' };
    assert.equal(sw.pickClient([kiosk, hidden, visible, focused]), focused);
    assert.equal(sw.pickClient([kiosk, hidden, visible]), visible);
    assert.equal(sw.pickClient([kiosk, hidden]), hidden);
    assert.equal(sw.pickClient([kiosk]), null);
    assert.equal(sw.pickClient([{ url: 'not a url' }]), null);
  });
});

describe("the page's config for pushsubscriptionchange", () => {
  const KEY = 'B'.repeat(87);
  it('keeps an https API (or a local one) and a VAPID key, nothing else', () => {
    assert.deepEqual(sw.cleanConfig({ apiBase: 'https://pos-cloud-api.fly.dev/api/v1/', publicKey: KEY }), {
      apiBase: 'https://pos-cloud-api.fly.dev/api/v1',
      publicKey: KEY,
    });
    assert.deepEqual(sw.cleanConfig({ apiBase: 'http://localhost:8001/api/v1', publicKey: null }), {
      apiBase: 'http://localhost:8001/api/v1',
      publicKey: null,
    });
    assert.deepEqual(sw.cleanConfig({ apiBase: 'http://evil.example/api', publicKey: KEY }), { apiBase: null, publicKey: KEY });
    assert.equal(sw.cleanConfig({ apiBase: 'javascript:alert(1)', publicKey: 'short' }), null);
    assert.equal(sw.cleanConfig(null), null);
  });
});
