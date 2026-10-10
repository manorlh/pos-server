import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dispatchTone,
  draftFromRule,
  emptyDraft,
  isHeldBack,
  logSheet,
  quietHoursText,
  smsText,
  sourceLinks,
  thresholdsApply,
  validateDraft,
  type AlertRule,
  type LogEntry,
  type LogKind,
  type SmsDispatch,
} from './exceptionAlerts';

const KINDS: LogKind[] = [
  { key: 'refund', label: 'זיכוי / החזר', severity: 'medium', source: 'audit_exception', amount: true, percent: false, link: 'document' },
  { key: 'discount', label: 'הנחה', severity: 'low', source: 'audit_exception', amount: true, percent: true, link: 'document' },
  { key: 'drawer_open', label: 'פתיחת מגירה', severity: 'medium', source: 'audit_exception', amount: false, percent: false, link: 'shift' },
];

test('a valid draft becomes the API body: numbers, E.164 phones, duplicates dropped', () => {
  const draft = {
    ...emptyDraft('shop-1'),
    name: '  החזרים   גדולים ',
    kinds: ['refund', 'refund'],
    minAmount: '250',
    recipients: [
      { phone: '050-123-4567', label: 'דנה', userId: 'u1' },
      { phone: '+972 50 123 4567', label: '', userId: '' },
      { phone: '', label: '', userId: '' },
    ],
    quietFrom: '22:00',
    quietTo: '07:00',
  };
  const { errors, body } = validateDraft(draft);
  assert.deepEqual(errors, {});
  assert.ok(body);
  assert.equal(body.name, 'החזרים גדולים');
  assert.deepEqual(body.kinds, ['refund']);
  assert.equal(body.minAmount, 250);
  assert.equal(body.shopId, 'shop-1');
  assert.deepEqual(body.recipients, [{ phone: '+972501234567', label: 'דנה', userId: 'u1' }]);
  assert.equal(body.rateLimitMinutes, 10);
  assert.equal(body.countThreshold, null);
});

test('the server rules are checked first, with the server error codes', () => {
  const base = { ...emptyDraft(), name: 'x', kinds: ['refund'], recipients: [{ phone: '0501234567', label: '', userId: '' }] };
  assert.equal(validateDraft({ ...base, name: ' ' }).errors.name, 'name_required');
  assert.equal(validateDraft({ ...base, kinds: [] }).errors.kinds, 'kinds_required');
  assert.deepEqual(validateDraft({ ...base, kinds: [], minSeverity: 'high' }).errors, {});
  assert.equal(validateDraft({ ...base, countThreshold: '3' }).errors.countWindowMinutes, 'count_needs_both');
  assert.equal(validateDraft({ ...base, countThreshold: '1', countWindowMinutes: '5' }).errors.countThreshold, 'number_out_of_range');
  assert.equal(validateDraft({ ...base, countThreshold: '2.5', countWindowMinutes: '5' }).errors.countThreshold, 'number_not_integer');
  assert.equal(validateDraft({ ...base, quietFrom: '22:00' }).errors.quietTo, 'quiet_needs_both');
  assert.equal(validateDraft({ ...base, quietFrom: '24:00', quietTo: '07:00' }).errors.quietFrom, 'time_invalid');
  assert.equal(validateDraft({ ...base, quietFrom: '07:00', quietTo: '07:00' }).errors.quietTo, 'quiet_empty');
  assert.equal(validateDraft({ ...base, minAmount: 'abc' }).errors.minAmount, 'number_invalid');
  assert.equal(validateDraft({ ...base, rateLimitMinutes: '-1' }).errors.rateLimitMinutes, 'number_out_of_range');
  assert.equal(validateDraft({ ...base, recipients: [{ phone: '03-1234567', label: '', userId: '' }] }).errors['recipients.0'], 'phone_not_mobile');
  assert.equal(validateDraft({ ...base, recipients: [] }).errors.recipients, 'recipients_required');
  // A switched-off rule may be kept without recipients.
  assert.deepEqual(validateDraft({ ...base, enabled: false, recipients: [] }).errors, {});
});

test('a rule round-trips through the form', () => {
  const rule: AlertRule = {
    id: 'r1', companyId: 'c1', shopId: null, shopName: null, name: 'קופות', enabled: true, kinds: ['drawer_open'],
    minSeverity: null, minAmount: null, minPercent: 15, countThreshold: 3, countWindowMinutes: 10, countScope: 'employee',
    recipients: [{ phone: '+972521234567', label: 'רון', userId: null }], quietFrom: null, quietTo: null,
    rateLimitMinutes: 0, digestEnabled: false, canWrite: true, createdAt: null, updatedAt: null,
  };
  const { body } = validateDraft(draftFromRule(rule));
  assert.ok(body);
  assert.equal(body.countThreshold, 3);
  assert.equal(body.countScope, 'employee');
  assert.equal(body.rateLimitMinutes, 0);
  assert.equal(body.minPercent, 15);
  assert.equal(body.digestEnabled, false);
  assert.deepEqual(body.recipients, [{ phone: '+972521234567', label: 'רון', userId: null }]);
});

