/**
 * Run with `npm test`. The browser kiosk's orders (lib/kioskWebOrders.ts, docs/SPEC_KIOSK.md §23,
 * §27): pickup numbers, the till's held-sale form, voucher coverage and the open order as the cloud
 * takes it — pinned by the golden fixture server/tests/fixtures/kiosk_web/open_order.json, which
 * the server validates against its own schema (tests/test_kiosk_web.py). `UPDATE_GOLDEN=1 npm test`
 * writes it again.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  coveredUnits,
  dueAgorot,
  goodsAgorot,
  heldSaleCodec,
  localDate,
  newId,
  nextPickup,
  offlinePickupLabel,
  openLines,
  openOrderWire,
  orderCode,
  orderDue,
  orderNeedsUpload,
  pickupLabelOf,
  voucherAmount,
  voucherCodeOf,
  voucherCoverable,
  voucherForfeits,
  voucherTake,
  type OpenOrder,
  type WebOrderLine,
} from './kioskWebOrders';

const burger: WebOrderLine = {
  key: 'l1',
  productId: 'p-burger',
  name: 'המבורגר קלאסי',
  qty: 2,
  baseAgorot: 5400,
  unitAgorot: 5900,
  options: [
    { groupId: 'g-size', groupName: 'גודל', kind: 'choice', optionId: 'o-regular', name: 'רגיל', priceAgorot: 0 },
    { groupId: 'g-extras', groupName: 'תוספות', kind: 'addon', optionId: 'o-cheese', name: 'גבינה', priceAgorot: 500 },
    { groupId: 'g-without', groupName: 'בלי', kind: 'removal', optionId: 'o-onion', name: 'בצל', priceAgorot: 0 },
  ],
  note: 'עשוי היטב',
  categoryId: 'c-burgers',
  sku: 'BRG1',
  barcode: '7290000000017',
  imageUrl: null,
  allergens: ['gluten'],
};
const cola: WebOrderLine = {
  key: 'l2',
  productId: 'p-cola',
  name: 'קולה',
  qty: 1,
  baseAgorot: 1200,
  unitAgorot: 1200,
  options: [],
  note: null,
  categoryId: 'c-drinks',
  sku: null,
  barcode: null,
  imageUrl: null,
  allergens: [],
};

function order(over: Partial<OpenOrder> = {}): OpenOrder {
  return {
    localId: '3b1f2c9e-5a7d-4c1e-9f3a-6d2e8b1a4c55',
    createdAtMs: Date.UTC(2026, 9, 7, 9, 15, 1, 300),
    businessDate: '2026-10-07',
    serviceType: 'take_away',
    tableRef: null,
    fulfillmentMode: 'BON',
    configVersion: 'c727da0ef0f5b92e',
    customerName: 'דנה',
    customerPhone: null,
    lines: [burger, cola],
    tipAgorot: 1300,
    vouchers: [
      {
        redemptionId: '8a5c1d2e-9b7f-4e3a-a1c2-0d9e8f7a6b51',
        serial: 17,
        amountAgorot: 5400,
        eventName: 'כנס',
        redeemed: [{ productId: 'p-burger', tillProductId: 'p-burger', name: 'המבורגר קלאסי', quantity: 1 }],
      },
    ],
    pickupNumber: 17,
    pickupLabel: 'W-17',
    bon: { mode: 'routing', printerId: null, copies: 1 },
    kitchenSent: false,
    cloudState: null,
    rejected: null,
    ...over,
  };
}

describe('pickup numbers', () => {
  it('starts each day at start, counts up, wraps after max', () => {
    const rules = { start: 1, max: 3 };
    assert.equal(nextPickup(null, null, '2026-10-07', rules), 1);
    assert.equal(nextPickup('2026-10-07', 1, '2026-10-07', rules), 2);
    assert.equal(nextPickup('2026-10-07', 3, '2026-10-07', rules), 1);
    assert.equal(nextPickup('2026-10-06', 2, '2026-10-07', rules), 1);
    assert.equal(nextPickup(null, null, '2026-10-07', { start: 0, max: 0 }), 1);
  });

  it('labels with the prefix, and an offline shop number with L', () => {
    assert.equal(pickupLabelOf('A', 17), 'A-17');
    assert.equal(pickupLabelOf('', 17), '17');
    assert.equal(offlinePickupLabel('A', 4), 'AL-4');
    assert.equal(offlinePickupLabel(null, 4), 'L-4');
    assert.equal(localDate(new Date(2026, 9, 7, 23, 59).getTime()), '2026-10-07');
  });
});

describe('the basket for the till', () => {
  it("is the till's held sale: the product as a JSON string, the options as the line's details", () => {
    const cart = JSON.parse(heldSaleCodec('cart-1', [burger, cola]));
    assert.equal(cart.cartId, 'cart-1');
    assert.equal(cart.lines.length, 2);
    const [b, c] = cart.lines;
    assert.equal(b.quantity, 2);
    assert.equal(b.unitPrice, 5900);
    assert.equal(b.discount, 0);
    assert.equal(b.notes, null);
    const product = JSON.parse(b.product);
    assert.equal(product.id, 'p-burger');
    assert.equal(product.cloudId, 'p-burger');
    assert.equal(product.price, 5400);
    assert.equal(product.isAvailable, true);
    assert.deepEqual(product.allergens, ['gluten']);
    assert.equal(b.details.v, 1);
    assert.equal(b.details.basePrice, 54);
    assert.deepEqual(
      b.details.modifiers.map((m: { kind: string; name: string; charged: number }) => [m.kind, m.name, m.charged]),
      [['choice', 'רגיל', 0], ['addon', 'גבינה', 5], ['removal', 'בצל', 0]],
    );
    assert.equal(b.details.noteText, 'עשוי היטב');
    // A plain line carries no details (as the till writes it).
    assert.equal(c.details, null);
    assert.equal(JSON.parse(c.product).sku, 'p-cola'.slice(0, 8));
  });

  it('lists the lines with their total, the options and the note as the tills show them', () => {
    assert.deepEqual(openLines([burger, cola]), [
      { name: 'המבורגר קלאסי', quantity: 2, totalAgorot: 11800, notes: 'רגיל · גבינה · בלי בצל · עשוי היטב' },
      { name: 'קולה', quantity: 1, totalAgorot: 1200 },
    ]);
    assert.equal(goodsAgorot([burger, cola]), 13000);
  });
});

describe('vouchers', () => {
  it("cover the dish's own price — a paid add-on stays to be paid", () => {
    // 2 × 59 = 118, of which the dish's own share is 54/59.
    assert.equal(voucherCoverable(burger), 10800);
    assert.equal(voucherCoverable(cola), 1200);
  });

  it('take what is left on the voucher, no more than the basket holds, less what earlier vouchers took', () => {
    const items = [
      { productId: 'p-burger', tillProductId: 'p-burger', name: 'המבורגר', quantity: 3, remaining: 3 },
      { productId: 'p-fries', tillProductId: null, name: 'צ׳יפס', quantity: 1, remaining: 1 },
    ];
    assert.deepEqual([...voucherTake(items, [burger, cola], [])], [['p-burger', 2]]);
    const earlier = [{ redeemed: [{ productId: 'p-burger', tillProductId: null, name: null, quantity: 1 }] }];
    assert.deepEqual([...coveredUnits([burger, cola], earlier)], [['l1', 1]]);
    assert.deepEqual([...voucherTake(items, [burger, cola], earlier)], [['p-burger', 1]]);
    assert.equal(voucherTake([{ ...items[1] }], [burger, cola], []).size, 0);
  });

  it('a one-time voucher taken in part forfeits the rest (the customer is asked)', () => {
    const items = [{ productId: 'p-burger', tillProductId: null, name: 'המבורגר', quantity: 3, remaining: 3 }];
    assert.equal(voucherForfeits(false, items, new Map([['p-burger', 2]])), true);
    assert.equal(voucherForfeits(true, items, new Map([['p-burger', 2]])), false);
    assert.equal(voucherForfeits(false, items, new Map([['p-burger', 3]])), false);
  });

  it('pays the goods it covers, never the tip, never more than the goods left', () => {
    const one = [{ productId: 'p-burger', tillProductId: null, name: null, quantity: 1 }];
    assert.equal(voucherAmount([burger, cola], [], one), 5400);
    const first = { redemptionId: 'r1', serial: 1, amountAgorot: 5400, eventName: null, redeemed: one };
    assert.equal(voucherAmount([burger, cola], [first], one), 5400);
    // The same burger cannot be paid twice: two units only.
    assert.equal(voucherAmount([burger, cola], [first, { ...first, redemptionId: 'r2' }], one), 0);
    assert.equal(dueAgorot(13000, 1300, [first]), 8900);
    assert.equal(dueAgorot(1000, 0, [first]), 0);
  });

  it('reads a typed or scanned code', () => {
    assert.equal(voucherCodeOf('PV:abcd-efgh-jkmn-pqrs'), 'ABCDEFGHJKMNPQRS');
    assert.equal(voucherCodeOf(']Q1PV:ABCDEFGHJKMNPQRS'), 'ABCDEFGHJKMNPQRS');
    assert.equal(voucherCodeOf('abcd efgh jkmn pqrs'), 'ABCDEFGHJKMNPQRS');
    assert.equal(voucherCodeOf('ab'), null);
    assert.equal(voucherCodeOf('ABCD/EFGH'), null);
  });
});

describe('the open order', () => {
  it('adds up as the cloud checks it: due = total + tip − vouchers', () => {
    const w = openOrderWire(order());
    assert.equal(w.totalAgorot, 13000);
    assert.equal(w.tipAgorot, 1300);
    assert.equal(w.voucherAgorot, 5400);
    assert.equal(w.dueAgorot, 8900);
    assert.equal(orderDue(order()), 8900);
    assert.equal(w.itemCount, 3);
    assert.equal(w.state, 'open');
    assert.equal(orderCode('abc'), 'KO:abc');
    assert.equal(orderNeedsUpload(order()), true);
    assert.equal(orderNeedsUpload(order({ cloudState: 'open' })), false);
    assert.equal(orderNeedsUpload(order({ rejected: 'invalid' })), false);
  });

  it('is the golden fixture the server validates (tests/fixtures/kiosk_web/open_order.json)', () => {
    const dir = join(process.cwd(), '..', 'server', 'tests', 'fixtures', 'kiosk_web');
    const file = join(dir, 'open_order.json');
    const body = `${JSON.stringify({ orders: [openOrderWire(order())] }, null, 2)}\n`;
    if (process.env.UPDATE_GOLDEN === '1' || !existsSync(file)) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(file, body, 'utf8');
    }
    assert.equal(readFileSync(file, 'utf8').replace(/\r\n/g, '\n'), body);
  });

  it('makes v4 ids', () => {
    assert.match(newId(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    let n = 0;
    assert.match(newId(() => ((n += 0.37) % 1)), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
