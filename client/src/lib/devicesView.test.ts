/**
 * Run with `npm test`. "מכשירים" (lib/devicesView.ts): what the one search box finds (a partial
 * serial, a model by its code, its Hebrew label or its maker in Hebrew), how the filters combine
 * and count, the "גרסה ישנה" rule, the sort, and the view's round trip through the URL and the
 * viewer's storage.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SORT,
  EMPTY_FILTERS,
  NONE,
  activeFilterCount,
  applyDeviceFilters,
  compareVersions,
  deviceLabelOf,
  effectiveFilters,
  flagsOf,
  hasActiveFilters,
  hasViewParams,
  matchesSearch,
  newestVersions,
  nextSort,
  parseAppVersion,
  parseStoredView,
  platformOf,
  roleOf,
  rowValues,
  searchTokens,
  serialOf,
  serializeStoredView,
  shortAppVersion,
  sortDevices,
  toggleFilterValue,
  versionStateOf,
  viewFromParams,
  viewToParams,
  type DeviceFilters,
  type DeviceViewContext,
  type DeviceViewRow,
} from './devicesView';

const SHOPS: Record<string, string> = { s1: 'תל אביב', s2: 'חיפה', s3: 'אילת' };
const ROLE: Record<string, string> = {
  till: 'קופה',
  kiosk: 'קיוסק',
  kds: 'מסך מטבח (KDS)',
  order_status_board: 'מסך מוכן / לא מוכן',
  customer_display: 'מסך לקוח',
};
const PLATFORM: Record<string, string> = { android: 'Android', windows: 'Windows', web: 'דפדפן (Web)' };
const MODEL: Record<string, string> = {
  N55F: 'Feitian F20 / Nova 55F',
  SUNMI_T2: 'סאנמי T2 (מדפסת מובנית)',
  P18: 'Kozen P18 (מסופון ברשת)',
};

const ctx: DeviceViewContext = {
  shopName: (id) => SHOPS[id],
  companyName: (id) => (id === 's3' ? 'דרום' : 'מרכז'),
  registerLabel: (n) => `קופה ${n}`,
  modelLabel: (m) => MODEL[m] ?? m,
  roleLabel: (r) => ROLE[r],
  platformLabel: (p) => PLATFORM[p],
};

function row(over: Partial<DeviceViewRow> & { id: string }): DeviceViewRow {
  return {
    name: over.id,
    machineCode: `CODE-${over.id}`,
    shopId: 's1',
    posNumber: null,
    status: 'online',
    platform: 'android',
    lastHeartbeatAt: '2026-10-13T08:00:00Z',
    ...over,
  };
}

const till1 = row({
  id: 'a',
  name: 'קופה ראשית',
  posNumber: '1',
  deviceModel: 'N55F',
  serialNumber: 'F2003183A700375',
  serialSource: 'ftpos',
  appVersion: '0.1.248+b6e07db-device',
  areaId: 'bar',
  areaName: 'מרפסת',
  lastIp: '31.168.1.2',
  lanIp: '192.168.0.207',
  cellular: { sims: [{ carrier: 'פרטנר', phoneNumber: '0547770001' }] },
});
const till2 = row({
  id: 'b',
  name: 'קופה 2',
  posNumber: '2',
  deviceModel: 'SUNMI_T2',
  serialNumber: 'T2-PB12-3456',
  serialSource: 'sunmi',
  appVersion: '0.1.240',
  status: 'offline',
});
const kiosk = row({
  id: 'c',
  name: 'קיוסק כניסה',
  deviceRole: 'kiosk',
  deviceModel: 'P18',
  serialNumber: 'P18X99',
  appVersion: '0.1.248',
  shopId: 's2',
  trainingMode: true,
});
const winTill = row({
  id: 'd',
  name: 'קופה חלון',
  posNumber: '3',
  platform: 'windows',
  appVersion: '0.4.2',
  shopId: 's2',
  remoteLocked: true,
});
const screen = row({ id: 'e', name: 'גריל', deviceRole: 'kds', fiscal: false, platform: 'web', shopId: 's1' });
const loose = row({
  id: 'f',
  name: 'Unassigned',
  shopId: null,
  status: 'not_paired',
  lastHeartbeatAt: null,
  serialNumber: null,
});
const ALL = [till1, till2, kiosk, winTill, screen, loose];

const ids = (rows: readonly DeviceViewRow[]) => rows.map((r) => r.id);
const found = (q: string) => ids(ALL.filter((r) => matchesSearch(r, q, ctx)));

describe('search', () => {
  it('finds a serial by any part of it, its last digits too, ignoring separators and case', () => {
    assert.deepEqual(found('F2003183A700375'), ['a']);
    assert.deepEqual(found('700375'), ['a']);
    assert.deepEqual(found('375'), ['a']);
    assert.deepEqual(found('pb123456'), ['b']);
    assert.deepEqual(found('PB12-34'), ['b']);
    assert.deepEqual(found('3456'), ['b']);
  });

  it('a one- or two-character word only starts a word: "2" is not every serial with a 2', () => {
    assert.deepEqual(found('קופה 2'), ['b']);
    assert.deepEqual(found('T2'), ['b']);
    assert.ok(!found('20').includes('a'));
  });

  it('finds a model by its code, its Hebrew label, its name on the box and its maker in Hebrew', () => {
    assert.deepEqual(found('SUNMI_T2'), ['b']);
    assert.deepEqual(found('sunmi t2'), ['b']);
    assert.deepEqual(found('סאנמי'), ['b']);
    assert.deepEqual(found('Feitian'), ['a']);
    assert.deepEqual(found('פייטיאן'), ['a']);
    assert.deepEqual(found('nova 55f'), ['a']);
    assert.deepEqual(found('Nebullar'), ['c']);
  });

  it('finds the name, the register label, the shop, its company, the area, the role and the platform', () => {
    assert.deepEqual(found('ראשית'), ['a']);
    assert.deepEqual(found('קופה 1'), ['a']);
    assert.deepEqual(found('חיפה'), ['c', 'd']);
    assert.deepEqual(found('דרום'), []);
    assert.deepEqual(found('מרכז קיוסק'), ['c']);
    assert.deepEqual(found('מרפסת'), ['a']);
    assert.deepEqual(found('windows'), ['d']);
    assert.deepEqual(found('מסך מטבח'), ['e']);
  });

  it('is Hebrew-friendly: final letters, niqqud and geresh do not matter', () => {
    // "כניסה" typed with a final kaf as the word's prefix, and with niqqud.
    assert.deepEqual(found('קִיוֹסְק'), ['c']);
    assert.deepEqual(found('מסך'), ['e']);
    assert.deepEqual(searchTokens('  Sunmi   T2 '), ['sunmi', 't2']);
  });

  it('finds the addresses, the SIM carrier and phone, the device code and the version', () => {
    assert.deepEqual(found('192.168.0.207'), ['a']);
    assert.deepEqual(found('31.168'), ['a']);
    assert.deepEqual(found('פרטנר'), ['a']);
    assert.deepEqual(found('054-777'), ['a']);
    assert.deepEqual(found('code-f'), ['f']);
    assert.deepEqual(found('0.4.2'), ['d']);
  });

  it('every word must be found; an empty query finds everything', () => {
    assert.deepEqual(found('סאנמי חיפה'), []);
    assert.deepEqual(found('   '), ids(ALL));
  });
});

describe('row values', () => {
  it('reads the role and the platform the way the badges do', () => {
    assert.equal(roleOf({ deviceRole: null }), 'till');
    assert.equal(roleOf({ deviceRole: 'kiosk' }), 'kiosk');
    assert.equal(roleOf({ deviceRole: null, fiscal: false }), 'kds');
    assert.equal(roleOf({ deviceRole: 'customer_display' }), 'customer_display');
    assert.equal(platformOf({ platform: null }), 'android');
    assert.equal(platformOf({ platform: 'web' }), 'web');
  });

  it('the serial with its source, or nothing ("לא דווח")', () => {
    assert.deepEqual(serialOf(till1), { serial: 'F2003183A700375', source: 'Feitian SDK' });
    assert.deepEqual(serialOf(till2), { serial: 'T2-PB12-3456', source: 'SUNMI' });
    assert.deepEqual(serialOf({ serialNumber: 'X1', serialSource: null }), { serial: 'X1', source: null });
    assert.equal(serialOf({ serialNumber: '  ' }), null);
    assert.equal(serialOf(loose), null);
  });

  it('the flags: never seen, training, locked, a shop switched off (only with a shop)', () => {
    assert.deepEqual(flagsOf(loose), ['neverSeen']);
    assert.deepEqual(flagsOf(kiosk), ['training']);
    assert.deepEqual(flagsOf(winTill), ['locked']);
    assert.deepEqual(flagsOf(row({ id: 'x', shopActive: false })), ['inactiveShop']);
    assert.deepEqual(flagsOf(row({ id: 'y', shopId: null, shopActive: false })), []);
  });

  it('the label: "קופה N" with a register number, else the name', () => {
    assert.equal(deviceLabelOf(till2, ctx), 'קופה 2');
    assert.equal(deviceLabelOf(kiosk, ctx), 'קיוסק כניסה');
  });
});

describe('the app version', () => {
  it('parses and compares part by part, the build ignored', () => {
    assert.deepEqual(parseAppVersion('0.1.248+b6e07db-device'), [0, 1, 248]);
    assert.deepEqual(parseAppVersion('v1.2'), [1, 2]);
    assert.equal(parseAppVersion('dev'), null);
    assert.equal(parseAppVersion(null), null);
    assert.equal(shortAppVersion('0.1.248+b6e07db'), '0.1.248');
    assert.equal(shortAppVersion(''), null);
    assert.ok(compareVersions([0, 1, 248], [0, 1, 240]) > 0);
    assert.ok(compareVersions([0, 1, 9], [0, 1, 10]) < 0);
    assert.equal(compareVersions([1, 2], [1, 2, 0]), 0);
  });

  it('"old" is below the newest in view on its own platform; never said is unknown', () => {
    const newest = newestVersions(ALL);
    assert.deepEqual(newest.get('android'), [0, 1, 248]);
    assert.deepEqual(newest.get('windows'), [0, 4, 2]);
    assert.equal(versionStateOf(till1, newest), 'current');
    assert.equal(versionStateOf(till2, newest), 'old');
    assert.equal(versionStateOf(kiosk, newest), 'current');
    // The Windows app's 0.4.2 never makes an Android 0.1.248 old, nor the other way round.
    assert.equal(versionStateOf(winTill, newest), 'current');
    assert.equal(versionStateOf(screen, newest), 'unknown');
  });
});

describe('filters', () => {
  const run = (f: Partial<DeviceFilters>) => applyDeviceFilters(ALL, { ...EMPTY_FILTERS, ...f }, ctx);

  it('any value within a filter, all the filters together, with the search', () => {
    assert.deepEqual(ids(run({ status: ['offline', 'not_paired'] }).rows), ['b', 'f']);
    assert.deepEqual(ids(run({ role: ['till'], platform: ['android'] }).rows), ['a', 'b', 'f']);
    assert.deepEqual(ids(run({ role: ['till'], platform: ['android'], version: ['old'] }).rows), ['b']);
    assert.deepEqual(ids(run({ model: ['SUNMI_T2', 'P18'] }).rows), ['b', 'c']);
    assert.deepEqual(ids(run({ model: [NONE] }).rows), ['d', 'e', 'f']);
    assert.deepEqual(ids(run({ area: ['bar'] }).rows), ['a']);
    assert.deepEqual(ids(run({ area: [NONE], shop: ['s2'] }).rows), ['c', 'd']);
    assert.deepEqual(ids(run({ shop: [NONE] }).rows), ['f']);
    assert.deepEqual(ids(run({ flag: ['training', 'locked'] }).rows), ['c', 'd']);
    assert.deepEqual(ids(run({ q: 'קופה', status: ['online'] }).rows), ['a', 'd']);
  });

  it('counts a filter over what the search and the other filters leave, never its own choice', () => {
    const r = run({ status: ['online'], platform: ['android'] });
    // Status counts: android rows of every status.
    assert.equal(r.counts.status.get('online'), 2);
    assert.equal(r.counts.status.get('offline'), 1);
    assert.equal(r.counts.status.get('not_paired'), 1);
    // Platform counts: online rows of every platform.
    assert.equal(r.counts.platform.get('android'), 2);
    assert.equal(r.counts.platform.get('windows'), 1);
    assert.equal(r.counts.platform.get('web'), 1);
    // Role counts under both filters.
    assert.equal(r.counts.role.get('till'), 1);
    assert.equal(r.counts.role.get('kiosk'), 1);
    assert.equal(r.counts.role.get('kds'), undefined);
    assert.deepEqual(ids(r.rows), ['a', 'c']);
  });

  it('a value no row could have (another scope\'s area, an unknown status) is dropped, a known one stays', () => {
    const f = { ...EMPTY_FILTERS, area: ['elsewhere', 'bar'], status: ['bogus', 'retired'], shop: ['zz'] };
    const eff = effectiveFilters(f, ALL);
    assert.deepEqual(eff.area, ['bar']);
    assert.deepEqual(eff.status, ['retired']);
    assert.deepEqual(eff.shop, []);
    assert.deepEqual(ids(applyDeviceFilters(ALL, f, ctx).rows), []);
    assert.deepEqual(ids(applyDeviceFilters(ALL, { ...EMPTY_FILTERS, shop: ['zz'] }, ctx).rows), ids(ALL));
  });

  it('toggles a value, counts the filters on, and knows when anything is set', () => {
    let f = toggleFilterValue(EMPTY_FILTERS, 'role', 'kiosk');
    assert.deepEqual(f.role, ['kiosk']);
    f = toggleFilterValue(f, 'platform', 'web');
    assert.equal(activeFilterCount(f), 2);
    f = toggleFilterValue(f, 'role', 'kiosk');
    assert.deepEqual(f.role, []);
    assert.equal(activeFilterCount(f), 1);
    assert.equal(hasActiveFilters(EMPTY_FILTERS), false);
    assert.equal(hasActiveFilters({ ...EMPTY_FILTERS, q: ' x ' }), true);
    assert.deepEqual(EMPTY_FILTERS.role, []);
  });

  it('offers the models, areas and shops of the rows in view', () => {
    assert.deepEqual(rowValues(ALL, 'model').sort(), ['N55F', 'P18', 'SUNMI_T2', NONE].sort());
    assert.deepEqual(rowValues(ALL, 'area').sort(), ['bar', NONE].sort());
    assert.deepEqual(rowValues(ALL, 'shop').sort(), ['s1', 's2', NONE].sort());
  });
});

describe('sort', () => {
  it('by default: company and shop, tills by register number then the screens, no shop last', () => {
    // מרכז ▸ חיפה, then מרכז ▸ תל אביב; the screen after the tills; no shop last.
    assert.deepEqual(ids(sortDevices(ALL, DEFAULT_SORT, ctx)), ['d', 'c', 'a', 'b', 'e', 'f']);
    assert.deepEqual(ids(sortDevices(ALL, { key: 'shop', dir: 'desc' }, ctx)), ['a', 'b', 'e', 'd', 'c', 'f']);
  });

  it('a row without the value goes last either way', () => {
    assert.deepEqual(ids(sortDevices(ALL, { key: 'serial', dir: 'asc' }, ctx)), ['a', 'c', 'b', 'd', 'e', 'f']);
    assert.deepEqual(ids(sortDevices(ALL, { key: 'serial', dir: 'desc' }, ctx)), ['b', 'c', 'a', 'd', 'e', 'f']);
    assert.deepEqual(ids(sortDevices(ALL, { key: 'model', dir: 'asc' }, ctx)).slice(-3), ['d', 'e', 'f']);
  });

  it('by version numerically, by name with numbers in order, by status attention first', () => {
    const v = ids(sortDevices(ALL, { key: 'version', dir: 'asc' }, ctx));
    assert.deepEqual(v.slice(0, 4), ['b', 'c', 'a', 'd']);
    const names = sortDevices(
      [row({ id: 'x10', name: 'קופה 10' }), row({ id: 'x9', name: 'קופה 9' })],
      { key: 'name', dir: 'asc' },
      ctx,
    );
    assert.deepEqual(ids(names), ['x9', 'x10']);
    assert.deepEqual(ids(sortDevices(ALL, { key: 'status', dir: 'asc' }, ctx)).slice(0, 1), ['b']);
  });

  it('last seen: never seen is the stalest', () => {
    const rows = [
      row({ id: 'new', lastHeartbeatAt: '2026-10-13T09:00:00Z' }),
      row({ id: 'never', lastHeartbeatAt: null }),
      row({ id: 'old', lastHeartbeatAt: '2026-10-01T09:00:00Z' }),
    ];
    assert.deepEqual(ids(sortDevices(rows, { key: 'lastSeen', dir: 'asc' }, ctx)), ['never', 'old', 'new']);
    assert.deepEqual(ids(sortDevices(rows, { key: 'lastSeen', dir: 'desc' }, ctx)), ['new', 'old', 'never']);
  });

  it('a header click flips its own column and starts another ascending', () => {
    assert.deepEqual(nextSort(DEFAULT_SORT, 'shop'), { key: 'shop', dir: 'desc' });
    assert.deepEqual(nextSort({ key: 'shop', dir: 'desc' }, 'serial'), { key: 'serial', dir: 'asc' });
  });
});

describe('URL and storage', () => {
  const filters: DeviceFilters = {
    ...EMPTY_FILTERS,
    q: 'סאנמי T2',
    status: ['offline', 'online'],
    role: ['kiosk'],
    model: ['SUNMI_T2'],
    version: ['old'],
    area: [NONE],
    shop: ['8b6f2a1e-1111-4c2d-9e0f-123456789abc'],
    flag: ['locked'],
  };

  it('round-trips the filters and the sort, keeping the scope\'s own keys', () => {
    const search = viewToParams('company=c1&shop=s1', filters, { key: 'lastSeen', dir: 'desc' });
    const params = new URLSearchParams(search);
    assert.equal(params.get('company'), 'c1');
    assert.equal(params.get('shop'), 's1');
    assert.equal(params.get('shops'), '8b6f2a1e-1111-4c2d-9e0f-123456789abc');
    assert.equal(params.get('status'), 'offline,online');
    assert.equal(params.get('sort'), '-lastSeen');
    const back = viewFromParams(search);
    assert.deepEqual(back.filters, filters);
    assert.deepEqual(back.sort, { key: 'lastSeen', dir: 'desc' });
    assert.ok(hasViewParams(search));
  });

  it('writes nothing for the defaults, and clears its own keys only', () => {
    assert.equal(viewToParams('machine=m1&q=old&ver=old&sort=serial', EMPTY_FILTERS, DEFAULT_SORT), 'machine=m1');
    assert.equal(hasViewParams('company=c1&shop=s1'), false);
    assert.deepEqual(viewFromParams(''), { filters: EMPTY_FILTERS, sort: DEFAULT_SORT });
  });

  it('ignores junk: an unknown sort, values that are not ids, repeats', () => {
    const v = viewFromParams('sort=-nope&role=kiosk,kiosk,,<script>&model=a b');
    assert.deepEqual(v.sort, DEFAULT_SORT);
    assert.deepEqual(v.filters.role, ['kiosk']);
    assert.deepEqual(v.filters.model, []);
  });

  it('the viewer\'s remembered view: filters, sort and layout, defaults for anything unreadable', () => {
    const raw = serializeStoredView({ filters, sort: { key: 'serial', dir: 'asc' }, layout: 'cards' });
    const back = parseStoredView(raw);
    assert.deepEqual(back.filters, filters);
    assert.deepEqual(back.sort, { key: 'serial', dir: 'asc' });
    assert.equal(back.layout, 'cards');
    assert.deepEqual(parseStoredView('{nope'), { filters: EMPTY_FILTERS, sort: DEFAULT_SORT, layout: 'table' });
    assert.deepEqual(parseStoredView(null), { filters: EMPTY_FILTERS, sort: DEFAULT_SORT, layout: 'table' });
  });
});
