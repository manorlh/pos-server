/**
 * "מדפסות" (core/printerPicker.ts) and the printing helpers this round added: one printer for everything, the overrides,
 * a chosen printer that is gone, the receipt's width, a wider page fitted, one page at a time per printer, ASCII commands to
 * the spooler helper, the basket's summary, the Chromium 108 bidi fallback.
 */

import { describe, expect, it } from 'vitest';
import { fitWidth, printerRaster, RECEIPT_WIDTHS, toMono } from '../src/core/escpos';
import { basketSummaryDoc } from '../src/core/printDocs';
import { pickerCandidates, pickerView, pickStatusOf, targetId, type PickerInput } from '../src/core/printerPicker';
import { printerKey, withPrinter } from '../src/main/printer/printerLock';
import { asciiJson } from '../src/main/printer/transports';
import { bidiForCanvas } from '../src/renderer/print/draw';

const base = (over: Partial<PickerInput> = {}): PickerInput => ({
  queues: [
    { name: 'SNBC BTP-R880NPV', port: 'USB001', health: 'ok' },
    { name: 'Microsoft Print to PDF', port: 'PORTPROMPT:', health: 'ok' },
  ],
  usbNoDriver: [],
  serial: [],
  network: [],
  saved: [],
  chosen: { receipt: null, bon: null, ticket: null },
  autoQueue: 'SNBC BTP-R880NPV',
  ...over,
});

describe('the picker', () => {
  it('"אוטומטי": the USB printer found is the device’s printer; nothing else chosen; no alert', () => {
    const v = pickerView(base(), { widthDots: 576, widths: [...RECEIPT_WIDTHS], scannedAt: null, lanScanning: false, subnet: null });
    expect(v.rows[0]).toMatchObject({ id: 'win:SNBC BTP-R880NPV', connection: 'usb', status: 'ready', roles: ['receipt'] });
    expect(v.roles.map((r) => [r.role, r.auto])).toEqual([
      ['receipt', true],
      ['bon', true],
      ['ticket', true],
    ]);
    expect(v.roles[1].value).toBe('כמו המדפסת של המכשיר');
    expect(v.alerts).toEqual([]);
  });

  it('every kind found, one row each: a USB printer with no driver cannot be picked; a COM port; the network, a saved name first', () => {
    const rows = pickerCandidates(
      base({
        usbNoDriver: [{ name: 'USB Printing Support', id: 'USB/VID_154F' }],
        serial: [{ path: 'com3', name: 'CH340 (COM3)' }],
        network: [{ host: '192.168.1.71', port: 9100, health: 'no_paper' }],
        saved: [{ host: '192.168.1.71', port: 9100, health: 'no_paper', name: 'מטבח חם' }],
        chosen: { receipt: null, bon: { transport: 'tcp', host: '192.168.1.71', port: 9100 }, ticket: null },
      }),
    );
    expect(rows.map((r) => r.id)).toEqual(['win:SNBC BTP-R880NPV', 'tcp:192.168.1.71:9100', 'win:Microsoft Print to PDF', 'com:COM3', 'usb:USB/VID_154F']);
    expect(rows.find((r) => r.connection === 'usb_no_driver')).toMatchObject({ target: null, status: 'no_driver' });
    expect(rows.find((r) => r.id === 'tcp:192.168.1.71:9100')).toMatchObject({ name: 'מטבח חם', status: 'no_paper', roles: ['bon'] });
    expect(rows.find((r) => r.id === 'com:COM3')!.target).toEqual({ transport: 'serial', comPort: 'COM3' });
  });

  it('a chosen printer that is gone stays listed, red, and is said at the top; nothing at all on "אוטומטי" is said too', () => {
    const gone = pickerView(base({ chosen: { receipt: { transport: 'spooler', queueName: 'Xprinter XP-80' }, bon: null, ticket: null } }), { widthDots: 576, widths: [], scannedAt: null, lanScanning: false, subnet: null });
    expect(gone.rows[0]).toMatchObject({ id: 'win:Xprinter XP-80', missing: true, statusText: 'לא נמצאה', roles: ['receipt'] });
    expect(gone.alerts).toEqual(['המדפסת של המכשיר: "Xprinter XP-80" לא נמצאה — בדקו שהיא דולקת ומחוברת, או בחרו מדפסת אחרת']);
    const none = pickerView(base({ queues: [], autoQueue: null }), { widthDots: 576, widths: [], scannedAt: null, lanScanning: false, subnet: null });
    expect(none.alerts[0]).toContain('לא נמצאה מדפסת USB');
  });

  it('statuses and ids', () => {
    expect(['ok', 'no_paper', 'unavailable', 'weird'].map(pickStatusOf)).toEqual(['ready', 'no_paper', 'offline', 'unknown']);
    expect(targetId({ transport: 'tcp', host: '10.0.0.9' })).toBe('tcp:10.0.0.9:9100');
    expect(targetId({ transport: 'spooler', queueName: '' })).toBeNull();
    expect(targetId({ transport: 'serial', comPort: 'com4' })).toBe('com:COM4');
  });
});

