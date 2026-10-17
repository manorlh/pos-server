/**
 * "מדפסות" on the Windows till (core/till/printersView.ts, main/till/tillPrinters.ts, screens/PrintersScreen.tsx) —
 * pos-android ui/kitchen/PrintersScreen.kt, KitchenPrintService.kt (`printers`, `probe`, `printServerStatus`),
 * ReceiptDefaultCard.kt, PrinterDiscoveryPanel.kt: the words, the lights, the routes, the list, the queue's actions, the
 * test prints, the receipt choice behind a manager, the scan and "הוספה" with a code the cloud checks.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { parseKitchenConfig, parsePrinter, type KitchenPrinter } from '../src/core/kitchen/config';
import type { KitchenJob } from '../src/core/kitchen/queue';
import { tillPrinter } from '../src/core/kitchen/routing';
import {
  LAN_DOWN_DIRECT,
  LAN_DOWN_VIA_CLOUD,
  PRINTERS_TEXT,
  VIA_CLOUD,
  VIA_LAN,
  addRefusalText,
  describePrinter,
  designNameOf,
  foundPrinterView,
  historyRowsOf,
  jobStateText,
  lightOf,
  ownHealthOf,
  printServerView,
  probePlanOf,
  queueRowsOf,
  statusTextOf,
  tillPrinters,
  waitingByPrinter,
  widthTestOffered,
  type PrintersState,
} from '../src/core/till/printersView';
import { KitchenStore } from '../src/main/kitchen/kitchenStore';
import { TillPrinters, type TillPrintersDeps } from '../src/main/till/tillPrinters';
import { TILL_PRINTER_KEY } from '../src/main/till/tillRemotePrint';
import { PrintersScreen } from '../src/renderer/roles/till/screens/PrintersScreen';
import type { TillOp } from '../src/shared/till/protocol';
import { printer, until } from './support/kitchenFakes';
import { MANAGER_PIN, PIN, harness, type Harness, type HarnessOptions } from './tillEngineHarness';

const op = (s: string) => s as TillOp;
const P = (o: Record<string, unknown>): KitchenPrinter => parsePrinter(printer(o))!;

let h: Harness | null = null;
afterEach(() => {
  h?.stop();
  h = null;
});

function job(over: Partial<KitchenJob> & { printer?: KitchenPrinter }): KitchenJob {
  const p = over.printer ?? P({ id: 'p-bar', name: 'בר' });
  const now = Date.now();
  const { printer: _p, ...rest } = over;
  void _p;
  return {
    id: `j-${Math.random().toString(36).slice(2, 8)}`,
    printerId: p.id,
    printerName: p.name,
    printerJson: JSON.stringify(p),
    ticketJson: JSON.stringify({ source: 'table', tableName: '12', createdAt: new Date(now).toISOString(), lines: [{ name: 'המבורגר', quantity: 1 }], notice: null }),
    route: 'DIRECT',
    kind: 'ticket',
    state: 'pending',
    attempts: 0,
    lastError: null,
    queuedAt: now,
    createdAt: now,
    updatedAt: now,
    nextAttemptAt: now,
    finishedAt: null,
    relayVia: null,
    relayHost: null,
    relayJobId: null,
    ackStatus: null,
    lanOrigin: 0,
    dismissed: 0,
    discardReason: null,
    refId: null,
    ...rest,
  };
}

/* ------------------------------------------------------------------ the rules */

