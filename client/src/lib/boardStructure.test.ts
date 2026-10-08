import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { narrowToTills, structureTree } from './boardStructure';

const companies = [
  { id: 'c2', name: 'Beta', companyNumber: 2 },
  { id: 'c1', name: 'Alpha', companyNumber: 1 },
];
const shops = [
  { id: 's1', companyId: 'c1', name: 'Center', shopNumber: 1 },
  { id: 's2', companyId: 'c1', name: 'North', shopNumber: 2 },
  { id: 's3', companyId: 'c2', name: 'Far', shopNumber: 1 },
];
const machines = [
  { id: 'm2', name: 'Till 2', shopId: 's1', posNumber: '2', areaId: 'bar' },
  { id: 'm1', name: 'Till 1', shopId: 's1', posNumber: '1', areaId: null },
  { id: 'k1', name: 'Kitchen screen', shopId: 's1', fiscal: false },
  { id: 'old', name: 'Retired', shopId: 's1', posNumber: '3', isActive: false },
  { id: 'n1', name: 'North 1', shopId: 's2', posNumber: '1' },
];

describe('the board without the overview (no sales figures)', () => {
  it('companies › shops › active tills, in their numbers order, money at zero', () => {
    const tree = structureTree({ companies, shops, machines, shopIds: ['s1', 's2', 's3'] });
    assert.deepEqual(tree.map((c) => c.id), ['c1', 'c2']);
    const center = tree[0].shops[0];
    // A display device and a retired till are not tills of the board.
    assert.deepEqual(center.machines.map((m) => m.id), ['m1', 'm2']);
    assert.equal(center.salesToday, 0);
    assert.deepEqual(tree[1].shops[0].machines, []);
  });

  it('only the scope\'s shops, one till when chosen, the chosen shop\'s points of sale', () => {
    const tree = structureTree({
      companies, shops, machines, shopIds: ['s1'], machineId: null,
      areas: { shopId: 's1', list: [{ id: 'bar', name: 'Bar' }] },
    });
    assert.deepEqual(tree.map((c) => c.id), ['c1']);
    assert.deepEqual(tree[0].shops[0].areas?.map((a) => [a.name, a.machineIds]), [['Bar', ['m2']]]);
    const one = structureTree({ companies, shops, machines, shopIds: ['s1', 's2'], machineId: 'n1' });
    assert.deepEqual(one[0].shops.map((s) => s.id), ['s2']);
  });

  it('an event keeps its own tills only', () => {
    const tree = structureTree({ companies, shops, machines, shopIds: ['s1', 's2'] });
    const narrowed = narrowToTills(tree, ['m2']);
    assert.deepEqual(narrowed.flatMap((c) => c.shops.map((s) => [s.id, s.machines.map((m) => m.id)])), [['s1', ['m2']]]);
    assert.deepEqual(narrowToTills(tree, []), []);
  });
});
