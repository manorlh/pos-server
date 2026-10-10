'use client';

/**
 * One published legal page, inside the public shell. Loading / unavailable / retry are their own
 * states (never an endless spinner); the text is limited markdown rendered as text.
 */
import { useCallback, useEffect, useState } from 'react';
import { PublicPageShell } from '@/components/public-legal/PublicPageShell';
import { LegalMarkdown } from '@/components/public-legal/LegalMarkdown';
import { stringsFor } from '@/components/public-legal/strings';
import { fetchPublicLegalPage, type PublicLegalPage } from '@/lib/publicLegalApi';
import type { LegalKind, PublicLang } from '@/lib/legalDocs';

type Load = { status: 'loading' } | { status: 'ready'; page: PublicLegalPage } | { status: 'unavailable' };

function formatDate(iso: string | null, lang: PublicLang): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(lang === 'he' ? 'he-IL' : 'en-GB', { timeZone: 'Asia/Jerusalem' });
}

export function LegalPage({
  companyId,
  kind,
  shopId,
  lang,
}: {
  companyId: string;
  kind: LegalKind;
  shopId: string | null;
  lang: PublicLang;
}) {
  const t = stringsFor(lang);
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    fetchPublicLegalPage(companyId, kind, shopId, lang).then(
      (page) => {
        if (alive) setLoad({ status: 'ready', page });
      },
      () => {
        if (alive) setLoad({ status: 'unavailable' });
      },
    );
    return () => {
      alive = false;
    };
  }, [companyId, kind, shopId, lang, attempt]);

  const retry = useCallback(() => {
    setLoad({ status: 'loading' });
    setAttempt((n) => n + 1);
  }, []);

  return (
    <PublicPageShell companyId={companyId} shopId={shopId} lang={lang} surface="legal">
      <article className="mx-auto w-full max-w-3xl px-4 py-8">
        {load.status === 'loading' ? (
          <p role="status" className="text-slate-700">
            {t.loading}
          </p>
        ) : load.status === 'unavailable' ? (
          <div role="alert" className="space-y-3">
            <h1 className="text-2xl font-bold">{t.unavailable}</h1>
            <button
              type="button"
              onClick={retry}
              className="rounded-lg border border-slate-900 px-4 py-2 font-medium focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
            >
              {t.retry}
            </button>
          </div>
        ) : (
          <>
            <p className="mb-2 text-sm text-slate-700">{load.page.businessName}</p>
            <LegalMarkdown text={load.page.body} />
            <p className="mt-8 text-sm text-slate-700">
              {t.publishedOn(formatDate(load.page.publishedAt, lang), load.page.version)}
            </p>
          </>
        )}
      </article>
    </PublicPageShell>
  );
}
