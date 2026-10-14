/**
 * Run with `npm test`. "עמדות מזומן" on the dashboard (lib/cashStations.ts; P:/specs/cash-paylink.md §11, §12;
 * pos-server app/services/cash_station_admin.py, cash_station_drawer.py, cash_params.py): money in words, the
 * pills, the reconciliation, the commands' bodies, the station settings form and the kiosk assignment.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  COMMAND_OPS,
  DUMP_NOTES_MAX,
  EMPTY_JOURNAL_FILTERS,
  ILS_DENOMINATIONS,
  MOVEMENT_KINDS,
  NO_ARG_OPS,
  RESOLUTIONS,
  STATION_SETTING_KEYS,
  TX_OUTCOMES,
  TX_STATES,
  addDays,
  agorotText,
  agorotToShekelsText,
  commandBody,
  commandDraftError,
  commandDraftTotal,
  denominationList,
  denominationText,
  effectiveText,
  emptyCommandDraft,
  idList,
  journalParams,
  pageInfo,
  piecesText,
  piecesTotal,
  reconciliationDifference,
  reconciliationState,
  settingsBody,
  settingsDraftOf,
  shekelsToAgorot,
  shortTxId,
  signedAgorotText,
  stationLabel,
  stationOfClient,
  stationPillOf,
  stationPillTone,
  txTone,
  type CashStation,
} from './cashStations';

describe('money in words', () => {
  it('agorot as the spec writes them ("הוכנסו 70 ₪ מתוך 57.35 ₪")', () => {
    assert.equal(agorotText(7000), '70 ₪');
    assert.equal(agorotText(5735), '57.35 ₪');
    assert.equal(agorotText(5), '0.05 ₪');
    assert.equal(agorotText(360000), '3,600 ₪');
    assert.equal(agorotText(-350), '-3.50 ₪');
    assert.equal(agorotText(0), '0 ₪');
    assert.equal(agorotText(null), '—');
    assert.equal(signedAgorotText(150), '+1.50 ₪');
    assert.equal(signedAgorotText(-300), '-3 ₪');
    assert.equal(signedAgorotText(0), '0 ₪');
  });

  it('coins under a shekel in agorot, the rest in shekels', () => {
    assert.deepEqual(ILS_DENOMINATIONS.map(denominationText), ["10 אג'", "50 אג'", '1 ₪', '2 ₪', '5 ₪', '10 ₪', '20 ₪', '50 ₪', '100 ₪', '200 ₪']);
  });

  it('shekels typed by staff, and back', () => {
    assert.equal(shekelsToAgorot('12.5'), 1250);
    assert.equal(shekelsToAgorot('12,50'), 1250);
    assert.equal(shekelsToAgorot(' 70 '), 7000);
    assert.equal(shekelsToAgorot(''), null);
    assert.equal(shekelsToAgorot('-3'), null);
    assert.equal(shekelsToAgorot('1.234'), null);
    assert.equal(agorotToShekelsText(10000), '100');
    assert.equal(agorotToShekelsText(5735), '57.35');
    assert.equal(agorotToShekelsText(null), '');
  });

  it('pieces: their total and their words, largest first', () => {
    const pieces = [
      { valueAgorot: 1000, kind: 'coin', count: 2 },
      { valueAgorot: 5000, kind: 'note', count: 1 },
      { valueAgorot: 100, kind: 'coin', count: 0 },
    ];
    assert.equal(piecesTotal(pieces), 7000);
    assert.equal(piecesText(pieces), '1 × 50 ₪ · 2 × 10 ₪');
    assert.equal(piecesText([]), '');
  });
});

const station = (over: Partial<CashStation> = {}): CashStation => ({
  stationId: 's1',
  shopId: 'shop',
  shopName: 'סניף',
  companyId: null,
  name: 'עמדת מזומן 2',
  location: 'ליד קיוסק 3',
  label: 'עמדת מזומן 2 (ליד קיוסק 3)',
  serial: 'AE000001',
  isActive: true,
  host: { machineId: 'h', name: 'שרת מזומן', online: true, lastHeartbeatAt: null, lanAddress: '192.168.1.40', port: 47630, version: '0.5.0', reportedAt: null },
  clients: [],
  status: {
    state: 'ready', ready: true, reason: null, changeAvailableAgorot: 45600, exactOnly: false, queue: 0, activeTxId: null,
    heldCount: 0, deviceSerial: null, firmware: null, reportedAt: null, stale: false,
  },
  alerts: [],
  owed: { count: 0, amountAgorot: 0 },
  settings: {},
  createdAt: null,
  updatedAt: null,
  ...over,
});

describe('the station pill', () => {
  it('the reported state, or why there is none', () => {
    assert.equal(stationPillOf(station()), 'ready');
    assert.equal(stationPillOf(station({ status: { ...station().status!, state: 'fault', ready: false, reason: 'תקיעה' } })), 'fault');
    assert.equal(stationPillOf(station({ isActive: false })), 'inactive');
    assert.equal(stationPillOf(station({ host: null })), 'no_host');
    assert.equal(stationPillOf(station({ status: null })), 'no_report');
    assert.equal(stationPillOf(station({ status: { ...station().status!, stale: true } })), 'offline');
    assert.equal(stationPillOf(station({ host: { ...station().host!, online: false } })), 'offline');
    assert.equal(stationPillOf(station({ status: { ...station().status!, state: 'weird' } })), 'unknown');
  });

  it('tones: ready green, busy blue, maintenance amber, fault and offline red', () => {
    assert.deepEqual(
      (['ready', 'busy', 'maintenance', 'starting', 'fault', 'offline', 'no_host', 'no_report', 'inactive', 'unknown'] as const).map(stationPillTone),
      ['ok', 'info', 'warn', 'warn', 'bad', 'bad', 'muted', 'warn', 'muted', 'bad'],
    );
  });

  it('a journal row: paid, refunded, nothing, held, open', () => {
    assert.equal(txTone({ state: 'DONE', outcome: 'paid' }), 'ok');
    assert.equal(txTone({ state: 'DONE', outcome: 'refunded' }), 'info');
    assert.equal(txTone({ state: 'DONE', outcome: 'nothing_inserted' }), 'muted');
    assert.equal(txTone({ state: 'HELD', outcome: null }), 'bad');
    assert.equal(txTone({ state: 'ACCEPTING', outcome: null }), 'warn');
    assert.equal(shortTxId('0123456789abcdef'), '01234567');
  });

  it('the label, the station a kiosk resolves to', () => {
    assert.equal(stationLabel({ name: 'א', location: 'ב' }), 'א (ב)');
    assert.equal(stationLabel({ name: 'א', location: null }), 'א');
    assert.equal(stationLabel({ name: 'א', location: 'ב', label: 'תווית' }), 'תווית');
    const stations = [
      { stationId: 'a', clients: [{ machineId: 'K1', name: 'קיוסק 1', kind: 'kiosk' }] },
      { stationId: 'b', clients: [{ machineId: 'k2', name: 'קיוסק 2', kind: 'kiosk' }] },
    ];
    assert.equal(stationOfClient(stations, 'k1'), 'a');
    assert.equal(stationOfClient(stations, 'K2'), 'b');
    assert.equal(stationOfClient(stations, 'k3'), null);
  });
});

describe('the reconciliation (cash_station_drawer.py)', () => {
  it('net − (kiosk cash + change owed + held); 0 when they agree', () => {
    const agree = { stationNetAgorot: 10_000, kioskCashAgorot: 8_700, changeOwedAgorot: 1_300, heldAgorot: 0 };
    assert.equal(reconciliationDifference(agree), 0);
    assert.equal(reconciliationState(0), 'ok');
    assert.equal(reconciliationDifference({ ...agree, stationNetAgorot: 10_500 }), 500);
    assert.equal(reconciliationState(500), 'over');
    assert.equal(reconciliationDifference({ ...agree, heldAgorot: 2_000 }), -2_000);
    assert.equal(reconciliationState(-2_000), 'short');
  });
});

describe('the journal query', () => {
  it('both ends inclusive: `to` is sent as the next day (the server excludes it)', () => {
    assert.equal(addDays('2026-10-14', 1), '2026-10-15');
    assert.equal(addDays('2026-10-31', 1), '2026-11-01');
    assert.equal(addDays('2026-01-01', -1), '2025-12-31');
    assert.deepEqual(journalParams(EMPTY_JOURNAL_FILTERS, 0), { limit: 50, offset: 0 });
    assert.deepEqual(
      journalParams({ from: '2026-10-01', to: '2026-10-14', state: 'HELD', outcome: '', owed: 'open' }, 2),
      { from: '2026-10-01', to: '2026-10-15', state: 'HELD', owed: 'open', limit: 50, offset: 100 },
    );
    assert.deepEqual(journalParams({ ...EMPTY_JOURNAL_FILTERS, from: 'nonsense' }, 0), { limit: 50, offset: 0 });
  });

  it('the page line', () => {
    assert.deepEqual(pageInfo({ total: 132, limit: 50, offset: 50, count: 50 }), { first: 51, last: 100, hasPrev: true, hasNext: true });
    assert.deepEqual(pageInfo({ total: 132, limit: 50, offset: 100, count: 32 }), { first: 101, last: 132, hasPrev: true, hasNext: false });
    assert.deepEqual(pageInfo({ total: 0, limit: 50, offset: 0, count: 0 }), { first: 0, last: 0, hasPrev: false, hasNext: false });
  });

  it('every state, outcome and movement kind the server knows (app/models/cash_station.py)', () => {
    assert.deepEqual([...TX_STATES], ['LEASED', 'ACCEPTING', 'SETTLING', 'PAYING_CHANGE', 'REFUNDING', 'DONE', 'HELD']);
    assert.deepEqual([...TX_OUTCOMES], ['paid', 'refunded', 'nothing_inserted']);
    assert.deepEqual([...MOVEMENT_KINDS], ['float', 'refill', 'collect', 'count', 'dump', 'adjust']);
  });
});

describe('maintenance commands', () => {
  it('a float / refill loads something: the counts typed, the empty ones left out', () => {
    const d = { ...emptyCommandDraft('refill'), counts: { 100: '200', 500: '', 1000: '0' }, note: '  מילוי   בוקר ' };
    assert.equal(commandDraftError(d), null);
    assert.deepEqual(commandBody(d), { op: 'refill', args: { pieces: [{ valueAgorot: 100, count: 200 }], note: 'מילוי בוקר' } });
    assert.equal(commandDraftTotal(d), 20_000);
    assert.equal(commandDraftError(emptyCommandDraft('float')), 'pieces');
    assert.equal(commandDraftError({ ...emptyCommandDraft('float'), counts: { 100: 'x' } }), 'count');
    assert.equal(commandBody(emptyCommandDraft('float')), null);
  });

  it('a count keeps a zero (an empty hopper is a count) and the cashbox counted, in agorot', () => {
    const d = { ...emptyCommandDraft('count'), counts: { 100: '0', 1000: '12' }, counted: '360.5' };
    assert.deepEqual(commandBody(d), {
      op: 'count',
      args: { pieces: [{ valueAgorot: 100, count: 0 }, { valueAgorot: 1000, count: 12 }], countedAgorot: 36050 },
    });
    assert.equal(commandDraftError(emptyCommandDraft('count')), 'nothing');
    assert.equal(commandDraftError({ ...emptyCommandDraft('count'), counted: 'abc' }), 'counted');
  });

  it('a collect: the amount counted, or nothing (the expected cashbox)', () => {
    assert.deepEqual(commandBody(emptyCommandDraft('collect')), { op: 'collect', args: {} });
    assert.deepEqual(commandBody({ ...emptyCommandDraft('collect'), counted: '3600' }), { op: 'collect', args: { countedAgorot: 360000 } });
  });

  it('a dump: everything, or one denomination (all of it or some notes) — valueAgorot / notes, no pieces', () => {
    assert.deepEqual(commandBody(emptyCommandDraft('dump')), { op: 'dump', args: {} });
    assert.deepEqual(commandBody({ ...emptyCommandDraft('dump'), dumpValue: 2000 }), { op: 'dump', args: { valueAgorot: 2000 } });
    assert.deepEqual(commandBody({ ...emptyCommandDraft('dump'), dumpValue: 2000, dumpNotes: '5', note: 'סוף יום' }), {
      op: 'dump',
      args: { valueAgorot: 2000, notes: 5, note: 'סוף יום' },
    });
    assert.equal(commandDraftError({ ...emptyCommandDraft('dump'), dumpValue: 2000, dumpNotes: '0' }), 'dumpNotes');
    assert.equal(commandDraftError({ ...emptyCommandDraft('dump'), dumpValue: 2000, dumpNotes: String(DUMP_NOTES_MAX + 1) }), 'dumpNotes');
    assert.equal(commandDraftError({ ...emptyCommandDraft('dump'), dumpValue: 2000, dumpNotes: String(DUMP_NOTES_MAX) }), null);
  });

  it('the others carry nothing — the cloud keeps no argument of them, not even a note', () => {
    for (const op of NO_ARG_OPS) {
      assert.deepEqual(commandBody({ ...emptyCommandDraft(op), note: 'x' }), { op, args: {} });
    }
    // app/models/cash_station.py COMMAND_OPS, in the dashboard's order.
    assert.deepEqual([...COMMAND_OPS].sort(), [
      'collect', 'count', 'deliver_pending', 'dump', 'ext_return', 'ext_stack', 'float', 'maintenance_off', 'maintenance_on', 'refill', 'reset_alerts',
    ]);
    for (const op of NO_ARG_OPS) assert.ok(COMMAND_OPS.includes(op));
  });
});

describe('the station settings form', () => {
  const effective = {
    cashCoinsAccepted: [10, 50, 100, 200, 500, 1000],
    cashNotesAccepted: [2000, 5000, 10000, 20000],
    cashMaxChangeAgorot: 10000,
    cashExactChangeBelowAgorot: 3000,
    cashChangeShortfall: 'notify',
    cashAlertTills: [],
    cashRounding: 'nearest_10',
    cashFloatLevels: {},
    cashCashboxCapacity: { coins: 1500, notes: 500 },
    cashLampMap: {},
    cashSwitchMap: {},
    cashSimulator: false,
    cashInsertTimeoutSec: 180,
    cashIdleTimeoutSec: 60,
    cashQueueTimeoutSec: 120,
    cashRefundGraceSec: 120,
    cashSettleMs: 1000,
    cashPayoutTimeoutSec: 60,
    cashExtendedEscrow: true,
    cashHopperFeeds: 'auto',
    cashUnackedHoldMin: 30,
  };

  it('nothing overridden: every key inherits, the form starts from the effective values', () => {
    const d = settingsDraftOf({}, effective);
    assert.deepEqual(d.on, {});
    assert.deepEqual(settingsBody(d), { settings: {}, errors: [] });
    assert.equal(d.values.scalar.cashMaxChangeAgorot, '100');
    assert.deepEqual(d.values.cashNotesAccepted, [2000, 5000, 10000, 20000]);
    assert.deepEqual(d.values.cashCashboxCapacity, { notes: '500', coins: '1500' });
  });

  it('the overrides come back typed: lists, money in agorot, maps as objects', () => {
    const own = {
      cashNotesAccepted: [2000, 5000],
      cashMaxChangeAgorot: 5000,
      cashChangeShortfall: 'prevent',
      cashAlertTills: ['AB'],
      cashFloatLevels: { 100: { target: 200, low: 30 } },
      cashLampMap: { busy: 0, fault: 1, clients: { K1: 3 } },
      cashSwitchMap: { door: { n: 0, closedMeans: 'closed' } },
      cashSimulator: true,
      cashIdleTimeoutSec: 90,
    };
    const d = settingsDraftOf(own, effective);
    const { settings, errors } = settingsBody(d);
    assert.deepEqual(errors, []);
    assert.deepEqual(settings, {
      cashNotesAccepted: [2000, 5000],
      cashMaxChangeAgorot: 5000,
      cashChangeShortfall: 'prevent',
      cashAlertTills: ['ab'],
      cashFloatLevels: { 100: { target: 200, low: 30 } },
      cashLampMap: { busy: 0, fault: 1, clients: { k1: 3 } },
      cashSwitchMap: { door: { n: 0, closedMeans: 'closed' } },
      cashSimulator: true,
      cashIdleTimeoutSec: 90,
    });
  });

  it('turning an override off inherits again; a value out of range names its key', () => {
    const d = settingsDraftOf({ cashIdleTimeoutSec: 90 }, effective);
    assert.deepEqual(settingsBody({ ...d, on: {} }).settings, {});
    const bad = { ...d, values: { ...d.values, scalar: { ...d.values.scalar, cashIdleTimeoutSec: '5' } } };
    assert.deepEqual(settingsBody(bad).errors, [{ key: 'cashIdleTimeoutSec', problem: 'range' }]);
    const lamp = { on: { cashLampMap: true }, values: { ...d.values, cashLampMap: { busy: '64', fault: '', ready: '', clients: {} } } };
    assert.deepEqual(settingsBody(lamp).errors, [{ key: 'cashLampMap', problem: 'io' }]);
    const money = { on: { cashMaxChangeAgorot: true }, values: { ...d.values, scalar: { ...d.values.scalar, cashMaxChangeAgorot: '' } } };
    assert.deepEqual(settingsBody(money).errors, [{ key: 'cashMaxChangeAgorot', problem: 'empty' }]);
  });

  it('the server parameters\' text forms are read too (comma lists, JSON text)', () => {
    assert.deepEqual(denominationList('10,50, 100,7', 'coins'), [10, 50, 100]);
    assert.deepEqual(idList('A, b;a'), ['a', 'b']);
    const d = settingsDraftOf({ cashCashboxCapacity: '{"notes":400}' }, effective);
    assert.deepEqual(settingsBody(d).settings, { cashCashboxCapacity: { notes: 400 } });
  });

  it('the effective value in words', () => {
    assert.equal(effectiveText('cashNotesAccepted', [2000, 20000]), '20 ₪, 200 ₪');
    assert.equal(effectiveText('cashMaxChangeAgorot', 10000), '100 ₪');
    assert.equal(effectiveText('cashSimulator', false), 'לא');
    assert.equal(effectiveText('cashLampMap', {}), '—');
    assert.equal(effectiveText('cashRounding', 'nearest_10'), 'nearest_10');
  });

  it('the keys a station overrides are cash_params.py STATION_KEYS', () => {
    assert.equal(STATION_SETTING_KEYS.length, 21);
    assert.ok(!(STATION_SETTING_KEYS as readonly string[]).includes('cashReceiptLines'), 'a kiosk key');
    assert.ok(!(STATION_SETTING_KEYS as readonly string[]).includes('cashEnabled'), 'a kiosk key');
  });
});

describe('he.json', () => {
  it('every word the pages say is there', () => {
    const he = JSON.parse(readFileSync(join(process.cwd(), 'src', 'messages', 'he.json'), 'utf8'));
    const cs = he.cashStations;
    assert.ok(cs, 'cashStations');
    for (const k of ['title', 'subtitle', 'add', 'empty', 'includeInactive']) assert.ok(cs.list[k], `list.${k}`);
    for (const p of ['ready', 'busy', 'maintenance', 'fault', 'starting', 'offline', 'no_host', 'no_report', 'inactive', 'unknown']) {
      assert.ok(cs.pill[p], `pill.${p}`);
    }
    for (const s of TX_STATES) assert.ok(cs.txState[s], `txState.${s}`);
    for (const o of TX_OUTCOMES) assert.ok(cs.outcome[o], `outcome.${o}`);
    for (const k of MOVEMENT_KINDS) assert.ok(cs.movementKind[k], `movementKind.${k}`);
    for (const r of RESOLUTIONS) assert.ok(cs.resolution[r], `resolution.${r}`);
    for (const op of COMMAND_OPS) {
      assert.ok(cs.ops[op], `ops.${op}`);
      assert.ok(cs.opsHint[op], `opsHint.${op}`);
    }
    for (const s of ['pending', 'done', 'refused', 'failed']) assert.ok(cs.commandStatus[s], `commandStatus.${s}`);
    for (const k of STATION_SETTING_KEYS) assert.ok(cs.settings.keys[k], `settings.keys.${k}`);
    for (const tab of ['status', 'journal', 'movements', 'owed', 'drawer', 'maintenance', 'settings', 'kiosks']) {
      assert.ok(cs.tabs[tab], `tabs.${tab}`);
    }
    for (const k of ['cash_host', 'cash_hostHint', 'cashHostNote', 'cashHostReady', 'cashHostNeedsShop', 'cashHostNotTill', 'cashHostNotTillHint']) {
      assert.ok(he.machines.deviceRole[k], `machines.deviceRole.${k}`);
    }
    assert.ok(he.machines.deviceRole.badge.cash_host);
    assert.ok(he.exceptions.types.cash_unit);
    assert.ok(he.exceptionSettings.desc.cash_unit);
    assert.ok(he.phoneAlerts.type.cash);
    assert.ok(he.nav.cashStations);
    assert.ok(he.kiosks.payment.cashDeviceStationsNote);
    for (const k of ['intro', 'readOnly', 'assigned', 'unassigned', 'servedHere', 'servedElsewhere', 'noCash', 'switchLabel']) {
      assert.ok(cs.kiosks[k], `kiosks.${k}`);
    }
  });
});
