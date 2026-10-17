import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveServiceSize,
  serviceAttractButtons,
  serviceAutoLandscape,
  serviceNumberValue,
  serviceSettingsInForce,
  serviceSizeLook,
  serviceSizeName,
  validateServiceSize,
  type ServiceSizeNumberKey,
} from './kioskServiceSize';
import { validateLandscape } from './kioskLandscape';

/**
 * "גודל כרטיסי לקחת / לשבת" against the shared golden fixture (server/tests/fixtures/kiosk_service_size_golden.json —
 * the same bytes as kiosk-desktop's and pos-android's KioskServiceSizeTest): every rule, number for number.
 */

function fixture(): string {
  const name = 'kiosk_service_size_golden.json';
  const candidates = [join(process.cwd(), '..', 'server', 'tests', 'fixtures', name), join(__dirname, '..', '..', 'server', 'tests', 'fixtures', name)];
  const path = candidates.find((p) => existsSync(p));
  if (!path) throw new Error(`${name} not found`);
  return readFileSync(path, 'utf8');
}

const text = fixture();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const golden: any = JSON.parse(text);

test('the golden is the shared bytes', () => {
  assert.equal(createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex'), '8077021f835924a916e1256b1da9dc999449dfbf01d1cbabb7e75dfb7abe04d5');
});

test('every golden rule', () => {
  for (const c of golden.numberValue) assert.equal(serviceNumberValue(c.key as ServiceSizeNumberKey, c.raw), c.expect, JSON.stringify(c));
  for (const c of golden.sizeName) assert.equal(serviceSizeName(c.raw), c.expect);
  for (const c of golden.settingsInForce) assert.deepEqual(serviceSettingsInForce(c.general, c.landscapeBlock, c.landscape), c.expect, c.name);
  for (const c of golden.autoLandscape) assert.deepEqual(serviceAutoLandscape(c.heightDp), c.expect);
  for (const c of golden.resolve) assert.deepEqual(resolveServiceSize(c.general, c.landscapeBlock, c.display), c.expect, c.name);
  for (const c of golden.attractButtons) assert.deepEqual(serviceAttractButtons(c.boxWDp, c.boxHDp, c.measures), c.expect, c.name);
});

test('portrait with nothing set is today (no look); landscape always has one', () => {
  assert.equal(serviceSizeLook({ general: {} }, false, 1080, 1920, 1), null);
  const look = serviceSizeLook({ general: {} }, true, 1536, 864, 1);
  assert.deepEqual(look, { cssPerDp: 1, size: 'auto', cardMaxWidthPx: 319, cardHeightPx: 220, iconPx: 92 });
});

test('the editor validates both places', () => {
  assert.deepEqual(validateServiceSize({ serviceCardHeight: 99 }, 'general'), [{ path: 'general.serviceCardHeight', code: 'range', params: { min: 100, max: 400 } }]);
  assert.deepEqual(validateLandscape({ general: { serviceCardSize: 'small' } }, {}), []);
  assert.deepEqual(validateLandscape({ general: { serviceSelect: 'instant', serviceCardSize: 'xl' } }, {}), [
    { path: 'landscape.general.serviceSelect', code: 'unknownKey' },
    { path: 'landscape.general.serviceCardSize', code: 'enum' },
  ]);
});
