import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  changedCells,
  countStates,
  describeStateChanges,
  draftFromRoles,
  groupPermissions,
  matrixPayload,
  nextState,
  onlyDeviceLabel,
  overridesDraft,
  overridesPayload,
  parseLimit,
  roleChanged,
  setCell,
  setLimit,
  templateKeyOf,
  visibleRoles,
  type PermissionCatalogue,
  type TillRole,
} from './tillRoles';

const catalogue: PermissionCatalogue = {
  states: [
    { key: 'allow', label: 'מותר' },
    { key: 'approval', label: 'דורש אישור מנהל' },
    { key: 'deny', label: 'אסור' },
  ],
  devices: [],
  groups: [
    { key: 'sale', label: 'מכירה' },
    { key: 'drawer', label: 'מגירה' },
    { key: 'empty', label: 'ריק' },
  ],
  permissions: [
    { code: 'SELL', label: 'מכירה', group: 'sale', description: '', devices: [], scope: null, limits: [] },
    {
      code: 'CASH_DRAWER.CASH_OUT', label: 'הוצאת מזומן', group: 'drawer', description: '', devices: [], scope: null,
      limits: [{ key: 'maxAmount', label: 'עד', unit: 'amount', min: 0, max: 1000000 }],
    },
    { code: 'REFUND', label: 'זיכוי', group: 'sale', description: '', devices: [], scope: 'refund', limits: [] },
  ],
  builtinRoles: [
    {
      key: 'cashier', name: 'קופאי', description: '', legacy: false,
      permissions: { SELL: 'allow', 'CASH_DRAWER.CASH_OUT': 'approval', REFUND: 'approval' }, limits: {},
    },
    {
      key: 'supervisor', name: 'אחמ״ש', description: '', legacy: false,
      permissions: { SELL: 'allow', 'CASH_DRAWER.CASH_OUT': 'allow', REFUND: 'allow' },
      limits: { 'CASH_DRAWER.CASH_OUT': { maxAmount: 200 } },
    },
  ],
  specRoleKeys: ['cashier', 'supervisor'],
};

function role(over: Partial<TillRole>): TillRole {
  return {
    id: 'r1', companyId: 'c', builtinKey: 'cashier', baseKey: null, builtin: true, legacy: false, name: 'קופאי',
    description: null, sortOrder: 20, own: { permissions: {}, limits: {} },
    permissions: { SELL: 'allow', 'CASH_DRAWER.CASH_OUT': 'approval', REFUND: 'approval' }, limits: {},
    legacyRole: 'cashier', users: 0, updatedAt: null, ...over,
  };
}

test('a cell cycles allow → approval → deny → allow', () => {
  assert.equal(nextState('allow'), 'approval');
  assert.equal(nextState('approval'), 'deny');
  assert.equal(nextState('deny'), 'allow');
});

test('permissions are grouped in catalogue order and empty groups are dropped', () => {
  const groups = groupPermissions(catalogue);
  assert.deepEqual(groups.map((g) => g.key), ['sale', 'drawer']);
  assert.deepEqual(groups[0].permissions.map((p) => p.code), ['SELL', 'REFUND']);
});

test('a permission for one kind of device only says which ("Windows" for DESKTOP_EXIT)', () => {
  const devices = [
    { key: 'till', label: 'קופה' },
    { key: 'tablet', label: 'טאבלט' },
    { key: 'mobile', label: 'קופה ניידת' },
    { key: 'windows', label: 'Windows' },
  ];
  assert.equal(onlyDeviceLabel({ devices: ['windows'] }, { devices }), 'Windows');
  assert.equal(onlyDeviceLabel({ devices: ['till', 'tablet'] }, { devices }), null);
  assert.equal(onlyDeviceLabel({ devices: [] }, { devices }), null);
  assert.equal(onlyDeviceLabel({ devices: ['toaster'] }, { devices }), null);
});

test('the template of a custom role is the built-in it came from, else the cashier', () => {
  assert.equal(templateKeyOf({ builtinKey: null, baseKey: 'supervisor' }, catalogue), 'supervisor');
  assert.equal(templateKeyOf({ builtinKey: null, baseKey: null }, catalogue), 'cashier');
  assert.equal(templateKeyOf({ builtinKey: 'cashier', baseKey: 'supervisor' }, catalogue), 'cashier');
});

