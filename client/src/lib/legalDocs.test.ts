/**
 * Run with `npm test`. The legal pages' constants and limited markdown (lib/legalDocs.ts), the
 * marketing-consent box (lib/marketingConsent.ts) and the toolbar preferences (lib/a11yPrefs.ts).
 * The kinds each channel needs are pinned to the server's gate (app/services/digital_legal/gate.py).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { LEGAL_KINDS, REQUIRED_LEGAL_KINDS, isLegalKind, legalPagePath, parseInline, parseLimitedMarkdown } from './legalDocs';
import {
  MARKETING_TEXT_VERSION,
  TRANSACTIONAL_NOTICE,
  initialMarketingConsent,
  marketingConsentPayload,
  marketingConsentText,
} from './marketingConsent';
import { a11yAttributes, clampFont, readA11yPrefs, rootFontSize } from './a11yPrefs';

function serverFile(...parts: string[]): string {
  const candidates = [join(process.cwd(), '..', 'server', ...parts), join(__dirname, '..', '..', 'server', ...parts)];
  const found = candidates.find((p) => existsSync(p));
  assert.ok(found, `not found: ${candidates.join(' or ')}`);
  return readFileSync(found as string, 'utf8');
}

describe('legal kinds', () => {
  it('the four pages, and what each channel needs — the same as the server gate', () => {
    assert.deepEqual([...LEGAL_KINDS], ['accessibility', 'privacy', 'terms', 'cookies']);
    const gate = serverFile('app', 'services', 'digital_legal', 'gate.py');
    const pyNames: Record<string, string> = {
      accessibility: 'KIND_ACCESSIBILITY',
      privacy: 'KIND_PRIVACY',
      terms: 'KIND_TERMS',
      cookies: 'KIND_COOKIES',
    };
    const productConst: Record<string, string> = { menu: 'PRODUCT_MENU', card: 'PRODUCT_CARD', online: 'PRODUCT_ONLINE' };
    for (const [product, kinds] of Object.entries(REQUIRED_LEGAL_KINDS)) {
      const line = gate.split('\n').find((l) => l.trim().startsWith(`${productConst[product]}: (`));
      assert.ok(line, product);
      assert.equal(line!.trim(), `${productConst[product]}: (${kinds.map((k) => pyNames[k]).join(', ')}),`);
    }
  });

  it('public paths', () => {
    assert.equal(legalPagePath('c1', 'privacy'), '/legal/c1/privacy');
    assert.equal(legalPagePath('c1', 'terms', 's 1'), '/legal/c1/terms?shop=s%201');
    assert.ok(isLegalKind('cookies'));
    assert.ok(!isLegalKind('order-terms'));
  });
});

describe('limited markdown', () => {
  it('headings, paragraphs, lists — nothing else is markup', () => {
    const blocks = parseLimitedMarkdown('# כותרת\n\nשורה אחת\nשורה שתיים\n- א\n- ב\n## משנה\n<b>not html</b>');
    assert.deepEqual(blocks, [
      { type: 'h1', text: 'כותרת' },
      { type: 'p', lines: ['שורה אחת', 'שורה שתיים'] },
      { type: 'ul', items: ['א', 'ב'] },
      { type: 'h2', text: 'משנה' },
      { type: 'p', lines: ['<b>not html</b>'] },
    ]);
  });

  it('bold only', () => {
    assert.deepEqual(parseInline('**בהזמנה:** שם'), [
      { type: 'strong', text: 'בהזמנה:' },
      { type: 'text', text: ' שם' },
    ]);
  });
});

describe('marketing consent', () => {
  it('starts unticked and carries the exact versioned wording', () => {
    const v = initialMarketingConsent('sms', 'רויאל');
    assert.equal(v.granted, false);
    assert.equal(v.textVersion, MARKETING_TEXT_VERSION);
    assert.equal(v.text, marketingConsentText('sms', 'רויאל'));
    assert.match(v.text, /רויאל ב-SMS/);
    assert.equal(marketingConsentPayload(true, 'email', ' רויאל ').text.includes('מאת רויאל בדוא"ל'), true);
  });

  it('is the same text the server accepts', () => {
    const py = serverFile('app', 'services', 'digital_legal', 'marketing.py');
    for (const channel of ['sms', 'whatsapp', 'email'] as const) {
      const template = marketingConsentText(channel, '{business}');
      assert.ok(py.includes(template), channel);
    }
  });

  it('says service messages do not depend on it', () => {
    assert.match(TRANSACTIONAL_NOTICE, /ההזמנה מוכנה/);
  });
});

describe('toolbar preferences', () => {
  it('reads only known values and clamps the text size', () => {
    assert.deepEqual(readA11yPrefs('{"font":9,"contrast":true,"links":"yes"}'), { font: 3, contrast: true, links: false, still: false });
    assert.deepEqual(readA11yPrefs('nope'), { font: 0, contrast: false, links: false, still: false });
    assert.equal(clampFont(-1), 0);
  });

  it('becomes root attributes and a root font size', () => {
    assert.deepEqual(a11yAttributes({ font: 2, contrast: false, links: true, still: true }), {
      'data-a11y-font': '2',
      'data-a11y-links': '',
      'data-a11y-still': '',
    });
    assert.equal(rootFontSize(0), '');
    assert.equal(rootFontSize(2), '125%');
  });
});