describe('the words and the rules (PrintersScreen.kt)', () => {
  it('Android\'s words, word for word', () => {
    expect(PRINTERS_TEXT.title).toBe('מדפסות');
    expect(PRINTERS_TEXT.queueTitle).toBe('בונים שממתינים לטיפול');
    expect(PRINTERS_TEXT.listTitle).toBe('המדפסות של הקופה');
    expect(PRINTERS_TEXT.historyTitle).toBe('הודפסו לאחרונה (24 שעות)');
    expect(PRINTERS_TEXT.testSent('בר')).toBe('בון בדיקה נשלח ל־בר');
    expect(PRINTERS_TEXT.none).toBe('לא הוגדרו מדפסות בונים לקופה הזו. מגדירים בענן: הגדרות ← מדפסות בונים.');
    expect(PRINTERS_TEXT.serverSelf('10.0.0.2:8399')).toBe('הקופה הזו היא שרת ההדפסות של הסניף · מאזינה ב־10.0.0.2:8399');
    expect(PRINTERS_TEXT.receiptTitle).toBe('מדפסת לקבלות ולמסמכים');
    expect(PRINTERS_TEXT.discoveryDone(2, '10.0.0.0/24', 7)).toBe('נמצאו 2 ב-10.0.0.0/24 (7 שנ׳)');
    expect(PRINTERS_TEXT.widthTestSent('בר')).toBe('בדיקת רוחב נשלחה ל-בר: הרוחב הנכון הוא המסגרת הרחבה ביותר שיצאה ישרה ושלמה (מגדירים בדשבורד: "רוחב הדפסה").');
  });

  it('the light and its words (colorOf / statusText)', () => {
    const at = 1;
    expect(lightOf(null, 0)).toBe('none');
    expect(statusTextOf(null, 0)).toBe('בודק…');
    expect([lightOf({ level: 'error', at, detail: null }, 0), statusTextOf({ level: 'error', at, detail: null }, 0)]).toEqual(['error', 'לא מגיב']);
    expect(statusTextOf({ level: 'error', at, detail: 'אין נייר' }, 0)).toBe('תקלה: אין נייר');
    expect([lightOf({ level: 'ok', at, detail: null }, 2), statusTextOf({ level: 'ok', at, detail: null }, 2)]).toEqual(['warn', 'ממתין בתור 2']);
    expect(statusTextOf({ level: 'ok', at, detail: VIA_CLOUD }, 0)).toBe('תקין · דרך הענן');
    expect(statusTextOf({ level: 'ok', at, detail: VIA_LAN }, 0)).toBe('תקין · דרך שרת ההדפסות');
    expect(statusTextOf({ level: 'warn', at, detail: LAN_DOWN_DIRECT }, 0)).toBe('שרת ההדפסות לא זמין · מדפיס ישירות');
    expect(statusTextOf({ level: 'warn', at, detail: LAN_DOWN_VIA_CLOUD }, 0)).toBe('שרת ההדפסות לא זמין · נשלח דרך הענן');
    expect(statusTextOf({ level: 'ok', at, detail: null }, 0)).toBe('תקין');
    expect(ownHealthOf('no_paper', true)).toEqual({ level: 'error', detail: 'אין נייר' });
    expect(ownHealthOf('paper_low', true)).toEqual({ level: 'warn', detail: 'הנייר עומד להיגמר' });
    expect(ownHealthOf('ok', false)).toEqual({ level: 'error', detail: 'אוטומטי — לא נמצאה מדפסת' });
    expect(ownHealthOf('offline', true)).toEqual({ level: 'error', detail: null });
  });

  it('routes, descriptions, designs, the width test', () => {
    const net = P({ id: 'k', type: 'network', host: '10.0.0.9', port: 9100, printWidthDots: 512, ticketDesign: 'large' });
    const relay = P({ id: 'c', type: 'cloud', host: null, hostMachineId: 'other', hostMachineName: 'קופה 3', hostConnection: 'network', isHost: false });
    const bt = P({ id: 'b', type: 'bluetooth', host: null, btAddress: 'AA:BB', btName: 'BT-58' });
    const server = { machineId: 'srv', name: 'בר', isSelf: false, lanAddress: '10.0.0.5', port: 8399, deviceRole: null, keyId: null, offLan: false };
    expect(describePrinter(net, null)).toBe('רשת · 10.0.0.9:9100 · 512 נקודות');
    expect(describePrinter(relay, null)).toBe('דרך הענן');
    expect(describePrinter(net, server)).toBe('דרך שרת ההדפסות (בר) · רשת · 10.0.0.9:9100 · 512 נקודות');
    expect(describePrinter(bt, null)).toBe('Bluetooth · BT-58 AA:BB');
    expect(describePrinter(tillPrinter('קופה'), null)).toBe('מדפסת הקופה');
    expect(designNameOf(net)).toBe('גדול וברור');
    expect(designNameOf(P({ id: 'x', ticketStyle: { template: 'modern' } }))).toBe('מודרני');
    expect(designNameOf(P({ id: 'x' }))).toBe('לפי ההגדרה הכללית');
    expect(probePlanOf(net, null)).toEqual({ kind: 'tcp', host: '10.0.0.9', port: 9100 });
    expect(probePlanOf(relay, null)).toEqual({ kind: 'cloud' });
    expect(probePlanOf(net, server)).toEqual({ kind: 'lan', directHost: { host: '10.0.0.9', port: 9100 } });
    expect(probePlanOf(tillPrinter('קופה'), null)).toEqual({ kind: 'own' });
    expect(probePlanOf(bt, null).kind).toBe('unreachable');
    expect(widthTestOffered(net)).toBe(true);
    expect(widthTestOffered(relay)).toBe(false);
    expect(widthTestOffered(tillPrinter('קופה'))).toBe(false);
  });

  it('the list: its own, then in scope, hosted, or a table zone\'s target', () => {
    const cfg = parseKitchenConfig({
      printers: [printer({ id: 'in' }), printer({ id: 'out', inScope: false }), printer({ id: 'zone', inScope: false }), printer({ id: 'host', inScope: false, isHost: true })],
      zoneRedirects: { z1: { in: 'zone' } },
    });
    expect(tillPrinters(cfg, tillPrinter('קופה')).map((p) => p.id)).toEqual(['till', 'in', 'zone', 'host']);
  });

  it('the print server card (PrintServerCard)', () => {
    expect(printServerView({ name: 'בר', self: false, address: '10.0.0.5:8399', onLan: true, reachable: true })).toEqual({ light: 'ok', title: 'שרת הדפסות', text: 'שרת ההדפסות: בר · 10.0.0.5:8399', sub: 'זמין ברשת — הבונים נשלחים אליו' });
    expect(printServerView({ name: 'בר', self: false, address: null, onLan: true, reachable: false })).toMatchObject({ light: 'error', text: 'שרת ההדפסות: בר · כתובת עוד לא ידועה', sub: 'לא זמין ברשת — מדפיסים ישירות כשאפשר, אחרת דרך הענן' });
    expect(printServerView({ name: null, self: false, address: null, onLan: false, reachable: false })).toMatchObject({ light: 'warn', sub: 'הקופה לא מחוברת ל-Wi-Fi — הבונים יוצאים ישירות או דרך הענן' });
    expect(printServerView({ name: null, self: true, address: '10.0.0.2:8399', onLan: true, reachable: true })).toMatchObject({ light: 'ok', sub: null });
    expect(printServerView({ name: null, self: true, address: null, onLan: false, reachable: false }).text).toBe('הקופה הזו היא שרת ההדפסות — אבל אינה מחוברת כעת לרשת המקומית (Wi-Fi)');
  });

  it('the queue\'s rows, the history, waiting counts, a found printer, the cloud\'s refusal', () => {
    const failed = job({ id: 'f', state: 'failed', lastError: 'no_paper: אין נייר', createdAt: 2 });
    const waiting = job({ id: 'w', state: 'pending', attempts: 2, createdAt: 1 });
    expect(jobStateText(waiting)).toBe('ממתין — מנסה שוב (ניסיון 3)');
    expect(jobStateText({ state: 'relayed', lastError: 'slow', attempts: 0 })).toBe('נשלח לשרת ההדפסות ועוד לא הודפס (יותר מדקה)');
    const rows = queueRowsOf([failed, waiting], () => true);
    expect(rows.map((r) => r.id)).toEqual(['w', 'f']);
    expect(rows[1]).toMatchObject({ title: 'שולחן 12 · בר', state: 'לא הודפס — no_paper: אין נייר', canMove: true, canTill: true });
    const now = Date.now();
    const done = job({ id: 'd', state: 'done', finishedAt: now - 60_000 });
    const old = job({ id: 'o', state: 'done', finishedAt: now - 25 * 3_600_000 });
    expect(historyRowsOf([done, old, failed], now).map((r) => r.id)).toEqual(['d']);
    expect(historyRowsOf([done], now)[0].text).toMatch(/^שולחן 12 · בר · \d\d:\d\d$/);
    expect(waitingByPrinter([waiting, failed, job({ printerId: 'x', state: 'sending' })])).toEqual(new Map([['p-bar', 1], ['x', 1]]));
    expect(foundPrinterView({ host: '10.0.0.7', port: 9100, health: 'ok', known: null })).toMatchObject({ kind: 'מדפסת ESC/POS', paper: 'נייר תקין', known: null, canAdd: true, addTitle: 'הוספת מדפסת 10.0.0.7' });
    expect(foundPrinterView({ host: '10.0.0.8', port: 9100, health: 'unknown', known: 'מטבח' })).toMatchObject({ kind: 'לא ענתה לבדיקת ESC/POS — אפשר לנסות דף בדיקה', paper: null, known: 'כבר מוגדרת: מטבח', canAdd: false });
    expect(addRefusalText(null, null)).toBe('אין חיבור לענן — נסו שוב');
    expect(addRefusalText(409, 'printer_already_configured')).toBe('המדפסת כבר מוגדרת בסניף');
    expect(addRefusalText(403, 'x')).toBe('לא נוספה: x');
  });
});

