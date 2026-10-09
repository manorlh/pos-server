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
  DEVICE_PLATFORMS,
  DEVICE_ROLES,
  NON_FISCAL_ROLES,
  SYNQPAY_DEVICE_MODEL_IDS,
  SUNMI_MODEL_IDS,
  VENDOR_DEVICE_MODEL_IDS,
  addDeviceMissing,
  capabilitiesOf,
  deviceModelIdOf,
  deviceModelWarning,
  deviceProfileBody,
  deviceProfileErrorCode,
  deviceProfileErrorMessage,
  devicePlatformOf,
  deviceRoleOf,
  isDisplayDevice,
  isFiscalRole,
  kioskDraftError,
  kioskPinpadMissing,
  modelNeeded,
  pairingRequestBody,
  pinpadHostError,
  pinpadPortError,
  roleNeedsShop,
  splitDisplayDevices,
  platformsFor,
  webKioskLink,
  webPathOf,
  webScreenLink,
} from './deviceProfile';

const noKiosk = { name: '', controllerMachineIds: [], lockDevice: false, pinpadHost: '', pinpadPort: '' };

describe('the model catalog', () => {
  it('six models, then the SUNMI family, in the order the picker shows them', () => {
    assert.deepEqual(
      [...DEVICE_MODEL_IDS].slice(0, 6),
      ['N55F', 'MODO', 'P18', 'LANDI', 'FEITIAN_TABLET', 'GENERIC_ANDROID'],
    );
    assert.deepEqual(
      [...DEVICE_MODEL_IDS].slice(6),
      [...SUNMI_MODEL_IDS, ...SYNQPAY_DEVICE_MODEL_IDS, ...VENDOR_DEVICE_MODEL_IDS],
    );
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

describe('PAX A77 / Urovo i9100 (app/models/vendor_devices.py)', () => {
  // The server's table, shared byte-for-byte with pos-android.
  const golden = JSON.parse(
    readFileSync(join(process.cwd(), '..', 'server', 'tests', 'fixtures', 'vendor_devices_golden.json'), 'utf8'),
  ) as {
    models: {
      id: string;
      printer: boolean;
      paperMm: number | null;
      drawerPort: boolean;
      scanner: boolean;
      builtinTerminal: boolean;
    }[];
  };

  it('the same table as the server, model by model', () => {
    assert.deepEqual(
      golden.models.map((m) => m.id),
      [...VENDOR_DEVICE_MODEL_IDS],
    );
    for (const m of golden.models) {
      const c = DEVICE_MODEL_CAPABILITIES[m.id as keyof typeof DEVICE_MODEL_CAPABILITIES];
      assert.deepEqual(
        [c.builtinPrinter, c.paperWidthMm, c.cashDrawerPort, c.builtinScanner, c.builtinTerminal, c.driverPending],
        [m.printer, m.paperMm, m.drawerPort, m.scanner, m.builtinTerminal, false],
        m.id,
      );
    }
  });

  it('Agamento on the device, like the F20, but not on a kiosk', () => {
    assert.equal(capabilitiesOf('PAX_A77').builtinTerminal, true);
    assert.equal(capabilitiesOf('UROVO_I9100').builtinTerminal, true);
    assert.equal(capabilitiesOf('UROVO_I9100', { kiosk: true }).builtinTerminal, false);
    assert.equal(deviceModelIdOf(' pax_a77 '), 'PAX_A77');
  });
});

describe('roles', () => {
  it('a till, a kiosk, a KDS or the ready / not-ready board', () => {
    assert.deepEqual([...DEVICE_ROLES], ['till', 'kiosk', 'kds', 'order_status_board', 'customer_display']);
    assert.equal(deviceRoleOf('customer_display'), 'customer_display');
    assert.equal(deviceRoleOf('kiosk'), 'kiosk');
    assert.equal(deviceRoleOf(' TILL '), 'till');
    assert.equal(deviceRoleOf('kds'), 'kds');
    assert.equal(deviceRoleOf('order_status_board'), 'order_status_board');
    assert.equal(deviceRoleOf('printer'), null);
    assert.equal(deviceRoleOf(undefined), null);
  });

  it('a KDS and the board are not tills, not accounting systems', () => {
    assert.deepEqual([...NON_FISCAL_ROLES], ['kds', 'order_status_board', 'customer_display']);
    // "מסך לקוח" (P:/specs/customer-display.md §4): a screen too — no sales, no Z.
    assert.equal(isFiscalRole('customer_display'), false);
    assert.equal(isFiscalRole('till'), true);
    assert.equal(isFiscalRole('kiosk'), true);
    assert.equal(isFiscalRole(null), true);
    assert.equal(isFiscalRole('kds'), false);
    assert.equal(isFiscalRole('order_status_board'), false);
    // The server's own `fiscal` wins; an older server's row is a till.
    assert.equal(isDisplayDevice({ fiscal: false, deviceRole: 'till' }), true);
    assert.equal(isDisplayDevice({ deviceRole: 'order_status_board' }), true);
    assert.equal(isDisplayDevice({ fiscal: true, deviceRole: 'kiosk' }), false);
    assert.equal(isDisplayDevice({}), false);
  });

  it('the lists keep the screens apart from the tills, in order', () => {
    const rows = [
      { id: '1', deviceRole: 'till', fiscal: true },
      { id: '2', deviceRole: 'kds', fiscal: false },
      { id: '3', deviceRole: 'kiosk', fiscal: true },
      { id: '4', deviceRole: 'order_status_board', fiscal: false },
    ];
    const { tills, screens } = splitDisplayDevices(rows);
    assert.deepEqual(tills.map((m) => m.id), ['1', '3']);
    assert.deepEqual(screens.map((m) => m.id), ['2', '4']);
  });

  it('every role and platform has its label', () => {
    const he = JSON.parse(readFileSync(join(process.cwd(), 'src', 'messages', 'he.json'), 'utf8'));
    const t = he.machines.deviceRole as Record<string, unknown> & { badge: Record<string, unknown> };
    for (const r of DEVICE_ROLES) {
      assert.equal(typeof t[r], 'string', r);
      assert.equal(typeof t[`${r}Hint`], 'string', r);
    }
    for (const r of NON_FISCAL_ROLES) assert.equal(typeof t.badge[r], 'string', r);
    for (const p of DEVICE_PLATFORMS) assert.equal(typeof (t.platforms as Record<string, unknown>)[p], 'string', p);
  });
});

describe('platforms', () => {
  it('Android, Windows or the browser (a kiosk only)', () => {
    assert.deepEqual([...DEVICE_PLATFORMS], ['android', 'windows', 'web']);
    assert.equal(devicePlatformOf('Web'), 'web');
    assert.deepEqual(platformsFor('kiosk'), ['android', 'windows', 'web']);
    assert.deepEqual(platformsFor('till'), ['android', 'windows']);
    assert.deepEqual(platformsFor(''), ['android', 'windows']);
    // The browser KDS and board (`/kds`, `/board` — SPEC_KDS §13): a screen may be a browser, a till never.
    assert.deepEqual(platformsFor('kds'), ['android', 'windows', 'web']);
    assert.deepEqual(platformsFor('order_status_board'), ['android', 'windows', 'web']);
    assert.deepEqual([webPathOf('kiosk'), webPathOf('kds'), webPathOf('order_status_board'), webPathOf('till')], ['/k', '/kds', '/board', null]);
    assert.deepEqual(platformsFor('customer_display'), ['android', 'windows', 'web']);
    assert.equal(webPathOf('customer_display'), '/display');
    assert.equal(webScreenLink('http://localhost:3002', 'customer_display', 'ab12'), 'http://localhost:3002/display#pair=AB12');
    assert.equal(webScreenLink('https://pos-cloud-app.vercel.app/', 'kds', 'ab12-cd34'), 'https://pos-cloud-app.vercel.app/kds#pair=AB12CD34');
    assert.equal(webScreenLink('http://localhost:3002', 'order_status_board', ' xy9 8zz1 '), 'http://localhost:3002/board#pair=XY98ZZ1');
    assert.equal(webScreenLink('http://localhost:3002', 'order_status_board'), 'http://localhost:3002/board');
    assert.equal(modelNeeded({ platform: 'web' }), false);
    assert.equal(webKioskLink('https://pos-cloud-app.vercel.app/', 'ab12-cd34'), 'https://pos-cloud-app.vercel.app/k#pair=AB12CD34');
    assert.equal(webKioskLink('http://localhost:3002'), 'http://localhost:3002/k');
    assert.equal(devicePlatformOf(' Windows '), 'windows');
    assert.equal(devicePlatformOf('android'), 'android');
    assert.equal(devicePlatformOf('ios'), null);
    assert.equal(devicePlatformOf(undefined), null);
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

  it('a KDS and the board need their shop too; a station screen its stations', () => {
    assert.equal(roleNeedsShop('till'), false);
    for (const role of ['kiosk', 'kds', 'order_status_board'] as const) assert.equal(roleNeedsShop(role), true);
    assert.equal(addDeviceMissing({ ...draft, role: 'kds' }), 'shop');
    assert.equal(addDeviceMissing({ ...draft, role: 'order_status_board' }), 'shop');
    const inShop = { ...draft, companyId: 'c', shopId: 's' };
    assert.equal(addDeviceMissing({ ...inShop, role: 'order_status_board' }), null);
    assert.equal(
      addDeviceMissing({ ...inShop, role: 'kds', kds: { name: '', screenRole: 'station', stationIds: [] } }),
      'stations',
    );
    assert.equal(
      addDeviceMissing({ ...inShop, role: 'kds', kds: { name: '', screenRole: 'station', stationIds: ['g'] } }),
      null,
    );
    assert.equal(addDeviceMissing({ ...inShop, role: 'kds', kds: { name: '', screenRole: 'expo', stationIds: [] } }), null);
  });

  it('a Windows device needs no model; an Android one does', () => {
    assert.equal(addDeviceMissing({ ...draft, model: '', platform: 'windows' }), null);
    assert.equal(addDeviceMissing({ ...draft, model: '', platform: 'android' }), 'model');
    assert.deepEqual(pairingRequestBody({ ...draft, platform: 'windows' }, noKiosk), {
      deviceRole: 'till',
      platform: 'windows',
    });
  });

  it('the screen of a KDS / board code', () => {
    const inShop = { ...draft, companyId: 'c', shopId: 's' };
    assert.deepEqual(
      pairingRequestBody(
        { ...inShop, role: 'kds', platform: 'windows', kds: { name: ' גריל ', screenRole: 'station', stationIds: ['g'] } },
        noKiosk,
      ),
      {
        deviceRole: 'kds',
        platform: 'windows',
        companyId: 'c',
        shopId: 's',
        kds: { name: 'גריל', screenRole: 'station', stationIds: ['g'] },
      },
    );
    // Stations only for a station screen; the board is a pickup screen with a name at most.
    assert.deepEqual(
      pairingRequestBody({ ...inShop, role: 'kds', kds: { name: '', screenRole: 'expo', stationIds: ['g'] } }, noKiosk).kds,
      { screenRole: 'expo', stationIds: [] },
    );
    assert.deepEqual(
      pairingRequestBody({ ...inShop, role: 'order_status_board', kds: { name: 'TV', screenRole: 'station', stationIds: ['g'] } }, noKiosk).kds,
      { name: 'TV' },
    );
    assert.equal(pairingRequestBody({ ...inShop, role: 'order_status_board' }, noKiosk).kiosk, undefined);
  });

  it('a customer display code: its shop, its name and the till it mirrors (optional)', () => {
    assert.equal(roleNeedsShop('customer_display'), true);
    assert.equal(addDeviceMissing({ ...draft, role: 'customer_display' }), 'shop');
    const inShop = { ...draft, companyId: 'c', shopId: 's' };
    assert.equal(addDeviceMissing({ ...inShop, role: 'customer_display' }), null);
    assert.deepEqual(
      pairingRequestBody({ ...inShop, role: 'customer_display', platform: 'web', kds: { name: ' מסך 1 ', screenRole: 'expo', stationIds: [] }, mirrorTillId: 't1' }, noKiosk).kds,
      { name: 'מסך 1', tillMachineId: 't1' },
    );
    assert.deepEqual(pairingRequestBody({ ...inShop, role: 'customer_display' }, noKiosk).kds, {});
  });

  it('the generate body carries the role, and the kiosk options for a kiosk only', () => {
    assert.deepEqual(pairingRequestBody(draft, { ...noKiosk, lockDevice: true }), {
      deviceRole: 'till',
      deviceModel: 'N55F',
      platform: 'android',
    });
    assert.deepEqual(
      pairingRequestBody(
        { ...draft, role: 'kiosk', companyId: 'c', shopId: 's' },
        { ...noKiosk, name: ' כניסה ', controllerMachineIds: ['t1'], lockDevice: true },
      ),
      {
        deviceRole: 'kiosk',
        deviceModel: 'N55F',
        platform: 'android',
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
