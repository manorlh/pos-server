/**
 * Run with `npm test`. THE shared accessibility checklist of the public templates: every public
 * building block (components/public-legal) is rendered to static markup in Hebrew (RTL) and English
 * (LTR), in each of its states, and run through the rule set (lib/a11yRules.ts) — no violation at
 * any impact. A deliberately broken template proves the checklist bites.
 *
 * A new public template (digital menu, online ordering, business card) adds its renders here, or
 * calls `auditHtml(renderToStaticMarkup(...))` the same way in its own *.test.tsx.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';

import { auditHtml, formatViolations } from './a11yRules';
import { createConsentGate, memoryStorage } from './consent';
import { initialMarketingConsent } from './marketingConsent';
import type { PublicLegalIndex } from './publicLegalApi';
import { A11yToolbar } from '../components/public-legal/A11yToolbar';
import { ConsentGate, ConsentGateProvider } from '../components/public-legal/ConsentGate';
import { ContrastValidator } from '../components/public-legal/ContrastValidator';
import { CookieConsent } from '../components/public-legal/CookieConsent';
import { LegalFooter } from '../components/public-legal/LegalFooter';
import { LegalMarkdown } from '../components/public-legal/LegalMarkdown';
import { MarketingConsent } from '../components/public-legal/MarketingConsent';
import { PublicPageShell } from '../components/public-legal/PublicPageShell';

const LANGS = ['he', 'en'] as const;

const LEGAL: PublicLegalIndex = {
  businessName: 'רויאל',
  lang: 'he',
  documents: {
    accessibility: { title: 'הצהרת נגישות', slug: 'accessibility', version: 1, publishedAt: '2026-10-10T08:00:00Z' },
    privacy: { title: 'מדיניות פרטיות', slug: 'privacy', version: 2, publishedAt: '2026-10-10T08:00:00Z' },
    terms: { title: 'תקנון', slug: 'terms', version: 1, publishedAt: '2026-10-10T08:00:00Z' },
    cookies: { title: 'מדיניות עוגיות', slug: 'cookies', version: 1, publishedAt: '2026-10-10T08:00:00Z' },
  },
  cookiePolicyVersion: 1,
};

const MARKDOWN = [
  '# הצהרת נגישות',
  '',
  'רויאל רואה חשיבות במתן שירות נגיש.',
  '',
  '## רכז/ת הנגישות',
  '- שם: דנה לוי',
  '- טלפון: 050-1234567',
  '',
  '## תאריכים',
  '**תאריך הבדיקה האחרונה:** 01.10.2026',
].join('\n');

function audit(element: ReactElement) {
  const html = renderToStaticMarkup(element);
  return { html, result: auditHtml(html) };
}

function assertClean(name: string, element: ReactElement) {
  const { result } = audit(element);
  assert.equal(result.violations.length, 0, `${name}:\n${formatViolations(result)}`);
}

function SamplePage() {
  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <h1 className="text-2xl font-bold">תפריט</h1>
      <p>מנות היום.</p>
      <form aria-label="הזמנה">
        <label htmlFor="name">שם</label>
        <input id="name" autoComplete="name" />
        <MarketingConsent businessName="רויאל" value={initialMarketingConsent('sms', 'רויאל')} onChange={() => undefined} privacyHref="/legal/c1/privacy" />
        <button type="submit" className="rounded-lg focus-visible:outline focus-visible:outline-2">
          שליחה
        </button>
      </form>
    </div>
  );
}

describe('public templates pass the a11y checklist (he RTL, en LTR)', () => {
  for (const lang of LANGS) {
    it(`PublicPageShell with banner, toolbar and footer — ${lang}`, () => {
      const el = (
        <PublicPageShell companyId="c1" shopId="s1" lang={lang} legal={LEGAL} a11yToolbar consentForceOpen="banner">
          <SamplePage />
        </PublicPageShell>
      );
      assertClean('shell', el);
      const { html } = audit(el);
      assert.match(html, new RegExp(`data-public-root="" lang="${lang}" dir="${lang === 'he' ? 'rtl' : 'ltr'}"`));
      assert.match(html, /href="#public-main"/);
      for (const kind of ['accessibility', 'privacy', 'terms', 'cookies']) {
        assert.ok(html.includes(`/legal/c1/${kind}?shop=s1`), kind);
      }
    });

    it(`cookie settings dialog (modal, labelled, three categories) — ${lang}`, () => {
      const el = <CookieConsent companyId="c1" policyVersion={1} lang={lang} cookiePolicyHref="/legal/c1/cookies" forceOpen="settings" />;
      assertClean('settings', el);
      const { html } = audit(el);
      assert.match(html, /role="dialog" aria-modal="true"/);
      assert.equal((html.match(/type="checkbox"/g) ?? []).length, 3);
      assert.match(html, /disabled=""/, 'essential is fixed on');
    });

    it(`accessibility toolbar, open, with its "does not replace conformance" note — ${lang}`, () => {
      const el = <A11yToolbar lang={lang} statementHref="/legal/c1/accessibility" defaultOpen />;
      assertClean('toolbar', el);
      const { html } = audit(el);
      assert.ok(html.includes(lang === 'he' ? 'אינו מחליף' : 'does not replace'));
      assert.match(html, /aria-pressed="false"/);
    });

    it(`footer, markdown, marketing box, contrast validator — ${lang}`, () => {
      assertClean('footer', <LegalFooter companyId="c1" lang={lang} businessName="רויאל" />);
      assertClean('markdown', <LegalMarkdown text={MARKDOWN} />);
      assertClean('marketing', <MarketingConsent businessName="רויאל" lang={lang} value={initialMarketingConsent('email', 'רויאל')} channel="email" onChange={() => undefined} />);
      assertClean('contrast ok', <ContrastValidator lang={lang} theme={{}} />);
      assertClean('contrast failing', <ContrastValidator lang={lang} theme={{ textColor: '#BBBBBB', buttonColor: '#FACC15' }} />);
    });
  }
});

describe('what the public components promise', () => {
  it('the marketing box is never ticked in advance and sits apart from the order', () => {
    const { html } = audit(<MarketingConsent businessName="רויאל" value={initialMarketingConsent('sms', 'רויאל')} onChange={() => undefined} />);
    assert.ok(!/checked=""/.test(html));
    assert.match(html, /<fieldset/);
    assert.match(html, /ההזמנה מוכנה/);
  });

  it('the contrast validator states pass / fail in text, not only colour', () => {
    const { html } = audit(<ContrastValidator theme={{ textColor: '#BBBBBB' }} />);
    assert.ok(html.includes('לא עובר') && html.includes('לא ניתן לפרסם'));
  });

  it('nothing optional renders on the server, even when the gate already allows it', () => {
    const gate = createConsentGate({ storage: memoryStorage(), randomBytes: (n) => new Uint8Array(n) }, { companyId: 'c1', policyVersion: 0, surface: 'menu' });
    gate.acceptAll();
    const html = renderToStaticMarkup(
      <ConsentGateProvider gate={gate}>
        <ConsentGate category="analytics" fallback={<span>no</span>}>
          <span>tracking</span>
        </ConsentGate>
      </ConsentGateProvider>,
    );
    assert.equal(html, '<span>no</span>');
  });

  it('the footer lists only the published pages, and always the cookie settings', () => {
    const { html } = audit(<LegalFooter companyId="c1" published={{ privacy: true }} />);
    assert.ok(html.includes('/legal/c1/privacy'));
    assert.ok(!html.includes('/legal/c1/terms'));
    assert.ok(html.includes('הגדרות עוגיות'));
  });

  it('the checklist bites: a broken template fails it', () => {
    const broken = (
      <div className="ml-4">
        {/* eslint-disable-next-line jsx-a11y/alt-text, @next/next/no-img-element -- the failure under test */}
        <img src="dish.jpg" />
        <button className="outline-none">
          <svg aria-hidden="true" />
        </button>
        <input placeholder="טלפון" />
        <span className="animate-pulse">מבצע!</span>
      </div>
    );
    const rules = audit(broken).result.violations.map((v) => v.rule).sort();
    assert.deepEqual(rules, ['button-name', 'focus-visible', 'image-alt', 'label', 'motion-reduce', 'rtl-logical']);
  });
});
