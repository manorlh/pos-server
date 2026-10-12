/**
 * Run with `npm test`. "הלקוח זכאי לעוד פריט" (lib/voucherEntitlement.ts): the cloud's
 * `entitlement_left` / `entitlement_left_many`, replayed from the shared fixture
 * `server/tests/fixtures/prepaid_voucher_rules.json` (sections `entitlementLeft`, `entitlementLeftMany`;
 * its SHA-256 is pinned in kioskVouchers.test.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { entitlementLeft, entitlementLeftMany, type EntitlementLeft, type GroupLeft } from './voucherEntitlement';

interface VoucherIn {
  groups: { key: string; name: string; remainingAfterThisSale: number }[];
  totalRemainingAfterThisSale: number;
  splitAllowed: boolean;
}

function fixture(): {
  entitlementLeft: (VoucherIn & { name: string; expect: { entitlement: EntitlementLeft | null } })[];
  entitlementLeftMany: { name: string; vouchers: VoucherIn[]; expect: { entitlement: EntitlementLeft | null } }[];
} {
  const name = 'prepaid_voucher_rules.json';
  const candidates = [join(process.cwd(), '..', 'server', 'tests', 'fixtures', name), join(__dirname, '..', '..', 'server', 'tests', 'fixtures', name)];
  const found = candidates.find((p) => existsSync(p));
  assert.ok(found, `${name} not found`);
  return JSON.parse(readFileSync(found, 'utf8'));
}

const data = fixture();

const of = (v: VoucherIn): EntitlementLeft | null => {
  const groups: GroupLeft[] = v.groups.map((g) => ({ key: g.key, name: g.name, remaining: g.remainingAfterThisSale }));
  return entitlementLeft(groups, v.totalRemainingAfterThisSale, v.splitAllowed);
};

describe('entitlementLeft (the fixture)', () => {
  assert.ok(data.entitlementLeft.length >= 10);
  for (const c of data.entitlementLeft) {
    it(c.name, () => assert.deepEqual(of(c), c.expect.entitlement));
  }
});

describe('entitlementLeftMany (the fixture)', () => {
  assert.ok(data.entitlementLeftMany.length >= 5);
  for (const c of data.entitlementLeftMany) {
    it(c.name, () => assert.deepEqual(entitlementLeftMany(c.vouchers.map(of)), c.expect.entitlement));
  }
});

describe('by hand', () => {
  it('the owner\'s words: one voucher, then two', () => {
    const voucher = (food: number, drink: number) => entitlementLeft(
      [{ key: 'f', name: 'מזון', remaining: food }, { key: 'd', name: 'שתייה', remaining: drink }], food + drink, false);
    assert.equal(voucher(1, 0)?.tillText, 'הלקוח זכאי לעוד פריט מהשובר: מזון ×1 — הציעו לו');
    assert.equal(voucher(1, 0)?.kioskText, 'מגיע לך עוד פריט מהשובר: מזון ×1 — להוסיף?');
    assert.equal(voucher(1, 0)?.closeConfirm, 'סגירה עכשיו — מה שלא מומש מהשובר יאבד (מזון ×1)');
    assert.equal(entitlementLeftMany([voucher(1, 0), voucher(0, 1)])?.tillText, 'הלקוח זכאי לעוד 2 פריטים מהשוברים: מזון ×1 · שתייה ×1 — הציעו לו');
    assert.equal(entitlementLeftMany([null, voucher(0, 0)]), null);
  });
});
