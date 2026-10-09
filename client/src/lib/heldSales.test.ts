/**
 * Held sales at a remote close: the dialog's pure parts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { asOffer, canSend, heldSaleLine, reasonOk } from './heldSales';

describe('held sales at a remote close', () => {
  it('says each sale in one line: time, cashier, items, total', () => {
    const line = heldSaleLine({ id: 'h-1', at: null, cashier: 'דנה', itemCount: 2, total: '42.5', items: ['קפה', 'עוגה'] });
    assert.equal(line, '— · דנה · 2 פריטים · ₪42.50');
    assert.equal(heldSaleLine({ id: 'h-2', at: null, cashier: null, itemCount: 1, total: null, items: [] }), '— · — · פריט אחד · —');
  });
  it('sends a choice only when offered, with a reason where one is needed', () => {
    assert.equal(canSend({ allowed: true, needsReason: false }, ''), true);
    assert.equal(canSend({ allowed: true, needsReason: true }, 'קצר'), false);
    assert.equal(canSend({ allowed: true, needsReason: true }, 'לקוחות עזבו'), true);
    assert.equal(canSend({ allowed: false, needsReason: true, whyNot: 'כבוי' }, 'לקוחות עזבו'), false);
    assert.equal(canSend(null, 'לקוחות עזבו'), false);
    assert.equal(reasonOk('    '), false);
  });
  it("reads a till's pending close, which says only whether it was kept, as no offer", () => {
    assert.equal(asOffer(true), null);
    assert.deepEqual(asOffer({ allowed: true, needsReason: false }), { allowed: true, needsReason: false });
  });
});
