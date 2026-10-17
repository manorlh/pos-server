/**
 * "גודל כרטיסי לקחת / לשבת" on the Windows kiosk (P:/specs/kiosk-service-size.md): the shared rule it draws with
 * (client/src/lib/kioskServiceSize.ts through @dash-lib) against its own copy of the golden fixture — the same bytes
 * as pos-server's and pos-android's (SHA pinned in all three) — and the measures at its page zoom.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  resolveServiceSize,
  SERVICE_CARD_SIZES,
  SERVICE_SIZE_CONSTANTS,
  SERVICE_SIZE_KEYS,
  SERVICE_SIZE_NUMBER_SPECS,
  SERVICE_SIZE_PRESETS,
  serviceAttractButtons,
  serviceAutoLandscape,
  serviceNumberValue,
  serviceSettingsInForce,
  serviceSizeLook,
  serviceSizeName,
  validateServiceSize,
} from '@dash-lib/kioskServiceSize';
import { kioskWindowZoom } from '../src/core/windowZoom';

const text = readFileSync(path.join(__dirname, 'fixtures', 'kiosk_service_size_golden.json'), 'utf8');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const golden: any = JSON.parse(text);

describe('kiosk service card size — the shared golden', () => {
  it("is the same bytes as the server's and the till's", () => {
    expect(createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex')).toBe(
      '8077021f835924a916e1256b1da9dc999449dfbf01d1cbabb7e75dfb7abe04d5',
    );
  });

  it('the vocabulary, the ranges, the presets and the constants', () => {
    expect(golden.sizes).toEqual([...SERVICE_CARD_SIZES]);
    expect(golden.keys).toEqual([...SERVICE_SIZE_KEYS]);
    expect(golden.numbers).toEqual(SERVICE_SIZE_NUMBER_SPECS);
    expect(golden.presets).toEqual(SERVICE_SIZE_PRESETS);
    expect(golden.constants).toEqual(SERVICE_SIZE_CONSTANTS);
  });

  it('every rule', () => {
    for (const c of golden.numberValue) expect(serviceNumberValue(c.key, c.raw), JSON.stringify(c)).toBe(c.expect);
    for (const c of golden.sizeName) expect(serviceSizeName(c.raw)).toBe(c.expect);
    for (const c of golden.settingsInForce) expect(serviceSettingsInForce(c.general, c.landscapeBlock, c.landscape), c.name).toEqual(c.expect);
    for (const c of golden.autoLandscape) expect(serviceAutoLandscape(c.heightDp)).toEqual(c.expect);
    for (const c of golden.resolve) expect(resolveServiceSize(c.general, c.landscapeBlock, c.display), c.name).toEqual(c.expect);
    for (const c of golden.attractButtons) expect(serviceAttractButtons(c.boxWDp, c.boxHDp, c.measures), c.name).toEqual(c.expect);
  });
});

describe('the measures at the Windows kiosk zoom', () => {
  it('the owner\'s 14" at 125% (1536×864 DIPs): auto keeps the cards modest in CSS px', () => {
    const zoom = kioskWindowZoom(1536, 864);
    const cssW = Math.round(1536 / zoom);
    const cssH = Math.round(864 / zoom);
    const look = serviceSizeLook({ general: {} }, true, cssW, cssH, 1 / zoom);
    expect(look).not.toBeNull();
    // 220 dp high, a 92 dp icon: ~153 and ~64 CSS px of a 600 px tall window.
    expect(look!.cardHeightPx! / cssH).toBeLessThan(0.3);
    expect(look!.iconPx!).toBeLessThanOrEqual(Math.round(96 / zoom));
  });

  it('portrait with nothing set: today (no look)', () => {
    const zoom = kioskWindowZoom(1080, 1920);
    expect(serviceSizeLook({ general: {} }, false, 1080 / zoom, 1920 / zoom, 1 / zoom)).toBeNull();
    expect(serviceSizeLook({ general: { serviceCardSize: 'small' } }, false, 1080 / zoom, 1920 / zoom, 1 / zoom)?.iconPx).toBe(Math.round(56 / zoom));
  });

  it('the landscape block wins only in landscape', () => {
    const cfg = { general: { serviceCardSize: 'large' }, landscape: { general: { serviceCardSize: 'small' } } };
    expect(serviceSizeLook(cfg, true, 1920, 1080, 1)?.size).toBe('small');
    expect(serviceSizeLook(cfg, false, 1080, 1920, 1)?.size).toBe('large');
  });

  it('validation codes, as the editor shows them', () => {
    expect(validateServiceSize({ serviceCardSize: 'huge', serviceIconSize: 81, serviceCardHeight: 100 }, 'general')).toEqual([
      { path: 'general.serviceCardSize', code: 'enum' },
      { path: 'general.serviceIconSize', code: 'range', params: { min: 40, max: 160 } },
    ]);
  });
});
