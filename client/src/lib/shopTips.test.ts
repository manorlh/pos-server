/**
 * Run with `npm test`. "טיפים" of a shop (lib/shopTips.ts): reading the level's tips, the
 * ready-made choices, what a save writes (the existing keys only, nothing that equals what the shop
 * inherits) and the all-or-nothing save.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyPlan,
  choiceOf,
  givesTips,
  NO_TIPS,
  parsePresets,
  planIsEmpty,
  planWrites,
  PRESET_SETUPS,
  presetsError,
  setupErrors,
  setupForChoice,
  setupOf,
  TILL_PRESETS,
  tipKeyOn,
  type TipState,
} from './shopTips';

/** A new shop under a company that set nothing: today's defaults, resolved as the server sends them. */
function freshState(): TipState {
  return {
    settings: {
      own: {},
      inherited: {
        payFastCashTips: false, payCashTips: false, payFastCardTips: false, payCardTips: false, payManualCardTips: false,
      },
      sources: {},
    },
    params: {
      own: {},
      inherited: { tipAutoPrompt: true, terminalTipPrompt: false, billTipBase: 'balance', 'cashDrawer.cardTipsFromDrawer': false },
    },
    kiosk: {
      overrides: {},
      inherited: { payment: { tipEnabled: false, tipPresets: [10, 12, 15], tipOther: true, stepModes: { tip: 'optional' } } },
      menuVersion: 'v1',
    },
  };
}

describe('today', () => {
  it('a new shop under a company without tips is "ללא טיפ", and choosing it writes nothing', () => {
    const now = setupOf(freshState());
    assert.equal(givesTips(now), false);
    assert.equal(choiceOf(now), 'none');
    assert.ok(planIsEmpty(planWrites(setupForChoice('none', now), freshState())));
    assert.ok(planIsEmpty(planWrites(now, freshState())));
  });

  it('a company with tips on the till makes the new shop "מותאם" = the company\'s, writing nothing', () => {
    const st = freshState();
    st.settings!.inherited = { ...st.settings!.inherited, payCardTips: true, payFastCardTips: true, tipPresets: [8, 18] };
    const now = setupOf(st);
    assert.equal(now.tillCard, true);
    assert.deepEqual(now.presets, [8, 18]);
    assert.equal(choiceOf(now), 'custom');
    assert.ok(planIsEmpty(planWrites(now, st)));
  });
});

describe('the ready-made choices', () => {
  it('"מסעדה" writes the till\'s tips, the drawer\'s card tips — and only what differs', () => {
    const plan = planWrites(setupForChoice('restaurant', setupOf(freshState())), freshState());
    assert.deepEqual(plan.settings, {
      payFastCardTips: true, payCardTips: true, payManualCardTips: true, payFastCashTips: true, payCashTips: true,
    });
    assert.deepEqual(plan.params, { 'cashDrawer.cardTipsFromDrawer': true });
    assert.equal(plan.kiosk, null);
    // Undo puts back the shop's own (none: cleared).
    assert.deepEqual(plan.paramsUndo, { 'cashDrawer.cardTipsFromDrawer': null });
  });

  it('"בר/בית קפה" pools the tips with its own percentages', () => {
    const plan = planWrites(setupForChoice('cafe', setupOf(freshState())), freshState());
    assert.equal(plan.settings!.tipPresets instanceof Array, true);
    assert.deepEqual(plan.settings!.tipPresets, [5, 10, 15]);
    assert.equal(plan.settings!.tipDistribution, 'equal_pool');
    assert.equal(plan.params, null);
  });

  it('reads back as the same choice', () => {
    for (const id of ['restaurant', 'cafe', 'none'] as const) {
      assert.equal(choiceOf(PRESET_SETUPS[id]), id);
    }
  });

  it('"ללא טיפ" on a shop with tips clears its own keys back to the company\'s', () => {
    const st = freshState();
    st.settings!.own = { payCardTips: true, payCashTips: true };
    st.params!.own = { 'cashDrawer.cardTipsFromDrawer': true };
    st.kiosk!.overrides = { payment: { tipEnabled: true, tipPresets: [5] }, look: { style: 'ios' } };
    const now = setupOf(st);
    assert.equal(choiceOf(now), 'custom');
    const plan = planWrites(setupForChoice('none', now), st);
    assert.deepEqual(plan.settings, { payCardTips: null, payCashTips: null });
    assert.deepEqual(plan.settingsUndo, { payCardTips: true, payCashTips: true });
    assert.deepEqual(plan.params, { 'cashDrawer.cardTipsFromDrawer': null });
    // The kiosk's other keys are kept; its tip percentages stay (they matter only with the tip on).
    assert.deepEqual(plan.kiosk, { payment: { tipPresets: [5] }, look: { style: 'ios' } });
    assert.equal(plan.kioskMenuVersion, 'v1');
  });

  it('turning tips off where the shop has the legacy switch writes the options off explicitly', () => {
    const st = freshState();
    // The work profile wrote `tipsEnabled` on the shop: every card option asks.
    st.settings!.own = { tipsEnabled: true };
    assert.equal(tipKeyOn(st.settings!, 'payCardTips', 'card'), true);
    assert.equal(tipKeyOn(st.settings!, 'payCashTips', 'cash'), false);
    const plan = planWrites(setupForChoice('none', setupOf(st)), st);
    assert.deepEqual(plan.settings, { payFastCardTips: false, payCardTips: false, payManualCardTips: false });
  });

  it('the kiosk\'s tip as a layer of its own', () => {
    const want = { ...NO_TIPS, kiosk: true, kioskPresets: [5, 10], kioskMode: 'required' as const };
    const plan = planWrites(want, freshState());
    assert.deepEqual(plan.kiosk, { payment: { tipEnabled: true, tipPresets: [5, 10], stepModes: { tip: 'required' } } });
    assert.deepEqual(plan.kioskUndo, {});
  });
});

