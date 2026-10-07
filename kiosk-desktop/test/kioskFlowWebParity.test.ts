/**
 * One flow for every kiosk: the browser kiosk (`/k` on the dashboard's site) runs a copy of this
 * kiosk's core/kioskFlow.ts and core/kioskScan.ts in client/src/lib (the dashboard is built and
 * deployed without this folder). This test drives both copies through the same events and scans
 * and asserts the same answers — change one, change the other (pos-server docs/SPEC_KIOSK.md §27).
 * "איך תרצו לשלם?" (`asksPayMethod`, hosted by the details screen) is walked both ways too: both
 * kiosks take cash at the till, vouchers and the card (payment.methods).
 */

import { describe, expect, it } from 'vitest';
import * as desk from '../src/core/kioskFlow';
import * as web from '@dash-lib/kioskFlow';
import * as deskScan from '../src/core/kioskScan';
import * as webScan from '@dash-lib/kioskScan';

type Cfg = desk.FlowConfigIn;

const CONFIGS: Cfg[] = [];
for (const serviceTypes of [['take_away'], ['take_away', 'eat_in']]) {
  for (const skipCart of ['off', 'direct', 'confirm']) {
    for (const detailsStep of ['after_service', 'before_cart', 'before_pay', 'after_pay']) {
      for (const tipEnabled of [false, true]) {
        for (const customerName of ['off', 'optional']) {
          CONFIGS.push({
            general: { serviceTypes, skipCart, askTableNumber: false, servicePlacement: serviceTypes.length > 1 && skipCart === 'confirm' ? 'attract' : 'screen' },
            payment: { customerName, customerPhone: 'off', tipEnabled, tipPresets: [10, 15], detailsStep },
          });
        }
      }
    }
  }
}

const EVENTS: desk.KioskEvent[] = [
  { type: 'start' },
  { type: 'startWith', service: 'eat_in' },
  { type: 'chooseService', service: 'take_away' },
  { type: 'itemAdded' },
  { type: 'openCart' },
  { type: 'backToCatalog' },
  { type: 'checkout' },
  { type: 'detailsDone' },
  { type: 'back' },
  { type: 'paymentStarted' },
  { type: 'paymentCharging' },
  { type: 'paymentApproved' },
  { type: 'paymentDeclined' },
  { type: 'paymentUnknown' },
  { type: 'paymentReleased' },
  { type: 'retryPayment' },
  { type: 'successDone' },
  { type: 'reset' },
  { type: 'paused', paused: true },
  { type: 'paused', paused: false },
  { type: 'hours', open: false },
  { type: 'hours', open: true },
  { type: 'terminal', canCharge: false },
  { type: 'terminal', canCharge: true },
];

/** A deterministic walk: every config, many event sequences from a seeded generator. */
function* walks(seed = 7, count = 60, length = 14): Generator<desk.KioskEvent[]> {
  let x = seed;
  const rand = () => {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    return x / 0x7fffffff;
  };
  for (let i = 0; i < count; i++) yield Array.from({ length }, () => EVENTS[Math.floor(rand() * EVENTS.length)]);
}

describe('the browser kiosk runs the same flow', () => {
  it('every config, every walk: the same states, back actions and wire states', () => {
    let steps = 0;
    for (const cfg of CONFIGS) {
      for (const walk of walks()) {
        let a = desk.INITIAL_FLOW;
        let b = web.INITIAL_FLOW;
        for (const [i, e] of walk.entries()) {
          const cartEmpty = i % 5 === 0;
          // "איך תרצו לשלם?" asked on every other config (the host decides it from payment.methods).
          const asksPayMethod = CONFIGS.indexOf(cfg) % 2 === 1;
          const ra = { ...desk.rulesOf(cfg, cartEmpty), asksPayMethod };
          const rb = { ...web.rulesOf(cfg as web.FlowConfigIn, cartEmpty), asksPayMethod };
          a = desk.reduce(a, e, ra);
          b = web.reduce(b, e as web.KioskEvent, rb);
          expect(b).toEqual(a);
          expect(web.backAction(b, rb)).toBe(desk.backAction(a, ra));
          expect(web.wire(b)).toBe(desk.wire(a));
          const timers = { inactivitySec: 30, warningSec: 10, successSec: 8 };
          expect(web.idleCheck(b, 0, 35_000, timers)).toEqual(desk.idleCheck(a, 0, 35_000, timers));
          steps++;
        }
      }
    }
    expect(steps).toBeGreaterThan(10_000);
  });

  it('the same rules from the same config', () => {
    for (const cfg of CONFIGS) {
      const a = desk.rulesOf(cfg, false);
      const b = web.rulesOf(cfg as web.FlowConfigIn, false);
      expect({ ...b, asksDetails: null }).toEqual({ ...a, asksDetails: null });
      for (const s of ['take_away', 'eat_in', null] as const) expect(b.asksDetails(s)).toBe(a.asksDetails(s));
    }
  });
});

describe('the browser kiosk reads scans the same way', () => {
  const SCANS = [']E07290000000017', '7290000000017\r', ']C1(01)07290000000017', ']Q1PV:ABCD-EFGH-JKMN-PQRS', 'PV:abcdefghjkmnpqrs', 'SKU-17', '04210000526', ']d2010729000000001721ABC', ' 123 ', ''];
  it('parses, finds and decides alike', () => {
    const shown = [
      { id: 'p1', barcode: '7290000000017', sku: 'SKU-17', soldOut: false },
      { id: 'p2', barcode: null, sku: 'X', soldOut: true },
    ];
    for (const raw of SCANS) {
      expect(webScan.parseScan(raw)).toEqual(deskScan.parseScan(raw));
      expect(webScan.scannedVoucherCode(raw)).toBe(deskScan.scannedVoucherCode(raw));
      for (const screen of ['attract', 'service', 'catalog', 'cart', 'details', 'pay', 'success'] as const) {
        const scene = { screen, staff: false, sheetOpen: false, busy: false };
        const a = deskScan.decideScan(deskScan.parseScan(raw), scene, shown, () => 'direct', { all: shown, duplicate: false });
        const b = webScan.decideScan(webScan.parseScan(raw), scene, shown, () => 'direct', { all: shown, duplicate: false });
        expect(b).toEqual(a);
      }
    }
  });
});
