/**
 * "בונים" from Windows — the pure rules, ported from the Android till (pos-android hardware/kitchen/KitchenRouting.kt,
 * KitchenQueue.kt, KitchenDelivery.kt; domain/KdsWorkflow.kt) and the Windows kiosk's bon route over the printers'
 * settings it now pulls (core/kioskBonRoute.ts `windowsBonRouteFor`).
 */

import { describe, expect, it } from 'vitest';
import { parseKitchenConfig, type KitchenConfig } from '../src/core/kitchen/config';
import { handOverSteps, lanIntake, lanTargetOf, routeOf, split, unrouted, withoutOwnShare, TILL_PRINTER_ID } from '../src/core/kitchen/routing';
import {
  afterFailure,
  attemptFailed,
  backoffMs,
  bonJobState,
  KitchenJobRefused,
  needsAttention,
  PrinterNotReady,
  PrintUncertain,
  recovered,
  relayAskOrder,
  relayStatus,
  relayTargetOf,
  RELAY_SLOW_MS,
  RELAY_WINDOW_MS,
  type KitchenJob,
} from '../src/core/kitchen/queue';
import { printDirect, PartialWrite, readiness, type PrinterLink, type PrinterReadiness } from '../src/core/kitchen/delivery';
import { kdsTaken, kdsWorkflowOf } from '../src/core/kitchen/kds';
import { contentWidthOf, rasterWidthOf, ticketJobBytes } from '../src/core/kitchen/bytes';
import { kitchenLinesOfSale, withNotice, type KitchenLine } from '../src/core/kitchen/tickets';
import { bonViaKitchen, windowsBonRoute, windowsBonRouteFor } from '../src/core/kioskBonRoute';
import { bonAlerts, bonReason } from '../src/core/kitchen/alerts';
import { tablesOff } from '../src/main/kitchen/kitchenFlows';
import type { SaleLine } from '../src/core/sale';

const P = (over: Record<string, unknown>) => ({ id: 'p1', name: 'מטבח', type: 'network', host: '10.0.0.5', port: 9100, purpose: 'kitchen', inScope: true, ...over });

function cfg(over: Record<string, unknown> = {}): KitchenConfig {
  return parseKitchenConfig({
    printers: [P({ id: 'kitchen', name: 'מטבח' }), P({ id: 'bar', name: 'בר', host: '10.0.0.6' }), P({ id: 'away', name: 'מחסן', inScope: false })],
    categoryRoutes: { 'c-main': ['kitchen'], 'c-drink': ['bar'], 'c-both': ['kitchen', 'bar'], 'c-away': ['away'] },
    productRoutes: { 'p-none': [], 'p-special': ['bar'] },
    options: { kitchenTicketsOnSale: true, kitchenTicketsOnTill: false },
    ...over,
  });
}

const L = (productId: string, categoryId: string | null, name = productId, quantity = 1): KitchenLine => ({ productId, categoryId, name, quantity });

describe('where each line prints (KitchenRouting.split)', () => {
  it('by category; a product of its own wins; "ללא בון" stays without one; a printer out of scope is ignored', () => {
    const lines = [L('burger', 'c-main'), L('cola', 'c-drink'), L('p-special', 'c-main'), L('p-none', 'c-main'), L('crate', 'c-away'), L('salad', 'c-both')];
    const t = split(lines, cfg());
    expect(t.map((x) => [x.printer.id, x.lines.map((l) => l.productId)])).toEqual([
      ['kitchen', ['burger', 'salad']],
      ['bar', ['cola', 'p-special', 'salad']],
    ]);
    expect(unrouted(lines, cfg()).map((l) => l.productId)).toEqual(['crate']);
  });

  it('a counter sale with tables off: the lines routed nowhere print on this device — never silently skipped', () => {
    const lines = [L('burger', 'c-main'), L('mystery', null), L('p-none', 'c-main')];
    const t = split(lines, cfg(), 'קופה', true);
    expect(t.map((x) => [x.printer.id, x.lines.map((l) => l.productId), x.isTillCopy])).toEqual([
      ['kitchen', ['burger'], false],
      [TILL_PRINTER_ID, ['mystery'], false],
    ]);
  });

  it('"גם בקופה" (kitchenTicketsOnTill): a copy of what went to the kitchen on this device, marked a copy', () => {
    const t = split([L('burger', 'c-main'), L('cola', 'c-drink')], cfg({ options: { kitchenTicketsOnSale: true, kitchenTicketsOnTill: true } }));
    expect(t.map((x) => [x.printer.id, x.lines.length, x.isTillCopy])).toEqual([
      ['kitchen', 1, false],
      ['bar', 1, false],
      [TILL_PRINTER_ID, 2, true],
    ]);
    // A kiosk whose own printer may not take its bon: its own share left out.
    expect(withoutOwnShare(t).map((x) => x.printer.id)).toEqual(['kitchen', 'bar']);
  });

  it('a table zone redirects a printer ("הפניה לפי אזור שולחנות"); a zone without one as before', () => {
    const c = cfg({ zoneRedirects: { garden: { kitchen: 'bar' } } });
    expect(split([L('burger', 'c-main')], c, 'קופה', false, 'garden').map((x) => x.printer.id)).toEqual(['bar']);
    expect(split([L('burger', 'c-main')], c, 'קופה', false, 'hall').map((x) => x.printer.id)).toEqual(['kitchen']);
  });
});

