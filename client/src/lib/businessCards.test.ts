/**
 * The card resolver the editor's live preview runs, against the golden fixture the server's
 * resolver is tested against (server/tests/test_business_card_resolve.py) — the preview and the
 * public page give the same answer for the same input.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  applyTemplate,
  cardIssues,
  contrastRatio,
  defaultDoc,
  displayPhone,
  isPlatformUrl,
  isSafeMediaUrl,
  isSafeUrl,
  isValidSlug,
  navigationHref,
  normalizePhone,
  readableOn,
  resolveCard,
  suggestSlug,
  type ResolveInput,
} from './businessCards';

interface GoldenCase {
  name: string;
  input: ResolveInput;
  expected: unknown;
}

const golden: GoldenCase[] = JSON.parse(
  readFileSync(join(process.cwd(), '..', 'server', 'tests', 'fixtures', 'business_cards', 'resolve_golden.json'), 'utf8'),
);

const plain = (v: unknown) => JSON.parse(JSON.stringify(v));

describe('business card resolver — the same answer as the server', () => {
  it('has the golden cases', () => {
    assert.ok(golden.length >= 6);
  });
  for (const c of golden) {
    it(c.name, () => {
      const result = resolveCard(structuredClone(c.input));
      const issues = cardIssues(structuredClone(c.input), result);
      assert.deepEqual(plain({ ...result, issues }), c.expected);
    });
  }
});

describe('business card rules', () => {
  it('never shows a private value', () => {
    for (const c of golden) {
      const r = resolveCard(structuredClone(c.input));
      const text = JSON.stringify(r.model);
      for (const [key, f] of Object.entries(r.fields)) {
        if (f.visibility !== 'private' || f.value === null) continue;
        const needle = typeof f.value === 'string' ? f.value : JSON.stringify(f.value);
        assert.ok(!text.includes(needle), `${c.name}: ${key}`);
      }
    }
  });

  it('normalises Israeli phones like the server', () => {
    assert.equal(normalizePhone('050-123-4567'), '+972501234567');
    assert.equal(normalizePhone('+972 050 123 4567'), '+972501234567');
    assert.equal(normalizePhone('00972-3-1234567'), '+97231234567');
    assert.equal(normalizePhone('501234567'), '+972501234567');
    assert.equal(normalizePhone('12345'), null);
    assert.equal(normalizePhone('+1 212 555 0100'), '+12125550100');
    assert.equal(displayPhone('+972501234567'), '050-123-4567');
    assert.equal(displayPhone('+97231234567'), '03-123-4567');
  });

  it('accepts https only, and social links only on their platform', () => {
    assert.ok(isSafeUrl('https://royal.example/x?y=1#z'));
    for (const bad of ['http://royal.example', 'javascript:alert(1)', 'https://u:p@royal.example', 'https://royal', 'https://a.example/b c']) {
      assert.ok(!isSafeUrl(bad), bad);
    }
    assert.ok(isSafeMediaUrl('http://localhost:8001/media/pos/x.png'));
    assert.ok(!isSafeMediaUrl('http://evil.example/media/x.png'));
    assert.ok(isPlatformUrl('instagram', 'https://www.instagram.com/x'));
    assert.ok(!isPlatformUrl('instagram', 'https://instagram.com.evil.example/x'));
  });

  it('builds navigation links for Google and Waze', () => {
    assert.equal(navigationHref('32.1, 34.8', 'waze'), 'https://waze.com/ul?ll=32.1,34.8&navigate=yes');
    assert.equal(navigationHref('הרצל 1, תל אביב', 'google'), `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent('הרצל 1, תל אביב')}`);
  });

  it('checks slugs', () => {
    assert.ok(isValidSlug('royal-cafe'));
    for (const bad of ['ab', 'Royal', '-x-y', 'ro--yal', 'קפה', 'admin']) assert.ok(!isValidSlug(bad), bad);
    assert.equal(suggestSlug('Royal Café Herzliya!'), 'royal-caf-herzliya');
    assert.equal(suggestSlug('קפה רויאל'), '');
  });

  it('measures contrast and picks readable button text', () => {
    assert.equal(contrastRatio('#000000', '#ffffff'), 21);
    assert.ok(contrastRatio('#999999', '#ffffff') < 4.5);
    assert.equal(readableOn('#1d4ed8'), '#ffffff');
    assert.equal(readableOn('#f59e0b'), '#111111');
  });

  it('keeps content, actions and section order when the template changes', () => {
    const doc = defaultDoc('company', 'cover');
    doc.fields.phone = { mode: 'local', visibility: 'public', value: '03-1234567' };
    doc.sections = [...doc.sections].reverse();
    const next = applyTemplate(doc, 'dark');
    assert.equal(next.template, 'dark');
    assert.deepEqual(next.fields, doc.fields);
    assert.deepEqual(next.actions, doc.actions);
    assert.deepEqual(next.sections, doc.sections);
    assert.equal(next.design.palette.background, '#0b1120');
  });

  it('every template preset is readable (AA) out of the box', () => {
    for (const t of ['minimal', 'cover', 'dark', 'portrait', 'location', 'services', 'event', 'links'] as const) {
      const p = applyTemplate(defaultDoc('company', 'cover'), t).design.palette;
      assert.ok(contrastRatio(p.text, p.background) >= 4.5, `${t} text`);
      assert.ok(contrastRatio(p.text, p.surface) >= 4.5, `${t} text/surface`);
      assert.ok(contrastRatio(p.muted, p.background) >= 4.5, `${t} muted`);
      assert.ok(contrastRatio(p.muted, p.surface) >= 4.5, `${t} muted/surface`);
    }
  });
});
