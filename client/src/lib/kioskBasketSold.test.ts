/**
 * Run with `npm test`. What the basket check may keep (lib/kioskBasketSold.ts), the Android kiosk's KioskBasketLookup /
 * KioskBasketCheck.of for the Windows and the browser kiosk (docs/SPEC_MENUS.md §5.1): a line stays only while its product is
 * still sold here — blocks and channels always win.
 *
 *  - a dish is found where the kiosk SHOWS it, through its own settings (hidden products and categories, a block's "hide" look);
 *  - a line added under a menu may also stay on a product the active menu does not place (`held`) — by the same rules, hiding
 *    included; a line added with no menu may not;
 *  - a meal's component need not be on a screen of its own (held, or hidden for the kiosk) but blocks, sold-out and the cloud's
 *    word still apply.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { basketSold, type BasketProduct } from './kioskBasketSold';
import { resolveKioskConfig } from './kioskConfig';

interface P extends BasketProduct {
  name: string;
}

const row = (id: string, categoryId: string, over: Partial<P> = {}): P => ({ id, name: id, categoryId, soldOut: false, available: true, ...over });

/** "mains" are on the screens (placed by the menu or by the catalog); "sides" are held: the active menu does not place them. */
const screens = [row('burger', 'mains'), row('pasta', 'mains')];
const held = [row('fries', 'sides'), row('cola', 'drinks')];
const categories = [{ id: 'mains' }];

const cfgOf = (catalog: Record<string, unknown> = {}, general: Record<string, unknown> = {}) => resolveKioskConfig({ catalog, general } as never);

function sold(over: { products?: P[]; held?: P[]; cfg?: ReturnType<typeof cfgOf>; gone?: string[] } = {}) {
  return basketSold<P>({
    products: over.products ?? screens,
    categories,
    held: over.held ?? held,
    cfg: over.cfg ?? cfgOf(),
    gone: over.gone ? new Set(over.gone) : null,
  });
}

describe('a dish stays only where the kiosk still sells it', () => {
  it('on the screens: found, with a menu or without; a product that is not there is not', () => {
    const s = sold();
    assert.equal(s.dish('burger', false)?.id, 'burger');
    assert.equal(s.dish('burger', true)?.id, 'burger');
    assert.equal(s.dish('nothing', true), null);
  });

  it('sold out, blocked or locked (soldOut) and the cloud\'s "gone" take it off — wherever it is', () => {
    assert.equal(sold({ products: [row('burger', 'mains', { soldOut: true }), ...screens.slice(1)] }).dish('burger', true), null);
    assert.equal(sold({ gone: ['burger', 'fries'] }).dish('burger', true), null);
    assert.equal(sold({ gone: ['fries'] }).dish('fries', true), null);
    assert.equal(sold({ held: [row('fries', 'sides', { soldOut: true })] }).dish('fries', true), null);
  });

  it('hidden in the kiosk\'s own settings — the product, its category, or a block\'s "hide" look — it goes, though the catalog sells it', () => {
    assert.equal(sold({ cfg: cfgOf({ hiddenProducts: ['burger'] }) }).dish('burger', true), null);
    assert.equal(sold({ cfg: cfgOf({ hiddenProducts: ['burger'] }) }).dish('burger', false), null);
    assert.equal(sold({ cfg: cfgOf({ hiddenCategories: ['mains'] }) }).dish('pasta', true), null);
    assert.equal(sold({ products: [row('burger', 'mains', { kioskDisplay: 'hide' }), ...screens.slice(1)] }).dish('burger', true), null);
    // The others stay.
    assert.equal(sold({ cfg: cfgOf({ hiddenProducts: ['burger'] }) }).dish('pasta', true)?.id, 'pasta');
  });

  it('held: only for a line added under a menu', () => {
    const s = sold();
    assert.equal(s.dish('fries', true)?.id, 'fries');
    assert.equal(s.dish('fries', false), null, 'a line added with no menu goes when it is not on the screens');
  });

  it('held, but hidden in the kiosk\'s settings (the product, its category, "hide") — goes: never kept for having been added under a menu', () => {
    assert.equal(sold({ cfg: cfgOf({ hiddenProducts: ['fries'] }) }).dish('fries', true), null);
    assert.equal(sold({ cfg: cfgOf({ hiddenCategories: ['sides'] }) }).dish('fries', true), null);
    assert.equal(sold({ held: [row('fries', 'sides', { kioskDisplay: 'hide' })] }).dish('fries', true), null);
    assert.equal(sold({ cfg: cfgOf({ hiddenProducts: ['fries'] }) }).dish('cola', true)?.id, 'cola');
  });

  it('a product on the screens but hidden is not rescued by `held` or by the menu line', () => {
    const s = sold({ cfg: cfgOf({ hiddenProducts: ['burger'] }), held: [row('burger', 'mains'), ...held] });
    assert.equal(s.dish('burger', true), null);
  });
});

describe('a meal\'s component', () => {
  it('is found even when no screen shows it — held by the menu, or hidden for the kiosk', () => {
    assert.equal(sold().component('fries')?.id, 'fries');
    assert.equal(sold({ cfg: cfgOf({ hiddenProducts: ['fries', 'burger'], hiddenCategories: ['sides'] }) }).component('fries')?.id, 'fries');
    assert.equal(sold({ cfg: cfgOf({ hiddenProducts: ['burger'] }) }).component('burger')?.id, 'burger');
  });

  it('but never when blocked, sold out or gone', () => {
    assert.equal(sold({ held: [row('fries', 'sides', { soldOut: true })] }).component('fries'), null);
    assert.equal(sold({ products: [row('burger', 'mains', { soldOut: true })] }).component('burger'), null);
    assert.equal(sold({ gone: ['fries'] }).component('fries'), null);
    assert.equal(sold().component('nothing'), null);
  });
});
