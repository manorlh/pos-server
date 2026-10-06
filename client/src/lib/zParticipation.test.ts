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
  canBeRemote,
  initialLinks,
  linkHintOf,
  remoteListOf,
  choiceForTick,
  conflictNumbersOf,
  effectOf,
  formatTillNumbers,
  initialChoices,
  isKnownRefusal,
  isShopZ,
  mainTillOptions,
  producerBusyOf,
  producerViewOf,
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

describe('"מחובר ברשת המקומית" / "מרוחק (דרך הענן)"', () => {
  // Tills 1–5 in the shop Z on main till 1, kiosk 7 remote, till 6 independent.
  const s = () =>
    shop([
      ...[1, 2, 3, 4, 5].map((n) => till(n, 'shop_z', { mainTill: n === 1, link: 'lan' as const, seenOnLan: true })),
      till(6, 'independent', { link: 'lan', seenOnLan: null }),
      till(7, 'shop_z', { kiosk: true, link: 'remote', seenOnLan: false }),
    ]);

  it('only a till in the shop Z, never the main till, may be remote', () => {
    assert.equal(canBeRemote('m3', 'shop_z', 'm1'), true);
    assert.equal(canBeRemote('m1', 'shop_z', 'm1'), false);
    assert.equal(canBeRemote('m6', 'independent', 'm1'), false);
    assert.equal(canBeRemote('m6', 'own_z', null), false);
  });

  it('nothing changed: no `remote` in the body', () => {
    const st = s();
    assert.deepEqual(initialLinks(st), { m1: 'lan', m2: 'lan', m3: 'lan', m4: 'lan', m5: 'lan', m6: 'lan', m7: 'remote' });
    assert.equal(buildParticipationBody(st, initialChoices(st), 'm1', initialLinks(st)), null);
    assert.deepEqual(remoteListOf(st, initialChoices(st), initialLinks(st), 'm1'), ['m7']);
  });

  it('setting till 4 remote sends the whole list, by number', () => {
    const st = s();
    const links = { ...initialLinks(st), m4: 'remote' as const };
    assert.deepEqual(buildParticipationBody(st, initialChoices(st), 'm1', links), {
      participants: [],
      independent: [],
      remote: ['m4', 'm7'],
    });
    const back = { ...initialLinks(st), m7: 'lan' as const };
    assert.deepEqual(buildParticipationBody(st, initialChoices(st), 'm1', back), {
      participants: [],
      independent: [],
      remote: [],
    });
  });

  it('a remote till that leaves the shop Z, or becomes the main till, drops out of the list', () => {
    const st = s();
    const c = { ...initialChoices(st), m7: 'independent' as ZRole };
    assert.deepEqual(buildParticipationBody(st, c, 'm1', initialLinks(st)), {
      participants: [],
      independent: ['m7'],
      remote: [],
    });
    assert.deepEqual(remoteListOf(st, initialChoices(st), initialLinks(st), 'm7'), []);
  });

  it('the effect and the hint (a hint only)', () => {
    assert.equal(effectOf('shop_z', true), 'remote');
    assert.equal(effectOf('shop_z'), 'shopZ');
    assert.equal(he.independentTill.effect.remote, 'נסגרת דרך הענן — הקופה הראשית ממתינה לחלק שלה');
    assert.equal(linkHintOf('lan', false), 'maybeRemote');
    assert.equal(linkHintOf('remote', true), 'heardOnLan');
    assert.equal(linkHintOf('lan', true), null);
    assert.equal(linkHintOf('remote', false), null);
    assert.equal(linkHintOf('lan', null), null);
  });

  it('the summary names the remote tills', () => {
    const st = s();
    assert.equal(
      render(summarySegments(st, initialChoices(st), 'm1', initialLinks(st))),
      'קופות 1–5, 7 בזד הסניפי, נשענות על קופה 1 כשרת מקומי · קופה 7 מרוחקת (נסגרת דרך הענן) · קופה 6 עצמאית',
    );
  });
});

describe("the shop Z's one producer", () => {
  const msgs = JSON.parse(readFileSync(join(__dirname, '..', 'src', 'messages', 'he.json'), 'utf8')) as {
    independentTill: { producer: Record<string, string>; conflicts: Record<string, string> };
  };
  const fill = (text: string, values: Record<string, string>) =>
    text.replace(/\{(\w+)\}/g, (_, k: string) => values[k] ?? `{${k}}`);

  it('names the producer: the main till on the LAN, or the cloud', () => {
    const local = producerViewOf({ kind: 'local', machine: { machineId: 'm1', posNumber: '1', name: 'קופה 1' } });
    assert.equal(fill(msgs.independentTill.producer[local.key], local.values), 'מפיק ה-Z הסניפי: קופה 1 (רשת מקומית)');
    const cloud = producerViewOf({ kind: 'cloud', machine: null });
    assert.equal(fill(msgs.independentTill.producer[cloud.key], cloud.values), 'מפיק ה-Z הסניפי: הענן');
    assert.equal(producerViewOf({ kind: 'local', machine: null }).key, 'localNoTill');
    assert.equal(producerViewOf(undefined).key, 'cloud');
  });

  it("a conflict's numbers: printed and expected", () => {
    const both = conflictNumbersOf({ zId: 'z', detail: 'offline_z_out_of_sequence', number: 14, expectedNumber: 12 });
    assert.equal(fill(msgs.independentTill.conflicts[both.key], both.values), 'Z מס׳ 14 (הענן ציפה ל-12)');
    assert.equal(conflictNumbersOf({ zId: 'z', detail: 'offline_z_number_taken', number: 9 }).key, 'numberOnly');
    assert.equal(conflictNumbersOf({ zId: 'z', detail: 'not_shop_z_producer' }).key, 'none');
  });

  it('reads 409 shop_z_producer_busy, flat and nested', () => {
    const flat = {
      response: { data: { detail: 'shop_z_producer_busy', message: 'ממתין לקופה 1', canForce: true, reason: 'unsynced_shop_zs' } },
    };
    assert.deepEqual(producerBusyOf(flat), { message: 'ממתין לקופה 1', canForce: true, reason: 'unsynced_shop_zs' });
    const nested = { response: { data: { detail: { code: 'shop_z_producer_busy', message: 'ממתין', canForce: false } } } };
    assert.deepEqual(producerBusyOf(nested), { message: 'ממתין', canForce: false, reason: null });
    assert.equal(producerBusyOf({ response: { data: { detail: 'till_in_both_lists' } } }), null);
    assert.equal(refusalOf(flat)?.message, 'ממתין לקופה 1');
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
