/**
 * "הנחות קבועות" on the Windows till (P:/specs/preset-discounts.md §3, §5) — over a REAL KioskService (tillEngineHarness):
 * nothing shows until the settings set presets; a tap replaces the basket discount, the same tap takes it off, a keyed
 * discount afterwards replaces it; DISCOUNT's ceiling and `requiresManager` ask a manager the way the keyed basket discount
 * does; the no-discount products keep their price; the held sale keeps it; the document and the receipt name it.
 */

import bcrypt from 'bcryptjs';
import { afterEach, describe, expect, it } from 'vitest';
import { documentWire, type DocDraft } from '../src/main/fiscal/ledger';
import type { PrintDoc } from '../src/core/printDocs';
import { MANAGER_PIN, readyTill, roster, type Harness, type HarnessOptions } from './tillEngineHarness';

const open: Harness[] = [];
afterEach(() => {
  for (const h of open.splice(0)) h.stop();
});
const till = async (o: HarnessOptions = {}, pin = MANAGER_PIN) => {
  const h = await readyTill(o, pin);
  open.push(h);
  return h;
};
const allDocs = (h: Harness): DocDraft[] => h.svc.ledger.docsOfShift(h.svc.ledger.currentShift()!.id);
const wireOf = (d: DocDraft) => documentWire(d) as Record<string, unknown>;
const receipt = (h: Harness, docId: string): PrintDoc | null => {
  const j = h.svc.printQueue.jobsFor(docId, 'receipt')[0];
  return j ? (JSON.parse(j.doc) as PrintDoc) : null;
};
const rowsOf = (doc: PrintDoc | null) => (doc && doc.kind === 'receipt' ? doc.ops.filter((o): o is Extract<typeof o, { t: 'row' }> => o.t === 'row').map((o) => [o.label, o.value]) : []);
const textsOf = (doc: PrintDoc | null) => (doc && doc.kind === 'receipt' ? doc.ops.filter((o): o is Extract<typeof o, { t: 'text' }> => o.t === 'text').map((o) => o.text) : []);

async function approveWith(h: Harness, pin: string) {
  const d = h.state().dialog;
  if (!d) throw new Error('no dialog');
  return h.call('dialog.answer', { dialogId: d.id, action: 'approve', answers: { pin } });
}

function cloudUser(id: string, pin: string, permissions: Record<string, string>, limits: Record<string, Record<string, number>> | null = null) {
  return { id, username: id, firstName: id, lastName: null, pinHash: bcrypt.hashSync(pin, 4), role: 'cashier', isActive: true, shopId: null, permissions, limits, tillRoleKey: id };
}

const PRODUCTS = [
  { id: 'p-burger', name: 'המבורגר', price: 42, categoryId: 'c-main', inStock: true, isAvailable: true, trackStock: false, salesChannel: 'all' },
  { id: 'p-wine', name: 'יין', price: 80, categoryId: 'c-main', inStock: true, isAvailable: true, trackStock: false, salesChannel: 'all', noDiscount: true },
];

const PRESETS = [
  { id: 'member', name: 'הנחת מנוי', kind: 'percent', value: 10, color: '#1e88e5' },
  { id: 'staff', name: 'הנחת עובדים', kind: 'percent', value: 40, forWhom: 'required', forWhomSource: 'employees' },
  { id: 'gift', name: 'מתנה', kind: 'amount', value: 50, button: false },
  { id: 'boss', name: 'באישור', kind: 'percent', value: 5, requiresManager: true, forWhom: 'optional' },
  { id: 'off', name: 'כבויה', kind: 'percent', value: 15, active: false },
];

const withPresets = (extra: Record<string, unknown> = {}): HarnessOptions => ({ products: PRODUCTS, settings: { presetDiscounts: PRESETS, ...extra } });

