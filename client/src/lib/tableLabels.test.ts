/**
 * Run with `npm test`. "מספר שולחן עם אותיות" (P:/specs/table-scope.md §6, §14.8): lib/tableLabels.ts against
 * the fixture the server and the till are tested against (server/tests/fixtures/table_label_sort_golden.json):
 * every case of it — parse, the natural order, titles with the word before them, ranges, the keypad, its row
 * of letters and the internal number.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  LabelError,
  checkRange,
  checkTableNumber,
  compareNatural,
  compareTables,
  exact,
  expandRange,
  fieldValue,
  internalNumber,
  labelKey,
  lettersIn,
  nextNumber,
  parse,
  rangeEndValue,
  shownOf,
  sortTables,
  suggestions,
  tableTitle,
  withTerm,
} from './tableLabels';

interface Golden {
  parse: { input: string; number?: number; label?: string; key?: string; error?: string }[];
  sorted: string[];
  shuffled: string[];
  mixed: { input: string[]; sorted: string[] };
  titles: {
    number: number | null;
    label: string | null;
    name: string | null;
    labelOnly: boolean;
    title: string;
    term: string;
    withTerm: string;
  }[];
  ranges: { from: string; to: string; items?: (string | number)[]; error?: string }[];
  keypad: {
    tables: { number: number; label: string | null }[];
    cases: { typed: string; suggestions: string[]; exact: string | null }[];
  };
  letters: { labels: (string | null)[]; letters: string[] };
  internal: { taken: number[]; number: number }[];
}

const golden: Golden = JSON.parse(
  readFileSync(join(process.cwd(), '..', 'server', 'tests', 'fixtures', 'table_label_sort_golden.json'), 'utf8'),
);

const reasonOf = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (e) {
    assert.ok(e instanceof LabelError, String(e));
    return e.reason;
  }
};

describe('table labels: the shared golden', () => {
  it('parses every case: a number, a label with its key, or the reason it is refused', () => {
    assert.ok(golden.parse.length >= 30);
    for (const c of golden.parse) {
      const name = JSON.stringify(c.input);
      if (c.error) {
        assert.equal(reasonOf(() => parse(c.input)), c.error, name);
        assert.deepEqual(checkTableNumber(c.input), { parsed: null, error: c.error }, name);
        continue;
      }
      const got = parse(c.input);
      if (c.number !== undefined) {
        assert.deepEqual([got.number, got.label], [c.number, null], name);
      } else {
        assert.deepEqual([got.number, got.label, got.key], [null, c.label, c.key], name);
        assert.equal(labelKey(c.input), c.key, name);
      }
    }
  });

  it('sorts naturally: the shuffled list and the mixed one', () => {
    assert.deepEqual([...golden.shuffled].sort(compareNatural), golden.sorted);
    assert.deepEqual([...golden.mixed.input].sort(compareNatural), golden.mixed.sorted);
  });

  it('every title, and the word before it', () => {
    for (const c of golden.titles) {
      const title = tableTitle(c.number, c.label, c.name, c.labelOnly);
      assert.equal(title, c.title, JSON.stringify(c));
      assert.equal(withTerm(c.term, title, c.labelOnly), c.withTerm, JSON.stringify(c));
    }
  });

  it('every range, and the reason a range is refused', () => {
    for (const c of golden.ranges) {
      const name = `${c.from} … ${c.to}`;
      if (c.error) {
        assert.equal(reasonOf(() => expandRange(c.from, c.to)), c.error, name);
        assert.equal(checkRange(c.from, c.to).error, c.error, name);
        continue;
      }
      const got = expandRange(c.from, c.to).map((p) => (p.label !== null ? p.label : p.number));
      assert.deepEqual(got, c.items, name);
    }
  });

  it('the keypad: suggestions in the natural order (at most 8) and the exact match', () => {
    const rows = golden.keypad.tables;
    for (const c of golden.keypad.cases) {
      const got = suggestions(c.typed, rows).map((r) => shownOf(r.number, r.label));
      assert.deepEqual(got, c.suggestions, JSON.stringify(c.typed));
      const hit = rows.find((r) => exact(c.typed, r.number, r.label));
      assert.equal(hit ? shownOf(hit.number, hit.label) : null, c.exact, JSON.stringify(c.typed));
    }
  });

  it('the row of letters, and the internal number', () => {
    assert.deepEqual(lettersIn(golden.letters.labels), golden.letters.letters);
    for (const c of golden.internal) assert.equal(internalNumber(c.taken), c.number);
  });
});

describe('table labels: the dashboard\'s helpers', () => {
  it('a table with no label sorts by its number, 3 before 3A, and two of the same by number', () => {
    const tables = [
      { number: 99_999, label: '3B' },
      { number: 10, label: null },
      { number: 3, label: null },
      { number: 99_998, label: '3A' },
      { number: 2, label: undefined },
    ];
    assert.deepEqual(sortTables(tables).map((t) => shownOf(t.number, t.label)), ['2', '3', '3A', '3B', '10']);
    assert.ok(compareTables({ number: 5, label: '3B' }, { number: 9, label: '3-b' }) < 0);
  });

  it('what the field sends: the number, or the label as stored', () => {
    assert.equal(fieldValue(parse('012')), 12);
    assert.equal(fieldValue(parse(' 3b ')), '3B');
    assert.equal(rangeEndValue(' 12 '), 12);
    assert.equal(rangeEndValue('3a'), '3a');
  });

  it('the next number skips a label\'s internal one', () => {
    assert.equal(nextNumber([{ number: 12 }, { number: 99_999, label: '3B' }, { number: 4, label: null }]), 13);
    assert.equal(nextNumber([]), 1);
  });
});
