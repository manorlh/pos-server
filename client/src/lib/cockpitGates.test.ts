import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { UNRESTRICTED, type DashboardAccess } from './dashboardAccess';
import { LIVE_CONTROL_GATES, MACHINE_ADMIN_ROLES, OPEN_GATE, TILL_MESSAGE_GATES, allowedEntries, gateAllows, pickVariant, remoteControlTabs, sortAttention } from './cockpitGates';

/** "מנהל סניף / אירוע" as the server's template gives it. */
const BRANCH_MANAGER: DashboardAccess = {
  restricted: true,
  sections: {
    cockpit: 'view', reports: 'view', z: 'view', live_event: 'view', alerts: 'edit', prepaid_vouchers: 'view',
    promotions: 'view', quick_actions: 'edit', item_blocks: 'edit', device_control: 'edit', till_messages: 'edit',
    kiosks: 'view', stock: 'edit',
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

describe('"הודעה לקופות": one button, the sheet by what the user holds', () => {
  // The registry's own gates (components/dashboard/cockpit/registry.ts), in its order.
  const VARIANTS = [
    { sheet: 'full', gate: TILL_MESSAGE_GATES.full },
    { sheet: 'banner', gate: TILL_MESSAGE_GATES.banner },
  ];
  const access = (sections: DashboardAccess['sections']): DashboardAccess => ({ restricted: true, sections });
  const pick = (a: DashboardAccess, role: string | null = 'shop_manager') => pickVariant(VARIANTS, a, role)?.sheet;

  it('till messages at edit: the full sheet (full screen allowed)', () => {
    assert.equal(pick(access({ till_messages: 'edit' })), 'full');
    assert.equal(pick(access({ till_messages: 'edit', quick_actions: 'edit' })), 'full');
    assert.equal(pick(BRANCH_MANAGER), 'full');
  });

  it('only the quick actions at edit: the banner sheet', () => {
    assert.equal(pick(access({ quick_actions: 'edit' })), 'banner');
    // Viewing the till messages opens nothing on POST /till-messages: still the banner.
    assert.equal(pick(access({ quick_actions: 'edit', till_messages: 'view' })), 'banner');
  });

  it('neither at edit, or a role the routes refuse: no sheet', () => {
    assert.equal(pick(access({ quick_actions: 'view', till_messages: 'view' })), undefined);
    assert.equal(pick(REPORTS_ONLY), undefined);
    assert.equal(pick(access({ till_messages: 'edit', quick_actions: 'edit' }), 'shift_supervisor'), undefined);
    assert.equal(pick(access({ quick_actions: 'edit' }), null), undefined); // signed out / no role
  });

  it('an unrestricted machine admin gets the full sheet', () => {
    assert.equal(pick(UNRESTRICTED, 'company_manager'), 'full');
  });

  it('the button shows exactly when one of its sheets does', () => {
    const cases: [DashboardAccess, string | undefined][] = [
      [access({ till_messages: 'edit' }), 'shop_manager'],
      [access({ quick_actions: 'edit' }), 'shop_manager'],
      [access({ quick_actions: 'edit', till_messages: 'view' }), 'company_manager'],
      [access({ quick_actions: 'view' }), 'shop_manager'],
      [REPORTS_ONLY, 'company_manager'],
      [BRANCH_MANAGER, 'shift_supervisor'],
      [UNRESTRICTED, 'cashier'],
      [UNRESTRICTED, 'distributor'],
    ];
    for (const [a, role] of cases) {
      assert.equal(gateAllows(TILL_MESSAGE_GATES.button, a, role), pickVariant(VARIANTS, a, role) !== undefined, JSON.stringify([a, role]));
    }
  });
});

describe('"שליטה חיה": what each grant may read and do (the server\'s rules)', () => {
  const access = (sections: DashboardAccess['sections']): DashboardAccess => ({ restricted: true, sections });

  it('the remote control sheet: tills with device_control, kiosks with kiosks or device_control', () => {
    assert.deepEqual(remoteControlTabs(access({ device_control: 'edit' }), 'shop_manager'), ['tills', 'kiosks']);
    assert.deepEqual(remoteControlTabs(access({ kiosks: 'edit' }), 'shop_manager'), ['kiosks']);
    assert.deepEqual(remoteControlTabs(access({ device_control: 'view', kiosks: 'view' }), 'shop_manager'), []);
    assert.deepEqual(remoteControlTabs(BRANCH_MANAGER, 'shop_manager'), ['tills', 'kiosks']);
    assert.deepEqual(remoteControlTabs(access({ device_control: 'edit' }), 'shift_supervisor'), [], 'the routes check the role too');
  });

  it('the button shows exactly when one of the halves does', () => {
    const cases: [DashboardAccess, string][] = [
      [access({ device_control: 'edit' }), 'shop_manager'],
      [access({ kiosks: 'edit' }), 'company_manager'],
      [access({ kiosks: 'view' }), 'shop_manager'],
      [REPORTS_ONLY, 'company_manager'],
      [BRANCH_MANAGER, 'cashier'],
      [UNRESTRICTED, 'distributor'],
    ];
    for (const [a, role] of cases) {
      assert.equal(gateAllows(LIVE_CONTROL_GATES.remoteButton, a, role), remoteControlTabs(a, role).length > 0, JSON.stringify([a, role]));
    }
  });

  it('blocks and stock: read at view, act at edit', () => {
    const viewer = access({ item_blocks: 'view', stock: 'view' });
    assert.equal(gateAllows(LIVE_CONTROL_GATES.blocksRead, viewer, 'shop_manager'), true);
    assert.equal(gateAllows(LIVE_CONTROL_GATES.blocksEdit, viewer, 'shop_manager'), false);
    assert.equal(gateAllows(LIVE_CONTROL_GATES.stockEdit, viewer, 'shop_manager'), false);
    assert.equal(gateAllows(LIVE_CONTROL_GATES.blocksEdit, BRANCH_MANAGER, 'shop_manager'), true);
    assert.equal(gateAllows(LIVE_CONTROL_GATES.stockEdit, BRANCH_MANAGER, 'shop_manager'), true);
  });
});
