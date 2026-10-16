/**
 * "הנחות קבועות" (P:/specs/preset-discounts.md §2, §4): the till reads the presets and applies one exactly as pos-server's
 * app/services/preset_discounts.py (`resolve_for_till`, `apply_preset`) and pos-android do. `preset_discounts_golden.json`
 * is byte-equal in the three repos; each pins the same SHA-256 of its LF bytes.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyPreset, presetCartDiscount, presetDocFields, presetForOf, presetLabel, resolvePresetDiscounts } from '../src/core/till/presetDiscounts';
import { documentDiscountAmount } from '../src/core/till/discounts';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SellState } from '../src/shared/till/protocol';
import { CartPane } from '../src/renderer/roles/till/parts/CartPane';
import { BasketDiscountSheet, PresetForSheet } from '../src/renderer/roles/till/parts/TillSheets';

const noop = () => undefined;

const GOLDEN_SHA256 = 'e63eeca9e9b19d111b429def511029b14441ada9ad0e4eeaeb3e4207fe18e443';
const text = readFileSync(path.join(__dirname, 'fixtures', 'preset_discounts_golden.json'), 'utf8').replace(/\r\n/g, '\n');

interface ApplyCase {
  name: string;
  payableAgorot: number;
  nonDiscountableAgorot: number;
  preset: { kind: string; value: unknown };
  expect: { canApply: boolean; discountAgorot: number; totalAgorot: number; ratePercent: number | null };
}
interface ResolveCase {
  name: string;
  presetDiscounts: unknown;
  presetDiscountButtons: unknown;
  expect: { presets: unknown[]; buttons: string[] };
}
const golden = JSON.parse(text) as { apply: ApplyCase[]; resolve: ResolveCase[] };

describe('preset discounts golden', () => {
  it('is the shared fixture, byte for byte', () => {
    expect(createHash('sha256').update(text, 'utf8').digest('hex')).toBe(GOLDEN_SHA256);
    expect(golden.apply.length).toBeGreaterThan(0);
    expect(golden.resolve.length).toBeGreaterThan(0);
  });

  for (const c of golden.apply) {
    it(`apply: ${c.name}`, () => {
      expect(applyPreset(c.payableAgorot, c.nonDiscountableAgorot, c.preset.kind, c.preset.value)).toEqual(c.expect);
      // The cart's own arithmetic over the basket discount a preset becomes gives the same sum.
      const d = presetCartDiscount({ kind: c.preset.kind as 'percent' | 'amount', value: c.preset.value as number });
      if (c.expect.canApply && d) {
        const base = c.payableAgorot - Math.max(c.nonDiscountableAgorot, 0);
        expect(documentDiscountAmount(base, d)).toBe(c.expect.discountAgorot);
      }
    });
  }

  for (const c of golden.resolve) {
    it(`resolve: ${c.name}`, () => {
      expect(resolvePresetDiscounts(c.presetDiscounts, c.presetDiscountButtons)).toEqual(c.expect);
    });
  }
});

describe('preset discounts at the till', () => {
  it('values: HALF_UP to two decimals, exact on the decimal text', () => {
    expect(applyPreset(10_000, 0, 'percent', '12.345').discountAgorot).toBe(1_235);
    expect(applyPreset(10_000, 0, 'percent', 0.005).ratePercent).toBe(0.01);
    expect(applyPreset(10_000, 0, 'percent', 100.004).ratePercent).toBe(100);
    expect(applyPreset(10_000, 0, 'percent', 100.005).canApply).toBe(false);
    expect(applyPreset(10_000, 0, 'percent', true).canApply).toBe(false);
    expect(applyPreset(10_000, 0, 'amount', '1e1').discountAgorot).toBe(1_000);
    expect(applyPreset(10_000, 0, 'gift', 10).canApply).toBe(false);
  });

  it('a name is collapsed, cut to 24 and trimmed; at most 20 presets', () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ id: `p${i}`, name: `  הנחה\t ${i}  `, kind: 'percent', value: 5 }));
    const r = resolvePresetDiscounts(many, null);
    expect(r.presets).toHaveLength(20);
    expect(r.presets[3].name).toBe('הנחה 3');
    expect(resolvePresetDiscounts([{ id: 'x', name: 'א'.repeat(23) + ' ב', kind: 'amount', value: 1 }], null).presets[0].name).toBe('א'.repeat(23));
  });

  it('for whom: none ignores it, required refuses a blank, a typed name keeps no ref', () => {
    expect(presetForOf({ forWhom: 'none' }, { for: 'דנה' })).toEqual({ for: null, forKind: null, forRef: null });
    expect(presetForOf({ forWhom: 'required' }, { for: '   ' })).toBe('required');
    expect(presetForOf({ forWhom: 'optional' }, {})).toEqual({ for: null, forKind: null, forRef: null });
    expect(presetForOf({ forWhom: 'optional' }, { for: ' דנה  כהן ', forKind: 'employee', forRef: 'u-1' })).toEqual({ for: 'דנה כהן', forKind: 'employee', forRef: 'u-1' });
    expect(presetForOf({ forWhom: 'required' }, { for: 'משה', forKind: 'boss', forRef: 'x' })).toEqual({ for: 'משה', forKind: 'typed', forRef: null });
  });

  it('labels and document fields', () => {
    expect(presetLabel('הנחת עובדים', 'percent', 40)).toBe('הנחת עובדים 40%');
    expect(presetLabel('הנחת מנוי', 'percent', 12.5)).toBe('הנחת מנוי 12.5%');
    expect(presetLabel('שובר', 'amount', 20)).toBe('שובר');
    const mark = { id: 'staff', name: 'הנחת עובדים', kind: 'percent' as const, for: 'דנה', forKind: 'employee' as const, forRef: 'u-1' };
    expect(presetDocFields('manual', mark)).toEqual({});
    expect(presetDocFields('preset', mark)).toEqual({ presetDiscountId: 'staff', presetDiscountName: 'הנחת עובדים', presetDiscountFor: 'דנה', presetDiscountForKind: 'employee', presetDiscountForRef: 'u-1' });
    expect(presetDocFields('preset', { ...mark, for: null, forKind: null, forRef: null })).toEqual({ presetDiscountId: 'staff', presetDiscountName: 'הנחת עובדים' });
  });
});

describe('preset discounts on the screens', () => {
  const items = [
    { id: 'member', name: 'הנחת מנוי', kind: 'percent' as const, value: 10, color: '#1E88E5', requiresManager: false, forWhom: 'none' as const, forWhomSource: 'free' as const },
    { id: 'staff', name: 'הנחת עובדים', kind: 'percent' as const, value: 40, color: null, requiresManager: false, forWhom: 'required' as const, forWhomSource: 'employees' as const },
  ];
  const sell = (over: Partial<SellState> = {}): SellState => ({
    catalogVersion: 1,
    departmentId: null,
    search: '',
    lines: [{ lineId: 'l1', productId: 'p', name: 'המבורגר', qty: 1, unitAgorot: 4_200, discountPct: 0, totalAgorot: 4_200 }],
    itemCount: 1,
    totalAgorot: 3_780,
    vatAgorot: 0,
    ...over,
  });
  const actions = { setQty: noop, remove: noop, clear: noop, pay: noop, preset: noop };

  it('the cart: one button per one-tap preset, the active one on, its name and whom for in the totals', () => {
    const none = renderToStaticMarkup(createElement(CartPane, { sell: sell(), actions, view: {} }));
    expect(none).not.toContain('הנחת מנוי');
    const html = renderToStaticMarkup(
      createElement(CartPane, {
        sell: sell({ basketDiscount: { amountAgorot: 420, type: 'percentage', value: 1_000, preset: { id: 'member', name: 'הנחת מנוי', for: 'דנה' } } }),
        actions,
        view: { presetButtons: items },
      }),
    );
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('background:#1E88E5');
    expect(html).toContain('הנחת עובדים');
    expect(html).toContain('עבור: דנה');
    // "כשאין הרשאה" = להסתיר on DISCOUNT: only the one on the basket stays (to take it off).
    const hidden = renderToStaticMarkup(createElement(CartPane, { sell: sell({ basketDiscount: { amountAgorot: 420, type: 'percentage', value: 1_000, preset: { id: 'member', name: 'הנחת מנוי', for: null } } }), actions, view: { presetButtons: items, hidden: ['DISCOUNT'] } }));
    expect(hidden).not.toContain('הנחת עובדים');
  });

  it('the basket discount sheet: the chips at the top; "עבור מי" lists the employees', () => {
    const html = renderToStaticMarkup(createElement(BasketDiscountSheet, { preview: async () => undefined, apply: noop, current: null, presets: items, onPreset: noop, onClose: noop }));
    expect(html.indexOf('הנחת מנוי')).toBeLessThan(html.indexOf('החל הנחה'));
    const who = renderToStaticMarkup(createElement(PresetForSheet, { preset: items[1], employees: [{ id: 'u1', name: 'דנה כהן' }], onApply: noop, onClose: noop }));
    expect(who).toContain('הנחת עובדים — עבור מי?');
    expect(who).toContain('דנה כהן');
    expect(who).not.toContain('בלי שם');
  });
});