describe('checks', () => {
  it('percentages', () => {
    assert.equal(presetsError([10, 12], TILL_PRESETS), null);
    assert.match(presetsError([], TILL_PRESETS)!, /לפחות/);
    assert.match(presetsError([10, 10], TILL_PRESETS)!, /פעמיים/);
    assert.match(presetsError([0], TILL_PRESETS)!, /בין 1/);
    assert.match(presetsError([1, 2, 3, 4, 5, 6, 7], TILL_PRESETS)!, /עד 6/);
    assert.deepEqual(parsePresets('10, 12 · 15%'), [10, 12, 15]);
    assert.equal(parsePresets('ten'), null);
    assert.deepEqual(setupErrors({ ...NO_TIPS, kiosk: true, kioskPresets: [60] }).length, 1);
    // Percentages of a part that is off are not checked.
    assert.deepEqual(setupErrors({ ...NO_TIPS, presets: [] }), []);
  });
});

describe('saving all or nothing', () => {
  const plan = planWrites({ ...PRESET_SETUPS.restaurant, kiosk: true }, freshState());

  it('writes the parts in order', async () => {
    const calls: string[] = [];
    const r = await applyPlan(plan, async (part) => void calls.push(part), String);
    assert.equal(r.ok, true);
    assert.deepEqual(calls, ['settings', 'params', 'kiosk']);
    assert.deepEqual(r.outcomes.map((o) => o.state), ['saved', 'saved', 'saved']);
  });

  it('a refused part stops the rest and puts back what was saved', async () => {
    const calls: [string, unknown][] = [];
    const r = await applyPlan(
      plan,
      async (part, body) => {
        calls.push([part, body]);
        if (part === 'params') throw new Error('403');
      },
      (e) => (e as Error).message,
    );
    assert.equal(r.ok, false);
    assert.deepEqual(r.outcomes, [
      { part: 'settings', state: 'undone' },
      { part: 'params', state: 'failed', message: '403' },
      { part: 'kiosk', state: 'skipped' },
    ]);
    assert.deepEqual(calls[calls.length - 1], ['settings', plan.settingsUndo]);
  });

  it('says what stayed saved when putting it back fails', async () => {
    let n = 0;
    const r = await applyPlan(
      plan,
      async (part) => {
        n += 1;
        if (part === 'kiosk' || n > 3) throw new Error('down');
      },
      (e) => (e as Error).message,
    );
    assert.deepEqual(r.outcomes.map((o) => o.state), ['kept', 'kept', 'failed']);
  });
});
