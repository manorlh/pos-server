/**
 * "מספר הזמנה: עם אות (A-17) / מספר בלבד (17)" (`pickup.labelFormat`, the owner 09.10.2026) on the
 * Windows kiosk: the label function on and off, and the allocation — the number alone comes from the
 * shop's shared counter (the config's repair forces `scope: 'shop'`); one drawn without the cloud is
 * tagged ("AL-4") in either format, so it is never mistaken for one of the shop's.
 */

import { describe, expect, it } from 'vitest';
import { offlinePickupLabel, pickupLabel, type PickupRules } from '../src/core/kioskOrders';
import { allocatePickup } from '../src/main/kiosk/orders';
import type { Kv } from '../src/main/db/schema';
import type { Api } from '../src/main/sync/api';
import { resolveKioskConfig } from '@dash-lib/kioskConfig';

function memoryKv(): Kv {
  const m = new Map<string, string>();
  return {
    get: (k: string) => m.get(k) ?? null,
    set: (k: string, v: string) => void m.set(k, v),
    getNumber: (k: string) => (m.has(k) ? Number(m.get(k)) : null),
    setNumber: (k: string, v: number) => void m.set(k, String(v)),
  } as unknown as Kv;
}

function cloud(answer: { number?: number; label?: string } | null): Api {
  return {
    post: async () => (answer ? { kind: 'ok', status: 200, body: answer, headers: new Headers() } : { kind: 'offline', reason: 'down' }),
  } as unknown as Api;
}

const order = { localId: 'o1', businessDate: '2026-10-09' };
const rules = (over: Partial<PickupRules> = {}): PickupRules => ({ scope: 'kiosk', prefix: 'A', start: 1, max: 999, labelFormat: 'prefixed', ...over });

describe('the label', () => {
  it('with its letter (the default) and the number alone', () => {
    expect(pickupLabel('A', 17)).toBe('A-17');
    expect(pickupLabel('A', 17, 'prefixed')).toBe('A-17');
    expect(pickupLabel('', 17, 'prefixed')).toBe('17');
    expect(pickupLabel('A', 17, 'number')).toBe('17');
    expect(pickupLabel(null, 5, null)).toBe('5');
    expect(offlinePickupLabel('A', 4)).toBe('AL-4');
  });
});

describe('the allocation', () => {
  it('with its letter, the kiosk’s own sequence as before', async () => {
    const kv = memoryKv();
    expect(await allocatePickup(kv, null, 'm', order, rules())).toEqual({ number: 1, label: 'A-1' });
    expect(await allocatePickup(kv, null, 'm', { ...order, localId: 'o2' }, rules())).toEqual({ number: 2, label: 'A-2' });
  });

  it('the number alone from the shop’s counter: the cloud’s label, else the number bare', async () => {
    const kv = memoryKv();
    expect(await allocatePickup(kv, cloud({ number: 17, label: '17' }), 'm', order, rules({ scope: 'shop', labelFormat: 'number' }))).toEqual({ number: 17, label: '17' });
    expect(await allocatePickup(kv, cloud({ number: 18 }), 'm', order, rules({ scope: 'shop', labelFormat: 'number' }))).toEqual({ number: 18, label: '18' });
  });

  it('a number drawn without the cloud is tagged in either format — never a bare "17" another kiosk may say', async () => {
    expect(await allocatePickup(memoryKv(), cloud(null), 'm', order, rules({ scope: 'shop', labelFormat: 'number' }))).toEqual({ number: 1, label: 'AL-1' });
    expect(await allocatePickup(memoryKv(), null, null, order, rules({ scope: 'kiosk', labelFormat: 'number' }))).toEqual({ number: 1, label: 'AL-1' });
    expect(await allocatePickup(memoryKv(), cloud(null), 'm', order, rules({ scope: 'shop' }))).toEqual({ number: 1, label: 'AL-1' });
  });

  it('the config: the number alone always takes the shop’s counter', () => {
    expect(resolveKioskConfig({ pickup: { labelFormat: 'number', scope: 'kiosk' } }).pickup.scope).toBe('shop');
    expect(resolveKioskConfig({}).pickup.labelFormat).toBe('prefixed');
  });
});
