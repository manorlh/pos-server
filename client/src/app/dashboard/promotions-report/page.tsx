'use client';

/**
 * Promotions report (דוח מבצעים): how many times each promotion applied, on how many
 * sales, and what it took off — by promotion, shop, till and day. Credit notes are left
 * out: a return credits what was paid for the item, and the promotion it was sold under
 * stays given. Server: `GET /reports/promotions`.
 *
 * On the report framework (P:\specs\reports-upgrade.md §5): days, hours and one promotion
 * (`promotionId`, the report's own filter, `?promotion=` in the URL) — the shop and the till
 * from the scope; the endpoint takes no company. No tips here on purpose (§2ה). The OTH /
 * club discounts below run on the same window and scope (their endpoint has no promotion).
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { usePageScope } from '@/lib/scope';
import { scopeApiParams, type ReportFilterSpec } from '@/lib/reportFilters';
import { isUuid, promotionChoices } from '@/lib/auditReports';
import { previousWindow, type PreviousPeriod, type ReportKpi } from '@/lib/designedReport';
import {
  fetchPromotions,
  fetchPromotionsReport,
  type Promotion,
  type PromotionReportFigures,
  type PromotionsReport,
} from '@/lib/promotionsApi';
import { OthClubReport } from '@/components/dashboard/discounts/oth-club-report';
import { ReportWindowSummary } from '@/components/dashboard/report-window-summary';
import { Combobox } from '@/components/ui/combobox';
import { Label } from '@/components/ui/label';
import {
  ReportPage,
  ReportTable,
  reportQueryState,
  useReportFilters,
  type ReportColumn,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';

const SPEC: ReportFilterSpec = { filters: ['hours'], extras: { promotion: '' } };

type ByPromotion = PromotionsReport['byPromotion'][number];
type ByShop = PromotionsReport['byShop'][number];
type ByTill = PromotionsReport['byTill'][number];
type ByDay = PromotionsReport['byDay'][number];

/** The totals row as the designed PDF's cards (and the period before's), by KPI key. */
function totalsFigures(tot: PromotionsReport['totals']): Record<string, number> {
  return { discounts: tot.discount, applications: tot.applications, transactions: tot.documents };
}

