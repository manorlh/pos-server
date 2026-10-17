import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  defaultTerminalType,
  emptyTerminalDraft,
  takesTerminal,
  terminalDraftErrors,
  terminalDraftFromSettings,
  terminalFieldsOf,
  terminalPairingBody,
  terminalSecretElsewhere,
  terminalSettingsPatch,
  terminalTypeLabel,
  terminalTypesFor,
  TERMINAL_FIELD_LABELS,
} from './deviceTerminal';
import { PAYMENT_SECRET_KEYS } from './paymentIntegration';

describe('the types per device (server app/services/device_terminal.py types_for)', () => {
  it('Windows — kiosk and till alike — and the browser kiosk: Nayax LAN / USB, SynqPay, none', () => {
    const windows = ['auto', 'nayax_lan', 'nayax_usb', 'synqpay', 'none'];
    assert.deepEqual(terminalTypesFor({ role: 'kiosk', platform: 'windows' }), windows);
    assert.deepEqual(terminalTypesFor({ role: 'till', platform: 'windows' }), windows);
    assert.deepEqual(terminalTypesFor({ role: 'kiosk', platform: 'web' }), windows);
  });

  it('an Android kiosk: external terminals only, never built-in nor Tap to Pay', () => {
    assert.deepEqual(terminalTypesFor({ role: 'kiosk', platform: 'android', builtinTerminal: true }), [
      'auto',
      'nayax_lan',
      'nayax_usb',
      'zcredit',
      'synqpay',
      'none',
    ]);
  });

  it('an Android till: built-in only with a terminal of its own, Tap to Pay unless no NFC', () => {
    assert.deepEqual(terminalTypesFor({ role: 'till', platform: 'android', builtinTerminal: true }), [
      'auto',
      'agamento',
      'nayax_lan',
      'nayax_usb',
      'zcredit',
      'synqpay',
      'tap_to_pay',
      'none',
    ]);
    assert.ok(!terminalTypesFor({ role: 'till', platform: 'android', builtinTerminal: false }).includes('agamento'));
    // No model chosen yet: built-in is not ruled out.
    assert.ok(terminalTypesFor({ role: 'till' }).includes('agamento'));
    assert.ok(!terminalTypesFor({ role: 'till', hasNfc: false }).includes('tap_to_pay'));
  });

  it('screens and servers get no terminal', () => {
    for (const role of ['kds', 'order_status_board', 'customer_display', 'local_server', 'cash_host', '']) {
      assert.equal(takesTerminal(role), false);
      assert.deepEqual(terminalTypesFor({ role, platform: 'android' }), []);
    }
  });

  it('defaults keep today: a kiosk on a Nayax pinpad, a till by the shop', () => {
    assert.equal(defaultTerminalType('kiosk'), 'nayax_lan');
    assert.equal(defaultTerminalType('till'), 'auto');
    assert.equal(terminalTypeLabel('none', 'kiosk'), 'ללא מסופון — תשלום בקופה');
    assert.equal(terminalTypeLabel('agamento', 'till'), 'מובנה במכשיר');
  });
});

describe('the fields per type', () => {
  it('only the type\'s own fields; none for auto / built-in / none', () => {
    assert.deepEqual(terminalFieldsOf(emptyTerminalDraft('nayax_lan')), ['nayaxDeviceHost', 'nayaxDevicePort']);
    assert.deepEqual(terminalFieldsOf(emptyTerminalDraft('nayax_usb')), ['nayaxUsbDevice']);
    assert.deepEqual(terminalFieldsOf(emptyTerminalDraft('zcredit')), ['zcreditTerminalNumber', 'zcreditPinpadId', 'zcreditMode']);
    assert.deepEqual(terminalFieldsOf(emptyTerminalDraft('tap_to_pay')), ['tapToPayTpn', 'tapToPayEnvironment']);
    assert.deepEqual(terminalFieldsOf(emptyTerminalDraft('synqpay')), ['synqpayDeviceModel', 'synqpayConnection']);
    assert.deepEqual(terminalFieldsOf({ type: 'synqpay', synqpayConnection: 'usb' }), [
      'synqpayDeviceModel',
      'synqpayConnection',
      'synqpayUsbDevice',
    ]);
    assert.deepEqual(terminalFieldsOf({ type: 'synqpay', synqpayConnection: 'lan' }), [
      'synqpayDeviceModel',
      'synqpayConnection',
      'synqpayHost',
      'synqpayProtocol',
      'synqpayPort',
      'synqpayTls',
    ]);
    for (const t of ['auto', 'agamento', 'none'] as const) assert.deepEqual(terminalFieldsOf(emptyTerminalDraft(t)), []);
  });

  it('never a secret field; the secret is pointed to the payment settings', () => {
    for (const key of PAYMENT_SECRET_KEYS) assert.ok(!(key in TERMINAL_FIELD_LABELS), key);
    assert.equal(terminalSecretElsewhere('zcredit'), 'zcreditPassword');
    assert.equal(terminalSecretElsewhere('tap_to_pay'), 'tapToPayMerchantCode');
    assert.equal(terminalSecretElsewhere('synqpay'), 'synqpayPairing');
    assert.equal(terminalSecretElsewhere('nayax_lan'), null);
  });

  it('checks the shown fields as the server does', () => {
    assert.deepEqual(terminalDraftErrors({ ...emptyTerminalDraft('nayax_lan'), nayaxDeviceHost: 'http://x', nayaxDevicePort: '70000' }), {
      nayaxDeviceHost: 'invalid',
      nayaxDevicePort: 'invalid',
    });
    assert.deepEqual(terminalDraftErrors({ ...emptyTerminalDraft('nayax_usb'), nayaxUsbDevice: 'COM3' }), { nayaxUsbDevice: 'invalid' });
    assert.deepEqual(terminalDraftErrors({ ...emptyTerminalDraft('nayax_usb'), nayaxUsbDevice: '0b00:3070' }), {});
    assert.deepEqual(
      terminalDraftErrors({ ...emptyTerminalDraft('synqpay'), synqpayConnection: 'usb', synqpayUsbDevice: 'com3' }),
      {},
    );
    assert.deepEqual(terminalDraftErrors({ ...emptyTerminalDraft('zcredit'), zcreditTerminalNumber: '12a' }), {
      zcreditTerminalNumber: 'invalid',
    });
    // A hidden field is not checked (another type's leftovers).
    assert.deepEqual(terminalDraftErrors({ ...emptyTerminalDraft('none'), nayaxDeviceHost: 'http://x' }), {});
  });
});

