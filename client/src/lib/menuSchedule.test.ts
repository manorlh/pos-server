/**
 * Run with `npm test`. "תפריטים" — which menu is active when (lib/menuSchedule.ts), pinned
 * to the server's rules by the shared golden fixtures
 * (pos-server server/tests/fixtures/catalog_menus_golden.json, the same bytes as
 * pos-android's test resources).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
  crossesMidnight,
  daysSummary,
  isWholeDayRange,
  localNowIn,
  menuErrorCode,
  minutesOf,
  nextDateOnWeekday,
  normalizeDays,
  parseLocalMoment,
  rangeSummary,
  resolve,
  scheduleActive,
  scheduleProblems,
  scheduleSummary,
  simulatorAt,
  weekdayOf,
  type MenuBlock,
  type MenuSchedule,
  type MenuSurface,
} from './menuSchedule';

interface GoldenCase {
  name: string;
  at: string;
  surface: MenuSurface;
  block: string;
  expected: {
    resolution: {
      mode: string;
      menuId: string | null;
      menuName: string | null;
      level: string | null;
      depth: number | null;
      priority: number | null;
    };
  };
}

interface Golden {
  blocks: Record<string, MenuBlock>;
  cases: GoldenCase[];
}

/** `npm test` runs in client/: the server's fixtures are next door. */
function goldenPath(): string {
  const candidates = [
    join(process.cwd(), '..', 'server', 'tests', 'fixtures', 'catalog_menus_golden.json'),
    join(__dirname, '..', '..', 'server', 'tests', 'fixtures', 'catalog_menus_golden.json'),
  ];
  const found = candidates.find((p) => existsSync(p));
  assert.ok(found, `golden fixtures not found at ${candidates.join(' or ')}`);
  return found;
}

describe('the golden fixtures (the server, the till and the kiosk agree)', () => {
  const golden = JSON.parse(readFileSync(goldenPath(), 'utf8')) as Golden;

  it('has cases', () => {
    assert.ok(golden.cases.length >= 20);
  });

  for (const c of golden.cases) {
    it(`${c.block} ${c.at} ${c.surface}: ${c.name}`, () => {
      const block = golden.blocks[c.block];
      assert.ok(block, `no block ${c.block}`);
      const got = resolve(block, c.at, c.surface);
      const want = c.expected.resolution;
      assert.deepEqual(
        {
          mode: got.mode,
          menuId: got.menuId,
          menuName: got.menuName,
          level: got.level,
          depth: got.depth,
          priority: got.priority,
        },
        {
          mode: want.mode,
          menuId: want.menuId,
          menuName: want.menuName,
          level: want.level,
          depth: want.depth,
          priority: want.priority,
        },
      );
    });
  }
});

describe('reading the clock', () => {
  it('reads strict two-digit HH:MM only', () => {
    assert.equal(minutesOf('00:00'), 0);
    assert.equal(minutesOf('23:59'), 23 * 60 + 59);
    assert.equal(minutesOf('7:05'), null);
    assert.equal(minutesOf('24:00'), null);
    assert.equal(minutesOf('12:60'), null);
    assert.equal(minutesOf('1a:00'), null);
    assert.equal(minutesOf(null), null);
  });

  it('parses a naive local moment without time zones, weekday 0 = Sunday', () => {
    assert.deepEqual(parseLocalMoment('2026-10-06T08:30'), { day: parseLocalMoment('2026-10-06T00:00')!.day, minute: 510 });
    assert.equal(parseLocalMoment('2026-02-30T08:30'), null);
    assert.equal(weekdayOf('2026-10-06'), 2); // Tuesday
    assert.equal(weekdayOf('2026-10-11'), 0); // Sunday
    assert.equal(weekdayOf('2026-10-10'), 6); // Saturday
  });
});

