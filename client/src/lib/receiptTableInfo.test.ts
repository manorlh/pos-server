/**
 * Run with `npm test`. "מספר שולחן על החשבונית" — the till design's `receiptTableInfo` field and its
 * preview (lib/receiptTableInfo.ts) against the fixture the server and the till are tested against
 * (server/tests/fixtures/receipt_table_line_cases.json; P:/specs/receipt-table-number.md): the preview
 * shows the line the till prints.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  RECEIPT_TABLE_FIELDS,
  SAMPLE_RECEIPT_TABLE,
  formatReceiptTableInfo,
  parseReceiptTableInfo,
  receiptTableLine,
  toggleReceiptTableInfo,
  type ReceiptTableFacts,
} from './receiptTableInfo';

interface Cases {
  parse: { value: string | null; fields: string[] }[];
  combinations: { fields: string[]; facts: ReceiptTableFacts | null; line: string | null }[];
  lines: { name: string; fields: string[]; facts: ReceiptTableFacts | null; line: string | null }[];
}

const cases: Cases = JSON.parse(
  readFileSync(join(process.cwd(), '..', 'server', 'tests', 'fixtures', 'receipt_table_line_cases.json'), 'utf8'),
);

describe('receiptTableInfo', () => {
  it('reads the value as the till does', () => {
    for (const c of cases.parse) assert.deepEqual(parseReceiptTableInfo(c.value), c.fields, String(c.value));
    assert.deepEqual(parseReceiptTableInfo(undefined), []);
  });

  it('prints the line of every combination, none for the empty list', () => {
    assert.equal(cases.combinations.length, 16);
    for (const c of cases.combinations) assert.equal(receiptTableLine(c.fields, c.facts), c.line, c.fields.join(','));
  });

  it('the named cases: a named or restored table, one guest, a quick sale', () => {
    for (const c of cases.lines) assert.equal(receiptTableLine(c.fields, c.facts), c.line, c.name);
  });

  it('the chips toggle the stored list in the line order, none when empty', () => {
    assert.equal(toggleReceiptTableInfo(undefined, 'waiter'), 'waiter');
    assert.equal(toggleReceiptTableInfo('waiter', 'table'), 'table,waiter');
    assert.equal(toggleReceiptTableInfo('table', 'table'), 'none');
    assert.equal(formatReceiptTableInfo(['guests', 'zone', 'guests']), 'zone,guests');
    assert.equal(formatReceiptTableInfo([]), 'none');
  });

  it('the preview shows the spec example with every field on', () => {
    assert.equal(receiptTableLine(RECEIPT_TABLE_FIELDS, SAMPLE_RECEIPT_TABLE), 'שולחן 12 · גן · 4 סועדים · מלצר: דנה');
  });
});
