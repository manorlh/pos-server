'use client';

/**
 * "הגדלות מכירה" (docs/SPEC_MENU_MODIFIERS.md §6): what the till suggests after a dish is
 * added — "add fries?", "make it a meal?" — as a small card that never stops the cashier.
 * Each rule with how it did over the last 30 days: shown, taken, the rate and what the
 * taken lines sold for. Server: `/menu/upsells`, `/reports/upsells`.
 *
 * Each rule shows its places ("איפה") and what starts it; the list filters by place (any of
 * the chosen), trigger type, active only and a search (rule name or item), all kept in the
 * URL query (lib/upsellFilters.ts) so a link keeps them.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Pencil, Plus, Search, Sparkles, Trash2 } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatCurrency } from '@/lib/format';
import { daysBackIso, todayIso } from '@/lib/reportWindow';
import { cn } from '@/lib/utils';
import { deleteUpsell, fetchUpsellReport, fetchUpsells, type UpsellReport, type UpsellRule } from '@/lib/menuApi';
import {
  EMPTY_UPSELL_FILTER,
  UPSELL_PLACES,
  UPSELL_TRIGGERS,
  filterUpsells,
  groupStepCodes,
  isEmptyUpsellFilter,
  parseUpsellFilter,
  placesOf,
  withUpsellFilter,
  type UpsellFilter,
} from '@/lib/upsellFilters';
import { UpsellEditorDialog } from '@/components/dashboard/menu/upsell-editor';
import { MenuBroadcastBanner } from '@/components/dashboard/menu/broadcast-banner';
import { IosCanvas, IosCard, IosChip, IosFootnote, IosSectionHeader, IosSwitch, IosTag, IosTextButton } from '@/components/dashboard/menu/ios';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

/** `list` with `item` switched on or off, in the canonical order of `all`. */
function toggled<T extends string>(all: readonly T[], list: readonly T[], item: T): T[] {
  return all.filter((x) => (x === item ? !list.includes(x) : list.includes(x)));
}

