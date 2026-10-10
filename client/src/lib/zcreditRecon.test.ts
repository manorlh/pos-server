import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATEGORY_SEVERITY,
  CSV_COLUMNS,
  DEFAULT_FILTER,
  HARD_CATEGORIES,
  RECON_CATEGORIES,
  attentionOf,
  cardTail,
  countByCategory,
  creditCandidates,
  csvFileName,
  defaultRunDay,
  filterItems,
  itemsCsvRows,
  maskedTerminal,
  reconHref,
  type ReconItem,
} from './zcreditRecon';

function item(over: Partial<ReconItem> = {}): ReconItem {
  return {
    id: 'i1',
    runId: 'r1',
    category: 'matched',
    categoryLabel: 'תואם',
    severity: 'ok',
    reason: 'תואם',
    zcredit: {
      reference: '998877665', amount: 10.35, statusCode: 2, statusLabel: 'מאושרת, הופקדה', dealType: '01', isRefund: false,
      depositId: null, cardLast4: '0000', cardName: 'מקס', payments: 1, approval: '00000000', savedAt: '2019-03-04T21:06:37',
      source: 'report',
    },
    ours: {
      transactionId: 't1', paymentId: 'p1', machineId: 'm1', machineName: 'קופה 1', shopId: 's1', documentNumber: '20001001',
      documentType: 320, amount: 10.35, status: 'completed', cardLast4: '0000', createdAt: '2019-03-04T18:06:30+00:00',
      transmitted: true, batch: '777',
    },
    related: [],
    handled: null,
    canCredit: false,
    ...over,
  };
}

describe('categories', () => {
  it('the server\'s seven, errors first, and the two hard ones are errors', () => {
    assert.equal(RECON_CATEGORIES.length, 7);
    assert.deepEqual(RECON_CATEGORIES.slice(0, 2), ['zcredit_only', 'ours_only']);
    assert.equal(RECON_CATEGORIES.at(-1), 'matched');
    for (const c of HARD_CATEGORIES) assert.equal(CATEGORY_SEVERITY[c], 'error');
    assert.equal(CATEGORY_SEVERITY.matched, 'ok');
    assert.ok(!DEFAULT_FILTER.categories.includes('matched'));
  });
});

describe('masking', () => {
  it('the terminal shows its last four digits only', () => {
    assert.equal(maskedTerminal('0101'), '••••0101');
    assert.equal(maskedTerminal('0990000101'), '••••0101');
    assert.equal(maskedTerminal(null), '••••');
  });
  it('a card shows its last four digits only', () => {
    assert.equal(cardTail('4580123412341234'), '1234');
    assert.equal(cardTail('************4580'), '4580');
    assert.equal(cardTail('12'), null);
  });
});

describe('filters', () => {
  const rows = [
    item({ id: 'a', category: 'zcredit_only', severity: 'error', ours: null, canCredit: true }),
    item({ id: 'b', category: 'ours_only', severity: 'error', zcredit: null, handled: { at: 'x', by: 'admin', note: 'n' } }),
    item({ id: 'c' }),
  ];
  it('by category, open only and a free search', () => {
    assert.deepEqual(filterItems(rows, DEFAULT_FILTER).map((r) => r.id), ['a', 'b']);
    assert.deepEqual(filterItems(rows, { ...DEFAULT_FILTER, openOnly: true }).map((r) => r.id), ['a']);
    assert.deepEqual(filterItems(rows, { categories: [], openOnly: false, search: '20001001' }).map((r) => r.id), ['b', 'c']);
    assert.deepEqual(filterItems(rows, { categories: [], openOnly: false, search: '9988' }).map((r) => r.id), ['a', 'c']);
  });
  it('counts per category', () => {
    const n = countByCategory(rows);
    assert.equal(n.zcredit_only, 1);
    assert.equal(n.matched, 1);
    assert.equal(n.duplicate, 0);
  });
});

describe('צור זיכוי', () => {
  it('only a Z-Credit charge with no document offers its candidate documents', () => {
    const orphan = item({
      category: 'zcredit_only', canCredit: true, ours: null,
      related: [
        { transactionId: 't9', documentNumber: '20001009', kind: 'unmatched_document' },
        { transactionId: 't1', documentNumber: '20001001', kind: 'documented_charge' },
        { zcReference: 'x', kind: 'unmatched_zcredit' },
      ],
    });
    assert.deepEqual(creditCandidates(orphan).map((r) => r.transactionId), ['t9', 't1']);
    assert.deepEqual(creditCandidates(item({ related: orphan.related })), []);
  });
});

describe('CSV', () => {
  it('one row per item, the terminal masked, cards cut, numbers as numbers', () => {
    const rows = itemsCsvRows(
      { terminalLast4: '0101', businessDate: '2026-09-27' },
      [item({ zcredit: { ...item().zcredit!, cardLast4: '4580123412341234' } })],
      { header: [], category: (c) => `cat:${c}`, yes: 'כן', no: 'לא' },
    );
    assert.equal(rows.length, 1);
    assert.equal(rows[0].length, CSV_COLUMNS.length);
    assert.equal(rows[0][0], 'cat:matched');
    assert.equal(rows[0][2], '••••0101');
    assert.equal(rows[0][6], 10.35);
    assert.equal(rows[0][10], '1234');
    assert.equal(rows[0][19], 'כן');
    assert.ok(!JSON.stringify(rows).includes('4580123412341234'));
    assert.equal(csvFileName({ terminalLast4: '0101', businessDate: '2026-09-27' }), 'zcredit-reconciliation-2026-09-27-0101.csv');
  });
});

describe('links and days', () => {
  it('the run day defaults to yesterday, across a month', () => {
    assert.equal(defaultRunDay('2026-10-01'), '2026-09-30');
    assert.equal(defaultRunDay('2026-10-09'), '2026-10-08');
  });
  it('the page link', () => {
    assert.equal(reconHref(), '/dashboard/zcredit-reconciliation');
    assert.equal(reconHref({ runId: 'r1' }), '/dashboard/zcredit-reconciliation?run=r1');
  });
});

describe('cockpit', () => {
  it('one item per terminal and day with open errors, and each unreadable run', () => {
    const items = attentionOf({
      open: 3,
      runs: [{ runId: 'r1', terminalKey: 'k', terminal: '••••0101', businessDate: '2026-09-27', finishedAt: 'x', zcreditOnly: 2, oursOnly: 1 }],
      failed: [{ runId: 'r2', terminal: '••••0202', businessDate: '2026-09-27', errorMessage: 'אין חיבור' }],
    });
    assert.equal(items.length, 2);
    assert.equal(items[0].severity, 'critical');
    assert.equal(items[0].href, '/dashboard/zcredit-reconciliation?run=r1');
    assert.ok(items[1].failed);
    assert.deepEqual(attentionOf(null), []);
  });
});
