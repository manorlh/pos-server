/**
 * Run with `npm test`. The shop's local network on the dashboard (lib/lanMode.ts): the main till
 * card's switch, its row per system, "סנכרון רשת מקומית", and a device's "לא משמש כשרת מקומי".
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  LAN_SYSTEMS,
  ageText,
  healthRows,
  healthTone,
  localNetworkBlock,
  localNetworkView,
  machineSuggests,
  machineSwitchBlock,
  syncTone,
  type MachineLanServer,
} from './lanMode';

const machine = (over: Partial<MachineLanServer> = {}): MachineLanServer => ({
  machineId: 'm1',
  lanServerExcluded: false,
  lanServerExcludedReason: null,
  lanServerExcludedAuto: false,
  lanServerExcludedSuggested: false,
  lanServerExcludedChosen: false,
  isMainTill: false,
  applies: true,
  canEdit: true,
  ...over,
});

describe('the switch "רשת מקומית"', () => {
  it('needs a main till to turn on, never to turn off', () => {
    assert.equal(localNetworkBlock({ localNetwork: false, mainTill: null }), 'needs_main_till');
    assert.equal(localNetworkBlock({ localNetwork: false, mainTill: { machineId: 'm1' } }), null);
    assert.equal(localNetworkBlock({ localNetwork: true, mainTill: null }), null);
  });

  it('on with a main till, on without one (inactive), off', () => {
    assert.equal(localNetworkView({ localNetwork: true, localMode: true }), 'on');
    assert.equal(localNetworkView({ localNetwork: true, localMode: false }), 'inactive');
    assert.equal(localNetworkView({ localNetwork: false, localMode: false }), 'off');
  });
});

describe('a row per system', () => {
  it('in the card’s order, a system the server left out shown as none', () => {
    const rows = healthRows([{ system: 'kds', state: 'soon', host: null }, { system: 'tables', state: 'lan', host: null }]);
    assert.deepEqual(rows.map((r) => r.system), [...LAN_SYSTEMS]);
    assert.equal(rows[0].state, 'lan');
    assert.equal(rows[1].state, 'none');
    assert.equal(rows[3].state, 'soon');
  });

  it('green through the main till, amber elsewhere on the LAN, red with nobody serving', () => {
    assert.equal(healthTone('lan'), 'ok');
    assert.equal(healthTone('other_host'), 'warn');
    assert.equal(healthTone('partial'), 'warn');
    assert.equal(healthTone('no_host'), 'bad');
    assert.equal(healthTone('soon'), 'muted');
    assert.equal(healthTone('cloud'), 'muted');
  });
});

describe('"סנכרון רשת מקומית"', () => {
  it('green synced, amber on its way or offline, red past a minute online', () => {
    assert.equal(syncTone({ state: 'synced', alert: false }), 'ok');
    assert.equal(syncTone({ state: 'syncing', alert: false }), 'warn');
    assert.equal(syncTone({ state: 'offline', alert: false }), 'warn');
    assert.equal(syncTone({ state: 'lagging', alert: true }), 'bad');
    assert.equal(syncTone({ state: 'unknown', alert: false }), 'muted');
    assert.equal(syncTone(null), 'muted');
  });

  it('the oldest change’s age, in seconds below a minute and whole minutes above', () => {
    assert.deepEqual(ageText(42), { key: 'seconds', values: { n: '42' } });
    assert.deepEqual(ageText(61), { key: 'minutes', values: { n: '1' } });
    assert.deepEqual(ageText(3600), { key: 'minutes', values: { n: '60' } });
    assert.equal(ageText(null), null);
  });
});

describe('a device: "לא משמש כשרת מקומי"', () => {
  it('a KDS screen by itself, never the main till, read-only for others, n/a off the LAN group', () => {
    assert.equal(machineSwitchBlock(machine()), null);
    assert.equal(machineSwitchBlock(machine({ lanServerExcluded: true, lanServerExcludedAuto: true })), 'kds_screen');
    assert.equal(machineSwitchBlock(machine({ isMainTill: true })), 'main_till');
    assert.equal(machineSwitchBlock(machine({ canEdit: false })), 'read_only');
    assert.equal(machineSwitchBlock(machine({ applies: false })), 'not_applicable');
  });

  it('a kiosk or a handheld nobody chose for is suggested', () => {
    assert.equal(machineSuggests(machine({ lanServerExcludedSuggested: true })), true);
    assert.equal(machineSuggests(machine({ lanServerExcludedSuggested: true, lanServerExcludedChosen: true })), false);
    assert.equal(machineSuggests(machine({ lanServerExcludedSuggested: true, lanServerExcluded: true })), false);
  });
});

describe('every text the card and the page show', () => {
  const he = JSON.parse(readFileSync(join(__dirname, '..', 'src', 'messages', 'he.json'), 'utf8')) as {
    mainTill: { localNetwork: Record<string, Record<string, string>> };
    machineLanServer: { blocked: Record<string, string> };
    independentTill: { lanServer: { column: string } };
  };
  it('a system, a state and a sync state each have their Hebrew', () => {
    const ln = he.mainTill.localNetwork;
    for (const s of LAN_SYSTEMS) assert.ok(ln.systems[s], s);
    for (const s of ['lan', 'other_host', 'no_host', 'cloud', 'off', 'soon', 'partial', 'none']) assert.ok(ln.states[s], s);
    for (const s of ['synced', 'syncing', 'lagging', 'offline', 'unknown', 'none', 'seconds', 'minutes', 'alert']) assert.ok(ln.sync[s], s);
    for (const b of ['read_only', 'kds_screen', 'main_till', 'not_applicable']) assert.ok(he.machineLanServer.blocked[b], b);
    assert.ok(he.independentTill.lanServer.column);
  });
});
