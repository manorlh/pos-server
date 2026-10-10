/**
 * Run with `npm test`. Type-to-filter for the searchable pickers (lib/optionSearch.ts): what a
 * query is folded to, which options it finds, and in which order.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { MATCH_TIER, moveHighlight, normalizeSearchText, rankOptions, type SearchOption } from './optionSearch';

const opt = (value: string, label: string, ...keywords: string[]): SearchOption => ({ value, label, keywords });
const values = (options: SearchOption[]) => options.map((o) => o.value);

describe('normalizeSearchText', () => {
  it('folds case, spaces, hyphens, dots and other punctuation into single spaces', () => {
    assert.equal(normalizeSearchText('  A920   Pro '), 'a920 pro');
    assert.equal(normalizeSearchText('A920-PRO'), 'a920 pro');
    assert.equal(normalizeSearchText('a920.pro'), 'a920 pro');
    assert.equal(normalizeSearchText('S1U2_M4 / (Castles)'), 's1u2 m4 castles');
    assert.equal(normalizeSearchText('SynqPay — DX8000'), 'synqpay dx8000');
  });

  it('drops accents, niqqud, geresh / gershayim and quotes, and folds Hebrew final letters', () => {
    assert.equal(normalizeSearchText('Café'), 'cafe');
    assert.equal(normalizeSearchText('מ״מ'), normalizeSearchText('מ"מ'));
    assert.equal(normalizeSearchText('מ״מ'), 'ממ');
    assert.equal(normalizeSearchText('אינג׳ניקו'), normalizeSearchText("אינג'ניקו"));
    assert.equal(normalizeSearchText('שָׁלוֹם'), 'שלומ');
    assert.equal(normalizeSearchText('דו־צדדי'), 'דו צדדי');
    assert.equal(normalizeSearchText('ךםןףץ'), 'כמנפצ');
  });

  it('is empty for an empty or punctuation-only text', () => {
    assert.equal(normalizeSearchText(''), '');
    assert.equal(normalizeSearchText('  - . / '), '');
  });
});

describe('rankOptions', () => {
  const options = [
    opt('pro', 'PAX A920 Pro'),
    opt('a920', 'PAX A920'),
    opt('k2', 'SUNMI K2 / K2 MINI (קיוסק, 80 מ״מ)', 'SUNMI K2', 'K2', 'K2 MINI'),
    opt('t2mini', 'SUNMI T2 mini', 'SUNMI T2 mini', 'T2 mini'),
    opt('t2', 'SUNMI T2 / T2 lite', 'SUNMI T2', 'T2', 'T2 lite'),
    opt('t2s', 'SUNMI T2s', 'SUNMI T2s', 'T2s'),
  ];

  it('an empty or punctuation-only query is every option, in its own order, as a new array', () => {
    for (const q of ['', '   ', ' - . ']) {
      const out = rankOptions(options, q);
      assert.deepEqual(values(out), values(options));
      assert.notEqual(out, options);
    }
  });

  it('finds a model however its spaces, hyphens, dots and case are typed', () => {
    for (const q of ['a920pro', 'A920 Pro', 'a920-pro', 'A920.PRO', 'pax a920 pro', 'PAXA920PRO']) {
      assert.equal(rankOptions(options, q)[0]?.value, 'pro', q);
    }
    assert.deepEqual(values(rankOptions([opt('x', 'a920pro')], 'A920 Pro')), ['x']);
  });

  it('puts an exact name before one starting with the query, before a word inside, before a substring', () => {
    const list = [
      opt('substring', 'XT2X'),
      opt('word', 'SUNMI T2 lite'),
      opt('prefix', 'T2 mini'),
      opt('exact', 'T-2'),
    ];
    assert.deepEqual(values(rankOptions(list, 't2')), ['exact', 'prefix', 'word', 'substring']);
  });

  it('ranks by the best of the label and the keywords, the label first at the same level', () => {
    assert.deepEqual(values(rankOptions(options, 't2')), ['t2', 't2mini', 't2s']);
    assert.deepEqual(values(rankOptions(options, 'sunmi t2')), ['t2', 't2mini', 't2s']);
    const tie = [opt('keyword', 'Other', 'Alpha'), opt('label', 'Alpha')];
    assert.deepEqual(values(rankOptions(tie, 'alpha')), ['label', 'keyword']);
  });

  it('keeps the options’ own order between equal matches', () => {
    const list = [opt('b', 'SUNMI V2'), opt('a', 'SUNMI V1'), opt('c', 'SUNMI V3')];
    assert.deepEqual(values(rankOptions(list, 'sunmi')), ['b', 'a', 'c']);
  });

  it('takes the words of a query in any order', () => {
    assert.deepEqual(values(rankOptions(options, 'mini t2')), ['t2mini']);
    assert.deepEqual(values(rankOptions(options, 'lite t2')), ['t2']);
  });

  it('finds the words of a query across the label and the keywords', () => {
    const list = [opt('d', 'מגירה, 80 מ״מ', 'SUNMI D3'), opt('v', 'ידני, 58 מ״מ', 'SUNMI V2')];
    assert.deepEqual(values(rankOptions(list, 'sunmi מגירה')), ['d']);
    assert.deepEqual(values(rankOptions(list, '80 ממ')), ['d']);
    assert.deepEqual(values(rankOptions(list, 'מ"מ')), ['d', 'v']);
  });

  it('searches the description last', () => {
    const list = [
      { value: 'desc', label: 'One', description: 'kiosk' },
      { value: 'label', label: 'Kiosk' },
    ];
    assert.deepEqual(values(rankOptions(list, 'kiosk')), ['label', 'desc']);
  });

  it('finds nothing for a query no name contains', () => {
    assert.deepEqual(rankOptions(options, 'verifone'), []);
    assert.deepEqual(rankOptions(options, 't2 verifone'), []);
  });

  it('exposes the tiers in order', () => {
    const tiers = Object.values(MATCH_TIER);
    assert.deepEqual(tiers, [...tiers].sort((a, b) => a - b));
  });

  it('accepts a typographic apostrophe or a geresh for an ASCII one', () => {
    const list = [opt('ing', "אינג'ניקו")];
    assert.deepEqual(values(rankOptions(list, 'אינג׳ניקו')), ['ing']);
    assert.deepEqual(values(rankOptions(list, 'אינג’ניקו')), ['ing']);
    assert.deepEqual(values(rankOptions(list, 'אינגניקו')), ['ing']);
  });
});

describe('moveHighlight', () => {
  const four = [{}, {}, {}, {}];

  it('ArrowDown / ArrowUp step through the list and wrap around its ends', () => {
    assert.equal(moveHighlight(four, 0, 'next'), 1);
    assert.equal(moveHighlight(four, 3, 'next'), 0);
    assert.equal(moveHighlight(four, 2, 'previous'), 1);
    assert.equal(moveHighlight(four, 0, 'previous'), 3);
  });

  it('from no highlight, ArrowDown is the first option and ArrowUp the last', () => {
    assert.equal(moveHighlight(four, null, 'next'), 0);
    assert.equal(moveHighlight(four, null, 'previous'), 3);
    // A highlight left over from a longer list counts as none.
    assert.equal(moveHighlight(four, 9, 'next'), 0);
  });

  it('Home / End go to the first and the last option', () => {
    assert.equal(moveHighlight(four, 2, 'first'), 0);
    assert.equal(moveHighlight(four, 1, 'last'), 3);
    assert.equal(moveHighlight(four, null, 'last'), 3);
  });

  it('skips disabled options', () => {
    const list = [{ disabled: true }, {}, { disabled: true }, {}, { disabled: true }];
    assert.equal(moveHighlight(list, null, 'next'), 1);
    assert.equal(moveHighlight(list, 1, 'next'), 3);
    assert.equal(moveHighlight(list, 3, 'next'), 1);
    assert.equal(moveHighlight(list, 1, 'previous'), 3);
    assert.equal(moveHighlight(list, null, 'first'), 1);
    assert.equal(moveHighlight(list, null, 'last'), 3);
  });

  it('is null for an empty list or one of disabled options only', () => {
    assert.equal(moveHighlight([], null, 'next'), null);
    assert.equal(moveHighlight([{ disabled: true }], 0, 'first'), null);
  });
});
