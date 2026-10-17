/**
 * "הכל" in the order's categories (core/till/sellAllTab.ts ⇔ pos-android domain/SellAllTab.kt): the parameter, the
 * bar's tabs per mode, and the category the order opens on.
 */
import { describe, expect, it } from 'vitest';
import { categoryBarOf, parseSellAllTab } from '../src/core/till/sellAllTab';
import { shownProducts } from '../src/renderer/roles/till/design/designLayout';

describe('sellAllTab', () => {
  it('parses first / last; unset or unknown is hidden (the default)', () => {
    expect(parseSellAllTab('first')).toBe('first');
    expect(parseSellAllTab(' LAST ')).toBe('last');
    expect(parseSellAllTab('hidden')).toBe('hidden');
    expect(parseSellAllTab(undefined)).toBe('hidden');
    expect(parseSellAllTab('אמצע')).toBe('hidden');
  });

  it('first: "הכל" before the categories, the pick as it is', () => {
    expect(categoryBarOf('first', ['a', 'b'], null, false)).toEqual({ tabs: [null, 'a', 'b'], selected: null });
    expect(categoryBarOf('first', ['a', 'b'], 'b', true)).toEqual({ tabs: [null, 'a', 'b'], selected: 'b' });
  });

  it('last: "הכל" after them; the order opens on the first category; "הכל" tapped stays', () => {
    expect(categoryBarOf('last', ['a', 'b'], null, false)).toEqual({ tabs: ['a', 'b', null], selected: 'a' });
    expect(categoryBarOf('last', ['a', 'b'], null, true).selected).toBeNull();
    expect(categoryBarOf('last', ['a', 'b'], 'gone', true).selected).toBe('a');
  });

  it('hidden: the categories only, opening on the first; none at all — every product', () => {
    expect(categoryBarOf('hidden', ['a', 'b'], null, false)).toEqual({ tabs: ['a', 'b'], selected: 'a' });
    expect(categoryBarOf('hidden', ['a', 'b'], 'b', true).selected).toBe('b');
    expect(categoryBarOf('hidden', ['a'], 'x', true, ['a', 'x']).selected).toBe('x');
    expect(categoryBarOf('hidden', [], null, false)).toEqual({ tabs: [], selected: null });
  });

  it('a search looks through every product whatever the category', () => {
    const p = (id: string, departmentId: string, name: string) => ({ id, departmentId, name, priceAgorot: 100 }) as never;
    const all = [p('1', 'a', 'קפה'), p('2', 'b', 'קפה קר')];
    expect(shownProducts(all, all, 'a', 'קפה').map((x: { id: string }) => x.id)).toEqual(['1', '2']);
    expect(shownProducts(all, all, 'a', '').map((x: { id: string }) => x.id)).toEqual(['1']);
  });
});
