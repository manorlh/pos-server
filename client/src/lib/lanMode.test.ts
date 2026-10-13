/**
 * Run with `npm test`. The shop's local network on the dashboard (lib/lanMode.ts): the main till
 * card's switch, its row per system, "סנכרון רשת מקומית", and a device's "לא משמש כשרת מקומי".
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CLOSE_FROM_CLOUD_AFTER_SECONDS,
  CLOSE_FROM_CLOUD_BLOCKS,
  EMPTY_SWITCH_FORM,
  LAN_SYSTEMS,
  SWITCH_BLOCKS,
  SWITCH_SUMMARY_KEYS,
  TILL_TAKEOVER_MODES,
  ageText,
  closeFromCloudBlock,
  eligibleTargets,
  hostOnline,
  isSilent,
  lastSwitchKey,
  tillTakeoverKey,
  parseCountedCash,
  shiftStep,
  silentSecondsAt,
  switchBlock,
  switchBody,
  switchSummary,
  type LocalServerState,
  type LocalServerTill,
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

// ── "העברת שרת מקומי" and "סגירת משמרת מהענן" ─────────────────────────────────

const NOW = Date.parse('2026-10-13T20:00:00Z');
const ago = (s: number) => new Date(NOW - s * 1000).toISOString();

const till = (over: Partial<LocalServerTill> = {}): LocalServerTill => ({
  machineId: 'old',
  posNumber: '1',
  name: 'קופה 1',
  online: false,
  lastHeartbeatAt: ago(900),
  silentSeconds: 900,
  canCloseFromCloud: true,
  openShift: { shiftId: 's1', sequenceNumber: 7 },
  pendingDocuments: 3,
  ...over,
});

const state = (over: Partial<LocalServerState> = {}): LocalServerState => ({
  shopId: 'shop',
  server: till(),
  candidates: [
    { machineId: 'new', posNumber: '2', name: 'קופה 2', online: true, lastHeartbeatAt: ago(5), eligible: true, reason: null, reasonText: null },
    { machineId: 'win', posNumber: '3', name: 'קופה 3', online: true, lastHeartbeatAt: ago(5), eligible: false, reason: 'not_android', reasonText: 'x' },
  ],
  tablesLan: true,
  localMode: true,
  shopZ: { producer: { kind: 'local', machine: { machineId: 'old', posNumber: '1' }, since: null }, handover: null },
  closeFromCloudAfterSeconds: 300,
  canSwitch: true,
  canForce: true,
  canReleaseShopZ: false,
  lastSwitch: null,
  switches: [],
  formerHostChanges: { count: 0, items: [], checked: [] },
  ...over,
});

const label = (r: { posNumber?: string | null } | null | undefined) => (r?.posNumber ? `קופה ${r.posNumber}` : '—');

describe('"סגירת משמרת מהענן": only a till not heard for 5 minutes', () => {
  it('reads the silence by the clock, never heard counting as silent', () => {
    assert.equal(silentSecondsAt(ago(42), NOW), 42);
    assert.equal(silentSecondsAt(null, NOW), null);
    assert.equal(silentSecondsAt('not a date', NOW), null);
    assert.equal(isSilent(ago(299), NOW), false);
    assert.equal(isSilent(ago(300), NOW), true);
    assert.equal(isSilent(null, NOW), true);
    assert.equal(CLOSE_FROM_CLOUD_AFTER_SECONDS, 300);
  });
  it('is offered on the device page only for a silent till with an open shift', () => {
    assert.equal(closeFromCloudBlock({ lastHeartbeatAt: ago(600), hasOpenShift: true }, NOW), null);
    assert.equal(closeFromCloudBlock({ lastHeartbeatAt: ago(60), hasOpenShift: true }, NOW), 'heard_recently');
    assert.equal(closeFromCloudBlock({ lastHeartbeatAt: ago(600), hasOpenShift: false }, NOW), 'no_open_shift');
    assert.equal(closeFromCloudBlock({ lastHeartbeatAt: ago(600), hasOpenShift: true, removed: true }, NOW), 'removed');
    assert.equal(closeFromCloudBlock({ lastHeartbeatAt: ago(600), hasOpenShift: true, display: true }, NOW), 'display');
  });
  it('takes a cash count typed by hand, or none', () => {
    assert.equal(parseCountedCash(''), null);
    assert.equal(parseCountedCash('  '), null);
    assert.equal(parseCountedCash('140'), 140);
    assert.equal(parseCountedCash('99,5'), 99.5);
    assert.equal(parseCountedCash('-3'), 'invalid');
    assert.equal(parseCountedCash('abc'), 'invalid');
    assert.equal(parseCountedCash('1.234'), 'invalid');
  });
});

describe('the wizard "העברת שרת מקומי"', () => {
  it('offers only online Android tills of the shop, never the server', () => {
    assert.deepEqual(eligibleTargets(state()).map((c) => c.machineId), ['new']);
    const self = state({ candidates: [{ ...state().candidates[0], machineId: 'old' }] });
    assert.deepEqual(eligibleTargets(self), []);
  });
  it('refuses while the cloud hears the old server, unless forced by a permitted user', () => {
    const heard = state({ server: till({ online: true, silentSeconds: 20, canCloseFromCloud: false }) });
    const form = { ...EMPTY_SWITCH_FORM, targetMachineId: 'new' };
    assert.equal(hostOnline(heard), true);
    assert.equal(switchBlock(heard, form), 'host_online');
    assert.equal(switchBlock(heard, { ...form, force: true }), null);
    assert.equal(switchBlock({ ...heard, canForce: false }, { ...form, force: true }), 'host_online');
    // Its shift cannot be closed from the cloud while it is heard.
    assert.equal(shiftStep(heard), 'heard_recently');
    assert.equal(switchBlock(heard, { ...form, force: true, closeOldShift: true }), 'shift_not_closable');
  });
  it('checks the rest before confirming', () => {
    const s = state();
    assert.equal(switchBlock(s, EMPTY_SWITCH_FORM), 'no_target');
    assert.equal(switchBlock(s, { ...EMPTY_SWITCH_FORM, targetMachineId: 'win' }), 'no_target');
    const form = { ...EMPTY_SWITCH_FORM, targetMachineId: 'new' };
    assert.equal(switchBlock(s, form), null);
    assert.equal(switchBlock(s, { ...form, closeOldShift: true, countedCash: 'x' }), 'bad_cash');
    assert.equal(switchBlock(s, { ...form, releaseShopZ: true }), 'release_forbidden');
    assert.equal(switchBlock({ ...s, canReleaseShopZ: true }, { ...form, releaseShopZ: true }), null);
    assert.equal(switchBlock({ ...s, canSwitch: false }, form), 'forbidden');
    assert.equal(shiftStep(state({ server: till({ openShift: null }) })), 'none');
  });
  it('sends only what applies (§8)', () => {
    const s = state();
    assert.deepEqual(switchBody(s, { ...EMPTY_SWITCH_FORM, targetMachineId: 'new', force: true }), { targetMachineId: 'new' });
    assert.deepEqual(
      switchBody(s, { ...EMPTY_SWITCH_FORM, targetMachineId: 'new', closeOldShift: true, countedCash: '140' }),
      { targetMachineId: 'new', closeOldShift: true, countedCash: 140 },
    );
    assert.deepEqual(
      switchBody(s, { ...EMPTY_SWITCH_FORM, targetMachineId: 'new', closeOldShift: true }),
      { targetMachineId: 'new', closeOldShift: true, countedCash: null },
    );
    const heard = state({ server: till({ online: true }) });
    assert.deepEqual(
      switchBody(heard, { ...EMPTY_SWITCH_FORM, targetMachineId: 'new', force: true, releaseShopZ: true }),
      { targetMachineId: 'new', force: true, releaseShopZ: true },
    );
  });
  it('sums up what moves, the shift, the shop Z and the notice', () => {
    const keys = (lines: { key: string }[]) => lines.map((l) => l.key);
    const s = state();
    const form = { ...EMPTY_SWITCH_FORM, targetMachineId: 'new' };
    const lines = switchSummary(s, form, label);
    assert.deepEqual(keys(lines), ['move', 'roles', 'shiftStays', 'zFrozen', 'notice']);
    assert.deepEqual(lines[0].values, { from: 'קופה 1', to: 'קופה 2' });
    assert.deepEqual(
      keys(switchSummary(s, { ...form, closeOldShift: true, countedCash: '140', releaseShopZ: true }, label)),
      ['move', 'roles', 'closeShiftCounted', 'zReleased', 'notice'],
    );
    const heard = state({ server: till({ online: true, openShift: null }) });
    assert.deepEqual(keys(switchSummary(heard, { ...form, force: true }, label)), ['move', 'roles', 'zFrozen', 'forced', 'notice']);
    assert.deepEqual(keys(switchSummary(state({ server: null }), form, label)), ['first', 'roles', 'notice']);
  });
  it('has its Hebrew for every step, line and refusal', () => {
    const he = JSON.parse(readFileSync(join(__dirname, '..', 'src', 'messages', 'he.json'), 'utf8')) as {
      localServer: Record<string, Record<string, string> | string>;
      dashboardAccess: { sections: Record<string, string> };
      exceptions: { types: Record<string, string> };
      exceptionSettings: { desc: Record<string, string> };
    };
    const ls = he.localServer as Record<string, Record<string, string>>;
    for (const k of SWITCH_SUMMARY_KEYS) assert.ok(ls.summary[k], k);
    for (const k of SWITCH_BLOCKS) assert.ok(ls.blocked[k], k);
    for (const k of CLOSE_FROM_CLOUD_BLOCKS) assert.ok(ls.closeFromCloud[`blocked_${k}`], k);
    for (const k of ['not_assigned', 'independent', 'lan_excluded', 'kiosk', 'not_android', 'offline']) assert.ok(ls.ineligible[k], k);
    for (const k of ['title', 'open', 'confirm', 'forceLabel', 'forceWarning', 'closeShiftLabel', 'releaseZLabel']) assert.ok(ls.wizard[k], k);
    for (const k of ['title', 'confirm', 'countedCash', 'reason', 'done']) assert.ok(ls.closeFromCloud[k], k);
    for (const k of ['title', 'markChecked', 'till', 'cloud']) assert.ok(ls.changes[k], k);
    assert.ok(he.dashboardAccess.sections.local_server_switch);
    for (const k of ['local_server_switched', 'shift_closed_from_cloud', 'cloud_closed_shift_late_documents']) {
      assert.ok(he.exceptions.types[k], k);
      assert.ok(he.exceptionSettings.desc[k], k);
    }
    // "העברת שרת מקומי מהקופה" (§9): the wizard's lines, and the parameter's values in words.
    for (const k of ['lastSwitchFromTill', 'tillTakeoverOff', 'tillTakeoverManager']) assert.ok(ls.wizard[k], k);
    const tp = (he as unknown as { tillParameters: { enumLabels: Record<string, Record<string, string>> } }).tillParameters;
    for (const mode of TILL_TAKEOVER_MODES) assert.ok(tp.enumLabels.tillServerTakeover[mode], mode);
  });
});

describe('"העברת שרת מקומי מהקופה" (tillServerTakeover)', () => {
  it('reads anything but manager as the cloud only', () => {
    assert.equal(tillTakeoverKey('manager'), 'tillTakeoverManager');
    for (const v of ['off', undefined, null, '', 'MANAGER', 'on']) assert.equal(tillTakeoverKey(v), 'tillTakeoverOff', String(v));
  });
  it('says a switch from a till as one', () => {
    assert.equal(lastSwitchKey({ source: 'till' }), 'lastSwitchFromTill');
    assert.equal(lastSwitchKey({ source: 'cloud' }), 'lastSwitch');
    assert.equal(lastSwitchKey({}), 'lastSwitch');
  });
});
