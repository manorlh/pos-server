/**
 * Run with `npm test`. WCAG contrast (lib/contrast.ts) — pinned to the server's rules by the shared
 * golden fixture server/tests/fixtures/contrast_golden.json (tests/test_digital_legal.py reads it too).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { checkThemeContrast, contrastRatio, parseColor, type ThemeTokens } from './contrast';

interface Golden {
  ratios: Array<{ fg: string; bg: string; ratio: number | null }>;
  themes: Array<{ name: string; theme: ThemeTokens; ok: boolean; failures: string[]; ratios: Record<string, number | null> }>;
}

function goldenPath(): string {
  const candidates = [
    join(process.cwd(), '..', 'server', 'tests', 'fixtures', 'contrast_golden.json'),
    join(__dirname, '..', '..', 'server', 'tests', 'fixtures', 'contrast_golden.json'),
  ];
  const found = candidates.find((p) => existsSync(p));
  assert.ok(found, `golden fixture not found at ${candidates.join(' or ')}`);
  return found as string;
}

describe('contrast — the same answers as the server (golden)', () => {
  const golden = JSON.parse(readFileSync(goldenPath(), 'utf8')) as Golden;

  it('has enough cases to mean something', () => {
    assert.ok(golden.ratios.length >= 15);
    assert.ok(golden.themes.length >= 8);
  });

  for (const c of golden.ratios) {
    it(`ratio ${c.fg} on ${c.bg}`, () => {
      const got = contrastRatio(c.fg, c.bg);
      assert.equal(got === null ? null : Math.round(got * 100) / 100, c.ratio);
    });
  }

  for (const c of golden.themes) {
    it(`theme "${c.name}"`, () => {
      const res = checkThemeContrast(c.theme);
      assert.equal(res.ok, c.ok);
      assert.deepEqual(res.failures, c.failures);
      assert.deepEqual(Object.fromEntries(res.pairs.map((p) => [p.id, p.ratio])), c.ratios);
    });
  }
});

describe('contrast — rules', () => {
  it('parses hex, short hex, alpha and rgb(); refuses anything else', () => {
    assert.deepEqual(parseColor('#fff'), [255, 255, 255, 1]);
    assert.deepEqual(parseColor('#000000'), [0, 0, 0, 1]);
    assert.deepEqual(parseColor('rgb(1, 2, 3)'), [1, 2, 3, 1]);
    assert.equal(parseColor('blue'), null);
    assert.equal(parseColor('rgb(256,0,0)'), null);
    assert.equal(parseColor(null), null);
  });

  it('never rounds a ratio up to pass: 4.48 fails text, 4.54 passes', () => {
    assert.equal(checkThemeContrast({ textColor: '#777777' }).ok, false);
    assert.equal(checkThemeContrast({ textColor: '#767676' }).ok, true);
  });

  it('a large-text pair needs 3:1, a text pair 4.5:1', () => {
    const large = checkThemeContrast({ pairs: [{ id: 'x', fg: '#FFFFFF', bg: '#2F9E44', kind: 'large' }] });
    const text = checkThemeContrast({ pairs: [{ id: 'x', fg: '#FFFFFF', bg: '#2F9E44', kind: 'text' }] });
    assert.equal(large.failures.includes('x'), false);
    assert.equal(text.failures.includes('x'), true);
  });

  it('an unreadable colour fails (it can never be shown to pass)', () => {
    const res = checkThemeContrast({ buttonColor: 'nope' });
    assert.deepEqual(res.failures, ['button_text']);
    assert.equal(res.pairs.find((p) => p.id === 'button_text')?.ratio, null);
  });
});