export default function PromotionsReportPage() {
  const t = useTranslations('promotionsReport');
  const tt = useTranslations('promotions.types');
  const ts = useTranslations('promotions.status');
  const { resolution, effective } = usePageScope({ maxLevel: 'machine', unsupported: ['company'] });
  const filters = useReportFilters(SPEC);

  const appliedPromotion = (filters.applied?.extras.promotion ?? '').trim();
  const promotionId = isUuid(appliedPromotion) ? appliedPromotion : '';

  /** The window and scope — what the OTH / club section below takes too. */
  const windowParams = useMemo(
    () => (filters.apiParams ? { ...filters.apiParams, ...scopeApiParams(effective, false) } : null),
    [effective, filters.apiParams],
  );
  const params = useMemo(
    () => (windowParams ? { ...windowParams, ...(promotionId ? { promotionId } : {}) } : null),
    [promotionId, windowParams],
  );

  const query = useQuery<PromotionsReport>({
    queryKey: ['report-promotions', params],
    queryFn: () => fetchPromotionsReport(params!),
    enabled: params !== null,
  });
  const data = query.data;

  // The promotion filter's choices: the tenant's promotions (and any the report names that are gone).
  const list = useQuery({
    queryKey: ['promotions-report-choices'],
    queryFn: () => fetchPromotions(),
    staleTime: 5 * 60_000,
  });
  const promotionOptions = useMemo(() => {
    const known = new Map<string, Promotion>((list.data?.items ?? []).map((p) => [p.id, p]));
    const typeName = (type: string | null | undefined) => (type && tt.has(`${type}.name`) ? tt(`${type}.name`) : null);
    const options = promotionChoices(list.data?.items ?? [], data?.byPromotion ?? []).map((c) => {
      const p = known.get(c.id);
      return {
        value: c.id,
        label: c.name || t('unknown'),
        description: p
          ? [typeName(p.type), ts.has(p.status) ? ts(p.status) : null].filter(Boolean).join(' · ')
          : list.isSuccess
            ? t('filter.deleted')
            : undefined,
      };
    });
    const chosen = (filters.draftExtras.promotion ?? '').trim();
    return chosen && !options.some((o) => o.value === chosen)
      ? [{ value: chosen, label: t('unknown'), description: undefined }, ...options]
      : options;
  }, [data, filters.draftExtras.promotion, list.data, list.isSuccess, t, ts, tt]);

  const promotionLine = useMemo(() => {
    if (!promotionId) return [];
    const name = promotionOptions.find((o) => o.value === promotionId)?.label ?? t('unknown');
    return [{ label: t('filter.promotion'), value: name }];
  }, [promotionId, promotionOptions, t]);

  const tables = useMemo(() => {
    const unknown = t('unknown');
    const totals = data?.totals;
    const figures = <R extends PromotionReportFigures>(): ReportColumn<R>[] => [
      { key: 'applications', header: t('col.applications'), kind: 'number', value: (r) => r.applications, total: totals?.applications },
      { key: 'documents', header: t('col.documents'), kind: 'number', value: (r) => r.documents, total: totals?.documents },
      {
        key: 'discount',
        header: t('col.discount'),
        kind: 'money',
        value: (r) => r.discount,
        total: totals?.discount,
        className: 'font-semibold',
      },
    ];
    const common = { totalsLabel: t('total'), emptyText: t('noRows') };

    const byPromotion: ReportTableSpec<ByPromotion> = {
      ...common,
      id: 'main',
      title: t('byPromotion'),
      rows: data?.byPromotion ?? [],
      rowKey: (r, i) => r.promotionId ?? `p${i}`,
      columns: [
        { key: 'promotion', header: t('col.promotion'), required: true, value: (r) => r.name ?? unknown, className: 'font-medium' },
        {
          key: 'type',
          header: t('col.type'),
          value: (r) => (r.type && tt.has(`${r.type}.name`) ? tt(`${r.type}.name`) : null),
          className: 'text-muted-foreground',
        },
        ...figures<ByPromotion>(),
      ],
    };
    const byShop: ReportTableSpec<ByShop> = {
      ...common,
      id: 'shops',
      title: t('byShop'),
      rows: data?.byShop ?? [],
      rowKey: (r, i) => r.shopId ?? `s${i}`,
      columns: [
        { key: 'shop', header: t('col.shop'), required: true, value: (r) => r.name ?? unknown, className: 'font-medium' },
        ...figures<ByShop>(),
      ],
    };
    const byTill: ReportTableSpec<ByTill> = {
      ...common,
      id: 'tills',
      title: t('byTill'),
      rows: data?.byTill ?? [],
      rowKey: (r, i) => r.machineId ?? `m${i}`,
      columns: [
        {
          key: 'till',
          header: t('col.till'),
          required: true,
          value: (r) =>
            [r.shopName, r.name, r.posNumber ? t('register', { n: r.posNumber }) : null].filter(Boolean).join(' · ') || unknown,
          className: 'font-medium',
        },
        ...figures<ByTill>(),
      ],
    };
    const byDay: ReportTableSpec<ByDay> = {
      ...common,
      id: 'days',
      title: t('byDay'),
      rows: data?.byDay ?? [],
      rowKey: (r) => r.date,
      columns: [
        { key: 'day', header: t('col.day'), kind: 'date', required: true, value: (r) => r.date, className: 'font-medium' },
        ...figures<ByDay>(),
      ],
    };
    return { byPromotion, byShop, byTill, byDay };
  }, [data, t, tt]);

  const exportTables = [tables.byPromotion, tables.byShop, tables.byTill, tables.byDay] as ReportTableSpec<unknown>[];

  // The designed PDF (P:\specs\reports-designed-pdf.md §7): the totals as cards, a bar per
  // promotion, and the promotions of the period before.
  const figures = data ? totalsFigures(data.totals) : null;
  const kpis: ReportKpi[] = figures
    ? [
        { key: 'discounts', label: t('col.discount'), value: figures.discounts, kind: 'money', icon: 'discount' },
        { key: 'applications', label: t('col.applications'), value: figures.applications, kind: 'count', icon: 'star' },
        { key: 'transactions', label: t('col.documents'), value: figures.transactions, kind: 'count', icon: 'receipt' },
      ]
    : [];
  const previous = async (): Promise<PreviousPeriod | null> => {
    const w = previousWindow(data?.window.from, data?.window.to);
    if (!params || !w) return null;
    const before = await fetchPromotionsReport({ ...params, ...w });
    return { rows: before.byPromotion, kpis: totalsFigures(before.totals), ...w };
  };

  return (
    <ReportPage
      reportKey="promotions-report"
      title={t('title')}
      subtitle={t('subtitle')}
      resolution={resolution}
      filters={filters}
      bar={{
        children: (
          <div className="min-w-0 space-y-1">
            <Label className="text-xs" htmlFor="promotion-filter">
              {t('filter.promotion')}
            </Label>
            <Combobox
              id="promotion-filter"
              options={promotionOptions}
              value={filters.draftExtras.promotion ?? ''}
              onValueChange={(id) => filters.setExtra('promotion', id ?? '')}
              placeholder={t('filter.all')}
              emptyText={t('filter.noMatch')}
              clearable
              size="sm"
            />
          </div>
        ),
      }}
      query={reportQueryState(query)}
      prompt={t('selectFilters')}
      loading="table"
      export={
        data
          ? {
              tables: exportTables,
              from: data.window.from,
              to: data.window.to,
              filterLines: promotionLine,
              reportType: 'promotions-report',
              kpis,
              chartFrom: { label: 'promotion', value: 'discount', type: 'hbar' },
              previous,
            }
          : null
      }
    >
      {data ? (
        <>
          <ReportWindowSummary window={data.window} generatedAt={data.generatedAt} />
          {data.byPromotion.length === 0 ? (
            <p className="text-muted-foreground py-10 text-center text-sm">{t('noRows')}</p>
          ) : (
            <>
              <ReportTable table={tables.byPromotion} />
              <ReportTable table={tables.byShop} />
              <ReportTable table={tables.byTill} />
              <ReportTable table={tables.byDay} />
            </>
          )}
          {/* OTH ("על חשבון הבית") and the club discount, over the same window and scope. */}
          {promotionId ? <p className="text-muted-foreground text-xs">{t('othNotFiltered')}</p> : null}
          <OthClubReport params={windowParams} />
        </>
      ) : null}
    </ReportPage>
  );
}
