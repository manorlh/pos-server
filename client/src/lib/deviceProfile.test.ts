/**
 * Run with `npm test`. "סוג מכשיר" — the role and model of a device (lib/deviceProfile.ts,
 * pos-server docs/SPEC_DEVICE_ROLE_MODEL.md).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEVICE_MODEL_CAPABILITIES,
  DEVICE_MODEL_IDS,
  SYNQPAY_DEVICE_MODEL_IDS,
  SUNMI_MODEL_IDS,
  addDeviceMissing,
  capabilitiesOf,
  deviceModelIdOf,
  deviceModelWarning,
  deviceProfileBody,
  deviceProfileErrorCode,
  deviceProfileErrorMessage,
  deviceRoleOf,
  kioskDraftError,
  kioskPinpadMissing,
  pairingRequestBody,
  pinpadHostError,
  pinpadPortError,
} from './deviceProfile';

const noKiosk = { name: '', controllerMachineIds: [], lockDevice: false, pinpadHost: '', pinpadPort: '' };

describe('the model catalog', () => {
  it('six models, then the SUNMI family, in the order the picker shows them', () => {
    assert.deepEqual(
      [...DEVICE_MODEL_IDS].slice(0, 6),
      ['N55F', 'MODO', 'P18', 'LANDI', 'FEITIAN_TABLET', 'GENERIC_ANDROID'],
    );
    assert.deepEqual([...DEVICE_MODEL_IDS].slice(6), [...SUNMI_MODEL_IDS, ...SYNQPAY_DEVICE_MODEL_IDS]);
  });

  it('the same capability table as the server', () => {
    const row = (m: keyof typeof DEVICE_MODEL_CAPABILITIES) => {
      const c = DEVICE_MODEL_CAPABILITIES[m];
      return [c.builtinPrinter, c.builtinTerminal, c.cashDrawerPort, c.driverPending];
    };
    assert.deepEqual(row('N55F'), [true, true, false, false]);
    assert.deepEqual(row('MODO'), [false, true, false, false]);
    assert.deepEqual(row('P18'), [false, false, false, false]);
    assert.deepEqual(row('LANDI'), [false, false, false, true]);
    assert.deepEqual(row('FEITIAN_TABLET'), [false, false, false, true]);
    assert.deepEqual(row('GENERIC_ANDROID'), [false, false, false, false]);
    // SynqPay: the terminal is the device; its head waits for SynqPay's SDK.
    for (const m of SYNQPAY_DEVICE_MODEL_IDS) assert.deepEqual(row(m), [false, true, false, true]);
  });

  it('a model with no driver never claims a printer or a drawer', () => {
    for (const m of DEVICE_MODEL_IDS) {
      const c = DEVICE_MODEL_CAPABILITIES[m];
      if (c.driverPending) assert.equal(c.builtinPrinter || c.cashDrawerPort, false, m);
    }
  });

  it('an unknown model reads as a 55F', () => {
    assert.deepEqual(capabilitiesOf(null), DEVICE_MODEL_CAPABILITIES.N55F);
    assert.deepEqual(capabilitiesOf('X9'), DEVICE_MODEL_CAPABILITIES.N55F);
    assert.equal(deviceModelIdOf(' landi '), 'LANDI');
    assert.equal(deviceModelIdOf(''), null);
  });
});

describe('SUNMI (docs/SPEC_SUNMI.md)', () => {
  // The server's table (app/models/sunmi.py), shared byte-for-byte with pos-android.
  const golden = JSON.parse(
    readFileSync(join(process.cwd(), '..', 'server', 'tests', 'fixtures', 'sunmi_models_golden.json'), 'utf8'),
  ) as { models: { id: string; printer: boolean; paperMm: number | null; drawerPort: boolean; scanner: boolean }[] };

  it('the same SUNMI table as the server, model by model', () => {
    assert.deepEqual(
      golden.models.map((m) => m.id),
      [...SUNMI_MODEL_IDS],
    );
    for (const m of golden.models) {
      const c = DEVICE_MODEL_CAPABILITIES[m.id as keyof typeof DEVICE_MODEL_CAPABILITIES];
      assert.deepEqual(
        [c.builtinPrinter, c.paperWidthMm, c.cashDrawerPort, c.builtinScanner],
        [m.printer, m.paperMm, m.drawerPort, m.scanner],
        m.id,
      );
    }
  });

  it('no SUNMI charges on a terminal of its own, none is "בקרוב"', () => {
    for (const m of SUNMI_MODEL_IDS) {
      const c = DEVICE_MODEL_CAPABILITIES[m];
      assert.equal(c.builtinTerminal, false, m);
      assert.equal(c.driverPending, false, m);
    }
  });

  it('the desktops have a drawer port, the handhelds do not', () => {
    assert.equal(capabilitiesOf('SUNMI_T2S').cashDrawerPort, true);
    assert.equal(capabilitiesOf('SUNMI_D3').cashDrawerPort, true);
    assert.equal(capabilitiesOf('SUNMI_V2_PRO').cashDrawerPort, false);
    assert.equal(capabilitiesOf('SUNMI_K2').cashDrawerPort, false);
    assert.equal(capabilitiesOf('SUNMI_T3').paperWidthMm, 80);
    assert.equal(capabilitiesOf('SUNMI_V2').paperWidthMm, 58);
    assert.equal(deviceModelIdOf('sunmi_t2s'), 'SUNMI_T2S');
  });

  it('every model has its label and badge', () => {
    const he = JSON.parse(readFileSync(join(process.cwd(), 'src', 'messages', 'he.json'), 'utf8'));
    const labels = he.machines.deviceModel as Record<string, unknown> & { badge: Record<string, unknown> };
    for (const m of DEVICE_MODEL_IDS) {
      assert.equal(typeof labels[m], 'string', m);
      assert.equal(typeof labels.badge[m], 'string', m);
    }
  });
});

describe('roles', () => {
  it('a till or a kiosk; a kitchen screen is not a role', () => {
    assert.equal(deviceRoleOf('kiosk'), 'kiosk');
    assert.equal(deviceRoleOf(' TILL '), 'till');
    assert.equal(deviceRoleOf('kds'), null);
    assert.equal(deviceRoleOf(undefined), null);
  });
});

describe('the model warning', () => {
  it('pairing kept the model the device named', () => {
    assert.deepEqual(
      deviceModelWarning({ deviceModel: 'P18', deviceModelChosen: 'N55F', deviceModelReported: 'P18' }),
      { kind: 'pairingOverride', chosen: 'N55F', stored: 'P18' },
    );
  });

  it('the device disagrees with a model chosen afterwards', () => {
    assert.deepEqual(
      deviceModelWarning({ deviceModel: 'N55F', deviceModelChosen: 'N55F', deviceModelReported: 'P18' }),
      { kind: 'deviceDisagrees', reported: 'P18', stored: 'N55F' },
    );
  });

  it('nothing when they agree or nothing was reported', () => {
    assert.equal(deviceModelWarning({ deviceModel: 'P18', deviceModelChosen: 'P18', deviceModelReported: 'P18' }), null);
    assert.equal(deviceModelWarning({ deviceModel: 'MODO', deviceModelChosen: 'MODO' }), null);
    assert.equal(deviceModelWarning({ deviceModel: 'MODO' }), null);
    assert.equal(deviceModelWarning({}), null);
  });
});

describe('adding a device', () => {
  const draft = { role: 'till' as const, model: 'N55F' as const, machineCode: 'Bar', companyId: '', shopId: '' };

  it('both choices are required, in order', () => {
    assert.equal(addDeviceMissing({ ...draft, role: '' }), 'role');
    assert.equal(addDeviceMissing({ ...draft, model: '' }), 'model');
    assert.equal(addDeviceMissing({ ...draft, machineCode: '  ' }), 'machineCode');
    assert.equal(addDeviceMissing(draft), null);
  });

  it('a kiosk needs its shop', () => {
    assert.equal(addDeviceMissing({ ...draft, role: 'kiosk' }), 'shop');
    assert.equal(addDeviceMissing({ ...draft, role: 'kiosk', companyId: 'c' }), 'shop');
    assert.equal(addDeviceMissing({ ...draft, role: 'kiosk', companyId: 'c', shopId: 's' }), null);
  });

  it('the generate body carries the role, and the kiosk options for a kiosk only', () => {
    assert.deepEqual(pairingRequestBody(draft, { ...noKiosk, lockDevice: true }), {
      deviceRole: 'till',
      deviceModel: 'N55F',
    });
    assert.deepEqual(
      pairingRequestBody(
        { ...draft, role: 'kiosk', companyId: 'c', shopId: 's' },
        { ...noKiosk, name: ' כניסה ', controllerMachineIds: ['t1'], lockDevice: true },
      ),
      {
        deviceRole: 'kiosk',
        deviceModel: 'N55F',
        companyId: 'c',
        shopId: 's',
        kiosk: { name: 'כניסה', controllerMachineIds: ['t1'], lockDevice: true },
      },
    );
  });
});

describe('changing them on the machine page', () => {
  it('only what changed is sent', () => {
    const current = { role: 'till' as const, model: 'N55F' as const };
    assert.equal(deviceProfileBody(current, current, noKiosk), null);
    assert.deepEqual(deviceProfileBody(current, { ...current, model: 'MODO' }, noKiosk), { deviceModel: 'MODO' });
    assert.deepEqual(deviceProfileBody(current, { ...current, role: 'kiosk' }, { ...noKiosk, lockDevice: true }), {
      deviceRole: 'kiosk',
      kiosk: { controllerMachineIds: [], lockDevice: true },
    });
    assert.deepEqual(deviceProfileBody({ role: 'kiosk', model: 'P18' }, { role: 'till', model: 'P18' }, noKiosk), {
      deviceRole: 'till',
    });
  });

  it('the server message of a refusal is shown as is', () => {
    const err = { response: { data: { detail: 'device_profile_open_shift', message: 'לא ניתן…' } } };
    assert.equal(deviceProfileErrorMessage(err), 'לא ניתן…');
    assert.equal(deviceProfileErrorCode(err), 'device_profile_open_shift');
    assert.equal(deviceProfileErrorMessage({ response: { data: { detail: 'x' } } }), null);
    assert.equal(deviceProfileErrorMessage(new Error('net')), null);
  });
});

describe('a kiosk charges on an external pinpad', () => {
  it('no built-in terminal whatever the model; the printer stays as the model has it', () => {
    assert.equal(capabilitiesOf('N55F', { kiosk: true }).builtinTerminal, false);
    assert.equal(capabilitiesOf('N55F', { kiosk: true }).builtinPrinter, true);
    assert.equal(capabilitiesOf('MODO', { kiosk: true }).builtinTerminal, false);
    assert.equal(capabilitiesOf('N55F').builtinTerminal, true);
  });

  it('the machine page warns a kiosk with no pinpad address', () => {
    assert.equal(kioskPinpadMissing({ deviceRole: 'kiosk', pinpadAddressMissing: true }), true);
    assert.equal(kioskPinpadMissing({ deviceRole: 'kiosk', pinpadAddressMissing: false }), false);
    assert.equal(kioskPinpadMissing({ deviceRole: 'till', pinpadAddressMissing: true }), false);
    // Explicitly on Z-Credit: no pinpad address needed.
    assert.equal(
      kioskPinpadMissing({ deviceRole: 'kiosk', pinpadAddressMissing: true, paymentIntegration: 'zcredit' }),
      false,
    );
  });

  it('the address is checked as the server checks it', () => {
    assert.equal(pinpadHostError(''), null);
    assert.equal(pinpadHostError('192.168.1.20'), null);
    assert.equal(pinpadHostError('pinpad-1.local'), null);
    assert.equal(pinpadHostError('192.168.1.300'), 'invalid');
    assert.equal(pinpadHostError('http://10.0.0.5'), 'invalid');
    assert.equal(pinpadHostError('10.0.0.5:8080'), 'invalid');
    assert.equal(pinpadPortError(''), null);
    assert.equal(pinpadPortError('8080'), null);
    assert.equal(pinpadPortError('70000'), 'invalid');
    assert.equal(kioskDraftError({ ...noKiosk, pinpadHost: 'a b' }), 'pinpadHost');
    assert.equal(kioskDraftError({ ...noKiosk, pinpadHost: '10.0.0.5', pinpadPort: 'x' }), 'pinpadPort');
    assert.equal(kioskDraftError({ ...noKiosk, pinpadPort: 'x' }), null);
  });

  it('a typed address travels with the kiosk, as the existing pinpad keys', () => {
    const body = pairingRequestBody(
      { role: 'kiosk', model: 'P18', machineCode: 'K', companyId: 'c', shopId: 's' },
      { ...noKiosk, pinpadHost: ' 10.0.0.5 ', pinpadPort: '9000' },
    );
    assert.deepEqual(body.kiosk, { controllerMachineIds: [], lockDevice: false, pinpadHost: '10.0.0.5', pinpadPort: 9000 });
    const noPort = pairingRequestBody(
      { role: 'kiosk', model: 'P18', machineCode: 'K', companyId: 'c', shopId: 's' },
      { ...noKiosk, pinpadHost: '10.0.0.5' },
    );
    assert.deepEqual(noPort.kiosk, { controllerMachineIds: [], lockDevice: false, pinpadHost: '10.0.0.5' });
  });
});
