'use client';

/**
 * The products list's "זמינות" column: one line per product — "פעיל בכל החברה",
 * "פעיל ב-3/4 סניפים · חסום בקופה 4" — and, on click, the full company › shop › point
 * of sale › till tree in a dialog (`ProductAvailabilitySection`, the same editor the
 * product dialog shows).
 *
 * The counts come from `POST /products/availability-summary`, one request for the
 * whole page. Nothing here resolves a level itself; it only words the server's counts.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, Lock } from 'lucide-react';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { AvailabilityException, ProductAvailabilitySummary } from '@/lib/types';
import { ProductAvailabilitySection } from '@/components/dashboard/product-availability';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export const AVAILABILITY_SUMMARY_KEY = 'product-availability-summary';

/** Summaries for one page of products, by id. Local copies have none. */
export function useAvailabilitySummaries(productIds: string[]) {
  return useQuery<Record<string, ProductAvailabilitySummary>>({
    queryKey: [AVAILABILITY_SUMMARY_KEY, productIds],
    enabled: productIds.length > 0,
    queryFn: () =>
      api
        .post<{ items: ProductAvailabilitySummary[] }>('/products/availability-summary', { productIds })
        .then((r) => Object.fromEntries(r.data.items.map((s) => [s.productId, s]))),
  });
}

type Translate = ReturnType<typeof useTranslations>;

function exceptionPlace(e: AvailabilityException, t: Translate): string {
  switch (e.level) {
    case 'machine':
      return e.posNumber ? t('placeTill', { number: e.posNumber }) : (e.name ?? '');
    case 'area':
      return t('placeArea', { name: e.name ?? '' });
    case 'shop':
      return t('placeShop', { name: e.name ?? '' });
    default:
      return t('placeCompany', { name: e.name ?? '' });
  }
}

/** The words for one summary: a headline, its tone, and the first lock (if any). */
export function describeSummary(s: ProductAvailabilitySummary, t: Translate) {
  const locks = s.exceptions.filter((e) => !e.value);
  const firstLock = locks[0] ? t('lockedAt', { place: exceptionPlace(locks[0], t) }) : null;
  const moreExceptions = Math.max(0, s.exceptionCount - (firstLock ? 1 : 0));

  if (s.shopCount === 0) {
    return { headline: t('notAssigned'), tone: 'muted' as const, detail: null, more: 0 };
  }
  const allActive =
    s.activeShopCount === s.shopCount &&
    s.activeMachineCount === s.machineCount &&
    s.activeAreaCount === s.areaCount;
  if (allActive) {
    return {
      headline: s.companyCount > 1 ? t('activeEverywhereCompanies', { count: s.companyCount }) : t('activeEverywhere'),
      tone: 'ok' as const,
      detail: null,
      more: s.exceptionCount,
    };
  }
  if (s.activeShopCount === 0 && s.activeMachineCount === 0) {
    return { headline: t('lockedEverywhere'), tone: 'locked' as const, detail: null, more: 0 };
  }
  const parts: string[] = [];
  parts.push(
    s.activeShopCount === s.shopCount
      ? t('allShops')
      : t('activeShops', { active: s.activeShopCount, total: s.shopCount }),
  );
  if (s.machineCount > 0 && s.activeMachineCount < s.machineCount) {
    parts.push(t('activeTills', { active: s.activeMachineCount, total: s.machineCount }));
  }
  return { headline: parts.join(' · '), tone: 'partial' as const, detail: firstLock, more: moreExceptions };
}

export function AvailabilitySummaryCell({
  productId,
  productName,
  summary,
  isLoading,
  applicable,
}: {
  productId: string;
  productName: string;
  summary?: ProductAvailabilitySummary;
  isLoading: boolean;
  /** Only a global product has a tree; a local copy shows a dash. */
  applicable: boolean;
}) {
  const t = useTranslations('productsList.availability');
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);

  if (!applicable) return <span className="text-muted-foreground">—</span>;
  if (isLoading && !summary) return <span className="text-xs text-muted-foreground">{t('loading')}</span>;
  if (!summary) return <span className="text-muted-foreground">—</span>;

  const d = describeSummary(summary, t);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="group flex max-w-64 items-start gap-1 rounded-md text-start text-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        title={t('openTree')}
      >
        <span className="min-w-0">
          <span
            className={cn(
              'block',
              d.tone === 'ok' && 'text-foreground',
              d.tone === 'partial' && 'text-amber-700 dark:text-amber-400',
              d.tone === 'locked' && 'text-destructive',
              d.tone === 'muted' && 'text-muted-foreground',
            )}
          >
            {d.tone === 'locked' ? <Lock className="me-1 inline h-3 w-3" aria-hidden /> : null}
            {d.headline}
          </span>
          {d.detail || d.more > 0 ? (
            <span className="block text-xs text-muted-foreground">
              {d.detail}
              {d.detail && d.more > 0 ? ' · ' : null}
              {d.more > 0 ? t('moreExceptions', { count: d.more }) : null}
            </span>
          ) : null}
        </span>
        <ChevronLeft className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100" aria-hidden />
      </button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          // The tree may have been edited; the line must follow.
          if (!next) qc.invalidateQueries({ queryKey: [AVAILABILITY_SUMMARY_KEY] });
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('treeTitle', { name: productName })}</DialogTitle>
          </DialogHeader>
          {open ? <ProductAvailabilitySection productId={productId} /> : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
