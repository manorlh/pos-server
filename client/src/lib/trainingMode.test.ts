/**
 * Run with `npm test`. The training-mode rules the dashboard applies (lib/trainingMode.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  apiErrorInfo,
  canPassChecks,
  confirmNameMatches,
  deletionEntries,
  deletionTotal,
  entityCountEntries,
  hasQuarantinedData,
  pendingOf,
  splitBlockers,
  tableLabel,
  templateCountsAsEntities,
  withoutTrainingFields,
} from './trainingMode';
import type { TrainingBlocker, UnsyncedTillBlocker } from './trainingMode';

const unsynced = (over: Partial<UnsyncedTillBlocker> = {}): UnsyncedTillBlocker => ({
  code: 'unsynced_till',
  machineId: 'm1',
  name: 'קופה 1',
  posNumber: 1,
  pendingDocuments: 3,
  pendingCount: null,
  asOf: null,
  ...over,
});

describe('confirmNameMatches', () => {
  it('matches the name exactly, ignoring spaces around either side', () => {
    assert.equal(confirmNameMatches('  מסעדת הים ', 'מסעדת הים'), true);
    assert.equal(confirmNameMatches('מסעדת הים', ' מסעדת הים  '), true);
  });
  it('refuses a different or partial name', () => {
    assert.equal(confirmNameMatches('מסעדת', 'מסעדת הים'), false);
    assert.equal(confirmNameMatches('מסעדת  הים', 'מסעדת הים'), false);
  });
  it('never matches an empty shop name', () => {
    assert.equal(confirmNameMatches('', ''), false);
    assert.equal(confirmNameMatches('  ', ' '), false);
  });
});

describe('blockers', () => {
  const tables: TrainingBlocker = { code: 'open_tables', count: 2, tables: [{ number: 4, name: null }, { number: null, name: 'בר' }] };

  it('splits unsynced tills from open tables', () => {
    const out = splitBlockers([unsynced(), tables, unsynced({ machineId: 'm2' })]);
    assert.deepEqual(out.unsyncedTills.map((b) => b.machineId), ['m1', 'm2']);
    assert.equal(out.openTables?.count, 2);
    assert.deepEqual(splitBlockers(null), { unsyncedTills: [], openTables: null });
  });

  it('passes the checks with no blockers, or with blockers once forced', () => {
    assert.equal(canPassChecks([], false), true);
    assert.equal(canPassChecks(undefined, false), true);
    assert.equal(canPassChecks([tables], false), false);
    assert.equal(canPassChecks([tables], true), true);
  });

  it('reads the pending documents, falling back to the queue count', () => {
    assert.equal(pendingOf(unsynced({ pendingDocuments: 5, pendingCount: 9 })), 5);
    assert.equal(pendingOf(unsynced({ pendingDocuments: null, pendingCount: 9 })), 9);
    assert.equal(pendingOf(unsynced({ pendingDocuments: null, pendingCount: null })), null);
  });

  it('names a table by its number, else its name', () => {
    assert.equal(tableLabel({ number: 0, name: 'x' }), '0');
    assert.equal(tableLabel({ number: null, name: ' בר ' }), 'בר');
    assert.equal(tableLabel({ number: null, name: '  ' }), null);
  });
});

describe('deletionEntries', () => {
  it('always lists sales, shifts, Z and X; the rest only when present', () => {
    assert.deepEqual(deletionEntries({ transactions: 12, shifts: 2, zReports: 1, xReports: 0, other: 0, tableOrders: 0 }), [
      ['transactions', 12],
      ['shifts', 2],
      ['zReports', 1],
      ['xReports', 0],
    ]);
    assert.deepEqual(deletionEntries({ transactions: 1, other: 3, tableOrders: 4 }).map(([k]) => k), [
      'transactions',
      'shifts',
      'zReports',
      'xReports',
      'other',
      'tableOrders',
    ]);
  });
  it('totals the lines', () => {
    assert.equal(deletionTotal({ transactions: 12, shifts: 2, zReports: 1, xReports: 3, other: 1, tableOrders: 2 }), 21);
    assert.equal(deletionTotal(null), 0);
  });
});

describe('hasQuarantinedData', () => {
  it('is true when any kind has documents', () => {
    assert.equal(hasQuarantinedData({ transaction: 0, shift: 0, z: 0, x: 0, other: 0 }), false);
    assert.equal(hasQuarantinedData({ transaction: 0, shift: 1, z: 0, x: 0, other: 0 }), true);
    assert.equal(hasQuarantinedData(undefined), false);
  });
});

describe('demo menu counts', () => {
  it('orders entity types and drops zeros', () => {
    assert.deepEqual(
      entityCountEntries({ prep_note: 4, product: 40, zzz: 1, category: 6, upsell: 0, modifier_group: 9 }),
      [
        ['category', 6],
        ['product', 40],
        ['modifier_group', 9],
        ['prep_note', 4],
        ['zzz', 1],
      ],
    );
    assert.deepEqual(entityCountEntries(null), []);
  });
  it('maps template counts onto entity types', () => {
    const out = templateCountsAsEntities({ categories: 6, products: 40, groups: 9, meals: 2, upsells: 3, notes: 4, courses: 3 });
    assert.deepEqual(out, { category: 6, product: 40, meal: 2, modifier_group: 9, upsell: 3, course: 3, prep_note: 4 });
  });
});

describe('apiErrorInfo', () => {
  it('reads a structured detail code', () => {
    const err = { response: { status: 409, data: { detail: { code: 'real_shift_open', tills: [] } } } };
    const info = apiErrorInfo(err);
    assert.equal(info.status, 409);
    assert.equal(info.code, 'real_shift_open');
    assert.deepEqual(info.detail?.tills, []);
  });
  it('reads a plain string detail as the code', () => {
    assert.equal(apiErrorInfo({ response: { status: 403, data: { detail: 'forbidden' } } }).code, 'forbidden');
  });
  it('copes with no response at all', () => {
    assert.deepEqual(apiErrorInfo(new Error('network')), { status: undefined, code: undefined, detail: undefined });
    assert.deepEqual(apiErrorInfo(null), { status: undefined, code: undefined, detail: undefined });
  });
});

describe('withoutTrainingFields', () => {
  it('drops the training fields and keeps the rest', () => {
    assert.deepEqual(withoutTrainingFields({ name: 'א', trainingMode: true, trainingStartedAt: null }), { name: 'א' });
  });
});
