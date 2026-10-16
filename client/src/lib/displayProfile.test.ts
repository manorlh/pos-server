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
  kioskTargetCssPx,
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

test("the smallest control in CSS px: 48 dp at the app's scale (layout audit 16.10)", () => {
  // The Windows kiosk's 1080p window at its page zoom ×2: half the CSS px; ×1.48 (10.1" 1280×800): 32.4.
  assert.equal(kioskTargetCssPx(0.5), 24);
  assert.equal(kioskTargetCssPx(1 / 1.4815), 32.4);
  // The Android WebView and a browser at ratio 1: 48 CSS px; a 4K screen laid out as full HD (root zoom ×2): 24.
  assert.equal(kioskTargetCssPx(1), 48);
  assert.equal(kioskTargetCssPx(1 / 2), 24);
  // Nonsense in: the dp itself.
  assert.equal(kioskTargetCssPx(0), 48);
  assert.equal(kioskTargetCssPx(Number.NaN), 48);
});

test('a believable 9" or more is never a handheld; a square is corrected at both ends (layout audit 16.10, as pos-android)', () => {
  // 15.6" 1366×768 at 150% (240 dpi), its real 100.5 dpi: no longer the handheld's 910×512 — S15, the density corrected.
  const pitch = Math.hypot(1366, 768) / 15.6;
  const counter = displayProfile({ widthPx: 1366, heightPx: 768, densityDpi: 240, xdpi: pitch, ydpi: pitch });
  assert.equal(counter.physicalTrusted, true);
  assert.equal(counter.sizeClass, '15');
  assert.ok(counter.widthDp > 1100 && counter.heightDp >= 600, `${counter.widthDp}×${counter.heightDp}`);
  // The same panel with no physical claim (an HDMI box): the vendor's density, a handheld as before.
  const hdmi = displayProfile({ widthPx: 1366, heightPx: 768, densityDpi: 240, xdpi: 0, ydpi: 0 });
  assert.equal(hdmi.sizeClass, 'handheld');
  // A 10.1" square 720×720 at 150%: corrected at both ends like a panel on its side (480 → 640 dp), not like today's portrait.
  const sq = Math.hypot(720, 720) / 10.1;
  const square = displayProfile({ widthPx: 720, heightPx: 720, densityDpi: 240, xdpi: sq, ydpi: sq });
  assert.equal(square.landscape, false);
  assert.equal(square.widthDp, square.heightDp);
  assert.ok(square.widthDp >= 600, String(square.widthDp));
  // A browser (never believable) is untouched by either rule.
  assert.deepEqual(displayProfile(browserFacts(683, 480, 1)).sizeClass, 'handheld');
});
