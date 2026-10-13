/**
 * Run with `npm test`. "בעיות" — the problems screen's pure rules (lib/problems.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PROBLEM_GROUPS,
  badgeCount,
  badgeText,
  canSeeProblems,
  findFocus,
  isDayOnly,
  orderedGroups,
  placeOf,
  resolveRequest,
  sinceDate,
  toggleHidden,
  withHidden,
  withoutItem,
  type ProblemItem,
  type ProblemsResponse,
} from './problems';
import { UNRESTRICTED, type DashboardAccess } from './dashboardAccess';

function item(over: Partial<ProblemItem> = {}): ProblemItem {
  return {
    id: 'log:e1',
    kind: 'till_offline',
    severity: 'high',
    companyId: 'c1',
    shopId: 's1',
    shopName: 'מרכז',
    machineId: 'm1',
    machineName: 'קופה ראשית',
    posNumber: '3',
    since: '2026-10-13T08:00:00+00:00',
    title: 'קופה לא מחוברת',
    detail: null,
    link: '/dashboard/machines/m1',
    exceptionId: 'e1',
    code: 'abc123',
    resolvable: true,
    resolveVia: 'log',
    ...over,
  };
}

function answer(): ProblemsResponse {
  return {
    counts: { high: 2, medium: 1, low: 1 },
    total: 4,
    hiddenGroups: [],
    groups: [
      { key: 'devices', hidden: false, total: 2, counts: { high: 1, medium: 0, low: 1 }, items: [item(), item({ id: 'pending:m2', severity: 'low', exceptionId: null, resolvable: false, resolveVia: null })] },
      { key: 'z_shift', hidden: false, total: 1, counts: { high: 0, medium: 1, low: 0 }, items: [item({ id: 'awaitingz:m1', severity: 'medium', exceptionId: null, since: '2026-10-11', resolvable: false })] },
      { key: 'card', hidden: false, total: 1, counts: { high: 1, medium: 0, low: 0 }, items: [item({ id: 'log:e9', exceptionId: 'e9', kind: 'zcredit_recon' })] },
      { key: 'kitchen', hidden: false, total: 0, counts: { high: 0, medium: 0, low: 0 }, items: [] },
    ],
  };
}

const restricted = (sections: DashboardAccess['sections']): DashboardAccess => ({ restricted: true, sections });

describe('who may open the problems screen', () => {
  it('every dashboard role but the cashier (and a producer)', () => {
    for (const role of ['super_admin', 'distributor', 'company_manager', 'shop_manager', 'shift_supervisor']) {
      assert.equal(canSeeProblems(role, UNRESTRICTED), true, role);
    }
    assert.equal(canSeeProblems('cashier', UNRESTRICTED), false);
    assert.equal(canSeeProblems('producer_view', UNRESTRICTED), false);
    assert.equal(canSeeProblems(null, UNRESTRICTED), false);
  });

  it('with "דוחות" when the sections are narrowed', () => {
    assert.equal(canSeeProblems('company_manager', restricted({ reports: 'view' })), true);
    assert.equal(canSeeProblems('company_manager', restricted({ products: 'edit', alerts: 'edit' })), false);
  });
});

describe('the groups', () => {
  it('keep the fixed order, integrity last', () => {
    assert.deepEqual(PROBLEM_GROUPS, ['devices', 'z_shift', 'card', 'kitchen', 'integrity']);
    assert.deepEqual(orderedGroups(['kitchen', 'nope', 'devices', 'kitchen']), ['devices', 'kitchen']);
  });

  it('hide and show, and the counts leave the hidden ones out', () => {
    const hidden = toggleHidden([], 'devices');
    assert.deepEqual(hidden, ['devices']);
    const shown = withHidden(answer(), hidden);
    assert.deepEqual(shown.counts, { high: 1, medium: 1, low: 0 });
    assert.equal(shown.total, 2);
    assert.equal(shown.groups[0].hidden, true);
    assert.deepEqual(shown.hiddenGroups, ['devices']);
    // The items of a hidden group are still there (shown when the group is opened).
    assert.equal(shown.groups[0].items.length, 2);
    const back = withHidden(shown, toggleHidden(hidden, 'devices'));
    assert.deepEqual(back.counts, { high: 2, medium: 1, low: 1 });
    assert.deepEqual(back.hiddenGroups, []);
  });
});

describe('the badge', () => {
  it('is the open total, 99+ past 99', () => {
    assert.equal(badgeCount(answer()), 4);
    assert.equal(badgeCount(undefined), 0);
    assert.equal(badgeText(7), '7');
    assert.equal(badgeText(120), '99+');
  });
});

describe('a push alert opens its card', () => {
  it('by its log row or by the item id', () => {
    assert.deepEqual(findFocus(answer(), 'e9')?.group, 'card');
    assert.equal(findFocus(answer(), 'awaitingz:m1')?.item.kind, 'till_offline');
    assert.equal(findFocus(answer(), 'missing'), null);
    assert.equal(findFocus(answer(), null), null);
  });
});

describe('"טופל"', () => {
  it("goes through the log's route, or the alerts' when that is the user's", () => {
    assert.deepEqual(resolveRequest(item()), {
      method: 'patch',
      url: '/exception-log/e1',
      body: { acknowledged: true, note: null },
    });
    assert.deepEqual(resolveRequest(item({ resolveVia: 'alerts' }))?.url, '/push/alerts/e1/ack');
    assert.equal(resolveRequest(item({ resolvable: false })), null);
    assert.equal(resolveRequest(item({ exceptionId: null })), null);
  });

  it('takes the card away at once and recounts', () => {
    const after = withoutItem(answer(), 'log:e1');
    assert.equal(after.groups[0].items.length, 1);
    assert.equal(after.groups[0].total, 1);
    assert.deepEqual(after.counts, { high: 1, medium: 1, low: 1 });
    assert.equal(after.total, 3);
    const same = answer();
    assert.equal(withoutItem(same, 'nope'), same);
  });
});

describe('when and where', () => {
  it('reads a business day as that day', () => {
    const day = sinceDate('2026-10-11');
    assert.equal(day?.getFullYear(), 2026);
    assert.equal(day?.getMonth(), 9);
    assert.equal(day?.getDate(), 11);
    assert.equal(isDayOnly('2026-10-11'), true);
    assert.equal(isDayOnly('2026-10-11T08:00:00Z'), false);
    assert.equal(sinceDate(null), null);
    assert.equal(sinceDate('garbage'), null);
  });

  it('names the shop and the till', () => {
    const label = (n: string) => `קופה ${n}`;
    assert.equal(placeOf(item(), label), 'מרכז · קופה ראשית');
    assert.equal(placeOf(item({ machineName: null }), label), 'מרכז · קופה 3');
    assert.equal(placeOf(item({ machineName: null, posNumber: null, shopName: null }), label), '');
  });
});
