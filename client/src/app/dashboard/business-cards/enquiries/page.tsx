'use client';

/**
 * "פניות מכרטיסי ביקור" — the enquiries the cards' forms stored (no CRM is connected): filter by
 * card / state / text, read, mark handled or archive. Contact details are shown only here, to the
 * users whose scope covers the card.
 */
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Mail, Phone } from 'lucide-react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useState } from 'react';
import { toast } from 'sonner';

import { NativeSelect } from '@/components/dashboard/business-cards/bc-ui';
import { NS } from '@/components/dashboard/business-cards/field-editors';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { listCards, listEnquiries, updateEnquiry, type EnquiryRow } from '@/lib/businessCardsApi';
import { canAccess } from '@/lib/dashboardAccess';
import { useDashboardAccess } from '@/lib/dashboardAccessApi';
import { formatDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';

const STATUSES = ['new', 'handled', 'archived'] as const;

export default function CardEnquiriesPage() {
  const t = useTranslations(`${NS}.inbox`);
  const tn = useTranslations(NS);
  const qc = useQueryClient();
  const mayEdit = canAccess(useDashboardAccess(), 'business_cards', 'edit');
  const [cardId, setCardId] = useState('');
  const [status, setStatus] = useState<'' | (typeof STATUSES)[number]>('new');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<string | null>(null);

  const cards = useQuery({ queryKey: ['business-cards', 'all-for-inbox'], queryFn: () => listCards({ includeArchived: true }) });
  const list = useQuery({
    queryKey: ['business-card-enquiries', cardId, status, q],
    queryFn: () => listEnquiries({ cardId: cardId || undefined, status: status || undefined, q: q.trim() || undefined }),
    placeholderData: keepPreviousData,
  });
  const update = useMutation({
    mutationFn: ({ id, s }: { id: string; s: EnquiryRow['status'] }) => updateEnquiry(id, s),
    onSuccess: () => {
      toast.success(t('updated'));
      void qc.invalidateQueries({ queryKey: ['business-card-enquiries'] });
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, tn('errors.generic'))),
  });
  const counts = list.data?.counts ?? {};

  return (
    <div className="space-y-4">
      <div>
        <Link href="/dashboard/business-cards" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:underline">
          <ChevronRight aria-hidden className="size-3.5" />
          {t('back')}
        </Link>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>
      <div className="flex flex-wrap items-end gap-2 rounded-xl border bg-card p-3">
        <div role="tablist" aria-label={t('status')} className="inline-flex gap-1 rounded-lg bg-muted p-1">
          {(['', ...STATUSES] as const).map((s) => (
            <button
              key={s || 'all'}
              type="button"
              role="tab"
              aria-selected={status === s}
              onClick={() => setStatus(s)}
              className={cn('h-7 rounded-md px-2.5 text-[0.8rem] font-medium', status === s ? 'bg-background shadow-sm' : 'text-muted-foreground')}
            >
              {s ? t(`statuses.${s}`) : tn('any')}
              {s && counts[s] ? <span className="ms-1 tabular-nums">({counts[s]})</span> : null}
            </button>
          ))}
        </div>
        <NativeSelect
          label={t('card')}
          value={cardId}
          onChange={setCardId}
          className="w-56"
          options={[{ value: '', label: t('allCards') }, ...(cards.data ?? []).map((c) => ({ value: c.id, label: c.name }))]}
        />
        <div className="min-w-48 flex-1 space-y-1">
          <label htmlFor="bc-inbox-q" className="text-xs font-medium">
            {t('search')}
          </label>
          <Input id="bc-inbox-q" value={q} onChange={(e) => setQ(e.target.value)} maxLength={100} />
        </div>
      </div>
      <div className="rounded-xl border bg-card">
        {list.isLoading ? (
          <div className="space-y-2 p-3">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-6 w-full" />
          </div>
        ) : null}
        {list.data && !list.data.items.length ? <p className="p-6 text-center text-sm text-muted-foreground">{t('none')}</p> : null}
        <ul className="divide-y">
          {list.data?.items.map((e) => (
            <li key={e.id} className="p-3">
              <button type="button" className="flex w-full flex-wrap items-center justify-between gap-2 text-start" aria-expanded={open === e.id} onClick={() => setOpen(open === e.id ? null : e.id)}>
                <span className="min-w-0">
                  <span className="font-semibold">{e.name || '—'}</span>
                  <span className="ms-2 text-xs text-muted-foreground">
                    {e.cardName} · {e.createdAt ? formatDateTime(e.createdAt) : ''}
                  </span>
                  {e.topic ? <span className="ms-2 text-xs">· {e.topic}</span> : null}
                </span>
                <Badge variant={e.status === 'new' ? 'default' : 'secondary'}>{t(`statuses.${e.status}`)}</Badge>
              </button>
              {open === e.id ? (
                <div className="mt-2 space-y-2 text-sm">
                  <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-[8rem_1fr]">
                    <dt className="text-muted-foreground">{t('contact')}</dt>
                    <dd className="flex flex-wrap gap-3">
                      {e.phone ? (
                        <a href={`tel:${e.phone}`} dir="ltr" className="inline-flex items-center gap-1 underline">
                          <Phone aria-hidden className="size-3.5" />
                          {e.phoneDisplay}
                        </a>
                      ) : null}
                      {e.email ? (
                        <a href={`mailto:${e.email}`} dir="ltr" className="inline-flex items-center gap-1 underline">
                          <Mail aria-hidden className="size-3.5" />
                          {e.email}
                        </a>
                      ) : null}
                    </dd>
                    {e.message ? (
                      <>
                        <dt className="text-muted-foreground">{t('message')}</dt>
                        <dd className="whitespace-pre-wrap">{e.message}</dd>
                      </>
                    ) : null}
                    <dt className="text-muted-foreground">{t('source')}</dt>
                    <dd>
                      {e.source ?? '—'}
                      {e.campaign ? ` · ${t('campaign')}: ${e.campaign}` : ''}
                    </dd>
                    <dt className="text-muted-foreground">{t('consent')}</dt>
                    <dd className="text-xs">
                      {e.consentedAt ? formatDateTime(e.consentedAt) : ''}
                      {e.consentPrivacyUrl ? (
                        <a href={e.consentPrivacyUrl} target="_blank" rel="noopener noreferrer" dir="ltr" className="ms-2 underline">
                          {e.consentPrivacyUrl}
                        </a>
                      ) : null}
                    </dd>
                  </dl>
                  {mayEdit ? (
                    <div className="flex flex-wrap gap-1.5">
                      {e.status !== 'handled' ? (
                        <Button type="button" size="sm" disabled={update.isPending} onClick={() => update.mutate({ id: e.id, s: 'handled' })}>
                          {t('markHandled')}
                        </Button>
                      ) : null}
                      {e.status !== 'new' ? (
                        <Button type="button" size="sm" variant="outline" disabled={update.isPending} onClick={() => update.mutate({ id: e.id, s: 'new' })}>
                          {t('markNew')}
                        </Button>
                      ) : null}
                      {e.status !== 'archived' ? (
                        <Button type="button" size="sm" variant="ghost" disabled={update.isPending} onClick={() => update.mutate({ id: e.id, s: 'archived' })}>
                          {t('archive')}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
