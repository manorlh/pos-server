import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  DEFAULT_END_HOUR,
  MAX_END_HOUR,
  MIN_END_HOUR,
  addDays,
  businessDayOf,
  businessDayStart,
  businessDayToday,
  crossMonthLine,
  dayBasisQuery,
  documentMonths,
  normalizeEndHour,
  setCurrentEndHour,
  shekels,
  wallClock,
} from './businessDay';

/**
 * The golden fixture shared with the server and the till (pos-server
 * server/tests/fixtures/business_day_golden.json). `npm test` runs in client/, beside server/.
 * The SHA-256 (LF line endings) is the same constant in tests/test_business_day.py and the till's
 * BusinessDayTest: change the fixture in both repositories, and every constant, together.
 */
const GOLDEN_SHA256 = '1b881752fc089378c9213024647ab2593449147a47d07be08aa2eb28de60552e';
const GOLDEN_PATH = resolve(process.cwd(), '..', 'server', 'tests', 'fixtures', 'business_day_golden.json');

interface Golden {
  defaultEndHour: number;
  minEndHour: number;
  maxEndHour: number;
  endHours: { input: unknown; hour: number }[];
  days: { name: string; at: string; tz: string; endHour: number; local: string; businessDay: string }[];
  starts: { name: string; businessDay: string; tz: string; endHour: number; startsAt: string }[];
  documentMonths: {
    name: string;
    tz: string;
    documents: { at: string; amount: string }[];
    months: { month: string; total: string }[];
    line: string | null;
  }[];
}

const text = existsSync(GOLDEN_PATH) ? readFileSync(GOLDEN_PATH, 'utf8').replace(/\r\n/g, '\n') : null;
const golden: Golden | null = text ? (JSON.parse(text) as Golden) : null;

test('the fixture is the pinned one', { skip: text === null }, () => {
  assert.equal(createHash('sha256').update(text as string, 'utf8').digest('hex'), GOLDEN_SHA256);
});

test('the bounds are the fixture’s', { skip: golden === null }, () => {
  const g = golden as Golden;
  assert.deepEqual([DEFAULT_END_HOUR, MIN_END_HOUR, MAX_END_HOUR], [g.defaultEndHour, g.minEndHour, g.maxEndHour]);
});

test('end hours are normalised as the server and the till do', { skip: golden === null }, () => {
  for (const c of (golden as Golden).endHours) assert.equal(normalizeEndHour(c.input), c.hour, JSON.stringify(c.input));
});

test('every golden moment is on its business day', { skip: golden === null }, () => {
  for (const c of (golden as Golden).days) {
    assert.equal(businessDayOf(c.at, c.tz, c.endHour), c.businessDay, c.name);
    const w = wallClock(c.at, c.tz);
    const local = `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}T${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}`;
    assert.ok(`${local}:${String(w.second).padStart(2, '0')}`.startsWith(c.local), `${c.name}: ${local}`);
  }
});

test('every golden business day starts when the fixture says', { skip: golden === null }, () => {
  for (const c of (golden as Golden).starts) {
    const start = businessDayStart(c.businessDay, c.tz, c.endHour);
    assert.equal(start.toISOString().replace('.000Z', 'Z'), c.startsAt, c.name);
    assert.equal(businessDayOf(start, c.tz, c.endHour), c.businessDay, c.name);
    assert.equal(businessDayOf(start.getTime() - 1000, c.tz, c.endHour), addDays(c.businessDay, -1), c.name);
  }
});

test('a Z’s documents by month, and the line only across months', { skip: golden === null }, () => {
  for (const c of (golden as Golden).documentMonths) {
    const months = documentMonths(c.documents, c.tz);
    assert.deepEqual(months, c.months, c.name);
    assert.equal(crossMonthLine(months), c.line, c.name);
  }
});

test('the owner’s example without the fixture: 01:00 on 1.10 is 30.9', () => {
  assert.equal(businessDayOf('2026-09-30T22:00:00Z', 'Asia/Jerusalem', 4), '2026-09-30');
  assert.equal(businessDayOf('2026-09-30T22:00:00Z', 'Asia/Jerusalem', 0), '2026-10-01');
  assert.equal(businessDayToday(Date.parse('2026-09-30T22:00:00Z'), 'Asia/Jerusalem', 4), '2026-09-30');
});

test('today follows the scope’s hour once it is known', () => {
  const oneAm = Date.parse('2026-09-30T22:00:00Z');
  setCurrentEndHour(0);
  assert.equal(businessDayToday(oneAm), '2026-10-01');
  setCurrentEndHour('nonsense');
  assert.equal(businessDayToday(oneAm), '2026-09-30');
});

test('the line in English, shekels, and the basis query', () => {
  const months = [
    { month: '2026-09', total: '1234.5' },
    { month: '2026-10', total: '-25.00' },
  ];
  assert.equal(crossMonthLine(months, 'en'), 'Of this Z: ₪1,234.50 of September documents · -₪25.00 of October documents (report by document date)');
  assert.equal(crossMonthLine([months[0]]), null);
  assert.equal(shekels('0.29'), '₪0.29');
  assert.deepEqual(dayBasisQuery('business'), {});
  assert.deepEqual(dayBasisQuery('document'), { dayBasis: 'document' });
});