describe('the printing helpers', () => {
  it('"רוחב הדפסה": 576 / 512 / 432 / 384, anything else 576', () => {
    expect([576, 512, 432, 384, '512', 500, null, undefined].map(printerRaster)).toEqual([576, 512, 432, 384, 512, 576, 576, 576]);
  });

  it('a page wider than the head is scaled down to it, never cut; one that fits is left alone', () => {
    const rgba = new Uint8Array(576 * 10 * 4).fill(255);
    // A black dot at the right edge (where an RTL label is).
    rgba.fill(0, (5 * 576 + 575) * 4, (5 * 576 + 575) * 4 + 3);
    const wide = toMono(rgba, 576, 10);
    const fit = fitWidth(wide, 512);
    expect(fit.width).toBe(512);
    expect(fit.height).toBe(9);
    const lastRowHasRightDot = Array.from({ length: fit.height }, (_, y) => fit.data[y * fit.rowBytes + 63] & 1).some(Boolean);
    expect(lastRowHasRightDot).toBe(true);
    expect(fitWidth(fit, 576)).toBe(fit);
  });

  it('one page at a time per printer, whoever sends it; other printers do not wait', async () => {
    const order: string[] = [];
    const slow = (tag: string, ms: number) => async () => {
      order.push(`${tag}+`);
      await new Promise((r) => setTimeout(r, ms));
      order.push(`${tag}-`);
    };
    const key = printerKey({ transport: 'tcp', host: '10.0.0.9' });
    expect(key).toBe('net:10.0.0.9:9100');
    await Promise.all([withPrinter(key, slow('receipt', 30)), withPrinter(key, slow('bon', 5)), withPrinter('win:other', slow('other', 1))]);
    expect(order.indexOf('receipt-')).toBeLessThan(order.indexOf('bon+'));
    expect(order.indexOf('other-')).toBeLessThan(order.indexOf('receipt-'));
    expect(printerKey({ transport: 'spooler', queueName: null })).toBeNull();
  });

  it('commands to the spooler helper are ASCII: a Hebrew queue name escaped, read back the same', () => {
    const text = asciiJson({ op: 'send', printer: 'מדפסת קבלות — 1' });
    expect(/^[\x20-\x7e]*$/.test(text)).toBe(true);
    expect(JSON.parse(text)).toEqual({ op: 'send', printer: 'מדפסת קבלות — 1' });
  });

  it('"סיכום עסקה": sold, returned, the one figure that crossed the counter', () => {
    const paid = JSON.stringify(basketSummaryDoc({ soldAgorot: 6_200, returnedAgorot: 2_400, documentNumbers: ['20000003', '20000002'], printedAt: new Date(2026, 9, 17, 21, 45) }));
    expect(paid).toContain('שולם');
    expect(paid).toContain('20000003');
    expect(JSON.stringify(basketSummaryDoc({ soldAgorot: 1_000, returnedAgorot: 3_000, documentNumbers: ['1'], printedAt: new Date() }))).toContain('הוחזר ללקוח');
    expect(JSON.stringify(basketSummaryDoc({ soldAgorot: 1_000, returnedAgorot: 1_000, documentNumbers: ['1'], printedAt: new Date() }))).toContain('יתרה 0');
  });

  it('Chromium 108: isolates become embeddings ("K-1" printed "1-K" before); a current Chromium keeps them', () => {
    const lri = String.fromCharCode(0x2066);
    const pdi = String.fromCharCode(0x2069);
    const text = `מספר ${lri}K-1${pdi}`;
    expect(bidiForCanvas(text, true)).toBe(text);
    expect(bidiForCanvas(text, false)).toBe(`מספר ${String.fromCharCode(0x202a)}K-1${String.fromCharCode(0x202c)}`);
    expect(bidiForCanvas('אין', false)).toBe('אין');
  });
});
