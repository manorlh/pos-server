import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  AS_TODAY,
  bigBasketWidthDp,
  browserFacts,
  displayProfile,
  kioskDisplay,
  kioskDisplayTheme,
  tillLayoutOf,
  type DisplayFacts,
} from './displayProfile';

/**
 * The display profile against the shared golden fixture (server/tests/fixtures/display_profiles_golden.json,
 * the same bytes as pos-android's DisplayProfileTest): every case's profile, the kiosk's landscape
 * decisions and the till's layout, number for number with domain/DisplayProfile.kt.
 */

function fixture(): string {
  const name = 'display_profiles_golden.json';
  const candidates = [join(process.cwd(), '..', 'server', 'tests', 'fixtures', name), join(__dirname, '..', '..', 'server', 'tests', 'fixtures', name)];
  const path = candidates.find((p) => existsSync(p));
  if (!path) throw new Error(`${name} not found`);
  return readFileSync(path, 'utf8');
}

interface GoldenCase {
  name: string;
  facts: DisplayFacts;
  profile: Record<string, unknown>;
  kiosk: Record<string, unknown>;
  till: { layout: string; bigBasketWidthDp: number | null };
}

const text = fixture();
const cases: GoldenCase[] = JSON.parse(text).cases;

test("the fixture is the same bytes as the till's", () => {
  const sha = createHash('sha256').update(text.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
  assert.equal(sha, '1beefb2a4720c099a55c60f9c0e1e386b4b56052f52e419c3a476f085eb44d6a');
});

test('every golden case: the profile, the kiosk and the till', () => {
  assert.ok(cases.length >= 25);
  for (const c of cases) {
    const p = displayProfile(c.facts);
    assert.deepEqual({ ...p }, c.profile, c.name);
    assert.deepEqual({ ...kioskDisplay(p) }, c.kiosk, c.name);
    const layout = tillLayoutOf(p);
    assert.equal(layout, c.till.layout, c.name);
    if (layout === 'BIG') assert.equal(bigBasketWidthDp(p.widthDp), c.till.bigBasketWidthDp, c.name);
  }
});

test('a browser window: CSS pixels are dp, never a physical claim, 4K at ratio 1 scaled', () => {
  const fhd = displayProfile(browserFacts(1920, 1080, 1));
  assert.equal(fhd.physicalTrusted, false);
  assert.deepEqual([fhd.widthDp, fhd.heightDp, fhd.scale], [1920, 1080, 1]);
  const uhd = displayProfile(browserFacts(3840, 2160, 1));
  assert.deepEqual([uhd.widthDp, uhd.heightDp, uhd.scale], [1920, 1080, 2]);
  // A retina laptop at ratio 2: its CSS size is what counts.
  const retina = displayProfile(browserFacts(1440, 900, 2));
  assert.deepEqual([retina.widthDp, retina.heightDp, retina.scale], [1440, 900, 1]);
});

test('the landscape kiosk: side cart from 1300, the rail or the tabs; portrait as configured', () => {
  const wide = kioskDisplay(displayProfile(browserFacts(1920, 1080)));
  assert.equal(wide.sideCart, true);
  assert.equal(wide.panelWidthDp, 480);
  assert.deepEqual(kioskDisplayTheme({ cartStyle: 'bar', categoryLayout: 'side' }, wide), { cartStyle: 'panel', categoryLayout: 'side' });
  assert.deepEqual(kioskDisplayTheme({ cartStyle: 'bar', categoryLayout: 'top' }, wide), { cartStyle: 'panel', categoryLayout: 'top' });
  const narrow = kioskDisplay(displayProfile(browserFacts(880, 600)));
  assert.equal(narrow.sideCart, false);
  assert.deepEqual(kioskDisplayTheme({ cartStyle: 'bar', categoryLayout: 'side' }, narrow), { cartStyle: 'bar', categoryLayout: 'top' });
  const upright = kioskDisplay(displayProfile(browserFacts(1080, 1920)));
  assert.deepEqual(upright, AS_TODAY);
  const theme = { cartStyle: 'bar', categoryLayout: 'side' };
  assert.equal(kioskDisplayTheme(theme, upright), theme);
});
