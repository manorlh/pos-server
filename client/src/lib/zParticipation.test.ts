/**
 * Run with `npm test`. "קופה עצמאית בתוך סניף" — the rules of the "קופות בזד הסניפי" card
 * (lib/zParticipation.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildParticipationBody,
  choiceForTick,
  effectOf,
  formatTillNumbers,
  initialChoices,
  isKnownRefusal,
  isShopZ,
  mainTillOptions,
  refusalOf,
  roleOf,
  summarySegments,
  switchBlockOf,
  validateParticipation,
  type SummarySegment,
  type ZChoices,
  type ZParticipationState,
  type ZParticipationTill,
  type ZRole,
} from './zParticipation';

function till(n: number, role: ZRole, extra: Partial<ZParticipationTill> = {}): ZParticipationTill {
  return {
    machineId: `m${n}`,
    posNumber: String(n),
    name: `קופה ${n}`,
    areaId: null,
    zMode: role === 'shop_z' ? 'cloud' : 'till',
    independent: role === 'independent',
    role,
    openShift: false,
    awaitingZ: 0,
    mainTill: false,
    online: true,
    ...extra,
  };
}

/** The owner's shop: tills 1–6 all in the shop Z, main till 1. */
function shop(tills: ZParticipationTill[], mainTillId: string | null = 'm1'): ZParticipationState {
  const main = tills.find((t) => t.machineId === mainTillId);
  return {
    shopId: 's1',
    tills,
    mainTill: main ? { machineId: main.machineId, posNumber: main.posNumber, name: main.name } : null,
    localMode: true,
    canEdit: true,
  };
}

const sixInShopZ = () => shop([1, 2, 3, 4, 5, 6].map((n) => till(n, 'shop_z', { mainTill: n === 1 })));

/** The he.json texts of the section, with `{name}` filled in (the summary has no plurals). */
const he = JSON.parse(readFileSync(join(__dirname, '..', 'src', 'messages', 'he.json'), 'utf8')) as {
  independentTill: { summary: Record<string, string>; effect: Record<string, string> };
};
function render(segments: SummarySegment[]): string {
  return segments
    .map((s) => he.independentTill.summary[s.key].replace(/\{(\w+)\}/g, (_, k: string) => s.values[k] ?? `{${k}}`))
    .join(' · ');
}

describe('roles and the checkbox', () => {
  it('reads the role, and falls back to the flags', () => {
    assert.equal(roleOf({ role: 'own_z', independent: false, zMode: 'till' }), 'own_z');
    assert.equal(roleOf({ role: undefined as unknown as ZRole, independent: true, zMode: 'till' }), 'independent');
    assert.equal(roleOf({ role: undefined as unknown as ZRole, independent: false, zMode: 'till' }), 'own_z');
    assert.equal(roleOf({ role: undefined as unknown as ZRole, independent: false, zMode: 'cloud' }), 'shop_z');
  });

  it('ticked is the shop Z; unticked is independent, or back to "Z לכל קופה" for such a till', () => {
    assert.equal(choiceForTick('shop_z', false), 'independent');
    assert.equal(choiceForTick('independent', true), 'shop_z');
    assert.equal(choiceForTick('own_z', true), 'shop_z');
    assert.equal(choiceForTick('own_z', false), 'own_z');
  });

  it('labels each till by its effect', () => {
    assert.equal(effectOf('shop_z'), 'shopZ');
    assert.equal(effectOf('independent'), 'independent');
    assert.equal(effectOf('own_z'), 'ownZ');
    assert.equal(he.independentTill.effect.shopZ, 'Z סניפי');
    assert.equal(he.independentTill.effect.independent, 'Z עצמאי, ללא שרת מקומי');
    assert.equal(he.independentTill.effect.ownZ, 'Z לכל קופה (מצב הסניף)');
  });
});

