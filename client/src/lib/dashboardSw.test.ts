/**
 * Run with `npm test`. The dashboard's service worker (public/sw.js): where a tap on a phone alert
 * leads — the "בעיות" screen's own card for a problem the user may read in the log, the page the
 * server named for anything else.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

interface Sw {
  notificationUrl(data: unknown): string;
  PROBLEM_KINDS: Set<string>;
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
