import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TILL_ENTRIES, deniedPreview, effectiveDeniedUi, entryOutcome, legacyHides } from './deniedPreview';
import type { PermState } from './tillRoles';

// The spec's waiter (server till_permissions.DEFAULTS), the codes the preview reads.
const waiter: Record<string, PermState> = {
  SELL: 'allow', 'CALCULATOR.USE': 'deny', 'TABLES.USE': 'allow', REFUND: 'deny', DISCOUNT: 'approval', LINE_VOID: 'approval',
  OTH: 'approval', Z: 'deny', SHIFT_CLOSE: 'deny', 'CASH_DRAWER.CASH_OUT': 'deny', 'CASH_DRAWER.OPEN_MANUALLY': 'approval',
  'TABLES.ASSIGN': 'deny', SHIFT_OPEN: 'deny', CARD_UNRESOLVED: 'deny', REPRINT: 'deny',
};
const keys = (list: { key: string }[]) => list.map((e) => e.key);

test('every entry names a permission and its kind; the keys are unique', () => {
  assert.equal(new Set(TILL_ENTRIES.map((e) => e.key)).size, TILL_ENTRIES.length);
  for (const e of TILL_ENTRIES) {
    assert.ok(e.codes.length > 0 && e.label && e.where, e.key);
    assert.ok(['option', 'legacy', 'always', 'safety'].includes(e.kind), e.key);
  }
  // The never-hidden ones of spec §4.
  const safety = TILL_ENTRIES.filter((e) => e.kind === 'safety').flatMap((e) => e.codes).sort();
  assert.deepEqual(safety, ['ATTENDANCE_MANAGE', 'CARD_UNRESOLVED', 'SHIFT_OPEN', 'TRANSMIT']);
});

test('allowed and approval are never hidden, whatever the answer', () => {
  for (const mode of ['show', 'hide', 'code'] as const) {
    assert.equal(entryOutcome({ codes: ['SELL'], kind: 'legacy' }, waiter, mode, true), 'alone');
    assert.equal(entryOutcome({ codes: ['DISCOUNT'], kind: 'option' }, waiter, mode, true), 'approval');
    // An entry offered by either of two: the better one counts.
    assert.equal(entryOutcome({ codes: ['REFUND', 'CASH_DRAWER.OPEN_MANUALLY'], kind: 'option' }, waiter, mode, true), 'approval');
  }
});

test('hide: every denial left out but the safety ones; code: every denial on a code', () => {
  const hide = deniedPreview(waiter, 'hide', true);
  for (const k of ['refund', 'till_z', 'shift_close', 'cash_out', 'calculator', 'table_reprint', 'table_assign', 'waiter_assign']) {
    assert.ok(keys(hide.hidden).includes(k), k);
  }
  assert.ok(!keys(hide.hidden).includes('shift_open') && keys(hide.denied).includes('shift_open'));
  assert.ok(keys(hide.denied).includes('card_unresolved'));
  const code = deniedPreview(waiter, 'code', true);
  assert.deepEqual(code.hidden, []);
  assert.deepEqual(code.denied, []);
  assert.ok(keys(code.code).includes('refund') && keys(code.code).includes('shift_open'));
  // "דורש אישור מנהל" is on a code under every answer.
  assert.ok(keys(deniedPreview(waiter, 'show', true).code).includes('discount'));
});

test('show is today: the older parameter hides its entries, the always-hidden stay hidden, the rest explain', () => {
  const today = deniedPreview(waiter, 'show', true);
  assert.ok(keys(today.hidden).includes('calculator') && keys(today.hidden).includes('cash_out'));
  assert.ok(keys(today.hidden).includes('table_assign'));
  assert.ok(keys(today.denied).includes('refund') && keys(today.denied).includes('waiter_assign'));
  const disabled = deniedPreview(waiter, 'show', false);
  assert.ok(keys(disabled.denied).includes('calculator'));
  assert.ok(keys(disabled.hidden).includes('table_assign'), 'hidden whenever denied, as today');
});

test('the role over the level, the level over show; the older parameter hides by default', () => {
  assert.equal(effectiveDeniedUi('hide', 'code'), 'hide');
  assert.equal(effectiveDeniedUi(null, 'code'), 'code');
  assert.equal(effectiveDeniedUi(undefined, undefined), 'show');
  assert.equal(effectiveDeniedUi(null, 'later'), 'show');
  assert.equal(legacyHides(undefined), true);
  assert.equal(legacyHides('הסתר'), true);
  assert.equal(legacyHides('הצג מושבת עם הסבר'), false);
});

test('a code the role does not send reads as deny (never granted)', () => {
  assert.equal(entryOutcome({ codes: ['NEW_CODE'], kind: 'option' }, {}, 'hide', true), 'hidden');
});
