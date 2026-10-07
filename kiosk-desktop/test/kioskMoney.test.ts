/**
 * The Windows kiosk's money against the shared golden fixture (pos-server
 * server/tests/fixtures/kiosk_money_golden.json — the Android till's rules, PARITY.md gaps 1–3):
 * through the main process's own path — its catalog (groups, meals), its promotions as the cloud
 * sends them, `priceBasket` and the document's totals (`saleTotals`, the tip) — to the agora.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { saleTotals, tipToCharge, unitAgorot, type SaleLine } from '../src/core/sale';
import { documentWire, type DocDraft } from '../src/main/fiscal/ledger';
import { KioskService } from '../src/main/service';
import type { BasketChange, StartPaymentIn } from '../src/shared/bridge';
import type { Transport } from '../src/main/printer/transports';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const FIXTURE = path.join(here, '..', '..', 'server', 'tests', 'fixtures', 'kiosk_money_golden.json');
/** The same constant as client/src/lib/kioskMoney.test.ts and server tests/test_kiosk_money_golden.py. */
const GOLDEN_SHA256 = '69424fcab136e5f783c2d3ce472c77a81ba703b5f1dc0ce6a1314245df888c0e';

type Row = Record<string, unknown>;
const noPrinter: Transport = { send: async () => undefined, status: async () => ({ health: 'ok', detail: null }), list: async () => [], dispose: () => undefined };

