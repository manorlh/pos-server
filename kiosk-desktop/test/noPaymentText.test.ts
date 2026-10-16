/**
 * "התשלום אינו זמין כרגע" says why (core/noPaymentText.ts): a kiosk set "ללא אשראי" whose cash device is down is never
 * told to wait for a terminal it does not have.
 */
import { describe, expect, it } from 'vitest';
import { defaultText } from '@dash-lib/kioskTexts';
import { NO_PAYMENT_BODY_TERMINAL, noPaymentBodyHe, noPaymentCause } from '../src/core/noPaymentText';

describe('the no-payment screen’s default line', () => {
  it('the cause, from what the kiosk is set to take and what it can take now', () => {
    expect(noPaymentCause({ methods: ['card'], usable: [] })).toBe('terminal');
    // "ללא אשראי" with the cash device down: the cash device, never the terminal.
    expect(noPaymentCause({ methods: ['cash_device'], usable: [] })).toBe('cash_device');
    expect(noPaymentCause({ methods: ['card', 'cash_device'], usable: [] })).toBe('both');
    expect(noPaymentCause({ methods: ['card', 'cash_device'], usable: ['card'] })).toBe('cash_device');
    expect(noPaymentCause({ methods: [], usable: [] })).toBe('none');
  });

  it('the words: the terminal’s is the registry’s own default; the others name what is down', () => {
    expect(NO_PAYMENT_BODY_TERMINAL).toBe(defaultText('he', 'noPaymentBody'));
    expect(noPaymentBodyHe('terminal')).toBe(NO_PAYMENT_BODY_TERMINAL);
    expect(noPaymentBodyHe('cash_device')).toContain('מכשיר המזומן');
    expect(noPaymentBodyHe('cash_device')).not.toContain('המסופון');
    expect(noPaymentBodyHe('both')).toContain('המסופון ומכשיר המזומן');
    expect(noPaymentBodyHe('none')).not.toContain('המסופון');
  });
});
