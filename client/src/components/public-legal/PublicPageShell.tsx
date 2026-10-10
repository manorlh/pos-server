'use client';

/**
 * The frame of EVERY public page (digital menu, online ordering, business card, legal pages):
 *
 * * `lang` + `dir` (Hebrew RTL / English LTR) on the root, marked `data-public-root` (the a11y rule
 *   set checks it has a `main`);
 * * a "דלג לתוכן" skip link to `<main id="public-main">`;
 * * `LegalFooter` — the published legal pages and "הגדרות עוגיות";
 * * `CookieConsent` — configured for the business and its published cookie-policy version, so the
 *   consent gate (lib/consentGate.ts) allows nothing optional until the visitor chooses;
 * * the optional `A11yToolbar` (`a11yToolbar`), whose preferences become `data-a11y-*` here.
 *
 * Reduced motion: the root honours `prefers-reduced-motion` (app/globals.css), and the toolbar's
 * "עצירת אנימציות" stops animations on request.
 *
 * `legal` — the public legal index (`GET /public/v1/legal/{companyId}`); omitted, the shell fetches it.
 */
import { useEffect, useState, type ReactNode } from 'react';
import type { ConsentSurface } from '../../lib/consent';
import { fetchPublicLegalIndex, type PublicLegalIndex } from '../../lib/publicLegalApi';
import { a11yAttributes, DEFAULT_A11Y_PREFS } from '../../lib/a11yPrefs';
import { legalPagePath } from '../../lib/legalDocs';
import { A11yToolbar, useA11yPrefs, useRootFontSize } from './A11yToolbar';
import { CookieConsent } from './CookieConsent';
import { LegalFooter } from './LegalFooter';
import { dirOf, stringsFor, type PublicLang } from './strings';

export interface PublicPageShellProps {
  companyId: string;
  shopId?: string | null;
  lang?: PublicLang;
  surface?: ConsentSurface;
  /** The public legal index; `undefined` = fetch it, `null` = none (e.g. a preview). */
  legal?: PublicLegalIndex | null;
  /** Show the optional accessibility toolbar (off by default). */
  a11yToolbar?: boolean;
  /** The business name for the footer line. */
  businessName?: string | null;
  className?: string;
  /** Tests / previews: render the consent UI in this state. */
  consentForceOpen?: 'banner' | 'settings';
  children: ReactNode;
}

function useLegalIndex(companyId: string, shopId: string | null | undefined, lang: PublicLang, given: PublicLegalIndex | null | undefined) {
  const [fetched, setFetched] = useState<{ key: string; index: PublicLegalIndex | null } | null>(null);
  const key = `${companyId}|${shopId ?? ''}|${lang}`;
  useEffect(() => {
    if (given !== undefined) return;
    let alive = true;
    fetchPublicLegalIndex(companyId, shopId, lang).then(
      (index) => {
        if (alive) setFetched({ key, index });
      },
      () => {
        if (alive) setFetched({ key, index: null });
      },
    );
    return () => {
      alive = false;
    };
  }, [companyId, shopId, lang, key, given]);
  if (given !== undefined) return given;
  return fetched?.key === key ? fetched.index : null;
}

export function PublicPageShell({
  companyId,
  shopId,
  lang = 'he',
  surface = 'other',
  legal,
  a11yToolbar = false,
  businessName,
  className,
  consentForceOpen,
  children,
}: PublicPageShellProps) {
  const t = stringsFor(lang);
  const index = useLegalIndex(companyId, shopId, lang, legal);
  const storedPrefs = useA11yPrefs();
  const prefs = a11yToolbar ? storedPrefs : DEFAULT_A11Y_PREFS;
  useRootFontSize(prefs);
  const docs = index?.documents ?? {};
  const cookieHref = docs.cookies ? legalPagePath(companyId, 'cookies', shopId) : null;
  const statementHref = docs.accessibility ? legalPagePath(companyId, 'accessibility', shopId) : null;

  return (
    <div
      data-public-root=""
      lang={lang}
      dir={dirOf(lang)}
      {...a11yAttributes(prefs)}
      className={`flex min-h-dvh flex-col bg-white text-slate-900 ${className ?? ''}`.trim()}
    >
      <a
        href="#public-main"
        className="sr-only rounded-lg bg-white px-4 py-2 font-medium text-slate-900 focus:not-sr-only focus:fixed focus:start-2 focus:top-2 focus:z-[70] focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-700"
      >
        {t.skipToContent}
      </a>
      <main id="public-main" tabIndex={-1} className="flex-1">
        {children}
      </main>
      <LegalFooter
        companyId={companyId}
        shopId={shopId}
        lang={lang}
        published={docs}
        businessName={businessName ?? index?.businessName ?? null}
      />
      <CookieConsent
        companyId={companyId}
        policyVersion={index?.cookiePolicyVersion ?? 0}
        surface={surface}
        lang={lang}
        cookiePolicyHref={cookieHref}
        forceOpen={consentForceOpen}
      />
      {a11yToolbar ? <A11yToolbar lang={lang} statementHref={statementHref} /> : null}
    </div>
  );
}