describe('how a job leaves this device (routeOf, lanTargetOf, handOverSteps)', () => {
  const host = (over: Record<string, unknown> = {}) => ({ machineId: 'server', name: 'קופה 1', isSelf: false, lanAddress: '10.0.0.2', port: 8399, ...over });
  const config = (printHost: Record<string, unknown> | null, printers: Array<Record<string, unknown>>) => parseKitchenConfig({ printHost, printers, printSecret: 's' });

  it('no print server: a network printer is printed here', () => {
    const c = config(null, [P({})]);
    expect(routeOf(c.printers[0], c.printHost)).toBe('DIRECT');
    expect(lanTargetOf(c.printers[0], c.printHost)).toBeNull();
  });

  it('another device is the print server: over the LAN — then the printer itself — then the cloud', () => {
    const c = config(host(), [P({})]);
    expect(routeOf(c.printers[0], c.printHost)).toBe('LAN');
    expect(lanTargetOf(c.printers[0], c.printHost)).toEqual({ address: '10.0.0.2', port: 8399 });
    expect(handOverSteps(c.printers[0], c.printHost, true, true)).toEqual(['LAN', 'DIRECT', 'CLOUD']);
    // Off any LAN (no private address): the printer itself, then the cloud.
    expect(handOverSteps(c.printers[0], c.printHost, false, true)).toEqual(['DIRECT', 'CLOUD']);
    // A Bluetooth printer is never reached from Windows: the print server, else the cloud.
    expect(handOverSteps(c.printers[0], c.printHost, true, false)).toEqual(['LAN', 'CLOUD']);
  });

  it('this device is the print server: its printers are printed here', () => {
    const c = config(host({ isSelf: true }), [P({ isHost: true })]);
    expect(routeOf(c.printers[0], c.printHost)).toBe('DIRECT');
  });

  it('a cloud printer another till hosts: its LAN address, else the cloud relay; the host as print server — the server address', () => {
    const viaLan = config(host({ machineId: 'other' }), [P({ type: 'cloud', host: null, hostMachineId: 'till-3', hostLanAddress: '10.0.0.9', hostLanPort: 8400 })]);
    expect(routeOf(viaLan.printers[0], viaLan.printHost)).toBe('LAN');
    expect(lanTargetOf(viaLan.printers[0], viaLan.printHost)).toEqual({ address: '10.0.0.9', port: 8400 });
    const relay = config(host({ machineId: 'other' }), [P({ type: 'cloud', host: null, hostMachineId: 'till-3' })]);
    expect(routeOf(relay.printers[0], relay.printHost)).toBe('RELAY');
    const onServer = config(host({ machineId: 'till-3' }), [P({ type: 'cloud', host: null, hostMachineId: 'till-3', hostLanAddress: '10.0.0.99' })]);
    expect(lanTargetOf(onServer.printers[0], onServer.printHost)).toEqual({ address: '10.0.0.2', port: 8399 });
    // Hosted here: printed here by its connection.
    const mine = config(null, [P({ type: 'cloud', host: null, hostMachineId: 'me', isHost: true, hostConnection: 'till' })]);
    expect(routeOf(mine.printers[0], mine.printHost)).toBe('DIRECT');
  });

  it('off the shop\'s LAN ("מרוחקת"): never the print server over the LAN; its own printers itself; the shop\'s only through the cloud', () => {
    const c = config(host({ offLan: true, lanAddress: null }), [P({ scope: 'shop' }), P({ id: 'mine', scope: 'machine' })]);
    expect(lanTargetOf(c.printers[0], c.printHost)).toBeNull();
    expect(routeOf(c.printers[1], c.printHost)).toBe('DIRECT');
    expect(handOverSteps(c.printers[0], c.printHost, true, true)).toEqual(['CLOUD']);
  });

  it('a job that came over the LAN: taken for a printer this device prints, refused "not the print server" otherwise', () => {
    const asServer = config(host({ isSelf: true }), []);
    const sent = parseKitchenConfig({ printers: [P({ id: 'x' })] }).printers[0];
    expect(lanIntake('x', sent, asServer, 'me').kind).toBe('accepted');
    const notServer = config(host(), []);
    expect(lanIntake('x', sent, notServer, 'me')).toEqual({ kind: 'not_print_server' });
    const cloudMine = parseKitchenConfig({ printers: [P({ id: 'c', type: 'cloud', hostMachineId: 'me' })] }).printers[0];
    expect(lanIntake('c', cloudMine, notServer, 'me').kind).toBe('accepted');
    expect(lanIntake('c', cloudMine, notServer, 'someone')).toEqual({ kind: 'not_here' });
  });
});

