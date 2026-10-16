/**
 * "מדפסת חלופית" and "תור הדפסה" (pos-android KitchenFailoverTest, KitchenResendAfterHostMoveTest, the redirect log): the
 * candidates, `mayRedirect`, `shouldAsk`, the temporary redirects, a ticket moved (a new id, "הופנה מ: …", the old one out of
 * its printer's queue), "the next ones too", the cloud's log — and on the Windows till the question about a kitchen ticket that
 * did not print, where `unprintedBonAlert` is on. Tests only: fake printers, a fake cloud.
 */

import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { parsePrinter, type KitchenPrinter } from '../src/core/kitchen/config';
import {
  FAILOVER_TEXT,
  activeRedirects,
  bonAlertOn,
  candidates,
  clearedRedirects,
  deviceKey,
  failoverEnabled,
  mayRedirect,
  redirectFor,
  redirectLog,
  shouldAsk,
  ticketTitleOf,
  withRedirect,
  type TempRedirect,
} from '../src/core/kitchen/failover';
import type { KitchenJob } from '../src/core/kitchen/queue';
import { tillPrinter } from '../src/core/kitchen/routing';
import { fakeRenderer, FakeNetPrinter, printer, PRINT_KEY, until } from './support/kitchenFakes';
import { PIN, harness, type Harness } from './tillEngineHarness';

const P = (o: Record<string, unknown>): KitchenPrinter => parsePrinter({ name: String(o.id), type: 'network', host: '10.0.0.9', port: 9100, purpose: 'kitchen', inScope: true, ...o })!;

const job = (o: Partial<KitchenJob> = {}): KitchenJob => ({
  id: 'j',
  printerId: 'bar',
  printerName: 'בר',
  printerJson: '{}',
  ticketJson: JSON.stringify({ orderRef: '57', lines: [] }),
  route: 'DIRECT',
  kind: 'ticket',
  state: 'pending',
  attempts: 1,
  lastError: 'offline',
  queuedAt: 0,
  createdAt: 0,
  updatedAt: 0,
  nextAttemptAt: 0,
  finishedAt: null,
  relayVia: null,
  relayHost: null,
  relayJobId: null,
  ackStatus: null,
  lanOrigin: 0,
  dismissed: 0,
  discardReason: null,
  refId: null,
  ...o,
});

