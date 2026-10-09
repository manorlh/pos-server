/**
 * S0-12: the one app bundle's floor — Chromium 108 (Windows 7 / Electron 22, Chrome / Edge 109)
 * and Safari 16.4 (P:/specs/web-till-spec-v2.md §13.3):
 *  - .browserslistrc and vite.app.config.mts say the same floor;
 *  - the till's CSS uses nothing above it, nothing heavy for a Celeron drawing in software
 *    (no blur, no backdrop-filter, one small shadow, transitions on transform / background only),
 *    and the lite profile turns transitions, animations and shadows off.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { APP_BUILD_TARGET, APP_CSS_TARGETS, APP_MIN_CHROME, APP_MIN_SAFARI } from '../vite.app.config.mts';

const root = path.resolve(__dirname, '..');
const css = readFileSync(path.join(root, 'src/renderer/roles/till/till.css'), 'utf8');
const rules = readFileSync(path.join(root, 'src/renderer/.browserslistrc'), 'utf8')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

describe('the floor, said once in each tool\'s words', () => {
  it('browserslist: Chrome / Edge 108, Safari / iOS 16.4', () => {
    expect(rules).toEqual(expect.arrayContaining(['chrome >= 108', 'edge >= 108', 'safari >= 16.4', 'ios_saf >= 16.4']));
  });

  it('Vite and Lightning CSS: the same', () => {
    expect(APP_MIN_CHROME).toBe(108);
    expect(APP_MIN_SAFARI).toBe('16.4');
    expect(APP_BUILD_TARGET).toEqual(['chrome108', 'safari16.4']);
    expect(APP_CSS_TARGETS.chrome).toBe(108 << 16);
    expect(APP_CSS_TARGETS.safari).toBe((16 << 16) | (4 << 8));
    for (const r of rules) {
      const m = /^(\w+) >= ([\d.]+)$/.exec(r)!;
      const [major, minor = '0'] = m[2].split('.');
      const key = m[1] as keyof typeof APP_CSS_TARGETS;
      expect(APP_CSS_TARGETS[key], r).toBe((Number(major) << 16) | (Number(minor) << 8));
    }
  });
});

describe('the till\'s CSS', () => {
  const code = css.replace(/\/\*[\s\S]*?\*\//g, '');

  it('has no colour function, selector or at-rule above Chromium 108', () => {
    for (const re of [/oklch\(/i, /oklab\(/i, /color-mix\(/i, /:has\(/, /@starting-style/, /@scope/, /anchor-name/, /position-anchor/, /field-sizing/, /@container\s+style/, /:popover-open/, /text-wrap:\s*(balance|pretty)/, /\binset\s*:/]) {
      expect(code, String(re)).not.toMatch(re);
    }
  });

  it('has no CSS nesting', () => {
    // Every "{" opens a block whose body has no other "{" — except @media / @supports.
    const stripped = code.replace(/@(media|supports)[^{]*\{([\s\S]*?\})\s*\}/g, '$2');
    let depth = 0;
    for (const ch of stripped) {
      if (ch === '{') depth += 1;
      if (ch === '}') depth -= 1;
      expect(depth).toBeLessThanOrEqual(1);
    }
    expect(stripped).not.toMatch(/&/);
  });

  it('has no blur, no backdrop-filter, no filter at all, one small shadow', () => {
    expect(code).not.toMatch(/backdrop-filter/);
    expect(code).not.toMatch(/\bfilter\s*:/);
    expect(code).not.toMatch(/blur\(/);
    const shadows = code.match(/box-shadow\s*:[^;]+;/g) ?? [];
    const real = shadows.filter((s) => !/none/.test(s));
    expect(real.length).toBeLessThanOrEqual(1);
    for (const s of real) {
      const blur = Number(/\d+px\s+(\d+)px/.exec(s)?.[1] ?? 0);
      expect(blur).toBeLessThanOrEqual(8);
    }
  });

  it('animates only transform and background-color, never layout, and has no keyframes', () => {
    expect(code).not.toMatch(/@keyframes/);
    for (const t of code.match(/transition\s*:[^;]+;/g) ?? []) {
      if (/none/.test(t)) continue;
      const props = t
        .replace(/transition\s*:/, '')
        .replace(';', '')
        .split(',')
        .map((x) => x.trim().split(/\s+/)[0]);
      for (const prop of props) expect(['transform', 'background-color', 'opacity']).toContain(prop);
    }
  });

  it('lite turns transitions, animations and shadows off, and reduced motion turns transitions off', () => {
    expect(code).toMatch(/\.t-root\[data-lite='1'\] \*[\s\S]*?transition: none !important;[\s\S]*?animation: none !important;[\s\S]*?box-shadow: none !important;/);
    expect(code).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
  });

  it('colours are hex or rgba tokens', () => {
    const colours = code.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g) ?? [];
    expect(colours.length).toBeGreaterThan(10);
    expect(colours.filter((c) => c.startsWith('hsl'))).toEqual([]);
  });
});
