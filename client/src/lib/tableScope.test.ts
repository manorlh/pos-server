/**
 * Run with `npm test`. "תחום שולחנות" (P:/specs/table-scope.md §2, §3, §14.9): the picker's toggles, what a
 * scope covers, the ids still on the floor, and the employee card's "לא חופפים" warning.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  coveredTables,
  devicesWithoutOverlap,
  liveScope,
  sameScope,
  scopeCounts,
  scopeOf,
  sharesTables,
  toggleTable,
  toggleZone,
  type ScopeTreeZone,
} from './tableScope';

const zone = (id: string, tables: string[]): ScopeTreeZone => ({
  id,
  name: id,
  areaId: null,
  areaName: null,
  tables: tables.map((t, i) => ({ id: t, number: i + 1, label: null, name: null, title: String(i + 1) })),
});

// "מפלס 2" (2A, 2B), "מפלס 3" (3A, 3B, 3C), "בר" with no table yet.
const floor = [zone('l2', ['2a', '2b']), zone('l3', ['3a', '3b', '3c']), zone('bar', [])];

describe('the table scope picker', () => {
  it('reads a served scope; null is every table', () => {
    assert.equal(scopeOf(null), null);
    assert.deepEqual(scopeOf({ zoneIds: ['l2', 'l2', ' '], tableIds: undefined }), { zoneIds: ['l2'], tableIds: [] });
  });

  it('a zone checked takes its tables in (its single tables folded into it); unchecked lets them go', () => {
    let s = toggleTable({ zoneIds: [], tableIds: [] }, '3a', true);
    s = toggleTable(s, '2a', true);
    s = toggleZone(s, floor[1], true);
    assert.deepEqual(s, { zoneIds: ['l3'], tableIds: ['2a'] });
    assert.deepEqual([...coveredTables(s, floor)].sort(), ['2a', '3a', '3b', '3c']);
    s = toggleZone(s, floor[1], false);
    assert.deepEqual(s, { zoneIds: [], tableIds: ['2a'] });
    assert.deepEqual(toggleTable(s, '2a', false), { zoneIds: [], tableIds: [] });
  });

  it('drops what the floor no longer has, keeps null as null', () => {
    assert.deepEqual(liveScope({ zoneIds: ['l2', 'gone'], tableIds: ['3a', 'old'] }, floor), { zoneIds: ['l2'], tableIds: ['3a'] });
    assert.equal(liveScope(null, floor), null);
    assert.deepEqual(scopeCounts({ zoneIds: ['l2', 'gone'], tableIds: ['3a'] }, floor), { zones: 1, tables: 1, covered: 3 });
  });

  it('the same scope whatever the order', () => {
    assert.ok(sameScope({ zoneIds: ['a', 'b'], tableIds: [] }, { zoneIds: ['b', 'a'], tableIds: [] }));
    assert.ok(!sameScope({ zoneIds: [], tableIds: [] }, null));
    assert.ok(sameScope(null, null));
  });
});

describe('"התחום של המכשיר והתחום של העובד לא חופפים"', () => {
  const devices = [
    { id: 'd2', name: 'מסופון 2', tableScope: { zoneIds: ['l2'], tableIds: [] } },
    { id: 'd8', name: 'מסופון 8', tableScope: { zoneIds: ['l3'], tableIds: [] } },
    { id: 'bar', name: 'קופת בר', tableScope: { zoneIds: ['bar'], tableIds: [] } },
    { id: 'all', name: 'טאבלט', tableScope: null },
  ];

  it('names every device whose scope shares no table with hers', () => {
    const dana = { zoneIds: [], tableIds: ['3a', '3b'] };
    assert.deepEqual(devicesWithoutOverlap(dana, devices, floor).map((d) => d.id), ['d2', 'bar']);
    // No scope of her own: she sees each device's.
    assert.deepEqual(devicesWithoutOverlap(null, devices, floor), []);
    // The same zone, even with no table in it yet, is in common.
    assert.ok(sharesTables({ zoneIds: ['bar'], tableIds: [] }, { zoneIds: ['bar'], tableIds: [] }, floor));
    // An empty scope (sees nothing) shares nothing.
    assert.ok(!sharesTables({ zoneIds: [], tableIds: [] }, { zoneIds: ['l3'], tableIds: [] }, floor));
  });
});
