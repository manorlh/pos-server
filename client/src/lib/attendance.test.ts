import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  adjustmentTimes,
  cardAlerts,
  cardStatus,
  decimalHours,
  formatHours,
  isoToLocalInput,
  liveSeconds,
  localInputToIso,
  noteKeys,
  reportExportRows,
  REPORT_HEADER_KEYS,
  type AttendanceAdjustment,
  type AttendanceShift,
} from './attendance';

const shift = (over: Partial<AttendanceShift> = {}): AttendanceShift => ({
  id: 's1',
  posUserId: 'u1',
  posUserName: 'דנה כהן',
  shopId: 'shop',
  shopName: 'מרכז',
  status: 'finished',
  source: 'till',
  clockInAt: '2026-10-06T14:00:00+00:00',
  clockOutAt: '2026-10-06T22:00:00+00:00',
  breaks: [{ id: 'b', startAt: '2026-10-06T17:00:00+00:00', endAt: '2026-10-06T17:30:00+00:00' }],
  breakSeconds: 1800,
  workedSeconds: 27000,
  flags: [],
  ...over,
});

describe('attendance — times', () => {
  it('writes hours as a timesheet does', () => {
    assert.equal(formatHours(27720), '7:42');
    assert.equal(formatHours(59), '0:00');
    assert.equal(formatHours(null), '0:00');
    assert.equal(decimalHours(27720), 7.7);
  });

  it('moves the server figure on by the time since it was given', () => {
    const t = '2026-10-06T16:00:00+00:00';
    assert.equal(liveSeconds(600, t, Date.parse(t) + 65_000), 665);
    assert.equal(liveSeconds(600, null, Date.now()), 600);
    // A browser clock behind the server never counts backwards.
    assert.equal(liveSeconds(600, t, Date.parse(t) - 10_000), 600);
  });

  it('round-trips a datetime-local value', () => {
    const iso = '2026-10-06T13:05:00.000Z';
    assert.equal(localInputToIso(isoToLocalInput(iso)), iso);
    assert.equal(localInputToIso(''), null);
    assert.equal(isoToLocalInput(null), '');
  });
});

describe('attendance — the live board', () => {
  it('tells status from alerts', () => {
    assert.equal(cardStatus({ status: 'working', pendingCorrections: 0 }), 'working');
    assert.equal(cardStatus({ status: 'on_break', pendingCorrections: 1 }), 'on_break');
    assert.equal(cardStatus({ status: 'working', pendingCorrections: 2 }), 'pending');
    assert.deepEqual(cardAlerts({ flags: ['clock_skew', 'unknown'], openTables: 3 }), ['openTablesNow', 'clock_skew']);
  });
});

describe('attendance — the report', () => {
  it('orders the notes', () => {
    assert.deepEqual(noteKeys({ notes: ['corrected', 'open', 'closed_by_manager', 'x'] }), [
      'open', 'closed_by_manager', 'corrected',
    ]);
  });

  it('exports one row per shift in the header order', () => {
    const rows = reportExportRows(
      [shift({ date: '2026-10-06', notes: ['closed_by_manager'], closeReason: 'שכחה לצאת', breakCount: 1, roleName: 'מלצר' })],
      { note: (k) => `[${k}]`, status: (s) => s, time: (iso) => (iso ? iso.slice(11, 16) : '') },
    );
    assert.equal(rows[0].length, REPORT_HEADER_KEYS.length);
    assert.deepEqual(rows[0], [
      '2026-10-06', 'דנה כהן', '', 'מלצר', 'מרכז', '14:00', '22:00', 1, '0:30', 7.5, 'finished',
      '[closed_by_manager] · שכחה לצאת',
    ]);
  });
});

describe('attendance — corrections', () => {
  const base: AttendanceAdjustment = {
    id: 'a', shopId: 's', posUserId: 'u', kind: 'missing_in', status: 'pending', source: 'till',
    originalTime: '2026-10-06T14:40:00Z', requestedTime: '2026-10-06T14:05:00Z',
  };

  it('shows then and now', () => {
    assert.deepEqual(adjustmentTimes(base), { before: '2026-10-06T14:40:00Z', after: '2026-10-06T14:05:00Z' });
    assert.deepEqual(
      adjustmentTimes({ ...base, status: 'approved', approvedTime: '2026-10-06T14:10:00Z' }),
      { before: '2026-10-06T14:40:00Z', after: '2026-10-06T14:10:00Z' },
    );
  });
});
