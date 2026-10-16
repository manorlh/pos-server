/**
 * "פרטי הזמנה" of a quick order — "הזמנה מהירה — לקחת / לשבת" (`askEatInTakeAway`), "הזמנה מהירה — שם לקוח" (`askOrderName`) and
 * "מתי לשאול" (`orderDetailsAt`): pos-android OrderRoundTest's order-details cases and OrderDetailsStepTest, then the Windows
 * engine's flows — a new order opening with them, the first item held for them, the payment asking first — and the kitchen
 * ticket with the name as its headline and take-away / eat-in as its band. Tests only: a fake cloud and printer.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { KitchenDoc } from '../src/core/kitchen/doc';
import {
  ORDER_DETAILS_AT_OPEN,
  ORDER_DETAILS_DINING_FIRST,
  ORDER_TEXT,
  cleanOrderName,
  firstOrderDetailsStep,
  missingOrderDetails,
  orderDetailsStrip,
  orderQuestionsOf,
  startDetailsDue,
  stepAfterDining,
  type OrderFacts,
} from '../src/core/till/orderDetails';
import { fakeRenderer, FakeNetPrinter, printer, PRINT_KEY, until } from './support/kitchenFakes';
import { harness, MANAGER_PIN, PIN, type Harness, type HarnessOptions } from './tillEngineHarness';

const order = (o: Partial<OrderFacts> = {}): OrderFacts => ({ hasLines: true, hasRefundLines: false, dining: null, name: null, ...o });

describe('the rules (MenuSheetState.kt, OrderNameSheet.kt)', () => {
  it('the details asked follow the parameters, and only what is missing', () => {
    const off = orderQuestionsOf({});
    expect(off.dining || off.name).toBe(false);
    const both = orderQuestionsOf({ askEatInTakeAway: 'true', askOrderName: 'true', orderDetailsAt: ORDER_DETAILS_AT_OPEN });
    expect(both).toEqual({ dining: true, name: true, atOpen: true, diningFirst: false });
    // A cloud that predates "מתי לשאול": the default — the order opens with them.
    expect(orderQuestionsOf({ askOrderName: 'true' })).toMatchObject({ atOpen: false, diningFirst: true });
    expect(orderQuestionsOf({ askOrderName: true, orderDetailsAt: 'במעבר לתשלום' })).toEqual({ dining: false, name: true, atOpen: false, diningFirst: false });
    expect(orderQuestionsOf({ orderDetailsAt: ORDER_DETAILS_DINING_FIRST }).diningFirst).toBe(true);

    expect(missingOrderDetails(both, order())).toEqual({ dining: true, name: true, atOpen: true, diningFirst: false });
    expect(missingOrderDetails(both, order({ name: 'דני' }))).toEqual({ dining: true, name: false, atOpen: true, diningFirst: false });
    expect(missingOrderDetails(both, order({ name: 'דני', dining: 'take_away' }))).toBeNull();
    expect(missingOrderDetails(both, order({ name: '   ' }))?.name).toBe(true);
    expect(missingOrderDetails(off, order())).toBeNull();
    // A return is not an order for the kitchen.
    expect(missingOrderDetails(both, order({ hasRefundLines: true }))).toBeNull();
  });

  it('"בתחילת הזמנה": only a new order, before its first item', () => {
    const first = orderQuestionsOf({ askEatInTakeAway: 'true', askOrderName: 'true' });
    expect(startDetailsDue(first, order({ hasLines: false }))).toMatchObject({ dining: true, name: true });
    expect(startDetailsDue(first, order({ hasLines: true }))).toBeNull();
    expect(startDetailsDue(first, order({ hasLines: false, dining: 'eat_in' }))).toMatchObject({ dining: false, name: true });
    expect(startDetailsDue(orderQuestionsOf({ askOrderName: 'true', orderDetailsAt: ORDER_DETAILS_AT_OPEN }), order({ hasLines: false }))).toBeNull();
  });

  it('the dining question comes first, the name alone when it is the only one; after it, the name or done', () => {
    expect(firstOrderDetailsStep(true, true)).toBe('dining');
    expect(firstOrderDetailsStep(true, false)).toBe('dining');
    expect(firstOrderDetailsStep(false, true)).toBe('name');
    expect(firstOrderDetailsStep(false, false)).toBeNull();
    expect(stepAfterDining(true)).toBe('name');
    expect(stepAfterDining(false)).toBeNull();
  });

  it('the name as kept, the strip, the words', () => {
    expect(cleanOrderName('  דני  ')).toBe('דני');
    expect(cleanOrderName('א'.repeat(60))).toHaveLength(40);
    expect(cleanOrderName('   ')).toBeNull();
    expect(orderDetailsStrip('take_away', 'דני')).toBe('לקחת  ·  דני');
    expect(orderDetailsStrip('eat_in', null)).toBe('לשבת');
    expect(orderDetailsStrip(null, null)).toBe('');
    expect(ORDER_TEXT.diningQuestion).toBe('לקחת או לשבת?');
    expect(ORDER_TEXT.nameHint).toBe('השם יודפס בגדול בראש הבון למטבח — כדי לקרוא ללקוח כשההזמנה מוכנה.');
  });
});

/* ------------------------------------------------------------------ on the Windows till */

