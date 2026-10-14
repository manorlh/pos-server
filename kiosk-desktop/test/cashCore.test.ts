import { describe, expect, it } from 'vitest';
import { cashDue, canPay, exactPlan, greedyPlan, inventoryOf, payoutStrategy } from '../src/core/cash/change';
import { acceptanceFor, escrowDecision } from '../src/core/cash/acceptance';
import { cashSettingsOf, DEFAULT_CASH_SETTINGS, CASH_PARAM_KEYS } from '../src/core/cash/settings';
import { applyEvent } from '../src/core/cash/alerts';
import {
  accurateCount,
  canFullDump,
  canPartialDump,
  canUpdateDeviceCount,
  classifyEvent,
  dispenserClass,
  busOf,
  DP_MDB_LEVEL_2_TUBE,
  DP_MDB_TYPE_3_PAYOUT,
  DP_SHOPPER,
  DP_SHOPPER_TOTAL,
  hasPrecisePay,
  NOTE_EVENT,
  EV,
  FAULT_BIT,
  COIN_DISPENSER_EVENT,
} from '../src/core/cash/paylinkApi';
import { matchRoute } from '../src/core/cash/lanProtocol';
import { slipCodeOf } from '../src/core/cash/tx';

describe('change making', () => {
  const inv = inventoryOf([
    { valueAgorot: 1000, count: 2 },
    { valueAgorot: 500, count: 1 },
    { valueAgorot: 200, count: 3 },
    { valueAgorot: 50, count: 0 },
  ]);

  it('greedy is PayLink’s walk; exact finds what greedy misses', () => {
    expect(greedyPlan(1700, inv)).toEqual({ plan: [{ valueAgorot: 1000, count: 1 }, { valueAgorot: 500, count: 1 }, { valueAgorot: 200, count: 1 }], paid: 1700 });
    const small = inventoryOf([{ valueAgorot: 50, count: 5 }, { valueAgorot: 20, count: 5 }]);
    expect(greedyPlan(60, small).paid).toBe(50);
    expect(exactPlan(60, small)).toEqual([{ valueAgorot: 20, count: 3 }]);
    expect(exactPlan(70, inventoryOf([{ valueAgorot: 50, count: 1 }]))).toBe(null);
  });

  it('the strategy: PayOut when greedy lands, PaySpecific when only precise pay does, short otherwise', () => {
    const small = inventoryOf([{ valueAgorot: 50, count: 5 }, { valueAgorot: 20, count: 5 }]);
    expect(payoutStrategy(100, small, true)).toEqual({ kind: 'pay_out', amount: 100 });
    expect(payoutStrategy(60, small, true).kind).toBe('pay_specific');
    expect(payoutStrategy(60, small, false)).toEqual({ kind: 'short', amount: 60, payable: 50 });
    expect(canPay(0, small, false)).toBe(true);
  });

  it('cash rounding to 10 agorot (1–4 down, 5–9 up)', () => {
    expect(cashDue(3735, 'nearest_10')).toEqual({ dueAgorot: 3740, roundingAgorot: 5 });
    expect(cashDue(3734, 'nearest_10')).toEqual({ dueAgorot: 3730, roundingAgorot: -4 });
    expect(cashDue(3734, 'none')).toEqual({ dueAgorot: 3734, roundingAgorot: 0 });
  });
});

describe('prevent: acceptance', () => {
  const base = {
    inventory: inventoryOf([{ valueAgorot: 1000, count: 5 }, { valueAgorot: 500, count: 5 }, { valueAgorot: 100, count: 20 }]),
    changeAvailableAgorot: 9500,
    hasDispensers: true,
    precisePay: true,
    settings: { ...DEFAULT_CASH_SETTINGS, exactChangeBelowAgorot: 3000, maxChangeAgorot: 10000 },
    deviceCoins: [10, 50, 100, 200, 500, 1000],
    deviceNotes: [2000, 5000, 10000, 20000],
  };

  it('200 on 15 is refused; up to the change limit and what the hoppers hold', () => {
    const a = acceptanceFor({ ...base, remainingAgorot: 1500 });
    // 100 on 15 needs 85: 5×10 + 5×5 + 10×1 — payable; 200 on 15 needs 185 > the 100 limit.
    expect(a.notes).toEqual([2000, 5000, 10000]);
    expect(a.exactOnly).toBe(false);
    expect(escrowDecision(20000, { ...base, remainingAgorot: 1500 })).toBe('return');
    expect(escrowDecision(5000, { ...base, remainingAgorot: 1500 })).toBe('accept');
  });

  it('exact only when the change on hand is under the level, or there are no dispensers', () => {
    expect(acceptanceFor({ ...base, changeAvailableAgorot: 2000, remainingAgorot: 3000 })).toEqual({ coins: [10, 50, 100, 200, 500, 1000], notes: [2000], exactOnly: true });
    expect(acceptanceFor({ ...base, hasDispensers: false, remainingAgorot: 500 }).coins).toEqual([10, 50, 100, 200, 500]);
  });

  it('a denomination off in the settings is never enabled', () => {
    const a = acceptanceFor({ ...base, settings: { ...base.settings, notesAccepted: [2000] }, remainingAgorot: 5000 });
    expect(a.notes).toEqual([2000]);
  });
});

