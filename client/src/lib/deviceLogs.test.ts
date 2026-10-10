/**
 * Run with `npm test`. "שליחת לוגים לענן" — the pure rules of the device's "לוגים" and the super
 * admin's "לוגים ממכשירים" (lib/deviceLogs.ts), and a logs request's phase in the shared
 * "פקודות שנשלחו" tracker (lib/deviceCommands.ts `phaseOfDeviceLogs`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MINUTE_CHOICES,
  MINUTES_DEFAULT,
  MINUTES_MAX,
  MINUTES_MIN,
  clampMinutes,
  formatBytes,
  highlightParts,
  isNewUpload,
  isOpenRequest,
  listParams,
  logFileName,
  minutesLabel,
  rangeLabel,
  requestState,
} from './deviceLogs';
import { actionLabelOf, phaseOfDeviceLogs } from './deviceCommands';

test('the minutes picker: 15–1440, 120 by default, every choice valid', () => {
  assert.equal(MINUTES_DEFAULT, 120);
  assert.equal(clampMinutes(undefined), 120);
  assert.equal(clampMinutes('abc'), 120);
  assert.equal(clampMinutes(5), MINUTES_MIN);
  assert.equal(clampMinutes(5000), MINUTES_MAX);
  assert.equal(clampMinutes('240'), 240);
  assert.equal(clampMinutes(90.4), 90);
  for (const m of MINUTE_CHOICES) assert.equal(clampMinutes(m), m);
  assert.ok(MINUTE_CHOICES.includes(MINUTES_DEFAULT));
  assert.deepEqual([minutesLabel(15), minutesLabel(60), minutesLabel(120), minutesLabel(480), minutesLabel(1440), minutesLabel(90)], [
    '15 דק׳', 'שעה', 'שעתיים', '8 שעות', '24 שעות', '90 דק׳',
  ]);
});

test('sizes and time ranges as the list shows them (Israel time)', () => {
  assert.equal(formatBytes(820), '820 B');
  assert.equal(formatBytes(12_700), '12.4 KB');
  assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
  assert.equal(formatBytes(null), '—');
  // 2026-10-09 09:00–11:00 UTC = 12:00–14:00 in Israel (summer time).
  const from = Date.UTC(2026, 9, 9, 9, 0);
  assert.equal(rangeLabel(from, from + 2 * 3600_000), '09.10 12:00–14:00');
  assert.equal(rangeLabel(Date.UTC(2026, 9, 8, 20, 0), Date.UTC(2026, 9, 8, 22, 0)), '08.10 23:00 – 09.10 01:00');
  assert.equal(rangeLabel(null, from), '—');
});

test('"חדש": a manual upload with a note, until someone opens it', () => {
  assert.equal(isNewUpload({ reason: 'manual', note: 'הקופה נתקעה', openedAt: null }), true);
  assert.equal(isNewUpload({ reason: 'manual', note: '   ', openedAt: null }), false);
  assert.equal(isNewUpload({ reason: 'manual', note: null, openedAt: null }), false);
  assert.equal(isNewUpload({ reason: 'crash', note: 'x', openedAt: null }), false);
  assert.equal(isNewUpload({ reason: 'manual', note: 'x', openedAt: '2026-10-09T10:00:00Z' }), false);
});

test('a request is "נשלח" → "התקבל במכשיר" → "התקבל", and nothing about its content', () => {
  assert.equal(requestState({ status: 'pending', received: false }), 'sent');
  assert.equal(requestState({ status: 'delivered', received: false }), 'delivered');
  assert.equal(requestState({ status: 'done', received: true }), 'received');
  assert.equal(requestState({ status: 'expired', received: true }), 'received', 'the log arrived: that is what counts');
  assert.equal(requestState({ status: 'refused', received: false }), 'failed');
  assert.equal(requestState({ status: 'expired', received: false }), 'expired');
  assert.equal(isOpenRequest({ status: 'pending', received: false }), true);
  assert.equal(isOpenRequest({ status: 'delivered', received: false }), true);
  assert.equal(isOpenRequest({ status: 'done', received: true }), false);
});

test('the tracker: a logs request moves like any command and ends "הלוג התקבל"', () => {
  assert.equal(actionLabelOf('upload_logs'), 'בקשת לוגים');
  assert.deepEqual(phaseOfDeviceLogs('pending', false), { phase: 'sent', detail: null });
  assert.deepEqual(phaseOfDeviceLogs('delivered', false), { phase: 'received', detail: null });
  assert.deepEqual(phaseOfDeviceLogs('done', true), { phase: 'done', detail: 'הלוג התקבל' });
  assert.equal(phaseOfDeviceLogs('expired', false).phase, 'expired');
  assert.equal(phaseOfDeviceLogs('refused', false, 'not_supported').detail, 'נדחה — המכשיר לא תומך בפעולה');
});

test('the download is named after the device and when it arrived', () => {
  const u = { machineId: '0f8f862a-1111-2222-3333-444455556666', machineName: 'קופה 2 / בר', receivedAt: '2026-10-09T11:12:00Z' };
  assert.equal(logFileName(u, 'txt'), 'לוגים-קופה_2_בר-20261009-1412.txt');
  assert.equal(logFileName(u, 'gz'), 'לוגים-קופה_2_בר-20261009-1412.log.gz');
  assert.equal(logFileName({ ...u, machineName: null }, 'txt'), 'לוגים-0f8f862a-20261009-1412.txt');
});

test('the search highlight: every match, any case, the rest untouched', () => {
  assert.deepEqual(highlightParts('Sync FAILED, sync retry', 'sync'), [
    { text: 'Sync', match: true },
    { text: ' FAILED, ', match: false },
    { text: 'sync', match: true },
    { text: ' retry', match: false },
  ]);
  assert.deepEqual(highlightParts('abc', ''), [{ text: 'abc', match: false }]);
  assert.deepEqual(highlightParts('abc', 'zzz'), [{ text: 'abc', match: false }]);
});

test('the super admin page sends only the filters that are set', () => {
  assert.deepEqual(listParams({}), {});
  assert.deepEqual(
    listParams({ tenantId: 't', shopId: '', machineId: null, reason: 'crash', dateFrom: '2026-10-01', dateTo: '1.10.26', onlyNew: true, limit: 50, offset: 0 }),
    { tenantId: 't', reason: 'crash', dateFrom: '2026-10-01', onlyNew: 'true', limit: '50' },
  );
  assert.deepEqual(listParams({ reason: 'bored' as never, offset: 100 }), { offset: '100' });
});
