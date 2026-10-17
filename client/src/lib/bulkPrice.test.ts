import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bulkFormProblem,
  bulkPriceBody,
  formatShekel,
  isScheduled,
  localToIso,
  parseAmount,
  priceInput,
  productAreasPayload,
  scheduleAction,
  scheduleStatusLabel,
  toggleId,
  type BulkPriceForm,
} from './bulkPrice';

const FORM: BulkPriceForm = {
  productIds: ['p1'],
  categoryIds: [],
  op: 'add',
  value: '2',
  round: 'none',
  areaIds: null,
  overrideAreas: false,
  startsAt: '',
  endsAt: '',
  label: '',
};

const NOW = new Date('2026-10-17T10:00:00Z');

test('amounts: comma or dot, empty is none', () => {
  assert.equal(parseAmount('12,5'), 12.5);
  assert.equal(parseAmount(' 3 '), 3);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount('abc'), null);
});

test('the body: whole shop by default, the override only for the whole shop', () => {
  assert.deepEqual(bulkPriceBody({ ...FORM, overrideAreas: true }), {
    productIds: ['p1'], op: 'add', value: 2, round: 'none', areaIds: null, overrideAreas: true,
  });
  const areas = bulkPriceBody({ ...FORM, areaIds: ['a1'], overrideAreas: true, categoryIds: ['c1'], productIds: [] });
  assert.equal(areas.overrideAreas, false);
  assert.deepEqual(areas.areaIds, ['a1']);
  assert.deepEqual(areas.categoryIds, ['c1']);
  assert.equal(areas.productIds, undefined);
});

test('times travel as ISO with a zone', () => {
  const iso = localToIso('2026-10-20T08:00');
  assert.ok(iso && /Z$/.test(iso));
  assert.equal(localToIso(''), null);
  assert.equal(localToIso('not a date'), null);
  const body = bulkPriceBody({ ...FORM, startsAt: '2026-10-20T08:00', endsAt: '2026-10-21T08:00', label: ' שבוע ' });
  assert.equal(body.startsAt, iso);
  assert.ok(body.endsAt);
  assert.equal(body.label, 'שבוע');
});

test('problems with the form', () => {
  assert.equal(bulkFormProblem(FORM, NOW), null);
  assert.ok(bulkFormProblem({ ...FORM, productIds: [] }, NOW));
  assert.ok(bulkFormProblem({ ...FORM, value: '' }, NOW));
  assert.ok(bulkFormProblem({ ...FORM, op: 'set', value: '-1' }, NOW));
  assert.equal(bulkFormProblem({ ...FORM, op: 'add', value: '-1' }, NOW), null);
  assert.ok(bulkFormProblem({ ...FORM, areaIds: [] }, NOW));
  assert.ok(bulkFormProblem({ ...FORM, startsAt: '2026-10-21T08:00', endsAt: '2026-10-20T08:00' }, NOW));
});

test('"תזמן" only for a later start', () => {
  assert.equal(isScheduled({ startsAt: '' }, NOW), false);
  assert.equal(isScheduled({ startsAt: '2030-01-01T08:00' }, NOW), true);
  assert.equal(isScheduled({ startsAt: '2020-01-01T08:00' }, NOW), false);
});

test('schedules: labels and the one action each offers', () => {
  assert.equal(scheduleStatusLabel('pending'), 'ממתין');
  assert.equal(scheduleStatusLabel('reverted'), 'הוחזר');
  assert.equal(scheduleStatusLabel('weird'), 'weird');
  assert.equal(scheduleAction('pending', null), 'cancel');
  assert.equal(scheduleAction('applied', '2026-10-20T00:00:00Z'), 'revert');
  assert.equal(scheduleAction('applied', null), null);
  assert.equal(scheduleAction('cancelled', null), null);
});

test('a product\'s points of sale: all picked is null, none is an empty list', () => {
  assert.equal(productAreasPayload(['a', 'b'], ['b', 'a']), null);
  assert.deepEqual(productAreasPayload(['a', 'b'], ['b']), ['b']);
  assert.deepEqual(productAreasPayload(['a', 'b'], []), []);
  assert.deepEqual(productAreasPayload(['a', 'b'], ['x', 'a']), ['a']);
});

test('price inputs and money', () => {
  assert.equal(priceInput(''), null);
  assert.equal(priceInput('12.345'), 12.35);
  assert.equal(priceInput('-1'), undefined);
  assert.equal(formatShekel(3), '₪3.00');
  assert.equal(formatShekel(null), '—');
  assert.deepEqual(toggleId(['a'], 'b', true), ['a', 'b']);
  assert.deepEqual(toggleId(['a', 'b'], 'a', false), ['b']);
});
