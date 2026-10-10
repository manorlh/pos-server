/**
 * Run with `npm test`. "הודעות לעובד" and "פריטים נלווים" as the product form edits them
 * (lib/productExtras.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALERT_TEXT_MAX,
  alertsOf,
  alertsPayload,
  alertsProblem,
  allergenAlertText,
  companionUnitPrice,
  companionsFromIds,
  companionsOf,
  companionsPayload,
  companionsProblem,
  kitchenPrintChoice,
  kitchenPrintValue,
  moveItem,
  newAlert,
  withKind,
  type ProductCompanion,
} from './productExtras';

const HE: Record<string, string> = { gluten: 'גלוטן', eggs: 'ביצים', sesame: 'שומשום' };
const label = (c: string) => HE[c] ?? c;

describe('the allergen alert', () => {
  it('names the allergens in Hebrew, in the fixed order', () => {
    assert.equal(allergenAlertText(['eggs', 'gluten'], label), 'מכיל: גלוטן, ביצים — עדכנו את הלקוח!');
    assert.equal(allergenAlertText(['SESAME', 'nonsense'], label), 'מכיל: שומשום — עדכנו את הלקוח!');
  });
  it('says nothing without allergens', () => {
    assert.equal(allergenAlertText([], label), null);
    assert.equal(allergenAlertText(undefined, label), null);
  });
});

describe('alerts', () => {
  it('a new one is information, everywhere, not to be confirmed; an allergen asks to be', () => {
    assert.deepEqual(newAlert(), { text: '', kind: 'info', requireAck: false, whereShown: 'both' });
    assert.equal(withKind(newAlert(), 'allergen').requireAck, true);
    assert.equal(withKind(newAlert(), 'warning').requireAck, false);
    assert.equal(withKind({ ...newAlert(), requireAck: true }, 'info').requireAck, true);
  });
  it('reorders one place at a time, never past an end', () => {
    assert.deepEqual(moveItem(['a', 'b', 'c'], 2, -1), ['a', 'c', 'b']);
    assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 1), ['b', 'a', 'c']);
    const list = ['a', 'b'];
    assert.equal(moveItem(list, 0, -1), list);
    assert.equal(moveItem(list, 1, 1), list);
  });
  it('reads what is stored, unknown values as the defaults', () => {
    assert.deepEqual(alertsOf(null), []);
    assert.deepEqual(alertsOf([{ text: 'חם', kind: 'x', whereShown: 'kitchen', requireAck: 'yes' }, 7]), [
      { text: 'חם', kind: 'info', requireAck: false, whereShown: 'both' },
    ]);
  });
  it('an empty or too long text is a problem; trimmed for the server', () => {
    assert.equal(alertsProblem([]), null);
    assert.equal(alertsProblem([{ ...newAlert(), text: '  ' }]), 'empty');
    assert.equal(alertsProblem([{ ...newAlert(), text: 'x'.repeat(ALERT_TEXT_MAX + 1) }]), 'tooLong');
    assert.equal(alertsProblem([{ ...newAlert(), text: 'x'.repeat(ALERT_TEXT_MAX) }]), null);
    assert.equal(alertsProblem(Array.from({ length: 11 }, () => ({ ...newAlert(), text: 'x' }))), 'tooMany');
    assert.equal(alertsPayload([{ ...newAlert(), text: '  מכיל ביצים  ' }])[0].text, 'מכיל ביצים');
  });
});

describe('companions', () => {
  const ice: ProductCompanion = { productId: 'ice', quantity: 2, priceMode: 'custom', price: 1.5, kitchenPrint: false };

  it('the picker keeps the rows set, adds new ones at the item price, never itself or twice', () => {
    const out = companionsFromIds(['ice', 'lemon', 'cola', 'lemon'], [ice], 'cola');
    assert.deepEqual(out, [ice, { productId: 'lemon', quantity: 1, priceMode: 'item', price: null, kitchenPrint: null }]);
  });
  it('a set price must be there and not negative', () => {
    assert.equal(companionsProblem([ice]), null);
    assert.equal(companionsProblem([{ ...ice, price: null }]), 'customPrice');
    assert.equal(companionsProblem([{ ...ice, price: -1 }]), 'customPrice');
    assert.equal(companionsProblem([{ ...ice, priceMode: 'free', price: null }]), null);
  });
  it('sends a price only for a set one, the quantity within 1–99', () => {
    assert.deepEqual(companionsPayload([{ ...ice, price: 1.556, quantity: 500 },{ productId: 'x', quantity: 0, priceMode: 'free', price: 9 }]), [
      { productId: 'ice', quantity: 99, priceMode: 'custom', price: 1.56, kitchenPrint: false },
      { productId: 'x', quantity: 1, priceMode: 'free', price: null, kitchenPrint: null },
    ]);
  });
  it('reads what is stored', () => {
    assert.deepEqual(companionsOf([{ productId: 'ice', name: 'כוס קרח', quantity: 1, priceMode: 'free', price: null, kitchenPrint: null }, { name: 'no id' }]), [
      { productId: 'ice', name: 'כוס קרח', quantity: 1, priceMode: 'free', price: null, kitchenPrint: null },
    ]);
  });
  it('"הדפס במטבח": own routing, with the product, or not printed', () => {
    assert.equal(kitchenPrintChoice(null), 'own');
    assert.equal(kitchenPrintChoice(true), 'parent');
    assert.equal(kitchenPrintChoice(false), 'none');
    for (const c of ['own', 'parent', 'none'] as const) assert.equal(kitchenPrintChoice(kitchenPrintValue(c)), c);
  });
  it('the price on the till: the item\'s, ₪0, or the set one', () => {
    assert.equal(companionUnitPrice({ ...ice, priceMode: 'item' }, 2), 2);
    assert.equal(companionUnitPrice({ ...ice, priceMode: 'free' }, 2), 0);
    assert.equal(companionUnitPrice(ice, 2), 1.5);
  });
});