export default function UpsellsPage() {
  const t = useTranslations('upsells');
  const tw = useTranslations('promotions.weekdays');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [editing, setEditing] = useState<UpsellRule | null>(null);
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState<UpsellRule | null>(null);

  // The filters live in the URL query (`?place=quick,kiosk&trigger=transition&active=1&q=…`).
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filter = useMemo(() => parseUpsellFilter(searchParams), [searchParams]);
  // The search box answers every key; the URL follows a moment later. A query that changes
  // from elsewhere (back / forward, a link) is taken into the box; our own write is not.
  const [qDraft, setQDraft] = useState(filter.q);
  const [urlQ, setUrlQ] = useState(filter.q);
  const [writtenQ, setWrittenQ] = useState<string | null>(null);
  if (filter.q !== urlQ) {
    setUrlQ(filter.q);
    if (filter.q !== writtenQ) setQDraft(filter.q);
  }
  const qTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (qTimer.current) clearTimeout(qTimer.current);
    },
    [],
  );
  /** Change filters in the URL (the search text as typed so far included), the page's other keys kept. */
  const writeFilter = (patch: Partial<UpsellFilter>, q: string = qDraft) => {
    if (qTimer.current) clearTimeout(qTimer.current);
    // The live query, not this render's: a pending search write may have landed since.
    const search = window.location.search;
    const query = withUpsellFilter(search, { ...parseUpsellFilter(search), q, ...patch });
    setWrittenQ(parseUpsellFilter(query).q);
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  };
  const onSearch = (value: string) => {
    setQDraft(value);
    if (qTimer.current) clearTimeout(qTimer.current);
    qTimer.current = setTimeout(() => writeFilter({}, value), 300);
  };

  const { data, isLoading, isError, error } = useQuery({ queryKey: ['menu-upsells'], queryFn: fetchUpsells });
  const allRules = useMemo(() => data?.items ?? [], [data]);
  const rules = useMemo(() => filterUpsells(allRules, { ...filter, q: qDraft }), [allRules, filter, qDraft]);
  const filtered = !isEmptyUpsellFilter({ ...filter, q: qDraft });
  const stats = useQuery<UpsellReport>({
    queryKey: ['menu-upsells-stats'],
    queryFn: () => fetchUpsellReport({ from: daysBackIso(29), to: todayIso() }),
  });
  const byRule = useMemo(() => new Map((stats.data?.rows ?? []).map((r) => [r.ruleId, r])), [stats.data]);

  const remove = useMutation({
    mutationFn: (r: UpsellRule) => deleteUpsell(r.id),
    onSuccess: () => {
      toast.success(t('deleted'));
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: ['menu-upsells'] });
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const ts = useTranslations('specials.upsell');
  // What it offers: its options by name ("קולה / ספרייט / מים"), else its one product.
  const offered = (r: UpsellRule) =>
    (r.options?.length ? r.options.map((o) => o.name ?? '—').join(' / ') : r.productName) ?? '—';

  const whenText = (r: UpsellRule) => {
    const parts: string[] = [];
    if (r.weekdays?.length) parts.push(r.weekdays.map((d) => tw(String(d))).join(' '));
    if (r.startTime && r.endTime) parts.push(`${r.startTime}–${r.endTime}`);
    return parts.length ? parts.join(' · ') : t('always');
  };

  const scopeLabel = (r: UpsellRule) => (t.has(`scope.${r.triggerType}`) ? t(`scope.${r.triggerType}`) : r.triggerType);
  const stepLabel = (code: string) => (t.has(`steps.${code}`) ? t(`steps.${code}`) : code);
  // What starts it: its products / categories, or its steps ("כניסה למחלקה (שתייה, קינוחים)").
  const triggerText = (r: UpsellRule) =>
    r.triggerType === 'transition'
      ? groupStepCodes(r.triggerIds, r.triggerNames)
          .map((g) => (g.names.length ? `${stepLabel(g.step)} (${g.names.join(', ')})` : stepLabel(g.step)))
          .join(', ') || '—'
      : r.triggerNames.filter(Boolean).join(', ') || '—';

  const totals = stats.data?.totals;

  return (
    <div className="space-y-4">
      <MenuBroadcastBanner />
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        <p className="text-sm text-muted-foreground">{ts('example')}</p>
      </div>
      <IosCanvas>
        <div className="mx-auto max-w-3xl">
          {totals && totals.shown > 0 ? (
            <div className="grid grid-cols-3 gap-2">
              <IosCard className="p-3 text-center">
                <div className="text-[12px] text-[#6D6D72]">{t('stats.shown')}</div>
                <div className="text-[22px] font-bold tabular-nums">{totals.shown}</div>
              </IosCard>
              <IosCard className="p-3 text-center">
                <div className="text-[12px] text-[#6D6D72]">{t('stats.rate')}</div>
                <div className="text-[22px] font-bold tabular-nums text-[#34C759]">
                  {totals.acceptanceRate !== null ? `${Math.round(totals.acceptanceRate * 100)}%` : '—'}
                </div>
              </IosCard>
              <IosCard className="p-3 text-center">
                <div className="text-[12px] text-[#6D6D72]">{t('stats.revenue')}</div>
                <div className="text-[22px] font-bold tabular-nums">{formatCurrency(totals.revenue)}</div>
              </IosCard>
            </div>
          ) : null}
          <IosSectionHeader
            trailing={
              data?.canCreate ? (
                <IosTextButton
                  onClick={() => {
                    setEditing(null);
                    setOpen(true);
                  }}
                >
                  <Plus className="h-4 w-4" aria-hidden />
                  {t('new')}
                </IosTextButton>
              ) : null
            }
          >
            {t('header')}
          </IosSectionHeader>
          {allRules.length > 0 ? (
            <IosCard className="mb-2 space-y-2.5 p-3">
              <div className="relative">
                <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#8E8E93]" aria-hidden />
                <Input
                  type="search"
                  value={qDraft}
                  onChange={(e) => onSearch(e.target.value.slice(0, 100))}
                  placeholder={t('filters.search')}
                  aria-label={t('filters.search')}
                  className="ps-9"
                />
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="w-12 shrink-0 text-[12px] text-[#6D6D72]">{t('filters.place')}</span>
                {UPSELL_PLACES.map((p) => (
                  <IosChip key={p} on={filter.places.includes(p)} onClick={() => writeFilter({ places: toggled(UPSELL_PLACES, filter.places, p) })}>
                    {t(`places.${p}`)}
                  </IosChip>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="w-12 shrink-0 text-[12px] text-[#6D6D72]">{t('filters.trigger')}</span>
                {UPSELL_TRIGGERS.map((tr) => (
                  <IosChip
                    key={tr}
                    on={filter.triggers.includes(tr)}
                    onClick={() => writeFilter({ triggers: toggled(UPSELL_TRIGGERS, filter.triggers, tr) })}
                  >
                    {t(`scope.${tr}`)}
                  </IosChip>
                ))}
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-[15px]">{t('filters.activeOnly')}</span>
                <IosSwitch checked={filter.activeOnly} onChange={(v) => writeFilter({ activeOnly: v })} label={t('filters.activeOnly')} />
              </div>
              {filtered ? (
                <div className="flex items-center justify-between gap-3 text-[12px] text-[#6D6D72]">
                  <span>{t('filters.count', { shown: rules.length, total: allRules.length })}</span>
                  <IosTextButton
                    onClick={() => {
                      setQDraft('');
                      writeFilter(EMPTY_UPSELL_FILTER, '');
                    }}
                  >
                    {t('filters.clear')}
                  </IosTextButton>
                </div>
              ) : null}
            </IosCard>
          ) : null}
          {isLoading ? (
            <Skeleton className="h-40 w-full rounded-[22px]" />
          ) : isError ? (
            <p className="py-8 text-center text-sm text-[#FF3B30]">{axiosErrorToToastMessage(error, tc('error'))}</p>
          ) : allRules.length === 0 ? (
            <IosCard className="py-10 text-center text-[15px] text-[#6D6D72]">{t('empty')}</IosCard>
          ) : rules.length === 0 ? (
            <IosCard className="py-10 text-center text-[15px] text-[#6D6D72]">{t('filters.none')}</IosCard>
          ) : (
            <IosCard>
              {rules.map((r) => {
                const s = byRule.get(r.id);
                return (
                  <div
                    key={r.id}
                    className={cn(
                      'flex items-start gap-3 border-b border-black/[0.08] px-4 py-3 last:border-b-0 dark:border-white/[0.1]',
                      !r.isActive && 'opacity-60',
                    )}
                  >
                    <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[9px] bg-gradient-to-b from-[#FFCC00] to-[#FF9500] text-white">
                      <Sparkles className="h-4 w-4" aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[16px] font-semibold">{r.name}</span>
                        <IosTag tone={r.action === 'upgrade' ? 'blue' : 'green'}>{t(`action.${r.action}`)}</IosTag>
                        {/* "חלון בחירה", where and once per order — only when not as before. */}
                        {r.display === 'popup' || r.triggerType === 'order' || r.triggerType === 'transition' ? (
                          <IosTag tone="orange">{ts('tagPopup')}</IosTag>
                        ) : null}
                        {/* "איפה": every place of the rule. */}
                        {placesOf(r).map((p) => (
                          <IosTag key={p}>{t(`places.${p}`)}</IosTag>
                        ))}
                        {r.oncePerOrder ? <IosTag>{ts('tagOnce')}</IosTag> : null}
                        {!r.isActive ? <IosTag>{t('inactive')}</IosTag> : null}
                      </div>
                      <p className="text-[13px] text-[#3C3C43] dark:text-white/70">
                        {r.triggerType === 'order'
                          ? ts('flowOrder', { product: offered(r) })
                          : t('flowScoped', { scope: scopeLabel(r), triggers: triggerText(r), product: offered(r) })}
                      </p>
                      {r.prompt || r.message ? (
                        <p className="text-[13px] italic text-[#6D6D72]">“{r.prompt || r.message}”</p>
                      ) : null}
                      <p className="text-[12px] text-[#8E8E93]">
                        {whenText(r)}
                        {s ? ` · ${t('stats.line', { shown: s.shown, accepted: s.accepted, rate: s.acceptanceRate !== null ? Math.round(s.acceptanceRate * 100) : 0 })}` : ''}
                        {s?.declined ? ` · ${ts('declined', { count: s.declined })}` : ''}
                      </p>
                    </div>
                    {r.canEdit ? (
                      <div className="flex items-center gap-1">
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={tc('edit')}
                          title={tc('edit')}
                          onClick={() => {
                            setEditing(r);
                            setOpen(true);
                          }}
                        >
                          <Pencil className="h-4 w-4" aria-hidden />
                        </Button>
                        <Button size="icon-sm" variant="ghost" aria-label={tc('delete')} title={tc('delete')} onClick={() => setDeleting(r)}>
                          <Trash2 className="h-4 w-4 text-[#FF3B30]" aria-hidden />
                        </Button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </IosCard>
          )}
          <IosFootnote>{t('footnote')}</IosFootnote>
        </div>
      </IosCanvas>

      <UpsellEditorDialog open={open} onOpenChange={setOpen} rule={editing} />

      <Dialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t('deleteTitle')}</DialogTitle>
          </DialogHeader>
          <p className="text-sm">{t('deleteBody', { name: deleting?.name ?? '' })}</p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              {tc('cancel')}
            </Button>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => deleting && remove.mutate(deleting)}>
              {tc('delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
