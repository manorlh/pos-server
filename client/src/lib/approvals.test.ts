/**
 * Run with `npm test`. "בקשות אישור מרחוק" — the pure rules (lib/approvals.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  APPROVAL_COLUMNS,
  EMPTY_HISTORY_FILTERS,
  EMPTY_OVERRIDE_DRAFT,
  activeFilterCount,
  apiErrorOf,
  approvalRowValues,
  approvedText,
  approverOptions,
  badgeText,
  clearOwnType,
  decideBody,
  decideFailure,
  draftFromPolicy,
  effectiveEnabled,
  effectiveValue,
  employeeHint,
  fieldError,
  fieldRange,
  formatCountdown,
  formatPercent,
  historyParams,
  inheritedSource,
  inheritedStyleSummary,
  isApprovalStyle,
  initialPartial,
  isOverridden,
  isPartial,
  limitKeyOf,
  moveItem,
  myCeiling,
  normalizeApprovers,
  normalizeCard,
  normalizeDetail,
  normalizeEmployees,
  normalizeList,
  overrideDraftErrors,
  overrideDraftOf,
  overrideFromDraft,
  overrideStart,
  ownStyle,
  ownStyleCount,
  overriddenCount,
  overridesBody,
  partialError,
  partialField,
  payloadDocument,
  payloadExtras,
  payloadLines,
  payloadTable,
  placeOf,
  policyBody,
  policyDirty,
  policyErrors,
  reasonsError,
  requestedText,
  resolveStyle,
  roleLabel,
  rolesForMaps,
  secondsLeft,
  sameEmployeeIds,
  setOwnField,
  setRoleLimit,
  setStyle,
  STYLE_ALL,
  styleCatalogOf,
  stylePermissionGroups,
  statusTone,
  toggleEmployee,
  typeLabels,
  typesByPhase,
  type CatalogField,
  type PolicyResponse,
} from './approvals';

const CARD = {
  id: 'a1',
  type: 'discount_basket',
  typeLabel: 'הנחה על החשבון',
  status: 'pending',
  shopId: 's1',
  shopName: 'מרכז',
  machineId: 'm1',
  machineName: 'קופה 2',
  areaName: 'בר',
  requesterName: 'דנה',
  requesterPosUserId: 'p1',
  amount: '120.50',
  percent: 30,
  reasonCode: 'taste',
  reasonText: 'מנה לא טעימה',
  note: 'לקוח קבוע',
  tableLabel: '12',
  createdAt: '2026-10-13T10:00:00Z',
  expiresAt: '2026-10-13T10:03:00Z',
  decidedAt: null,
  decidedByName: null,
  decidedByUserId: null,
  approvedAmount: null,
  approvedPercent: null,
  message: null,
  sentTo: [{ userId: 'u1', name: 'רון' }, { approverId: 'u2', name: 'דנה' }],
  canDecide: true,
};

describe('a request off the wire', () => {
  it('reads numbers, the recipients and an unknown status defensively', () => {
    const c = normalizeCard(CARD);
    assert.equal(c.amount, 120.5);
    assert.equal(c.percent, 30);
    assert.deepEqual(c.sentTo, [{ userId: 'u1', name: 'רון' }, { userId: 'u2', name: 'דנה' }]);
    assert.equal(c.canDecide, true);
    assert.equal(normalizeCard({ ...CARD, status: 'weird' }).status, 'expired');
    assert.equal(normalizeCard(null).id, '');
  });

  it('reads the detail: flags, unit, my ceiling, any payload', () => {
    const d = normalizeDetail({ ...CARD, allowPartial: true, limitUnit: 'percent', myLimit: { maxPercent: '20' }, payload: 'x' });
    assert.equal(d.allowPartial, true);
    assert.equal(d.quickApprove, false);
    assert.equal(d.limitUnit, 'percent');
    assert.deepEqual(d.myLimit, { maxPercent: 20 });
    assert.deepEqual(d.payload, {});
    assert.equal(normalizeDetail({ ...CARD, limitUnit: 'kg' }).limitUnit, null);
  });

  it('reads the list with its totals', () => {
    const l = normalizeList({ items: [CARD], total: 7, pendingCount: 2 });
    assert.equal(l.items.length, 1);
    assert.equal(l.total, 7);
    assert.equal(l.pendingCount, 2);
    assert.deepEqual(normalizeList({}), { items: [], total: 0, pendingCount: 0 });
  });
});

describe('showing a request', () => {
  const c = normalizeCard(CARD);
  it('colours by status', () => {
    assert.equal(statusTone('pending'), 'pending');
    assert.equal(statusTone('approved'), 'ok');
    assert.equal(statusTone('rejected'), 'error');
    assert.equal(statusTone('expired'), 'muted');
    assert.equal(statusTone('cancelled'), 'muted');
  });

  it('writes the percent and the amount', () => {
    assert.equal(formatPercent(30), '30%');
    assert.equal(formatPercent(12.345), '12.35%');
    assert.equal(formatPercent(null), '');
    assert.match(requestedText(c), /^30% · .*120\.50/);
    assert.equal(requestedText({ amount: null, percent: null }), '');
    assert.equal(approvedText({ approvedAmount: null, approvedPercent: 20 }), '20%');
    assert.equal(placeOf(c), 'קופה 2 · בר');
  });

  it('knows a partial approval', () => {
    assert.equal(isPartial({ ...c, status: 'approved', approvedPercent: 20 }), true);
    assert.equal(isPartial({ ...c, status: 'approved', approvedPercent: 30 }), false);
    assert.equal(isPartial({ ...c, status: 'rejected', approvedPercent: 20 }), false);
  });

  it('counts down to the expiry', () => {
    const now = Date.parse('2026-10-13T10:00:01Z');
    assert.equal(secondsLeft(c.expiresAt, now), 179);
    assert.equal(secondsLeft(c.expiresAt, Date.parse('2026-10-13T11:00:00Z')), 0);
    assert.equal(secondsLeft(null, now), null);
    assert.equal(secondsLeft('nope', now), null);
    assert.equal(formatCountdown(179), '2:59');
    assert.equal(formatCountdown(5), '0:05');
    assert.equal(formatCountdown(3725), '1:02:05');
  });

  it('shows the badge only above zero', () => {
    assert.equal(badgeText(0), null);
    assert.equal(badgeText(undefined), null);
    assert.equal(badgeText(3), '3');
    assert.equal(badgeText(120), '99+');
  });
});

describe('the payload', () => {
  const payload = {
    lines: [{ name: 'המבורגר', qty: 2, price: 50, total: 100, sentToKitchen: true }, { quantity: '1', lineTotal: '20' }, 'junk'],
    table: { id: 't1', name: '12' },
    document: { number: 1001, type: 'חשבונית', total: '220' },
    installments: 12,
    reason: 'x',
    nested: { a: 1 },
  };
  it('reads lines of any shape', () => {
    const lines = payloadLines(payload);
    assert.equal(lines.length, 3);
    assert.deepEqual(lines[0], { name: 'המבורגר', qty: 2, price: 50, total: 100, sentToKitchen: true });
    assert.deepEqual(lines[1], { name: '—', qty: 1, price: null, total: 20, sentToKitchen: false });
    assert.deepEqual(payloadLines({ lines: 'no' }), []);
    assert.deepEqual(payloadLines(null), []);
  });
  it('reads the table, the document and the rest', () => {
    assert.equal(payloadTable(payload), '12');
    assert.equal(payloadTable(payload, 'שולחן 7'), 'שולחן 7');
    assert.equal(payloadTable({ table: 5 }), '5');
    assert.equal(payloadTable({}), null);
    assert.deepEqual(payloadDocument(payload), { number: '1001', type: 'חשבונית', total: 220, date: null });
    assert.equal(payloadDocument({ document: {} }), null);
    assert.deepEqual(payloadExtras(payload), [['installments', '12'], ['reason', 'x']]);
  });
});

describe('deciding', () => {
  const d = normalizeDetail({ ...CARD, allowPartial: true, limitUnit: 'percent', myLimit: { maxPercent: 20 } });
  it('lowers the percent of a discount, the amount of a refund', () => {
    assert.equal(partialField(d), 'percent');
    assert.equal(partialField({ limitUnit: 'amount', amount: 100, percent: 10 }), 'amount');
    assert.equal(partialField({ limitUnit: null, amount: 100, percent: null }), 'amount');
    assert.equal(partialField({ limitUnit: null, amount: null, percent: null }), null);
    assert.equal(myCeiling(d, 'percent'), 20);
    assert.equal(myCeiling(d, 'amount'), null);
  });
  it('starts the box at the lower of asked and my ceiling', () => {
    assert.equal(initialPartial(30, 20), '20');
    assert.equal(initialPartial(30, null), '30');
    assert.equal(initialPartial(null, 20), '');
  });
  it('checks the lower value', () => {
    assert.equal(partialError('', 30, null), 'empty');
    assert.equal(partialError('0', 30, null), 'notPositive');
    assert.equal(partialError('abc', 30, null), 'notPositive');
    assert.equal(partialError('31', 30, null), 'overRequested');
    assert.equal(partialError('25', 30, 20), 'overLimit');
    assert.equal(partialError('20', 30, 20), null);
  });
  it('builds the body: partial only when lower, message only when written', () => {
    assert.deepEqual(decideBody('approve', { field: 'percent', requested: 30, partial: '20', message: '  ok ' }), {
      decision: 'approve',
      approvedPercent: 20,
      message: 'ok',
    });
    assert.deepEqual(decideBody('approve', { field: 'percent', requested: 30, partial: '30' }), { decision: 'approve' });
    assert.deepEqual(decideBody('approve', { field: 'amount', requested: 100, partial: '60' }), { decision: 'approve', approvedAmount: 60 });
    assert.deepEqual(decideBody('reject', { field: 'percent', requested: 30, partial: '20', message: '' }), { decision: 'reject' });
  });
  it('reads the server refusals', () => {
    const err = (status: number, detail: unknown) => ({ response: { status, data: { detail } } });
    assert.deepEqual(apiErrorOf(err(409, 'already_decided')), { status: 409, code: 'already_decided' });
    assert.deepEqual(apiErrorOf(new Error('x')), { status: null, code: null });
    assert.equal(decideFailure(err(409, 'expired')), 'decided');
    assert.equal(decideFailure(err(403, 'not_allowed')), 'notAllowed');
    assert.equal(decideFailure(err(422, 'partial_not_allowed')), 'partialNotAllowed');
    assert.equal(decideFailure(err(422, 'invalid_amount')), 'invalidAmount');
    assert.equal(decideFailure(err(500, 'boom')), 'other');
  });
});

describe('history', () => {
  it('sends only the filters that are set', () => {
    const f = { ...EMPTY_HISTORY_FILTERS, type: 'refund', requester: '  דנה ', from: '2026-10-01' };
    assert.deepEqual(historyParams(f), { status: 'all', type: 'refund', requester: 'דנה', from: '2026-10-01', limit: 200, offset: 0 });
    assert.deepEqual(historyParams(EMPTY_HISTORY_FILTERS, { status: 'pending', limit: 50, offset: 50 }), {
      status: 'pending',
      limit: 50,
      offset: 50,
    });
    assert.equal(activeFilterCount(f), 3);
  });

  it('writes a row for the export, one value per column', () => {
    const c = normalizeCard({ ...CARD, status: 'approved', approvedPercent: 20, decidedByName: 'רון', message: 'רק 20' });
    const row = approvalRowValues(c, { status: (s) => `S:${s}` });
    assert.deepEqual(Object.keys(row).sort(), APPROVAL_COLUMNS.map((x) => x.key).sort());
    assert.equal(row.status, 'S:approved');
    assert.equal(row.type, 'הנחה על החשבון');
    assert.equal(row.amount, 120.5);
    assert.equal(row.approvedPercent, 20);
    assert.equal(row.sentTo, 'רון, דנה');
    assert.equal(row.reason, 'מנה לא טעימה');
    assert.equal(row.till, 'קופה 2 · בר');
  });

  it('offers the approvers the server lists and anyone who decided', () => {
    const opts = approverOptions([{ id: 'u1', name: 'רון' }], [{ decidedByUserId: 'u9', decidedByName: 'אבי' }, { decidedByUserId: 'u1', decidedByName: 'x' }]);
    assert.deepEqual(opts, [{ value: 'u9', label: 'אבי' }, { value: 'u1', label: 'רון' }]);
  });
});

const FIELDS: CatalogField[] = [
  { key: 'enabled', label: 'פעיל', kind: 'bool' },
  { key: 'methods', label: 'דרכים', kind: 'methods', options: ['pin', 'remote'] },
  { key: 'reasons', label: 'סיבות', kind: 'strings' },
  { key: 'timeoutSeconds', label: 'המתנה', kind: 'int', min: 30, max: 1800 },
  { key: 'escalateAfterSeconds', label: 'הסלמה', kind: 'int', min: 10, max: 3600, nullable: true },
  { key: 'limits', label: 'תקרות', kind: 'roleLimits' },
  { key: 'pickApprover', label: 'בחירה', kind: 'enum', options: ['optional', 'required', 'off'] },
];

const POLICY: PolicyResponse = {
  level: 'shop',
  id: 's1',
  canWrite: true,
  own: { enabled: true, types: { refund: { enabled: true, timeoutSeconds: null }, oth: {} } },
  inherited: {
    enabled: false,
    types: { refund: { enabled: false, timeoutSeconds: 180, escalateAfterSeconds: null, approverRoles: ['till:manager'] } },
  },
  inheritedSources: { enabled: null, types: { refund: { timeoutSeconds: 'company', enabled: null } } },
  effective: { enabled: true, types: {} },
  catalog: { levels: ['company', 'shop', 'area', 'machine'], types: [], roles: [], fields: FIELDS },
};

describe('the policy form', () => {
  it('drafts this level own values, nulls and empty types dropped', () => {
    const d = draftFromPolicy(POLICY);
    assert.deepEqual(d, { enabled: true, types: { refund: { enabled: true } }, approvalStyle: {} });
    assert.equal(policyDirty(d, POLICY), false);
  });

  it('sets, inherits and clears fields', () => {
    let d = draftFromPolicy(POLICY);
    d = setOwnField(d, 'refund', 'timeoutSeconds', 60);
    assert.equal(isOverridden(d, 'refund', 'timeoutSeconds'), true);
    assert.equal(overriddenCount(d, 'refund'), 2);
    assert.equal(policyDirty(d, POLICY), true);
    d = setOwnField(d, 'refund', 'timeoutSeconds', null);
    assert.equal(policyDirty(d, POLICY), false);
    d = clearOwnType(d, 'refund');
    assert.deepEqual(policyBody(d), { enabled: true, types: {}, approvalStyle: {} });
  });

  it('sends the whole own document in a stable order', () => {
    let d = draftFromPolicy(POLICY);
    d = setOwnField(d, 'oth', 'reasons', ['א']);
    d = setOwnField(d, 'drawer_open', 'enabled', false);
    assert.deepEqual(Object.keys(policyBody(d).types), ['drawer_open', 'oth', 'refund']);
  });

  it('shows the inherited value and where it comes from', () => {
    const d = draftFromPolicy(POLICY);
    assert.equal(effectiveValue(d, POLICY, 'refund', 'timeoutSeconds'), 180);
    assert.equal(inheritedSource(POLICY, 'refund', 'timeoutSeconds'), 'company');
    assert.equal(inheritedSource(POLICY, 'refund', 'enabled'), null);
    assert.equal(inheritedSource(POLICY, 'oth', 'enabled'), null);
    assert.equal(effectiveEnabled(d, POLICY), true);
    assert.equal(effectiveEnabled({ ...d, enabled: null }, POLICY), false);
  });

  it('reads escalation 0 at this level as off', () => {
    const d = setOwnField(draftFromPolicy(POLICY), 'refund', 'escalateAfterSeconds', 0);
    assert.equal(effectiveValue(d, POLICY, 'refund', 'escalateAfterSeconds'), null);
    assert.equal(fieldError(FIELDS[4], 0), null);
    assert.equal(fieldError(FIELDS[4], 5), 'range');
    // The catalogue says min 0 (= off); past off the shortest is still ESCALATE_MIN.
    assert.equal(fieldError({ ...FIELDS[4], min: 0 }, 5), 'range');
    assert.equal(fieldError({ ...FIELDS[4], min: 0 }, 10), null);
    assert.deepEqual(fieldRange({ ...FIELDS[4], min: 0 }), { min: 10, max: 3600 });
    assert.equal(overrideStart(FIELDS[4], null), 0);
    assert.equal(overrideStart(FIELDS[4], 120), 120);
  });

  it('starts an override from what applies now', () => {
    assert.deepEqual(overrideStart(FIELDS[1], ['pin']), ['pin']);
    assert.deepEqual(overrideStart(FIELDS[1], undefined), []);
    assert.equal(overrideStart(FIELDS[6], undefined), 'optional');
    assert.equal(overrideStart(FIELDS[3], undefined), 30);
    assert.equal(overrideStart(FIELDS[0], undefined), false);
  });

  it('validates the fields', () => {
    assert.equal(fieldError(FIELDS[3], 29), 'range');
    assert.equal(fieldError(FIELDS[3], 1801), 'range');
    assert.equal(fieldError(FIELDS[3], 'abc'), 'notNumber');
    assert.equal(fieldError(FIELDS[3], 1.5), 'notNumber');
    assert.equal(fieldError(FIELDS[3], 180), null);
    assert.equal(fieldError(FIELDS[1], []), 'methods');
    assert.equal(fieldError(FIELDS[5], { 'till:manager': { maxAmount: -1 } }), 'limit');
    assert.equal(fieldError(FIELDS[5], { 'till:manager': { maxAmount: 500 } }), null);
    const d = setOwnField(draftFromPolicy(POLICY), 'refund', 'timeoutSeconds', 5);
    assert.deepEqual(policyErrors(d, FIELDS), { 'refund.timeoutSeconds': 'range' });
  });

  it('keeps the reasons list within its limits', () => {
    assert.equal(reasonsError(['א', 'ב']), null);
    assert.equal(reasonsError(Array.from({ length: 21 }, (_, i) => `r${i}`)), 'tooMany');
    assert.equal(reasonsError(['x'.repeat(61)]), 'tooLong');
    assert.equal(reasonsError(['א', ' ']), 'empty');
    assert.equal(reasonsError(['א', 'א']), 'duplicate');
    assert.deepEqual(moveItem(['a', 'b', 'c'], 0, 2), ['b', 'c', 'a']);
    assert.deepEqual(moveItem(['a', 'b'], 0, 5), ['a', 'b']);
  });

  it('groups the types by phase and names roles', () => {
    const groups = typesByPhase([
      { key: 'tip_over', label: 'טיפ', phase: 2, limitUnit: 'percent', sees: '' },
      { key: 'refund', label: 'זיכוי', phase: 1, limitUnit: 'amount', sees: '' },
      { key: 'oth', label: 'על חשבון הבית', phase: 1, limitUnit: 'amount', sees: '' },
    ]);
    assert.deepEqual(groups.map((g) => [g.phase, g.types.map((t) => t.key)]), [[1, ['refund', 'oth']], [2, ['tip_over']]]);
    assert.equal(roleLabel([{ key: 'till:manager', label: 'מנהל', kind: 'till' }], 'till:manager'), 'מנהל');
    assert.equal(roleLabel([], 'till:x'), 'till:x');
    assert.equal(limitKeyOf('percent'), 'maxPercent');
    assert.equal(limitKeyOf(null), null);
  });

  it('edits per-role ceilings and lists the roles they apply to', () => {
    let limits = setRoleLimit({}, 'till:manager', 'maxAmount', '500');
    assert.deepEqual(limits, { 'till:manager': { maxAmount: 500 } });
    limits = setRoleLimit(limits, 'till:manager', 'maxAmount', '');
    assert.deepEqual(limits, {});
    assert.deepEqual(rolesForMaps(['till:manager'], { 'dash:shop_manager': {} }, { 'till:manager': true }), ['till:manager', 'dash:shop_manager']);
    assert.deepEqual(rolesForMaps(undefined), []);
  });
});

const STYLE_POLICY: PolicyResponse = {
  ...POLICY,
  own: { enabled: null, types: {}, approvalStyle: { TABLE_RESTORE: 'takeover', DISCOUNT: null as unknown as 'both', '*': 'bad' as 'both' } },
  inherited: { ...POLICY.inherited, approvalStyle: { TABLE_RESTORE: 'both', DISCOUNT: 'approve', REFUND: 'approve' } },
  inheritedSources: { ...POLICY.inheritedSources, approvalStyle: { TABLE_RESTORE: null, DISCOUNT: 'company', REFUND: 'company' } },
  catalog: {
    ...POLICY.catalog,
    approvalStyle: {
      options: ['approve', 'takeover', 'both'],
      default: 'both',
      permissions: [
        { code: 'DISCOUNT', label: 'הנחה', group: 'sale' },
        { code: 'TABLE_RESTORE', label: 'שחזור שולחן', group: 'tables' },
        { code: 'REFUND', label: 'זיכוי', group: 'sale' },
      ],
    },
  },
};

describe('"סגנון האישור"', () => {
  it('drafts this level own map, nulls and unknown values dropped, and always sends it', () => {
    const d = draftFromPolicy(STYLE_POLICY);
    assert.deepEqual(d.approvalStyle, { TABLE_RESTORE: 'takeover' });
    assert.deepEqual(policyBody(d).approvalStyle, { TABLE_RESTORE: 'takeover' });
    assert.equal(policyDirty(d, STYLE_POLICY), false);
    assert.deepEqual(policyBody(draftFromPolicy({ own: { enabled: null, types: {} } })).approvalStyle, {});
  });

  it('sets a permission, "*" and back to inherit', () => {
    let d = draftFromPolicy(STYLE_POLICY);
    d = setStyle(d, STYLE_ALL, 'approve');
    d = setStyle(d, 'DISCOUNT', 'both');
    assert.deepEqual(policyBody(d).approvalStyle, { '*': 'approve', DISCOUNT: 'both', TABLE_RESTORE: 'takeover' });
    assert.equal(ownStyleCount(d), 2);
    assert.equal(policyDirty(d, STYLE_POLICY), true);
    d = setStyle(setStyle(d, STYLE_ALL, null), 'DISCOUNT', null);
    assert.equal(policyDirty(d, STYLE_POLICY), false);
    assert.equal(ownStyle(d, 'REFUND'), null);
  });

  it('resolves: this permission here, then "*" here, then inherited with its level', () => {
    let d = draftFromPolicy(STYLE_POLICY);
    assert.deepEqual(resolveStyle(d, STYLE_POLICY, 'TABLE_RESTORE'), { style: 'takeover', from: 'own', source: null });
    assert.deepEqual(resolveStyle(d, STYLE_POLICY, 'DISCOUNT'), { style: 'approve', from: 'inherited', source: 'company' });
    assert.deepEqual(resolveStyle(d, STYLE_POLICY, 'UNKNOWN'), { style: 'both', from: 'inherited', source: null });
    d = setStyle(d, STYLE_ALL, 'takeover');
    assert.deepEqual(resolveStyle(d, STYLE_POLICY, 'DISCOUNT'), { style: 'takeover', from: 'ownAll', source: null });
  });

  it('sums up what "כל ההרשאות" inherits', () => {
    assert.deepEqual(inheritedStyleSummary(STYLE_POLICY, ['DISCOUNT', 'REFUND']), { style: 'approve', source: 'company', mixed: false });
    assert.deepEqual(inheritedStyleSummary(STYLE_POLICY, ['DISCOUNT', 'TABLE_RESTORE']), { style: null, source: null, mixed: true });
    assert.deepEqual(inheritedStyleSummary(STYLE_POLICY, []), { style: 'both', source: null, mixed: false });
  });

  it('reads the catalogue and groups the permissions', () => {
    const c = styleCatalogOf(STYLE_POLICY.catalog);
    assert.deepEqual(c.options, ['approve', 'takeover', 'both']);
    assert.deepEqual(
      stylePermissionGroups(c.permissions).map((g) => [g.group, g.permissions.map((p) => p.code)]),
      [['sale', ['DISCOUNT', 'REFUND']], ['tables', ['TABLE_RESTORE']]],
    );
    assert.deepEqual(styleCatalogOf(null), { options: ['approve', 'takeover', 'both'], default: 'both', permissions: [] });
    assert.equal(isApprovalStyle('takeover'), true);
    assert.equal(isApprovalStyle('x'), false);
  });
});

describe('an employee own overrides', () => {
  it('round-trips a draft, leaving out what is "as the role"', () => {
    const d = overrideDraftOf({ offShift: true, maxAmount: 500 });
    assert.deepEqual(d, { ...EMPTY_OVERRIDE_DRAFT, offShift: true, maxAmount: '500' });
    assert.deepEqual(overrideFromDraft(d), { offShift: true, maxAmount: 500 });
    assert.deepEqual(overrideFromDraft(EMPTY_OVERRIDE_DRAFT), {});
  });
  it('validates the ceilings', () => {
    assert.deepEqual(overrideDraftErrors({ ...EMPTY_OVERRIDE_DRAFT, maxAmount: '-1', maxCount: '2.5', maxPercent: '10' }), ['maxAmount', 'maxCount']);
  });
  it('sends all types and only the types that set something', () => {
    const body = overridesBody(
      { ...EMPTY_OVERRIDE_DRAFT, noRequests: true },
      { refund: { ...EMPTY_OVERRIDE_DRAFT, maxAmount: '200' }, oth: EMPTY_OVERRIDE_DRAFT },
    );
    assert.deepEqual(body, { all: { noRequests: true }, types: { refund: { maxAmount: 200 } } });
  });
});

describe('who would receive a level requests', () => {
  it('reads the list, its health and the ones without a phone', () => {
    const r = normalizeApprovers({
      items: [
        { userId: 'u1', name: 'דנה', roles: ['אחמ"ש'], types: ['refund', 'oth'], shops: ['מרכז'], hasDevice: false, health: { devices: 0, tone: 'red' } },
        { userId: 'u2', name: 'רון', roles: ['מנהל'], types: ['refund'], shops: ['מרכז'], health: { devices: 2, lastSuccessAt: '2026-10-13T10:00:00Z', tone: 'weird' } },
        'junk',
      ],
      withoutDevice: ['דנה'],
    });
    assert.equal(r.items.length, 2);
    assert.deepEqual(r.withoutDevice, ['דנה']);
    assert.equal(r.items[0].health.tone, 'red');
    assert.equal(r.items[1].hasDevice, true);
    assert.equal(r.items[1].health.tone, 'green');
    assert.equal(r.items[1].health.lastSuccessAt, '2026-10-13T10:00:00Z');
    assert.deepEqual(normalizeApprovers({ items: [{ userId: 'u3', name: 'אבי' }] }).withoutDevice, ['אבי']);
    assert.deepEqual(normalizeApprovers(null), { items: [], withoutDevice: [] });
  });
  it('names the types by the catalogue, unknown keys last', () => {
    const types = [
      { key: 'refund', label: 'זיכוי' },
      { key: 'oth', label: 'על חשבון הבית' },
    ];
    assert.deepEqual(typeLabels(['oth', 'x_new', 'refund'], types), ['זיכוי', 'על חשבון הבית', 'x_new']);
  });
});

describe('linked employees', () => {
  it('reads the list and toggles a choice', () => {
    const list = normalizeEmployees({
      items: [{ posUserId: 'p1', name: 'דנה', username: 'dana', shopName: 'מרכז', tillRoleName: 'מנהל', linkedUserId: null }, { name: 'no id' }],
    });
    assert.equal(list.length, 1);
    assert.equal(employeeHint(list[0]), 'dana · מרכז · מנהל');
    const added = toggleEmployee([], list[0]);
    assert.equal(added.length, 1);
    assert.equal(toggleEmployee(added, list[0]).length, 0);
    assert.equal(sameEmployeeIds(added, [...list]), true);
    assert.equal(sameEmployeeIds([], list), false);
  });
});
