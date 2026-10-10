import { describe, expect, it } from 'vitest';
import { tipOtherAgorot, tipPercentAgorot } from '@dash-lib/kioskConfig';
import { TIP_OTHER_MAX_AGOROT, tipOf, tipToCharge } from '../src/core/sale';

/** Tips on, with "סכום אחר" (the config's payment). */
const ON = { tipEnabled: true, tipOther: true };

describe('the tip charged (service.startPayment)', () => {
  it('a preset: the percent of the goods, half up to the agora — as the screen showed it', () => {
    for (const [goods, pct] of [
      [12_800, 10],
      [12_850, 12],
      [999, 15],
      [1, 50],
    ] as const) {
      expect(tipToCharge(ON, goods, pct, null)).toBe(tipOf(goods, pct));
      expect(tipToCharge(ON, goods, pct, null)).toBe(tipPercentAgorot(goods, pct));
    }
    expect(tipToCharge(ON, 12_800, null, null)).toBe(0);
  });

  it('"סכום אחר": whole shekels, above zero, up to the goods and ₪999 — wins over a percent', () => {
    expect(tipToCharge(ON, 12_800, 10, 2_000)).toBe(2_000);
    expect(tipToCharge(ON, 12_800, null, 12_800)).toBe(12_800);
    // Not a whole shekel, more than the order, more than ₪999, zero: the percent as before.
    expect(tipToCharge(ON, 12_800, 10, 2_050)).toBe(1_280);
    expect(tipToCharge(ON, 12_800, 10, 12_900)).toBe(1_280);
    expect(tipToCharge(ON, 200_000, null, TIP_OTHER_MAX_AGOROT + 100)).toBe(0);
    expect(tipToCharge(ON, 200_000, null, TIP_OTHER_MAX_AGOROT)).toBe(TIP_OTHER_MAX_AGOROT);
    expect(tipToCharge(ON, 12_800, null, 0)).toBe(0);
    // What the digits pad lets through is what the service charges.
    expect(tipToCharge(ON, 12_800, null, tipOtherAgorot('25', 12_800))).toBe(2_500);
    expect(tipOtherAgorot('129', 12_800)).toBeNull();
  });
  it("the Android kiosk's switches: tips off charge nothing, 'other' off takes the preset (KioskViewModel.price)", () => {
    expect(tipToCharge({ tipEnabled: false, tipOther: true }, 12_800, 10, 2_000)).toBe(0);
    expect(tipToCharge({ tipEnabled: true, tipOther: false }, 12_800, 10, 2_000)).toBe(1_280);
    expect(tipToCharge({ tipEnabled: true }, 12_800, 10, 2_000)).toBe(2_000);
  });
});