/* ------------------------------------------------------------------ the service */

const BAR = printer({ id: 'p-bar', name: 'בר', host: '10.0.0.9', port: 9100, ticketDesign: 'compact' });
const RELAY = printer({ id: 'p-relay', name: 'מטבח רחוק', type: 'cloud', host: null, hostMachineId: 'other', hostMachineName: 'קופה 3', isHost: false });
const OTHER_RECEIPT = printer({ id: 'r-3', name: 'קבלות 3', type: 'cloud', purpose: 'receipt', host: null, hostMachineId: 'other', hostMachineName: 'קופה 3', isHost: false, inScope: false, scope: 'shop' });

interface Fakes extends TillPrintersDeps {
  tcp: Map<string, boolean>;
  raw: Array<{ host: string; port: number; n: number }>;
}

function fakes(): Fakes {
  const tcp = new Map<string, boolean>();
  const raw: Fakes['raw'] = [];
  return {
    tcp,
    raw,
    probeTcp: async (host, port) => tcp.get(`${host}:${port}`) ?? false,
    ownStatus: async () => ({ health: 'ok', found: true }),
    lanCall: async () => ({ status: 200, body: { ok: true } }),
    sendRaw: async (host, port, bytes) => {
      raw.push({ host, port, n: bytes.length });
    },
    scan: async () => ({ ok: true, subnet: '10.0.0.0/24', printers: [{ host: '10.0.0.9', port: 9100, health: 'ok' }, { host: '10.0.0.40', port: 9100, health: 'paper_low' }] }),
    grant: async (pin) => (pin === MANAGER_PIN ? { ok: true, token: 'grant-1', name: 'אבי לוי' } : { ok: false, message: 'קוד שגוי' }),
    pollMs: 60_000,
  };
}

