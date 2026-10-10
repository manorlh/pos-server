import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toExcelDate, uniqueSheetName, wallClockUtc } from './excelExport';

test('a timestamp is written as the Israel wall clock (summer, UTC+3)', () => {
  const cell = toExcelDate('2026-07-01T21:30:00Z', 'datetime') as Date;
  assert.equal(cell.toISOString(), '2026-07-02T00:30:00.000Z');
});

test('winter is UTC+2', () => {
  const wall = wallClockUtc(new Date('2026-12-01T10:00:00Z'));
  assert.equal(wall.toISOString(), '2026-12-01T12:00:00.000Z');
});

test('a date column takes the Israel day of a late-night timestamp', () => {
  const cell = toExcelDate('2026-07-01T22:30:00Z', 'date') as Date;
  assert.equal(cell.toISOString(), '2026-07-02T00:00:00.000Z');
});

test('a plain business date is that day, never shifted', () => {
  const cell = toExcelDate('2026-09-27', 'datetime') as Date;
  assert.equal(cell.toISOString(), '2026-09-27T00:00:00.000Z');
});

test('text that is no date stays text', () => {
  assert.equal(toExcelDate('לא תאריך', 'date'), 'לא תאריך');
});

test('sheet names: forbidden characters out, 31 characters, a repeat numbered', () => {
  const used = new Set<string>();
  assert.equal(uniqueSheetName('זדים/קופות', used), 'זדים קופות');
  assert.equal(uniqueSheetName('זדים/קופות', used), 'זדים קופות (2)');
  assert.equal(uniqueSheetName('א'.repeat(40), used).length, 31);
  assert.equal(uniqueSheetName('', used), 'Report');
});
