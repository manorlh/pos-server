/**
 * Run with `npm test`. The dashboard's copy of the server's "never leave a till without a
 * way to take payment" rule (lib/paymentOptions.ts; server app/services/payment_options.py):
 * every cash and card option off is a voucher-only till while the production voucher —
 * scanned or typed by hand — is on; only nothing at all is refused.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  PAYMENT_OPTIONS,
  VOUCHER_SWITCHES,
  VOUCHER_SWITCH_DEFAULT,
  noPaymentOptionAllowed,
  resolvePaymentOptionKey,
  voucherOnly,
} from './paymentOptions';
import type { PosSettingsPatch, PosSettingsV1 } from './types';

const CASH_CARD_OFF: PosSettingsPatch = Object.fromEntries(
  PAYMENT_OPTIONS.map((o) => [o.enabledKey, false]),
);
const VOUCHER_OFF: PosSettingsPatch = { payVoucherEnabled: false, payVoucherManualEnabled: false };

describe('voucher switches', () => {
  it('are the keys the server and the till read', () => {
    assert.deepEqual(
      VOUCHER_SWITCHES.map((v) => v.key),
      ['payVoucherEnabled', 'payVoucherManualEnabled'],
    );
  });

  it('are on when nothing sets them', () => {
    assert.equal(VOUCHER_SWITCH_DEFAULT, true);
    for (const v of VOUCHER_SWITCHES) {
      assert.equal(resolvePaymentOptionKey(v.key, {}, undefined, VOUCHER_SWITCH_DEFAULT), true);
    }
  });

  it('inherit, and a layer of its own wins', () => {
    const inherited: PosSettingsV1 = { payVoucherEnabled: false, payVoucherManualEnabled: true };
    assert.equal(resolvePaymentOptionKey('payVoucherEnabled', {}, inherited, true), false);
    assert.equal(
      resolvePaymentOptionKey('payVoucherEnabled', { payVoucherEnabled: true }, inherited, true),
      true,
    );
    // `null` = this layer resets to inherit.
    assert.equal(
      resolvePaymentOptionKey('payVoucherManualEnabled', { payVoucherManualEnabled: null }, inherited, true),
      true,
    );
  });
});

describe('noPaymentOptionAllowed', () => {
  it('allows a voucher-only layer (every cash and card option off)', () => {
    assert.equal(noPaymentOptionAllowed(CASH_CARD_OFF, undefined), false);
    assert.equal(noPaymentOptionAllowed({ ...CASH_CARD_OFF, payVoucherEnabled: false }, undefined), false);
    assert.equal(
      noPaymentOptionAllowed({ ...CASH_CARD_OFF, payVoucherManualEnabled: false }, undefined),
      false,
    );
  });

  it('refuses only when nothing at all is left', () => {
    assert.equal(noPaymentOptionAllowed({ ...CASH_CARD_OFF, ...VOUCHER_OFF }, undefined), true);
  });

  it('reads what the layer inherits', () => {
    const inherited: PosSettingsV1 = { ...(CASH_CARD_OFF as PosSettingsV1), payVoucherEnabled: false };
    assert.equal(noPaymentOptionAllowed({}, inherited), false); // typing the code is still on
    assert.equal(noPaymentOptionAllowed({ payVoucherManualEnabled: false }, inherited), true);
    assert.equal(
      noPaymentOptionAllowed({ payVoucherManualEnabled: false, payCashEnabled: true }, inherited),
      false,
    );
  });

  it('a cash or card option alone still keeps a layer payable', () => {
    for (const o of PAYMENT_OPTIONS) {
      assert.equal(
        noPaymentOptionAllowed({ ...CASH_CARD_OFF, ...VOUCHER_OFF, [o.enabledKey]: true }, undefined),
        false,
      );
    }
  });
});

describe('voucherOnly', () => {
  it('is a layer whose only way to pay is the voucher', () => {
    assert.equal(voucherOnly({}, undefined), false);
    assert.equal(voucherOnly(CASH_CARD_OFF, undefined), true);
    assert.equal(voucherOnly({ ...CASH_CARD_OFF, ...VOUCHER_OFF }, undefined), false);
    assert.equal(voucherOnly({ ...CASH_CARD_OFF, payCardEnabled: true }, undefined), false);
  });
});
