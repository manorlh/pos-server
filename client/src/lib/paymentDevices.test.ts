/**
 * Run with `npm test`. "מכשירי תשלום": the dashboard's checks (mirroring pos-server
 * app/services/payment_devices.py), the body it sends, the till's device choice (fixed / group)
 * and the per-till summary.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AGAMENTO_DEFAULT_PATH,
  AGAMENTO_DEFAULT_PORT,
  choiceDraftOf,
  choiceError,
  choicePatch,
  cleanGroup,
  cleanKind,
  connectionSummary,
  deviceForm,
  deviceInput,
  deviceServerError,
  effectiveSwitch,
  emptyDeviceForm,
  hasDeviceErrors,
  kindHasTerminalNumber,
  modeChoiceOf,
  normalizeMac,
  sameChoice,
  sortDevices,
  splitAddress,
  tillSummary,
  toggleGroup,
  triStateOf,
  triStateValue,
  validateDeviceForm,
  withModeChoice,
  type PaymentDevice,
  type PaymentDeviceForm,
  type PaymentDeviceMachine,
} from './paymentDevices';

const D1 = 'aaaaaaaa-1111-4111-8111-111111111111';
const D2 = 'bbbbbbbb-2222-4222-8222-222222222222';
const D3 = 'cccccccc-3333-4333-8333-333333333333';

function form(over: Partial<PaymentDeviceForm>): PaymentDeviceForm {
  return { ...emptyDeviceForm(over.kind ?? 'agamento_lan'), nickname: 'Bar', ...over };
}

function device(over: Partial<PaymentDevice>): PaymentDevice {
  return {
    id: D1,
    shopId: 's1',
    nickname: 'Bar',
    kind: 'agamento_lan',
    active: true,
    sortOrder: 0,
    config: { host: '192.168.1.20', port: 8080, path: '/SPICy', https: false },
    secrets: { synqpayApiKey: { set: false } },
    ...over,
  };
}

function machine(over: Partial<PaymentDeviceMachine>): PaymentDeviceMachine {
  return {
    id: 'm1',
    name: 'קופה 1',
    hasBuiltinTerminal: false,
    ownChoice: false,
    choice: { enabled: true, mode: 'group', fixedDeviceId: null, groupDeviceIds: null },
    ...over,
  };
}

describe('kinds', () => {
  it('cleans a kind', () => {
    assert.equal(cleanKind(' Agamento-LAN '), 'agamento_lan');
    assert.equal(cleanKind('zcredit_pinpad'), 'zcredit_pinpad');
    assert.equal(cleanKind('nayax'), null);
    assert.equal(cleanKind(3), null);
  });

  it('a terminal number of its own: Agamento and SynqPay only', () => {
    assert.equal(kindHasTerminalNumber('agamento_lan'), true);
    assert.equal(kindHasTerminalNumber('synqpay'), true);
    assert.equal(kindHasTerminalNumber('zcredit_pinpad'), false);
  });
});

describe('addresses', () => {
  it('splits a URL typed into the host field, as the server does', () => {
    assert.deepEqual(splitAddress('http://192.168.1.20:8080/SPICy'), {
      host: '192.168.1.20',
      port: '8080',
      path: '/SPICy',
      https: false,
    });
    assert.deepEqual(splitAddress('https://pinpad.local'), { host: 'pinpad.local', port: undefined, path: undefined, https: true });
    assert.deepEqual(splitAddress('10.0.0.1'), { host: '10.0.0.1', port: undefined, path: undefined, https: undefined });
    assert.equal(splitAddress('ftp://1.2.3.4'), null);
  });

  it('normalises a MAC', () => {
    assert.equal(normalizeMac('AA-BB-CC-DD-EE-0F'), 'aa:bb:cc:dd:ee:0f');
    assert.equal(normalizeMac('aabb.ccdd.eeff'), 'aa:bb:cc:dd:ee:ff');
    assert.equal(normalizeMac('zz:zz'), null);
  });
});

describe('validateDeviceForm', () => {
  it('nickname: required, 40 at most, unique whatever its case', () => {
    assert.equal(validateDeviceForm(form({ nickname: '   ', host: '1.2.3.4' })).nickname, 'nickname_required');
    assert.equal(validateDeviceForm(form({ nickname: 'x'.repeat(41), host: '1.2.3.4' })).nickname, 'nickname_too_long');
    assert.equal(
      validateDeviceForm(form({ nickname: ' bar ', host: '1.2.3.4' }), { otherNicknames: ['BAR'] }).nickname,
      'nickname_taken',
    );
  });

  it('agamento_lan', () => {
    assert.deepEqual(validateDeviceForm(form({ host: '192.168.1.20' })), {});
    assert.deepEqual(validateDeviceForm(form({ host: 'http://192.168.1.20:8080/SPICy' })), {});
    assert.equal(validateDeviceForm(form({ host: '' })).host, 'host_required');
    assert.equal(validateDeviceForm(form({ host: '192.168.1.300' })).host, 'host_invalid');
    assert.equal(validateDeviceForm(form({ host: 'ftp://1.2.3.4' })).host, 'host_invalid');
    assert.equal(validateDeviceForm(form({ host: '1.2.3.4', port: '70000' })).port, 'port_invalid');
    assert.equal(validateDeviceForm(form({ host: '1.2.3.4', path: 'SPICy' })).path, 'path_invalid');
    assert.equal(validateDeviceForm(form({ host: '1.2.3.4', mac: 'nope' })).mac, 'mac_invalid');
    assert.equal(validateDeviceForm(form({ host: '1.2.3.4', terminalNumber: '12a' })).terminalNumber, 'terminal_number_invalid');
  });

  it('zcredit_pinpad: the PinPad only (a leftover terminal number is not its)', () => {
    const z = (over: Partial<PaymentDeviceForm>) => form({ kind: 'zcredit_pinpad', ...over });
    assert.deepEqual(validateDeviceForm(z({ pinpadId: 'PINPAD123456', terminalNumber: 'abc' })), {});
    assert.equal(validateDeviceForm(z({})).pinpadId, 'pinpad_required');
    assert.equal(validateDeviceForm(z({ pinpadId: '12-3' })).pinpadId, 'pinpad_invalid');
  });

  it('synqpay', () => {
    const s = (over: Partial<PaymentDeviceForm>) => form({ kind: 'synqpay', ...over });
    assert.deepEqual(validateDeviceForm(s({ model: 'dx8000', connection: 'lan', host: '10.0.0.4' })), {});
    assert.deepEqual(validateDeviceForm(s({ model: 'rx5000', connection: 'usb', terminalNumber: '1234567' })), {});
    const missing = validateDeviceForm(s({}));
    assert.equal(missing.model, 'model_required');
    assert.equal(missing.connection, 'connection_required');
    assert.equal(validateDeviceForm(s({ model: 'dx8000', connection: 'lan' })).host, 'host_required');
    assert.equal(validateDeviceForm(s({ model: 'foo', connection: 'usb' })).model, 'model_invalid');
    assert.equal(validateDeviceForm(s({ model: 'dx8000', connection: 'usb', usbDevice: '12:34' })).usbDevice, 'usb_device_invalid');
    assert.equal(validateDeviceForm(s({ model: 'dx8000', connection: 'usb', serialNumber: 'ab' })).serialNumber, 'serial_invalid');
    assert.equal(validateDeviceForm(s({ model: 'dx8000', connection: 'usb', synqpayApiKey: 'bad key' })).synqpayApiKey, 'synqpay_key_invalid');
    // The mask is "keep", never a value to check.
    assert.deepEqual(validateDeviceForm(s({ model: 'dx8000', connection: 'usb', synqpayApiKey: '••••' })), {});
  });

  it('sort order', () => {
    assert.equal(validateDeviceForm(form({ host: '1.2.3.4', sortOrder: '10000' })).sortOrder, 'sort_order_invalid');
    assert.equal(validateDeviceForm(form({ host: '1.2.3.4', sortOrder: '' })).sortOrder, undefined);
    assert.equal(hasDeviceErrors({ sortOrder: 'sort_order_invalid' }), true);
    assert.equal(hasDeviceErrors({}), false);
  });
});

describe('deviceInput', () => {
  it('agamento_lan: the URL split, the defaults, the MAC normalised, the terminal number kept', () => {
    const body = deviceInput(
      form({ nickname: '  Bar   one ', host: 'http://192.168.1.20:8081', mac: 'AA-BB-CC-DD-EE-FF', terminalNumber: '1234567' }),
    );
    assert.deepEqual(body, {
      nickname: 'Bar one',
      kind: 'agamento_lan',
      config: {
        host: '192.168.1.20',
        port: 8081,
        path: AGAMENTO_DEFAULT_PATH,
        https: false,
        mac: 'aa:bb:cc:dd:ee:ff',
        terminalNumber: '1234567',
      },
      active: true,
      sortOrder: 0,
    });
    assert.equal(deviceInput(form({ host: '10.0.0.1' })).config.port, AGAMENTO_DEFAULT_PORT);
  });

  it('zcredit_pinpad: the PinPad alone, no secret', () => {
    const body = deviceInput(form({ kind: 'zcredit_pinpad', pinpadId: 'PINPAD123456', terminalNumber: '0882' }));
    assert.deepEqual(body.config, { pinpadId: '123456' });
    assert.equal('synqpayApiKey' in body, false);
  });

  it('synqpay: the host only on the network, the key only when typed, remove → null', () => {
    const lan = form({ kind: 'synqpay', model: 'DX8000', connection: 'lan', host: '10.0.0.4', port: '9443', tls: true });
    assert.deepEqual(deviceInput({ ...lan, synqpayApiKey: 'abc123' }).config, {
      model: 'dx8000',
      connection: 'lan',
      host: '10.0.0.4',
      protocol: 'tcp',
      port: 9443,
      tls: true,
    });
    assert.equal(deviceInput({ ...lan, synqpayApiKey: 'abc123' }).synqpayApiKey, 'abc123');
    assert.equal('synqpayApiKey' in deviceInput(lan), false);
    assert.equal(deviceInput({ ...lan, synqpayApiKey: '••••' }).synqpayApiKey, undefined);
    assert.equal(deviceInput({ ...lan, removeSynqpayApiKey: true }).synqpayApiKey, null);
    const usb = deviceInput(form({ kind: 'synqpay', model: 'rx5000', connection: 'usb', host: '10.0.0.4', usbDevice: '0b00:0080' }));
    assert.deepEqual(usb.config, { model: 'rx5000', connection: 'usb', protocol: 'tcp', tls: false, usbDevice: '0B00:0080' });
  });

  it('round-trips a stored device', () => {
    const stored = device({
      config: { host: '192.168.1.20', port: 8080, path: '/SPICy', https: false, mac: 'aa:bb:cc:dd:ee:ff' },
      sortOrder: 3,
    });
    const f = deviceForm(stored);
    assert.equal(f.port, '');
    assert.equal(f.path, '');
    assert.equal(f.sortOrder, '3');
    assert.deepEqual(deviceInput(f).config, stored.config);
    // A pinpad's leftover terminal number never reaches the form.
    assert.equal(deviceForm(device({ kind: 'zcredit_pinpad', config: { pinpadId: '1', terminalNumber: '0882' } })).terminalNumber, '');
  });
});

describe('lists and labels', () => {
  it('orders as the till: sort order, then nickname', () => {
    const ordered = sortDevices([
      device({ id: 'b', nickname: 'b', sortOrder: 2 }),
      device({ id: 'a', nickname: 'A', sortOrder: 2 }),
      device({ id: 'z', nickname: 'z', sortOrder: 1 }),
    ]);
    assert.deepEqual(ordered.map((d) => d.id), ['z', 'a', 'b']);
  });

  it('summarises the connection', () => {
    assert.equal(connectionSummary(device({})), '192.168.1.20:8080');
    assert.equal(
      connectionSummary(device({ config: { host: '10.0.0.2', port: 8081, path: '/x', https: true, terminalNumber: '77' } })),
      'https://10.0.0.2:8081/x · #77',
    );
    assert.equal(connectionSummary(device({ kind: 'zcredit_pinpad', config: { pinpadId: '123456', terminalNumber: '0882' } })), 'PinPad 123456');
    assert.equal(
      connectionSummary(device({ kind: 'synqpay', config: { model: 'dx8000', connection: 'lan', host: '10.0.0.4', port: 9000 } })),
      'Ingenico DX8000 · 10.0.0.4:9000',
    );
    assert.equal(connectionSummary(device({ kind: 'synqpay', config: { model: 'rx5000', connection: 'usb' } })), 'RX5000 · USB');
  });
});

describe('the switch', () => {
  it('maps the tri-state both ways', () => {
    for (const s of ['on', 'off', 'inherit'] as const) assert.equal(triStateOf(triStateValue(s)), s);
    assert.equal(triStateOf(undefined), 'inherit');
    assert.equal(triStateValue('inherit'), null);
  });

  it('is on by its own value, else by what it inherits, else off', () => {
    assert.equal(effectiveSwitch(false, true), false);
    assert.equal(effectiveSwitch(undefined, true), true);
    assert.equal(effectiveSwitch(null, undefined), false);
  });
});

describe('the device choice (fixed / group)', () => {
  it('reads a layer', () => {
    assert.deepEqual(choiceDraftOf({ paymentDeviceMode: 'fixed', fixedPaymentDeviceId: D1, paymentDeviceGroup: [D2.toUpperCase(), D2] }), {
      mode: 'fixed',
      fixedId: D1,
      group: [D2],
    });
    assert.deepEqual(choiceDraftOf({}), { mode: null, fixedId: null, group: null });
    assert.deepEqual(choiceDraftOf({ paymentDeviceMode: 'default' }), { mode: null, fixedId: null, group: null });
    assert.equal(modeChoiceOf('group'), 'group');
    assert.equal(modeChoiceOf(undefined), 'inherit');
    assert.deepEqual(cleanGroup([]), []);
    assert.equal(cleanGroup(undefined), null);
  });

  it('a mode choice clears what it does not read; "as above" clears all', () => {
    const draft = { mode: 'group' as const, fixedId: D1, group: [D2] };
    assert.deepEqual(withModeChoice(draft, 'fixed'), { mode: 'fixed', fixedId: D1, group: null });
    assert.deepEqual(withModeChoice(draft, 'group'), { mode: 'group', fixedId: null, group: [D2] });
    assert.deepEqual(withModeChoice(draft, 'inherit'), { mode: null, fixedId: null, group: null });
    assert.deepEqual(choicePatch(withModeChoice(draft, 'inherit')), {
      paymentDeviceMode: null,
      fixedPaymentDeviceId: null,
      paymentDeviceGroup: null,
    });
    assert.equal(sameChoice(draft, { ...draft, group: [D2] }), true);
    assert.equal(sameChoice(draft, { ...draft, group: [] }), false);
  });

  it('ticks a group in the devices order; none ticked = every device', () => {
    const order = [D1, D2, D3];
    assert.deepEqual(toggleGroup(null, D3, true, order), [D3]);
    assert.deepEqual(toggleGroup([D3], D1, true, order), [D1, D3]);
    assert.deepEqual(toggleGroup([D1, D3], D1, false, order), [D3]);
    assert.deepEqual(toggleGroup([D3], D3, false, order), []);
  });

  it('checks what the server checks', () => {
    const ids = [D1, D2];
    assert.equal(choiceError({ mode: 'fixed', fixedId: null, group: null }, null, ids), 'fixed_payment_device_required');
    assert.equal(choiceError({ mode: 'fixed', fixedId: null, group: null }, D1, ids), null);
    assert.equal(choiceError({ mode: 'fixed', fixedId: D3, group: null }, null, ids), 'payment_device_not_in_shop');
    assert.equal(choiceError({ mode: 'group', fixedId: null, group: [D1, D3] }, null, ids), 'payment_device_not_in_shop');
    assert.equal(choiceError({ mode: 'group', fixedId: null, group: [] }, null, ids), null);
    assert.equal(choiceError({ mode: null, fixedId: null, group: null }, null, []), null);
  });
});

describe('the per-till summary', () => {
  const devices = [device({ id: D2, nickname: 'b', sortOrder: 1 }), device({ id: D1, nickname: 'a', sortOrder: 0 })];

  it('built-in clearing, the switch off', () => {
    assert.equal(tillSummary(machine({ hasBuiltinTerminal: true }), devices).state, 'builtin');
    assert.equal(
      tillSummary(machine({ choice: { enabled: false, mode: 'group', fixedDeviceId: null, groupDeviceIds: null } }), devices).state,
      'off',
    );
  });

  it('a fixed device, or its device missing', () => {
    const fixed = tillSummary(machine({ choice: { enabled: true, mode: 'fixed', fixedDeviceId: D2, groupDeviceIds: null } }), devices);
    assert.equal(fixed.state, 'fixed');
    assert.deepEqual(fixed.devices.map((d) => d.id), [D2]);
    const missing = tillSummary(machine({ choice: { enabled: true, mode: 'fixed', fixedDeviceId: null, groupDeviceIds: null } }), devices);
    assert.equal(missing.state, 'fixed_missing');
  });

  it('a group of all, or of some, in the till order', () => {
    const all = tillSummary(machine({}), devices);
    assert.equal(all.state, 'group_all');
    assert.deepEqual(all.devices.map((d) => d.id), [D1, D2]);
    const some = tillSummary(machine({ choice: { enabled: true, mode: 'group', fixedDeviceId: null, groupDeviceIds: [D2] } }), devices);
    assert.equal(some.state, 'group');
    assert.deepEqual(some.devices.map((d) => d.id), [D2]);
  });
});

describe('server answers', () => {
  it('reads the code, the field and the Hebrew', () => {
    const err = { response: { status: 422, data: { detail: { code: 'host_invalid', field: 'config.host', msg: 'כתובת' } } } };
    assert.deepEqual(deviceServerError(err), { code: 'host_invalid', field: 'host', msg: 'כתובת' });
    const fixed = { response: { status: 422, data: { detail: { code: 'fixed_payment_device_required', field: 'fixedPaymentDeviceId', msg: 'x' } } } };
    assert.deepEqual(deviceServerError(fixed), { code: 'fixed_payment_device_required', field: null, msg: 'x' });
    assert.equal(deviceServerError({ response: { data: { detail: 'Shop not found' } } }), null);
    assert.equal(deviceServerError(new Error('x')), null);
  });
});
