import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { TEXT_KEYS } from '@dash-lib/kioskConfig';
import {
  decideScan,
  DUPLICATE_MS,
  findScanProduct,
  gtinCheckOk,
  IDLE_END_MS,
  KeyBurst,
  keyLeftAlone,
  parseScan,
  scanCandidates,
  ScanDedupe,
  ScanKeyReader,
  scannedVoucherCode,
  upcEToUpcA,
  usKeyChar,
  type ScanProduct,
  type ScanScene,
} from '../src/core/kioskScan';

type P = ScanProduct & { addPath: 'direct' | 'sheet' | 'none' };
const p = (id: string, barcode: string | null, extra: Partial<P> = {}): P => ({ id, barcode, sku: id, soldOut: false, addPath: 'direct', ...extra });

/** What the kiosk shows (sold out marked); "tillonly" is in the kiosk's catalog rows but not shown. */
const shown: P[] = [
  p('cola', '7290000000015'),
  p('burger', '4006381333931', { sku: 'B-100' }),
  p('snack', '96385074'),
  p('upc', '0036000291452'),
  p('upce', '042100005264'),
  p('meal', '1111111111116', { addPath: 'sheet' }),
  p('gone', '2222222222222', { soldOut: true, addPath: 'none' }),
  p('clash', '777', { sku: 'clash' }),
  p('bysku', null, { sku: '777' }),
];
const all = [...shown, p('tillonly', '3333333333333')];

const decide = (raw: string, scene: Partial<ScanScene> = {}, duplicate = false) =>
  decideScan(parseScan(raw), { screen: 'catalog', ...scene }, shown, (x) => x.addPath, { all, duplicate });
const addedId = (a: ReturnType<typeof decide>) => (a.kind === 'add' ? a.product.id : null);

describe('a scan, read (a port of the Android kiosk’s KioskScan.kt)', () => {
  it('AIM prefixes of 1D symbologies are read and dropped', () => {
    const ean = parseScan(']E07290000000015\r\n');
    expect(ean).toMatchObject({ aim: ']E0', text: '7290000000015', symbology: 'EAN-13', guessed: false });
    expect(parseScan(']E496385074').symbology).toBe('EAN-8');
    expect(parseScan(']E0036000291452').symbology).toBe('UPC-A');
    expect(parseScan(']E004252614').symbology).toBe('UPC-E');
    expect(parseScan(']C0ABC-123').symbology).toBe('Code 128');
    expect(parseScan(']C10107290000000015').symbology).toBe('GS1-128');
    expect(parseScan(']A0B-100').symbology).toBe('Code 39');
    expect(parseScan(']I017290000000012').symbology).toBe('ITF');
  });

  it('AIM prefixes of 2D symbologies are read and dropped', () => {
    expect(parseScan(']Q17290000000015')).toMatchObject({ symbology: 'QR', text: '7290000000015' });
    expect(parseScan(']d1B-100').symbology).toBe('Data Matrix');
    expect(parseScan(']d20107290000000015').symbology).toBe('GS1 Data Matrix');
    expect(parseScan(']L0hello').symbology).toBe('PDF417');
    expect(parseScan(']z0hello').symbology).toBe('Aztec');
  });

  it('without an AIM prefix only the EAN/UPC family is told from the digits', () => {
    expect(parseScan('7290000000015')).toMatchObject({ aim: null, symbology: 'EAN-13', guessed: true });
    expect(parseScan('96385074').symbology).toBe('EAN-8');
    expect(parseScan('036000291452').symbology).toBe('UPC-A');
    expect(parseScan('04252614').symbology).toBe('UPC-E');
    expect(parseScan('7290000000016').symbology).toBeNull();
    expect(parseScan('B-100').symbology).toBeNull();
    expect(parseScan(' \u0002\r\n').text).toBe('');
  });

  it('check digits, UPC-E and the other ways of writing a code', () => {
    expect(gtinCheckOk('4006381333931')).toBe(true);
    expect(gtinCheckOk('4006381333932')).toBe(false);
    expect(upcEToUpcA('04252614')).toBe('042100005264');
    expect(upcEToUpcA('04252615')).toBeNull();
    expect(scanCandidates('036000291452')).toEqual(['036000291452', '0036000291452']);
    expect(scanCandidates('0036000291452')).toEqual(['0036000291452', '036000291452']);
    expect(scanCandidates('0107290000000015\u001d10LOT7')).toContain('7290000000015');
    expect(scanCandidates('https://id.example.com/01/07290000000015?x=1')).toContain('7290000000015');
  });

  it('a voucher is told by its "PV:" only, after an AIM prefix too', () => {
    expect(scannedVoucherCode('PV:ABCD-EFGH-2345-6789')).toBe('ABCDEFGH23456789');
    expect(scannedVoucherCode(']Q1pv:abcdefgh23456789')).toBe('ABCDEFGH23456789');
    expect(scannedVoucherCode('ABCDEFGH23456789')).toBeNull();
    expect(scannedVoucherCode('7290000000015')).toBeNull();
  });
});