describe('scheduleActive', () => {
  const s = (patch: Partial<MenuSchedule> & Record<string, unknown>) => ({
    always: false,
    days: null,
    ranges: [],
    ...patch,
  });

  it('start inclusive, end exclusive', () => {
    const lunch = s({ ranges: [{ start: '11:30', end: '17:00' }] });
    assert.equal(scheduleActive(lunch, '2026-10-06T11:29'), false);
    assert.equal(scheduleActive(lunch, '2026-10-06T11:30'), true);
    assert.equal(scheduleActive(lunch, '2026-10-06T16:59'), true);
    assert.equal(scheduleActive(lunch, '2026-10-06T17:00'), false);
  });

  it('a range across midnight belongs to the day it started', () => {
    const tuesdayNight = s({ days: [2], ranges: [{ start: '22:00', end: '02:00' }] });
    assert.equal(scheduleActive(tuesdayNight, '2026-10-06T22:00'), true);
    assert.equal(scheduleActive(tuesdayNight, '2026-10-07T01:59'), true); // Wednesday, Tuesday's night
    assert.equal(scheduleActive(tuesdayNight, '2026-10-07T02:00'), false);
    assert.equal(scheduleActive(tuesdayNight, '2026-10-06T01:00'), false); // Monday's night
  });

  it('00:00–00:00 is the whole day; 06:00–06:00 is 24 hours from 06:00', () => {
    const monday = s({ days: [1], ranges: [{ start: '00:00', end: '00:00' }] });
    assert.equal(scheduleActive(monday, '2026-10-05T00:00'), true);
    assert.equal(scheduleActive(monday, '2026-10-05T23:59'), true);
    assert.equal(scheduleActive(monday, '2026-10-06T00:00'), false);
    const tuesday6 = s({ days: [2], ranges: [{ start: '06:00', end: '06:00' }] });
    assert.equal(scheduleActive(tuesday6, '2026-10-07T05:59'), true);
    assert.equal(scheduleActive(tuesday6, '2026-10-07T06:00'), false);
    assert.equal(scheduleActive(tuesday6, '2026-10-06T05:59'), false);
  });

  it('no ranges: the whole day; ranges none of which reads: never; no days: never', () => {
    assert.equal(scheduleActive(s({}), '2026-10-06T03:00'), true);
    // The block's spelling of ranges, as the till gets them.
    assert.equal(scheduleActive({ days: null, ranges: [['25:00', '26:00'], ['7:5', '08:00']] }, '2026-10-06T07:30'), false);
    assert.equal(scheduleActive({ days: null, ranges: [['07:00', '08:00']] }, '2026-10-06T07:30'), true);
    assert.equal(scheduleActive(s({ days: [] }), '2026-10-06T12:00'), false);
    assert.equal(scheduleActive(s({ days: [3] }), '2026-10-06T12:00'), false);
  });

  it('always: any hour of any day, the date range still applies (inclusive)', () => {
    const holiday = s({ always: true, days: [], validFrom: '2026-12-24', validTo: '2026-12-26' });
    assert.equal(scheduleActive(holiday, '2026-12-23T23:59'), false);
    assert.equal(scheduleActive(holiday, '2026-12-24T00:00'), true);
    assert.equal(scheduleActive(holiday, '2026-12-26T23:59'), true);
    assert.equal(scheduleActive(holiday, '2026-12-27T00:00'), false);
    // The block's own spelling of the dates.
    assert.equal(scheduleActive({ always: true, from: '2026-12-24', to: null }, '2026-12-25T10:00'), true);
  });

  it('the hours after midnight keep the date they started on', () => {
    const lastNight = s({ ranges: [{ start: '22:00', end: '02:00' }], validTo: '2026-10-06' });
    assert.equal(scheduleActive(lastNight, '2026-10-07T01:00'), true);
    assert.equal(scheduleActive(lastNight, '2026-10-07T22:30'), false);
  });
});

