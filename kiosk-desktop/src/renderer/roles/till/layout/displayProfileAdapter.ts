/**
 * A MINIMAL ADAPTER of `client/src/lib/displayProfile.ts` (P:/specs/kiosk-landscape-till-mode.md
 * §2, §6), behind the same names and types, for the till's layout until that file lands.
 *
 * TODO(kiosk-landscape): when `client/src/lib/displayProfile.ts` is merged (branch
 * feat/kiosk-landscape-till-mode), replace this file's body with
 *   export * from '@dash-lib/displayProfile';
 * and drop test/tillDisplayAdapter.test.ts's copy of the golden rows — the real one is pinned by
 * display_profiles_golden.json in both repos.
 *
 * Only what a browser / Electron / WKWebView ever sees is implemented: a CSS pixel is a dp
 * (`densityDpi = 160 × devicePixelRatio`) and the physical size is never known (`xdpi = 0`), so the
 * dp buckets decide (§2.4) — a 4K screen at ratio 1 is scaled to behave like FHD.
 */

export interface DisplayFacts {
  widthPx: number;
  heightPx: number;
  densityDpi: number;
  /** The vendor's physical claim (0 when unknown — always, in a browser). */
  xdpi: number;
  ydpi: number;
}

export type DisplaySizeClass = 'handheld' | '11' | '13' | '15' | '21' | '27' | '32';

export interface DisplayProfile {
  landscape: boolean;
  sizeClass: DisplaySizeClass;
  diagonalInches: number;
  physicalTrusted: boolean;
  scale: number;
  widthDp: number;
  heightDp: number;
  kioskTypeScale: number;
}

export type TillLayoutClass = 'HANDHELD' | 'TABLET' | 'BIG';

export const HANDHELD_MAX_SMALLEST_DP = 600;
const HIRES_SMALLEST_DP = 1440;
const HIRES_TARGET_SMALLEST_DP = 1080;
const CLASSES: ReadonlyArray<[DisplaySizeClass, number]> = [
  ['handheld', 9.0],
  ['11', 12.0],
  ['13', 14.5],
  ['15', 18.5],
  ['21', 24.5],
  ['27', 29.5],
  ['32', Number.MAX_VALUE],
];
const ORDER: DisplaySizeClass[] = CLASSES.map(([c]) => c);

const round2 = (v: number) => Math.floor(v * 100 + 0.5) / 100;
const round1 = (v: number) => Math.floor(v * 10 + 0.5) / 10;
const roundHalfUp = (v: number) => Math.floor(v + 0.5);
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** The browser's facts: never a physical claim, so never "trusted" (§2.2). */
export function displayProfile(f: DisplayFacts): DisplayProfile {
  const density = (f.densityDpi > 0 ? f.densityDpi : 160) / 160;
  const wNative = f.widthPx / density;
  const hNative = f.heightPx / density;
  const swNative = Math.min(wNative, hNative);
  const diagonal = Math.hypot(wNative, hNative) / 160;
  let sizeClass: DisplaySizeClass = 'handheld';
  if (swNative >= HANDHELD_MAX_SMALLEST_DP) {
    const byInches = (CLASSES.find(([, upTo]) => diagonal < upTo) ?? CLASSES[CLASSES.length - 1])[0];
    sizeClass = byInches === 'handheld' ? '11' : byInches;
  }
  const raw = sizeClass !== 'handheld' && swNative >= HIRES_SMALLEST_DP ? swNative / HIRES_TARGET_SMALLEST_DP : 1;
  const scale = round2(clamp(raw, 0.75, 2.5));
  const effective = density * scale;
  return {
    landscape: f.widthPx > f.heightPx,
    sizeClass,
    diagonalInches: round1(diagonal),
    physicalTrusted: false,
    scale,
    widthDp: Math.floor(f.widthPx / effective),
    heightDp: Math.floor(f.heightPx / effective),
    kioskTypeScale: 1,
  };
}

export function browserFacts(innerWidth: number, innerHeight: number, devicePixelRatio = 1): DisplayFacts {
  const ratio = devicePixelRatio > 0 ? devicePixelRatio : 1;
  return { widthPx: Math.round(innerWidth * ratio), heightPx: Math.round(innerHeight * ratio), densityDpi: Math.round(160 * ratio), xdpi: 0, ydpi: 0 };
}

/** `TillDisplay.layoutOf` (§6): handheld under 600 dp; BIG from S15 with room; TABLET the rest. */
export function tillLayoutOf(p: DisplayProfile): TillLayoutClass {
  if (Math.min(p.widthDp, p.heightDp) < HANDHELD_MAX_SMALLEST_DP) return 'HANDHELD';
  const bigClass = ORDER.indexOf(p.sizeClass) >= ORDER.indexOf('15');
  const fits = p.landscape ? p.widthDp >= 1400 && p.heightDp >= 800 : p.heightDp >= 1400 && p.widthDp >= 800;
  return bigClass && fits ? 'BIG' : 'TABLET';
}

/** The BIG layout's basket (§6.1): clamp(0.28 × wEff, 420, 560). */
export function bigBasketWidthDp(widthDp: number): number {
  return clamp(roundHalfUp(widthDp * 0.28), 420, 560);
}
