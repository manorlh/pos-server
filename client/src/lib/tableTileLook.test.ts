/**
 * Run with `npm test`. "עיצוב השולחנות" — the till design's "שולחנות ומפה" helpers (lib/tableTileLook.ts):
 * the till parameters as the till reads them, the stored forms byte for byte the server's (pos-server
 * app/services/table_tile_look.py, tests/test_till_design_tables.py), the colours a table is drawn in
 * and the sample floor of the preview. The contract: P:/specs/till-design-tables.md §5.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_STATE_COLORS,
  INFO_NONE,
  NUMBER_SCALE,
  SAMPLE_ORDER,
  TABLE_STATES,
  TILE_INFO_FIELDS,
  TILE_LOOK_DEFAULTS,
  TILE_LOOK_KEYS,
  changedParams,
  changedStates,
  effectiveParams,
  formatStateColors,
  formatTileInfo,
  inkOn,
  luminance,
  minutesText,
  mixHex,
  overdueError,
  parseOverdue,
  parseStateColors,
  parseTileInfo,
  parseTileStyle,
  resolveTileLook,
  sampleState,
  sampleTable,
  setsItself,
  stateWord,
  tileColors,
  tileInfoLines,
  toggleTileInfo,
  withStateColor,
} from './tableTileLook';

/** The server's default, pinned in tests/test_till_design_tables.py and the spec's §5. */
const SERVER_DEFAULT_COLORS =
  '{"free":"#34c759","occupied":"#3b82f6","kitchen":"#f97316","toPay":"#ff9500","otherTill":"#af52de","overdue":"#ff3b30","reserved":"#30b0c7"}';

describe('the parameters', () => {
  it('are the server\'s five, with its defaults', () => {
    assert.deepEqual([...TILE_LOOK_KEYS], ['tableTileStyle', 'tableTileInfo', 'tableStateColors', 'tableOverdueMinutes', 'tableNumberSize']);
    assert.deepEqual(TILE_LOOK_DEFAULTS, {
      tableTileStyle: 'soft',
      tableTileInfo: 'guests,time,amount',
      tableStateColors: SERVER_DEFAULT_COLORS,
      tableOverdueMinutes: 45,
      tableNumberSize: 'm',
    });
    assert.deepEqual(TABLE_STATES, ['free', 'occupied', 'kitchen', 'toPay', 'otherTill', 'overdue', 'reserved']);
    assert.deepEqual(TILE_INFO_FIELDS, ['guests', 'time', 'amount', 'waiter', 'course', 'seats']);
  });

  it('read nothing they do not know: the default', () => {
    const look = resolveTileLook({});
    assert.equal(look.style, 'soft');
    assert.deepEqual(look.info, ['guests', 'time', 'amount']);
    assert.deepEqual(look.colors, DEFAULT_STATE_COLORS);
    assert.equal(look.overdueMinutes, 45);
    assert.equal(look.numberScale, 1);
    assert.equal(parseTileStyle('Filled'), 'soft');
    assert.equal(parseOverdue(4), 45);
    assert.equal(parseOverdue(601), 45);
    assert.equal(parseOverdue('30'), 30);
    assert.equal(overdueError('30'), null);
    assert.equal(overdueError('4'), 'range');
    assert.equal(overdueError('601'), 'range');
    assert.equal(overdueError('4.5'), 'range');
    assert.deepEqual(NUMBER_SCALE, { s: 0.8, m: 1, l: 1.25 });
    const set = resolveTileLook({ tableTileStyle: 'outline', tableTileInfo: 'none', tableOverdueMinutes: 90, tableNumberSize: 'l' });
    assert.deepEqual([set.style, set.info, set.overdueMinutes, set.numberScale], ['outline', [], 90, 1.25]);
  });
});

describe('what is written on a table', () => {
  it('is kept in the till\'s order, `none` for the number only', () => {
    assert.deepEqual(parseTileInfo('waiter, guests'), ['guests', 'waiter']);
    assert.deepEqual(parseTileInfo('SEATS,price'), ['seats']);
    assert.deepEqual(parseTileInfo(INFO_NONE), []);
    assert.deepEqual(parseTileInfo(undefined), ['guests', 'time', 'amount']);
    assert.equal(formatTileInfo(['waiter', 'guests']), 'guests,waiter');
    assert.equal(formatTileInfo([]), 'none');
    assert.equal(toggleTileInfo('guests,time,amount', 'waiter'), 'guests,time,amount,waiter');
    assert.equal(toggleTileInfo('guests,time,amount', 'time'), 'guests,amount');
    assert.equal(toggleTileInfo('guests', 'guests'), 'none');
    assert.equal(toggleTileInfo('none', 'course'), 'course');
  });

  it('writes only what the sample table has, in order', () => {
    const busy = sampleTable('kitchen', 0, 4, 45);
    assert.deepEqual(tileInfoLines(['guests', 'time', 'amount'], busy), ['4 סועדים', '34 דק׳', '₪218']);
    assert.deepEqual(tileInfoLines(['waiter', 'guests'], busy), ['4 סועדים', 'דנה']);
    // A free table: only its seats.
    assert.deepEqual(tileInfoLines(['guests', 'time', 'seats'], sampleTable('free', 1, 6, 45)), ['6 מקומות']);
    assert.deepEqual(tileInfoLines([], busy), []);
    assert.equal(minutesText(34), '34 דק׳');
    assert.equal(minutesText(72), '1:12 ש׳');
  });
});

