/**
 * The Windows kiosk's KDS release (src/main/kiosk/kdsRelease.ts): the Android kiosk's payload,
 * idempotent by the document, only for a KDS-mode order in a shop that runs the KDS; carried by
 * a side row of the outbox, and dropped (not parked for ever) on a refusal.
 */

import { describe, expect, it } from 'vitest';
import { kdsSaleRelease, nameUuid, releasesToKds, saleDispatchId } from '../src/main/kiosk/kdsRelease';
import { FINAL_ON_REFUSAL, plan, SIDE_KINDS, type OutboxRow } from '../src/main/sync/outbox';
import type { SaleLine } from '../src/core/sale';

const lines: SaleLine[] = [
  {
    key: 'l1',
    productId: '0b1c2d3e-0000-4000-8000-000000000001',
    name: 'המבורגר',
    sku: '1001',
    basePriceAgorot: 3800,
    options: [
      { groupId: 'g', optionId: 'a', name: 'גבינה', priceAgorot: 400, qty: 1 },
      { groupId: 'g', optionId: 'b', name: 'בצל מטוגן', priceAgorot: 0, qty: 2 },
    ],
    notes: ['בלי בצל', 'מדיום'],
    qty: 1,
  },
  { key: 'l2', productId: '0b1c2d3e-0000-4000-8000-000000000002', name: 'צ׳יפס', sku: null, basePriceAgorot: 2350, options: [], notes: [], qty: 2 },
  { key: 'l3', productId: '0b1c2d3e-0000-4000-8000-000000000003', name: 'בוטל', sku: null, basePriceAgorot: 100, options: [], notes: [], qty: 0 },
];

const input = (over: Record<string, unknown> = {}) => ({
  transactionId: 'c1a8f0e2-5b7d-4a1e-9f3c-6d2e8b1a4c77',
  transactionNumber: '40000057',
  order: { serviceType: 'take_away' as const, customerName: ' דנה ', customerPhone: '0501234567', pickupNumber: 17, pickupLabel: 'A-17' as string | null },
  lines,
  categoryOf: (id: string) => (id.endsWith('01') ? 'cat-mains' : null),
  actorName: 'קיוסק Windows',
  occurredAt: '2026-10-06T09:15:01.300Z',
  ...over,
});

describe('the release id', () => {
  it('is Java’s UUID.nameUUIDFromBytes — the same vectors as pos-android KdsDomainTest', () => {
    expect(saleDispatchId('tx-1')).toBe('8812b174-01ce-3536-85f9-87d430596cd9');
    expect(saleDispatchId('0b8e1a52-6a3f-4c3e-9d6e-2f4a1b7c9d01')).toBe('fd96dcb1-609b-399e-84e5-c21354e9388a');
    expect(nameUuid('x')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-3[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('one per document, whoever builds it and however often', () => {
    expect(kdsSaleRelease(input()).id).toBe(kdsSaleRelease(input({ occurredAt: '2026-10-06T10:00:00.000Z' })).id);
    expect(kdsSaleRelease(input()).id).not.toBe(kdsSaleRelease(input({ transactionId: 'other' })).id);
  });
});

describe('the body (the Android kiosk’s payload)', () => {
  it('a paid kiosk order, after payment, with the kiosk’s pickup number and the customer’s details', () => {
    const b = kdsSaleRelease(input());
    expect(b).toMatchObject({
      source: 'kiosk',
      sourceRef: 'c1a8f0e2-5b7d-4a1e-9f3c-6d2e8b1a4c77',
      trigger: 'payment',
      paid: true,
      fallbackPrinted: false,
      serviceType: 'take_away',
      pickupName: 'דנה',
      contactPhone: '0501234567',
      transactionNumber: '40000057',
      pickupNumber: 17,
      pickupLabel: 'A-17',
      waiterName: 'קיוסק Windows',
      noteUpdates: [],
    });
  });

  it('every line once, keyed <line>:0, its options as mods, its notes, its category; nothing of a zero line', () => {
    const items = kdsSaleRelease(input()).items as Array<Record<string, unknown>>;
    expect(items).toEqual([
      { lineKey: 'l1:0', productId: lines[0].productId, name: 'המבורגר', quantity: 1, categoryId: 'cat-mains', notes: 'בלי בצל · מדיום', mods: ['גבינה', '2× בצל מטוגן'] },
      { lineKey: 'l2:0', productId: lines[1].productId, name: 'צ׳יפס', quantity: 2 },
    ]);
  });

  it('leaves out what it does not know, and a pickup number the engine would refuse', () => {
    const b = kdsSaleRelease(input({ transactionNumber: null, actorName: null, order: { serviceType: 'eat_in', customerName: null, customerPhone: '  ', pickupNumber: 12000, pickupLabel: ' ' } }));
    for (const k of ['transactionNumber', 'actorName', 'waiterName', 'pickupName', 'contactPhone', 'pickupNumber', 'pickupLabel']) expect(b).not.toHaveProperty(k);
    expect(b.serviceType).toBe('eat_in');
  });
});

describe('only a KDS order in a shop that runs the KDS', () => {
  it('KDS mode and kdsEnabled — a BON order never reaches a kitchen screen', () => {
    expect(releasesToKds({ fulfillmentMode: 'KDS' }, true)).toBe(true);
    expect(releasesToKds({ fulfillmentMode: 'KDS' }, false)).toBe(false);
    expect(releasesToKds({ fulfillmentMode: 'BON' }, true)).toBe(false);
  });
});

describe('the outbox carries it', () => {
  const row = (seq: number, kind: OutboxRow['kind'], ref: string): OutboxRow => ({ seq, kind, ref_id: ref, created_at: '', attempts: 0, last_error: null, next_at: 0 });

  it('a side row, before the shift stream — and final on a refusal', () => {
    expect(SIDE_KINDS.has('kds_release')).toBe(true);
    expect(FINAL_ON_REFUSAL.has('kds_release')).toBe(true);
    expect(FINAL_ON_REFUSAL.has('transmission')).toBe(false);
    const steps = plan([row(1, 'transaction', 'd1'), row(2, 'kds_release', 'd1'), row(3, 'shift_open', 's1')], () => 's1', (id) => ({ id, sequence: 1, openedAt: '' }));
    expect(steps[0]).toMatchObject({ kind: 'side', row: { kind: 'kds_release', ref_id: 'd1' } });
  });
});
