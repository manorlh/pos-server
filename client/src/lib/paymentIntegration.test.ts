/**
 * Run with `npm test`. The payment-integration rules the dashboard applies (lib/paymentIntegration.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanIntegration,
  cleanPinpadId,
  fieldPresent,
  formEffectiveIntegration,
  hasPaymentIntegrationErrors,
  inheritedLabel,
  integrationBadge,
  integrationOptions,
  isExternal,
  isSecretMask,
  isValidPinpadHost,
  isValidPort,
  missingFieldsLabel,
  missingRequiredFields,
  normalizeMachineIntegration,
  paymentIntegrationErrorMessage,
  PI_TEXT,
  resolveFormIntegration,
  secretSavedLabel,
  spicyPathError,
  validatePaymentIntegration,
  withSendableSecrets,
} from './paymentIntegration';
import type { PaymentIntegrationForm, SecretsStatus } from './paymentIntegration';

const noSecrets: SecretsStatus = {
  zcreditPassword: { set: false, source: null, own: false },
  zcreditKey: { set: false, source: null, own: false },
};

const fullZcredit: PaymentIntegrationForm = {
  paymentIntegration: 'zcredit',
  zcreditTerminalNumber: '0123456789',
  zcreditPassword: 'not-a-real-password',
  zcreditPinpadId: 'PINPAD100000',
  zcreditMode: 'test',
};

describe('values', () => {
  it('cleans known values and refuses the rest', () => {
    assert.equal(cleanIntegration(' Nayax-LAN '), 'nayax_lan');
    assert.equal(cleanIntegration('zcredit'), 'zcredit');
    assert.equal(cleanIntegration('visa'), null);
    assert.equal(cleanIntegration(null), null);
  });
  it('knows which integrations are external', () => {
    assert.equal(isExternal('nayax_lan'), true);
    assert.equal(isExternal('zcredit'), true);
    assert.equal(isExternal('tap_to_pay'), true);
    assert.equal(isExternal('agamento'), false);
    assert.equal(isExternal('auto'), false);
  });
});

describe('integrationOptions', () => {
  const byValue = (opts: ReturnType<typeof integrationOptions>) => Object.fromEntries(opts.map((o) => [o.value, o]));

  it('offers everything but Tap to Pay on a till with its own terminal', () => {
    const o = byValue(integrationOptions({ hasBuiltinTerminal: true, hasNfc: true }));
    assert.equal(o.auto.selectable, true);
    assert.equal(o.agamento.selectable, true);
    assert.equal(o.nayax_lan.selectable, true);
    assert.equal(o.zcredit.selectable, true);
    assert.equal(o.tap_to_pay.selectable, false);
  });

  it('disables the built-in terminal, with why, on a till without one', () => {
    const o = byValue(integrationOptions({ hasBuiltinTerminal: false, hasNfc: true }));
    assert.equal(o.agamento.selectable, false);
    assert.equal(o.agamento.reason, 'needs_builtin_terminal');
    assert.equal(o.agamento.explanation, PI_TEXT.agamentoNeedsBuiltin);
    assert.equal(o.nayax_lan.selectable, true);
    assert.equal(o.zcredit.selectable, true);
  });

  it('never lets Tap to Pay be picked, and hides it on a device without NFC', () => {
    for (const device of [null, { hasBuiltinTerminal: true, hasNfc: true }, { hasBuiltinTerminal: false, hasNfc: null }]) {
      const o = byValue(integrationOptions(device));
      assert.equal(o.tap_to_pay.selectable, false);
      assert.equal(o.tap_to_pay.reason, 'soon');
      assert.equal(o.tap_to_pay.hidden, false);
      assert.match(o.tap_to_pay.label, /בקרוב/);
    }
    const noNfc = byValue(integrationOptions({ hasBuiltinTerminal: false, hasNfc: false }));
    assert.equal(noNfc.tap_to_pay.reason, 'needs_nfc');
    assert.equal(noNfc.tap_to_pay.hidden, true);
  });

  it('offers the built-in terminal on an upper layer (no device known)', () => {
    const o = byValue(integrationOptions(undefined));
    assert.equal(o.agamento.selectable, true);
  });

  it('lets the server take a choice away, never add one', () => {
    const o = byValue(
      integrationOptions({ hasBuiltinTerminal: null }, [
        { value: 'agamento', selectable: false, reason: 'needs_builtin_terminal' },
        { value: 'tap_to_pay', selectable: true },
      ]),
    );
    assert.equal(o.agamento.selectable, false);
    assert.equal(o.tap_to_pay.selectable, false);
  });
});

describe('resolveFormIntegration', () => {
  it('takes this layer, else the inherited one, else automatic', () => {
    assert.deepEqual(resolveFormIntegration({ own: 'zcredit', inherited: 'nayax_lan' }), {
      selected: 'zcredit',
      effective: 'zcredit',
      automatic: false,
      inherited: false,
    });
    assert.deepEqual(resolveFormIntegration({ own: 'auto', inherited: 'zcredit' }), {
      selected: 'auto',
      effective: 'zcredit',
      automatic: false,
      inherited: true,
    });
    assert.equal(resolveFormIntegration({ own: null, inherited: null }).effective, 'auto');
  });

  it('keeps the older nayaxEnabled: automatic + nayaxEnabled is Nayax', () => {
    const r = resolveFormIntegration({ own: undefined, inherited: undefined, nayaxEnabled: true });
    assert.equal(r.effective, 'nayax_lan');
    assert.equal(r.automatic, true);
    assert.equal(formEffectiveIntegration({}, { nayaxEnabled: true }).effective, 'nayax_lan');
    // This layer's own `false` wins over an inherited `true`.
    assert.equal(formEffectiveIntegration({ nayaxEnabled: false }, { nayaxEnabled: true }).effective, 'auto');
  });

  it('resolves a till automatically by its hardware', () => {
    assert.equal(resolveFormIntegration({ own: null, inherited: null, hasBuiltinTerminal: true }).effective, 'agamento');
    assert.equal(resolveFormIntegration({ own: null, inherited: null, hasBuiltinTerminal: false }).effective, 'nayax_lan');
  });

  it("skips an inherited built-in terminal on a till that has none, as the server does", () => {
    const r = resolveFormIntegration({ own: null, inherited: 'agamento', hasBuiltinTerminal: false });
    assert.equal(r.effective, 'nayax_lan');
    assert.equal(r.automatic, true);
  });
});

describe('host, port, path, PinPad id', () => {
  it('accepts IPv4 addresses and host names', () => {
    for (const h of ['192.168.1.50', '10.0.0.1', 'pinpad-1.local', 'NOVA', '1.example']) {
      assert.equal(isValidPinpadHost(h), true, h);
    }
  });
  it('refuses broken addresses', () => {
    for (const h of ['192.168.1.300', '192.168.1', '192.168.01.5', 'http://1.2.3.4', '1.2.3.4:8080', 'my_host', '-a.b', 'a..b', '']) {
      assert.equal(isValidPinpadHost(h), false, h);
    }
  });
  it('checks the port range', () => {
    assert.equal(isValidPort('8080'), true);
    assert.equal(isValidPort('1'), true);
    assert.equal(isValidPort('65535'), true);
    assert.equal(isValidPort('0'), false);
    assert.equal(isValidPort('65536'), false);
    assert.equal(isValidPort('80a'), false);
  });
  it('wants an absolute plain path', () => {
    assert.equal(spicyPathError('/SPICy'), null);
    assert.equal(spicyPathError('SPICy'), PI_TEXT.pathNoSlash);
    assert.equal(spicyPathError('/a b'), PI_TEXT.pathInvalid);
  });
  it('takes a PinPad id with or without the PINPAD prefix', () => {
    assert.equal(cleanPinpadId('PINPAD100000'), '100000');
    assert.equal(cleanPinpadId('pinpad100000'), '100000');
    assert.equal(cleanPinpadId('100000'), '100000');
    assert.equal(cleanPinpadId('AB12'), 'AB12');
    assert.equal(cleanPinpadId('PINPAD'), null);
    assert.equal(cleanPinpadId('1000-00'), null);
  });
});

describe('validatePaymentIntegration — Nayax', () => {
  it('requires the host', () => {
    const errors = validatePaymentIntegration({ paymentIntegration: 'nayax_lan' }, {}, noSecrets);
    assert.deepEqual(errors, { nayaxDeviceHost: PI_TEXT.required });
  });
  it('refuses an invalid IP such as 192.168.1.300', () => {
    const errors = validatePaymentIntegration(
      { paymentIntegration: 'nayax_lan', nayaxDeviceHost: '192.168.1.300' },
      {},
      noSecrets,
    );
    assert.equal(errors.nayaxDeviceHost, PI_TEXT.hostInvalid);
  });
  it('checks the port range and the path', () => {
    const errors = validatePaymentIntegration(
      { paymentIntegration: 'nayax_lan', nayaxDeviceHost: '192.168.1.30', nayaxDevicePort: '70000', nayaxSpicyPath: 'SPICy' },
      {},
      noSecrets,
    );
    assert.deepEqual(errors, { nayaxDevicePort: PI_TEXT.portInvalid, nayaxSpicyPath: PI_TEXT.pathNoSlash });
  });
  it('is valid with a host, the port and path defaulting', () => {
    const errors = validatePaymentIntegration(
      { paymentIntegration: 'nayax_lan', nayaxDeviceHost: '192.168.1.30' },
      {},
      noSecrets,
    );
    assert.equal(hasPaymentIntegrationErrors(errors), false);
  });
  it('is satisfied by an inherited host', () => {
    const errors = validatePaymentIntegration({ paymentIntegration: 'nayax_lan' }, { nayaxDeviceHost: '10.0.0.7' }, noSecrets);
    assert.deepEqual(errors, {});
  });
  it('wants a host for a tablet left automatic', () => {
    const errors = validatePaymentIntegration({}, {}, noSecrets, { hasBuiltinTerminal: false });
    assert.deepEqual(errors, { nayaxDeviceHost: PI_TEXT.required });
  });
  it('a cleared field (null) falls back to the inherited value', () => {
    const errors = validatePaymentIntegration(
      { paymentIntegration: 'nayax_lan', nayaxDeviceHost: null },
      { nayaxDeviceHost: '10.0.0.7' },
      noSecrets,
    );
    assert.deepEqual(errors, {});
  });
});

describe('validatePaymentIntegration — Z-Credit', () => {
  it('requires all four fields', () => {
    const errors = validatePaymentIntegration({ paymentIntegration: 'zcredit' }, {}, noSecrets);
    assert.deepEqual(Object.keys(errors).sort(), [
      'zcreditMode',
      'zcreditPassword',
      'zcreditPinpadId',
      'zcreditTerminalNumber',
    ]);
    assert.equal(errors.zcreditTerminalNumber, PI_TEXT.required);
    assert.equal(errors.zcreditPassword, PI_TEXT.required);
    assert.equal(errors.zcreditMode, PI_TEXT.modeRequired);
  });
  it('is valid when complete, the key optional', () => {
    assert.deepEqual(validatePaymentIntegration(fullZcredit, {}, noSecrets), {});
  });
  it('wants digits in the terminal number, leading zeros allowed', () => {
    const bad = validatePaymentIntegration({ ...fullZcredit, zcreditTerminalNumber: '08820-16' }, {}, noSecrets);
    assert.equal(bad.zcreditTerminalNumber, PI_TEXT.digitsOnly);
    const zeros = validatePaymentIntegration({ ...fullZcredit, zcreditTerminalNumber: '000123' }, {}, noSecrets);
    assert.equal(zeros.zcreditTerminalNumber, undefined);
  });
  it('takes the PinPad id with or without its prefix', () => {
    assert.deepEqual(validatePaymentIntegration({ ...fullZcredit, zcreditPinpadId: '100000' }, {}, noSecrets), {});
    assert.deepEqual(validatePaymentIntegration({ ...fullZcredit, zcreditPinpadId: 'PINPAD100000' }, {}, noSecrets), {});
    const bad = validatePaymentIntegration({ ...fullZcredit, zcreditPinpadId: 'PIN PAD' }, {}, noSecrets);
    assert.equal(bad.zcreditPinpadId, PI_TEXT.pinpadInvalid);
  });
  it('refuses an unknown mode', () => {
    const bad = validatePaymentIntegration({ ...fullZcredit, zcreditMode: 'live' }, {}, noSecrets);
    assert.equal(bad.zcreditMode, PI_TEXT.modeRequired);
  });
  it('is satisfied by inherited values and a password stored at a parent', () => {
    const errors = validatePaymentIntegration(
      { zcreditPinpadId: '100001' },
      { paymentIntegration: 'zcredit', zcreditTerminalNumber: '0123456789', zcreditMode: 'production' },
      { zcreditPassword: { set: true, source: 'shop', own: false }, zcreditKey: { set: false } },
    );
    assert.deepEqual(errors, {});
  });
  it('a password saved on this layer counts; the mask is not a typed one', () => {
    const own: SecretsStatus = { zcreditPassword: { set: true, source: 'machine', own: true } };
    assert.deepEqual(validatePaymentIntegration({ ...fullZcredit, zcreditPassword: undefined }, {}, own), {});
    const masked = validatePaymentIntegration({ ...fullZcredit, zcreditPassword: '••••' }, {}, noSecrets);
    assert.equal(masked.zcreditPassword, PI_TEXT.required);
  });
  it('an unknown secrets status does not block', () => {
    assert.equal(fieldPresent('zcreditPassword', {}, {}, null), true);
  });
  it('above the till, lists missing fields rather than refuse them', () => {
    const form: PaymentIntegrationForm = { paymentIntegration: 'zcredit', zcreditTerminalNumber: '0123456789' };
    assert.deepEqual(validatePaymentIntegration(form, {}, noSecrets, { requireAll: false }), {});
    assert.deepEqual(missingRequiredFields('zcredit', form, {}, noSecrets), [
      'zcreditPassword',
      'zcreditPinpadId',
      'zcreditMode',
    ]);
    // Formats are still checked there.
    const bad = validatePaymentIntegration({ ...form, zcreditTerminalNumber: 'abc' }, {}, noSecrets, { requireAll: false });
    assert.equal(bad.zcreditTerminalNumber, PI_TEXT.digitsOnly);
  });
});

describe('validatePaymentIntegration — the choice itself', () => {
  it('refuses the built-in terminal on a till without one', () => {
    const errors = validatePaymentIntegration({ paymentIntegration: 'agamento' }, {}, noSecrets, { hasBuiltinTerminal: false });
    assert.equal(errors.paymentIntegration, PI_TEXT.agamentoNeedsBuiltin);
    assert.deepEqual(validatePaymentIntegration({ paymentIntegration: 'agamento' }, {}, noSecrets, { hasBuiltinTerminal: true }), {});
  });
  it('refuses Tap to Pay', () => {
    const errors = validatePaymentIntegration({ paymentIntegration: 'tap_to_pay' }, {}, noSecrets);
    assert.equal(errors.paymentIntegration, PI_TEXT.tapToPayReserved);
  });
  it('needs nothing for automatic or the built-in terminal', () => {
    assert.deepEqual(validatePaymentIntegration({ paymentIntegration: 'auto' }, {}, noSecrets), {});
    assert.deepEqual(validatePaymentIntegration({}, {}, noSecrets, { hasBuiltinTerminal: true }), {});
  });
  it('does not require Z-Credit fields while on Nayax, but checks one typed (the server would refuse it)', () => {
    assert.deepEqual(
      validatePaymentIntegration({ paymentIntegration: 'nayax_lan', nayaxDeviceHost: '10.0.0.2' }, {}, noSecrets),
      {},
    );
    const errors = validatePaymentIntegration(
      { paymentIntegration: 'nayax_lan', nayaxDeviceHost: '10.0.0.2', zcreditTerminalNumber: 'abc' },
      {},
      noSecrets,
    );
    assert.deepEqual(errors, { zcreditTerminalNumber: PI_TEXT.digitsOnly });
  });
  it('leaves a leftover Nayax address alone under another type', () => {
    const errors = validatePaymentIntegration(
      { paymentIntegration: 'agamento', nayaxDeviceHost: '1.2.3.4:8080' },
      {},
      noSecrets,
      { hasBuiltinTerminal: true },
    );
    assert.deepEqual(errors, {});
  });
});

describe('secrets', () => {
  it('recognises the mask', () => {
    assert.equal(isSecretMask('••••'), true);
    assert.equal(isSecretMask('****'), true);
    assert.equal(isSecretMask('ab••'), false);
    assert.equal(isSecretMask(''), false);
  });
  it('never sends the mask or a blank field, keeps a typed value and an explicit removal', () => {
    assert.deepEqual(withSendableSecrets({ zcreditPassword: '••••', zcreditKey: '' }), {});
    assert.deepEqual(withSendableSecrets({ zcreditPassword: 'abc', zcreditKey: undefined }), { zcreditPassword: 'abc' });
    assert.deepEqual(withSendableSecrets({ zcreditPassword: null }), { zcreditPassword: null });
  });
  it('says where a saved secret is kept', () => {
    assert.equal(secretSavedLabel('zcreditPassword', 'shop', false), 'סיסמה שמורה ברמת החנות');
    assert.equal(secretSavedLabel('zcreditPassword', 'machine', true), 'סיסמה שמורה');
    assert.equal(secretSavedLabel('zcreditKey', 'tenant', false), 'מפתח שמור ברמת הארגון');
  });
});

describe('labels', () => {
  it('names the missing fields', () => {
    assert.equal(missingFieldsLabel(['zcreditTerminalNumber', 'zcreditPinpadId']), 'חסר: מספר מסוף, מזהה PinPad');
    assert.equal(missingFieldsLabel([]), '');
    assert.equal(missingFieldsLabel(['somethingNew']), 'חסר: somethingNew');
  });
  it('says where an integration is inherited from', () => {
    assert.equal(inheritedLabel('zcredit', 'shop'), 'בירושה מהחנות: Z-Credit — מסופון חיצוני');
    assert.equal(inheritedLabel('nayax_lan', 'area'), 'בירושה מנקודת המכירה: Nayax — מסופון ברשת');
  });
});

describe('integrationBadge', () => {
  it('names the integration in use', () => {
    const b = integrationBadge({ paymentIntegration: 'zcredit', paymentIntegrationSource: 'shop', paymentIntegrationAutomatic: false, paymentIntegrationMissing: [] });
    assert.equal(b?.label, 'Z-Credit');
    assert.equal(b?.tone, 'neutral');
    assert.equal(b?.missing, '');
    assert.match(b?.title ?? '', /ברמת החנות/);
  });
  it('marks an automatic choice', () => {
    const b = integrationBadge({ paymentIntegration: 'agamento', paymentIntegrationAutomatic: true, paymentIntegrationMissing: [] });
    assert.equal(b?.label, 'מובנה (אוטומטי)');
    const n = integrationBadge({ paymentIntegration: 'nayax_lan', paymentIntegrationAutomatic: true });
    assert.equal(n?.label, 'Nayax (אוטומטי)');
  });
  it('warns while fields are missing', () => {
    const b = integrationBadge({
      paymentIntegration: 'zcredit',
      paymentIntegrationAutomatic: false,
      paymentIntegrationMissing: ['zcreditTerminalNumber', 'zcreditPinpadId'],
    });
    assert.equal(b?.tone, 'warn');
    assert.equal(b?.missing, 'חסר: מספר מסוף, מזהה PinPad');
  });
  it('shows nothing for a row from an older server', () => {
    assert.equal(integrationBadge({}), null);
    assert.equal(integrationBadge({ paymentIntegration: null }), null);
  });
  it('normalizes the row fields', () => {
    assert.deepEqual(normalizeMachineIntegration({}), {
      paymentIntegration: null,
      paymentIntegrationSource: null,
      paymentIntegrationAutomatic: null,
      paymentIntegrationMissing: [],
    });
    assert.deepEqual(
      normalizeMachineIntegration({
        paymentIntegration: 'zcredit',
        paymentIntegrationSource: 'shop',
        paymentIntegrationAutomatic: false,
        paymentIntegrationMissing: ['zcreditPinpadId', 3],
      }),
      {
        paymentIntegration: 'zcredit',
        paymentIntegrationSource: 'shop',
        paymentIntegrationAutomatic: false,
        paymentIntegrationMissing: ['zcreditPinpadId'],
      },
    );
  });
});

describe('paymentIntegrationErrorMessage', () => {
  const err = (detail: unknown) => ({ response: { status: 422, data: { detail } } });
  it("shows the server's words for the built-in terminal and a bad secret", () => {
    assert.equal(
      paymentIntegrationErrorMessage(err({ code: 'agamento_needs_builtin_terminal', msg: 'אין מסוף מובנה' })),
      'אין מסוף מובנה',
    );
    assert.equal(paymentIntegrationErrorMessage(err({ code: 'secret_invalid', msg: 'סוד לא תקין' })), 'סוד לא תקין');
  });
  it('leaves any other error alone', () => {
    assert.equal(paymentIntegrationErrorMessage(err('Not found')), null);
    assert.equal(paymentIntegrationErrorMessage(err({ code: 'other', msg: 'x' })), null);
    assert.equal(paymentIntegrationErrorMessage(new Error('boom')), null);
  });
});