async function till(cfg: Record<string, unknown>, o: HarnessOptions = {}, deps: Fakes = fakes()) {
  const answers = { 'GET sync/m/printers': () => ({ syncType: 'full', etag: 'e1', printSecret: 'secret-0123456789', ...cfg }), ...(o.answers ?? {}) };
  h = harness({ ...o, answers });
  await h.svc.kitchen.pull(true);
  const f = h.engine.register(new TillPrinters(h.engine.ctx, deps));
  await h.ok('session.login', { pin: PIN });
  return { h, f, deps };
}

const pv = (x: Harness) => (x.state() as unknown as { printers?: PrintersState }).printers;
const row = (x: Harness, id: string) => pv(x)!.rows.find((r) => r.id === id)!;

describe('the service through the engine', () => {
  it('opens: its own printer and the kitchen\'s, each tested — a connect, the cloud, its status', async () => {
    const d = fakes();
    d.tcp.set('10.0.0.9:9100', true);
    const { h } = await till({ printers: [BAR, RELAY, printer({ id: 'p-off', name: 'קינוחים', host: '10.0.0.10' })] }, {}, d);
    expect(pv(h)).toBeUndefined();
    await h.ok(op('printers.open'));
    await until(() => pv(h)!.rows.every((r) => !r.checking && r.status !== 'בודק…'));
    const v = pv(h)!;
    expect(v.rows.map((r) => r.id)).toEqual(['till', 'p-bar', 'p-relay', 'p-off']);
    expect(row(h, 'till')).toMatchObject({ name: 'קופה', light: 'ok', status: 'תקין', design: null, widthTest: false, designTest: false });
    expect(row(h, 'till').where.startsWith('מדפסת הקופה · ')).toBe(true);
    expect(row(h, 'p-bar')).toMatchObject({ light: 'ok', status: 'תקין', where: 'רשת · 10.0.0.9:9100', design: 'עיצוב בון: חסכוני', widthTest: true, designTest: true });
    expect(row(h, 'p-relay')).toMatchObject({ light: 'ok', status: 'תקין · דרך הענן', where: 'דרך הענן', widthTest: false });
    expect(row(h, 'p-off')).toMatchObject({ light: 'error', status: 'לא מגיב' });
    expect(v.none).toBeNull();
    expect(v.server).toBeNull();
    expect(v.queue).toBeNull();
    expect(v.receipt.now).toBe('הקבלות מודפסות כעת: לא הוגדרה מדפסת לקבלות');
    expect(v.receipt.options).toEqual([]);
    // The cloud was asked by the printers' own route (its ETag), nothing changed.
    expect(h.sent.filter((s) => s.path === 'sync/m/printers').length).toBeGreaterThanOrEqual(2);
    // "בדיקת תקשורת" again: the printer answers now.
    d.tcp.set('10.0.0.10:9100', true);
    await h.ok(op('printers.check'), { printerId: 'p-off' });
    await until(() => row(h, 'p-off').status === 'תקין');
    expect((await h.fail(op('printers.check'), { printerId: 'nope' })).code).toBe('invalid_args');
  });

  it('only this till\'s printer: "לא הוגדרו מדפסות בונים…"; another operator sees nothing', async () => {
    const { h } = await till({ printers: [] });
    await h.ok(op('printers.open'));
    expect(pv(h)!.none).toBe(PRINTERS_TEXT.none);
    await h.ok('session.logout');
    await h.ok('session.login', { pin: MANAGER_PIN });
    expect(pv(h)).toBeUndefined();
    expect((await h.fail(op('printers.test'), { printerId: 'till' })).code).toBe('permission_denied');
  });

  it('the print server on the LAN: its card; a printer it prints answers through it (or straight, off the LAN)', async () => {
    const d = fakes();
    d.tcp.set('10.0.0.9:9100', true);
    const { h } = await till({ printers: [BAR], printHost: { machineId: 'srv', name: 'בר', isSelf: false, lanAddress: '10.0.0.5', port: 8399 } }, {}, d);
    await h.ok(op('printers.open'));
    await until(() => !!pv(h)!.server && !row(h, 'p-bar').checking && row(h, 'p-bar').status !== 'בודק…');
    const lan = h.svc.kitchen.lanReachable();
    expect(pv(h)!.server).toMatchObject({ title: 'שרת הדפסות', text: 'שרת ההדפסות: בר · 10.0.0.5:8399', light: lan ? 'ok' : 'warn' });
    expect(row(h, 'p-bar').status).toBe(lan ? 'תקין · דרך שרת ההדפסות' : 'שרת ההדפסות לא זמין · מדפיס ישירות');
    expect(row(h, 'p-bar').where).toBe('דרך שרת ההדפסות (בר) · רשת · 10.0.0.9:9100');
  });

  it('"בון בדיקה", the design\'s sample, "בדיקת רוחב"', async () => {
    const d = fakes();
    const { h } = await till({ printers: [BAR] }, {}, d);
    await h.ok(op('printers.open'));
    await h.ok(op('printers.test'), { printerId: 'p-bar' });
    expect(pv(h)!.message).toBe('בון בדיקה נשלח ל־בר');
    const store = new KitchenStore(h.svc.db);
    const tests = store.all().filter((j) => j.printerId === 'p-bar');
    expect(tests.map((j) => j.kind)).toEqual(['test']);
    await h.ok(op('printers.test'), { printerId: 'till' });
    expect(store.all().filter((j) => j.printerId === 'till').map((j) => j.kind)).toEqual(['test']);
    await h.ok(op('printers.designTest'), { printerId: 'p-bar' });
    expect(pv(h)!.message).toBe('בון לדוגמה נשלח ל־בר');
    const sample = store.all().filter((j) => j.printerId === 'p-bar' && j.kind !== 'test')[0];
    expect(JSON.parse(sample.ticketJson).notice).toBe('הדפסת ניסיון — לא להכנה · הערה לשולחן: יום הולדת — להביא נר');
    expect((await h.fail(op('printers.designTest'), { printerId: 'till' })).code).toBe('invalid_args');
    await h.ok(op('printers.widthTest'), { printerId: 'p-bar' });
    await until(() => d.raw.length === 1);
    expect(d.raw[0]).toMatchObject({ host: '10.0.0.9', port: 9100 });
    await until(() => (pv(h)!.message ?? '').startsWith('בדיקת רוחב נשלחה ל-בר'));
    expect((await h.fail(op('printers.widthTest'), { printerId: 'till' })).code).toBe('invalid_args');
  });

  it('the queue: retry and "בטל בון" are the engine\'s; "מדפסת אחרת" asks, "הדפס בקופה" moves; "הדפס שוב" a printed one', async () => {
    const kitchen = P({ id: 'p-kitchen', name: 'מטבח', host: '10.0.0.11' });
    const { h } = await till({ printers: [BAR, printer({ id: 'p-kitchen', name: 'מטבח', host: '10.0.0.11' })] });
    const store = new KitchenStore(h.svc.db);
    const failed = job({ id: 'j-failed', state: 'failed', attempts: 1, lastError: 'offline' });
    const done = job({ id: 'j-done', state: 'done', finishedAt: Date.now() - 5_000, printer: kitchen });
    store.insertAll([failed, done]);
    await h.ok(op('printers.open'));
    const q = pv(h)!.queue!;
    expect(q.title).toBe('בונים שממתינים לטיפול');
    expect(q.rows).toEqual([{ id: 'j-failed', title: 'שולחן 12 · בר', state: 'לא הודפס — offline', canMove: true, canTill: true }]);
    expect(pv(h)!.history!.rows.map((r) => r.id)).toEqual(['j-done']);
    // "מדפסת אחרת": the choices of the engine's queue, the kitchen among them.
    await h.ok(op('printers.move'), { jobId: 'j-failed' });
    const d = h.state().dialog!;
    expect(d.title).toBe('בחרו מדפסת');
    expect(d.actions.map((a) => a.id)).toContain('to:p-kitchen');
    await h.ok('dialog.answer', { dialogId: d.id, action: 'to:p-kitchen' });
    // Moved by the engine's queue: off the bar's queue, a job on the kitchen marked "הופנה מ: בר".
    expect(pv(h)!.queue).toBeNull();
    expect(store.all().some((j) => j.printerId === 'p-kitchen' && j.ticketJson.includes('הופנה מ: בר'))).toBe(true);
    // "הדפס שוב": a new job on the kitchen, marked.
    await h.ok(op('printers.reprint'), { jobId: 'j-done' });
    const again = store.all().filter((j) => j.printerId === 'p-kitchen' && j.id !== 'j-done' && j.ticketJson.includes('הדפסה חוזרת'));
    expect(again).toHaveLength(1);
    expect(JSON.parse(again[0].ticketJson).notice).toBe('הדפסה חוזרת');
    expect((await h.fail(op('printers.reprint'), { jobId: 'nope' })).code).toBe('invalid_args');
    // "הדפס בקופה" on another failed one.
    store.insertAll([job({ id: 'j-2', state: 'failed', attempts: 1, lastError: 'offline' })]);
    await h.ok(op('printers.toTill'), { jobId: 'j-2' });
    expect(store.all().some((j) => j.printerId === 'till' && j.ticketJson.includes('המבורגר'))).toBe(true);
  });

  it('"מדפסת לקבלות ולמסמכים": another till\'s printer offered; a cashier\'s change asks a manager', async () => {
    const { h } = await till({ printers: [BAR, OTHER_RECEIPT] }, { parameters: { remotePrintDocuments: 'bill_receipts' } });
    await h.ok(op('printers.open'));
    const r = pv(h)!.receipt;
    expect(r.title).toBe('מדפסת לקבלות ולמסמכים');
    expect(r.followsCloud).toBe('לפי הגדרת הענן');
    expect(r.options.map((o) => o.label)).toEqual(['המדפסת של קופה 3', 'לשאול בכל פעם']);
    // No printer of its own here and none assigned to it: each receipt asks (remoteRouteOf).
    expect(r.now).toBe('הקבלות מודפסות כעת: לשאול בכל פעם');
    expect((await h.fail(op('printers.receipt'), { choice: 'nope' })).code).toBe('invalid_args');
    await h.ok(op('printers.receipt'), { choice: 'r-3' });
    const d = h.state().dialog!;
    expect(d.kind).toBe('manager_approval');
    expect(d.body).toContain('שינוי מדפסת הקבלות של הקופה: המדפסת של קופה 3');
    expect(h.svc.kv.get(TILL_PRINTER_KEY)).toBeNull();
    await h.ok('dialog.answer', { dialogId: d.id, action: 'approve', answers: { pin: MANAGER_PIN } });
    expect(h.svc.kv.get(TILL_PRINTER_KEY)).toBe('r-3');
    expect(pv(h)!.receipt).toMatchObject({ override: 'נבחר בקופה — עוקף את הגדרת הענן', now: 'הקבלות מודפסות כעת: המדפסת של קופה 3', followsCloud: null });
    expect(pv(h)!.receipt.options.find((o) => o.id === 'r-3')!.on).toBe(true);
    // "חזור להגדרת הענן".
    await h.ok(op('printers.receipt'), { choice: null });
    await h.ok('dialog.answer', { dialogId: h.state().dialog!.id, action: 'approve', answers: { pin: MANAGER_PIN } });
    expect(h.svc.kv.get(TILL_PRINTER_KEY)).toBeNull();
  });

  it('"חיפוש מדפסות ברשת" and "הוספה" with a code the cloud checks', async () => {
    const posted: Array<{ body: unknown }> = [];
    const { h } = await till({ printers: [BAR] }, { answers: { 'POST sync/m/printers': (b) => (posted.push({ body: b }), { id: 'new' }) } });
    await h.ok(op('printers.open'));
    expect(pv(h)!.discovery!.startLabel).toBe('חיפוש מדפסות ברשת');
    await h.ok(op('printers.scan'));
    await until(() => pv(h)!.discovery!.scanning === false);
    const disc = pv(h)!.discovery!;
    expect(disc.text).toMatch(/^נמצאו 2 ב-10\.0\.0\.0\/24 \(\d+ שנ׳\)$/);
    expect(disc.startLabel).toBe('חיפוש מחדש');
    expect(disc.found.map((f) => [f.host, f.known, f.paper])).toEqual([
      ['10.0.0.9', 'כבר מוגדרת: בר', 'נייר תקין'],
      ['10.0.0.40', null, 'הנייר עומד להיגמר'],
    ]);
    expect((await h.fail(op('printers.add'), { host: '10.0.0.99', port: 9100, name: 'x', purpose: 'kitchen' })).code).toBe('invalid_args');
    await h.ok(op('printers.add'), { host: '10.0.0.40', port: 9100, name: 'בר 2', purpose: 'kitchen' });
    const d = h.state().dialog!;
    expect(d).toMatchObject({ kind: 'manager_approval', title: 'הוספת מדפסת 10.0.0.40', body: 'הוספת מדפסת לסניף' });
    await h.ok('dialog.answer', { dialogId: d.id, action: 'approve', answers: { pin: MANAGER_PIN } });
    await until(() => posted.length === 1 && pv(h)!.message !== null);
    expect(posted[0].body).toEqual({ name: 'בר 2', host: '10.0.0.40', port: 9100, purpose: 'kitchen' });
    expect(pv(h)!.message).toBe('המדפסת בר 2 נוספה לסניף');
    expect(pv(h)!.discovery!.found[1].known).toBe('כבר מוגדרת: בר 2');
  });

  it('the scan off the LAN, and "הפסק"', async () => {
    const d = fakes();
    d.scan = async () => ({ ok: false, error: 'not_on_lan' });
    const { h } = await till({ printers: [] }, {}, d);
    await h.ok(op('printers.open'));
    await h.ok(op('printers.scan'));
    await until(() => pv(h)!.discovery!.scanning === false);
    expect(pv(h)!.discovery!.text).toBe('הקופה לא מחוברת לרשת מקומית (Wi‑Fi או Ethernet) — אין מה לסרוק.');
    let release: () => void = () => undefined;
    d.scan = () => new Promise((r) => (release = () => r({ ok: true, subnet: 's', printers: [] })));
    await h.ok(op('printers.scan'));
    expect(pv(h)!.discovery!.scanning).toBe(true);
    await h.ok(op('printers.scanStop'));
    expect(pv(h)!.discovery!.text).toBe('הסריקה הופסקה.');
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(pv(h)!.discovery!.text).toBe('הסריקה הופסקה.');
  });
});