describe('the colours', () => {
  it('are stored whole, lower case and in order — the server\'s bytes', () => {
    assert.equal(formatStateColors(DEFAULT_STATE_COLORS), SERVER_DEFAULT_COLORS);
    assert.equal(formatStateColors({ occupied: '#16A34A' }), SERVER_DEFAULT_COLORS.replace('#3b82f6', '#16a34a'));
    assert.equal(withStateColor(SERVER_DEFAULT_COLORS, 'occupied', '#16A34A'), SERVER_DEFAULT_COLORS.replace('#3b82f6', '#16a34a'));
  });

  it('read leniently: a state missing or not #rrggbb is today\'s', () => {
    assert.deepEqual(parseStateColors('not json'), DEFAULT_STATE_COLORS);
    assert.deepEqual(parseStateColors('{"free":"#FFF","toPay":"#123456"}'), { ...DEFAULT_STATE_COLORS, toPay: '#123456' });
    assert.deepEqual(parseStateColors({ overdue: '#000000' }), { ...DEFAULT_STATE_COLORS, overdue: '#000000' });
    assert.deepEqual(changedStates(parseStateColors('{"occupied":"#16a34a"}')), ['occupied']);
    assert.deepEqual(changedStates(DEFAULT_STATE_COLORS), []);
  });

  it('draw a table soft, filled or outlined', () => {
    const soft = tileColors('soft', '#3b82f6');
    assert.equal(soft.stroke, '#3b82f6');
    assert.notEqual(soft.fill, '#3b82f6');
    assert.equal(soft.number, '#1e293b');
    const filled = tileColors('filled', '#3b82f6');
    assert.equal(filled.fill, '#3b82f6');
    assert.equal(filled.number, '#ffffff');
    // On a light colour, dark words (luminance > 0.6).
    assert.equal(tileColors('filled', '#fef08a').number, '#0f172a');
    const outline = tileColors('outline', '#3b82f6');
    assert.equal(outline.fill, '#ffffff');
    assert.equal(outline.stroke, '#3b82f6');
    assert.ok(outline.strokeScale > soft.strokeScale);
    assert.equal(inkOn('#ffffff'), '#0f172a');
    assert.equal(inkOn('#000000'), '#ffffff');
    assert.ok(Math.abs(luminance('#ffffff') - 1) < 1e-9 && luminance('#000000') === 0);
    assert.equal(mixHex('#000000', '#ffffff', 0.5), '#808080');
  });
});

describe('the sample floor', () => {
  it('deals every state within seven tables, the busy ones first', () => {
    assert.deepEqual(new Set(SAMPLE_ORDER), new Set(TABLE_STATES));
    assert.equal(SAMPLE_ORDER.length, TABLE_STATES.length);
    assert.equal(sampleState(0), 'occupied');
    assert.equal(sampleState(7), 'occupied');
    assert.deepEqual(new Set(Array.from({ length: 7 }, (_, i) => sampleState(i))), new Set(TABLE_STATES));
  });

  it('puts the overdue table past the threshold, and words under each', () => {
    const late = sampleTable('overdue', 2, 4, 60);
    assert.ok((late.minutes ?? 0) > 60);
    assert.equal(stateWord(sampleTable('reserved', 0, 4, 45)), 'שמור 20:30');
    assert.equal(stateWord(sampleTable('toPay', 0, 4, 45)), 'לתשלום');
    assert.equal(sampleTable('free', 0, 4, 45).guests, null);
  });
});

describe('the defaults are today\'s colours', () => {
  it('pins the till\'s classic colours (TableVisuals.kt)', () => {
    assert.deepEqual(DEFAULT_STATE_COLORS, {
      free: '#34c759', occupied: '#3b82f6', kitchen: '#f97316', toPay: '#ff9500', otherTill: '#af52de', overdue: '#ff3b30', reserved: '#30b0c7',
    });
  });
});

describe('one level\'s card', () => {
  const inherited = { tableTileStyle: 'soft', tableOverdueMinutes: 45, mapDecor: 'full' };
  const own = { tableOverdueMinutes: 30, tableNumberSize: null };

  it('resolves an edit over the level\'s own value over what it inherits', () => {
    assert.deepEqual(effectiveParams(inherited, own, {}), { tableTileStyle: 'soft', tableOverdueMinutes: 30, mapDecor: 'full' });
    assert.deepEqual(effectiveParams(inherited, own, { tableTileStyle: 'filled', tableOverdueMinutes: null }), {
      tableTileStyle: 'filled', tableOverdueMinutes: 45, mapDecor: 'full',
    });
    assert.equal(setsItself(own, {}, 'tableOverdueMinutes'), true);
    assert.equal(setsItself(own, { tableOverdueMinutes: null }, 'tableOverdueMinutes'), false);
    assert.equal(setsItself(own, { mapDecor: 'off' }, 'mapDecor'), true);
    assert.equal(setsItself(own, {}, 'tableNumberSize'), false);
  });

  it('sends only what changes the level\'s own values', () => {
    assert.deepEqual(changedParams(own, { tableOverdueMinutes: 30, tableTileStyle: 'filled' }), { tableTileStyle: 'filled' });
    assert.deepEqual(changedParams(own, { tableOverdueMinutes: null }), { tableOverdueMinutes: null });
    assert.deepEqual(changedParams(own, { tableNumberSize: null }), {});
  });
});
