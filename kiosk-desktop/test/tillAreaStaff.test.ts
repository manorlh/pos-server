/**
 * Points of sale on the Windows till (P:/specs/chain-areas.md §6, §8):
 *  - till users per point of sale: the roster's `areaIds` (null / absent / empty — every device of the shop; a list — only
 *    a device standing in one of them; a device in none refuses a user with a list), on the sign-in list and on the PIN;
 *  - the device's point of sale: the settings sync's `area` once it said one, else `machines/me`'s;
 *  - the catalog: a product the device's point of sale does not sell (`shopListed: false`) is not on the sell screen.
 */

import { describe, expect, it } from 'vitest';
import { NO_LOCK, type RosterUser } from '../src/core/desktopExit';
import { TEXT, allowedInArea, areaRefOf, deviceAreaIdOf, deviceAreaOf, loginCandidates, tryLogin } from '../src/core/till/staff';
import { sellableOnTill } from '../src/main/kiosk/catalog';

const hash = (pin: string) => `$2b$10$${pin}`;
const compare = async (pin: string, h: string) => h === hash(pin);

const user = (id: string, pin: string, areaIds?: string[] | null, extra: Partial<RosterUser> = {}): RosterUser => ({
  id,
  username: id,
  firstName: id,
  lastName: null,
  pinHash: hash(pin),
  role: 'cashier',
  isActive: true,
  shopId: 'shop-1',
  ...(areaIds !== undefined ? { areaIds } : {}),
  ...extra,
});

const BAR = 'area-bar';
const KITCHEN = 'area-kitchen';

describe('who may sign in on this point of sale (allowedInArea)', () => {
  it('no list — null, absent or empty — is every device of the shop, one in no point of sale too', () => {
    for (const ids of [null, undefined, []] as Array<string[] | null | undefined>) {
      expect(allowedInArea({ areaIds: ids }, BAR)).toBe(true);
      expect(allowedInArea({ areaIds: ids }, null)).toBe(true);
    }
  });

  it('a list: only a device standing in one of them (any letter case); a device in none refuses', () => {
    expect(allowedInArea({ areaIds: [BAR] }, BAR)).toBe(true);
    expect(allowedInArea({ areaIds: [KITCHEN, BAR] }, BAR.toUpperCase())).toBe(true);
    expect(allowedInArea({ areaIds: [KITCHEN] }, BAR)).toBe(false);
    expect(allowedInArea({ areaIds: [BAR] }, null)).toBe(false);
    expect(allowedInArea({ areaIds: [BAR] }, '')).toBe(false);
  });
});

describe("the device's point of sale", () => {
  it('reads `{id, name}`; anything else is none', () => {
    expect(areaRefOf({ id: BAR, name: 'בר' })).toEqual({ id: BAR, name: 'בר' });
    expect(areaRefOf({ id: BAR })).toEqual({ id: BAR, name: null });
    for (const v of [null, undefined, {}, { id: '' }, { id: 7 }, [BAR], BAR]) expect(areaRefOf(v)).toBeNull();
  });

  it('the settings sync wins once it carried the key (null there = moved out); else machines/me', () => {
    expect(deviceAreaIdOf({ id: KITCHEN, name: 'מטבח' }, { id: BAR, name: 'בר' })).toBe(KITCHEN);
    expect(deviceAreaIdOf(null, { id: BAR, name: 'בר' })).toBeNull();
    expect(deviceAreaIdOf(undefined, { id: BAR, name: 'בר' })).toBe(BAR);
    expect(deviceAreaOf(undefined, undefined)).toBeNull();
  });
});

describe('the sign-in list (loginCandidates)', () => {
  const users = [user('all', '1111'), user('bar', '2222', [BAR]), user('kitchen', '3333', [KITCHEN]), user('other-shop', '4444', null, { shopId: 'shop-2' })];
  const ids = (list: RosterUser[]) => list.map((u) => u.id).sort();

  it('in the bar: the unrestricted and the bar\'s', () => {
    expect(ids(loginCandidates(users, 'shop-1', BAR))).toEqual(['all', 'bar']);
  });

  it('a device in no point of sale: only the unrestricted', () => {
    expect(ids(loginCandidates(users, 'shop-1', null))).toEqual(['all']);
  });

  it('no point of sale asked (an older caller): the shop as before', () => {
    expect(ids(loginCandidates(users, 'shop-1'))).toEqual(['all', 'bar', 'kitchen']);
  });
});

describe('the PIN (tryLogin)', () => {
  const users = [user('all', '1111'), user('bar', '2222', [BAR]), user('kitchen', '3333', [KITCHEN])];
  const login = (pin: string, areaId: string | null | undefined, roster: RosterUser[] = users, lock = NO_LOCK) =>
    tryLogin({ users: roster, shopId: 'shop-1', ...(areaId !== undefined ? { areaId } : {}), pin, lock, nowMs: 1_000, compare });

  it('a user of this point of sale, and an unrestricted one, sign in', async () => {
    expect((await login('2222', BAR)).user?.id).toBe('bar');
    expect((await login('1111', BAR)).user?.id).toBe('all');
    expect((await login('1111', null)).outcome).toBe('granted');
  });

  it("another point of sale's employee is refused by name — no try spent", async () => {
    const lock = { failures: 2, lockedUntilMs: 0 };
    const d = await login('3333', BAR, users, lock);
    expect(d.outcome).toBe('not_in_area');
    expect(d.user).toBeNull();
    expect(d.message).toBe('העובד לא משויך לנקודת המכירה של הקופה');
    expect(d.message).toBe(TEXT.notInArea);
    expect(d.lock).toEqual(lock);
  });

  it('a device in no point of sale refuses a user with a list', async () => {
    expect((await login('2222', null)).outcome).toBe('not_in_area');
  });

  it('a wrong code is still a wrong code (a try spent)', async () => {
    const d = await login('9999', BAR);
    expect(d.outcome).toBe('wrong');
    expect(d.lock.failures).toBe(1);
  });

  it('two employees on one code: the one allowed here signs in', async () => {
    const roster = [user('kitchen', '5555', [KITCHEN]), user('bar', '5555', [BAR])];
    expect((await login('5555', BAR, roster)).user?.id).toBe('bar');
  });

  it('no point of sale given (an older caller): not checked', async () => {
    expect((await login('3333', undefined)).user?.id).toBe('kitchen');
  });
});

describe('the sell screen (sellableOnTill): what this point of sale does not sell', () => {
  it('`shopListed: false` hides it, whatever `inStock` says', () => {
    expect(sellableOnTill({ id: 'p', shopListed: false, inStock: false }, 'all')).toBe(false);
    expect(sellableOnTill({ id: 'p', shopListed: false, inStock: true }, 'all')).toBe(false);
    expect(sellableOnTill({ id: 'p', shopListed: false }, 'selected')).toBe(false);
  });

  it('listed, or an older cloud that sends no `shopListed`: on it; the new optional fields change nothing', () => {
    expect(sellableOnTill({ id: 'p', shopListed: true }, 'all')).toBe(true);
    expect(sellableOnTill({ id: 'p' }, 'all')).toBe(true);
    expect(sellableOnTill({ id: 'p', shopListed: true, priceLevel: 'area', soldInAreas: [BAR] }, 'all')).toBe(true);
  });
});