describe.runIf(existsSync(FIXTURE))('the kiosk money golden fixture, through the Windows kiosk', () => {
  const text = readFileSync(FIXTURE, 'utf8').replace(/\r\n/g, '\n');
  const golden = JSON.parse(text) as {
    modifiers: Array<{ name: string; baseAgorot: number; group: Row; picks: Array<{ optionId: string; qty: number; pre: string | null }> | null; expected: { charges: number[]; problems: string[]; unitAgorot: number } }>;
    meals: Array<{ name: string; mealPriceAgorot: number; slots: Row[]; componentGroups: Record<string, Row[]>; chosen: Record<string, string[]>; expected: { components: number[]; unitAgorot: number; valid: boolean } }>;
    products: Record<string, { categoryId: string; noDiscount?: boolean }>;
    baskets: Array<{
      name: string;
      now: string;
      promotions: Row[];
      lines: Array<{ id: string; productId: string; unitAgorot: number; qty: number }>;
      vatRate: number;
      tipPct: number | null;
      expected: { lines: Array<{ id: string; promotionAgorot: number; promotionId: string | null; totalAgorot: number }>; applied: Array<{ promotionId: string; applications: number; discountAgorot: number }>; totalAgorot: number; netAgorot: number; vatAgorot: number; tipAgorot: number };
    }>;
  };

  it('is the pinned file', () => {
    expect(createHash('sha256').update(text, 'utf8').digest('hex')).toBe(GOLDEN_SHA256);
  });

  /** A paired kiosk holding `products` / `menu` / `promotions` as the cloud sent them. */
  function kiosk(products: Row[], menu: Row | null, promotions: Row[]) {
    const svc = new KioskService({ dataDir: mkdtempSync(path.join(os.tmpdir(), 'kd-money-')), appVersion: '0.3.0', deviceInfo: {}, transport: noPrinter, downloader: async () => { throw new Error('no media'); } });
    const categories = [...new Set(products.map((p) => String(p.categoryId)))].map((id) => ({ id, name: id, isActive: true }));
    svc.cloud.applyCatalog({ syncType: 'full', products, categories, menu, machineCatalog: { mode: 'all' }, serverTime: 'x' });
    svc.cloud.setPromotions(promotions, null);
    return svc;
  }
  const product = (id: string, priceAgorot: number, extra: Row = {}): Row => ({ id, name: id, price: priceAgorot / 100, categoryId: golden.products[id]?.categoryId ?? 'c-x', inStock: true, isAvailable: true, noDiscount: golden.products[id]?.noDiscount === true, ...extra });
  type Priced = { lines: SaleLine[]; changes: BasketChange[]; promotions: Array<{ promotionId: string; applications: number; discountAgorot: number }> };
  const priceBasket = (svc: KioskService, input: Partial<StartPaymentIn>, now = new Date()) =>
    (svc as unknown as { priceBasket(i: StartPaymentIn, now: Date): Priced }).priceBasket({ service: 'take_away', customerName: null, customerPhone: null, tableRef: null, tipPct: null, tipAgorot: null, lines: [], ...input }, now);

  for (const c of golden.modifiers.filter((x) => x.expected.problems.length === 0)) {
    it(`choices: ${c.name}`, () => {
      const svc = kiosk([product('dish', c.baseAgorot, { categoryId: 'c-x' })], { groups: [c.group], links: { products: { dish: [String(c.group.id)] } } }, []);
      try {
        const picks = c.picks ?? (c.group.options as Row[]).filter((o) => o.isDefault === true).map((o) => ({ optionId: String(o.id), qty: 1, pre: null }));
        const { lines, changes } = priceBasket(svc, { lines: [{ key: 'L1', productId: 'dish', qty: 1, notes: [], options: picks.map((p) => ({ groupId: String(c.group.id), optionId: p.optionId, qty: p.qty, pre: p.pre as 'lite' | 'extra' | 'side' | null })) }] });
        expect(changes).toEqual([]);
        expect(lines[0].options.map((o) => o.chargedAgorot)).toEqual(c.expected.charges);
        expect(unitAgorot(lines[0])).toBe(c.expected.unitAgorot);
      } finally {
        svc.stop();
      }
    });
  }

  for (const c of golden.meals.filter((x) => x.expected.valid)) {
    it(`meals: ${c.name}`, () => {
      const ids = new Set(c.slots.flatMap((s) => (s.options as Row[]).map((o) => String(o.productId))));
      const groups = Object.values(c.componentGroups).flat();
      const products = [product('meal', c.mealPriceAgorot, { categoryId: 'c-meal' }), ...[...ids].map((id) => product(id, 1000, { categoryId: 'c-x' }))];
      const svc = kiosk(products, { groups, links: { products: Object.fromEntries(Object.entries(c.componentGroups).map(([pid, gs]) => [pid, gs.map((g) => String(g.id))])) }, meals: { meal: c.slots } }, []);
      try {
        const components = Object.entries(c.chosen).flatMap(([slotId, pids]) => pids.map((productId) => ({ slotId, productId })));
        const { lines, changes } = priceBasket(svc, { lines: [{ key: 'L1', productId: 'meal', qty: 2, notes: [], options: [], meal: { components } }] });
        expect(changes).toEqual([]);
        const meal = lines[0].meal!;
        expect(meal.components.map((x) => x.upchargeAgorot + x.options.reduce((s, o) => s + (o.chargedAgorot ?? 0), 0))).toEqual(c.expected.components);
        expect(unitAgorot(lines[0])).toBe(c.expected.unitAgorot);
        // On the wire: the meal's components, the line's unit with them.
        const item = (documentWire({ ...stubDoc(lines) }).items as Row[])[0];
        expect(item.unitPrice).toBe(c.expected.unitAgorot / 100);
        expect(((item.details as Row).meal as Row).components).toHaveLength(components.length);
      } finally {
        svc.stop();
      }
    });
  }

  for (const c of golden.baskets) {
    it(`baskets: ${c.name}`, () => {
      const prices = new Map(c.lines.map((l) => [l.productId, l.unitAgorot]));
      const svc = kiosk([...prices].map(([id, agorot]) => product(id, agorot)), null, c.promotions);
      try {
        const [d, t] = c.now.split('T');
        const now = new Date(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)), Number(t.slice(0, 2)), Number(t.slice(3, 5)));
        const { lines, changes, promotions } = priceBasket(svc, { lines: c.lines.map((l) => ({ key: l.id, productId: l.productId, qty: l.qty, notes: [], options: [] })) }, now);
        expect(changes).toEqual([]);
        expect(lines.map((l) => ({ id: l.key, promotionAgorot: l.promotionAgorot ?? 0, promotionId: l.promotionId ?? null, totalAgorot: unitAgorot(l) * l.qty - (l.promotionAgorot ?? 0) }))).toEqual(c.expected.lines);
        expect(promotions.map((a) => ({ promotionId: a.promotionId, applications: a.applications, discountAgorot: a.discountAgorot }))).toEqual(c.expected.applied);
        const goods = saleTotals(lines, c.vatRate);
        const tip = tipToCharge(goods.totalAgorot, c.tipPct, null);
        expect(tip).toBe(c.expected.tipAgorot);
        const totals = saleTotals(lines, c.vatRate, tip);
        expect({ total: totals.totalAgorot, net: totals.netAgorot, vat: totals.vatAgorot, discount: totals.discountAgorot }).toEqual({
          total: c.expected.totalAgorot,
          net: c.expected.netAgorot,
          vat: c.expected.vatAgorot,
          discount: c.expected.applied.reduce((s, a) => s + a.discountAgorot, 0),
        });
        // The document the cloud gets: the promotions in its discount, each line's share, the card leg the rest.
        const wire = documentWire(stubDoc(lines, promotions, totals));
        expect(wire.totalAmount).toBe(totals.grossAgorot / 100);
        expect(wire.documentDiscount ?? 0).toBe(totals.discountAgorot / 100);
        expect(((wire.payments as Row[])[0] as Row).amount).toBe(totals.totalAgorot / 100);
        expect(((wire.promotions as Row[] | undefined) ?? []).map((p) => p.promotionId)).toEqual(c.expected.applied.map((a) => a.promotionId));
      } finally {
        svc.stop();
      }
    });
  }

  function stubDoc(lines: SaleLine[], promotions: Priced['promotions'] = [], totals = saleTotals(lines, 0.18)): DocDraft {
    return {
      id: '00000000-0000-4000-8000-000000000001',
      documentType: 320,
      number: 1,
      prefix: null,
      status: 'completed',
      createdAt: '',
      updatedAt: '',
      shiftId: 's',
      businessDate: '2026-10-07',
      cashierId: 'kiosk:m',
      cashierName: 'קיוסק',
      branchId: null,
      orderId: null,
      lines,
      itemIds: lines.map((_, i) => `00000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`),
      tracked: [],
      totals,
      promotions: promotions.map((p) => ({ ...p, name: p.promotionId, type: 'x' })),
      card: { brand: 'visa', last4: '1', authNum: '1', uid: 'u', payments: null, firstPaymentAgorot: null, chargedAgorot: totals.chargeAgorot, meta: {} } as unknown as DocDraft['card'],
      paymentId: 'p',
      voidMeta: null,
    };
  }
});