test('an untouched draft changes nothing and sends nothing', () => {
  const roles = [role({})];
  const draft = draftFromRoles(roles);
  assert.equal(changedCells(roles, draft), 0);
  assert.equal(roleChanged(roles[0], draft), false);
  assert.deepEqual(matrixPayload(roles, draft, catalogue), []);
});

test('a save sends only what differs from the template', () => {
  const roles = [role({})];
  let draft = draftFromRoles(roles);
  draft = setCell(draft, 'r1', 'REFUND', 'allow');
  assert.equal(changedCells(roles, draft), 1);
  assert.deepEqual(matrixPayload(roles, draft, catalogue), [{ id: 'r1', permissions: { REFUND: 'allow' }, limits: {} }]);
  // Back to the template's value: the role's own map is empty again.
  draft = setCell(draft, 'r1', 'REFUND', 'approval');
  assert.equal(changedCells(roles, draft), 0);
});

test('a role that set a value equal to its template drops it on the next save', () => {
  const roles = [role({ own: { permissions: { SELL: 'allow' }, limits: {} } })];
  let draft = draftFromRoles(roles);
  draft = setCell(draft, 'r1', 'REFUND', 'deny');
  assert.deepEqual(matrixPayload(roles, draft, catalogue)[0].permissions, { REFUND: 'deny' });
});

test('limits: a changed amount is sent, the template amount is not, "no limit" against a template becomes the max', () => {
  const sup = role({
    id: 'r2', builtinKey: 'supervisor', name: 'אחמ״ש',
    permissions: { SELL: 'allow', 'CASH_DRAWER.CASH_OUT': 'allow', REFUND: 'allow' },
    limits: { 'CASH_DRAWER.CASH_OUT': { maxAmount: 200 } },
  });
  let draft = draftFromRoles([sup]);
  assert.deepEqual(matrixPayload([sup], draft, catalogue), []);
  draft = setLimit(draft, 'r2', 'CASH_DRAWER.CASH_OUT', 'maxAmount', 350);
  assert.deepEqual(matrixPayload([sup], draft, catalogue)[0].limits, { 'CASH_DRAWER.CASH_OUT': { maxAmount: 350 } });
  draft = setLimit(draft, 'r2', 'CASH_DRAWER.CASH_OUT', 'maxAmount', null);
  assert.deepEqual(matrixPayload([sup], draft, catalogue)[0].limits, { 'CASH_DRAWER.CASH_OUT': { maxAmount: 1000000 } });
});

test('limit boxes: blank is no limit, out of range or text is invalid', () => {
  const lim = { min: 0, max: 100 };
  assert.equal(parseLimit('', lim), null);
  assert.equal(parseLimit(' 12,5 ', lim), 12.5);
  assert.equal(parseLimit('101', lim), undefined);
  assert.equal(parseLimit('abc', lim), undefined);
});

test('counts per state and the legacy columns', () => {
  assert.deepEqual(countStates({ a: 'allow', b: 'deny', c: 'allow' }), { allow: 2, approval: 0, deny: 1 });
  const roles = [
    role({ id: 'l', legacy: true, users: 0, sortOrder: 90, name: 'ישן' }),
    role({ id: 'm', legacy: true, users: 3, sortOrder: 91, name: 'ישן מנהל' }),
    role({ id: 'w', sortOrder: 10, name: 'מלצר' }),
  ];
  assert.deepEqual(visibleRoles(roles, false).map((r) => r.id), ['w', 'm']);
  assert.deepEqual(visibleRoles(roles, true).map((r) => r.id), ['w', 'l', 'm']);
});

test('user overrides: blank means "as the role"', () => {
  const draft = overridesDraft({ overrides: { states: { REFUND: 'allow', BAD: 'x' as never } } });
  assert.deepEqual(draft, { REFUND: 'allow' });
  assert.deepEqual(overridesPayload({ REFUND: 'allow', SELL: '' }), { states: { REFUND: 'allow' } });
  assert.equal(overridesPayload({ SELL: '' }), null);
});

test('audit lines name the permission and both states', () => {
  const lines = describeStateChanges(
    { permissions: { REFUND: 'approval' } },
    { permissions: { REFUND: 'allow', SELL: 'deny' } },
    { REFUND: 'זיכוי', SELL: 'מכירה' },
    (s) => ({ allow: 'מותר', approval: 'אישור', deny: 'אסור' })[s],
  );
  assert.deepEqual(lines, ['זיכוי: אישור → מותר', 'מכירה: — → אסור']);
});
