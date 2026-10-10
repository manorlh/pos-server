import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { REDEMPTION_FLAGS, flagTexts } from './prepaidRedemptionFlags';

type Messages = { prepaidVouchers: { kinds: { flag: Record<string, string> }; tills: Record<string, unknown>; report: Record<string, unknown> } };

const he = JSON.parse(readFileSync('src/messages/he.json', 'utf8')) as Messages;
const labels = he.prepaidVouchers.kinds.flag;

test('every flag the cloud records has a Hebrew label', () => {
  for (const flag of REDEMPTION_FLAGS) {
    assert.ok(labels[flag] && /[֐-׿]/.test(labels[flag]), `no Hebrew label for ${flag}`);
  }
});

test("the helper's new flags read as the operators say them", () => {
  assert.equal(labels.test_real, 'שובר בדיקה בקופה אמיתית');
  assert.equal(labels.paused, 'מומש בזמן השהיה');
  assert.equal(labels.over_quota, 'מעבר למכסה');
});

test('labels in order, each once; an unknown flag shows its code', () => {
  const label = (f: string) => labels[f];
  assert.deepEqual(flagTexts(['paused', 'over_quota', 'paused', 'brand_new'], label), [
    'מומש בזמן השהיה',
    'מעבר למכסה',
    'brand_new',
  ]);
  assert.deepEqual(flagTexts(null, label), []);
  assert.deepEqual(flagTexts(['', ' '], label), []);
});

test('the till report and the batch report say when test batches are out', () => {
  assert.match(String(he.prepaidVouchers.tills.testExcluded), /\{count\}/);
  assert.match(String(he.prepaidVouchers.report.testBatch), /בדיקה/);
});
