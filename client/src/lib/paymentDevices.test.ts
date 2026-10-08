/**
 * Run with `npm test`. "מכשירי תשלום": the dashboard's checks (mirroring pos-server
 * app/services/payment_devices.py), the body it sends, and the list's labels.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  AGAMENTO_DEFAULT_PATH,
  AGAMENTO_DEFAULT_PORT,
  appliesTo,
  cleanKind,
  connectionSummary,
  defaultDeviceChoices,
  deviceForm,
  deviceInput,
  deviceServerError,
  deviceTillNames,
  effectiveSwitch,
  emptyDeviceForm,
  hasDeviceErrors,
  normalizeMac,
  sortDevices,
  splitAddress,
  triStateOf,
  triStateValue,
  validateDeviceForm,
  type PaymentDevice,
  type PaymentDeviceForm,
} from './paymentDevices';

const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '22222222-2222-4222-8222-222222222222';

function form(over: Partial<PaymentDeviceForm>): PaymentDeviceForm {
  return { ...emptyDeviceForm(over.kind ?? 'agamento_lan'), nickname: 'Bar', ...over };
}

function device(over: Partial<PaymentDevice>): PaymentDevice {
  return {
    id: 'd1',
    shopId: 's1',
    nickname: 'Bar',
    kind: 'agamento_lan',
    active: true,
    sortOrder: 0,
    config: { host: '192.168.1.20', port: 8080, path: '/SPICy', https: false },
    machineIds: [],
    secrets: { zcreditPassword: { set: false }, synqpayApiKey: { set: false } },
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
    assert.equal(normalizeMac('aabbccddeeff'), 'aa:bb:cc:dd:ee:ff');
    assert.equal(normalizeMac('zz:zz'), null);
  });
});

describe('validateDeviceForm', () => {
  it('nickname: required, 40 at most, unique whatever its case', () => {
    assert.equal(validateDeviceForm(form({ nickname: '   ', host: '1.2.3.4' })).nickname, 'nickname_required');
    assert.equal(validateDeviceForm(form({ nickname: 'x'.repeat(41), host: '1.2.3.4' })).nickname, 'nickname_too_long');
    assert.equal(validateDeviceForm(form({ nickname: ' x'.repeat(20), host: '1.2.3.4' })).nickname, undefined);
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
    assert.equal(validateDeviceForm(form({ host: 'http://1.2.3.4:99999' })).port, 'port_invalid');
    assert.equal(validateDeviceForm(form({ host: '1.2.3.4', path: 'SPICy' })).path, 'path_invalid');
    assert.equal(validateDeviceForm(form({ host: '1.2.3.4', mac: 'nope' })).mac, 'mac_invalid');
    assert.equal(validateDeviceForm(form({ host: '1.2.3.4', terminalNumber: '12a' })).terminalNumber, 'terminal_number_invalid');
  });

  it('zcredit_pinpad', () => {
    const z = (over: Partial<PaymentDeviceForm>) => form({ kind: 'zcredit_pinpad', ...over });
    assert.deepEqual(validateDeviceForm(z({ pinpadId: 'PINPAD123456' })), {});
    assert.equal(validateDeviceForm(z({})).pinpadId, 'pinpad_required');
    assert.equal(validateDeviceForm(z({ pinpadId: '12-3' })).pinpadId, 'pinpad_invalid');
    assert.equal(validateDeviceForm(z({ pinpadId: '1', zcreditPassword: 'a\u0001b' })).zcreditPassword, 'secret_invalid');
    // The mask is "keep", never a value to check.
    assert.deepEqual(validateDeviceForm(z({ pinpadId: '1', zcreditPassword: '••••' })), {});
  });

  it('synqpay', () => {
    const s = (over: Partial<PaymentDeviceForm>) => form({ kind: 'synqpay', ...over });
    assert.deepEqual(validateDeviceForm(s({ model: 'dx8000', connection: 'lan', host: '10.0.0.4' })), {});
    assert.deepEqual(validateDeviceForm(s({ model: 'rx5000', connection: 'usb' })), {});
    const missing = validateDeviceForm(s({}));
    assert.equal(missing.model, 'model_required');
    assert.equal(missing.connection, 'connection_required');
    assert.equal(validateDeviceForm(s({ model: 'dx8000', connection: 'lan' })).host, 'host_required');
    assert.equal(validateDeviceForm(s({ model: 'foo', connection: 'usb' })).model, 'model_invalid');
    assert.equal(validateDeviceForm(s({ model: 'dx8000', connection: 'usb', usbDevice: '12:34' })).usbDevice, 'usb_device_invalid');
    assert.equal(validateDeviceForm(s({ model: 'dx8000', connection: 'usb', serialNumber: 'ab' })).serialNumber, 'serial_invalid');
    assert.equal(validateDeviceForm(s({ model: 'dx8000', connection: 'usb', port: '0' })).port, 'port_invalid');
    assert.equal(validateDeviceForm(s({ model: 'dx8000', connection: 'usb', synqpayApiKey: 'bad key' })).synqpayApiKey, 'synqpay_key_invalid');
  });

  it('sort order and tills', () => {
    assert.equal(validateDeviceForm(form({ host: '1.2.3.4', sortOrder: '10000' })).sortOrder, 'sort_order_invalid');
    assert.equal(validateDeviceForm(form({ host: '1.2.3.4', sortOrder: '-1' })).sortOrder, 'sort_order_invalid');
    assert.equal(validateDeviceForm(form({ host: '1.2.3.4', sortOrder: '' })).sortOrder, undefined);
    const errors = validateDeviceForm(form({ host: '1.2.3.4', machineIds: [T2] }), { machineIds: [T1] });
    assert.equal(errors.machineIds, 'machine_not_in_shop');
    assert.equal(hasDeviceErrors(errors), true);
    assert.equal(hasDeviceErrors({}), false);
  });
});

describe('deviceInput', () => {
  it('agamento_lan: the URL split, the defaults, the MAC normalised, no secrets', () => {
    const body = deviceInput(
      form({ nickname: '  Bar   one ', host: 'http://192.168.1.20:8081', mac: 'AA-BB-CC-DD-EE-FF', zcreditPassword: 'x' }),
    );
    assert.deepEqual(body, {
      nickname: 'Bar one',
      kind: 'agamento_lan',
      config: { host: '192.168.1.20', port: 8081, path: AGAMENTO_DEFAULT_PATH, https: false, mac: 'aa:bb:cc:dd:ee:ff' },
      machineIds: [],
      active: true,
      sortOrder: 0,
    });
    assert.equal(deviceInput(form({ host: '10.0.0.1' })).config.port, AGAMENTO_DEFAULT_PORT);
  });

  it('zcredit_pinpad: the prefix stripped; a typed password sent, remove → null, else absent', () => {
    const z = form({ kind: 'zcredit_pinpad', pinpadId: 'PINPAD123456', mode: 'test', terminalNumber: '0882' });
    assert.deepEqual(deviceInput(z).config, { pinpadId: '123456', terminalNumber: '0882', mode: 'test' });
    assert.equal('zcreditPassword' in deviceInput(z), false);
    assert.equal(deviceInput({ ...z, zcreditPassword: '••••' }).zcreditPassword, undefined);
    assert.equal(deviceInput({ ...z, zcreditPassword: ' pw ' }).zcreditPassword, 'pw');
    assert.equal(deviceInput({ ...z, removeZcreditPassword: true }).zcreditPassword, null);
  });

  it('synqpay: the host only on the network, the key only when typed', () => {
    const lan = deviceInput(
      form({ kind: 'synqpay', model: 'DX8000', connection: 'lan', host: '10.0.0.4', port: '9443', tls: true, synqpayApiKey: 'abc123' }),
    );
    assert.deepEqual(lan.config, { model: 'dx8000', connection: 'lan', host: '10.0.0.4', protocol: 'tcp', port: 9443, tls: true });
    assert.equal(lan.synqpayApiKey, 'abc123');
    const usb = deviceInput(form({ kind: 'synqpay', model: 'rx5000', connection: 'usb', host: '10.0.0.4', usbDevice: '0b00:0080' }));
    assert.deepEqual(usb.config, { model: 'rx5000', connection: 'usb', protocol: 'tcp', tls: false, usbDevice: '0B00:0080' });
  });

  it('keeps only the tills that still exist, once each', () => {
    const body = deviceInput(form({ host: '1.2.3.4', machineIds: [T1, T1, T2] }), { machineIds: [T1] });
    assert.deepEqual(body.machineIds, [T1]);
  });

  it('round-trips a stored device', () => {
    const stored = device({
      config: { host: '192.168.1.20', port: 8080, path: '/SPICy', https: false, mac: 'aa:bb:cc:dd:ee:ff' },
      machineIds: [T1],
      sortOrder: 3,
    });
    const f = deviceForm(stored);
    assert.equal(f.port, '');
    assert.equal(f.path, '');
    assert.equal(f.sortOrder, '3');
    assert.deepEqual(deviceInput(f).config, stored.config);
    assert.deepEqual(deviceInput(f).machineIds, [T1]);
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

  it('applies to every till without a list, else to the listed ones', () => {
    assert.equal(appliesTo(device({ machineIds: [] }), T1), true);
    assert.equal(appliesTo(device({ machineIds: [T2] }), T1), false);
    assert.equal(appliesTo(device({ machineIds: [T1.toUpperCase()] }), T1), true);
    const choices = defaultDeviceChoices([device({ id: 'x', machineIds: [T2] }), device({ id: 'y' })], T1);
    assert.deepEqual(choices.map((d) => d.id), ['y']);
  });

  it('summarises the connection', () => {
    assert.equal(connectionSummary(device({})), '192.168.1.20:8080');
    assert.equal(
      connectionSummary(device({ config: { host: '10.0.0.2', port: 8081, path: '/x', https: true } })),
      'https://10.0.0.2:8081/x',
    );
    assert.equal(
      connectionSummary(device({ kind: 'zcredit_pinpad', config: { pinpadId: '123456', terminalNumber: '0882' } })),
      'PinPad 123456 · 0882',
    );
    assert.equal(
      connectionSummary(device({ kind: 'synqpay', config: { model: 'dx8000', connection: 'lan', host: '10.0.0.4', port: 9000 } })),
      'Ingenico DX8000 · 10.0.0.4:9000',
    );
    assert.equal(connectionSummary(device({ kind: 'synqpay', config: { model: 'rx5000', connection: 'usb' } })), 'RX5000 · USB');
  });

  it('names the tills, or null for all of them', () => {
    const machines = [
      { id: T1, name: 'קופה 1' },
      { id: T2, name: 'קופה 2' },
    ];
    assert.equal(deviceTillNames(device({ machineIds: [] }), machines), null);
    assert.deepEqual(deviceTillNames(device({ machineIds: [T2, 'gone'] }), machines), ['קופה 2']);
  });
});

describe('the switch', () => {
  it('maps the tri-state both ways', () => {
    assert.equal(triStateOf(true), 'on');
    assert.equal(triStateOf(false), 'off');
    assert.equal(triStateOf(undefined), 'inherit');
    assert.equal(triStateOf(null), 'inherit');
    assert.equal(triStateValue('on'), true);
    assert.equal(triStateValue('off'), false);
    assert.equal(triStateValue('inherit'), null);
    for (const s of ['on', 'off', 'inherit'] as const) assert.equal(triStateOf(triStateValue(s)), s);
  });

  it('is on by its own value, else by what it inherits, else off', () => {
    assert.equal(effectiveSwitch(false, true), false);
    assert.equal(effectiveSwitch(undefined, true), true);
    assert.equal(effectiveSwitch(null, undefined), false);
  });
});

describe('server answers', () => {
  it('reads the code, the field and the Hebrew', () => {
    const err = { response: { status: 422, data: { detail: { code: 'host_invalid', field: 'config.host', msg: 'כתובת' } } } };
    assert.deepEqual(deviceServerError(err), { code: 'host_invalid', field: 'host', msg: 'כתובת' });
    const taken = { response: { status: 409, data: { detail: { code: 'nickname_taken', field: 'nickname', msg: 'x' } } } };
    assert.equal(deviceServerError(taken)?.field, 'nickname');
    assert.equal(deviceServerError({ response: { data: { detail: 'Shop not found' } } }), null);
    assert.equal(deviceServerError(new Error('x')), null);
  });
});
