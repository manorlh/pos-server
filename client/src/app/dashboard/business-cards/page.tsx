'use client';

/**
 * "כרטיסי ביקור" — the cards of the selected scope: search and filters (type, state, template),
 * open / QR / duplicate / archive, the enquiries inbox, and "כרטיס חדש" (spec §27).
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ArchiveRestore, CopyPlus, ExternalLink, Inbox, Pencil, Plus, QrCode, Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { NativeSelect } from '@/components/dashboard/business-cards/bc-ui';
import { ShareDialog } from '@/components/dashboard/business-cards/card-dialogs';
import { CreateCardDialog } from '@/components/dashboard/business-cards/create-card-dialog';
import { NS } from '@/components/dashboard/business-cards/field-editors';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { CARD_STATUSES, CARD_TEMPLATES, CARD_TYPES } from '@/lib/businessCards';
import { duplicateCard, listCards, listEnquiries, setCardState, type CardRow } from '@/lib/businessCardsApi';
import { canAccess } from '@/lib/dashboardAccess';
import { useDashboardAccess } from '@/lib/dashboardAccessApi';
import { formatDateTime } from '@/lib/format';
import { usePageScope } from '@/lib/scope';

export default function BusinessCardsPage() {
  const t = useTranslations(NS);
  const qc = useQueryClient();
  const { resolution, effective } = usePageScope({ maxLevel: 'shop' });
  const mayEdit = canAccess(useDashboardAccess(), 'business_cards', 'edit');
  const [q, setQ] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [template, setTemplate] = useState('');
  const [archived, setArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const [share, setShare] = useState<CardRow | null>(null);

  const filters = { companyId: effective.companyId, shopId: effective.shopId, q: q.trim() || undefined, type, status, template, includeArchived: archived };
  const cards = useQuery({
    queryKey: ['business-cards', filters],
    queryFn: () => listCards(filters),
    enabled: resolution.status === 'ok',
    placeholderData: keepPreviousData,
  });
  const inbox = useQuery({ queryKey: ['business-card-enquiries', 'counts'], queryFn: () => listEnquiries({ status: 'new' }), enabled: resolution.status === 'ok' });
  const newCount = inbox.data?.counts?.new ?? 0;

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['business-cards'] });
  const dup = useMutation({
    mutationFn: (c: CardRow) => duplicateCard(c.id),
    onSuccess: (row) => {
      toast.success(t('duplicated', { name: row.name }));
      invalidate();
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, t('errors.generic'))),
  });
  const state = useMutation({
    mutationFn: ({ c, action }: { c: CardRow; action: 'archive' | 'restore' }) => setCardState(c.id, action),
    onSuccess: (_row, v) => {
      toast.success(t(v.action === 'archive' ? 'archived' : 'restored'));
      invalidate();
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, t('errors.generic'))),
  });

  const rows = cards.data ?? [];
  const filtered = !!(q || type || status || template);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/dashboard/business-cards/enquiries" className="inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-sm font-medium hover:bg-muted">
            <Inbox aria-hidden className="size-4" />
            {t('enquiries')}
            {newCount ? <Badge>{t('enquiriesNew', { count: newCount })}</Badge> : null}
          </Link>
          {mayEdit ? (
            <Button type="button" onClick={() => setCreating(true)}>
              <Plus aria-hidden />
              {t('newCard')}
            </Button>
          ) : null}
        </div>
      </div>

      <ScopeGate resolution={resolution}>
        <div className="flex flex-wrap items-end gap-2 rounded-xl border bg-card p-3">
          <div className="min-w-48 flex-1 space-y-1">
            <label htmlFor="bc-search" className="text-xs font-medium">
              {t('search')}
            </label>
            <div className="relative">
              <Search aria-hidden className="pointer-events-none absolute start-2 top-2 size-4 text-muted-foreground" />
              <Input id="bc-search" className="ps-8" value={q} onChange={(e) => setQ(e.target.value)} maxLength={100} />
            </div>
          </div>
          <NativeSelect label={t('filterType')} value={type} onChange={setType} options={[{ value: '', label: t('any') }, ...CARD_TYPES.map((v) => ({ value: v, label: t(`types.${v}`) }))]} className="w-36" />
          <NativeSelect label={t('filterStatus')} value={status} onChange={setStatus} options={[{ value: '', label: t('any') }, ...CARD_STATUSES.map((v) => ({ value: v, label: t(`statuses.${v}`) }))]} className="w-36" />
          <NativeSelect label={t('filterTemplate')} value={template} onChange={setTemplate} options={[{ value: '', label: t('any') }, ...CARD_TEMPLATES.map((v) => ({ value: v, label: t(`templates.${v}`) }))]} className="w-44" />
          <label className="flex h-8 items-center gap-2 text-sm">
            <input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} className="size-4" />
            {t('showArchived')}
          </label>
        </div>

        <div className="overflow-x-auto rounded-xl border bg-card">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="border-b bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 text-start font-medium">{t('colName')}</th>
                <th scope="col" className="px-3 py-2 text-start font-medium">{t('colType')}</th>
                <th scope="col" className="px-3 py-2 text-start font-medium">{t('colTarget')}</th>
                <th scope="col" className="px-3 py-2 text-start font-medium">{t('colStatus')}</th>
                <th scope="col" className="px-3 py-2 text-end font-medium">{t('colViews')}</th>
                <th scope="col" className="px-3 py-2 text-start font-medium">{t('colUpdated')}</th>
                <th scope="col" className="px-3 py-2">
                  <span className="sr-only">{t('edit')}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {cards.isLoading
                ? Array.from({ length: 3 }, (_, i) => (
                    <tr key={i} className="border-b">
                      <td colSpan={7} className="p-3">
                        <Skeleton className="h-6 w-full" />
                      </td>
                    </tr>
                  ))
                : rows.map((c) => (
                    <tr key={c.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="px-3 py-2">
                        <Link href={`/dashboard/business-cards/${c.id}`} className="font-semibold hover:underline">
                          {c.name}
                        </Link>
                        <div dir="ltr" className="text-start text-xs text-muted-foreground">
                          {c.publicPath}
                        </div>
                      </td>
                      <td className="px-3 py-2">{t(`types.${c.type}`)}</td>
                      <td className="px-3 py-2 text-xs">
                        {[c.companyName, c.shopName, c.areaName].filter(Boolean).join(' › ')}
                        {c.parentName ? <div className="text-muted-foreground">↳ {c.parentName}</div> : null}
                      </td>
                      <td className="px-3 py-2">
                        <Badge variant={c.status === 'published' ? 'default' : 'secondary'}>{t(`statuses.${c.status}`)}</Badge>
                        {c.publishedRevision && c.hasUnpublishedChanges ? <div className="mt-0.5 text-[0.7rem] text-amber-800 dark:text-amber-300">{t('unpublishedChanges')}</div> : null}
                        {!c.publishedRevision ? <div className="mt-0.5 text-[0.7rem] text-muted-foreground">{t('neverPublished')}</div> : null}
                      </td>
                      <td className="px-3 py-2 text-end tabular-nums">{c.stats30d?.view ?? 0}</td>
                      <td className="px-3 py-2 text-xs text-muted-foreground">{c.updatedAt ? formatDateTime(c.updatedAt) : ''}</td>
                      <td className="px-3 py-2">
                        <div className="flex justify-end gap-0.5" role="group" aria-label={t('rowActions', { name: c.name })}>
                          <Link href={`/dashboard/business-cards/${c.id}`} aria-label={`${t('edit')}: ${c.name}`} title={t('edit')} className="inline-flex size-7 items-center justify-center rounded-md hover:bg-muted">
                            <Pencil aria-hidden className="size-4" />
                          </Link>
                          {c.publishedRevision && c.status !== 'archived' ? (
                            <a href={c.publicPath} target="_blank" rel="noopener noreferrer" aria-label={`${t('openCard')}: ${c.name}`} title={t('openCard')} className="inline-flex size-7 items-center justify-center rounded-md hover:bg-muted">
                              <ExternalLink aria-hidden className="size-4" />
                            </a>
                          ) : null}
                          <Button type="button" size="icon-sm" variant="ghost" aria-label={`${t('qr')}: ${c.name}`} title={t('qr')} onClick={() => setShare(c)}>
                            <QrCode aria-hidden />
                          </Button>
                          {mayEdit ? (
                            <>
                              <Button type="button" size="icon-sm" variant="ghost" aria-label={`${t('duplicate')}: ${c.name}`} title={t('duplicate')} disabled={dup.isPending} onClick={() => dup.mutate(c)}>
                                <CopyPlus aria-hidden />
                              </Button>
                              {c.status === 'archived' ? (
                                <Button type="button" size="icon-sm" variant="ghost" aria-label={`${t('restore')}: ${c.name}`} title={t('restore')} onClick={() => state.mutate({ c, action: 'restore' })}>
                                  <ArchiveRestore aria-hidden />
                                </Button>
                              ) : (
                                <Button type="button" size="icon-sm" variant="ghost" aria-label={`${t('archive')}: ${c.name}`} title={t('archive')} onClick={() => state.mutate({ c, action: 'archive' })}>
                                  <Archive aria-hidden />
                                </Button>
                              )}
                            </>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
          {!cards.isLoading && !rows.length ? <p className="p-6 text-center text-sm text-muted-foreground">{filtered ? t('noMatch') : t('empty')}</p> : null}
        </div>
      </ScopeGate>

      {creating ? (
        <CreateCardDialog open={creating} onOpenChange={setCreating} defaultCompanyId={effective.companyId} defaultShopId={effective.shopId} />
      ) : null}
      {share ? <ShareDialog open={!!share} onOpenChange={(v) => !v && setShare(null)} card={share} canEdit={false} /> : null}
    </div>
  );
}