const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

async function till(parameters: Record<string, unknown>, o: HarnessOptions = {}): Promise<Harness> {
  const h = harness({ ...o, parameters: { ...(o.parameters ?? {}), ...parameters } });
  closers.push(() => h.stop());
  await h.ok('session.login', { pin: PIN });
  await h.ok('shift.open', { openingCashAgorot: 0 });
  return h;
}

describe('the Windows engine', () => {
  it('off (the default): no sheet, no strip, the payment as before', async () => {
    const h = await till({});
    expect(h.state().order).toBeUndefined();
    await h.ok('sell.add', { productId: 'p-cola' });
    await h.ok('checkout.start');
    expect(h.state().checkout.phase).toBe('tender');
  });

  it('"בתחילת הזמנה" (the default): the new order opens with "לקחת או לשבת?" and the name; closed — the payment asks', async () => {
    const h = await till({ askEatInTakeAway: 'true', askOrderName: 'true' });
    expect(h.state().order?.ask).toEqual({ purpose: 'start', dining: true, name: true, confirmLabel: 'התחל הזמנה' });
    // Mandatory: a name asked and not given is refused.
    expect((await h.fail('order.details', { dining: 'take_away' })).message).toBe('יש להזין שם לקוח להזמנה');
    await h.ok('order.details', { dining: 'take_away', name: ' דני ' });
    expect(h.state().order).toMatchObject({ dining: 'take_away', name: 'דני', strip: 'לקחת  ·  דני', ask: null });
    await h.ok('sell.add', { productId: 'p-cola' });
    await h.ok('checkout.start');
    expect(h.state().checkout.phase).toBe('tender');
  });

  it('the opening questions closed unanswered: not again for this order — the payment asks before paying', async () => {
    const h = await till({ askOrderName: 'true' });
    expect(h.state().order?.ask?.purpose).toBe('start');
    await h.ok('order.dismiss');
    expect(h.state().order?.ask).toBeNull();
    await h.ok('sell.add', { productId: 'p-cola' });
    expect(await h.ok('checkout.start')).toEqual({ orderDetails: true });
    expect(h.state().checkout.phase).toBe('idle');
    expect(h.state().order?.ask).toEqual({ purpose: 'payment', dining: false, name: true, confirmLabel: 'המשך לתשלום' });
    // Given: the payment goes on by itself.
    await h.ok('order.details', { name: 'רוני' });
    expect(h.state().checkout.phase).toBe('tender');
  });

  it('"בפתיחת הזמנה": the first item waits for the details, then goes in; closed — it is dropped', async () => {
    const h = await till({ askEatInTakeAway: 'true', orderDetailsAt: ORDER_DETAILS_AT_OPEN });
    expect(h.state().order?.ask).toBeNull();
    expect(await h.ok('sell.add', { productId: 'p-cola' })).toEqual({ orderDetails: true });
    expect(h.state().sell.lines).toHaveLength(0);
    expect(h.state().order?.ask).toEqual({ purpose: 'open', dining: true, name: false, confirmLabel: 'התחל הזמנה' });
    await h.ok('order.dismiss');
    expect(h.state().sell.lines).toHaveLength(0);
    await h.ok('sell.add', { productId: 'p-cola' });
    await h.ok('order.details', { dining: 'eat_in' });
    expect(h.state().sell.lines.map((l) => l.productId)).toEqual(['p-cola']);
    // The second item does not ask again.
    await h.ok('sell.add', { productId: 'p-burger' });
    expect(h.state().sell.lines).toHaveLength(2);
  });

  it('the strip changes them; a held sale keeps them and is named by the order', async () => {
    const h = await till({ askEatInTakeAway: 'true', askOrderName: 'true', orderDetailsAt: 'במעבר לתשלום' });
    await h.ok('sell.add', { productId: 'p-cola' });
    await h.ok('order.edit');
    expect(h.state().order?.ask).toMatchObject({ purpose: 'edit', dining: true, name: true, confirmLabel: 'שמור' });
    await h.ok('order.details', { dining: 'eat_in', name: 'מאיה' });
    await h.ok('held.hold', {});
    expect(h.state().held?.sales[0].label).toBe('מאיה');
    expect(h.state().order?.strip ?? null).toBeNull();
    await h.ok('held.resume', { id: h.state().held!.sales[0].id });
    expect(h.state().order).toMatchObject({ dining: 'eat_in', name: 'מאיה' });
  });

  it('a return is never asked', async () => {
    const h = harness({ parameters: { askOrderName: 'true', orderDetailsAt: 'במעבר לתשלום' } });
    closers.push(() => h.stop());
    await h.ok('session.login', { pin: MANAGER_PIN });
    await h.ok('shift.open', { openingCashAgorot: 0 });
    await h.ok('refund.button');
    await h.ok('refund.catalog');
    await h.ok('sell.add', { productId: 'p-cola' });
    const r = await h.ok('checkout.start');
    expect(r).not.toEqual({ orderDetails: true });
  });

  it('the kitchen ticket: the name as its headline, take-away as its band', async () => {
    const kitchen = await new FakeNetPrinter().listen();
    closers.push(() => kitchen.close());
    const h = await till(
      { askEatInTakeAway: 'true', askOrderName: 'true', kitchenTicketsOnSale: true },
      {
        answers: {
          'GET sync/m/printers': () => ({ syncType: 'full', etag: 'e', printSecret: PRINT_KEY, printers: [printer({ id: 'kitchen', name: 'מטבח', port: kitchen.port })], categoryRoutes: { 'c-main': ['kitchen'] } }),
        },
      },
    );
    const renderer = fakeRenderer();
    h.svc.printQueue.setRenderer(renderer);
    await h.svc.kitchen.pull(true);
    await h.ok('order.details', { dining: 'take_away', name: 'דני' });
    await h.ok('sell.add', { productId: 'p-burger' });
    await h.ok('checkout.start');
    await h.ok('checkout.cash', { amountAgorot: 5_000 });
    await h.svc.kitchen.work();
    await until(() => kitchen.tickets().length === 1);
    const doc = renderer.docs.find((d) => d.doc.kind === 'kitchen')!.doc as KitchenDoc;
    expect(doc.ticket).toMatchObject({ customerName: 'דני', dining: 'take_away' });
    // The next order starts afresh: asked again, nothing kept.
    expect(h.state().order).toMatchObject({ dining: null, name: null });
  });
});