describe('resolve beyond the fixtures', () => {
  const block = (assignments: unknown[], menus: unknown[], fallback = 'catalog'): MenuBlock => ({ fallback, menus, assignments });
  const always = { always: true, days: null, ranges: [] };

  it('the most specific level wins whatever the priorities; a company above loses to its own', () => {
    const b = block(
      [
        { menuId: 'm-org', level: 'company', depth: 1, priority: 1000 },
        { menuId: 'm-own', level: 'company', depth: 0, priority: 0 },
        { menuId: 'm-till', level: 'machine', depth: 0, priority: -5 },
      ],
      [
        { id: 'm-org', name: 'ארגון', channel: 'both', schedule: always },
        { id: 'm-own', name: 'חברה', channel: 'both', schedule: always },
        { id: 'm-till', name: 'קופה', channel: 'pos', schedule: always },
      ],
    );
    assert.equal(resolve(b, '2026-10-06T10:00', 'pos').menuId, 'm-till');
    assert.equal(resolve(b, '2026-10-06T10:00', 'kiosk').menuId, 'm-own');
  });

  it('ties: priority, then name, then id', () => {
    const b = block(
      [
        { menuId: 'b', level: 'shop', priority: 1 },
        { menuId: 'a', level: 'shop', priority: 1 },
      ],
      [
        { id: 'b', name: 'זהה', schedule: always },
        { id: 'a', name: 'זהה', schedule: always },
      ],
    );
    assert.equal(resolve(b, '2026-10-06T10:00').menuId, 'a');
  });

  it('nothing active: the fallback', () => {
    assert.equal(resolve(block([], [], 'none'), '2026-10-06T10:00').mode, 'none');
    assert.equal(resolve(block([], [], 'whatever'), '2026-10-06T10:00').mode, 'catalog');
    assert.equal(resolve(null, '2026-10-06T10:00').mode, 'catalog');
  });
});

describe('the editor', () => {
  it('summarises a schedule in Hebrew', () => {
    assert.equal(
      scheduleSummary({ always: false, days: [0, 1, 2, 3, 4], ranges: [{ start: '11:30', end: '17:00' }] }),
      'א׳–ה׳ · 11:30–17:00',
    );
    assert.equal(scheduleSummary({ always: true, days: null, ranges: [] }), 'תמיד');
    assert.equal(scheduleSummary({ always: false, days: null, ranges: [] }), 'כל יום · כל היום');
    assert.equal(
      scheduleSummary({ always: true, days: null, ranges: [], validFrom: '2026-12-24', validTo: '2026-12-26' }),
      'תמיד · 24/12/2026–26/12/2026',
    );
    assert.equal(
      scheduleSummary({
        always: false,
        days: [4, 5],
        ranges: [{ start: '22:00', end: '02:00' }],
        validFrom: '2026-10-01',
      }),
      'ה׳ ו׳ · 22:00–02:00 (למחרת) · מ-01/10/2026',
    );
    assert.equal(daysSummary([0, 2, 4]), 'א׳ ג׳ ה׳');
    assert.equal(daysSummary([0, 1, 2, 4, 5, 6]), 'א׳–ג׳ ה׳–ש׳');
    assert.equal(daysSummary([0, 1, 2, 3, 4, 5, 6]), 'כל יום');
    assert.equal(rangeSummary({ start: '00:00', end: '00:00' }), 'כל היום');
  });

  it('tells a range that runs into the next morning', () => {
    assert.equal(crossesMidnight({ start: '22:00', end: '02:00' }), true);
    assert.equal(crossesMidnight({ start: '06:00', end: '06:00' }), true);
    assert.equal(crossesMidnight({ start: '00:00', end: '00:00' }), false);
    assert.equal(isWholeDayRange({ start: '00:00', end: '00:00' }), true);
    assert.equal(crossesMidnight({ start: '11:30', end: '17:00' }), false);
    assert.equal(crossesMidnight({ start: '', end: '02:00' }), false);
  });

  it('validates as the server does', () => {
    assert.deepEqual(scheduleProblems({ always: false, days: [], ranges: [] }), ['no_days']);
    assert.deepEqual(scheduleProblems({ always: true, days: [], ranges: [] }), []);
    assert.deepEqual(scheduleProblems({ always: false, days: null, ranges: [{ start: '7:00', end: '08:00' }] }), ['bad_time']);
    assert.deepEqual(
      scheduleProblems({
        always: false,
        days: null,
        ranges: Array.from({ length: 9 }, () => ({ start: '08:00', end: '09:00' })),
      }),
      ['too_many_ranges'],
    );
    assert.deepEqual(
      scheduleProblems({ always: true, days: null, ranges: [], validFrom: '2026-12-26', validTo: '2026-12-24' }),
      ['dates_reversed'],
    );
    assert.deepEqual(normalizeDays([3, 1, 1]), [1, 3]);
    assert.equal(normalizeDays([0, 1, 2, 3, 4, 5, 6]), null);
    assert.deepEqual(normalizeDays([]), []);
  });
});

