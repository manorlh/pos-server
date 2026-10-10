'use client';

/**
 * "בדיקת פרסום": per public channel (digital menu, business card, online ordering), are the legal
 * pages it needs published for this company / shop — the server's gate (`GET
 * /digital-legal/publication-check`), the same one the channels' publish routes call.
 */
import { useTranslations } from 'next-intl';
import { useQueries } from '@tanstack/react-query';
import { fetchPublicationCheck } from '@/lib/digitalLegalApi';
import type { DigitalProduct } from '@/lib/legalDocs';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

const NS = 'digitalLegal.publication';
const PRODUCTS: DigitalProduct[] = ['menu', 'card', 'online'];

export function PublicationPanel({ companyId, shopId }: { companyId: string; shopId: string | null }) {
  const t = useTranslations(NS);
  const checks = useQueries({
    queries: PRODUCTS.map((product) => ({
      queryKey: ['digital-legal', 'publication-check', companyId, shopId, product],
      queryFn: () => fetchPublicationCheck({ companyId, shopId }, product),
    })),
  });

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">{t('intro')}</p>
      <div className="grid gap-3 md:grid-cols-3">
        {PRODUCTS.map((product, i) => {
          const q = checks[i];
          return (
            <Card key={product}>
              <CardHeader>
                <CardTitle className="text-base">{t(`products.${product}`)}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2 text-sm">
                {q.isLoading || !q.data ? (
                  <Skeleton className="h-16 w-full" />
                ) : (
                  <>
                    <p className={q.data.blocking.some((b) => b.code === 'legal_missing') ? 'font-medium text-red-800 dark:text-red-300' : 'font-medium text-green-800 dark:text-green-300'}>
                      {q.data.blocking.some((b) => b.code === 'legal_missing') ? `✗ ${t('blocked')}` : `✓ ${t('ok')}`}
                    </p>
                    <ul className="space-y-0.5">
                      {Object.entries(q.data.legal).map(([kind, entry]) => (
                        <li key={kind}>
                          {entry.published
                            ? `✓ ${t('published', { title: entry.title, version: entry.version ?? '' })}`
                            : `✗ ${t('missing', { title: entry.title })}`}
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