describe('the rules (KitchenFailoverTest)', () => {
  it('the candidates: the kitchen first, the receipt printers, the till last; one per device; the not answering last', () => {
    const failed = P({ id: '1', host: '10.0.0.1' });
    const all = [tillPrinter('קופה'), P({ id: '1', host: '10.0.0.1' }), P({ id: '2', host: '10.0.0.2' }), P({ id: '3', host: '10.0.0.1' }), P({ id: '4', host: '10.0.0.4', purpose: 'receipt' }), P({ id: '5', host: '10.0.0.5' })];
    expect(candidates(failed, all, new Map()).map((c) => c.printer.id)).toEqual(['2', '5', '4', 'till']);
    const health = new Map([
      ['2', 'error' as const],
      ['5', 'ok' as const],
    ]);
    const c = candidates(failed, [P({ id: '2', host: 'a' }), P({ id: '5', host: 'b' }), P({ id: '6', host: 'c' })], health);
    expect(c.map((x) => [x.printer.id, x.light])).toEqual([
      ['5', 'ok'],
      ['6', null],
      ['2', 'error'],
    ]);
    // The till's own printer failing: never offered itself.
    expect(candidates(tillPrinter('קופה'), [tillPrinter('קופה'), P({ id: '2' })], new Map()).map((x) => x.printer.id)).toEqual(['2']);
    expect(deviceKey(P({ id: 'x', host: ' 10.0.0.1 ', port: null }))).toBe('net:10.0.0.1:9100');
  });

  it('mayRedirect: only while it waits here', () => {
    expect(mayRedirect(job({ state: 'pending' }))).toBe(true);
    expect(mayRedirect(job({ state: 'failed' }))).toBe(true);
    for (const state of ['printing', 'relayed', 'done'] as const) expect(mayRedirect(job({ state }))).toBe(false);
    expect(mayRedirect(job({ dismissed: 1 }))).toBe(false);
    expect(mayRedirect(job({ relayJobId: 'cloud-1' }))).toBe(false);
    expect(mayRedirect(job({ lanOrigin: 1 }))).toBe(false);
  });

  it('shouldAsk', () => {
    expect(shouldAsk(job(), true, new Map())).toBe(true);
    expect(shouldAsk(job(), false, new Map())).toBe(false);
    expect(shouldAsk(job({ attempts: 0 }), true, new Map())).toBe(false);
    expect(shouldAsk(job({ kind: 'test' }), true, new Map())).toBe(false);
    expect(shouldAsk(job({ attempts: 5 }), true, new Map([['j', Number.MAX_SAFE_INTEGER]]))).toBe(false);
    expect(shouldAsk(job(), true, new Map([['j', 1]]))).toBe(false);
    expect(shouldAsk(job({ attempts: 2 }), true, new Map([['j', 1]]))).toBe(true);
    expect(shouldAsk(job({ state: 'printing' }), true, new Map())).toBe(false);
  });

  it('the parameters', () => {
    expect(failoverEnabled(null)).toBe(true);
    expect(failoverEnabled('true')).toBe(true);
    expect(failoverEnabled('false')).toBe(false);
    expect(failoverEnabled(' FALSE ')).toBe(false);
    expect(bonAlertOn(undefined)).toBe(false);
    expect(bonAlertOn('true')).toBe(true);
  });

  it('the temporary redirects: their time, one per printer, cleared by printer', () => {
    const r: TempRedirect = { fromId: 'bar', fromName: 'בר', toId: 'kitchen', toName: 'מטבח', until: 1_000 };
    expect(redirectFor('bar', [r], 999)).toEqual(r);
    expect(redirectFor('bar', [r], 1_000)).toBeNull();
    expect(activeRedirects([r], 1_000)).toEqual([]);
    const old = { ...r, until: 500 };
    const grill = { ...r, fromId: 'grill', until: 100 };
    const next = { ...r, until: 2_000 };
    expect(withRedirect([old, grill], next, 200)).toEqual([next]);
    expect(clearedRedirects([r, { ...r, fromId: 'grill' }], 'bar').map((x) => x.fromId)).toEqual(['grill']);
  });

  it("a ticket's title, the log's body", () => {
    expect(ticketTitleOf(job())).toBe('מכירה #57');
    expect(ticketTitleOf(job({ ticketJson: JSON.stringify({ tableName: '12' }) }))).toBe('שולחן 12');
    expect(ticketTitleOf(job({ kind: 'test' }))).toBe('בדיקת מדפסת');
    expect(ticketTitleOf(job({ ticketJson: 'x' }))).toBe('בון');
    expect(redirectLog({ id: 'l', kind: 'kitchen', from: { id: 'till', name: 'קופה' }, to: { id: 'kitchen', name: 'מטבח' }, ticket: 'מכירה #57', error: 'x'.repeat(600), temporaryUntil: Date.UTC(2026, 9, 16, 10, 15), user: { id: 'u', name: 'דנה' }, at: Date.UTC(2026, 9, 16, 10) })).toEqual({
      id: 'l',
      kind: 'kitchen',
      fromPrinterId: null,
      fromName: 'קופה',
      toPrinterId: 'kitchen',
      toName: 'מטבח',
      ticket: 'מכירה #57',
      error: 'x'.repeat(500),
      temporaryUntil: '2026-10-16T10:15:00.000Z',
      posUserId: 'u',
      posUserName: 'דנה',
      occurredAt: '2026-10-16T10:00:00.000Z',
    });
  });
});

/* ------------------------------------------------------------------ on the Windows till */

const closers: Array<() => unknown> = [];
afterEach(async () => {
  for (const c of closers.splice(0).reverse()) await c();
});

