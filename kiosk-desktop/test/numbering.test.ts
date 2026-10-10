import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DocumentCounters, formatDocNumber, prefixFor, raised, seriesCounterSeed, seriesOf, type CounterStore } from '../src/core/documentNumbers';
import { saleTotals, type SaleLine } from '../src/core/sale';
import { openDb } from '../src/main/db/sqlite';
import { Kv, migrate } from '../src/main/db/schema';
import { Outbox } from '../src/main/sync/outbox';
import { Ledger } from '../src/main/fiscal/ledger';

describe('the printed number (SPEC_DOCUMENT_PREFIX §2)', () => {
  it('is the prefix and the number padded to 7 digits, no dash', () => {
    expect(formatDocNumber('2', '57')).toBe('20000057');
    expect(formatDocNumber('101', 57)).toBe('1010000057');
    expect(formatDocNumber('02', '57')).toBe('020000057');
    expect(formatDocNumber('2', '0057')).toBe('20000057');
  });

  it('above 9,999,999 is the only form with a dash (never an ambiguous pad)', () => {
    expect(formatDocNumber('2', '9999999')).toBe('29999999');
    expect(formatDocNumber('2', '12345678')).toBe('2-12345678');
    expect(formatDocNumber('21', '2345678')).not.toBe(formatDocNumber('2', '12345678'));
  });

  it('without a prefix is the bare number', () => {
    expect(formatDocNumber(null, '57')).toBe('57');
    expect(formatDocNumber('  ', '57')).toBe('57');
  });

  it('takes the cloud prefix, else the till number when it is 1–3 digits', () => {
    expect(prefixFor('12', '4')).toBe('12');
    expect(prefixFor(null, '4')).toBe('4');
    expect(prefixFor(null, '1234')).toBe(null);
    expect(prefixFor('x', '4')).toBe('4');
  });
});

describe('a series per document type (§3)', () => {
  it('320, 330 and 400, with −400 in 400', () => {
    expect(seriesOf(320)).toBe(320);
    expect(seriesOf(330)).toBe(330);
    expect(seriesOf(400)).toBe(400);
    expect(seriesOf(-400)).toBe(400);
  });

  it('a new counter starts after the old shared one or the ledger, whichever is higher', () => {
    expect(seriesCounterSeed(null, 57, 40, 30)).toBe(57);
    expect(seriesCounterSeed(null, 0, 40, 30)).toBe(40);
    expect(seriesCounterSeed(12, 57, 40, 30)).toBe(30);
    expect(seriesCounterSeed(80, 57, 40, 30)).toBe(80);
  });

  it('a counter only ever goes up', () => {
    expect(raised(10, 5)).toBe(10);
    expect(raised(10, 15)).toBe(15);
    expect(raised(10, null)).toBe(10);
  });
});

function memoryStore(): CounterStore & { writes: Array<[string, number]>; values: Map<string, number> } {
  const values = new Map<string, number>();
  const writes: Array<[string, number]> = [];
  return {
    values,
    writes,
    read: (k) => values.get(k) ?? null,
    write: (k, v) => {
      writes.push([k, v]);
      values.set(k, v);
    },
    ledgerMax: () => 0,
  };
}

describe('DocumentCounters', () => {
  it('saves the next number before handing it out, per series', () => {
    const store = memoryStore();
    const c = new DocumentCounters(store);
    c.prime();
    store.writes.length = 0;
    expect(c.next(320)).toBe(1);
    expect(store.writes).toEqual([['documentSequence.320', 1]]);
    expect(c.next(320)).toBe(2);
    expect(c.next(400)).toBe(1);
    expect(c.next(-400)).toBe(2);
    expect(c.report()).toEqual({ '320': 2, '330': 0, '400': 2 });
  });

  it('is raised by the cloud (highestTransactionNumbers) and never lowered', () => {
    const store = memoryStore();
    store.values.set('documentSequence.320', 90);
    const c = new DocumentCounters(store);
    c.prime();
    c.raise({ '320': 50, '330': 7 });
    expect(c.report()).toEqual({ '320': 90, '330': 7, '400': 0 });
    expect(c.next(330)).toBe(8);
  });

  it('an old cloud (one highest for all) raises every series', () => {
    const c = new DocumentCounters(memoryStore());
    c.prime();
    c.raise({}, 33);
    expect(c.report()).toEqual({ '320': 33, '330': 33, '400': 33 });
  });
});

function ledger() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'kd-num-'));
  const db = openDb(path.join(dir, 'k.db'));
  migrate(db);
  const kv = new Kv(db);
  const outbox = new Outbox(db);
  return { db, kv, outbox, ledger: new Ledger(db, kv, outbox) };
}

const line: SaleLine = { key: 'a', productId: '0b1c2d3e-0000-4000-8000-000000000001', name: 'המבורגר', sku: null, basePriceAgorot: 5400, options: [], notes: [], qty: 2 };