describe('the PUT body', () => {
  it('unticking till 6 sends it alone as independent, and no main till', () => {
    const s = sixInShopZ();
    const c: ZChoices = { ...initialChoices(s), m6: choiceForTick('shop_z', false) };
    assert.deepEqual(buildParticipationBody(s, c, 'm1'), { participants: [], independent: ['m6'] });
  });

  it('nothing changed is no body', () => {
    const s = sixInShopZ();
    assert.equal(buildParticipationBody(s, initialChoices(s), 'm1'), null);
  });

  it('a new main till, or none, is sent; an unchanged one is not', () => {
    const s = sixInShopZ();
    assert.deepEqual(buildParticipationBody(s, initialChoices(s), 'm2'), {
      participants: [],
      independent: [],
      mainTillId: 'm2',
    });
    assert.deepEqual(buildParticipationBody(s, initialChoices(s), null), {
      participants: [],
      independent: [],
      mainTillId: null,
    });
    const none = shop([till(1, 'shop_z')], null);
    assert.equal(buildParticipationBody(none, initialChoices(none), ''), null);
  });

  it('an independent till ticked back joins the shop Z; a "Z לכל קופה" till is sent only when changed', () => {
    const s = shop([till(1, 'shop_z', { mainTill: true }), till(2, 'own_z'), till(3, 'independent')]);
    const c = { ...initialChoices(s), m3: choiceForTick('independent', true) };
    assert.deepEqual(buildParticipationBody(s, c, 'm1'), { participants: ['m3'], independent: [] });
    const c2 = { ...initialChoices(s), m2: 'independent' as ZRole };
    assert.deepEqual(buildParticipationBody(s, c2, 'm1'), { participants: [], independent: ['m2'] });
  });
});

describe('validation', () => {
  it('the main till must be ticked', () => {
    const s = sixInShopZ();
    const c = { ...initialChoices(s), m1: 'independent' as ZRole };
    assert.deepEqual(validateParticipation(s, c, 'm1'), [
      { kind: 'main_not_participating', machineId: 'm1' },
    ]);
    assert.deepEqual(validateParticipation(s, c, null), []);
    assert.deepEqual(validateParticipation(s, initialChoices(s), 'm1'), []);
  });

  it('a till with an open shift, or shifts awaiting a Z, cannot change sides', () => {
    const s = shop([
      till(1, 'shop_z', { mainTill: true }),
      till(2, 'shop_z', { openShift: true }),
      till(3, 'shop_z', { awaitingZ: 2 }),
    ]);
    assert.equal(switchBlockOf(s.tills[1]), 'open_shift');
    assert.equal(switchBlockOf(s.tills[2]), 'awaiting_z');
    assert.equal(switchBlockOf(s.tills[0]), null);
    // Untouched, they block nothing.
    assert.deepEqual(validateParticipation(s, initialChoices(s), 'm1'), []);
    const c = { ...initialChoices(s), m2: 'independent' as ZRole, m3: 'independent' as ZRole };
    assert.deepEqual(validateParticipation(s, c, 'm1'), [
      { kind: 'blocked', machineId: 'm2', reason: 'open_shift' },
      { kind: 'blocked', machineId: 'm3', reason: 'awaiting_z' },
    ]);
  });

  it('the main till is picked from the ticked tills only, by number', () => {
    const s = shop([till(10, 'shop_z'), till(2, 'shop_z'), till(6, 'independent'), till(3, 'own_z')], null);
    assert.deepEqual(
      mainTillOptions(s.tills, initialChoices(s)).map((t) => t.posNumber),
      ['2', '10'],
    );
  });
});

