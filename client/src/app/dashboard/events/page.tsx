'use client';

/**
 * Events ("אירועים", docs/SPEC_EVENTS.md): a shop with many tills splits them into
 * temporary events — at report level only; nothing changes on the tills, the documents,
 * the shifts or the Z. Each event is a name, a window (date + hour, both ends) and a set
 * of the shop's tills, and has a producer report with insights, reconciliations and an
 * Excel export. Confirming it ("נותן תוקף") freezes the report and releases the tills.
 *
 * This page: the events of the shop in scope, a create / edit dialog, and choosing two or
 * more to compare.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarClock, ChevronLeft, GitCompareArrows, Pencil, Plus, Store, Trash2 } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { usePageScope } from '@/lib/scope';
import { deleteEvent, eventErrorMessage, fetchEvents, type EventListItem, type ReportEvent } from '@/lib/eventsApi';
import { clockLabel, compareIds, durationText } from '@/lib/eventReport';
import { cn } from '@/lib/utils';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { Card, InsightsSurface, Muted, SectionHeader, Segmented, SkeletonCard } from '@/components/dashboard/insights/ios';
import { EventFormDialog } from '@/components/dashboard/events/event-form-dialog';
import { StatusChip, money } from '@/components/dashboard/events/event-parts';
import { LiveEventLink } from '@/components/dashboard/event-live/live-event-link';
import { Button } from '@/components/ui/button';

const WRITE_ROLES = new Set(['super_admin', 'distributor', 'company_manager', 'shop_manager']);
type Filter = 'all' | 'draft' | 'confirmed';

export default function EventsPage() {
  const t = useTranslations('events');
  const tc = useTranslations('common');
  const router = useRouter();
  const qc = useQueryClient();
  const role = useAuth((s) => s.user?.role);
  const canWrite = !!role && WRITE_ROLES.has(role);
  const { scope, resolution, effective } = usePageScope({ maxLevel: 'shop', minLevel: 'shop' });
  const shopId = effective.shopId ?? '';
  const shopName = scope.shop?.name ?? '';

  const [filter, setFilter] = useState<Filter>('all');
  // `?compare=<id>`: the event page's "השוואה" arrives with that event already chosen.
  const searchParams = useSearchParams();
  const [selected, setSelected] = useState<string[]>(() => {
    const first = searchParams.get('compare');
    return first ? [first] : [];
  });
  const [dialog, setDialog] = useState<{ open: boolean; event: ReportEvent | null }>({ open: false, event: null });

  const events = useQuery<EventListItem[]>({
    queryKey: ['events', shopId],
    queryFn: () => fetchEvents({ shopId }),
    enabled: Boolean(shopId),
  });

  const remove = useMutation({
    mutationFn: (id: string) => deleteEvent(id),
    onSuccess: () => {
      toast.success(t('deleted'));
      void qc.invalidateQueries({ queryKey: ['events'] });
    },
    onError: (err) => toast.error(eventErrorMessage(err, tc('error'))),
  });

  const list = (events.data ?? []).filter((e) => filter === 'all' || e.status === filter);
  const compare = compareIds(selected);
  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  return (
    <InsightsSurface className="print:bg-white">
      <div className="flex flex-wrap items-end justify-between gap-3 px-1">
        <div className="min-w-0">
          <p className="flex items-center gap-1 truncate text-[13px] font-semibold uppercase tracking-wide text-[#8E8E93]">
            <Store className="h-3.5 w-3.5" aria-hidden />
            {shopName || t('pickShop')}
          </p>
          <h1 className="text-[34px] font-bold leading-tight tracking-tight">{t('title')}</h1>
          <p className="text-[15px] text-[#8E8E93]">{t('subtitle')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {compare ? (
            <Button variant="outline" onClick={() => router.push(`/dashboard/events/compare?ids=${compare}`)}>
              <GitCompareArrows className="h-4 w-4" aria-hidden />
              {t('compareSelected', { count: selected.length })}
            </Button>
          ) : null}
          {canWrite && shopId ? (
            <Button onClick={() => setDialog({ open: true, event: null })}>
              <Plus className="h-4 w-4" aria-hidden />
              {t('new')}
            </Button>
          ) : null}
        </div>
      </div>

      <ScopeGate resolution={resolution}>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-2 px-1">
          <Segmented
            value={filter}
            onChange={setFilter}
            className="w-72"
            label={t('filterLabel')}
            options={[
              { id: 'all', label: t('filter.all') },
              { id: 'draft', label: t('filter.draft') },
              { id: 'confirmed', label: t('filter.confirmed') },
            ]}
          />
          <span className="text-[13px] text-[#8E8E93]">{t('compareHint')}</span>
        </div>

        <SectionHeader>{t('listTitle')}</SectionHeader>
        {events.isLoading ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <SkeletonCard key={i} className="h-40" />
            ))}
          </div>
        ) : events.isError ? (
          <Card className="flex items-center justify-between gap-3">
            <Muted>{eventErrorMessage(events.error, t('loadError'))}</Muted>
            <button type="button" onClick={() => void events.refetch()} className="text-[15px] text-[#007AFF]">
              {t('retry')}
            </button>
          </Card>
        ) : list.length === 0 ? (
          <Card className="flex flex-col items-center gap-3 py-10 text-center">
            <CalendarClock className="h-10 w-10 text-[#007AFF]" aria-hidden />
            <p className="text-[17px] font-semibold">{t('empty')}</p>
            <Muted className="max-w-md">{t('emptyHint')}</Muted>
            {canWrite ? (
              <Button onClick={() => setDialog({ open: true, event: null })}>
                <Plus className="h-4 w-4" aria-hidden />
                {t('new')}
              </Button>
            ) : null}
          </Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {list.map((e) => {
              const tz = e.timezone;
              const isSelected = selected.includes(e.id);
              return (
                <Card key={e.id} className={cn('flex flex-col gap-3 transition-shadow', isSelected && 'ring-2 ring-[#007AFF]')}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <Link href={`/dashboard/events/${e.id}`} className="block truncate text-[19px] font-semibold hover:underline">
                        {e.name}
                      </Link>
                      <p className="text-[13px] text-[#8E8E93]" dir="rtl">
                        {clockLabel(e.startsAt, tz, true)} – {clockLabel(e.endsAt, tz, true)} · {durationText(e.durationMinutes)}
                      </p>
                    </div>
                    <StatusChip status={e.status} />
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-[14px]">
                    <span>{t('tillsCount', { count: e.machineIds.length })}</span>
                    {e.producerName ? <span className="text-[#8E8E93]">{t('producer', { name: e.producerName })}</span> : null}
                  </div>
                  <div className="text-[13px] text-[#8E8E93]">
                    {e.machines.map((m) => m.name).join(' · ') || '—'}
                  </div>
                  {e.summary ? (
                    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                      <span className="text-[22px] font-bold tabular-nums">{money(e.summary.net)}</span>
                      <span className="text-[13px] text-[#8E8E93]">
                        {t('summaryLine', { sales: e.summary.salesCount, avg: money(e.summary.avgTicket) })}
                      </span>
                      {e.summary.alerts ? <span className="text-[13px] font-semibold text-[#FF3B30]">{t('alerts', { count: e.summary.alerts })}</span> : null}
                    </div>
                  ) : (
                    <p className="text-[13px] text-[#8E8E93]">{t('liveHint')}</p>
                  )}
                  <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-[#3C3C4320] pt-3 dark:border-[#54545866]">
                    <label className="flex items-center gap-2 text-[13px]">
                      <input type="checkbox" className="h-4 w-4 accent-[#007AFF]" checked={isSelected} onChange={() => toggle(e.id)} />
                      {t('select')}
                    </label>
                    <div className="flex items-center gap-1">
                      {canWrite && e.status === 'draft' ? (
                        <>
                          <Button variant="ghost" size="sm" onClick={() => setDialog({ open: true, event: e })} aria-label={t('edit')}>
                            <Pencil className="h-4 w-4" aria-hidden />
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={t('delete')}
                            disabled={remove.isPending}
                            onClick={() => {
                              if (window.confirm(t('deleteConfirm', { name: e.name }))) remove.mutate(e.id);
                            }}
                          >
                            <Trash2 className="h-4 w-4 text-[#FF3B30]" aria-hidden />
                          </Button>
                        </>
                      ) : null}
                      <LiveEventLink eventId={e.id} />
                      <Link
                        href={`/dashboard/events/${e.id}`}
                        className="flex items-center gap-0.5 rounded-lg px-2 py-1 text-[15px] font-medium text-[#007AFF] hover:bg-[#007AFF]/10"
                      >
                        {t('open')}
                        <ChevronLeft className="h-4 w-4" aria-hidden />
                      </Link>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </ScopeGate>

      {shopId ? (
        <EventFormDialog
          open={dialog.open}
          onOpenChange={(open) => setDialog((d) => ({ ...d, open }))}
          shopId={shopId}
          shopName={shopName}
          event={dialog.event}
          onSaved={(saved) => {
            if (!dialog.event) router.push(`/dashboard/events/${saved.id}`);
          }}
        />
      ) : null}
    </InsightsSurface>
  );
}