describe('"הנחות קבועות" on the till', () => {
  it('nothing configured: nothing offered, a tap refused', async () => {
    const h = await till({ products: PRODUCTS });
    expect(h.state().presetDiscounts).toBeUndefined();
    await h.ok('sell.add', { productId: 'p-burger' });
    expect((await h.fail('discount.preset', { presetId: 'member' })).code).toBe('discount_refused');
  });

  it('the state: active presets in order, the buttons, the employees for whom', async () => {
    const h = await till(withPresets());
    const s = h.state().presetDiscounts!;
    expect(s.items.map((p) => p.id)).toEqual(['member', 'staff', 'gift', 'boss']);
    expect(s.items[0]).toMatchObject({ name: 'הנחת מנוי', kind: 'percent', value: 10, color: '#1E88E5' });
    expect(s.buttons).toEqual(['member', 'staff', 'boss']);
    expect(s.employees?.map((e) => e.id)).toEqual(roster().map((u) => u.id));
    const chosen = await till(withPresets({ presetDiscountButtons: ['gift'] }));
    expect(chosen.state().presetDiscounts!.buttons).toEqual(['gift']);
  });

  it('replaces, toggles, skips the no-discount lines; a keyed discount replaces it', async () => {
    const h = await till(withPresets());
    await h.ok('sell.add', { productId: 'p-burger' });
    await h.ok('sell.add', { productId: 'p-wine' });
    await h.ok('discount.apply', { mode: 'fixed', input: '5' });
    await h.ok('discount.preset', { presetId: 'member' });
    // 10% of ₪42 (the wine takes none), replacing the keyed ₪5.
    expect(h.state().sell.basketDiscount).toMatchObject({ amountAgorot: 420, type: 'percentage', value: 1_000, preset: { id: 'member', name: 'הנחת מנוי', for: null } });
    expect(h.state().sell.totalAgorot).toBe(11_780);
    // Another preset replaces it; an amount larger than the discountable lines is capped, not refused.
    await h.ok('discount.preset', { presetId: 'gift' });
    expect(h.state().sell.basketDiscount).toMatchObject({ amountAgorot: 4_200, type: 'fixed', preset: { id: 'gift' } });
    // The same preset again: off.
    await h.ok('discount.preset', { presetId: 'gift' });
    expect(h.state().sell.basketDiscount ?? null).toBeNull();
    await h.ok('discount.preset', { presetId: 'member' });
    await h.ok('discount.apply', { mode: 'percent', input: '20' });
    expect(h.state().sell.basketDiscount).toMatchObject({ amountAgorot: 840, value: 2_000 });
    expect(h.state().sell.basketDiscount?.preset).toBeUndefined();
    // An inactive or unknown preset is refused.
    expect((await h.fail('discount.preset', { presetId: 'off' })).code).toBe('discount_refused');
  });

  it('only no-discount lines: refused', async () => {
    const h = await till(withPresets());
    await h.ok('sell.add', { productId: 'p-wine' });
    expect((await h.fail('discount.preset', { presetId: 'member' })).message).toBe('אין בהזמנה פריטים שמקבלים הנחה');
  });

  it("above the role's maxPercent: the manager's code, as the keyed discount", async () => {
    const users = [...roster(), cloudUser('sup30', '3030', { SELL: 'allow', DISCOUNT: 'allow', SHIFT_OPEN: 'allow' }, { DISCOUNT: { maxPercent: 30 } })];
    const h = await till({ ...withPresets(), users }, '3030');
    await h.ok('sell.add', { productId: 'p-burger' });
    await h.ok('discount.preset', { presetId: 'member' });
    expect(h.state().dialog).toBeNull();
    await h.ok('discount.preset', { presetId: 'staff', for: 'אבי לוי', forKind: 'employee', forRef: 'u-manager' });
    expect(h.state().dialog?.kind).toBe('manager_approval');
    // Still the member's until approved.
    expect(h.state().sell.basketDiscount?.preset?.id).toBe('member');
    expect((await approveWith(h, MANAGER_PIN)).ok).toBe(true);
    expect(h.state().sell.basketDiscount).toMatchObject({ amountAgorot: 1_680, preset: { id: 'staff', for: 'אבי לוי' } });
  });

  it('requiresManager: always a code, even for a role that may', async () => {
    const h = await till(withPresets());
    await h.ok('sell.add', { productId: 'p-burger' });
    await h.ok('discount.preset', { presetId: 'boss' });
    expect(h.state().dialog?.kind).toBe('manager_approval');
    expect((await approveWith(h, MANAGER_PIN)).ok).toBe(true);
    expect(h.state().sell.basketDiscount?.preset?.id).toBe('boss');
  });

  it('for whom required: refused without a name', async () => {
    const h = await till(withPresets());
    await h.ok('sell.add', { productId: 'p-burger' });
    expect((await h.fail('discount.preset', { presetId: 'staff' })).message).toBe('יש לבחור עבור מי ההנחה');
    expect((await h.fail('discount.preset', { presetId: 'staff', for: '   ' })).code).toBe('invalid_args');
  });

  it('kept on a held sale', async () => {
    const h = await till(withPresets());
    await h.ok('sell.add', { productId: 'p-burger' });
    await h.ok('discount.preset', { presetId: 'staff', for: 'דנה כהן', forKind: 'employee', forRef: 'u-cashier' });
    const { id } = await h.ok<{ id: string }>('held.hold', {});
    expect(h.state().sell.basketDiscount ?? null).toBeNull();
    await h.ok('held.resume', { id });
    expect(h.state().sell.basketDiscount).toMatchObject({ amountAgorot: 1_680, preset: { id: 'staff', for: 'דנה כהן' } });
  });

  it('on the document and the receipt: kind "preset", the id, the name, whom for', async () => {
    const h = await till(withPresets());
    await h.ok('sell.add', { productId: 'p-burger' });
    await h.ok('sell.add', { productId: 'p-wine' });
    await h.ok('discount.preset', { presetId: 'staff', for: 'דנה כהן', forKind: 'employee', forRef: 'u-cashier' });
    await h.ok('checkout.start');
    await h.ok('checkout.cash', { amountAgorot: h.state().checkout.dueAgorot });
    const d = allDocs(h)[0];
    expect(wireOf(d)).toMatchObject({
      basketDiscount: 16.8,
      basketDiscountPercent: 40,
      basketDiscountKind: 'preset',
      presetDiscountId: 'staff',
      presetDiscountName: 'הנחת עובדים',
      presetDiscountFor: 'דנה כהן',
      presetDiscountForKind: 'employee',
      presetDiscountForRef: 'u-cashier',
      approvedByPosUserId: 'u-manager',
    });
    const r = receipt(h, d.id);
    expect(rowsOf(r)).toContainEqual(['הנחת עובדים 40%', '-16.80']);
    expect(rowsOf(r).some(([l]) => l === 'הנחה')).toBe(false);
    expect(textsOf(r)).toContain('עבור: דנה כהן');
  });

  it('an amount preset and a keyed discount: no preset fields, kind manual', async () => {
    const h = await till(withPresets());
    await h.ok('sell.add', { productId: 'p-burger' });
    await h.ok('sell.add', { productId: 'p-wine' });
    await h.ok('discount.preset', { presetId: 'gift' });
    await h.ok('checkout.start');
    await h.ok('checkout.cash', { amountAgorot: h.state().checkout.dueAgorot });
    const w = wireOf(allDocs(h)[0]);
    expect(w).toMatchObject({ basketDiscount: 42, basketDiscountKind: 'preset', presetDiscountId: 'gift', presetDiscountName: 'מתנה' });
    expect(w.basketDiscountPercent).toBeUndefined();
    expect(w.presetDiscountFor).toBeUndefined();
    expect(rowsOf(receipt(h, allDocs(h)[0].id))).toContainEqual(['מתנה', '-42.00']);
    await h.ok('checkout.finish');
    await h.ok('sell.add', { productId: 'p-burger' });
    await h.ok('discount.apply', { mode: 'percent', input: '10' });
    await h.ok('checkout.start');
    await h.ok('checkout.cash', { amountAgorot: h.state().checkout.dueAgorot });
    const m = wireOf(allDocs(h).at(-1)!);
    expect(m.basketDiscountKind).toBe('manual');
    expect(m.presetDiscountId).toBeUndefined();
  });
});
