/**
 * The Windows 7 legacy CSS (scripts/legacyCss.ts): Tailwind 4's output made to draw the same on
 * Chromium 108 (Electron 22), with the modern build untouched. The fixture follows Tailwind 4.3's
 * own output: the palette in oklch custom properties, opacity colours with an sRGB fallback and a
 * color-mix() inside @supports, gradients interpolating in oklab, the placeholder's mix.
 */
import { describe, expect, it } from 'vitest';
import { chrome108View, coverageGaps, declarationKeys, dropInterpolationInGradients, legacyCss, parseCss, serializeCss, splitSelectors } from '../scripts/legacyCss';

const TAILWIND = [
  '@layer properties{@supports (((-webkit-hyphens:none)) and (not (margin-trim:inline))) or ((-moz-orient:inline) and (not (color:rgb(from red r g b)))){*,:before,:after,::backdrop{--tw-gradient-position:initial}}}',
  '@layer theme{:root,:host{--color-red-50:oklch(97.1% .013 17.38);--color-red-600:oklch(57.7% .245 27.325);--color-blue-500:oklch(62.3% .214 259.815);--color-black:#000;--color-white:#fff;--spacing:.25rem}}',
  '@layer base{@supports (not (-webkit-appearance:-apple-pay-button)) or (contain-intrinsic-size:1px){::placeholder{color:color-mix(in oklab, currentcolor 50%, transparent)}}}',
  '@layer utilities{',
  '.bg-red-50{background-color:var(--color-red-50)}',
  '.text-red-600{color:var(--color-red-600)}',
  '.bg-black\\/40{background-color:#0006}@supports (color:color-mix(in lab, red, red)){.bg-black\\/40{background-color:color-mix(in oklab, var(--color-black) 40%, transparent)}}',
  '.bg-gradient-to-br{--tw-gradient-position:to bottom right in oklab;background-image:linear-gradient(var(--tw-gradient-stops))}',
  '.bg-radial{--tw-gradient-position:in oklab;background-image:radial-gradient(var(--tw-gradient-stops))}',
  '.from-blue-500{--tw-gradient-from:var(--color-blue-500);--tw-gradient-stops:var(--tw-gradient-via-stops,var(--tw-gradient-position),var(--tw-gradient-from) var(--tw-gradient-from-position),var(--tw-gradient-to) var(--tw-gradient-to-position))}',
  '.p-4{padding:calc(var(--spacing) * 4)}',
  '@media (width>=40rem){.sm\\:text-red-600{color:var(--color-red-600)}}',
  '}',
].join('');

describe('the legacy pass', () => {
  const legacy = legacyCss(TAILWIND);
  const view = chrome108View(legacy);

  it('gives the palette an sRGB value Chromium 108 keeps', () => {
    expect(view).toMatch(/--color-red-50:#[0-9a-f]{3,8}/);
    expect(view).toMatch(/--color-red-600:#[0-9a-f]{3,8}/);
    expect(view).toMatch(/--color-blue-500:#[0-9a-f]{3,8}/);
    // The wider-gamut value stays for newer engines, behind @supports (Chromium 108 skips it).
    expect(legacy).toMatch(/@supports \(color:lab\(0% 0 0\)\)|@supports \(color: lab\(0% 0 0\)\)/);
  });

  it('keeps the sRGB fallback of opacity colours, and gradients without oklab interpolation', () => {
    expect(view).toContain('.bg-black\\/40{background-color:#0006}');
    expect(view).toContain('--tw-gradient-position:to bottom right');
    expect(view).not.toContain('in oklab');
    // Nothing left that Chromium 108 cannot parse, outside a skipped @supports.
    expect(view).not.toMatch(/oklch\(|oklab\(|color-mix\(/);
  });

  it('a radial gradient whose position was only the interpolation gets a valid one', () => {
    expect(view).toMatch(/\.bg-radial\{--tw-gradient-position:ellipse;/);
  });

  it('loses nothing the modern sheet sets, but the explained placeholder', () => {
    expect(coverageGaps(TAILWIND, legacy)).toEqual([]);
    // Without the pass, Chromium 108 loses the palette and the gradient position.
    const lost = coverageGaps(TAILWIND, TAILWIND);
    expect(lost).toEqual(expect.arrayContaining(['@layer theme;|:root|--color-red-50', '@layer utilities;|.bg-gradient-to-br|--tw-gradient-position']));
  });
});

describe('the model of what Chromium 108 keeps', () => {
  it('drops unknown colour syntax and @supports blocks that need it; keeps feature sniffs and everything else', () => {
    const v = chrome108View(TAILWIND);
    expect(v).not.toMatch(/--color-red-50:/); // the declaration is gone; its use stays (and computes to nothing)
    expect(v).toContain('--color-black:#000');
    expect(v).not.toContain('color-mix(');
    expect(v).toContain('-webkit-hyphens:none'); // Tailwind's own @property fallback sniff is kept
    expect(v).toContain('.p-4{padding:calc(var(--spacing) * 4)}');
    expect(v).toContain('@media (width>=40rem)');
  });

  it('parses and writes a sheet back unchanged', () => {
    expect(serializeCss(parseCss(TAILWIND))).toBe(TAILWIND);
    const strings = '.a{content:"a;b{c}"}.b{background:url(data:image/svg+xml;utf8,x)}';
    expect(serializeCss(parseCss(strings))).toBe(strings);
  });

  it('splits selector lists at the top level only', () => {
    expect(splitSelectors(':root,:host')).toEqual([':root', ':host']);
    expect(splitSelectors(':is(.a,.b),.c[data-x="1,2"]')).toEqual([':is(.a,.b)', '.c[data-x="1,2"]']);
    expect(declarationKeys('.a,.b{color:red}')).toEqual(new Set(['|.a|color', '|.b|color']));
  });

  it('drops gradient interpolation only from gradients', () => {
    expect(dropInterpolationInGradients('linear-gradient(to right in oklab, red, blue)')).toBe('linear-gradient(to right, red, blue)');
    expect(dropInterpolationInGradients('linear-gradient(in oklch longer hue, red, blue)')).toBe('linear-gradient(red, blue)');
    expect(dropInterpolationInGradients('linear-gradient(var(--tw-gradient-stops))')).toBe('linear-gradient(var(--tw-gradient-stops))');
    expect(dropInterpolationInGradients('radial-gradient(circle, red, blue)')).toBe('radial-gradient(circle, red, blue)');
  });
});
