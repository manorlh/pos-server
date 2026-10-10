'use client';

/**
 * The footer of every public page: the accessibility statement, privacy policy, terms and cookie
 * policy of the business (only the published ones — `published`), and "הגדרות עוגיות", which reopens
 * the consent settings at any time (the gate's `openSettings`).
 */
import { LEGAL_KINDS, LEGAL_TITLES, legalPagePath, type LegalKind } from '../../lib/legalDocs';
import { useConsentGateInstance } from './ConsentGate';
import { stringsFor, type PublicLang } from './strings';

const LINK =
  'rounded underline underline-offset-2 hover:text-slate-950 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700';

export interface LegalFooterProps {
  companyId: string;
  shopId?: string | null;
  lang?: PublicLang;
  /** Which kinds are published (from the public index). Omitted = link all four. */
  published?: Partial<Record<LegalKind, unknown>> | null;
  businessName?: string | null;
  /** Override the page path builder (e.g. a business's own domain later). */
  hrefFor?: (kind: LegalKind) => string;
  /** Show the "הגדרות עוגיות" button (default true). */
  showCookieSettings?: boolean;
}

export function LegalFooter({
  companyId,
  shopId,
  lang = 'he',
  published,
  businessName,
  hrefFor,
  showCookieSettings = true,
}: LegalFooterProps) {
  const t = stringsFor(lang);
  const gate = useConsentGateInstance();
  const kinds = LEGAL_KINDS.filter((k) => !published || published[k]);
  const href = hrefFor ?? ((kind: LegalKind) => legalPagePath(companyId, kind, shopId));

  return (
    <footer className="border-t border-slate-300 bg-slate-50 px-4 py-6 text-sm text-slate-800">
      <nav aria-label={t.footerLabel} className="mx-auto max-w-3xl">
        <ul className="flex flex-wrap items-center gap-x-4 gap-y-2">
          {kinds.map((kind) => (
            <li key={kind}>
              <a href={href(kind)} className={LINK}>
                {LEGAL_TITLES[lang][kind]}
              </a>
            </li>
          ))}
          {showCookieSettings ? (
            <li>
              <button type="button" className={LINK} onClick={() => gate.openSettings()}>
                {t.cookieSettings}
              </button>
            </li>
          ) : null}
        </ul>
        {businessName ? <p className="mt-3 text-slate-700">© {businessName}</p> : null}
      </nav>
    </footer>
  );
}
