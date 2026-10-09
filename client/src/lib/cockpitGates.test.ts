import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { UNRESTRICTED, type DashboardAccess } from './dashboardAccess';
import { MACHINE_ADMIN_ROLES, OPEN_GATE, allowedEntries, gateAllows, sortAttention } from './cockpitGates';

/** "מנהל סניף / אירוע" as the server's template gives it. */
const BRANCH_MANAGER: DashboardAccess = {
  restricted: true,
  sections: {
    cockpit: 'view', reports: 'view', z: 'view', live_event: 'view', alerts: 'view', prepaid_vouchers: 'view',
    promotions: 'view', quick_actions: 'edit', item_blocks: 'edit', device_control: 'edit', till_messages: 'edit',
    kiosks: 'edit', stock: 'edit',
  },
};
const REPORTS_ONLY: DashboardAccess = { restricted: true, sections: { reports: 'view' } };

const quickPromo = { id: 'quickPromo', gate: { sections: ['quick_actions' as const], level: 'edit' as const } };
const blockItem = { id: 'blockItem', gate: { sections: ['item_blocks' as const], level: 'edit' as const } };
const tillMessage = {
  id: 'tillMessage',
  gate: { sections: ['till_messages' as const, 'quick_actions' as const], level: 'edit' as const, roles: MACHINE_ADMIN_ROLES },
};
const stockUpdate = { id: 'stockUpdate', gate: { sections: ['stock' as const], level: 'edit' as const, weekdays: [6] } };
const ACTIONS = [quickPromo, blockItem, tillMessage, stockUpdate];

describe('the cockpit hides what a user cannot use', () => {
  const thursday = new Date(2026, 9, 8, 12);
  const saturday = new Date(2026, 9, 10, 12);

  it('a branch manager gets the manager actions', () => {
    const ids = allowedEntries(ACTIONS, BRANCH_MANAGER, 'shop_manager', thursday).map((a) => a.id);
    assert.deepEqual(ids, ['quickPromo', 'blockItem', 'tillMessage']);
  });

  it('a user with reports only gets none of them', () => {
    assert.deepEqual(allowedEntries(ACTIONS, REPORTS_ONLY, 'company_manager', thursday), []);
  });

  it('the role the server checks is checked too', () => {
    assert.equal(gateAllows(tillMessage.gate, BRANCH_MANAGER, 'cashier', thursday), false);
    assert.equal(gateAllows(tillMessage.gate, UNRESTRICTED, 'shift_supervisor', thursday), false);
    assert.equal(gateAllows(tillMessage.gate, UNRESTRICTED, 'super_admin', thursday), true);
    assert.equal(gateAllows(tillMessage.gate, UNRESTRICTED, undefined, thursday), false);
  });

  it("Saturday's stock update only on Saturday", () => {
    assert.equal(gateAllows(stockUpdate.gate, BRANCH_MANAGER, 'shop_manager', thursday), false);
    assert.equal(gateAllows(stockUpdate.gate, BRANCH_MANAGER, 'shop_manager', saturday), true);
  });

  it('an open gate is everyone signed in; edit is not view', () => {
    assert.equal(gateAllows(OPEN_GATE, REPORTS_ONLY, 'cashier'), true);
    const viewOnly: DashboardAccess = { restricted: true, sections: { item_blocks: 'view' } };
    assert.equal(gateAllows(blockItem.gate, viewOnly, 'shop_manager'), false);
    assert.equal(gateAllows({ sections: ['item_blocks'], level: 'view' }, viewOnly, 'shop_manager'), true);
  });
});

describe('the attention feed', () => {
  it('the loudest first, then the newest', () => {
    const items = sortAttention([
      { id: 'a', severity: 'info' as const, at: '2026-10-08T10:00:00Z' },
      { id: 'b', severity: 'critical' as const, at: '2026-10-08T09:00:00Z' },
      { id: 'c', severity: 'warning' as const, at: '2026-10-08T11:00:00Z' },
      { id: 'd', severity: 'critical' as const, at: '2026-10-08T12:00:00Z' },
      { id: 'e', severity: 'warning' as const },
    ]);
    assert.deepEqual(items.map((i) => i.id), ['d', 'b', 'c', 'e', 'a']);
  });
});