describe('the summary', () => {
  it('formats register numbers as ranges', () => {
    const t = (...ns: number[]) => ns.map((n) => ({ posNumber: String(n) }));
    assert.equal(formatTillNumbers(t(1, 2, 3, 4, 5)), '1–5');
    assert.equal(formatTillNumbers(t(5, 1, 3, 2)), '1–3, 5');
    assert.equal(formatTillNumbers(t(1, 2)), '1, 2');
    assert.equal(formatTillNumbers(t(6)), '6');
    assert.equal(formatTillNumbers([{ posNumber: null, name: 'בר' }, { posNumber: '4' }]), '4, בר');
  });

  it("the owner's example: tills 1–5 on main till 1, till 6 independent", () => {
    const s = sixInShopZ();
    const c = { ...initialChoices(s), m6: choiceForTick('shop_z', false) };
    const segments = summarySegments(s, c, 'm1');
    assert.deepEqual(segments, [
      { key: 'shopZMain', values: { tills: '1–5', main: '1' } },
      { key: 'independentOne', values: { tills: '6' } },
    ]);
    assert.equal(render(segments), 'קופות 1–5 בזד הסניפי, נשענות על קופה 1 כשרת מקומי · קופה 6 עצמאית');
  });

  it('no main till, several independent, "Z לכל קופה" and nothing in the shop Z', () => {
    const s = shop([till(1, 'shop_z'), till(2, 'shop_z'), till(3, 'independent'), till(4, 'independent')], null);
    assert.equal(render(summarySegments(s, initialChoices(s), null)), 'קופות 1, 2 בזד הסניפי, ללא קופה ראשית · קופות 3, 4 עצמאיות');
    const own = shop([till(1, 'own_z'), till(2, 'own_z'), till(3, 'own_z')], null);
    assert.deepEqual(summarySegments(own, initialChoices(own), null), [{ key: 'ownZMany', values: { tills: '1–3' } }]);
    const alone = shop([till(1, 'independent')], null);
    assert.deepEqual(summarySegments(alone, initialChoices(alone), null).map((x) => x.key), ['noShopZ', 'independentOne']);
    const one = shop([till(1, 'shop_z', { mainTill: true })]);
    assert.deepEqual(summarySegments(one, initialChoices(one), 'm1'), [
      { key: 'shopZOneMain', values: { tills: '1', main: '1' } },
    ]);
  });
});

describe('a shop Z or a till Z', () => {
  it('goes by the scope, else by the origin', () => {
    assert.equal(isShopZ({ scope: { kind: 'shop' }, origin: 'till' }), true);
    assert.equal(isShopZ({ scope: { kind: 'area' } }), true);
    assert.equal(isShopZ({ scope: { kind: 'independent_till' }, origin: 'cloud' }), false);
    assert.equal(isShopZ({ scope: { kind: 'till' } }), false);
    assert.equal(isShopZ({ scope: null, origin: 'cloud' }), true);
    assert.equal(isShopZ({ origin: 'till' }), false);
    assert.equal(isShopZ({ origin: null, legacy: true }), false);
  });
});

describe('refusals', () => {
  it('reads this API\'s 409 with the server\'s Hebrew text and the till', () => {
    const err = {
      response: {
        status: 409,
        data: {
          detail: 'independent_switch_open_shift',
          message: 'לקופה 6 יש משמרת פתוחה',
          machineId: 'm6',
          posNumber: '6',
        },
      },
    };
    assert.deepEqual(refusalOf(err), {
      code: 'independent_switch_open_shift',
      message: 'לקופה 6 יש משמרת פתוחה',
      machineId: 'm6',
      posNumber: '6',
    });
  });

  it("reads the main till's nested refusal, and nothing from a network error", () => {
    const err = { response: { data: { detail: { code: 'main_till_independent', message: 'קופה עצמאית' } } } };
    assert.deepEqual(refusalOf(err), {
      code: 'main_till_independent',
      message: 'קופה עצמאית',
      machineId: null,
      posNumber: null,
    });
    assert.equal(refusalOf({ message: 'Network Error' }), null);
    assert.equal(refusalOf({ response: { data: { detail: [{ msg: 'x' }] } } }), null);
    assert.equal(isKnownRefusal('till_in_both_lists'), true);
    assert.equal(isKnownRefusal('something_else'), false);
  });
});
