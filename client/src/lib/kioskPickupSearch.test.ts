/**
 * Run with `npm test`. Finding a kiosk order by its pickup number (lib/kioskPickupSearch.ts) — the
 * same normalisation and matching as the server (kiosk_pickup.parse_pickup_query) and the till
 * (domain/KioskPickupSearch.kt) — and the KDS card's headline with the kiosk's label (lib/kdsBoard.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parsePickupQuery, pickupDateText, pickupLabelKey, pickupMatches } from './kioskPickupSearch';
import { orderTitle } from './kdsBoard';
import type { KdsOrder } from './kdsScreenTypes';

describe('the search box read as a pickup number', () => {
  const cases: Array<[string, string, number, boolean]> = [
    ['17', '17', 17, true],
    ['A17', 'A17', 17, false],
    ['A-17', 'A17', 17, false],
    ['a-17', 'A17', 17, false],
    [' a - 17 ', 'A17', 17, false],
    ['A–17', 'A17', 17, false], // an en dash
    ['#17', '17', 17, true],
    ['AL-17', 'AL17', 17, false], // drawn offline
    ['א-17', 'א17', 17, false],
    ['9999', '9999', 9999, true],
  ];
  for (const [typed, key, number, digitsOnly] of cases) {
    it(`"${typed}"`, () => {
      assert.deepEqual(parsePickupQuery(typed), { key, number, digitsOnly });
    });
  }

  it('is not a pickup number: empty, a word, a document number, an amount', () => {
    for (const typed of ['', '  ', 'A', 'המבורגר', '20000057', '12345', '17.50', 'A-17-B', null, undefined]) {
      assert.equal(parsePickupQuery(typed), null, String(typed));
    }
  });

  it('normalises a label the same way', () => {
    assert.equal(pickupLabelKey('a - 17'), 'A17');
    assert.equal(pickupLabelKey('AL-4'), 'AL4');
  });
});

describe('matching an order', () => {
  it('a bare number matches every order of that number; a letter only its own', () => {
    const q17 = parsePickupQuery('17')!;
    assert.equal(pickupMatches(q17, 'A-17', 17), true);
    assert.equal(pickupMatches(q17, '17', 17), true);
    assert.equal(pickupMatches(q17, 'BL-17', 17), true);
    assert.equal(pickupMatches(q17, 'A-170', 170), false);
    const a17 = parsePickupQuery('a-17')!;
    assert.equal(pickupMatches(a17, 'A-17', 17), true);
    assert.equal(pickupMatches(a17, 'B-17', 17), false);
    assert.equal(pickupMatches(a17, '17', 17), false);
  });

  it('shows the business date beside it (the number comes back daily)', () => {
    assert.equal(pickupDateText('2026-10-09'), '09.10.2026');
    assert.equal(pickupDateText(null), '');
  });
});

describe('the KDS card headline', () => {
  const order = (over: Partial<KdsOrder>): KdsOrder => ({
    id: 'abcdef123456', source: 'kiosk', displayRef: '40000057', tableRef: null, zoneName: null, serviceType: null, guests: null,
    waiterName: null, pickupName: null, orderNote: null, pickupNumber: 17, ...over,
  }) as KdsOrder;

  it('a kiosk order says what its slip says — with its letter or the number alone', () => {
    assert.equal(orderTitle(order({ pickupLabel: 'A-17' })), 'A-17');
    assert.equal(orderTitle(order({ pickupLabel: '17' })), '17');
  });

  it('any other order as before', () => {
    assert.equal(orderTitle(order({})), '#17');
    assert.equal(orderTitle(order({ pickupLabel: '  ' })), '#17');
    assert.equal(orderTitle(order({ pickupNumber: null })), '40000057');
    assert.equal(orderTitle(order({ tableRef: '12', pickupLabel: 'A-17' })), 'שולחן 12');
  });
});
