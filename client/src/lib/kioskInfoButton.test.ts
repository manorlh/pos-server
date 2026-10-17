/**
 * Run with `npm test`. "כפתור פרטים" (ⓘ, layout.infoButton): the rule against the shared golden
 * server/tests/fixtures/kiosk_info_button_golden.json (the same bytes in pos-android's test resources,
 * SHA pinned here, in pos-server tests/test_kiosk_count_badge.py and pos-android KioskInfoButtonTest),
 * and the layouts' sources (read as text: this runner does not compile React) drawing it on every dish
 * card of every template, opening the window and keeping the card's own tap.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveKioskConfig } from './kioskConfig';
import {
  INFO_BUTTON_TOUCH,
  INFO_DESCRIPTION_LINE_CHARS,
  KIOSK_LAYOUT_DEFAULTS,
  LAYOUT_INFO_BUTTONS,
  dishHasMoreInfo,
  dishInfoButtonOn,
  validateLayout,
  type DishInfoFacts,
  type LayoutInfoButton,
} from './kioskLayout';

const GOLDEN_SHA256 = 'c2b7a0eee3c6d2e649ec4145485332d1a14dc7089435d5aa31d8f61c49e175dc';

function fixture(name: string): string {
  const candidates = [join(process.cwd(), '..', 'server', 'tests', 'fixtures', name), join(__dirname, '..', '..', 'server', 'tests', 'fixtures', name)];
  const found = candidates.find((p) => existsSync(p));
  assert.ok(found, `fixture not found at ${candidates.join(' or ')}`);
  return readFileSync(found, 'utf8').replace(/\r\n/g, '\n');
}

const src = (p: string) => readFileSync(join(process.cwd(), 'src', p), 'utf8');

interface Golden {
  constants: { descriptionLineChars: number; touchTarget: number; modes: string[]; default: string };
  cases: Array<{ name: string; mode: string | null; skipsWindow: boolean; soldOut: boolean; facts: DishInfoFacts; more: boolean; on: boolean }>;
}

describe('"כפתור פרטים" (ⓘ): the shared golden', () => {
  const text = fixture('kiosk_info_button_golden.json');
  const golden = JSON.parse(text) as Golden;

  it('is the shared bytes, with this build\'s constants', () => {
    assert.equal(createHash('sha256').update(text, 'utf8').digest('hex'), GOLDEN_SHA256);
    assert.equal(golden.constants.descriptionLineChars, INFO_DESCRIPTION_LINE_CHARS);
    assert.equal(golden.constants.touchTarget, INFO_BUTTON_TOUCH);
    assert.deepEqual(golden.constants.modes, LAYOUT_INFO_BUTTONS);
    assert.equal(golden.constants.default, KIOSK_LAYOUT_DEFAULTS.infoButton);
  });

  for (const c of golden.cases) {
    it(c.name, () => {
      assert.equal(dishHasMoreInfo(c.facts), c.more);
      assert.equal(dishInfoButtonOn(c.mode as LayoutInfoButton | null, c.skipsWindow, c.soldOut, c.facts), c.on);
    });
  }
});

describe('layout.infoButton: a layout key like the others', () => {
  it('auto by default, every template; validated', () => {
    for (const template of ['standard', 'list', 'wall', 'magazine', 'restaurant_rail'] as const) {
      assert.equal(resolveKioskConfig({ layout: { template } }).layout.infoButton, 'auto', template);
    }
    assert.equal(resolveKioskConfig({ layout: { infoButton: 'off' } }).layout.infoButton, 'off');
    assert.deepEqual(validateLayout({ layout: { ...KIOSK_LAYOUT_DEFAULTS, infoButton: 'sometimes' } } as never).map((e) => e.path), ['layout.infoButton']);
    // A draft from before the key: nothing to refuse.
    const older = { ...KIOSK_LAYOUT_DEFAULTS } as Partial<typeof KIOSK_LAYOUT_DEFAULTS>;
    delete older.infoButton;
    assert.deepEqual(validateLayout({ layout: older } as never), []);
  });
});

describe('the ⓘ on every dish card (kiosk-shared)', () => {
  const button = src('kiosk-shared/layouts/info-button.tsx');

  it('opens the dish\'s window, stops its tap, touch target the kiosk\'s minimum', () => {
    assert.match(button, /e\.stopPropagation\(\);\s*m\.openProduct\(p\);/);
    assert.match(button, /'k-hit /);
    assert.match(button, /aria-label=\{m\.t\('dishInfo', \{ name: p\.name \}\)\}/);
    // Whether it shows: the shared rule, with "a tap skips the window" from the same tap path the card uses.
    assert.match(button, /tapPathOf\(p, l\.quickAdd, false, !!m\.mealOf\?\.\(p\)\) === 'direct'/);
    assert.match(button, /dishInfoButtonOn\(l\.infoButton, skips, p\.soldOut, dishInfoFacts\(m, p, card\)\)/);
    const he = JSON.parse(src('messages/he.json')) as { kiosks: { preview: Record<string, string> } };
    assert.equal(he.kiosks.preview.dishInfo, 'פרטים על {name}');
  });

  const cards: Array<[string, number]> = [
    ['kiosk-shared/layouts/parts.tsx', 3], // tile, row, plate
    ['kiosk-shared/layouts/list.tsx', 1],
    ['kiosk-shared/layouts/magazine.tsx', 1],
    ['kiosk-shared/layouts/wall.tsx', 1],
    ['kiosk-shared/layouts/hero.tsx', 1],
    ['components/dashboard/kiosks/preview-screens.tsx', 1], // today's card (standard)
  ];
  for (const [file, n] of cards) {
    it(`${file}: ${n} card(s) draw it`, () => {
      const s = src(file);
      assert.equal(s.match(/<DishInfoButton /g)?.length ?? 0, n);
      assert.equal(s.match(/data-dish=|export function ProductCard/g)?.length ?? 0, n);
    });
  }
});
