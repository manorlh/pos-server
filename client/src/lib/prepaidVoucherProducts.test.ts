/**
 * Run with `npm test`. Prepaid vouchers and every product type (lib/prepaidVoucherProducts.ts,
 * pos-server docs/SPEC_VOUCHER_PRODUCTION.md §7.14): the pickers' rows as the cloud answers them,
 * the badge for why a product cannot be used and what to know about one that can, and a goods
 * line by weight — the same words as the server's `item_text`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  blockKeyOf,
  clampQuantity,
  itemText,
  noteKeysOf,
  prepaidBlockOf,
  prepaidProductOf,
  quantityNumberText,
  quantityStep,
  quantityText,
  sortForPurpose,
} from './prepaidVoucherProducts';

const row = (over: Record<string, unknown> = {}) =>
  prepaidProductOf({ id: 'p1', name: 'נקניקייה', price: 25, sku: 's', blocked: { goods: null, itemDiscount: null }, notes: [], ...over });

describe('prepaidProductOf', () => {
  it('reads a row of GET /prepaid-vouchers/products', () => {
    const p = prepaidProductOf({
      id: 'p2', name: 'זיתים', price: 40, isWeighed: true, unitLabel: 'ק"ג',
      blocked: { goods: null, itemDiscount: null }, notes: ['weighed', 'not_listed'], shopName: null,
    });
    assert.equal(p.isWeighed, true);
    assert.equal(p.unitLabel, 'ק"ג');
    assert.deepEqual(p.notes, ['weighed', 'not_listed']);
    assert.deepEqual(p.blocked, { goods: null, itemDiscount: null });
  });

  it('an older server (no blocked, no notes) reads as usable; unknown codes are dropped', () => {
    const old = prepaidProductOf({ id: 'p3', name: 'x', price: 1 });
    assert.equal(prepaidBlockOf(old, 'items'), null);
    assert.equal(prepaidBlockOf(old, 'item_discount'), null);
    assert.deepEqual(old.notes, []);
    const newer = prepaidProductOf({ id: 'p4', name: 'y', price: 1, blocked: { goods: 'later_reason' }, notes: ['later_note', 'meal'] });
    assert.equal(prepaidBlockOf(newer, 'items'), null);
    assert.deepEqual(newer.notes, ['meal']);
  });
});

describe('why not, and what to know', () => {
  it('a reason per purpose; the general item reads differently on an item discount', () => {
    const general = row({ blocked: { goods: 'general', itemDiscount: 'general' } });
    assert.equal(blockKeyOf(general, 'items'), 'general');
    assert.equal(blockKeyOf(general, 'item_discount'), 'generalItem');
    const open = row({ blocked: { goods: 'open_price', itemDiscount: null }, notes: ['open_price'] });
    assert.equal(blockKeyOf(open, 'items'), 'open_price');
    assert.equal(blockKeyOf(open, 'item_discount'), null);
    const smokes = row({ blocked: { goods: null, itemDiscount: 'no_discount' } });
    assert.equal(blockKeyOf(smokes, 'items'), null);
    assert.equal(blockKeyOf(smokes, 'item_discount'), 'no_discount');
  });

  it('a goods voucher covers a base price; a discount takes the actual price', () => {
    const burger = row({ notes: ['options', 'meal', 'weighed', 'kiosk_only'] });
    assert.deepEqual(noteKeysOf(burger, 'items'), ['options', 'meal', 'weighed', 'kiosk_only']);
    assert.deepEqual(noteKeysOf(burger, 'item_discount'), ['optionsDiscount', 'mealDiscount', 'weighedDiscount', 'kiosk_only']);
  });

  it('an open price is a note only where it can be used; nothing under a reason', () => {
    const open = row({ blocked: { goods: 'open_price', itemDiscount: null }, notes: ['open_price'] });
    assert.deepEqual(noteKeysOf(open, 'items'), []);
    assert.deepEqual(noteKeysOf(open, 'item_discount'), ['open_price']);
  });

  it('made on a till: named by its shop when known', () => {
    assert.deepEqual(noteKeysOf(row({ notes: ['till_made'], shopName: 'הרצליה' }), 'items'), ['till_made']);
    assert.deepEqual(noteKeysOf(row({ notes: ['till_made'] }), 'items'), ['till_made_plain']);
  });

  it('usable for the purpose first, then by name', () => {
    const rows = [
      row({ id: 'a', name: 'א כללי', blocked: { goods: 'general', itemDiscount: 'general' } }),
      row({ id: 'b', name: 'ב סיגריות', blocked: { goods: null, itemDiscount: 'no_discount' } }),
      row({ id: 'c', name: 'ג פתוח', blocked: { goods: 'open_price', itemDiscount: null } }),
    ];
    assert.deepEqual(sortForPurpose(rows, 'items').map((r) => r.id), ['b', 'a', 'c']);
    assert.deepEqual(sortForPurpose(rows, 'item_discount').map((r) => r.id), ['c', 'a', 'b']);
  });
});

describe('a goods line by weight', () => {
  it('as the server prints it', () => {
    assert.equal(itemText({ name: 'נקניקייה', quantity: 2 }), '2× נקניקייה');
    assert.equal(itemText({ name: 'זיתים', quantity: 0.5, weighed: true, unitLabel: 'ק"ג' }), '0.5 ק"ג זיתים');
    assert.equal(itemText({ name: 'גבינה', quantity: 1.25, weighed: true }), '1.25 ק"ג גבינה');
    assert.equal(quantityText(3), '3×');
    assert.equal(quantityText(0.3, true, 'ליטר'), '0.3 ליטר');
    assert.equal(quantityNumberText(0.1 + 0.2), '0.3');
  });

  it('by weight to the gram, by the piece whole; never 0, never over 100', () => {
    assert.equal(clampQuantity(0.5, true), 0.5);
    assert.equal(clampQuantity(0.12345, true), 0.123);
    assert.equal(clampQuantity(0, true), 0.001);
    assert.equal(clampQuantity(-1, true), 0.001);
    assert.equal(clampQuantity(250, true), 100);
    assert.equal(clampQuantity(1.6, false), 2);
    assert.equal(clampQuantity(0, false), 1);
    assert.equal(clampQuantity(Number.NaN, false), 1);
    assert.equal(quantityStep(true), 0.5);
    assert.equal(quantityStep(false), 1);
  });
});