test('thresholds apply only where the kinds carry them', () => {
  assert.deepEqual(thresholdsApply(['drawer_open'], KINDS), { amount: false, percent: false });
  assert.deepEqual(thresholdsApply(['refund'], KINDS), { amount: true, percent: false });
  assert.deepEqual(thresholdsApply([], KINDS), { amount: true, percent: true });
});

const sms = (status: SmsDispatch['status'], statusLabel: string): SmsDispatch => ({
  id: status, ruleId: 'r', ruleName: 'החזרים', kind: 'alert', status, statusLabel, reason: null,
  recipient: '050-•••-4567', recipientLabel: 'דנה', provider: 'dry_run', providerMode: 'dry_run',
  notificationId: null, digestId: null, digestCount: null, text: null, at: null,
});

test('SMS attempts: tone, held back, one line each', () => {
  assert.equal(dispatchTone('sent'), 'ok');
  assert.equal(dispatchTone('dry_run'), 'muted');
  assert.equal(dispatchTone('failed'), 'error');
  assert.equal(dispatchTone('suppressed_quiet_hours'), 'warn');
  assert.ok(isHeldBack('suppressed_rate_limit') && !isHeldBack('dry_run'));
  assert.equal(
    smsText([sms('dry_run', 'הדמיה — לא נשלח'), sms('suppressed_rate_limit', 'נחסם — הגבלת קצב')]),
    'דנה 050-•••-4567: הדמיה — לא נשלח; דנה 050-•••-4567: נחסם — הגבלת קצב',
  );
  assert.equal(quietHoursText('22:00', '07:00'), '22:00–07:00');
  assert.equal(quietHoursText(null, null), null);
});

const entry = (over: Partial<LogEntry> = {}): LogEntry => ({
  id: 'e1', code: 'abcd2345', kind: 'refund', kindLabel: 'זיכוי / החזר', severity: 'medium', source: 'audit_exception',
  link: 'document', occurredAt: '2026-09-27T18:00:00+00:00', receivedAt: null, companyId: 'c1', shopId: 's1',
  shopName: 'מרכז', areaId: null, areaName: null, machineId: 'm1', machineName: 'קופה ראשית', posNumber: '2',
  posUserId: 'pu', posUserName: 'דנה', amount: 150, value: null, threshold: null, summary: null, details: null,
  transactionId: 't1', transactionNumber: '20000057', documentType: 330, shiftId: null, shiftNumber: null,
  zReportId: null, auditExceptionId: 'a1', backfilled: false, acknowledged: false, acknowledgedAt: null,
  acknowledgedBy: null, note: null, sms: [], ...over,
});

test('a row links to its document, its shift and its Z', () => {
  assert.deepEqual(sourceLinks(entry()), [{ kind: 'document', href: '/dashboard/transactions?tx=t1', number: '20000057' }]);
  const links = sourceLinks(entry({ transactionId: null, shiftId: 'sh1', shiftNumber: 4, details: { zReportId: 'z1', zNumber: 12 } }));
  assert.deepEqual(links, [
    { kind: 'shift', href: '/dashboard/shifts/sh1', number: 4 },
    { kind: 'z', href: '/dashboard/z-reports/z1', number: 12 },
  ]);
  assert.deepEqual(sourceLinks(entry({ transactionId: null })), []);
});

test('the Excel sheet: one row per entry, in the column order', () => {
  const sheet = logSheet(
    [entry({ acknowledged: true, acknowledgedBy: 'admin', note: 'טופל', sms: [sms('dry_run', 'הדמיה — לא נשלח')] })],
    (k) => k,
    'יומן חריגות',
    { severity: (s) => s, acknowledged: (yes) => (yes ? 'טופל' : 'פתוח') },
  );
  assert.equal(sheet.columns.length, sheet.rows[0].length);
  assert.deepEqual(sheet.columns.map((c) => c.header).slice(0, 3), ['time', 'kind', 'severity']);
  assert.deepEqual(sheet.rows[0], [
    '2026-09-27T18:00:00+00:00', 'זיכוי / החזר', 'medium', 'מרכז', null, 'קופה ראשית · 2', 'דנה', 150, null,
    '20000057', 'טופל', 'admin', 'טופל', 'דנה 050-•••-4567: הדמיה — לא נשלח', 'abcd2345',
  ]);
});
