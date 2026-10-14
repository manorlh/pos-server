/**
 * Run with `npm test`. "חסימות מהקופה" and "חסימה מהירה" as the dashboard shows and sends them
 * (lib/itemBlockControl.ts; P:/specs/item-block-control.md).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  channelsText,
  effectiveOf,
  managingBody,
  managingPickOf,
  managingSummary,
  ownPayload,
  quickDefaultsText,
  quickLeftovers,
  quickScopeText,
  quickTapChanges,
  sameOwn,
  samePick,
  toggleAll,
  toggleTill,
  withOwn,
  type ControlTill,
  type ControlView,
} from './itemBlockControl';

const DEFAULTS = {
  localMaxLevel: 'area',
  localChannels: ['pos'],
  managingMaxLevel: 'shop',
  releaseMode: 'own_scope',
  localRelease: true,
  quickDefaults: { channels: ['pos', 'kiosk', 'online', 'menu'], level: 'shop', duration: { mode: 'end_of_day' } },
} as ControlView['defaults'];

function till(id: string, role: ControlTill['role'], extra: Partial<ControlTill> = {}): ControlTill {
  return {
    id,
    name: `קופה ${id}`,
    posNumber: id,
    areaId: null,
    isMainTill: false,
    ownRole: null,
    role,
    roleSource: 'default',
    itemBlocks: {
      role,
      localMaxLevel: 'area',
      localChannels: ['pos'],
      managingMaxLevel: 'shop',
      releaseMode: 'own_scope',
      localRelease: true,
    },
    ...extra,
  };
}

describe('one level: own, inherited, default', () => {
  const view = {
    own: { localMaxLevel: 'shop' as const },
    inherited: { localMaxLevel: 'machine' as const, releaseMode: 'any_in_shop' as const },
    inheritedFrom: { localMaxLevel: 'company' as const, releaseMode: 'tenant' as const },
    defaults: DEFAULTS,
  };

  it('takes its own, else what it inherits and from where, else the default', () => {
    assert.deepEqual(effectiveOf(view, 'localMaxLevel'), { value: 'shop', from: 'own' });
    assert.deepEqual(effectiveOf(view, 'releaseMode'), { value: 'any_in_shop', from: 'inherited', source: 'tenant' });
    assert.deepEqual(effectiveOf(view, 'localChannels'), { value: ['pos'], from: 'default' });
    assert.deepEqual(effectiveOf(view, 'role'), { value: undefined, from: 'default' }, 'no role anywhere: by the main till');
  });

  it('sets and clears a key, and sends null when nothing is left', () => {
    const next = withOwn(view.own, 'localChannels', ['kiosk', 'pos']);
    assert.deepEqual(ownPayload(next), { localMaxLevel: 'shop', localChannels: ['pos', 'kiosk'] }, 'channels in order');
    assert.equal(ownPayload(withOwn(view.own, 'localMaxLevel', undefined)), null);
    assert.ok(sameOwn({ localChannels: ['kiosk', 'pos'] }, { localChannels: ['pos', 'kiosk'] }));
    assert.ok(!sameOwn({ role: 'local' }, {}));
  });
});

describe('the managing-till picker', () => {
  const tills = [till('1', 'managing', { isMainTill: true }), till('2', 'local'), till('3', 'local')];

  it('reads the server: "all" only when the level itself says so', () => {
    assert.deepEqual(managingPickOf({ own: {}, tills }), { all: false, selected: ['1'] });
    assert.deepEqual(managingPickOf({ own: { role: 'managing' }, tills: [till('1', 'managing'), till('2', 'local')] }), {
      all: true,
      selected: ['1'],
    });
  });

  it('several tills, all of them, and back to the main till', () => {
    let pick = managingPickOf({ own: {}, tills });
    pick = toggleTill(pick, '3', true);
    assert.deepEqual(pick.selected, ['1', '3']);
    assert.equal(managingSummary(pick, tills), 'קופה 1 (1) · קופה 3 (3)');
    pick = toggleAll(pick, tills, true);
    assert.equal(managingSummary(pick, tills), 'כל הקופות');
    pick = toggleTill(pick, '2', false);
    assert.equal(managingSummary(pick, tills), 'כל הקופות חוץ מ: קופה 2 (2)');
    assert.deepEqual(managingBody('s', null, pick), { shopId: 's', areaId: undefined, all: true, machineIds: ['1', '3'] });
    assert.deepEqual(toggleAll(pick, tills, false), { all: false, selected: ['1'] });
    assert.equal(managingSummary({ all: false, selected: [] }, tills), 'אין קופה מנהלת');
    assert.ok(samePick({ all: false, selected: ['3', '1'] }, { all: false, selected: ['1', '3'] }));
  });
});

describe('the quick block', () => {
  const quick = { channels: ['pos', 'kiosk', 'online', 'menu'] as const, level: 'shop' as const, duration: { mode: 'end_of_day' as const } };

  it('words the defaults', () => {
    assert.equal(quickDefaultsText({ ...quick, channels: [...quick.channels] }), 'כל הערוצים · הסניף · עד סוף היום');
    assert.equal(
      quickDefaultsText({ channels: ['kiosk'], level: 'company', duration: { mode: 'minutes', minutes: 120 } }),
      'קיוסק · כל החברה · 2 שעות',
    );
    assert.equal(channelsText(['menu', 'pos']), 'קופה, תפריט דיגיטלי');
  });

  it('a tap on the state it has does nothing', () => {
    assert.equal(quickTapChanges({ state: 'sold_out' }, 'sold_out'), false);
    assert.equal(quickTapChanges({ state: 'sold_out' }, 'available'), true);
  });

  it('says where it is stopped, and what "זמין" leaves', () => {
    assert.equal(quickScopeText({ state: 'blocked', scopeName: 'הסניף', scopeLevel: 'shop' }), 'חסום · הסניף');
    assert.equal(quickScopeText({ state: 'available', scopeName: null, scopeLevel: null }), null);
    const blocks = [
      { id: 'a', kind: 'sold_out' as const, level: 'shop', channels: ['pos' as const], until: null, itemType: 'product' as const },
      { id: 'b', kind: 'sold_out' as const, level: 'shop', channels: ['pos' as const], until: null, itemType: 'category' as const },
      { id: 'c', kind: 'blocked' as const, level: 'company', channels: ['pos' as const], until: null, itemType: 'product' as const },
    ];
    assert.deepEqual(quickLeftovers({ blocks }, { channels: ['pos'], level: 'shop' }).map((b) => b.id), ['b', 'c']);
    assert.deepEqual(quickLeftovers({ blocks }, { channels: ['kiosk'], level: 'company' }).map((b) => b.id), ['a', 'b', 'c']);
  });
});
