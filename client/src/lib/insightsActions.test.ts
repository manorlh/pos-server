/**
 * Run with `npm test`. The insights' action sheets — the pure rules of lib/insightsActions.ts:
 * targets, durations, texts, a happy hour's schedule, a result, the attention items.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  addDays,
  announcementText,
  anomalyActions,
  anomalyMessage,
  checkFixedPrice,
  crossesMidnight,
  durationBody,
  endAnnouncementText,
  happyHourLastDay,
  happyHourProblem,
  offerKey,
  offerLabel,
  orderAttention,
  productPitch,
  resultState,
  scopeQuery,
  slowActions,
  targetOptions,
  weekdaysLabel,
  type AttentionSeverity,
  type TargetLookup,
} from './insightsActions';

const LOOKUP: TargetLookup = {
  companies: [{ id: 'c1', name: 'רויאל' }],
  shops: [
    { id: 's1', name: 'הרצליה', companyId: 'c1' },
    { id: 's2', name: 'תל אביב', companyId: 'c1' },
  ],
  machines: [{ id: 'm1', name: 'קופה 1', shopId: 's1', areaId: 'a1', areaName: 'בר' }],
  event: { id: 'e1', name: 'ערב פתיחה' },
};

describe('targetOptions', () => {
  it('lists the till, its point of sale, the shop and the company, narrowest first', () => {
    const out = targetOptions({}, { machineId: 'm1' }, LOOKUP);
    assert.deepEqual(out.map((o) => `${o.level}:${o.name}`), ['machine:קופה 1', 'area:בר', 'shop:הרצליה', 'company:רויאל']);
  });

  it('puts the event before the shop and never repeats a target', () => {
    const out = targetOptions({ shopId: 's1', eventId: 'e1' }, { machineId: 'm1' }, LOOKUP);
    assert.deepEqual(out.map((o) => o.level), ['machine', 'area', 'event', 'shop', 'company']);
  });

  it('a scope of a shop offers the shop and its company', () => {
    assert.deepEqual(targetOptions({ shopId: 's2' }, undefined, LOOKUP).map((o) => o.id), ['s2', 'c1']);
  });

  it('the whole organization: every shop, then the companies', () => {
    assert.deepEqual(targetOptions({}, undefined, LOOKUP).map((o) => o.id), ['s1', 's2', 'c1']);
  });

  it('an unknown name falls back to the id', () => {
    const out = targetOptions({ machineId: 'abcdef123456' }, undefined, { companies: [], shops: [], machines: [] });
    assert.deepEqual(out, [{ level: 'machine', id: 'abcdef123456', name: 'abcdef12' }]);
  });
});

describe('durations', () => {
  it('each choice and "until" needs a date', () => {
    assert.deepEqual(durationBody('end_of_day'), { kind: 'end_of_day' });
    assert.deepEqual(durationBody('h2'), { kind: 'hours', hours: 2 });
    assert.deepEqual(durationBody('h4'), { kind: 'hours', hours: 4 });
    assert.equal(durationBody('until'), null);
    assert.equal(durationBody('until', '30/09/2026'), null);
    assert.deepEqual(durationBody('until', '2026-09-30'), { kind: 'until', date: '2026-09-30' });
  });

  it('adds days across a month and a year', () => {
    assert.equal(addDays('2026-09-27', 4), '2026-10-01');
    assert.equal(addDays('2026-12-30', 3), '2027-01-02');
  });
});

describe('texts', () => {
  it('the quick message for a product', () => {
    assert.equal(productPitch(' קרואסון שקדים ', 'טרי מהתנור'), 'הציעו ללקוחות: קרואסון שקדים — טרי מהתנור');
    assert.ok(productPitch('x', 'y'.repeat(600)).length <= 500);
  });

  it('a message for each anomaly, none for anything else', () => {
    assert.match(anomalyMessage('till_cash'), /מגירה/);
    assert.match(anomalyMessage('till_low_sales'), /קופה/);
    assert.equal(anomalyMessage('other'), '');
  });

  it('offer labels and keys', () => {
    assert.equal(offerLabel({ kind: 'percent', value: 15 }), '15% הנחה');
    assert.equal(offerLabel({ kind: 'percent', value: 12.5 }), '12.5% הנחה');
    assert.equal(offerLabel({ kind: 'second_half', value: null }), 'השני ב-50%');
    assert.equal(offerLabel({ kind: 'fixed_price', value: 900, newPrice: 900 }), '₪9 ליחידה');
    assert.equal(offerKey({ kind: 'second_half', value: null }), 'second_half:');
  });

  it('the announcement: name, offer, products, days, hours and the last day', () => {
    const text = announcementText(
      {
        name: 'שעה שמחה',
        type: 'discount',
        config: { discountKind: 'percent', discountValue: 20 },
        weekdays: [3, 1],
        startTime: '16:00',
        endTime: '18:00',
        validTo: '2026-10-31',
      },
      ['בירה', 'יין'],
    );
    assert.equal(text, 'מבצע: שעה שמחה — 20% הנחה על בירה, יין · ימים ב׳, ד׳ · 16:00–18:00 · עד 31/10');
    assert.equal(
      announcementText({ name: '1+1', type: 'buy_x_get_y', config: { buyQuantity: 1, getQuantity: 1, getDiscountPercent: 100, target: { all: true } } }),
      'מבצע: 1+1 — קנו 1 וקבלו 1 חינם על כל המוצרים',
    );
    assert.equal(endAnnouncementText(' שעה שמחה '), 'המבצע הסתיים: שעה שמחה');
  });

  it('a fixed price reads as the price, not the name twice', () => {
    assert.equal(
      announcementText({ name: 'קרואסון', type: 'fixed_price', config: { price: 9 } }, ['קרואסון']),
      'מבצע: קרואסון — ₪9 ליחידה על קרואסון',
    );
  });
});

describe('checkFixedPrice', () => {
  const pricing = { price: 5000, minPrice: 1000, floor: null };
  it('the reviewer’s case: ₪5 off a ₪50 reference leaves −₪35 in the ₪10 shop — refused', () => {
    const out = checkFixedPrice('5', pricing);
    assert.deepEqual(out && [out.value, out.lowest, out.tooLow, out.refused], [500, -3500, true, true]);
  });
  it('under ₪1, at or above the price, or not a number', () => {
    assert.equal(checkFixedPrice('0.5', { price: 1200, minPrice: 1200, floor: null })?.tooLow, true);
    assert.equal(checkFixedPrice('12', { price: 1200, minPrice: 1200, floor: null }), null);
    assert.equal(checkFixedPrice('abc', pricing), null);
  });
  it('the cost floor, and a fine price', () => {
    assert.equal(checkFixedPrice('9', { price: 1200, minPrice: 1200, floor: 950 })?.belowCost, true);
    assert.deepEqual(checkFixedPrice('9.9', { price: 1200, minPrice: 1200, floor: 950 }), {
      value: 990, lowest: 990, belowCost: false, tooLow: false, refused: false,
    });
  });
});

describe('happy hour', () => {
  it('needs days, two different HH:MM times and 1–12 weeks', () => {
    const ok = { weekdays: [2], startTime: '16:00', endTime: '18:00', weeks: 4 };
    assert.equal(happyHourProblem(ok), null);
    assert.equal(happyHourProblem({ ...ok, weekdays: [] }), 'needDays');
    assert.equal(happyHourProblem({ ...ok, weekdays: [7] }), 'needDays');
    assert.equal(happyHourProblem({ ...ok, startTime: '4:00' }), 'badTime');
    assert.equal(happyHourProblem({ ...ok, endTime: '16:00' }), 'sameTimes');
    assert.equal(happyHourProblem({ ...ok, weeks: 13 }), 'badWeeks');
    assert.equal(happyHourProblem({ ...ok, weeks: 0 }), 'badWeeks');
  });

  it('a window past midnight, the last day and the days label', () => {
    assert.equal(crossesMidnight('23:00', '02:00'), true);
    assert.equal(crossesMidnight('16:00', '18:00'), false);
    assert.equal(happyHourLastDay('2026-09-27', 4), '2026-10-24');
    assert.equal(weekdaysLabel([3, 2]), 'ג׳, ד׳');
  });
});

describe('resultState', () => {
  it('waits for data, then compares with the same hours before', () => {
    assert.equal(resultState(null), 'none');
    assert.equal(resultState({ dataArrived: false, hours: 1 }), 'waiting');
    assert.equal(resultState({ dataArrived: true, hours: 2, since: { units: 7, net: 0 }, before: { units: 3, net: 0 }, changePct: 133.3 }), 'up');
    assert.equal(resultState({ dataArrived: true, hours: 2, since: { units: 2, net: 0 }, before: { units: 3, net: 0 }, changePct: -33.3 }), 'down');
    assert.equal(resultState({ dataArrived: true, hours: 2, since: { units: 3, net: 0 }, before: { units: 3, net: 0 }, changePct: 0 }), 'flat');
    assert.equal(resultState({ dataArrived: true, hours: 2, since: { units: 4, net: 0 }, before: { units: 0, net: 0 }, changePct: null }), 'new');
  });
});

describe('attention items', () => {
  it('a till card opens the till and messages it; a slow product messages and promotes', () => {
    const card = { id: 'till_cash:m1', type: 'till_cash', severity: 'warning' as const, params: { machineId: 'm1' } };
    assert.deepEqual(anomalyActions(card).map((a) => a.actionId), ['openMachine', 'quickMessage']);
    assert.deepEqual(anomalyActions(card)[1].context, { machineId: 'm1' });
    assert.deepEqual(slowActions({ productId: 'p1' }).map((a) => [a.actionId, a.context.productId]), [['quickMessage', 'p1'], ['quickPromo', 'p1']]);
    assert.deepEqual(slowActions({ productId: null }), []);
  });

  it('anomalies by severity, then a few slow products', () => {
    type Row = { severity: AttentionSeverity; id: string };
    const a: Row[] = [{ severity: 'warning', id: 'w' }, { severity: 'critical', id: 'c' }];
    const s: Row[] = ['s1', 's2', 's3', 's4'].map((id) => ({ severity: 'opportunity', id }));
    assert.deepEqual(orderAttention(a, s).map((x) => x.id), ['c', 'w', 's1', 's2', 's3']);
  });

  it('the scope as query parameters, the event first', () => {
    assert.deepEqual(scopeQuery({ eventId: 'e1', shopId: 's1' }), { eventId: 'e1' });
    assert.deepEqual(scopeQuery({ shopId: 's1', areaId: 'a1' }), { shopId: 's1', areaId: 'a1' });
    assert.deepEqual(scopeQuery({ companyId: 'c1', machineId: 'm1' }), { machineId: 'm1' });
    assert.deepEqual(scopeQuery({}), {});
  });
});
