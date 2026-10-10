/**
 * Run with `npm test`. Israeli dates and times (lib/format.ts): dd/MM/yyyy, the 24-hour
 * clock, Hebrew names, and always Israel's clock — across the March and October clock
 * changes and around midnight — whatever zone the test machine runs in.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  addDaysIso,
  businessToday,
  dateInputText,
  formatDate,
  formatDateTime,
  formatDateTimeInZone,
  formatLongDate,
  formatMonthYear,
  formatShortDate,
  formatShortDateTime,
  formatTime,
  formatTimeAgo,
  formatWeekday,
  isoDate,
  parseDateInput,
  parseTimeInput,
  zonedParts,
} from './format';

describe('formatDate / formatDateTime', () => {
  it('writes day/month/year with slashes and zero padding', () => {
    assert.equal(formatDate('2026-10-07T09:05:00Z'), '07/10/2026');
    assert.equal(formatDateTime('2026-10-07T09:05:00Z'), '07/10/2026 12:05');
    assert.equal(formatDate('2026-01-03'), '03/01/2026');
  });

  it('uses the 24-hour clock', () => {
    assert.equal(formatDateTime('2026-10-07T20:45:00Z'), '07/10/2026 23:45');
    assert.equal(formatTime('2026-10-07T20:45:00Z'), '23:45');
    assert.equal(formatTime('2026-10-07T20:45:09Z', { seconds: true }), '23:45:09');
  });

  it('shows a plain business date as that day, not shifted by any zone', () => {
    assert.equal(formatDate('2026-09-28'), '28/09/2026');
    assert.equal(formatDate('2026-09-28', 'America/Los_Angeles'), '28/09/2026');
    assert.equal(formatDate('2026-02-30'), '—');
  });

  it('takes Dates and epoch milliseconds', () => {
    const at = Date.UTC(2026, 9, 7, 9, 5);
    assert.equal(formatDateTime(at), '07/10/2026 12:05');
    assert.equal(formatDateTime(new Date(at)), '07/10/2026 12:05');
  });

  it('renders a dash for nothing or garbage', () => {
    for (const v of [null, undefined, '', 'not a date']) {
      assert.equal(formatDate(v), '—');
      assert.equal(formatDateTime(v), '—');
      assert.equal(formatTime(v), '—');
    }
  });

  it('reads another zone when asked, and Israel for an unknown one', () => {
    assert.equal(formatDateTime('2026-10-07T09:05:00Z', 'UTC'), '07/10/2026 09:05');
    assert.equal(formatDateTimeInZone('2026-10-07T09:05:00Z', 'Europe/London'), '07/10/2026 10:05');
    assert.equal(formatDateTimeInZone('2026-10-07T09:05:00Z', 'Not/AZone'), '07/10/2026 12:05');
    assert.equal(formatDateTimeInZone(null, 'Asia/Jerusalem'), '—');
  });
});

describe('Israel time across the clock changes', () => {
  // 2026: summer time starts Friday 27/03 at 02:00 (→ 03:00), ends Sunday 25/10 at 02:00 (→ 01:00).
  it('is UTC+2 before the March change and UTC+3 after it', () => {
    assert.equal(formatDateTime('2026-03-26T23:59:00Z'), '27/03/2026 01:59');
    assert.equal(formatDateTime('2026-03-27T00:00:00Z'), '27/03/2026 03:00');
    assert.equal(formatDateTime('2026-03-27T00:30:00Z'), '27/03/2026 03:30');
  });

  it('repeats 01:00–02:00 on the October change', () => {
    assert.equal(formatDateTime('2026-10-24T22:30:00Z'), '25/10/2026 01:30'); // summer time
    assert.equal(formatDateTime('2026-10-24T23:30:00Z'), '25/10/2026 01:30'); // winter time
    assert.equal(formatDateTime('2026-10-25T00:00:00Z'), '25/10/2026 02:00');
  });

  it('puts midnight on the right day in summer and in winter', () => {
    assert.equal(formatDateTime('2026-10-06T21:00:00Z'), '07/10/2026 00:00');
    assert.equal(formatDateTime('2026-10-06T20:59:00Z'), '06/10/2026 23:59');
    assert.equal(formatDateTime('2026-12-31T22:00:00Z'), '01/01/2027 00:00');
    assert.equal(formatDateTime('2026-12-31T21:59:00Z'), '31/12/2026 23:59');
    assert.equal(isoDate('2026-12-31T22:00:00Z'), '2027-01-01');
    assert.equal(formatTime('2026-12-31T22:00:00Z'), '00:00');
  });

  it('gives the zone parts with the weekday', () => {
    assert.deepEqual(zonedParts('2026-10-06T21:00:00Z'), {
      year: 2026,
      month: 10,
      day: 7,
      hour: 0,
      minute: 0,
      second: 0,
      weekday: 3,
    });
  });
});

describe('short and long forms', () => {
  it('writes the short forms', () => {
    assert.equal(formatShortDate('2026-10-07T09:05:00Z'), '07/10');
    assert.equal(formatShortDateTime('2026-10-07T09:05:00Z'), '07/10 12:05');
  });

  it('names the weekday and the month in Hebrew', () => {
    assert.equal(formatWeekday('2026-10-07'), 'יום רביעי');
    assert.equal(formatWeekday('2026-10-10'), 'שבת');
    assert.equal(formatLongDate('2026-10-07'), 'יום רביעי, 7 באוקטובר 2026');
    assert.equal(formatLongDate('2026-10-06T21:30:00Z'), 'יום רביעי, 7 באוקטובר 2026');
    assert.equal(formatMonthYear('2026-03-01'), 'מרץ 2026');
  });

  it('says relative times in Hebrew', () => {
    const now = Date.UTC(2026, 9, 7, 12, 0);
    assert.equal(formatTimeAgo(now - 5 * 60_000, now), 'לפני 5 דקות');
    assert.equal(formatTimeAgo(null, now), '—');
  });
});

describe('days', () => {
  it("is Israel's today, not UTC's", () => {
    assert.equal(businessToday(Date.UTC(2026, 9, 6, 21, 30)), '2026-10-07');
    assert.equal(businessToday(Date.UTC(2026, 9, 6, 20, 30)), '2026-10-06');
  });

  it('adds days by the calendar, over months, years and the clock change', () => {
    assert.equal(addDaysIso('2026-10-31', 1), '2026-11-01');
    assert.equal(addDaysIso('2026-01-01', -1), '2025-12-31');
    assert.equal(addDaysIso('2026-10-24', 2), '2026-10-26');
    assert.equal(addDaysIso('2028-02-28', 1), '2028-02-29');
    assert.equal(addDaysIso('nope', 1), '');
  });
});

describe('typed dates (the date field)', () => {
  it('reads day first, the Israeli way', () => {
    assert.equal(parseDateInput('07/10/2026'), '2026-10-07');
    assert.equal(parseDateInput('7/10/2026'), '2026-10-07');
    assert.equal(parseDateInput('7.10.2026'), '2026-10-07');
    assert.equal(parseDateInput('7-10-2026'), '2026-10-07');
    assert.equal(parseDateInput(' 07 / 10 / 2026 '), '2026-10-07');
    assert.equal(parseDateInput('07102026'), '2026-10-07');
  });

  it('takes a two-digit year as this century', () => {
    assert.equal(parseDateInput('7/10/26'), '2026-10-07');
    assert.equal(parseDateInput('071026'), '2026-10-07');
  });

  it('takes ISO as it is', () => {
    assert.equal(parseDateInput('2026-10-07'), '2026-10-07');
  });

  it('refuses days that do not exist and half-typed text', () => {
    for (const s of ['31/02/2026', '29/02/2027', '00/10/2026', '07/13/2026', '7/10', '7/10/202', 'abc', '', null]) {
      assert.equal(parseDateInput(s), null, String(s));
    }
    assert.equal(parseDateInput('29/02/2028'), '2028-02-29');
  });

  it('round-trips with the field text', () => {
    assert.equal(dateInputText('2026-10-07'), '07/10/2026');
    assert.equal(parseDateInput(dateInputText('2026-10-07')), '2026-10-07');
    assert.equal(dateInputText(''), '');
    assert.equal(dateInputText(null), '');
    assert.equal(dateInputText('2026-02-30'), '');
  });
});

describe('typed times (the time field)', () => {
  it('reads the 24-hour clock', () => {
    assert.equal(parseTimeInput('14:30'), '14:30');
    assert.equal(parseTimeInput('9:05'), '09:05');
    assert.equal(parseTimeInput('9.05'), '09:05');
    assert.equal(parseTimeInput('905'), '09:05');
    assert.equal(parseTimeInput('2130'), '21:30');
    assert.equal(parseTimeInput('9'), '09:00');
    assert.equal(parseTimeInput('00:00'), '00:00');
    assert.equal(parseTimeInput('23:59'), '23:59');
  });

  it('refuses what is not a time', () => {
    for (const s of ['24:00', '12:60', '9:5', '2:30 PM', 'abc', '', null]) {
      assert.equal(parseTimeInput(s), null, String(s));
    }
  });
});
