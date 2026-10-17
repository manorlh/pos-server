/**
 * Run with `npm test`. "טיפ באשראי משולם מהמזומן": card tips paid to staff out of the drawer,
 * as the shift and Z pages read them (lib/drawerTips.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { cardTipsFromDrawerOf, deviceCashOf, hasDrawerTips, shiftDrawerCash } from './drawerTips';

describe('cardTipsFromDrawerOf', () => {
  it('reads the frozen amount, a zero included', () => {
    assert.equal(cardTipsFromDrawerOf({ totalCash: 50, cardTipsFromDrawer: 10 }), 10);
    assert.equal(cardTipsFromDrawerOf({ cardTipsFromDrawer: '12.50' }), 12.5);
    assert.equal(cardTipsFromDrawerOf({ cardTipsFromDrawer: 0 }), 0);
  });

  it('is null when the close did not carry it (parameter off, kiosks, older tills)', () => {
    assert.equal(cardTipsFromDrawerOf({ totalCash: 50 }), null);
    assert.equal(cardTipsFromDrawerOf(null), null);
    assert.equal(cardTipsFromDrawerOf(undefined), null);
  });

  it('takes nothing that is not an amount', () => {
    for (const junk of [null, 'ten', true, -5, '']) {
      assert.equal(cardTipsFromDrawerOf({ cardTipsFromDrawer: junk }), null, String(junk));
    }
  });
});

describe('shiftDrawerCash', () => {
  it("is the owner's example: 50 cash, a 10 card tip paid from the drawer → 40", () => {
    assert.equal(shiftDrawerCash('50.00', '0.00', 10), 40);
  });

  it('adds the cash tips and keeps agorot exact', () => {
    assert.equal(shiftDrawerCash(100.1, '0.2', 0.3), 100);
    assert.equal(shiftDrawerCash(null, undefined, 0), 0);
  });

  it('leaves the cash device cash out ("מזומן במכשיר")', () => {
    assert.equal(shiftDrawerCash('430.00', '0.00', 0, '330.00'), 100);
    assert.equal(shiftDrawerCash('100.00', '5.00', 5, -20), 120);
  });
});

describe('deviceCashOf', () => {
  it('is a figure only when there was any', () => {
    assert.equal(deviceCashOf('330.00'), 330);
    assert.equal(deviceCashOf('0.00'), null);
    assert.equal(deviceCashOf(null), null);
    assert.equal(deviceCashOf('x'), null);
  });
});

describe('hasDrawerTips', () => {
  it('shows the rows for any figure, never without one', () => {
    assert.equal(hasDrawerTips('10.00'), true);
    assert.equal(hasDrawerTips('0.00'), true);
    assert.equal(hasDrawerTips(null), false);
    assert.equal(hasDrawerTips(undefined), false);
  });
});