/* ------------------------------------------------------------------ the screen */

describe('the screen', () => {
  const noop = () => undefined;
  const actions = { check: noop, test: noop, designTest: noop, widthTest: noop, reprint: noop, retry: noop, handled: noop, move: noop, toTill: noop, receipt: noop, scan: noop, scanStop: noop, add: noop };

  it('draws the cards, the queue, the history and the discovery', async () => {
    const d = fakes();
    d.tcp.set('10.0.0.9:9100', true);
    const { h } = await till({ printers: [BAR] }, {}, d);
    new KitchenStore(h.svc.db).insertAll([job({ id: 'j-f', state: 'failed', lastError: 'offline', attempts: 1 }), job({ id: 'j-d', state: 'done', finishedAt: Date.now() })]);
    await h.ok(op('printers.open'));
    await until(() => !row(h, 'p-bar').checking && row(h, 'p-bar').status !== 'בודק…');
    const html = renderToStaticMarkup(createElement(PrintersScreen, { view: pv(h)!, actions, back: noop }));
    for (const s of ['מדפסות', 'בונים שממתינים לטיפול', 'נסה שוב', 'מדפסת אחרת', 'הדפס בקופה', 'בטל בון', 'מדפסת לקבלות ולמסמכים', 'המדפסות של הקופה', 'בדיקת תקשורת', 'בון בדיקה', 'הדפסת ניסיון בעיצוב הזה', 'בדיקת רוחב', 'הודפסו לאחרונה (24 שעות)', 'הדפס שוב', 'חיפוש מדפסות ברשת', 'חזרה', 't-prn-dot-ok']) {
      expect(html).toContain(s);
    }
    expect(renderToStaticMarkup(createElement(PrintersScreen, { view: null, actions, back: noop }))).toContain('…');
  });
});