describe('settings', () => {
  it('defaults: notify, nearest_10, cash off', () => {
    const s = cashSettingsOf({});
    expect(s.shortfall).toBe('notify');
    expect(s.rounding).toBe('nearest_10');
    expect(s.enabled).toBe(false);
  });

  it('read leniently from the till parameters (strings, JSON, comma lists)', () => {
    const s = cashSettingsOf({
      cashEnabled: 'true',
      cashStation: ' st-1 ',
      cashNotesAccepted: '2000,5000',
      cashAlertTills: 'a,b,a',
      cashFloatLevels: '{"100":{"target":200,"low":30},"bad":1}',
      cashLampMap: { busy: 1, clients: { k: 3, x: 99 } },
      cashChangeShortfall: 'weird',
      cashMaxChangeAgorot: '5000',
    });
    expect(s.enabled).toBe(true);
    expect(s.stationId).toBe('st-1');
    expect(s.notesAccepted).toEqual([2000, 5000]);
    expect(s.alertTills).toEqual(['a', 'b']);
    expect(s.floatLevels).toEqual({ '100': { target: 200, low: 30 } });
    expect(s.lampMap).toEqual({ busy: 1, fault: null, ready: null, clients: { k: 3 } });
    expect(s.shortfall).toBe('notify');
    expect(s.maxChangeAgorot).toBe(5000);
  });

  it('every field has its parameter key (contract §11.10)', () => {
    expect(Object.keys(CASH_PARAM_KEYS).sort()).toEqual(Object.keys(DEFAULT_CASH_SETTINGS).sort());
    expect(new Set(Object.values(CASH_PARAM_KEYS)).size).toBe(Object.keys(CASH_PARAM_KEYS).length);
  });
});

describe('PayLink classification', () => {
  it('dispenser families', () => {
    expect(dispenserClass(DP_SHOPPER)).toBe('smart_hopper');
    expect(dispenserClass(DP_SHOPPER_TOTAL)).toBe('smart_total');
    expect(dispenserClass(DP_MDB_LEVEL_2_TUBE)).toBe('mdb_tube');
    expect(dispenserClass(DP_MDB_TYPE_3_PAYOUT)).toBe('mdb_payout');
    expect(dispenserClass(0x01020101)).toBe('hopper'); // DP_MCL_SCH2
    expect(dispenserClass(0x11060002)).toBe('note'); // ID-003 recycler box
    expect(busOf(0x11060002)).toBe('id003');
    expect(canUpdateDeviceCount('note', 'id003')).toBe(true);
    expect(canUpdateDeviceCount('note', 'cctalk')).toBe(false);
    expect(canFullDump('note', 'mdb')).toBe(false);
    expect(canPartialDump('smart_hopper', 'cctalk')).toBe(true);
    expect(canFullDump('smart_hopper', 'cctalk')).toBe(false);
    expect(accurateCount(-1)).toBe(true);
    expect(accurateCount(2)).toBe(false);
  });

  it('events → alerts', () => {
    expect(classifyEvent(NOTE_EVENT | EV.JAM).alert).toBe('jam');
    expect(classifyEvent(NOTE_EVENT | EV.OUTPUT_PROBLEM).alert).toBe('stacker_problem');
    expect(classifyEvent(COIN_DISPENSER_EVENT | FAULT_BIT | 0).alert).toBe('unit_ok');
    let l = applyEvent([], { code: NOTE_EVENT | EV.JAM, raw: 0, dispenser: false, index: 1, at: 5 });
    expect(l).toEqual([{ code: 'jam', unit: 'acceptor:1', since: 5, detail: 'note:JAM' }]);
    l = applyEvent(l, { code: NOTE_EVENT | EV.JAM_FIXED, raw: 0, dispenser: false, index: 1, at: 9 });
    expect(l).toEqual([]);
  });

  it('precise pay from release 1.12.6 (V4-1-12-6)', () => {
    expect(hasPrecisePay((4 << 24) | (1 << 16) | (12 << 8) | 6)).toBe(true);
    expect(hasPrecisePay((4 << 24) | (1 << 16) | (12 << 8) | 5)).toBe(false);
    expect(hasPrecisePay((4 << 24) | (1 << 16) | (11 << 8) | 9)).toBe(false);
  });
});

describe('the LAN routes', () => {
  const tx = '0b1c2d3e-0000-4000-8000-0000000000d1';
  it('matches every route of §11.4 and nothing else', () => {
    expect(matchRoute('GET', '/cash/health')).toEqual({ kind: 'health' });
    expect(matchRoute('GET', '/cash/stations/st-1/status?x=1')).toEqual({ kind: 'status', stationId: 'st-1' });
    expect(matchRoute('POST', '/cash/stations/st-1/lease')).toEqual({ kind: 'lease', stationId: 'st-1' });
    expect(matchRoute('DELETE', '/cash/stations/st-1/lease/L1')).toEqual({ kind: 'release', stationId: 'st-1', leaseId: 'L1' });
    expect(matchRoute('POST', `/cash/stations/st-1/tx/${tx}/start`)).toEqual({ kind: 'tx_start', stationId: 'st-1', txId: tx });
    expect(matchRoute('GET', `/cash/stations/st-1/tx/${tx}`)).toEqual({ kind: 'tx_get', stationId: 'st-1', txId: tx });
    expect(matchRoute('POST', '/cash/stations/st-1/tx/not-a-uuid/start')).toBe(null);
    expect(matchRoute('GET', '/cash/stations/st-1/events')).toEqual({ kind: 'events', stationId: 'st-1' });
    expect(matchRoute('PUT', '/cash/stations/st-1/lease')).toBe(null);
  });

  it('slip codes are stable and short', () => {
    expect(slipCodeOf(tx)).toBe(slipCodeOf(tx));
    expect(slipCodeOf(tx)).toMatch(/^C-[A-Z0-9]{6}$/);
  });
});
