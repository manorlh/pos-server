/**
 * Stock over the hierarchy and targets: the screen's pure parts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  afterOp,
  barPercent,
  formatQty,
  levelsLabel,
  locationLabel,
  lowStockItems,
  nodeKey,
  nodeOfScope,
  paceLine,
  parseNodeKey,
  parseQty,
  shekels,
  strandedByProduct,
  targetTone,
  wizardPlan,
} from './stockLive';

describe('stock', () => {
  it('reads and writes nodes', () => {
    assert.equal(nodeKey({ level: 'area', targetId: 'a1' }), 'area:a1');
    assert.deepEqual(parseNodeKey('shop:s1'), { level: 'shop', targetId: 's1' });
    assert.equal(parseNodeKey('planet:x'), null);
    assert.equal(parseNodeKey(''), null);
  });
  it('shows quantities as the floor reads them', () => {
    assert.equal(formatQty(3), '3');
    assert.equal(formatQty(2.5), '2.5');
    assert.equal(formatQty(-1), '−1');
    assert.equal(formatQty(null), '—');
  });
  it('labels locations and levels', () => {
    assert.equal(locationLabel({ level: 'area', name: 'בר' }), 'נקודת מכירה · בר');
    assert.equal(levelsLabel(['area', 'shop']), 'סניף + נקודת מכירה');
    assert.equal(levelsLabel([]), 'סניף');
  });
  it('parses typed quantities', () => {
    assert.equal(parseQty('4'), 4);
    assert.equal(parseQty('2,5'), 2.5);
    assert.equal(parseQty('-1'), null);
    assert.equal(parseQty('-1', { allowNegative: true }), -1);
    assert.equal(parseQty('abc'), null);
  });
  it('previews an operation', () => {
    assert.equal(afterOp(5, 'add', 2), 7);
    assert.equal(afterOp(5, 'remove', 2), 3);
    assert.equal(afterOp(5, 'count', 9), 9);
    assert.equal(afterOp(5, 'wastage', 1), 4);
  });
  it('sums what a switch strands, per product', () => {
    const loc = { level: 'shop' as const, targetId: 's', name: 'X', levelLabel: 'סניף' };
    const m = strandedByProduct([
      { productId: 'p', productName: 'P', quantity: 3, location: loc },
      { productId: 'p', productName: 'P', quantity: 2, location: { ...loc, targetId: 't' } },
    ]);
    assert.equal(m.get('p'), 5);
  });
});

describe('the switch wizard', () => {
  const at = (level: 'shop' | 'area', targetId: string, name: string) => ({ level, targetId, name, levelLabel: level === 'shop' ? 'סניף' : 'נקודת מכירה' });
  // From the shop to the points of sale only: the shop's 10 must move to the bar and the lobby.
  const preview = {
    newlyManaged: [
      { productId: 'p', productName: 'P', quantity: 0, location: at('area', 'bar', 'בר') },
      { productId: 'p', productName: 'P', quantity: 0, location: at('area', 'lobby', 'לובי') },
    ],
    stranded: [{ productId: 'p', productName: 'P', quantity: 10, location: at('shop', 's', 'הרצליה') }],
  };
  const shopKey = 'p|shop:s';

  it('nothing typed: the stock left behind is the problem', () => {
    const plan = wizardPlan(preview, {}, {}, { writeOff: false, confirmZero: false });
    assert.equal(plan.remaining.get(shopKey), 10);
    assert.equal(plan.unfilled, 2);
    assert.match(plan.problem ?? '', /נשאר מלאי/);
  });
  it('split between two areas: transfers fill both, nothing is left', () => {
    const plan = wizardPlan(
      preview,
      {},
      { [shopKey]: [{ to: 'area:bar', quantity: '6' }, { to: 'area:lobby', quantity: '4' }] },
      { writeOff: false, confirmZero: false },
    );
    assert.equal(plan.problem, null);
    assert.equal(plan.unfilled, 0);
    assert.deepEqual(plan.transfers.map((t) => [t.to.targetId, t.quantity]), [['bar', 6], ['lobby', 4]]);
  });
  it('moving more than there is is refused', () => {
    const plan = wizardPlan(preview, {}, { [shopKey]: [{ to: 'area:bar', quantity: '12' }] }, { writeOff: true, confirmZero: true });
    assert.match(plan.problem ?? '', /גדולה ממה שיש/);
  });
  it('a write-off and a start at 0 must be said out loud', () => {
    const plan = wizardPlan(preview, { 'p|area:bar': '3' }, {}, { writeOff: true, confirmZero: false });
    assert.equal(plan.openings.length, 1);
    assert.match(plan.problem ?? '', /מתחילים מ-0/);
    assert.equal(wizardPlan(preview, { 'p|area:bar': '3' }, {}, { writeOff: true, confirmZero: true }).problem, null);
  });
  it('a bad line is named', () => {
    const plan = wizardPlan(preview, {}, { [shopKey]: [{ to: '', quantity: '3' }] }, { writeOff: true, confirmZero: true });
    assert.match(plan.problem ?? '', /לא תקינים/);
  });
  it('the narrowest node of a scope', () => {
    assert.deepEqual(nodeOfScope({ companyId: 'c', shopId: 's', areaId: 'a' }), { level: 'area', targetId: 'a' });
    assert.deepEqual(nodeOfScope({ companyId: 'c' }), { level: 'company', targetId: 'c' });
    assert.equal(nodeOfScope({}), null);
  });
});

describe('low stock in the cockpit', () => {
  const alert = {
    id: 'x',
    kind: 'low' as const,
    productId: 'p',
    productName: 'קולה',
    location: { level: 'area' as const, targetId: 'bar', name: 'בר', levelLabel: 'נקודת מכירה' },
    shopId: 's',
    quantity: 2,
    threshold: 10,
    suggestTransfer: { level: 'shop' as const, targetId: 's', name: 'הרצליה', quantity: 8 },
    raisedAt: null,
  };
  it('says what is low and what to move', () => {
    const [item] = lowStockItems([alert]);
    assert.equal(item.title, 'מלאי נמוך בבר: קולה');
    assert.equal(item.body, 'נשארו 2 (מינימום 10) · מומלץ להעביר 8 מהרצליה');
    assert.deepEqual(item.actions.map((a) => a.actionId), ['stock.transfer', 'stock.update', 'block.create']);
    assert.equal(item.actions[0].context.quantity, 8);
  });
  it('out with nothing to move: update or block', () => {
    const [item] = lowStockItems([{ ...alert, kind: 'out', quantity: 0, suggestTransfer: null }]);
    assert.equal(item.severity, 'critical');
    assert.deepEqual(item.actions.map((a) => a.actionId), ['stock.update', 'block.create']);
  });
});

describe('targets', () => {
  it('says the pace, or that it is too early', () => {
    assert.equal(paceLine({ forecast: 6100, period: 'day', elapsed: 0.5 }), 'בקצב הנוכחי: ₪6,100 עד סוף היום');
    assert.equal(paceLine({ forecast: 900, period: 'event', elapsed: 0.5 }), 'בקצב הנוכחי: ₪900 עד סוף האירוע');
    assert.equal(paceLine({ forecast: null, period: 'day', elapsed: 0.01 }), 'מוקדם מדי לחזות');
    assert.equal(paceLine({ forecast: 10, period: 'day', elapsed: 1 }), 'היום הסתיים');
    assert.equal(paceLine({ forecast: 10, period: 'event', elapsed: 1 }), 'האירוע הסתיים');
  });
  it('the bar and the tone', () => {
    assert.equal(barPercent({ actual: 50, amount: 200 }), 25);
    assert.equal(barPercent({ actual: 500, amount: 200 }), 100);
    assert.equal(barPercent({ actual: 5, amount: 0 }), 0);
    assert.equal(targetTone({ reached: true, forecastReaches: false }), 'ok');
    assert.equal(targetTone({ reached: false, forecastReaches: false }), 'behind');
    assert.equal(shekels(1234.4), '₪1,234');
  });
});