describe('the Windows kiosk\'s bon over the printers\' settings', () => {
  const printing = (over: Record<string, unknown> = {}) => ({ bonMode: 'routing', bonPrinterId: null, bonOnKiosk: false, ...over });
  const settings = (printers: Array<Record<string, unknown>>) => parseKitchenConfig({ printers });

  it('settings never pulled: exactly as before (its own printer, or none)', () => {
    for (const p of [printing(), printing({ bonOnKiosk: true }), printing({ bonMode: 'single', bonPrinterId: 'x', bonOnKiosk: true })]) {
      expect(windowsBonRouteFor(p, null)).toBe(windowsBonRoute(p));
    }
  });

  it('kitchen printers in the shop: the bon goes there, whatever "בון מטבח במדפסת הקיוסק" says', () => {
    const s = settings([P({})]);
    expect(windowsBonRouteFor(printing(), s)).toBe('kitchen');
    expect(windowsBonRouteFor(printing({ bonOnKiosk: true }), s)).toBe('kitchen');
    expect(bonViaKitchen('kitchen', printing(), s)).toBe(true);
    // No kitchen printer (a receipt printer only): off — none; on — its own.
    const none = settings([P({ purpose: 'receipt' })]);
    expect(windowsBonRouteFor(printing(), none)).toBe('none');
    expect(windowsBonRouteFor(printing({ bonOnKiosk: true }), none)).toBe('own');
  });

  it('one named bon printer: a shop printer through the kitchen queue; the kiosk\'s own on its own printer', () => {
    const s = settings([P({ id: 'bar' }), P({ id: 'usb', type: 'usb', purpose: 'receipt', scope: 'machine' })]);
    const toBar = printing({ bonMode: 'single', bonPrinterId: 'bar' });
    expect(windowsBonRouteFor(toBar, s)).toBe('single');
    expect(bonViaKitchen('single', toBar, s)).toBe(true);
    const toOwn = printing({ bonMode: 'single', bonPrinterId: 'usb', bonOnKiosk: true });
    expect(windowsBonRouteFor(toOwn, s)).toBe('single');
    expect(bonViaKitchen('single', toOwn, s)).toBe(false);
  });
});

const job = (over: Partial<KitchenJob> = {}): KitchenJob => ({
  id: 'j1',
  printerId: 'kitchen',
  printerName: 'מטבח',
  printerJson: '{}',
  ticketJson: '{"source":"sale","createdAt":"2026-10-16T10:00:00Z","lines":[{"name":"x","quantity":2}],"orderRef":"20000057"}',
  route: 'DIRECT',
  kind: 'ticket',
  state: 'pending',
  attempts: 0,
  lastError: null,
  queuedAt: 1_000,
  createdAt: 1_000,
  updatedAt: 1_000,
  nextAttemptAt: 1_000,
  finishedAt: null,
  relayVia: null,
  relayHost: null,
  relayJobId: null,
  ackStatus: null,
  lanOrigin: 0,
  dismissed: 0,
  discardReason: null,
  refId: null,
  ...over,
});