describe('the product a scan names', () => {
  it('found by barcode among what the kiosk shows, 1D, QR and GS1', () => {
    expect(addedId(decide(']E07290000000015'))).toBe('cola');
    expect(addedId(decide(']Q17290000000015'))).toBe('cola');
    expect(addedId(decide(']E496385074'))).toBe('snack');
    expect(addedId(decide(']d20107290000000015\u001d10LOT7'))).toBe('cola');
    expect(addedId(decide(']C10107290000000015'))).toBe('cola');
    expect(addedId(decide(']E0036000291452'))).toBe('upc');
    expect(addedId(decide(']E004252614'))).toBe('upce');
  });

  it('by SKU when no barcode matches; a barcode wins over another product’s SKU', () => {
    expect(addedId(decide(']A0B-100'))).toBe('burger');
    expect(addedId(decide(']d1b-100'))).toBe('burger');
    expect(addedId(decide('777'))).toBe('clash');
  });

  it('a product with something to choose opens its sheet', () => {
    expect(decide('1111111111116')).toMatchObject({ kind: 'choose', start: 'now', product: { id: 'meal' } });
  });

  it('not found, not on the kiosk and sold out all say not found', () => {
    expect(decide('5555555555555')).toEqual({ kind: 'not_found', why: 'unknown' });
    expect(decide('3333333333333')).toEqual({ kind: 'not_found', why: 'not_on_kiosk' });
    expect(decide('2222222222222')).toEqual({ kind: 'not_found', why: 'sold_out' });
    expect(findScanProduct(parseScan('3333333333333'), shown)).toEqual({ kind: 'missing', why: 'unknown' });
  });

  it('a prepaid voucher goes to the counter, never redeemed or looked up as a product', () => {
    expect(decide('PV:ABCD-EFGH-2345-6789')).toEqual({ kind: 'voucher', code: 'ABCDEFGH23456789' });
    expect(decide(']Q1PV:ABCDEFGH23456789', { screen: 'attract' })).toEqual({ kind: 'voucher', code: 'ABCDEFGH23456789' });
    expect(decide('PV:ABCDEFGH23456789', { screen: 'pay' })).toEqual({ kind: 'ignore', why: 'payment' });
  });
});

describe('what each screen does with a scan', () => {
  it('the attract screen starts the order; the service screen waits for the choice', () => {
    expect(decide('7290000000015', { screen: 'attract' })).toMatchObject({ kind: 'add', start: 'start_order' });
    expect(decide('7290000000015', { screen: 'service' })).toMatchObject({ kind: 'add', start: 'after_service' });
    expect(decide('7290000000015', { screen: 'cart' })).toMatchObject({ kind: 'add', start: 'now' });
    expect(decide('7290000000015', { screen: 'confirm' })).toMatchObject({ kind: 'add', start: 'now' });
    expect(decide('5555555555555', { screen: 'attract' })).toEqual({ kind: 'not_found', why: 'unknown' });
  });

  it('payment, success, details, rest screens, staff screens and sheets ignore scans', () => {
    expect(decide('7290000000015', { screen: 'pay' })).toEqual({ kind: 'ignore', why: 'payment' });
    expect(decide('7290000000015', { busy: true })).toEqual({ kind: 'ignore', why: 'payment' });
    expect(decide('7290000000015', { screen: 'success' })).toEqual({ kind: 'ignore', why: 'success' });
    expect(decide('7290000000015', { screen: 'details' })).toEqual({ kind: 'ignore', why: 'text_input' });
    for (const screen of ['setup', 'paused', 'closed', 'no_payment'] as const) {
      expect(decide('7290000000015', { screen })).toEqual({ kind: 'ignore', why: 'not_selling' });
    }
    expect(decide('7290000000015', { staff: true })).toEqual({ kind: 'ignore', why: 'staff' });
    expect(decide('7290000000015', { sheetOpen: true })).toEqual({ kind: 'ignore', why: 'sheet' });
    expect(decide('\r\n')).toEqual({ kind: 'ignore', why: 'empty' });
  });

  it('the same code within 800 ms counts once', () => {
    const d = new ScanDedupe();
    expect(DUPLICATE_MS).toBe(800);
    expect(d.accept('7290000000015', 1000)).toBe(true);
    expect(d.accept('7290000000015', 1500)).toBe(false);
    expect(d.accept('7290000000015', 2200)).toBe(false);
    expect(d.accept('7290000000015', 3100)).toBe(true);
    expect(d.accept('96385074', 3150)).toBe(true);
    expect(decide('7290000000015', {}, true)).toEqual({ kind: 'ignore', why: 'duplicate' });
  });
});

