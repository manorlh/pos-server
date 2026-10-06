/**
 * Run with `npm test`. "ביצועי קיוסקים" / "תקינות מכשירים" — the pure rules of lib/kioskInsights.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  abandonmentRows,
  bucketMinutes,
  buildKioskCsv,
  cardLockKey,
  csvCell,
  durationText,
  filterHealth,
  foldSearch,
  funnelRows,
  healthCounts,
  healthShops,
  kioskCsvFilename,
  knownCode,
  levelTone,
  orderedParts,
  overallTone,
  partCode,
  pctText,
  perKioskValue,
  PER_KIOSK_COLUMNS,
  shekels,
  sortHealth,
  sortRows,
  STEP_CODES,
  type Abandonment,
  type FunnelStage,
  type KioskHealthRow,
  type PerKioskRow,
} from './kioskInsights';

const kioskRow = (over: Partial<PerKioskRow> = {}): PerKioskRow => ({
  machineId: 'm1',
  name: 'קיוסק כניסה',
  machineName: 'קופה 3',
  shopId: 's1',
  shopName: 'הרצליה',
  isKiosk: true,
  sessions: 40,
  paidSessions: 30,
  conversion: 75,
  abandoned: 10,
  orders: 30,
  revenue: 123450,
  avgBasket: 4115,
  itemsPerOrder: 2.5,
  medianOrderSec: 95,
  upsellShown: 20,
  upsellAccepted: 5,
  upsellRate: 25,
  payAttempts: 32,
  payFailures: 2,
  payFailureRate: 6.3,
  ...over,
});

const stage = (key: FunnelStage['key'], sessions: number, dropPct: number | null): FunnelStage => ({
  key,
  rank: 0,
  sessions,
  pctOfStart: null,
  dropToNext: null,
  dropPct,
});

const healthRow = (over: Partial<KioskHealthRow> = {}): KioskHealthRow => ({
  machineId: 'k1',
  name: 'קיוסק רויאל',
  machineName: 'קופה 7',
  posNumber: '7',
  shopId: 's1',
  shopName: 'הרצליה',
  enabled: true,
  platform: 'android',
  appVersion: '1.0.210',
  online: true,
  lastContactAt: '2026-10-07T10:00:00Z',
  lastHeartbeatAt: null,
  network: null,
  screen: 'catalog',
  flowState: 'ordering',
  paused: false,
  pauseMessage: null,
  pausedUntil: null,
  shiftOpen: true,
  fulfillmentMode: 'BON',
  configUpToDate: true,
  overall: 'ok',
  parts: [],
  alerts: [],
  unprintedOrders: [],
  kdsScreens: [],
  ordersToday: 3,
  salesTodayAgorot: 12000,
  lastOrderAt: null,
  ...over,
});

describe('formatting', () => {
  it('durationText writes m:ss, h:mm:ss past an hour, and a dash for nothing', () => {
    assert.equal(durationText(0), '0:00');
    assert.equal(durationText(65), '1:05');
    assert.equal(durationText(59.6), '1:00');
    assert.equal(durationText(3725), '1:02:05');
    assert.equal(durationText(null), '—');
    assert.equal(durationText(undefined), '—');
    assert.equal(durationText(-5), '0:00');
  });

  it('pctText keeps one digit and a dash for null', () => {
    assert.equal(pctText(57.123), '57.1%');
    assert.equal(pctText(0), '0.0%');
    assert.equal(pctText(null), '—');
    assert.equal(pctText(12.345, 0), '12%');
  });

  it('bucketMinutes turns the seconds buckets into minutes, the last one open', () => {
    assert.deepEqual(bucketMinutes({ fromSec: 0, toSec: 60, count: 1 }), { from: 0, to: 1 });
    assert.deepEqual(bucketMinutes({ fromSec: 120, toSec: 180, count: 1 }), { from: 2, to: 3 });
    assert.deepEqual(bucketMinutes({ fromSec: 600, toSec: null, count: 4 }), { from: 10, to: null });
  });

  it('shekels divides agorot without float noise', () => {
    assert.equal(shekels(123450), 1234.5);
    assert.equal(shekels(1), 0.01);
    assert.equal(shekels(null), null);
  });

  it('knownCode accepts only listed codes', () => {
    assert.equal(knownCode(STEP_CODES, 'cart'), 'cart');
    assert.equal(knownCode(STEP_CODES, 'nowhere'), null);
    assert.equal(knownCode(STEP_CODES, null), null);
  });
});

describe('abandonmentRows', () => {
  const a: Abandonment = {
    left: 9,
    worstStep: 'cart',
    endReasons: { paid: 20, abandoned: 6, timeout: 3 },
    byStep: [
      { step: 'pay', count: 2, pct: 22.2, reasons: { cancelled: 1, weird: 1 } as Abandonment['byStep'][number]['reasons'] },
      { step: 'mystery', count: 1, pct: 11.1, reasons: { abandoned: 1 } },
      { step: 'cart', count: 6, pct: 66.7, reasons: { abandoned: 5, timeout: 1 } },
    ],
  };

  it('orders the steps as the kiosk shows them, unknown steps last', () => {
    assert.deepEqual(abandonmentRows(a).map((r) => r.step), ['cart', 'pay', 'mystery']);
  });

  it('fills every reason, folds an unknown reason into open, marks the worst step', () => {
    const [cart, pay] = abandonmentRows(a);
    assert.equal(cart.worst, true);
    assert.equal(pay.worst, false);
    assert.deepEqual(
      { abandoned: cart.abandoned, timeout: cart.timeout, cancelled: cart.cancelled, help: cart.help, reset: cart.reset, open: cart.open },
      { abandoned: 5, timeout: 1, cancelled: 0, help: 0, reset: 0, open: 0 },
    );
    assert.equal(pay.cancelled, 1);
    assert.equal(pay.open, 1);
  });

  it('is empty without data', () => {
    assert.deepEqual(abandonmentRows(null), []);
  });
});

describe('funnelRows', () => {
  it('marks the stage with the largest drop', () => {
    const rows = funnelRows([stage('start', 100, 10), stage('catalog', 90, 40), stage('item', 54, 5), stage('paid', 51, null)]);
    assert.deepEqual(rows.map((r) => r.biggestDrop), [false, true, false, false]);
  });

  it('marks nothing when nobody drops', () => {
    const rows = funnelRows([stage('start', 10, 0), stage('paid', 10, null)]);
    assert.ok(rows.every((r) => !r.biggestDrop));
  });
});

describe('sortRows', () => {
  const rows = [kioskRow({ machineId: 'a', revenue: 500, name: 'בית' }), kioskRow({ machineId: 'b', revenue: 900, name: 'אלף', conversion: null }), kioskRow({ machineId: 'c', revenue: 100, name: 'גימל' })];

  it('sorts numbers both ways', () => {
    assert.deepEqual(sortRows(rows, 'revenue', 'desc').map((r) => r.machineId), ['b', 'a', 'c']);
    assert.deepEqual(sortRows(rows, 'revenue', 'asc').map((r) => r.machineId), ['c', 'a', 'b']);
  });

  it('sorts Hebrew text', () => {
    assert.deepEqual(sortRows(rows, 'name', 'asc').map((r) => r.name), ['אלף', 'בית', 'גימל']);
  });

  it('keeps empty values last in either direction and does not mutate', () => {
    assert.equal(sortRows(rows, 'conversion', 'asc')[2].machineId, 'b');
    assert.equal(sortRows(rows, 'conversion', 'desc')[2].machineId, 'b');
    assert.deepEqual(rows.map((r) => r.machineId), ['a', 'b', 'c']);
  });
});

describe('CSV', () => {
  it('csvCell quotes what breaks a row and neutralises formulas', () => {
    assert.equal(csvCell('plain'), 'plain');
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('say "hi"'), '"say ""hi"""');
    assert.equal(csvCell('=SUM(A1)'), "'=SUM(A1)");
    assert.equal(csvCell(-12.5), '-12.5');
    assert.equal(csvCell(null), '');
  });

  it('perKioskValue sends money in shekels and falls back to the till name', () => {
    const row = kioskRow({ name: null });
    assert.equal(perKioskValue(row, 'name'), 'קופה 3');
    assert.equal(perKioskValue(row, 'revenue'), 1234.5);
    assert.equal(perKioskValue(row, 'avgBasket'), 41.15);
    assert.equal(perKioskValue(row, 'medianOrderSec'), 95);
    assert.equal(perKioskValue(kioskRow({ avgBasket: null }), 'avgBasket'), null);
  });

  it('buildKioskCsv writes the BOM, three titled blocks apart by blank lines, CRLF rows', () => {
    const csv = buildKioskCsv(
      {
        period: { from: '2026-09-01', to: '2026-09-28', days: 28, prevFrom: '2026-08-04', prevTo: '2026-08-31' },
        perKiosk: [kioskRow(), kioskRow({ machineId: 'm2', name: 'קיוסק, בר', revenue: 0, avgBasket: null })],
        funnel: [{ key: 'start', rank: 0, sessions: 40, pctOfStart: 100, dropToNext: 4, dropPct: 10 }],
        abandonment: { left: 1, worstStep: 'cart', endReasons: {}, byStep: [{ step: 'cart', count: 1, pct: 100, reasons: { timeout: 1 } }] },
      },
      (key) => `<${key}>`,
    );
    assert.ok(csv.startsWith('﻿'));
    assert.ok(csv.endsWith('\r\n'));
    const lines = csv.slice(1).split('\r\n');
    assert.equal(lines[0], '<csv.title>,2026-09-01 – 2026-09-28');
    assert.equal(lines[1], '');
    assert.equal(lines[2], '<csv.perKiosk>');
    assert.equal(lines[3], PER_KIOSK_COLUMNS.map((c) => `<csv.col.${c}>`).join(','));
    assert.equal(lines[4], 'קיוסק כניסה,הרצליה,40,30,75,10,30,1234.5,41.15,2.5,95,20,5,25,32,2,6.3');
    assert.ok(lines[5].startsWith('"קיוסק, בר",הרצליה,40,'));
    assert.ok(lines[5].includes(',0,,2.5,'));
    assert.equal(lines[6], '');
    assert.equal(lines[7], '<csv.funnel>');
    assert.equal(lines[9], '<funnel.start>,40,100,4,10');
    assert.equal(lines[10], '');
    assert.equal(lines[11], '<csv.abandonment>');
    assert.equal(lines[12], '<csv.col.step>,<csv.col.left>,<csv.col.leftPct>,<reasons.abandoned>,<reasons.timeout>,<reasons.cancelled>,<reasons.help>,<reasons.reset>,<reasons.open>');
    assert.equal(lines[13], '<steps.cart>,1,100,0,1,0,0,0,0');
    assert.equal(lines.length, 15); // the trailing CRLF leaves one empty tail
  });

  it('an unknown step goes out as its code', () => {
    const csv = buildKioskCsv(
      {
        period: { from: '2026-09-01', to: '2026-09-07', days: 7, prevFrom: '', prevTo: '' },
        perKiosk: [],
        funnel: [],
        abandonment: { left: 1, worstStep: null, endReasons: {}, byStep: [{ step: 'mystery', count: 1, pct: 100, reasons: {} }] },
      },
      (key) => key,
    );
    assert.ok(csv.includes('\r\nmystery,1,100,0,0,0,0,0,0\r\n'));
  });

  it('kioskCsvFilename names the period', () => {
    assert.equal(kioskCsvFilename({ from: '2026-09-01', to: '2026-09-28' }), 'kiosk-performance_2026-09-01_2026-09-28.csv');
    assert.equal(kioskCsvFilename({ from: '../x', to: '2026/09' }), 'kiosk-performance_x_202609.csv');
  });
});

describe('device health', () => {
  const rows = [
    healthRow({ machineId: 'a', name: 'קיוסק בר', overall: 'ok', shopId: 's2', shopName: 'תל אביב' }),
    healthRow({ machineId: 'b', name: 'קיוסק כניסה', overall: 'error' }),
    healthRow({ machineId: 'c', name: 'Kiosk Lobby', overall: 'offline', posNumber: '12' }),
    healthRow({ machineId: 'd', name: 'קיוסק ישן', overall: 'off', enabled: false }),
    healthRow({ machineId: 'e', name: 'קיוסק צד', overall: 'warn' }),
  ];

  it('sortHealth puts the worst first', () => {
    assert.deepEqual(sortHealth(rows).map((r) => r.machineId), ['b', 'c', 'e', 'a', 'd']);
  });

  it('filterHealth filters by state, shop and a folded search', () => {
    assert.deepEqual(filterHealth(rows, { overall: 'error', shopId: '', search: '' }).map((r) => r.machineId), ['b']);
    assert.deepEqual(filterHealth(rows, { overall: '', shopId: 's2', search: '' }).map((r) => r.machineId), ['a']);
    assert.deepEqual(filterHealth(rows, { overall: '', shopId: '', search: '  lobby ' }).map((r) => r.machineId), ['c']);
    assert.deepEqual(filterHealth(rows, { overall: '', shopId: '', search: 'תל אביב' }).map((r) => r.machineId), ['a']);
    assert.deepEqual(filterHealth(rows, { overall: '', shopId: '', search: '12' }).map((r) => r.machineId), ['c']);
    assert.equal(filterHealth(rows, { overall: '', shopId: '', search: '' }).length, 5);
  });

  it('foldSearch drops niqqud and geresh', () => {
    assert.equal(foldSearch('  קִיוֹסְק  ״א״ '), 'קיוסק א');
  });

  it('healthShops lists each shop once by name', () => {
    assert.deepEqual(healthShops(rows), [
      { id: 's1', name: 'הרצליה' },
      { id: 's2', name: 'תל אביב' },
    ]);
  });

  it('healthCounts prefers the server counts and counts the rows otherwise', () => {
    assert.deepEqual(healthCounts({ kiosks: rows }), { error: 1, offline: 1, warn: 1, ok: 1, off: 1 });
    assert.deepEqual(healthCounts({ kiosks: rows, counts: { ok: 7, warn: 2 } }), { error: 0, offline: 0, warn: 2, ok: 7, off: 0 });
  });

  it('orders the parts and knows their codes', () => {
    const row = healthRow({
      parts: [
        { key: 'uploads', level: 'ok', code: 'none', detail: {} },
        { key: 'app', level: 'ok', code: 'running', detail: { screen: 'cart' } },
        { key: 'terminal', level: 'error', code: 'card_lock', detail: { lock: 'mismatch' } },
      ],
    });
    assert.deepEqual(orderedParts(row).map((p) => p.key), ['app', 'terminal', 'uploads']);
    assert.equal(partCode({ key: 'printer', code: 'no_paper' }), 'no_paper');
    assert.equal(partCode({ key: 'printer', code: 'jammed' }), null);
    assert.equal(partCode({ key: 'terminal', code: 'no_paper' }), null);
  });

  it('cardLockKey reads both the bare and the alert form', () => {
    assert.equal(cardLockKey('mismatch'), 'mismatch');
    assert.equal(cardLockKey('terminal_mismatch'), 'mismatch');
    assert.equal(cardLockKey('terminal_not_configured'), 'not_configured');
    assert.equal(cardLockKey('terminal_unknown'), 'unknown');
    assert.equal(cardLockKey('other'), null);
    assert.equal(cardLockKey(null), null);
  });

  it('tones', () => {
    assert.equal(levelTone('error'), 'error');
    assert.equal(levelTone('unknown'), 'muted');
    assert.equal(levelTone('off'), 'muted');
    assert.equal(overallTone('offline'), 'error');
    assert.equal(overallTone('off'), 'muted');
    assert.equal(overallTone('warn'), 'warn');
  });
});
