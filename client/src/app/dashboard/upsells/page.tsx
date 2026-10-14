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
 *
 * Export (P:\specs\reports-upgrade.md §5, `StandaloneExportBar`, report key `upsells`): the
 * rules the list shows — the filters named in the export's header — with their places,
 * trigger, offer, hours, active, and their figures over the same 30 days. The designed PDF adds
 * the cards against the 30 days before and the rules by revenue.
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
import {
  deleteUpsell,
  fetchUpsellReport,
  fetchUpsells,
  type UpsellReport,
  type UpsellReportRow,
  type UpsellRule,
} from '@/lib/menuApi';
import { optionsTakenText, ratePercent, upsellFigureTotals } from '@/lib/menuTargetsReports';
import type { ReportFilterLine } from '@/lib/reportExport';
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
import { previousWindow } from '@/lib/designedReport';
import { StandaloneExportBar, type PreviousPeriod, type ReportKpi, type ReportTableSpec } from '@/components/dashboard/report-framework';

/** A rule of the export, with its figures in the stats window (none: not shown in it). */
type ExportRow = { rule: UpsellRule; stats: UpsellReportRow | undefined };

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

  // ── The export: the rules shown (the filters as the header's lines), their figures over 30 days ──
  const te = useTranslations('upsells.export');
  const statsLoaded = stats.data !== undefined;
  /** A figure of the window: 0 for a rule not shown in it, empty while the figures are not there. */
  const fig = (r: ExportRow, pick: (s: UpsellReportRow) => number) => (r.stats ? pick(r.stats) : statsLoaded ? 0 : null);
  const sums = (rows: ExportRow[]) => upsellFigureTotals(rows.map((r) => r.stats));
  const exportTable: ReportTableSpec<ExportRow> = {
    id: 'main',
    title: te('title'),
    rows: rules.map((rule) => ({ rule, stats: byRule.get(rule.id) })),
    rowKey: (r) => r.rule.id,
    totalsLabel: tc('total'),
    columns: [
      { key: 'name', header: te('col.name'), required: true, width: 26, value: (r) => r.rule.name },
      { key: 'action', header: te('col.action'), width: 10, value: (r) => t(`action.${r.rule.action}`) },
      { key: 'places', header: te('col.places'), width: 22, value: (r) => placesOf(r.rule).map((p) => t(`places.${p}`)).join(', ') },
      { key: 'triggerType', header: te('col.triggerType'), width: 16, value: (r) => scopeLabel(r.rule) },
      { key: 'triggers', header: te('col.triggers'), width: 30, value: (r) => (r.rule.triggerType === 'order' ? null : triggerText(r.rule)) },
      { key: 'offers', header: te('col.offers'), width: 30, value: (r) => offered(r.rule) },
      { key: 'prompt', header: te('col.prompt'), width: 30, defaultHidden: true, value: (r) => r.rule.prompt || r.rule.message || null },
      {
        key: 'display',
        header: te('col.display'),
        width: 14,
        defaultHidden: true,
        // As the list's tag: "חלון בחירה" for a popup, and always for "בכל הזמנה" / "מעבר בין מסכים".
        value: (r) =>
          r.rule.display === 'popup' || r.rule.triggerType === 'order' || r.rule.triggerType === 'transition'
            ? ts('tagPopup')
            : ts('tagCard'),
      },
      { key: 'oncePerOrder', header: te('col.oncePerOrder'), width: 10, defaultHidden: true, value: (r) => (r.rule.oncePerOrder ? tc('yes') : tc('no')) },
      { key: 'when', header: te('col.when'), width: 24, value: (r) => whenText(r.rule) },
      { key: 'active', header: te('col.active'), width: 8, value: (r) => (r.rule.isActive ? tc('yes') : tc('no')) },
      { key: 'shown', header: te('col.shown'), kind: 'number', value: (r) => fig(r, (s) => s.shown), totalOf: (rows) => sums(rows).shown },
      { key: 'accepted', header: te('col.accepted'), kind: 'number', value: (r) => fig(r, (s) => s.accepted), totalOf: (rows) => sums(rows).accepted },
      { key: 'dismissed', header: te('col.dismissed'), kind: 'number', value: (r) => fig(r, (s) => s.dismissed), totalOf: (rows) => sums(rows).dismissed },
      { key: 'declined', header: te('col.declined'), kind: 'number', value: (r) => fig(r, (s) => s.declined ?? 0), totalOf: (rows) => sums(rows).declined },
      { key: 'rate', header: te('col.rate'), kind: 'percent', value: (r) => ratePercent(r.stats?.acceptanceRate), totalOf: (rows) => sums(rows).rate },
      { key: 'revenue', header: te('col.revenue'), kind: 'money', value: (r) => fig(r, (s) => s.revenue), totalOf: (rows) => sums(rows).revenue },
      { key: 'optionsTaken', header: te('col.optionsTaken'), width: 36, value: (r) => optionsTakenText(r.stats?.optionsTaken) || null },
    ],
  };
  const exportFilterLines: ReportFilterLine[] = [
    {
      label: te('rules'),
      value: filtered ? te('rulesFiltered', { shown: rules.length, total: allRules.length }) : te('rulesAll', { total: allRules.length }),
    },
    ...(filter.places.length ? [{ label: t('filters.place'), value: filter.places.map((p) => t(`places.${p}`)).join(', ') }] : []),
    ...(filter.triggers.length ? [{ label: t('filters.trigger'), value: filter.triggers.map((x) => t(`scope.${x}`)).join(', ') }] : []),
    ...(filter.activeOnly ? [{ label: t('filters.activeOnly'), value: tc('yes') }] : []),
    ...(qDraft.trim() ? [{ label: te('search'), value: qDraft.trim() }] : []),
    { label: te('stats'), value: te('statsWindow') },
  ];
  // The designed PDF (P:\specs\reports-designed-pdf.md §7): the three cards (and what was taken),
  // the rules by revenue, and the 30 days before against the same rules, fetched on the click.
  const kpisOf = (x: UpsellReport['totals']) => ({
    shown: x.shown,
    accepted: x.accepted,
    rate: ratePercent(x.acceptanceRate),
    revenue: x.revenue,
  });
  const exportKpis: ReportKpi[] = totals
    ? [
        { key: 'shown', label: t('stats.shown'), value: totals.shown, kind: 'count', icon: 'chart' },
        { key: 'accepted', label: te('col.accepted'), value: totals.accepted, kind: 'count', icon: 'items' },
        { key: 'rate', label: t('stats.rate'), value: ratePercent(totals.acceptanceRate), kind: 'percent', icon: 'percent' },
        { key: 'revenue', label: t('stats.revenue'), value: totals.revenue, kind: 'money', icon: 'sales' },
      ]
    : [];
  const previous = async (): Promise<PreviousPeriod | null> => {
    const before = previousWindow(stats.data?.window.from ?? daysBackIso(29), stats.data?.window.to ?? todayIso());
    if (!before) return null;
    const prev = await fetchUpsellReport(before);
    const prevByRule = new Map(prev.rows.map((r) => [r.ruleId, r]));
    return {
      rows: rules.map((rule): ExportRow => ({ rule, stats: prevByRule.get(rule.id) })),
      kpis: kpisOf(prev.totals),
      ...before,
    };
  };

  return (
    <div className="space-y-4">
      <MenuBroadcastBanner />
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        <p className="text-sm text-muted-foreground">{ts('example')}</p>
      </div>
      {allRules.length > 0 ? (
        <div className="space-y-1">
          <StandaloneExportBar
            reportKey="upsells"
            title={te('title')}
            tables={[exportTable as ReportTableSpec<unknown>]}
            from={stats.data?.window.from ?? daysBackIso(29)}
            to={stats.data?.window.to ?? todayIso()}
            place={null}
            filterLines={exportFilterLines}
            disabled={stats.isLoading || rules.length === 0}
            reportType="upsells"
            kpis={exportKpis}
            chartFrom={{ label: 'name', value: 'revenue', type: 'hbar' }}
            insightKeys={{ label: 'name', value: 'revenue', count: 'accepted' }}
            previous={previous}
          />
          <p className="text-xs text-muted-foreground print:hidden">{te('note', { count: rules.length })}</p>
        </div>
      ) : null}
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