describe('the scanner’s keys', () => {
  const keys = (reader: ScanKeyReader, text: string, from: number, shiftFor = /[A-Z\]]/) => {
    const out: Array<string | null> = [];
    [...text].forEach((c, i) => {
      const code = /\d/.test(c) ? `Digit${c}` : /[a-z]/i.test(c) ? `Key${c.toUpperCase()}` : c === ']' ? 'BracketRight' : c === ':' ? 'Semicolon' : c === '-' ? 'Minus' : 'Unidentified';
      out.push(reader.down({ code, key: 'ש', shift: /[A-Z:]/.test(c) && shiftFor.test(c) ? true : c === ':', at: from + i * 4 }));
    });
    return out;
  };

  it('a burst ending in Enter is a code, read by key position whatever the Windows language', () => {
    const r = new ScanKeyReader();
    // Windows set to Hebrew: KeyboardEvent.key says "ש", the code says KeyA.
    keys(r, ']E07290000000015', 0);
    expect(r.down({ code: 'Enter', key: 'Enter', at: 100 })).toBe(']E07290000000015');
    keys(r, 'PV:ABCD-EFGH', 1000);
    expect(r.down({ code: 'NumpadEnter', key: 'Enter', at: 1100 })).toBe('PV:ABCD-EFGH');
  });

  it('a scanner sending no suffix: a pause ends the code', () => {
    const r = new ScanKeyReader();
    keys(r, '96385074', 0);
    expect(r.idle(50)).toBeNull();
    expect(r.idle(28 + IDLE_END_MS)).toBe('96385074');
    const b = new KeyBurst();
    b.onChar('x', 0);
    expect(b.onIdle(1000)).toBeNull();
    for (const [i, c] of [...'777'].entries()) b.onChar(c, 2000 + i);
    expect(b.onChar('9', 3000)).toBe('777');
  });

  it('US key positions, Shift, Caps Lock and GS1’s Ctrl+]', () => {
    expect(usKeyChar('KeyA', false)).toBe('a');
    expect(usKeyChar('KeyA', true)).toBe('A');
    expect(usKeyChar('KeyA', false, true)).toBe('A');
    expect(usKeyChar('Digit1', true)).toBe('!');
    expect(usKeyChar('Digit0', false)).toBe('0');
    expect(usKeyChar('Numpad7', false)).toBe('7');
    expect(usKeyChar('BracketRight', false)).toBe(']');
    expect(usKeyChar('Semicolon', true)).toBe(':');
    expect(usKeyChar('BracketRight', false, false, true)).toBe('\u001d');
    expect(usKeyChar('KeyA', false, false, false, true)).toBeNull();
    expect(usKeyChar('ShiftLeft', true)).toBeNull();
    expect(keyLeftAlone({ code: 'F12', meta: false })).toBe(true);
    expect(keyLeftAlone({ code: 'KeyA', meta: true })).toBe(true);
    expect(keyLeftAlone({ code: 'Enter', meta: false })).toBe(false);
  });
});

describe('the notes’ words are the kiosk’s texts', () => {
  it('scanNotFound and scanVoucherAtTill are texts the dashboard edits, with Hebrew defaults', () => {
    const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    const he = JSON.parse(readFileSync(path.join(here, '..', '..', 'client', 'src', 'messages', 'he.json'), 'utf8')) as {
      kiosks: { builtin: Record<string, string>; fields: { texts: Record<string, string> } };
    };
    for (const key of ['scanNotFound', 'scanVoucherAtTill']) {
      expect((TEXT_KEYS as readonly string[]).includes(key)).toBe(true);
      expect(he.kiosks.fields.texts[key]).toBeTruthy();
    }
    expect(he.kiosks.builtin.scanNotFound).toBe('המוצר לא נמצא');
    expect(he.kiosks.builtin.scanVoucherAtTill).toBe('יש להציג את השובר בקופה');
  });
});
