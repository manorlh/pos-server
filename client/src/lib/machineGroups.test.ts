/**
 * Run with `npm test`. "קבוצות מכשירים" (lib/machineGroups.ts): which tills a group may hold,
 * names as the server keeps them, and its refusals as codes.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanGroupName,
  companySubtree,
  eligibleTills,
  groupNameTaken,
  machineGroupErrorCode,
  sameMembers,
  toggleMember,
} from './machineGroups';

const companies = [
  { id: 'c-root', parentCompanyId: null },
  { id: 'c-north', parentCompanyId: 'c-root' },
  { id: 'c-north-2', parentCompanyId: 'c-north' },
  { id: 'c-rival', parentCompanyId: null },
];
const shops = [
  { id: 's-root', companyId: 'c-root' },
  { id: 's-north', companyId: 'c-north' },
  { id: 's-deep', companyId: 'c-north-2' },
  { id: 's-rival', companyId: 'c-rival' },
];
const machines = [
  { id: 'm1', shopId: 's-root', status: 'online' },
  { id: 'm2', shopId: 's-north', status: 'offline' },
  { id: 'm3', shopId: 's-deep', status: null },
  { id: 'm4', shopId: 's-rival', status: 'online' },
  { id: 'm5', shopId: 's-north', status: 'retired' },
  { id: 'm6', shopId: null, status: 'not_paired' },
];

describe('companySubtree', () => {
  it('holds the company and every company beneath it', () => {
    assert.deepEqual([...companySubtree(companies, 'c-root')].sort(), ['c-north', 'c-north-2', 'c-root']);
    assert.deepEqual([...companySubtree(companies, 'c-north')].sort(), ['c-north', 'c-north-2']);
    assert.deepEqual([...companySubtree(companies, 'c-rival')], ['c-rival']);
  });

  it('stops on a loop in the data', () => {
    const loop = [
      { id: 'a', parentCompanyId: 'b' },
      { id: 'b', parentCompanyId: 'a' },
    ];
    assert.deepEqual([...companySubtree(loop, 'a')].sort(), ['a', 'b']);
  });
});

describe('eligibleTills', () => {
  it('offers the active tills of shops under the company, across its shops', () => {
    assert.deepEqual(
      eligibleTills(machines, shops, companies, 'c-root').map((m) => m.id),
      ['m1', 'm2', 'm3'],
    );
    assert.deepEqual(
      eligibleTills(machines, shops, companies, 'c-north').map((m) => m.id),
      ['m2', 'm3'],
    );
  });

  it('never a retired till, one without a shop, or another company’s', () => {
    const ids = eligibleTills(machines, shops, companies, 'c-root').map((m) => m.id);
    assert.ok(!ids.includes('m4') && !ids.includes('m5') && !ids.includes('m6'));
    assert.deepEqual(
      eligibleTills(machines, shops, companies, 'c-rival').map((m) => m.id),
      ['m4'],
    );
  });
});

describe('names', () => {
  it('are kept as the server keeps them', () => {
    assert.equal(cleanGroupName('  עמדות   אירוע \n'), 'עמדות אירוע');
    assert.equal(cleanGroupName('   '), '');
    assert.equal(cleanGroupName('x'.repeat(100)).length, 80);
  });

  it('are once per company, without case', () => {
    const groups = [
      { id: 'g1', companyId: 'c-root', name: 'Bar' },
      { id: 'g2', companyId: 'c-north', name: 'בר' },
    ];
    assert.equal(groupNameTaken(groups, 'c-root', ' bar '), true);
    assert.equal(groupNameTaken(groups, 'c-root', 'bar', 'g1'), false, 'its own name');
    assert.equal(groupNameTaken(groups, 'c-rival', 'Bar'), false, 'another company');
    assert.equal(groupNameTaken(groups, 'c-north', 'בר'), true);
    assert.equal(groupNameTaken(groups, 'c-root', '  '), false);
  });
});

describe('members', () => {
  it('toggle once each, in the order chosen', () => {
    assert.deepEqual(toggleMember(['a', 'b'], 'c', true), ['a', 'b', 'c']);
    assert.deepEqual(toggleMember(['a', 'b'], 'a', true), ['b', 'a']);
    assert.deepEqual(toggleMember(['a', 'b'], 'a', false), ['b']);
    assert.deepEqual(toggleMember([], 'a', false), []);
  });

  it('compare without order', () => {
    assert.equal(sameMembers(['a', 'b'], ['b', 'a']), true);
    assert.equal(sameMembers(['a', 'b'], ['a']), false);
    assert.equal(sameMembers(['a', 'b'], ['a', 'c']), false);
  });
});

describe('machineGroupErrorCode', () => {
  it('reads the server’s refusals', () => {
    assert.equal(machineGroupErrorCode('machine_group_name_taken'), 'machine_group_name_taken');
    assert.equal(
      machineGroupErrorCode('machine_not_in_company:0f6c1d2e-0000-4000-8000-000000000001'),
      'machine_not_in_company',
    );
    assert.equal(machineGroupErrorCode('something_else'), null);
    assert.equal(machineGroupErrorCode({ detail: 'x' }), null);
    assert.equal(machineGroupErrorCode(undefined), null);
  });
});