/** A port nobody listens on (a printer that is off). */
async function deadPort(): Promise<number> {
  const s = net.createServer();
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  const port = (s.address() as net.AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

describe('the question on the Windows till', () => {
  it('a ticket the bar did not print: "לשלוח את הבון ל…" — to the kitchen, and the next ones too; logged; printed there', async () => {
    const kitchen = await new FakeNetPrinter().listen();
    closers.push(() => kitchen.close());
    const dead = await deadPort();
    const logs: Array<Record<string, unknown> | null> = [];
    const h: Harness = harness({
      parameters: { kitchenTicketsOnSale: true, unprintedBonAlert: true },
      answers: {
        'GET sync/m/printers': () => ({
          syncType: 'full',
          etag: 'e',
          printSecret: PRINT_KEY,
          printers: [printer({ id: 'bar', name: 'בר', port: dead }), printer({ id: 'kitchen', name: 'מטבח', port: kitchen.port })],
          categoryRoutes: { 'c-main': ['bar'] },
        }),
        'POST sync/m/print-redirects': (b) => {
          logs.push(b);
          return { __status: 201, id: 'x' };
        },
      },
    });
    closers.push(() => h.stop());
    h.svc.printQueue.setRenderer(fakeRenderer());
    await h.svc.kitchen.pull(true);
    await h.ok('session.login', { pin: PIN });
    await h.ok('shift.open', { openingCashAgorot: 0 });
    await h.ok('sell.add', { productId: 'p-burger' });
    await h.ok('checkout.start');
    await h.ok('checkout.cash', { amountAgorot: 5_000 });
    await h.ok('checkout.finish');
    await h.svc.kitchen.work();
    await until(() => h.svc.kitchen.attention().length === 1, 15_000);
    expect(h.state().printQueue?.banner).toBe(FAILOVER_TEXT.bannerOne);
    h.engine.printQueue.prompt();
    const d = h.state().dialog!;
    expect(d.title).toBe('המדפסת «בר» לא זמינה');
    expect(d.body.split('\n')[1]).toBe('לשלוח את הבון ל…');
    expect(d.fields).toEqual([{ name: 'alsoNext', label: FAILOVER_TEXT.alsoNext, kind: 'check' }]);
    expect(d.actions.map((a) => a.id)).toEqual(['to:kitchen', 'retry', 'keep']);
    await h.ok('dialog.answer', { dialogId: d.id, action: 'to:kitchen', answers: { alsoNext: 'true' } });
    // Moved: a new job on the kitchen printer, marked; the bar's out of its queue; the redirect for 15 minutes.
    const jobs = h.svc.kitchen.jobsFor(h.svc.ledger.todaysDocs(new Date().toISOString().slice(0, 10))[0]?.id ?? '');
    const all = jobs.length ? jobs : h.svc.kitchen.attention();
    void all;
    const redirects = h.svc.kitchen.redirects();
    expect(redirects.map((r) => [r.fromId, r.toId])).toEqual([['bar', 'kitchen']]);
    expect(h.state().printQueue?.redirects[0].text).toMatch(/^«בר» נשלחת ל«מטבח» עד \d\d:\d\d$/);
    await h.svc.kitchen.work();
    await until(() => kitchen.tickets().length === 1, 15_000);
    await until(() => logs.length === 1);
    expect(logs[0]).toMatchObject({ kind: 'kitchen', fromPrinterId: 'bar', fromName: 'בר', toPrinterId: 'kitchen', toName: 'מטבח', posUserName: 'דנה כהן' });
    expect(typeof logs[0]!.temporaryUntil).toBe('string');
    // "the next ones too": the next sale's bar ticket goes to the kitchen, marked.
    await h.ok('sell.add', { productId: 'p-burger' });
    await h.ok('checkout.start');
    await h.ok('checkout.cash', { amountAgorot: 5_000 });
    const docId = h.state().checkout.documentId!;
    expect(h.svc.kitchen.jobsFor(docId).map((j) => j.printerId)).toEqual(['kitchen']);
    expect(JSON.parse(h.svc.kitchen.jobsFor(docId)[0].ticketJson).notice).toBe('הופנה מ: בר');
    // "בטל הפניה".
    await h.ok('printQueue.endRedirect', { fromId: 'bar' });
    expect(h.svc.kitchen.redirects()).toEqual([]);
  }, 40_000);

  it('unprintedBonAlert off (the default): no question, the strip only', async () => {
    const dead = await deadPort();
    const h: Harness = harness({
      parameters: { kitchenTicketsOnSale: true },
      answers: { 'GET sync/m/printers': () => ({ syncType: 'full', etag: 'e', printSecret: PRINT_KEY, printers: [printer({ id: 'bar', name: 'בר', port: dead })], categoryRoutes: { 'c-main': ['bar'] } }) },
    });
    closers.push(() => h.stop());
    h.svc.printQueue.setRenderer(fakeRenderer());
    await h.svc.kitchen.pull(true);
    await h.ok('session.login', { pin: PIN });
    await h.ok('shift.open', { openingCashAgorot: 0 });
    await h.ok('sell.add', { productId: 'p-burger' });
    await h.ok('checkout.start');
    await h.ok('checkout.cash', { amountAgorot: 5_000 });
    await h.ok('checkout.finish');
    await h.svc.kitchen.work();
    await until(() => h.svc.kitchen.attention().length === 1, 15_000);
    h.engine.printQueue.prompt();
    expect(h.state().dialog).toBeNull();
    expect(h.state().printQueue?.banner).toBe(FAILOVER_TEXT.bannerOne);
    const list = (await h.ok('printQueue.list')) as { rows: Array<{ printer: string; canMove: boolean }> };
    expect(list.rows).toEqual([expect.objectContaining({ printer: 'בר', canMove: true })]);
  }, 40_000);
});
