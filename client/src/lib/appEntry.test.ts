/**
 * Run with `npm test`. `/app` — the single web entry (lib/appEntry.ts, web-till spec v2 §6.1): the
 * aliases, the pairing link, which credentials it runs on (its own, or an older page's on this
 * site — never a second pairing), and the screen for the cloud's role.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  APP_ALIASES,
  APP_STORE,
  LEGACY_STORES,
  ROLE_LABELS,
  appHref,
  entryOf,
  livePageOf,
  planCredentials,
  screenFor,
} from './appEntry';
import type { KioskCredentials } from './kioskWebApi';
import { KV } from './kioskWebStore';
import { screenKeys, screenStoreOptions } from './screenWebService';

function creds(machineId: string, pairedAt: string, extra: Partial<KioskCredentials> = {}): KioskCredentials {
  return {
    serverUrl: 'https://api.example.test/api/v1',
    accessToken: `token-${machineId}`,
    machineId,
    machineCode: null,
    tenantId: 't1',
    shopId: 's1',
    pairedAt,
    ...extra,
  };
}

describe('the address', () => {
  it('maps the aliases to the role they pair for', () => {
    assert.deepEqual(entryOf('/t', ''), { route: 't', alias: 'till', pairCode: null });
    assert.deepEqual(entryOf('/k/', ''), { route: 'k', alias: 'kiosk', pairCode: null });
    assert.deepEqual(entryOf('/KDS', ''), { route: 'kds', alias: 'kds', pairCode: null });
    assert.deepEqual(entryOf('/board', ''), { route: 'board', alias: 'board', pairCode: null });
    assert.deepEqual(entryOf('/app', ''), { route: 'app', alias: null, pairCode: null });
    assert.deepEqual(entryOf('/app', '', '?as=order_status_board'), { route: 'app', alias: 'board', pairCode: null });
    assert.deepEqual(entryOf('/app', '', '?as=printer'), { route: 'app', alias: null, pairCode: null });
    // Anything else is /app; `toString` is not an alias.
    assert.equal(entryOf('/toString', '').route, 'app');
    assert.equal(entryOf('', '').route, 'app');
    assert.deepEqual(Object.keys(APP_ALIASES), ['app', 't', 'k', 'kds', 'board']);
  });

  it('reads the pairing code after the #', () => {
    assert.equal(entryOf('/t', '#pair=ab12-cd34').pairCode, 'AB12CD34');
    assert.equal(entryOf('/app', '#pair=AB12%20CD34&x=1').pairCode, 'AB12CD34');
    assert.equal(entryOf('/app', '#pair=ab1').pairCode, null); // too short to be a code
    assert.equal(entryOf('/app', '#other=1').pairCode, null);
  });

  it('makes /app links that keep the code out of the query', () => {
    assert.equal(appHref(null), '/app');
    assert.equal(appHref('till', 'AB12CD34'), '/app?as=till#pair=AB12CD34');
    assert.equal(entryOf('/app', '#pair=AB12CD34', '?as=till').alias, 'till');
  });
});

describe('the credentials', () => {
  const kiosk = creds('m-kiosk', '2026-10-01T10:00:00.000Z');
  const kds = creds('m-kds', '2026-10-05T10:00:00.000Z');
  const board = creds('m-board', '2026-10-03T10:00:00.000Z');

  it('names the stores the older pages really use', () => {
    assert.deepEqual(LEGACY_STORES.find((s) => s.route === 'k'), { route: 'k', role: 'kiosk', dbName: 'r2m-kiosk', key: KV.credentials });
    for (const route of ['kds', 'board'] as const) {
      const s = LEGACY_STORES.find((x) => x.route === route)!;
      assert.equal(s.key, screenKeys(route).credentials);
      assert.equal(s.dbName, screenStoreOptions(route).dbName);
    }
    assert.equal(APP_STORE.dbName, 'r2m-app');
    assert.ok(!LEGACY_STORES.some((s) => s.dbName === APP_STORE.dbName || s.key === APP_STORE.credentials));
  });

  it('runs on its own when it has them', () => {
    const own = creds('m-app', '2026-10-09T10:00:00.000Z');
    assert.deepEqual(planCredentials(own, [{ route: 'k', credentials: kiosk }], 'kiosk'), { use: 'own', credentials: own });
  });

  it('takes an older page`s instead of pairing again — the alias`s own first', () => {
    const found = [
      { route: 'k' as const, credentials: kiosk },
      { route: 'kds' as const, credentials: kds },
      { route: 'board' as const, credentials: board },
    ];
    assert.deepEqual(planCredentials(null, found, 'kiosk'), { use: 'import', from: 'k', credentials: kiosk, others: ['kds', 'board'] });
    assert.deepEqual(planCredentials(null, found, 'board'), { use: 'import', from: 'board', credentials: board, others: ['kds', 'k'] });
    // No alias (or the till's, which has no older page): the newest pairing.
    assert.deepEqual(planCredentials(null, found, null), { use: 'import', from: 'kds', credentials: kds, others: ['board', 'k'] });
    assert.equal((planCredentials(null, found, 'till') as { from: string }).from, 'kds');
  });

  it('pairs when nothing usable is there', () => {
    assert.deepEqual(planCredentials(null, [], 'till'), { use: 'pair', alias: 'till' });
    const broken = creds('m', 'x', { accessToken: '' });
    assert.deepEqual(planCredentials({ ...broken }, [{ route: 'k', credentials: broken }], null), { use: 'pair', alias: null });
    // A pairing date that does not parse sorts last, never throws.
    const odd = creds('m-odd', 'not a date');
    assert.equal((planCredentials(null, [{ route: 'k', credentials: odd }, { route: 'kds', credentials: kds }], null) as { from: string }).from, 'kds');
  });
});

describe('the screen', () => {
  it('pairs, waits for the cloud, then shows the cloud`s role whatever the alias', () => {
    assert.deepEqual(screenFor({ paired: false, alias: 'till', deviceRole: 'kds' }), { kind: 'pair', alias: 'till' });
    assert.deepEqual(screenFor({ paired: true, alias: 'till', deviceRole: null }), { kind: 'waiting' });
    assert.deepEqual(screenFor({ paired: true, alias: 'till', deviceRole: 'order_status_board', fiscal: false }), { kind: 'role', role: 'board', fiscal: false });
    assert.deepEqual(screenFor({ paired: true, alias: null, deviceRole: 'till', fiscal: true }), { kind: 'role', role: 'till', fiscal: true });
    // A kiosk shown in till mode (lib/deviceMode.ts) is the till screen.
    assert.deepEqual(screenFor({ paired: true, alias: 'kiosk', deviceRole: 'kiosk', mode: 'till' }), { kind: 'role', role: 'till', fiscal: true });
    // A till the cloud says is not fiscal is not shown as fiscal.
    assert.deepEqual(screenFor({ paired: true, alias: null, deviceRole: 'till', fiscal: false }), { kind: 'role', role: 'till', fiscal: false });
  });

  it('knows the live page of each role until the bundle serves it', () => {
    assert.deepEqual(
      (['till', 'kiosk', 'kds', 'board', 'display'] as const).map((r) => [livePageOf(r), ROLE_LABELS[r]]),
      [[null, 'קופה'], ['/k', 'קיוסק'], ['/kds', 'מסך מטבח (KDS)'], ['/board', 'מסך מוכן / לא מוכן'], [null, 'מסך לקוח']],
    );
  });
});
