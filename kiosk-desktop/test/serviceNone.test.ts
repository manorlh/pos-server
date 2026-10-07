/**
 * "ללא סוג שירות" (`general.serviceMode` = none — the owner, 07.10.2026: "אין אופציה לבטל לגמרי
 * באופציות לקחת או לשבת"): the customer is not asked, and the order carries no service at all —
 * no "טייק אווי" / "ישיבה במקום" on the slip, no band on the bon, none sent with the order. The
 * same rule as the browser kiosk (client lib/kioskFlow.ts) and the Android kiosk (KioskServiceNoneTest).
 */
import { describe, expect, it } from 'vitest';
import { KIOSK_DEFAULTS } from '@dash-lib/kioskConfig';
import { INITIAL_FLOW, orderServiceOf, reduce, rulesOf, serviceOnAttract, servicesOf, type FlowConfigIn } from '../src/core/kioskFlow';
import * as web from '@dash-lib/kioskFlow';
import { bonDoc, slipDoc } from '../src/core/printDocs';
import { startPaymentInput } from '../src/main/bridge/runtime';

const cfg = (general: Record<string, unknown>, payment: Record<string, unknown> = {}): FlowConfigIn =>
  ({
    general: { ...KIOSK_DEFAULTS.general, ...general },
    payment: { ...KIOSK_DEFAULTS.payment, customerName: 'off', ...payment },
  }) as unknown as FlowConfigIn;

describe('"ללא סוג שירות" on the Windows kiosk', () => {
  const none = cfg({ serviceMode: 'none', serviceTypes: ['take_away', 'eat_in'], servicePlacement: 'attract' });

  it('no service at all: never asked, straight to the menu with none', () => {
    expect(servicesOf(none)).toEqual([]);
    expect(serviceOnAttract(none)).toBe(false);
    const s = reduce(INITIAL_FLOW, { type: 'start' }, rulesOf(none, true));
    expect(s).toMatchObject({ screen: 'catalog', service: null });
    expect(reduce(s, { type: 'back' }, rulesOf(none, true)).screen).toBe('attract');
    expect(orderServiceOf(s.service, none)).toBe(null);
    expect(orderServiceOf('eat_in', none)).toBe(null);
    // The browser kiosk's copy says the same.
    expect(web.servicesOf(none as web.FlowConfigIn)).toEqual([]);
    expect(web.orderServiceOf(null, none as web.FlowConfigIn)).toBe(null);
  });

  it('configs from before keep their behaviour', () => {
    const two = cfg({ serviceTypes: ['take_away', 'eat_in'] });
    expect(servicesOf(two)).toEqual(['take_away', 'eat_in']);
    expect(reduce(INITIAL_FLOW, { type: 'start' }, rulesOf(two, true)).screen).toBe('service');
    expect(orderServiceOf('eat_in', two)).toBe('eat_in');
    expect(orderServiceOf(null, cfg({ serviceTypes: ['eat_in'] }))).toBe('eat_in');
    expect(orderServiceOf(null, cfg({ serviceMode: 'types', serviceTypes: [] }))).toBe('take_away');
  });

  it('no word on the slip, no band on the bon', () => {
    const slip = slipDoc({ businessName: 'רויאל בר', pickupLabel: 'A-17', service: null, itemCount: 3, totalAgorot: 8900 });
    expect(slip.service).toBe(null);
    expect(slipDoc({ businessName: null, pickupLabel: '1', service: 'eat_in', itemCount: 1, totalAgorot: 100 }).service).toBe('ישיבה במקום');
    const bon = bonDoc({
      pickupLabel: 'A-17', customerName: null, tableRef: null, documentNumber: '1', service: null, createdAt: new Date(0),
      kioskName: 'קיוסק', posNumber: null, machineName: null, lines: [], reprint: false, copy: 1, printerName: null,
    });
    expect(bon.dining).toBe(null);
  });

  it('a page (the Android bridge, the browser) may send no service: it stays none', () => {
    const line = { key: 'k', productId: 'p', qty: 1 };
    expect(startPaymentInput({ lines: [line], service: null })?.service).toBe(null);
    expect(startPaymentInput({ lines: [line], service: 'eat_in' })?.service).toBe('eat_in');
    expect(startPaymentInput({ lines: [line] })?.service).toBe('take_away');
  });
});
