import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTableQuery, tableLabel, tableMatches } from './tableSearch';
import { transactionsQuery, txExtrasOf } from './transactionsFilters';

describe('the search box read as a table (same rules as the server and the till)', () => {
  for (const typed of ['ש12', 'ש 12', 'ש-12', 'ש־12', '  ש   12 ', 'שולחן 12', 'שולחן12', 'תא 12', 'תא12', 't12', 'T 12', 'table 12', 'Table12', 'ש#12']) {
    it(`"${typed}" asks for table 12 and nothing else`, () => {
      const q = parseTableQuery(typed);
      assert.equal(q?.number, 12);
      assert.equal(q?.explicit, true);
      assert.equal(q?.nameWhole, true);
      assert.equal(q?.labelKey, null);
      assert.equal(q?.name, typed.trim().split(/\s+/).join(' '));
    });
  }

  it('text with a letter may be a table name; digits alone are not a table without the chip', () => {
    assert.deepEqual(parseTableQuery('VIP 1'), { number: null, name: 'VIP 1', explicit: false, nameWhole: false, labelKey: 'VIP1' });
    assert.deepEqual(parseTableQuery('בר 3'), { number: null, name: 'בר 3', explicit: false, nameWhole: false, labelKey: 'בר3' });
    for (const typed of ['', '  ', '12', '20000057', '17.50', null, undefined]) assert.equal(parseTableQuery(typed), null);
  });

  it('with the "שולחן" chip digits are a table number and other text a name', () => {
    assert.deepEqual(parseTableQuery('12', true), { number: 12, name: null, explicit: true, nameWhole: false, labelKey: null });
    assert.deepEqual(parseTableQuery('VIP 1', true), { number: null, name: 'VIP 1', explicit: true, nameWhole: false, labelKey: 'VIP1' });
    assert.deepEqual(parseTableQuery('ש-12', true), { number: 12, name: 'ש-12', explicit: true, nameWhole: true, labelKey: null });
    assert.equal(parseTableQuery('', true), null);
  });

  it('an order matches by its number or by its name', () => {
    assert.ok(tableMatches(parseTableQuery('ש-12')!, 9012, 'ש-12'));
    assert.ok(!tableMatches(parseTableQuery('ש12')!, 9012, 'ש-12'));
    assert.ok(tableMatches(parseTableQuery('vip')!, 31, 'VIP 1'));
    assert.ok(!tableMatches(parseTableQuery('ש12')!, 112, null));
  });

  it('the explicit form matches a name as a whole; any other name search is a substring', () => {
    const q = parseTableQuery('ש-12')!;
    assert.ok(tableMatches(q, 9012, 'ש-12') && tableMatches(q, 9112, 'ש-12 (2)') && tableMatches(q, 9013, '  ש-12  '));
    assert.ok(!tableMatches(q, 9120, 'ש-120'));
    assert.ok(!tableMatches(q, 9200, 'גן ש-12'));
    assert.ok(!tableMatches(parseTableQuery('שולחן 1')!, 10, 'שולחן 10'));
    assert.ok(tableMatches(parseTableQuery('שולחן 10')!, null, 'שולחן 10'));
    assert.ok(tableMatches(parseTableQuery('vip', true)!, 31, 'the VIP 1'));
    assert.ok(tableMatches(parseTableQuery('VIP 1')!, 31, 'VIP 10'));
  });
});

describe('a label ("3B", P:/specs/table-scope.md §14.10) — the server\'s parse_table_query', () => {
  for (const typed of ['ש3B', 'שולחן 3b', 'תא 3-B', 't3b', 'T 3b', 'table 3B', 'ש-3B', 'ש 3 b']) {
    it(`"${typed}" asks for the table labelled 3B and nothing else`, () => {
      const q = parseTableQuery(typed)!;
      assert.equal(q.explicit, true);
      assert.equal(q.nameWhole, true);
      assert.equal(q.number, null);
      assert.equal(q.labelKey, '3B');
      assert.ok(tableMatches(q, 99_999, null, '3B') && tableMatches(q, 99_999, null, '3-b'));
      assert.ok(!tableMatches(q, 99_999, null, '3C') && !tableMatches(q, 3, null, null));
    });
  }

  it('"שולחן VIP" / "תא A1": a word, a space, a label of letters', () => {
    assert.equal(parseTableQuery('שולחן VIP')?.labelKey, 'VIP');
    assert.equal(parseTableQuery('תא a1')?.labelKey, 'A1');
    assert.equal(parseTableQuery('שולחן VIP')?.explicit, true);
    // "ש" alone before letters is no table word: "שניצל" is a search like any other.
    assert.equal(parseTableQuery('שניצל')?.explicit, false);
    // Not a label (no letter): the explicit form does not hold, the text stays a name search.
    assert.deepEqual(parseTableQuery('ש3-4'), { number: null, name: 'ש3-4', explicit: false, nameWhole: false, labelKey: 'ש34' });
  });

  it('with the chip, "3B" alone; any text that is a label also matches labels', () => {
    const chip = parseTableQuery('3b', true)!;
    assert.equal(chip.labelKey, '3B');
    assert.ok(tableMatches(chip, 1, null, '3B') && !tableMatches(chip, 3, null, null));
    const free = parseTableQuery('vip 1')!;
    assert.equal(free.explicit, false);
    assert.ok(tableMatches(free, 99_999, null, 'VIP-1'));
    // An order with no label is found by its number or name as before.
    assert.ok(tableMatches(parseTableQuery('ש12')!, 12, null, null));
  });
});

describe('a row\'s table beside its number', () => {
  it('"שולחן 12", the name when it says more, the name alone without a number', () => {
    assert.equal(tableLabel('שולחן', 12, null), 'שולחן 12');
    assert.equal(tableLabel('שולחן', 12, '12'), 'שולחן 12');
    assert.equal(tableLabel('שולחן', 9012, 'ש-12'), 'שולחן 9012 · ש-12');
    assert.equal(tableLabel('שולחן', 31, ' VIP 1 '), 'שולחן 31 · VIP 1');
    assert.equal(tableLabel('שולחן', null, 'בר 3'), 'בר 3');
    assert.equal(tableLabel('שולחן', null, null), null);
    assert.equal(tableLabel('שולחן', 99_999, 'VIP', '3B'), 'שולחן 3B · VIP');
    assert.equal(tableLabel('שולחן', 99_999, null, ' 3B '), 'שולחן 3B');
  });
});

describe('the "שולחן" filter goes out as `table`', () => {
  it('trimmed, capped at 60, absent when empty', () => {
    assert.deepEqual(transactionsQuery({ extras: txExtrasOf({ table: ' 12 ' }) }), { table: '12' });
    assert.equal(transactionsQuery({ extras: txExtrasOf({ table: 'x'.repeat(80) }) }).table, 'x'.repeat(60));
    assert.deepEqual(transactionsQuery({ extras: txExtrasOf({}) }), {});
  });
});