describe('a job\'s life (KitchenQueue)', () => {
  it('retried forever with backoff 5 s, doubling, at most a minute; refused / uncertain fail at once for a person', () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(backoffMs)).toEqual([5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000]);
    const once = attemptFailed(job(), 2_000, 'offline');
    expect(once).toMatchObject({ state: 'pending', attempts: 1, nextAttemptAt: 7_000, lastError: 'offline' });
    expect(afterFailure(job(), 2_000, new KitchenJobRefused('printer has no address'))).toMatchObject({ state: 'failed', attempts: 1 });
    expect(afterFailure(job(), 2_000, new PrintUncertain('cut short'))).toMatchObject({ state: 'failed', lastError: 'uncertain: cut short' });
    expect(afterFailure(job(), 2_000, new PrinterNotReady('no_paper', 'מטבח'))).toMatchObject({ state: 'pending', lastError: 'no_paper: מטבח' });
  });

  it('a host\'s word: done prints it; failed / expired fail it; unknown sends it again; silence is never a failure', () => {
    const r = job({ state: 'relayed', relayVia: 'lan', relayHost: '10.0.0.2:8399' });
    expect(relayStatus(r, 2_000, 'done', null)).toMatchObject({ state: 'done', relayVia: 'lan' });
    expect(relayStatus(r, 2_000, 'failed', 'no_paper')).toMatchObject({ state: 'failed', lastError: 'no_paper' });
    expect(relayStatus(r, 2_000, 'unknown', null)).toMatchObject({ state: 'pending', relayVia: null, relayHost: null });
    expect(relayStatus(r, 1_000 + RELAY_SLOW_MS, 'pending', null)).toMatchObject({ state: 'relayed', lastError: 'slow' });
    expect(relayStatus(r, 1_000 + RELAY_WINDOW_MS, null, null)).toMatchObject({ state: 'relayed', lastError: 'print host not answering' });
  });

  it('a restart: claimed — again; bytes going out — uncertain, never printed twice by itself', () => {
    expect(recovered(job({ state: 'printing' }), 5_000)).toMatchObject({ state: 'pending', nextAttemptAt: 5_000 });
    expect(recovered(job({ state: 'sending' }), 5_000)).toMatchObject({ state: 'failed', lastError: 'uncertain: the till stopped while it printed' });
  });

  it('the host it went to is asked first, then the print server now', () => {
    expect(relayAskOrder(relayTargetOf('10.0.0.2:8399'), { address: '10.0.0.7', port: 8399 })).toEqual([
      { address: '10.0.0.2', port: 8399 },
      { address: '10.0.0.7', port: 8399 },
    ]);
    expect(relayTargetOf('fe80::1:8399')).toEqual({ address: 'fe80::1', port: 8399 });
  });

  it('the staff see what needs them; the cloud\'s "בון לא הודפס" words', () => {
    const waiting = job({ attempts: 2, lastError: 'no_paper: מטבח' });
    expect(needsAttention(waiting)).toBe(true);
    expect(needsAttention(job())).toBe(false);
    expect(bonReason(waiting)).toBe('no_paper');
    expect(bonReason(job({ state: 'failed', attempts: 1, lastError: 'connect ECONNREFUSED 10.0.0.5:9100' }))).toBe('offline');
    const [a] = bonAlerts([waiting], new Map());
    expect(a).toMatchObject({ id: 'j1', state: 'retrying', reason: 'no_paper', printerId: 'kitchen', title: 'הזמנה 20000057', items: 2 });
    expect(bonJobState(job({ state: 'done', relayVia: 'printer' }))).toBe('printed');
    expect(bonJobState(job({ state: 'relayed' }))).toBe('queued');
  });
});

/** A printer link that says what the test says. */
function fakeLink(o: { before?: PrinterReadiness | null; after?: PrinterReadiness | null; failWrite?: number | null; failOpen?: boolean }) {
  const log: string[] = [];
  let reads = 0;
  const link: PrinterLink = {
    open: async () => {
      log.push('open');
      if (o.failOpen) throw new Error('ECONNREFUSED');
    },
    status: async () => {
      log.push('status');
      return reads++ === 0 ? (o.before ?? null) : (o.after ?? null);
    },
    write: async (b) => {
      log.push(`write ${b.length}`);
      if (o.failWrite !== undefined && o.failWrite !== null) throw new PartialWrite(o.failWrite, new Error('reset'));
    },
    settle: async () => void log.push('settle'),
    drain: async () => void log.push('drain'),
    close: () => void log.push('close'),
  };
  return { link, log };
}

