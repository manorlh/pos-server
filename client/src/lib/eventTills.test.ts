/**
 * Run with `npm test`. "שיוך קופות מהיר לאירוע" — the tills pickers' rules (lib/eventTills.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  applySelector,
  assignableSelection,
  availableSelectors,
  copyFromEvent,
  hasChanges,
  joinableEvents,
  movesToSend,
  nowUntilEndOfDay,
  searchTills,
  selectorState,
  tillChanges,
  tillConflicts,
  unresolvedConflicts,
} from './eventTills';
import type { EventTillOption } from './eventTypes';

const busy = (name: string) => ({
  eventId: `ev-${name}`,
  eventName: name,
  startsAt: '2026-10-09T15:00:00Z',
  endsAt: '2026-10-09T20:00:00Z',
});

function till(id: string, extra: Partial<EventTillOption> = {}): EventTillOption {
  return {
    id,
    name: `קופה ${id}`,
    posNumber: id,
    areaId: null,
    areaName: null,
    kind: 'till',
    groupIds: [],
    lastHeartbeatAt: null,
    busy: null,
    ...extra,
  };
}

// 1, 2 at the bar; 3 at the gate and in "עמדות"; 4 a kiosk in "עמדות"; 5 at the bar, busy in "פסטיבל".
const TILLS: EventTillOption[] = [
  till('1', { areaId: 'bar', areaName: 'בר' }),
  till('2', { areaId: 'bar', areaName: 'בר' }),
  till('3', { areaId: 'gate', areaName: 'כניסה', groupIds: ['stands'] }),
  till('4', { kind: 'kiosk', name: 'קיוסק לובי', groupIds: ['stands'] }),
  till('5', { areaId: 'bar', areaName: 'בר', busy: busy('פסטיבל') }),
];

describe('one-tap selectors', () => {
  it('"כל הסניף" picks every free till and counts the busy one as skipped', () => {
    const r = applySelector([], TILLS, { kind: 'all' });
    assert.deepEqual(r.ids, ['1', '2', '3', '4']);
    assert.deepEqual(r.skippedBusy.map((t) => t.id), ['5']);
  });

  it('"רק קופות" and "רק קיוסקים" replace the selection', () => {
    assert.deepEqual(applySelector(['4'], TILLS, { kind: 'tills' }).ids, ['1', '2', '3']);
    assert.deepEqual(applySelector(['1', '2'], TILLS, { kind: 'kiosks' }).ids, ['4']);
  });

  it('an area adds its free tills, and a second tap takes them away', () => {
    const once = applySelector(['3'], TILLS, { kind: 'area', areaId: 'bar' });
    assert.deepEqual(once.ids, ['1', '2', '3']);
    assert.deepEqual(once.skippedBusy.map((t) => t.id), ['5']);
    const twice = applySelector(once.ids, TILLS, { kind: 'area', areaId: 'bar' });
    assert.deepEqual(twice.ids, ['3']);
  });

  it('a device group picks its tills across areas, kiosks included', () => {
    assert.deepEqual(applySelector(['1'], TILLS, { kind: 'group', groupId: 'stands' }).ids, ['1', '3', '4']);
  });

  it('a busy till picked by hand stays when an area is added', () => {
    assert.deepEqual(applySelector(['5'], TILLS, { kind: 'area', areaId: 'gate' }).ids, ['3', '5']);
  });

  it('the chip shows whether its tills are picked', () => {
    assert.equal(selectorState(['1', '2'], TILLS, { kind: 'area', areaId: 'bar' }), 'on');
    assert.equal(selectorState(['1'], TILLS, { kind: 'area', areaId: 'bar' }), 'partial');
    assert.equal(selectorState([], TILLS, { kind: 'area', areaId: 'bar' }), 'off');
    assert.equal(selectorState(['1', '2', '3', '4'], TILLS, { kind: 'all' }), 'on');
    // "רק קופות" is on only when nothing else is picked.
    assert.equal(selectorState(['1', '2', '3'], TILLS, { kind: 'tills' }), 'on');
    assert.equal(selectorState(['1', '2', '3', '4'], TILLS, { kind: 'tills' }), 'partial');
  });

  it('offers only the chips the shop has', () => {
    const chips = availableSelectors({
      tills: TILLS,
      areas: [{ id: 'gate', name: 'כניסה' }, { id: 'bar', name: 'בר' }, { id: 'empty', name: 'ריק' }],
      groups: [{ id: 'stands', name: 'עמדות' }],
    });
    assert.deepEqual(chips.kinds, ['all', 'tills', 'kiosks']);
    assert.deepEqual(chips.areas.map((a) => [a.id, a.count]), [['gate', 1], ['bar', 3]]);
    assert.deepEqual(chips.groups.map((g) => [g.id, g.count]), [['stands', 2]]);
    const plain = availableSelectors({ tills: [till('1', { areaId: 'a' }), till('2', { areaId: 'a' })], areas: [{ id: 'a', name: 'A' }], groups: [] });
    assert.deepEqual(plain.kinds, ['all']);
    assert.deepEqual(plain.areas, []); // one area holding every till: nothing to choose
  });
});

describe('search', () => {
  const groups = new Map([['stands', 'עמדות אירוע']]);
  it('matches the name, the register number, the area and the group', () => {
    assert.deepEqual(searchTills(TILLS, 'לובי').map((t) => t.id), ['4']);
    assert.deepEqual(searchTills(TILLS, 'קופה 3').map((t) => t.id), ['3']);
    assert.deepEqual(searchTills(TILLS, 'בר').map((t) => t.id), ['1', '2', '5']);
    assert.deepEqual(searchTills(TILLS, 'עמדות', groups).map((t) => t.id), ['3', '4']);
    assert.deepEqual(searchTills(TILLS, '  כניסה   3 ').map((t) => t.id), ['3']);
    assert.equal(searchTills(TILLS, '').length, TILLS.length);
  });
});

describe('copy from a previous event', () => {
  it('takes its tills the shop still has, leaving the busy ones out', () => {
    const r = copyFromEvent(TILLS, ['3', '5', 'gone', '1']);
    assert.deepEqual(r.ids, ['1', '3']);
    assert.deepEqual(r.skippedBusy.map((t) => t.id), ['5']);
    assert.equal(r.missing, 1);
  });
});

describe('overlaps: "העבר לאירוע הזה"', () => {
  it('a busy till picked by hand is a conflict until it is marked to move', () => {
    const conflicts = tillConflicts(['1', '5'], TILLS, []);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0].eventName, 'פסטיבל');
    assert.equal(unresolvedConflicts(conflicts).length, 1);
    const marked = tillConflicts(['1', '5'], TILLS, ['5']);
    assert.equal(unresolvedConflicts(marked).length, 0);
    assert.deepEqual(movesToSend(['1', '5'], TILLS, ['5']), ['5']);
  });

  it('never sends a move for a till unpicked or no longer busy', () => {
    assert.deepEqual(movesToSend(['1'], TILLS, ['5']), []);
    assert.deepEqual(movesToSend(['1'], TILLS, ['1']), []);
  });
});

describe('the bulk request', () => {
  it('adds, removes and moves from the event\'s tills to the picked ones', () => {
    const changes = tillChanges(['1', '2'], ['2', '3', '5'], ['5']);
    assert.deepEqual(changes, { add: ['3'], remove: ['1'], move: ['5'] });
    assert.equal(hasChanges(changes), true);
    assert.equal(hasChanges(tillChanges(['1'], ['1'])), false);
    // A move for a till not picked is dropped.
    assert.deepEqual(tillChanges([], ['1'], ['9']).move, []);
  });
});

describe('"שייך לאירוע" from the devices page', () => {
  it('needs one shop and leaves the screens out', () => {
    const r = assignableSelection([
      { id: 'a', shopId: 's1' },
      { id: 'b', shopId: 's1', deviceRole: 'kiosk' },
      { id: 'k', shopId: 's1', deviceRole: 'kds' },
      { id: 'n', shopId: null },
    ]);
    assert.equal(r.shopId, 's1');
    assert.deepEqual(r.tills.map((m) => m.id), ['a', 'b']);
    assert.deepEqual(r.screens.map((m) => m.id), ['k']);
    assert.deepEqual(r.noShop.map((m) => m.id), ['n']);
    const mixed = assignableSelection([{ id: 'a', shopId: 's1' }, { id: 'b', shopId: 's2' }]);
    assert.equal(mixed.shopId, null);
    assert.equal(mixed.mixedShops, true);
  });

  it('a new event runs from now until the end of the day, in the business time zone', () => {
    // 09.10.2026 14:37 UTC = 17:37 in Israel (IDT).
    const w = nowUntilEndOfDay(new Date('2026-10-09T14:37:20Z'), 'Asia/Jerusalem');
    assert.deepEqual(w, { startDate: '2026-10-09', startTime: '17:35', endDate: '2026-10-09', endTime: '23:59' });
    // 21:58 UTC is already the next day there.
    const late = nowUntilEndOfDay(new Date('2026-10-09T21:58:00Z'), 'Asia/Jerusalem');
    assert.deepEqual(late, { startDate: '2026-10-10', startTime: '00:55', endDate: '2026-10-10', endTime: '23:59' });
  });

  it('offers the draft events not over yet, soonest first', () => {
    const now = new Date('2026-10-09T12:00:00Z');
    const list = joinableEvents(
      [
        { id: 'later', status: 'draft', startsAt: '2026-10-10T15:00:00Z', endsAt: '2026-10-10T20:00:00Z' },
        { id: 'past', status: 'draft', startsAt: '2026-10-08T15:00:00Z', endsAt: '2026-10-08T20:00:00Z' },
        { id: 'confirmed', status: 'confirmed', startsAt: '2026-10-09T15:00:00Z', endsAt: '2026-10-09T20:00:00Z' },
        { id: 'tonight', status: 'draft', startsAt: '2026-10-09T15:00:00Z', endsAt: '2026-10-09T20:00:00Z' },
      ],
      now,
    );
    assert.deepEqual(list.map((e) => e.id), ['tonight', 'later']);
  });
});