describe('the ledger', () => {
  it('numbers each pending sale in its series, saved before use, unique per (series, number)', () => {
    const { ledger: l, kv, db } = ledger();
    l.openShift({ id: 'kiosk:m', name: 'קיוסק' });
    const totals = saleTotals([line], 0.18);
    const a = l.openCardSale({ documentType: 320, prefix: '4', branchId: '2', operator: { id: 'kiosk:m', name: 'קיוסק' }, orderId: null, lines: [line], tracked: [], totals })!;
    const b = l.openCardSale({ documentType: 320, prefix: '4', branchId: '2', operator: { id: 'kiosk:m', name: 'קיוסק' }, orderId: null, lines: [line], tracked: [], totals })!;
    expect([a.number, b.number]).toEqual([1, 2]);
    expect(kv.getNumber('documentSequence.320')).toBe(2);
    expect(() => db.run("INSERT INTO documents (id, document_type, series, number, status, created_at, updated_at, total_agorot, payload) VALUES ('x', 320, 320, 2, 'pending', '', '', 0, '{}')")).toThrow();
  });

  it('a declined sale keeps its number (cancelled, uploaded); the retry is the next number', () => {
    const { ledger: l, outbox } = ledger();
    l.openShift({ id: 'kiosk:m', name: 'קיוסק' });
    const totals = saleTotals([line], 0.18);
    const first = l.openCardSale({ documentType: 320, prefix: '4', branchId: null, operator: { id: 'kiosk:m', name: 'קיוסק' }, orderId: null, lines: [line], tracked: [], totals })!;
    expect(outbox.count('transaction')).toBe(0); // never a pending document to the cloud
    l.voidCardSale(first.id, { outcome: 'declined' });
    expect(l.doc(first.id)!.status).toBe('cancelled');
    expect(outbox.count('transaction')).toBe(1);
    const retry = l.openCardSale({ documentType: 320, prefix: '4', branchId: null, operator: { id: 'kiosk:m', name: 'קיוסק' }, orderId: null, lines: [line], tracked: [], totals })!;
    expect(retry.number).toBe(first.number + 1);
    expect(retry.id).not.toBe(first.id);
  });

  it('a write that rolls back leaves a gap, never a repeat', () => {
    const { ledger: l, db } = ledger();
    l.openShift({ id: 'kiosk:m', name: 'קיוסק' });
    const totals = saleTotals([line], 0.18);
    try {
      db.tx(() => {
        l.openCardSale({ documentType: 320, prefix: null, branchId: null, operator: { id: 'k', name: 'k' }, orderId: null, lines: [line], tracked: [], totals });
        throw new Error('crash');
      });
    } catch {
      /* rolled back */
    }
    const next = l.openCardSale({ documentType: 320, prefix: null, branchId: null, operator: { id: 'k', name: 'k' }, orderId: null, lines: [line], tracked: [], totals })!;
    expect(next.number).toBe(2);
  });

  it('survives a restart: the counters come back from disk and never go down', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kd-num2-'));
    const file = path.join(dir, 'k.db');
    {
      const db = openDb(file);
      migrate(db);
      const l = new Ledger(db, new Kv(db), new Outbox(db));
      l.openShift({ id: 'k', name: 'k' });
      for (let i = 0; i < 3; i++) l.openCardSale({ documentType: 320, prefix: null, branchId: null, operator: { id: 'k', name: 'k' }, orderId: null, lines: [line], tracked: [], totals: saleTotals([line], 0.18) });
      // The documents are gone (a cloud reset deletes synced ones) — the counter is not.
      db.run('DELETE FROM documents');
      db.close();
    }
    const db = openDb(file);
    migrate(db);
    const l = new Ledger(db, new Kv(db), new Outbox(db));
    l.openShift({ id: 'k', name: 'k' });
    expect(l.openCardSale({ documentType: 320, prefix: null, branchId: null, operator: { id: 'k', name: 'k' }, orderId: null, lines: [line], tracked: [], totals: saleTotals([line], 0.18) })!.number).toBe(4);
  });

  it('shifts are numbered after the cloud’s last, saved before use', () => {
    const { ledger: l, kv } = ledger();
    l.raiseShiftSequence(41);
    const s = l.openShift({ id: 'kiosk:m', name: 'קיוסק' });
    expect(s.sequence_number).toBe(42);
    expect(kv.getNumber('shift.lastSequence')).toBe(42);
    expect(l.openShift({ id: 'kiosk:m', name: 'קיוסק' }).id).toBe(s.id); // the open one is returned
  });
});

describe('VAT once per document (prices include VAT)', () => {
  it('net = round(total / 1.18), vat = total − net', () => {
    const t = saleTotals([line], 0.18);
    expect(t.totalAgorot).toBe(10800);
    expect(t.netAgorot).toBe(9153);
    expect(t.vatAgorot).toBe(1647);
  });

  it('an exempt dealer: no VAT', () => {
    const t = saleTotals([line], 0);
    expect(t.netAgorot).toBe(10800);
    expect(t.vatAgorot).toBe(0);
  });
});
