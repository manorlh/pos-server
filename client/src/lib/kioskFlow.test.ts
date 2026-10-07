/**
 * Run with `npm test`. The kiosk flow as the browser kiosk runs it (lib/kioskFlow.ts — the Windows
 * kiosk's core/kioskFlow.ts, the Android kiosk's KioskFlow.kt; parity with the Windows copy:
 * kiosk-desktop/test/kioskFlowWebParity.test.ts): "איך תרצו לשלם?" always routes the checkout
 * through the details screen (it hosts the step), back from the payment returns there, and a
 * payment in flight is never reset. The scan rules the browser kiosk shares (lib/kioskScan.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { INITIAL_FLOW, backAction, idleCheck, reduce, rulesOf, wire, type FlowConfigIn, type KioskFlowRules, type KioskFlowState } from './kioskFlow';
import { parseScan, scannedVoucherCode } from './kioskScan';

const cfg: FlowConfigIn = {
  general: { serviceTypes: ['take_away'], skipCart: 'off', askTableNumber: false },
  payment: { customerName: 'off', customerPhone: 'off', tipEnabled: false },
};

function run(rules: KioskFlowRules, events: Parameters<typeof reduce>[1][], from: KioskFlowState = INITIAL_FLOW): KioskFlowState {
  return events.reduce((s, e) => reduce(s, e, rules), from);
}

describe('the browser kiosk flow', () => {
  const web = { ...rulesOf(cfg, false), asksPayMethod: true };
  const plain = rulesOf(cfg, false);

  it('without a step to ask, the checkout goes straight to the payment (as before)', () => {
    const s = run(plain, [{ type: 'start' }, { type: 'itemAdded' }, { type: 'openCart' }, { type: 'checkout' }]);
    assert.equal(s.screen, 'pay');
  });

  it('with "איך תרצו לשלם?" the checkout goes to the details screen first, then to the payment', () => {
    const s = run(web, [{ type: 'start' }, { type: 'openCart' }, { type: 'checkout' }]);
    assert.deepEqual([s.screen, s.detailsNext], ['details', 'pay']);
    const paid = run(web, [{ type: 'detailsDone' }], s);
    assert.deepEqual([paid.screen, paid.pay], ['pay', 'idle']);
    // Back from a payment that did not start returns to the method step.
    const back = run(web, [{ type: 'back' }], paid);
    assert.deepEqual([back.screen, back.detailsNext], ['details', 'pay']);
  });

  it('the order on its way to the tills holds the kiosk: no reset, no back', () => {
    const s = run(web, [{ type: 'start' }, { type: 'openCart' }, { type: 'checkout' }, { type: 'detailsDone' }, { type: 'paymentStarted' }, { type: 'paymentCharging' }]);
    assert.equal(wire(s), 'paying');
    assert.equal(run(web, [{ type: 'reset' }], s).screen, 'pay');
    assert.equal(backAction(s, web), 'cancel_payment');
    assert.equal(idleCheck(s, 0, 10_000_000, { inactivitySec: 30, warningSec: 10, successSec: 8 }).kind, 'none');
    const done = run(web, [{ type: 'paymentApproved' }], s);
    assert.equal(done.screen, 'success');
    assert.equal(run(web, [{ type: 'successDone' }], done).screen, 'attract');
  });

  it('rests on "התשלום אינו זמין" when it cannot take money, once the customer is done', () => {
    const idle = run(web, [{ type: 'terminal', canCharge: false }]);
    assert.equal(idle.screen, 'no_payment');
    const ordering = run(web, [{ type: 'start' }, { type: 'terminal', canCharge: false }]);
    assert.equal(ordering.screen, 'catalog');
  });
});

describe('scans on the browser kiosk', () => {
  it('a voucher is "PV:" + its code; a product barcode is never one', () => {
    assert.equal(scannedVoucherCode('PV:ABCD-EFGH-JKMN-PQRS\r'), 'ABCDEFGHJKMNPQRS');
    assert.equal(scannedVoucherCode(']Q1pv:abcdefghjkmnpqrs'), 'ABCDEFGHJKMNPQRS');
    assert.equal(scannedVoucherCode('7290000000017'), null);
    assert.equal(parseScan(']E07290000000017').symbology, 'EAN-13');
  });
});
