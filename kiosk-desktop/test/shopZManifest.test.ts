/**
 * The local shop Z manifest — one computation on the Windows kiosk, the Android till and in the
 * cloud (pos-server docs/SPEC_INDEPENDENT_TILL.md §8.12). The golden fixtures are the shared ones
 * (pos-server server/tests/fixtures/ and pos-android app/src/test/resources/, the same bytes): every
 * case computed here must match `expected` exactly, and the file's SHA-256 is pinned — the same
 * constant as in pos-server tests/test_shop_z_manifest.py and pos-android ShopZManifestTest.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { agorotOfDecimal, documentOfJson, manifestDocumentOf, manifestOf, money } from '../src/main/fiscal/shopZManifest';
import type { DocDraft } from '../src/main/fiscal/ledger';
import { saleTotals } from '../src/core/sale';

const here = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const GOLDEN = path.join(here, 'fixtures', 'shop_z_manifest_golden.json');
const SERVER_COPY = path.join(here, '..', '..', 'server', 'tests', 'fixtures', 'shop_z_manifest_golden.json');
/** The file's SHA-256, its line endings read as LF — the same constant on the server and the till. */
const GOLDEN_SHA256 = 'b14e69e8181b2dfc9b3c19ae7a4b500d6accf2403526ffa3bd0f08b8f078a057';

const text = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const cases = (JSON.parse(text(GOLDEN)) as { cases: Array<{ name: string; documents: Array<Record<string, unknown>>; expected: unknown }> }).cases;

describe('the shared golden fixtures', () => {
  it('are the pinned ones', () => {
    expect(createHash('sha256').update(text(GOLDEN), 'utf8').digest('hex')).toBe(GOLDEN_SHA256);
  });

  it.runIf(existsSync(SERVER_COPY))('are the server’s bytes', () => {
    expect(text(SERVER_COPY)).toBe(text(GOLDEN));
  });

  it.each(cases.map((c) => [c.name.slice(0, 70), c] as const))('%s — to the agora', (_name, c) => {
    expect(manifestOf(c.documents.map(documentOfJson))).toEqual(c.expected);
  });

  it('the order the documents come in is not a difference; one agora is', () => {
    const docs = cases[2].documents.map(documentOfJson);
    const base = manifestOf(docs);
    expect(manifestOf([...docs].reverse())).toEqual(base);
    const changed = docs.map((d, i) => (i === 0 ? { ...d, total: d.total + 1 } : d));
    expect(manifestOf(changed).digest).not.toBe(base.digest);
  });
});

describe('money', () => {
  it('half away from zero, as the cloud’s Decimal ROUND_HALF_UP', () => {
    expect(['12.30', '0.005', '-0.005', '1.004', '-12.345', '7', '-0.50'].map(agorotOfDecimal)).toEqual([1230, 1, -1, 100, -1235, 700, -50]);
    expect([1230, -50, 0, 5].map(money)).toEqual(['12.30', '-0.50', '0.00', '0.05']);
  });
});

describe('a kiosk document as the cloud will hold it', () => {
  const doc = (status: DocDraft['status']): DocDraft => {
    const lines = [{ key: 'l1', productId: 'p', name: 'קפה', sku: null, basePriceAgorot: 1250, options: [], notes: [], qty: 2 }];
    return {
      id: 'C1A8F0E2-0000-4000-8000-000000000001',
      documentType: 320,
      number: 57,
      prefix: '4',
      status,
      createdAt: '',
      updatedAt: '',
      shiftId: 's',
      businessDate: '2026-10-06',
      cashierId: 'kiosk:m',
      cashierName: 'קיוסק',
      branchId: null,
      orderId: null,
      lines,
      itemIds: ['i1'],
      tracked: [],
      totals: saleTotals(lines, 0.18, 300),
      card: status === 'completed' ? { brand: 'visa', meta: {}, payments: null } as unknown as DocDraft['card'] : null,
      paymentId: 'p1',
      voidMeta: null,
    };
  };

  it('the bare number, the gross, the card leg for the goods and the tip apart', () => {
    const m = manifestOf([manifestDocumentOf(doc('completed')), manifestDocumentOf({ ...doc('cancelled'), id: 'x', number: 58 })]);
    expect(m.documentIds).toEqual(['c1a8f0e2-0000-4000-8000-000000000001']);
    expect(m.types).toEqual({ '320': { count: 1, first: '57', last: '57' } });
    expect(m.totals).toMatchObject({ gross: '25.00', card: '25.00', tips: '3.00', vat: '3.81', cash: '0.00', payments: { card: '25.00' } });
  });
});
