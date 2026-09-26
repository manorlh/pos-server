/**
 * Run with `npm test` (compiles this file and `tenantSwitch.ts` with tsc, then runs
 * node's own test runner; the client has no other test setup).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { tenantFallbackAfterForbidden, tenantSwitchTarget } from './tenantSwitch';

const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
const C = 'cccccccc-0000-0000-0000-000000000003';

describe('tenantSwitchTarget — what a switch does to the URL', () => {
  it('drops the old organization’s company, shop and machine', () => {
    assert.equal(
      tenantSwitchTarget('/dashboard/stock', 'company=c1&shop=s1&machine=m1'),
      '/dashboard/stock',
    );
  });

  it('keeps query params that are not tenant data', () => {
    assert.equal(
      tenantSwitchTarget('/dashboard/z-reports', 'from=2026-09-01&shop=s1&to=2026-09-30'),
      '/dashboard/z-reports?from=2026-09-01&to=2026-09-30',
    );
  });

  it('sends a drill-down page to the overview, since its path names an old entity', () => {
    assert.equal(tenantSwitchTarget('/dashboard/shops/s1', ''), '/dashboard');
    assert.equal(tenantSwitchTarget('/dashboard/companies/c1', 'shop=s1'), '/dashboard');
    assert.equal(tenantSwitchTarget('/dashboard/machines/m1', ''), '/dashboard');
  });

  it('leaves a URL with no scope alone', () => {
    assert.equal(tenantSwitchTarget('/dashboard', ''), null);
    assert.equal(tenantSwitchTarget('/dashboard/transactions', 'from=2026-09-01'), null);
    // The list pages are not drill-downs: only `/dashboard/shops/<id>` is.
    assert.equal(tenantSwitchTarget('/dashboard/shops', ''), null);
  });
});

describe('tenantFallbackAfterForbidden — when a 403 may change the tenant', () => {
  it('keeps the tenant just switched to when the 403 was about an id, not the tenant', () => {
    // The reported bug: switched A → B on a page still scoped to A's shop. The
    // server refused the shop, B is still the caller's, and the switch must stand.
    assert.equal(
      tenantFallbackAfterForbidden({ requestTenantId: B, activeTenantId: B, tenantIds: [A, B] }),
      null,
    );
  });

  it('ignores a late answer to a request sent under the previous tenant', () => {
    assert.equal(
      tenantFallbackAfterForbidden({ requestTenantId: A, activeTenantId: B, tenantIds: [B] }),
      null,
    );
  });

  it('falls back to the first listed tenant when the active one is no longer listed', () => {
    assert.equal(
      tenantFallbackAfterForbidden({ requestTenantId: C, activeTenantId: C, tenantIds: [A, B] }),
      A,
    );
  });

  it('has nothing to fall back to when no tenant is left', () => {
    assert.equal(
      tenantFallbackAfterForbidden({ requestTenantId: C, activeTenantId: C, tenantIds: [] }),
      null,
    );
  });
});