describe('the simulator', () => {
  it('picks the coming date on the weekday, today when it is one', () => {
    assert.equal(nextDateOnWeekday('2026-10-06', 2), '2026-10-06');
    assert.equal(nextDateOnWeekday('2026-10-06', 3), '2026-10-07');
    assert.equal(nextDateOnWeekday('2026-10-06', 1), '2026-10-12');
    assert.equal(nextDateOnWeekday('2026-10-06', 0), '2026-10-11');
    assert.equal(nextDateOnWeekday('2026-12-30', 5), '2027-01-01');
    assert.equal(simulatorAt('2026-10-06', 5, '18:00'), '2026-10-09T18:00');
    assert.equal(simulatorAt('2026-10-06', 5, '18:00', '2026-12-24'), '2026-12-24T18:00');
  });

  it("reads the shop's wall clock", () => {
    assert.equal(localNowIn('Asia/Jerusalem', new Date('2026-10-06T05:30:00Z')), '2026-10-06T08:30');
    assert.equal(localNowIn('Asia/Jerusalem', new Date('2026-12-06T22:15:00Z')), '2026-12-07T00:15');
    assert.equal(localNowIn('UTC', new Date('2026-10-06T23:05:00Z')), '2026-10-06T23:05');
  });
});

describe('errors', () => {
  it('finds the code in a detail', () => {
    assert.equal(menuErrorCode('catalog_menu_forbidden'), 'catalog_menu_forbidden');
    assert.equal(menuErrorCode('menu_forbidden'), 'menu_forbidden');
    assert.equal(menuErrorCode('catalog_menu_out_of_reach'), 'catalog_menu_out_of_reach');
    assert.equal(
      menuErrorCode([{ loc: ['body'], msg: 'Value error, menu_no_days', type: 'value_error' }]),
      'menu_no_days',
    );
    assert.equal(
      menuErrorCode([{ loc: ['body', 'ranges', 0, 'start'], msg: 'Value error, time must be HH:MM' }]),
      'menu_bad_hhmm',
    );
    assert.equal(
      menuErrorCode([{ loc: ['body', 'products', 0, 'price'], msg: 'Input should be greater than or equal to 0' }]),
      'menu_bad_price',
    );
    assert.equal(menuErrorCode('Not Found'), null);
    assert.equal(menuErrorCode(undefined), null);
  });
});

describe('the menus pages: their texts exist in he.json', () => {
  // Every literal key the page and its components ask for (t('…') under their
  // useTranslations namespaces) must be in the messages, or it shows as its raw path.
  it('has every literal key', () => {
    const root = join(process.cwd(), 'src');
    const messages = JSON.parse(readFileSync(join(root, 'messages', 'he.json'), 'utf8')) as Record<string, unknown>;
    const has = (path: string) =>
      path
        .split('.')
        .reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), messages) !==
      undefined;
    const dir = join(root, 'components', 'dashboard', 'catalog-menus');
    const files = [
      ...readdirSync(dir)
        .filter((f) => f.endsWith('.tsx'))
        .map((f) => join(dir, f)),
      join(root, 'app', 'dashboard', 'menus', 'page.tsx'),
    ];
    const missing: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, 'utf8');
      const spaces = new Map<string, Set<string>>();
      for (const [, name, ns] of src.matchAll(/const\s+(\w+)\s*=\s*useTranslations\(\s*'([^']*)'\s*\)/g)) {
        if (!spaces.has(name)) spaces.set(name, new Set());
        spaces.get(name)!.add(ns);
      }
      for (const [name, set] of spaces) {
        const call = new RegExp(String.raw`(?<![\w.])${name}(?:\.rich)?\(\s*'([A-Za-z0-9_.]+)'`, 'g');
        for (const [, key] of src.matchAll(call)) {
          if (![...set].some((ns) => has(ns ? `${ns}.${key}` : key))) missing.push(`${file}: ${[...set].join('|')}.${key}`);
        }
      }
    }
    assert.deepEqual(missing, []);
  });
});