describe('one ticket onto one printer (KitchenDelivery.printDirect)', () => {
  const ready = readiness(0x12, 0x12, 0x12)!;
  const noPaper = readiness(0x12, 0x32, 0x72)!;
  const bytes = new Uint8Array(100);

  it('the status read: ready → sent and confirmed; marked SENDING before the first byte', async () => {
    const { link, log } = fakeLink({ before: ready, after: ready });
    const marks: string[] = [];
    const r = await printDirect(link, bytes, 'מטבח', () => void marks.push(`sending at ${log.length}`));
    expect(r).toEqual({ confirmed: true, paperLow: false });
    expect(log).toEqual(['open', 'status', 'write 100', 'settle', 'status', 'close']);
    expect(marks).toEqual(['sending at 2']);
  });

  it('no paper before the ticket: nothing sent, retried by the queue', async () => {
    const { link, log } = fakeLink({ before: noPaper });
    await expect(printDirect(link, bytes, 'מטבח', () => undefined)).rejects.toBeInstanceOf(PrinterNotReady);
    expect(log).not.toContain('write 100');
  });

  it('cut short after bytes went out, or paper out right after: uncertain — never sent again by itself', async () => {
    await expect(printDirect(fakeLink({ before: ready, failWrite: 40 }).link, bytes, 'מטבח', () => undefined)).rejects.toBeInstanceOf(PrintUncertain);
    await expect(printDirect(fakeLink({ before: ready, after: noPaper }).link, bytes, 'מטבח', () => undefined)).rejects.toBeInstanceOf(PrintUncertain);
    // Before any byte left: nothing printed — retried.
    const e = await printDirect(fakeLink({ before: ready, failWrite: 0 }).link, bytes, 'מטבח', () => undefined).catch((x) => x);
    expect(e).not.toBeInstanceOf(PrintUncertain);
  });

  it('a printer that does not report: sent, unconfirmed (only drained, no status after)', async () => {
    const { link, log } = fakeLink({ before: null });
    expect(await printDirect(link, bytes, 'מטבח', () => undefined)).toEqual({ confirmed: false, paperLow: false });
    expect(log).toEqual(['open', 'status', 'write 100', 'drain', 'close']);
  });
});

describe('ESC/POS of a kitchen ticket (EscPos.kt, KitchenTicketJob.kt)', () => {
  it('the raster is what the head prints across; the ticket at the paper\'s width at most, centred', () => {
    expect([rasterWidthOf(80, null), contentWidthOf(80, null)]).toEqual([576, 576]);
    expect([rasterWidthOf(58, null), contentWidthOf(58, null)]).toEqual([384, 384]);
    expect([rasterWidthOf(80, 512), contentWidthOf(80, 512)]).toEqual([512, 512]);
    expect([rasterWidthOf(58, 576), contentWidthOf(58, 576)]).toEqual([576, 384]);
  });

  it('INIT, 64-row bands, the design\'s feed, the cut; the buzzer when asked; no cutter: 3 more lines past the tear bar', () => {
    const page = { width: 384, height: 130, rowBytes: 48, data: new Uint8Array(48 * 130) };
    const b = ticketJobBytes(page, 576, { cut: true, beep: true, feedLines: 2 });
    expect([...b.subarray(0, 2)]).toEqual([0x1b, 0x40]);
    expect([...b.subarray(2, 10)]).toEqual([0x1d, 0x76, 0x30, 0, 72, 0, 64, 0]);
    expect([...b.subarray(b.length - 11)]).toEqual([0x1b, 0x64, 2, 0x1d, 0x56, 0x42, 0x00, 0x1b, 0x42, 0x03, 0x02]);
    // 130 rows: three bands (64, 64, 2).
    expect(b.length).toBe(2 + 3 * 8 + 130 * 72 + 11);
    const tear = ticketJobBytes(page, 576, { cut: false, beep: false, feedLines: 2 });
    expect([...tear.subarray(tear.length - 3)]).toEqual([0x1b, 0x64, 5]);
  });
});

