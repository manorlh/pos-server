/**
 * "סוג רישיון למכשיר" on the Windows device (src/core/deviceLicense.ts; P:\specs\device-license-type.md §7): the shared
 * golden fixture (the same bytes as pos-server's and the Android app's, SHA-256 pinned), the work mode's gate and
 * refusal by the license, and what the device keeps of the cloud's word.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  LICENSE_LABELS,
  LICENSE_PRODUCTS,
  LICENSE_ROLE_LABELS,
  LICENSE_SHORT_LABELS,
  LICENSE_TEXT,
  licenseFacts,
  licenseMismatch,
  parseLicenseProduct,
  saidLicense,
  workModeAllowed,
} from '../src/core/deviceLicense';
import { KIOSK_AT_REST, QUIET_TILL, closedRefusal, mayEnter, paramsOf, remote } from '../src/core/workMode';
import { CloudStore } from '../src/main/sync/cloud';

const RAW = readFileSync(join(__dirname, 'fixtures', 'device_license_golden.json'));
const GOLDEN = JSON.parse(RAW.toString('utf8'));
/** LF SHA-256 — the same in pos-server server/tests/test_device_license.py and the Android DeviceLicenseTest. */
const GOLDEN_SHA256 = 'e509efe1b2ebe7007a5d0605aca75b75f6d33963e8c9869bca97e73ce27db70d';

describe('the shared golden fixture', () => {
  it('is pinned', () => {
    const lf = RAW.toString('utf8').replace(/\r\n/g, '\n');
    expect(createHash('sha256').update(lf, 'utf8').digest('hex')).toBe(GOLDEN_SHA256);
  });

  it('products, labels and texts word for word', () => {
    expect([...LICENSE_PRODUCTS]).toEqual(GOLDEN.products);
    expect(LICENSE_LABELS).toEqual(GOLDEN.labels);
    expect(LICENSE_SHORT_LABELS).toEqual(GOLDEN.shortLabels);
    expect(LICENSE_ROLE_LABELS).toEqual(GOLDEN.roleLabels);
    expect(LICENSE_TEXT).toEqual(GOLDEN.texts);
  });

  it('parse, the work mode and the mismatch — every case', () => {
    for (const c of GOLDEN.parse) expect(parseLicenseProduct(c.raw), JSON.stringify(c)).toBe(c.product);
    for (const c of GOLDEN.workMode) expect(workModeAllowed(c.product, c.gate), JSON.stringify(c)).toBe(c.allowed);
    for (const c of GOLDEN.mismatch) expect(licenseMismatch(c.product, c.role), JSON.stringify(c)).toBe(c.mismatch);
  });

  it('the work mode through the parameters: the same answers', () => {
    for (const c of GOLDEN.workMode) {
      expect(paramsOf({ kioskTillModeEnabled: c.gate }, c.product).enabled, JSON.stringify(c)).toBe(c.allowed);
    }
  });
});

describe('the work mode closed by the license', () => {
  it('the refusal names the license; without one it is the gate’s', () => {
    const kioskOnly = paramsOf({ kioskTillModeEnabled: true }, 'kiosk');
    expect(mayEnter(kioskOnly, KIOSK_AT_REST)).toEqual({ wire: 'license', text: 'סוג הרישיון של המכשיר (קיוסק בלבד) אינו כולל מעבר בין קיוסק לקופה' });
    expect(closedRefusal(paramsOf({}, 'till')).text).toContain('קופה בלבד');
    expect(mayEnter(paramsOf({ kioskTillModeEnabled: false }), KIOSK_AT_REST)?.wire).toBe('disabled');
    expect(mayEnter(paramsOf({ kioskTillModeEnabled: false }, 'kiosk_till'), KIOSK_AT_REST)).toBeNull();
  });

  it('the dashboard’s command: answered with the license’s refusal, nothing moves', () => {
    const out = remote({ id: 'c1', mode: 'till', by: null }, 'kiosk', paramsOf({ kioskTillModeEnabled: true }, 'till'), KIOSK_AT_REST, QUIET_TILL);
    expect(out).toMatchObject({ run: false, done: true, blocked: { wire: 'license' } });
  });
});

describe('what the device says of it', () => {
  it('after the pairing and on the info screens', () => {
    expect(licenseFacts('kiosk', 'kiosk')).toEqual({
      product: 'kiosk',
      label: 'קיוסק בלבד',
      info: 'סוג רישיון: קיוסק בלבד',
      paired: 'המכשיר הוגדר: קיוסק · סוג רישיון: קיוסק בלבד',
      warning: null,
    });
    expect(licenseFacts('kiosk', 'till').warning).toBe('סוג הרישיון (קיוסק בלבד) לא תואם את תפקיד המכשיר (קופה) — פנו למפיץ');
    expect(licenseFacts(null, 'till')).toEqual({ product: null, label: null, info: null, paired: null, warning: null });
    expect(licenseFacts('till', 'kds').paired).toBeNull();
  });

  it('an answer that says nothing changes nothing', () => {
    expect(saidLicense({ licenseProduct: 'kiosk_till' })).toEqual({ said: true, product: 'kiosk_till' });
    expect(saidLicense({ licenseProduct: null })).toEqual({ said: true, product: null });
    expect(saidLicense({ zMode: 'cloud' })).toEqual({ said: false, product: null });
    expect(saidLicense(null)).toEqual({ said: false, product: null });
  });
});

class MemKv {
  private readonly m = new Map<string, string>();
  get(k: string) {
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  set(k: string, v: string) {
    this.m.set(k, v);
  }
  delete(k: string) {
    this.m.delete(k);
  }
  getJson<T>(k: string): T | null {
    const v = this.get(k);
    return v === null ? null : (JSON.parse(v) as T);
  }
  setJson(k: string, v: unknown) {
    this.set(k, JSON.stringify(v));
  }
  getNumber(k: string): number | null {
    const v = this.get(k);
    return v === null ? null : Number(v);
  }
  setNumber(k: string, n: number) {
    this.set(k, String(n));
  }
}

describe('the cloud store keeps the last word', () => {
  it('from any answer that says it; kept with no network; forgotten on unpairing', () => {
    const kv = new MemKv();
    const cloud = new CloudStore(kv as never);
    expect(cloud.licenseProduct()).toBeNull();
    expect(cloud.noteLicense({ zMode: 'cloud' })).toBe(false);
    expect(cloud.noteLicense({ licenseProduct: 'kiosk' })).toBe(true);
    expect(cloud.noteLicense({ licenseProduct: 'kiosk' })).toBe(false);
    expect(new CloudStore(kv as never).licenseProduct()).toBe('kiosk');
    expect(cloud.noteLicense({ licenseProduct: 'kiosk_till' })).toBe(true);
    expect(cloud.licenseProduct()).toBe('kiosk_till');
    cloud.forget();
    expect(new CloudStore(kv as never).licenseProduct()).toBeNull();
  });
});