describe('the pairing request', () => {
  it('nothing for "by the shop", nor for a kiosk left on a Nayax pinpad with no address (as before)', () => {
    assert.equal(terminalPairingBody(emptyTerminalDraft('auto'), 'till'), null);
    assert.equal(terminalPairingBody(emptyTerminalDraft('nayax_lan'), 'kiosk'), null);
    assert.equal(terminalPairingBody(emptyTerminalDraft('none'), 'kds'), null);
  });

  it('the type and its non-blank fields', () => {
    assert.deepEqual(
      terminalPairingBody({ ...emptyTerminalDraft('nayax_lan'), nayaxDeviceHost: ' 10.0.0.5 ', nayaxDevicePort: '9000' }, 'kiosk'),
      { paymentIntegration: 'nayax_lan', nayaxDeviceHost: '10.0.0.5', nayaxDevicePort: '9000' },
    );
    assert.deepEqual(terminalPairingBody(emptyTerminalDraft('nayax_lan'), 'till'), { paymentIntegration: 'nayax_lan' });
    assert.deepEqual(terminalPairingBody({ ...emptyTerminalDraft('nayax_usb'), nayaxUsbDevice: '0b00:3070' }, 'kiosk'), {
      paymentIntegration: 'nayax_usb',
      nayaxUsbDevice: '0B00:3070',
    });
    assert.deepEqual(
      terminalPairingBody(
        { ...emptyTerminalDraft('synqpay'), synqpayDeviceModel: 'rx5000', synqpayConnection: 'usb', synqpayHost: 'left.over' },
        'till',
      ),
      { paymentIntegration: 'synqpay', synqpayDeviceModel: 'rx5000', synqpayConnection: 'usb' },
    );
    assert.deepEqual(terminalPairingBody(emptyTerminalDraft('none'), 'kiosk'), { paymentIntegration: 'none' });
  });
});

describe('the device page', () => {
  it('reads the device\'s own layer; none set is "by the shop"', () => {
    assert.equal(terminalDraftFromSettings(undefined).type, 'auto');
    const d = terminalDraftFromSettings({ paymentIntegration: 'nayax_lan', nayaxDeviceHost: '10.0.0.5', nayaxDevicePort: '8080', zcreditPassword: 'x' });
    assert.equal(d.type, 'nayax_lan');
    assert.equal(d.nayaxDeviceHost, '10.0.0.5');
    assert.ok(!('zcreditPassword' in d));
  });

  it('writes only what changed; a cleared field inherits again; a pinpad with an address is on', () => {
    const initial = terminalDraftFromSettings({ paymentIntegration: 'nayax_lan', nayaxDeviceHost: '10.0.0.5', nayaxDevicePort: '8080' });
    assert.equal(terminalSettingsPatch(initial, initial), null);
    assert.deepEqual(terminalSettingsPatch(initial, { ...initial, nayaxDeviceHost: '10.0.0.6' }), {
      nayaxDeviceHost: '10.0.0.6',
      nayaxEnabled: true,
    });
    assert.deepEqual(terminalSettingsPatch(initial, { ...initial, nayaxDevicePort: '' }), { nayaxDevicePort: null });
    assert.deepEqual(terminalSettingsPatch(initial, emptyTerminalDraft('none')), { paymentIntegration: 'none' });
    assert.deepEqual(terminalSettingsPatch(initial, emptyTerminalDraft('auto')), { paymentIntegration: 'auto' });
    const fromAuto = terminalDraftFromSettings({});
    assert.deepEqual(terminalSettingsPatch(fromAuto, { ...emptyTerminalDraft('nayax_usb'), nayaxUsbDevice: '0b00:3070' }), {
      paymentIntegration: 'nayax_usb',
      nayaxUsbDevice: '0B00:3070',
    });
  });
});
