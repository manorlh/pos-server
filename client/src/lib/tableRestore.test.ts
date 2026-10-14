/**
 * Run with `npm test`. "שחזור שולחן ותשלומים" — the tables page's editor helpers (lib/tableRestore.ts);
 * the server checks the same values (pos-server app/services/table_restore.py,
 * tests/test_table_restore_payments.py) and the till parses them.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  NO_METHODS,
  RESTORE_KEYS,
  changedValues,
  editError,
  formatMethods,
  formatWindow,
  groupParams,
  ownKeys,
  parseMethods,
  parseWindow,
  tableDisplay,
  textOf,
  toggleMethod,
  valueOf,
} from './tableRestore';

describe('restore window', () => {
  it('reads the four kinds', () => {
    assert.deepEqual(parseWindow('same_z'), { kind: 'same_z', hours: null });
    assert.deepEqual(parseWindow('same_shift'), { kind: 'same_shift', hours: null });
    assert.deepEqual(parseWindow('any'), { kind: 'any', hours: null });
    assert.deepEqual(parseWindow('hours:6'), { kind: 'hours', hours: 6 });
    // Unknown: the default.
    assert.deepEqual(parseWindow('week'), { kind: 'same_z', hours: null });
    assert.deepEqual(parseWindow(undefined), { kind: 'same_z', hours: null });
  });

  it('writes hours 1–720 only', () => {
    assert.equal(formatWindow('hours', 6), 'hours:6');
    assert.equal(formatWindow('hours', '720'), 'hours:720');
    assert.equal(formatWindow('hours', 0), null);
    assert.equal(formatWindow('hours', 721), null);
    assert.equal(formatWindow('hours', '1.5'), null);
    assert.equal(formatWindow('any', null), 'any');
  });
});

describe('methods', () => {
  it('in the catalogue order, unknown dropped', () => {
    assert.deepEqual(parseMethods('external, CARD,bitcoin'), ['card', 'external']);
    assert.equal(formatMethods(['voucher', 'cash']), 'cash,voucher');
    assert.equal(toggleMethod('cash,card,voucher,external', 'card'), 'cash,voucher,external');
    assert.equal(toggleMethod('cash', 'external'), 'cash,external');
  });

  it('an empty list is a value, not inherit', () => {
    assert.equal(textOf('reverseMethods', ''), NO_METHODS);
    assert.equal(valueOf('reverseMethods', 'string', NO_METHODS), '');
    assert.equal(valueOf('reverseMethods', 'string', ''), null);
    assert.equal(valueOf('reverseMethods', 'string', 'cash'), 'cash');
  });
});

describe('edits', () => {
  it('refuses what the server refuses', () => {
    assert.equal(editError('restoredTablePrefix', 'ש-'), null);
    assert.equal(editError('restoredTablePrefix', '   '), 'prefix');
    assert.equal(editError('restoredTablePrefix', 'x'.repeat(11)), 'prefix');
    assert.equal(editError('restoreWindow', 'hours:12'), null);
    assert.equal(editError('restoreWindow', 'hours:0'), 'window');
    assert.equal(editError('restoreWindow', ''), null);
  });

  it('sends only what changed, typed', () => {
    const own = { billShowPaidItems: true, restoreWindow: 'same_shift', reverseMethods: '' };
    const types = { billShowPaidItems: 'boolean', restoreWindow: 'string', reverseAllButton: 'boolean', reverseMethods: 'string' };
    assert.deepEqual(
      changedValues(
        own,
        { billShowPaidItems: 'true', restoreWindow: '', reverseAllButton: 'false', reverseMethods: NO_METHODS },
        types,
      ),
      { restoreWindow: null, reverseAllButton: false },
    );
    assert.deepEqual(ownKeys({ ...own, other: 1, printCreditNote: null }), ['restoreWindow', 'reverseMethods', 'billShowPaidItems']);
    assert.equal(RESTORE_KEYS.length, 8);
  });
});

describe('a table on the floor', () => {
  it('by its number and name, or a restored one by its label alone', () => {
    assert.deepEqual(tableDisplay({ number: 12, name: null }), { main: '12', sub: null, text: '12' });
    assert.deepEqual(tableDisplay({ number: 12, name: ' VIP ' }), { main: '12', sub: 'VIP', text: '12 · VIP' });
    assert.deepEqual(tableDisplay({ number: 9012, name: 'ש-12', labelOnly: true }), { main: 'ש-12', sub: null, text: 'ש-12' });
    // A label-only table whose name was cleared reads by its number.
    assert.deepEqual(tableDisplay({ number: 9012, name: '', labelOnly: true }), { main: '9012', sub: null, text: '9012' });
  });
});

describe('the card groups (owner-decisions-1410 §1: the staff tables first)', () => {
  const groups = [
    { key: 'staffTables', label: 'שולחן עובדים / מנהלים' },
    { key: 'restore', label: 'שחזור שולחן ותשלומים בשולחן' },
  ];

  it('puts each parameter under its group, in the groups order', () => {
    const params = [
      { key: 'restoreWindow', group: 'restore' },
      { key: 'staffTableDiscountCheck', group: 'staffTables' },
      { key: 'billTipBase', group: 'restore' },
    ];
    const out = groupParams(params, groups);
    assert.deepEqual(out.map((g) => g.group?.key), ['staffTables', 'restore']);
    assert.deepEqual(out[0].parameters.map((p) => p.key), ['staffTableDiscountCheck']);
    assert.deepEqual(out[1].parameters.map((p) => p.key), ['restoreWindow', 'billTipBase']);
  });

  it('an empty group is left out; an unknown one goes last, under no heading', () => {
    const out = groupParams([{ key: 'x', group: 'restore' }, { key: 'y', group: 'later' }, { key: 'z' }], groups);
    assert.deepEqual(out.map((g) => g.group?.key ?? null), ['restore', null]);
    assert.deepEqual(out[1].parameters.map((p) => p.key), ['y', 'z']);
  });

  it('an older server (no groups): one list, no heading', () => {
    const out = groupParams<{ key: string; group?: string | null }>([{ key: 'restoreWindow' }], undefined);
    assert.equal(out.length, 1);
    assert.equal(out[0].group, null);
    assert.deepEqual(groupParams([], undefined), []);
  });
});
