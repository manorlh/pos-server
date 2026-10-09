/**
 * Run with `npm test`. "חיפוש מכשיר" (lib/deviceSearch.ts): the query a search sends, the page
 * it reads back, and how a row's SIMs and serial read.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEVICE_SEARCH_PAGE_SIZE,
  EMPTY_DEVICE_SEARCH,
  deviceSearchParams,
  hasDeviceFilters,
  pageCount,
  parseDeviceSearchPage,
  phonesOf,
  serialSourceLabel,
  simSummary,
} from './deviceSearch';

describe('deviceSearchParams', () => {
  it('sends only the filters set, trimmed, with the page', () => {
    const p = deviceSearchParams(
      { ...EMPTY_DEVICE_SEARCH, serial: ' K7Z24 ', carrier: 'סלקום', role: 'kiosk', lastSeen: '24h', phone: '054-1234567' },
      2,
    );
    assert.deepEqual(p, {
      serial: 'K7Z24',
      carrier: 'סלקום',
      role: 'kiosk',
      lastSeen: '24h',
      phone: '054-1234567',
      skip: 2 * DEVICE_SEARCH_PAGE_SIZE,
      limit: DEVICE_SEARCH_PAGE_SIZE,
    });
  });

  it('includes the inactive only when asked, and clamps the page size', () => {
    assert.equal(deviceSearchParams(EMPTY_DEVICE_SEARCH, 0).includeInactive, undefined);
    assert.equal(deviceSearchParams({ ...EMPTY_DEVICE_SEARCH, includeInactive: true }, 0).includeInactive, true);
    assert.equal(deviceSearchParams(EMPTY_DEVICE_SEARCH, -1, 500).limit, 100);
    assert.equal(deviceSearchParams(EMPTY_DEVICE_SEARCH, -1, 500).skip, 0);
  });

  it('knows an empty search', () => {
    assert.equal(hasDeviceFilters(EMPTY_DEVICE_SEARCH), false);
    assert.equal(hasDeviceFilters({ ...EMPTY_DEVICE_SEARCH, ip: '  ' }), false);
    assert.equal(hasDeviceFilters({ ...EMPTY_DEVICE_SEARCH, posNumber: '2' }), true);
    assert.equal(hasDeviceFilters({ ...EMPTY_DEVICE_SEARCH, includeInactive: true }), true);
  });
});

describe('parseDeviceSearchPage', () => {
  it('reads the server page and drops what it cannot read', () => {
    const page = parseDeviceSearchPage({
      total: 3,
      skip: 0,
      limit: 25,
      items: [
        {
          id: 'm1', name: 'קופה 1', machineCode: 'M-1', posNumber: '1', shopName: 'הרצליה', companyName: 'רויאל',
          tenantName: 'R2M', deviceModel: 'P18', deviceRole: 'kiosk', appVersion: '0.1.207', online: true,
          serialNumber: 'K7Z2412260010', serialSource: 'ro.serialno', lastIp: '31.168.1.2', lanIp: '192.168.0.207',
          sims: [{ slot: 2, carrier: 'סלקום', networkType: '5G' }, { slot: 1, carrier: 'פרטנר', networkType: '4G', defaultData: true, phoneNumber: '0541234567' }, { carrier: 'x' }],
          viaCellular: true,
        },
        { name: 'no id' },
        'junk',
      ],
    });
    assert.equal(page.total, 3);
    assert.equal(page.items.length, 1);
    const row = page.items[0];
    assert.equal(row.deviceRole, 'kiosk');
    assert.equal(row.isActive, true);
    assert.equal(row.sims.length, 2);
    assert.equal(row.tenantId, null);
    assert.equal(simSummary(row.sims), 'סים 1: פרטנר 4G (נתונים) · סים 2: סלקום 5G');
    assert.deepEqual(phonesOf(row.sims), ['0541234567']);
  });

  it('survives an answer that is not a page', () => {
    assert.deepEqual(parseDeviceSearchPage(null), { items: [], total: 0, skip: 0, limit: DEVICE_SEARCH_PAGE_SIZE });
    assert.equal(parseDeviceSearchPage({ items: [{ id: 'a', deviceRole: 'printer' }] }).items[0].deviceRole, 'till');
  });
});

describe('labels and pages', () => {
  it('names the serial sources', () => {
    assert.equal(serialSourceLabel('ftpos'), 'Feitian SDK');
    assert.equal(serialSourceLabel('ro.serialno'), 'ro.serialno');
    assert.equal(serialSourceLabel('build'), 'Android');
    assert.equal(serialSourceLabel(null), null);
  });

  it('a SIM with nothing known still reads', () => {
    assert.equal(simSummary([{ slot: 1 }]), 'סים 1: לא ידוע');
    assert.equal(simSummary([]), '');
  });

  it('counts pages', () => {
    assert.equal(pageCount(0), 1);
    assert.equal(pageCount(25, 25), 1);
    assert.equal(pageCount(26, 25), 2);
  });
});
