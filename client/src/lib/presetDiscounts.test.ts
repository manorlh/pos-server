/**
 * Run with `npm test`. "הנחות קבועות" as the dashboard edits them (lib/presetDiscounts.ts) — the
 * server's rules (app/services/preset_discounts.py validate_presets / resolve_for_till).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PRESETS_MAX,
  formatPresetValue,
  movePreset,
  newPreset,
  presetIssues,
  presetsForSave,
  presetsValid,
  readButtons,
  readPresets,
  resolveButtonIds,
  samePresets,
  validValue,
  type PresetDiscount,
} from './presetDiscounts';

const p = (id: string, over: Partial<PresetDiscount> = {}): PresetDiscount => ({ ...newPreset(id), name: id, ...over });

describe('validValue', () => {
  it('takes above 0 up to the top, two decimals at most', () => {
    assert.ok(validValue('percent', 10));
    assert.ok(validValue('percent', 12.5));
    assert.ok(validValue('percent', 100));
    assert.ok(validValue('amount', 0.01));
    assert.ok(validValue('amount', 100000));
    assert.ok(!validValue('percent', 0));
    assert.ok(!validValue('percent', 100.01));
    assert.ok(!validValue('amount', 100000.01));
    assert.ok(!validValue('percent', 10.005));
    assert.ok(!validValue('percent', Number.NaN));
  });
});

describe('presetIssues', () => {
  it('names what the server would refuse', () => {
    const list = [p('a', { name: '  ' }), p('b', { name: 'x'.repeat(25) }), p('c', { value: 0 }), p('c', { color: 'red' })];
    assert.deepEqual(presetIssues(list), [['nameRequired'], ['nameTooLong'], ['valueInvalid'], ['colorInvalid', 'idRepeats']]);
    assert.ok(!presetsValid(list));
    assert.ok(presetsValid([p('a'), p('b', { kind: 'amount', value: 25 })]));
  });

  it('refuses more than the cap', () => {
    assert.ok(!presetsValid(Array.from({ length: PRESETS_MAX + 1 }, (_, i) => p(`p${i}`))));
  });
});

describe('presetsForSave', () => {
  it('cleans the name, fills the defaults and keeps the id', () => {
    const [saved] = presetsForSave([{ id: 'x', name: '  הנחת   עובדים ', kind: 'percent', value: 40, color: '#abcdef' }]);
    assert.deepEqual(saved, {
      id: 'x',
      name: 'הנחת עובדים',
      kind: 'percent',
      value: 40,
      active: true,
      color: '#ABCDEF',
      requiresManager: false,
      button: true,
      forWhom: 'none',
      forWhomSource: 'free',
    });
  });
});

describe('readPresets / readButtons', () => {
  it('reads null as inherit and [] as none', () => {
    assert.equal(readPresets(undefined), null);
    assert.equal(readPresets(null), null);
    assert.deepEqual(readPresets([]), []);
    assert.equal(readButtons(null), null);
    assert.deepEqual(readButtons(['a', 'a', '', 3]), ['a']);
  });

  it('drops an item with no id and reads unknown choices as the defaults', () => {
    const list = readPresets([{ name: 'x' }, { id: 'a', name: 'A', kind: 'amount', value: 5, forWhom: 'maybe' }]);
    assert.equal(list?.length, 1);
    assert.equal(list?.[0].kind, 'amount');
    assert.equal(list?.[0].forWhom, 'none');
  });
});

describe('resolveButtonIds', () => {
  const list = [p('a'), p('b', { button: false }), p('c', { active: false }), p('d')];
  it('unset: every active preset whose button is on', () => {
    assert.deepEqual(resolveButtonIds(list, null), ['a', 'd']);
  });
  it('a list: those it names, in the presets\' order, active only', () => {
    assert.deepEqual(resolveButtonIds(list, ['d', 'b', 'c', 'zz']), ['b', 'd']);
    assert.deepEqual(resolveButtonIds(list, []), []);
  });
});

describe('helpers', () => {
  it('moves, formats, compares', () => {
    assert.deepEqual(movePreset(['a', 'b', 'c'], 0, 1), ['b', 'a', 'c']);
    assert.deepEqual(movePreset(['a', 'b'], 0, -1), ['a', 'b']);
    assert.equal(formatPresetValue({ kind: 'percent', value: 10 }), '10%');
    assert.equal(formatPresetValue({ kind: 'amount', value: 12.5 }), '₪12.5');
    assert.equal(formatPresetValue({ kind: 'amount', value: 12.25 }), '₪12.25');
    assert.ok(samePresets([p('a')], [{ ...p('a'), name: ' a ' }]));
    assert.ok(!samePresets([p('a')], null));
  });
});