describe('a sale as the kitchen gets it (KitchenMenu.expand)', () => {
  const line = (over: Partial<SaleLine>): SaleLine => ({ key: 'l1', productId: 'p-burger', name: 'המבורגר', sku: null, basePriceAgorot: 4200, options: [], notes: [], qty: 2, categoryId: 'c-main', ...over });

  it('choices as mods / removals, notes joined; a meal as its components, each by its own product; a credit line never', () => {
    const lines = kitchenLinesOfSale(
      [
        line({ options: [{ groupId: 'g', optionId: 'o1', name: 'גבינה', priceAgorot: 300, qty: 1 }, { groupId: 'g', optionId: 'o2', name: 'בצל', priceAgorot: 0, qty: 1, kind: 'removal' }], notes: ['מדיום'] }),
        line({
          key: 'l2',
          productId: 'p-meal',
          name: 'ארוחה',
          qty: 1,
          meal: {
            productId: 'p-meal',
            name: 'ארוחה',
            components: [
              { slotId: 's1', slotName: 'עיקרית', productId: 'p-schnitzel', name: 'שניצל', categoryId: 'c-main', listPriceAgorot: 3000, upchargeAgorot: 0, options: [] },
              { slotId: 's2', slotName: 'שתייה', productId: 'p-cola', name: 'קולה', categoryId: 'c-drink', listPriceAgorot: 1000, upchargeAgorot: 0, options: [] },
            ],
          },
        }),
        line({ key: 'l3', qty: -1 }),
      ],
      (id) => (id === 'p-cola' ? 'c-drink-now' : null),
    );
    expect(lines).toEqual([
      { lineId: 'l1', productId: 'p-burger', categoryId: 'c-main', name: 'המבורגר', quantity: 2, notes: 'מדיום', mods: ['+ גבינה'], removals: ['בלי בצל'] },
      { lineId: 'l2', productId: 'p-schnitzel', categoryId: 'c-main', name: 'שניצל', quantity: 1, notes: null, mods: null, removals: null, mealName: 'ארוחה' },
      { lineId: 'l2', productId: 'p-cola', categoryId: 'c-drink-now', name: 'קולה', quantity: 1, notes: null, mods: null, removals: null, mealName: 'ארוחה' },
    ]);
  });

  it('a band added once however often', () => {
    expect(withNotice(null, 'הדפסה חוזרת — ייתכן שכבר הודפס')).toBe('הדפסה חוזרת — ייתכן שכבר הודפס');
    expect(withNotice('עותק 2', 'הדפסה חוזרת — ייתכן שכבר הודפס')).toBe('עותק 2 · הדפסה חוזרת — ייתכן שכבר הודפס');
    expect(withNotice('עותק 2 · הדפסה חוזרת — ייתכן שכבר הודפס', 'הדפסה חוזרת — ייתכן שכבר הודפס')).toBe('עותק 2 · הדפסה חוזרת — ייתכן שכבר הודפס');
  });
});

describe('"תצורת עבודה ו-KDS" (KdsWorkflowConfig.of, KdsOutbox.taken)', () => {
  it('off: tickets as before, no release; the printer a target: both; KDS only: tickets only as the fallback', () => {
    expect(kdsWorkflowOf({})).toMatchObject({ reportsOrders: false, printsTickets: true, printsOnFallback: false });
    expect(kdsWorkflowOf({ kdsEnabled: 'true', workflowTargets: 'printer,kds' })).toMatchObject({ reportsOrders: true, printsTickets: true });
    expect(kdsWorkflowOf({ kdsEnabled: true, workflowTargets: '["kds"]' })).toMatchObject({ reportsOrders: true, printsTickets: false, printsOnFallback: true });
    expect(kdsWorkflowOf({ kdsEnabled: true, workflowTargets: 'kds', workflowPrinterFallback: 'false' })).toMatchObject({ printsTickets: false, printsOnFallback: false });
    expect(kdsWorkflowOf({ kdsEnabled: true, workflowTargets: 'expo' })).toMatchObject({ printsTickets: true });
  });

  it('taken: an answer that is not "accepted: false" with tasks; refused — not taken; no answer — not known', () => {
    const body = { items: [{ lineKey: 'a:0' }] };
    expect(kdsTaken(body, { kind: 'ok', body: { accepted: true, tasksCreated: 1 } })).toBe(true);
    expect(kdsTaken(body, { kind: 'ok', body: { accepted: false, reason: 'kds_disabled' } })).toBe(false);
    expect(kdsTaken(body, { kind: 'ok', body: { accepted: true, noTasks: true } })).toBe(false);
    expect(kdsTaken(body, { kind: 'refused' })).toBe(false);
    expect(kdsTaken(body, { kind: 'offline' })).toBeNull();
  });

  it('tables mode (TablesMode.parse): anything but a known mode is off', () => {
    expect(tablesOff(undefined)).toBe(true);
    expect(tablesOff('כבוי')).toBe(true);
    expect(tablesOff('רשת מקומית (קופה ראשית)')).toBe(false);
    expect(tablesOff('single')).toBe(false);
  });
});
