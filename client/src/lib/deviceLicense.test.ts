/**
 * Run with `npm test`. "סוג רישיון למכשיר" (lib/deviceLicense.ts, pos-server app/services/device_license.py):
 * the shared golden fixture's rules and the dashboard's Hebrew labels.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  LICENSE_DEFAULTS,
  LICENSE_FITS,
  LICENSE_PRODUCTS,
  licenseChoiceForRoleChange,
  licenseCountRows,
  licenseFits,
  licenseOptionsFor,
  mayManageLicense,
  pairingLicenseOf,
  parseLicenseProduct,
  workModeAllowed,
  type LicenseCountsAnswer,
} from './deviceLicense';

const golden = JSON.parse(
  readFileSync(join(process.cwd(), '..', 'server', 'tests', 'fixtures', 'device_license_golden.json'), 'utf8'),
);

describe('device license — the golden rules', () => {
  it('products, defaults and which fit each role', () => {
    assert.deepEqual([...LICENSE_PRODUCTS], golden.products);
    assert.deepEqual(LICENSE_DEFAULTS, golden.defaults);
    assert.deepEqual({ till: [...LICENSE_FITS.till], kiosk: [...LICENSE_FITS.kiosk] }, golden.fits);
  });

  it('parses like the devices', () => {
    for (const c of golden.parse) assert.equal(parseLicenseProduct(c.raw), c.product, JSON.stringify(c));
  });

  it('the work mode exists only for kiosk_till (no product: the gate)', () => {
    for (const c of golden.workMode) assert.equal(workModeAllowed(c.product, c.gate), c.allowed, JSON.stringify(c));
  });

  it('the dashboard says the same labels', () => {
    const he = JSON.parse(readFileSync(join(process.cwd(), 'src', 'messages', 'he.json'), 'utf8'));
    for (const p of LICENSE_PRODUCTS) {
      assert.equal(he.machines.license.product[p], golden.labels[p]);
      assert.equal(he.machines.license.short[p], golden.shortLabels[p]);
    }
  });
});

describe('device license — the dialogs', () => {
  it('offers the products a role fits, none for a screen', () => {
    assert.deepEqual([...licenseOptionsFor('till')], ['till', 'kiosk_till']);
    assert.deepEqual([...licenseOptionsFor('kiosk')], ['kiosk', 'kiosk_till']);
    assert.deepEqual([...licenseOptionsFor('kds')], []);
    assert.deepEqual([...licenseOptionsFor('')], []);
  });

  it('fits, a disabled kiosk included', () => {
    assert.equal(licenseFits('kiosk', 'kiosk'), true);
    assert.equal(licenseFits('kiosk', 'kiosk', false), false);
    assert.equal(licenseFits('kiosk_till', 'kiosk', false), true);
    assert.equal(licenseFits('till', 'kiosk'), false);
    assert.equal(licenseFits(null, 'kds'), true);
  });

  it('the pairing choice: a fitting pick, else the default; nothing for a screen', () => {
    assert.equal(pairingLicenseOf('till', ''), 'till');
    assert.equal(pairingLicenseOf('till', 'kiosk_till'), 'kiosk_till');
    assert.equal(pairingLicenseOf('till', 'kiosk'), 'till');
    assert.equal(pairingLicenseOf('kiosk', 'till'), 'kiosk');
    assert.equal(pairingLicenseOf('kds', 'till'), null);
  });

  it('a role change asks for a license only when the stored one does not fit', () => {
    assert.deepEqual(licenseChoiceForRoleChange('till', 'kiosk'), ['kiosk', 'kiosk_till']);
    assert.deepEqual(licenseChoiceForRoleChange('kiosk', 'till'), ['till', 'kiosk_till']);
    assert.equal(licenseChoiceForRoleChange('kiosk_till', 'kiosk'), null);
    assert.equal(licenseChoiceForRoleChange(null, 'kiosk'), null);
  });

  it('only a super admin or a distributor', () => {
    assert.equal(mayManageLicense('super_admin'), true);
    assert.equal(mayManageLicense('distributor'), true);
    assert.equal(mayManageLicense('company_manager'), false);
    assert.equal(mayManageLicense(null), false);
  });
});

describe('device license — the count', () => {
  it('a tree in reading order', () => {
    const c = (till: number, kiosk: number, both: number) => ({ till, kiosk, kiosk_till: both, total: till + kiosk + both });
    const answer: LicenseCountsAnswer = {
      products: ['till', 'kiosk', 'kiosk_till'],
      labels: golden.labels,
      tenants: [{ id: 't', name: 'T', counts: c(2, 1, 1) }],
      companies: [{ id: 'c', name: 'Acme', tenantId: 't', counts: c(1, 1, 1) }],
      shops: [
        { id: 's1', name: 'Center', companyId: 'c', tenantId: 't', counts: c(1, 0, 1) },
        { id: 's2', name: 'North', companyId: 'c', tenantId: 't', counts: c(0, 1, 0) },
      ],
      unassigned: [{ tenantId: 't', counts: c(1, 0, 0) }],
    };
    assert.deepEqual(
      licenseCountRows(answer).map((r) => [r.level, r.name, r.counts.total]),
      [['tenant', 'T', 4], ['company', 'Acme', 3], ['shop', 'Center', 2], ['shop', 'North', 1], ['unassigned', null, 1]],
    );
    assert.deepEqual(licenseCountRows(null), []);
  });
});
