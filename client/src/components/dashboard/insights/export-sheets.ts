'use client';

/**
 * The insights page's Excel export (docs/ACCOUNTING_EXPORT_AND_REPORTS.md §4.1): one
 * workbook, a sheet per table the page shows for the current scope, period and filters —
 * every row, not the few a section lists before "show more". Each section's data comes
 * through the page's own query (same key, same function), so what is already on screen
 * is reused rather than fetched again. A section that fails to load is left out instead
 * of failing the whole file; sections the page hides (no stock, no tables, no identified
 * customers, no data) are left out the same way. Money arrives in agorot and is written
 * in shekels; percentages are already 0–100.
 */

import { useTranslations } from 'next-intl';
import { useQueryClient, type QueryKey } from '@tanstack/react-query';
import type { ExcelColumn, ExcelSheet, ExcelValue } from '@/lib/excelExport';
import {
  fetchAbc,
  fetchBaskets,
  fetchCashierRates,
  fetchCustomers,
  fetchForecast,
  fetchHeatmap,
  fetchInsightsFeed,
  fetchMenuEngineering,
  fetchSlowProducts,
  fetchStockRisk,
  fetchTablesPeriod,
  fetchTrends,
  type AbcReport,
  type Baskets,
  type CashierMetric,
  type Cashiers,
  type Customers,
  type Forecast,
  type ForecastDay,
  type Heatmap,
  type InsightScopeParams,
  type InsightsFeed,
  type KpiBlock,
  type MenuEngineering,
  type ProductTrend,
  type Quadrant,
  type Severity,
  type SlotRange,
  type SlowReport,
  type StockReport,
  type StockStatus,
  type TablesPeriod,
  type TablesPeriodBlock,
  type Trends,
} from '@/lib/insightsApi';
import type { OrgScope } from '@/components/dashboard/org-scope-cascade';
import { useOrgScopeLabel } from '@/components/dashboard/live/scope-picker';
import { useCardText } from './insight-feed';
import { hh } from './ios';

/** Data the page fetched less than this long ago is exported as is (its auto-refresh period). */
const FRESH_MS = 5 * 60_000;

/** The parameters of the page's queries, exactly as the page builds them. */
export interface InsightsExportFilters {
  params: InsightScopeParams;
  menuParams: InsightScopeParams & { categoryId?: string; byCategory?: boolean };
  slowParams: InsightScopeParams & { deadDays?: number };
}

/** Agorot → shekels, as a number Excel can sum. */
const ils = (v: number | null | undefined): number | null => (v === null || v === undefined ? null : v / 100);
const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0);

/**
 * The scope line for the export's heading (the page's own scope picker, not the
 * dashboard's) and the async sheet builder for `ReportExportToolbar.getSheets`.
 */
export function useInsightsExport(scope: OrgScope) {
  const qc = useQueryClient();
  const t = useTranslations('insights');
  const tc = useTranslations('common');
  const cardText = useCardText();
  const scopeLabel = useOrgScopeLabel(scope);
  const weekdays = t.raw('weekdayNames') as string[];

  const pctOf = (label: string) => t('export.pctOf', { label });
  const countOf = (label: string) => t('export.countOf', { label });
  const minutesOf = (label: string) => t('export.minutesOf', { label });
  const itemCol: ExcelColumn = { header: t('menu.colItem'), width: 28 };
  const categoryCol: ExcelColumn = { header: t('menu.category'), width: 18 };
  const dayCol: ExcelColumn = { header: t('forecast.day'), width: 10 };
  const dateCol: ExcelColumn = { header: t('export.date'), kind: 'date' };
  const periodCols: ExcelColumn[] = [
    { header: t('range.label'), width: 14 },
    { header: t('range.from'), kind: 'date' },
    { header: t('range.to'), kind: 'date' },
  ];

  const severity = (s: Severity) =>
    s === 'critical'
      ? t('severity.critical')
      : s === 'warning'
        ? t('severity.warning')
        : s === 'opportunity'
          ? t('severity.opportunity')
          : s === 'positive'
            ? t('severity.positive')
            : t('severity.info');

  const confidence = (c: ForecastDay['confidence']) =>
    c === 'high'
      ? t('forecast.confidence.high')
      : c === 'medium'
        ? t('forecast.confidence.medium')
        : c === 'low'
          ? t('forecast.confidence.low')
          : t('forecast.confidence.none');

  const stockStatus = (s: StockStatus) =>
    s === 'out'
      ? t('stock.status.out')
      : s === 'critical'
        ? t('stock.status.critical')
        : s === 'low'
          ? t('stock.status.low')
          : s === 'below_min'
            ? t('stock.status.below_min')
            : s === 'dead'
              ? t('stock.status.dead')
              : s === 'overstock'
                ? t('stock.status.overstock')
                : t('stock.status.ok');

  const cashierMetric = (m: CashierMetric) =>
    m === 'discount' ? t('cashiers.discounts') : m === 'refund' ? t('cashiers.refunds') : t('cashiers.voids');

  // ── Headline figures and the feed ──
  const feedSheets = (f: InsightsFeed): ExcelSheet[] => {
    const out: ExcelSheet[] = [];
    const cur = f.kpis?.current;
    if (cur) {
      const p = f.period;
      const prev = f.kpis.previous;
      const row = (label: string, from: string, to: string, k: KpiBlock): ExcelValue[] => [
        label, from, to, ils(k.net), k.sales, ils(k.avgCheck), k.itemsPerSale, k.discountPct, ils(k.tips), k.tipPct,
      ];
      out.push({
        name: t('kpi.title'),
        columns: [
          ...periodCols,
          { header: t('kpi.net'), kind: 'money' },
          { header: t('kpi.sales'), kind: 'number' },
          { header: t('kpi.avgCheck'), kind: 'money' },
          { header: t('kpi.itemsPerSale'), kind: 'number', width: 12 },
          { header: t('kpi.discountPct'), kind: 'percent', width: 12 },
          { header: t('kpi.tips'), kind: 'money' },
          { header: t('export.tipPct'), kind: 'percent', width: 14 },
        ],
        rows: [
          row(t('export.current'), p.from, p.to, cur),
          ...(prev ? [row(t('export.previous'), p.prevFrom, p.prevTo, prev)] : []),
        ],
      });
    }
    // The page shows "no data" instead of the cards when the scope has no sales.
    if ((!f.availability || f.availability.hasSales) && f.cards.length > 0) {
      out.push({
        name: t('feed.title'),
        columns: [
          { header: t('export.severity'), width: 12 },
          { header: t('export.insight'), width: 40 },
          { header: t('export.details'), width: 70 },
          { header: t('feed.action'), width: 50 },
        ],
        rows: f.cards.map((card) => {
          const text = cardText(card);
          return [severity(card.severity), text.title, text.body || null, text.action ?? null];
        }),
      });
    }
    return out;
  };

  // ── Forecast ──
  const forecastSheets = (d: Forecast): ExcelSheet[] => {
    const out: ExcelSheet[] = [];
    if (d.days.some((x) => x.net !== null)) {
      out.push({
        name: t('sections.forecast'),
        heading: [
          d.accuracy.accuracy !== null
            ? t('forecast.accuracy', { pct: Math.round(d.accuracy.accuracy), days: d.accuracy.days })
            : t('forecast.accuracyUnknown'),
        ],
        columns: [
          dayCol,
          dateCol,
          { header: t('forecast.forecast'), kind: 'money' },
          { header: t('export.low'), kind: 'money', width: 16 },
          { header: t('export.high'), kind: 'money', width: 16 },
          { header: t('kpi.sales'), kind: 'number' },
          { header: t('forecast.confidenceCol'), width: 10 },
        ],
        rows: d.days.map((x) => [weekdays[x.weekday], x.date, ils(x.net), ils(x.low), ils(x.high), x.docs, confidence(x.confidence)]),
        totals: d.nextWeekTotal !== null ? [tc('total'), null, ils(d.nextWeekTotal), null, null, null, null] : undefined,
      });
    }
    const tomorrow = d.days[0];
    if (tomorrow && tomorrow.net !== null && d.tomorrowHourly.length > 0) {
      out.push({
        name: t('export.forecastHourly'),
        columns: [
          { header: t('export.hour'), width: 8 },
          { header: t('forecast.forecast'), kind: 'money' },
          { header: t('export.dayShare'), kind: 'percent', width: 14 },
          { header: t('kpi.sales'), kind: 'number' },
        ],
        rows: d.tomorrowHourly.map((h) => [hh(h.hour), ils(h.net), h.share, h.docs]),
        totals: [tc('total'), ils(tomorrow.net), null, tomorrow.docs],
      });
    }
    return out;
  };

  // ── Trends ──
  const trendsSheets = (d: Trends): ExcelSheet[] => {
    const out: ExcelSheet[] = [];
    if (d.daily.some((x) => x.net !== 0)) {
      out.push({
        name: t('sections.trends'),
        columns: [
          { header: t('trends.day'), width: 10 },
          dateCol,
          { header: t('kpi.net'), kind: 'money' },
          { header: t('kpi.sales'), kind: 'number' },
          { header: t('trends.baselineLegend'), kind: 'money', width: 24 },
          { header: pctOf(t('trends.deviation')), kind: 'percent' },
        ],
        rows: d.daily.map((x) => [weekdays[x.weekday], x.date, ils(x.net), x.docs, ils(x.baseline), x.deviationPct]),
      });
    }
    const movers = (name: string, rows: ProductTrend[]): ExcelSheet[] =>
      rows.length === 0
        ? []
        : [
            {
              name,
              columns: [
                itemCol,
                categoryCol,
                { header: t('export.unitsWeek'), kind: 'number', width: 12 },
                { header: t('export.unitsLastWeek'), kind: 'number', width: 14 },
                { header: t('export.change'), kind: 'percent' },
                { header: t('export.netWeek'), kind: 'money' },
                { header: t('export.netLastWeek'), kind: 'money', width: 16 },
              ],
              rows: rows.map((r) => [r.name, r.categoryName, r.units, r.unitsPrev, r.changePct, ils(r.net), ils(r.netPrev)]),
            },
          ];
    out.push(...movers(t('trends.rising'), d.products.rising), ...movers(t('trends.falling'), d.products.falling));
    return out;
  };

  // ── Weekday × hour ──
  const heatmapSheets = (d: Heatmap): ExcelSheet[] => {
    if (d.hours.length === 0) return [];
    const byKey = new Map(d.cells.map((c) => [`${c.weekday}-${c.hour}`, c]));
    const out: ExcelSheet[] = [
      {
        name: t('sections.heatmap'),
        heading: [t('heatmap.subtitle', { open: d.openDays, closed: d.closedDays })],
        columns: [dayCol, ...d.hours.map((h): ExcelColumn => ({ header: hh(h), kind: 'money', width: 11 }))],
        rows: [0, 1, 2, 3, 4, 5, 6].map((w) => [
          weekdays[w],
          ...d.hours.map((h) => {
            const c = byKey.get(`${w}-${h}`);
            return c && c.open && c.typicalNet > 0 ? ils(c.typicalNet) : null;
          }),
        ]),
        autoFilter: false,
      },
    ];
    const slots = (name: string, rows: SlotRange[]): ExcelSheet[] =>
      rows.length === 0
        ? []
        : [
            {
              name,
              columns: [
                dayCol,
                { header: t('export.fromHour'), width: 9 },
                { header: t('export.toHour'), width: 9 },
                { header: t('export.typical'), kind: 'money' },
                { header: t('export.usual'), kind: 'money' },
                { header: pctOf(t('trends.deviation')), kind: 'percent' },
                { header: t('export.gapPerWeek'), kind: 'money' },
                { header: t('export.weeks'), kind: 'number' },
              ],
              rows: rows.map((r) => [
                weekdays[r.weekday], hh(r.fromHour), hh(r.toHour), ils(r.typicalNet), ils(r.usual), r.deviationPct,
                ils(r.gapPerWeek), r.occurrences,
              ]),
            },
          ];
    out.push(...slots(t('heatmap.weakTitle'), d.weak), ...slots(t('heatmap.peakTitle'), d.peak));
    return out;
  };

  // ── Menu engineering: every item, as the costs table lists them (most units first) ──
  const menuSheets = (d: MenuEngineering): ExcelSheet[] => {
    const rows = [...d.items, ...d.missingCost].sort((a, b) => b.units - a.units);
    if (rows.length === 0) return [];
    const price = d.mode !== 'cost';
    const quadrant = (q: Quadrant | null) =>
      q === null
        ? null
        : q === 'star'
          ? price ? t('menu.q.starPrice') : t('menu.q.star')
          : q === 'plowhorse'
            ? price ? t('menu.q.plowhorsePrice') : t('menu.q.plowhorse')
            : q === 'puzzle'
              ? price ? t('menu.q.puzzlePrice') : t('menu.q.puzzle')
              : price ? t('menu.q.dogPrice') : t('menu.q.dog');
    const category = d.categoryId ? d.categories.find((c) => c.id === d.categoryId)?.name : null;
    const heading = [
      category ? `${t('menu.category')}: ${category}` : '',
      d.mode === 'price'
        ? t('menu.priceModeBanner')
        : d.missingCost.length > 0
          ? t('menu.missingBanner', { count: d.missingCost.length })
          : '',
    ].filter(Boolean);
    return [
      {
        name: t('sections.menu'),
        heading: heading.length > 0 ? heading : undefined,
        columns: [
          itemCol,
          categoryCol,
          { header: t('export.quadrant'), width: 22 },
          { header: t('export.units'), kind: 'number' },
          { header: t('export.menuMix'), kind: 'percent', width: 14 },
          { header: t('kpi.net'), kind: 'money' },
          { header: t('export.avgPrice'), kind: 'money' },
          { header: t('menu.colPriceEx'), kind: 'money', width: 16 },
          { header: t('menu.colCost'), kind: 'money' },
          { header: t('menu.colMargin'), kind: 'money' },
          { header: pctOf(t('menu.colFoodCost')), kind: 'percent', width: 14 },
          { header: t('export.totalMargin'), kind: 'money', width: 16 },
        ],
        rows: rows.map((r) => [
          r.name, r.categoryName, quadrant(r.quadrant), r.units, r.menuMix, ils(r.net), ils(r.avgPrice), ils(r.avgPriceExVat),
          ils(r.cost), ils(r.margin), r.foodCostPct, ils(r.totalMargin),
        ]),
      },
    ];
  };

  // ── ABC ──
  const abcSheets = (d: AbcReport): ExcelSheet[] => {
    if (d.total <= 0 || !d.items.some((i) => i.net > 0)) return [];
    const classLabel = (c: 'A' | 'B' | 'C') => (c === 'A' ? t('abc.classA') : c === 'B' ? t('abc.classB') : t('abc.classC'));
    return [
      {
        name: t('sections.abc'),
        heading: (['A', 'B', 'C'] as const).map((c) =>
          t('export.abcClassLine', {
            label: classLabel(c),
            share: d.classes[c].share.toFixed(0),
            count: d.classes[c].count,
            pct: d.classes[c].itemShare.toFixed(0),
          }),
        ),
        columns: [
          { header: t('export.abcClass'), width: 8 },
          itemCol,
          categoryCol,
          { header: t('export.units'), kind: 'number' },
          { header: t('kpi.net'), kind: 'money' },
          { header: t('abc.shareLegend'), kind: 'percent', width: 14 },
          { header: t('abc.cumLegend'), kind: 'percent' },
        ],
        rows: d.items.map((r) => [r.class, r.name, r.categoryName, r.units, ils(r.net), r.share, r.cumShare]),
        totals: [
          tc('total'), null, null, sum(d.items.map((r) => r.units)), ils(d.total), sum(d.items.map((r) => r.share)), null,
        ],
      },
    ];
  };

  // ── Slow movers and dead stock ──
  const slowSheets = (d: SlowReport): ExcelSheet[] => {
    const out: ExcelSheet[] = [];
    if (d.dead.length > 0) {
      out.push({
        name: t('slow.deadTitle', { count: d.dead.length }),
        heading: [t('slow.deadHint', { days: d.thresholds.deadDays })],
        columns: [
          itemCol,
          categoryCol,
          { header: t('export.lastSold'), kind: 'date', width: 24 },
          { header: t('export.daysSinceSale'), kind: 'number', width: 14 },
          { header: t('export.onHand'), kind: 'number' },
          { header: t('export.stockValue'), kind: 'money' },
          { header: t('feed.action'), width: 26 },
        ],
        rows: d.dead.map((r) => [
          r.name,
          r.categoryName,
          r.never ? t('slow.never', { days: r.lookbackDays }) : r.lastSold,
          r.daysSinceSale,
          r.onHand,
          ils(r.stockValue),
          r.action === 'sell_off_dont_reorder' ? t('slow.actionSellOff') : t('slow.actionDontReorder'),
        ]),
      });
    }
    if (d.slow.length > 0) {
      out.push({
        name: t('slow.slowTitle', { count: d.slow.length }),
        heading: [t('slow.slowHint')],
        columns: [
          itemCol,
          categoryCol,
          { header: t('export.units'), kind: 'number' },
          { header: t('kpi.net'), kind: 'money' },
          { header: t('export.menuMix'), kind: 'percent', width: 14 },
          { header: t('export.fairShare'), kind: 'percent', width: 14 },
          { header: t('export.perWeek'), kind: 'number', width: 12 },
          { header: t('export.onHand'), kind: 'number' },
          { header: t('feed.action'), width: 18 },
        ],
        rows: d.slow.map((r) => [
          r.name, r.categoryName, r.units, ils(r.net), r.menuMix, r.fairShare, r.perWeek, r.onHand,
          r.action === 'order_less' ? t('slow.actionOrderLess') : t('slow.actionPromote'),
        ]),
      });
    }
    if (d.declining.length > 0) {
      out.push({
        name: t('slow.decliningTitle', { count: d.declining.length }),
        heading: [t('slow.decliningHint', { pct: d.thresholds.declinePct })],
        columns: [
          itemCol,
          categoryCol,
          { header: t('export.units'), kind: 'number' },
          { header: t('export.unitsPrev'), kind: 'number', width: 16 },
          { header: t('export.change'), kind: 'percent' },
        ],
        rows: d.declining.map((r) => [r.name, r.categoryName, r.units, r.unitsPrev, r.changePct]),
      });
    }
    return out;
  };

  // ── Stock-out risk ──
  const stockSheets = (d: StockReport): ExcelSheet[] => {
    if (!d.hasStock || d.rows.length === 0) return [];
    return [
      {
        name: t('sections.stock'),
        heading: [
          t('stock.hint', {
            days: d.params?.velocityDays ?? 28,
            lead: d.params?.leadDays ?? 2,
            target: d.params?.targetDays ?? 7,
          }),
        ],
        columns: [
          itemCol,
          { header: t('export.shop'), width: 18 },
          { header: tc('status'), width: 14 },
          { header: t('export.onHand'), kind: 'number' },
          { header: t('export.perDay'), kind: 'number' },
          { header: t('export.daysOfCover'), kind: 'number' },
          { header: t('export.sellThrough'), kind: 'percent', width: 14 },
          { header: t('export.suggestedOrder'), kind: 'number', width: 12 },
          { header: t('export.reorderMin'), kind: 'number' },
          { header: t('export.reorderMax'), kind: 'number' },
          { header: t('export.stockValue'), kind: 'money' },
        ],
        rows: d.rows.map((r) => [
          r.name, r.shopName, stockStatus(r.status), r.onHand, r.perDay, r.daysOfCover, r.sellThroughPct, r.suggestedOrder,
          r.reorderMin, r.reorderMax, ils(r.stockValue),
        ]),
      },
    ];
  };

  // ── The basket ──
  const basketSheets = (d: Baskets): ExcelSheet[] => {
    if (!d.sales) return [];
    const out: ExcelSheet[] = [];
    if (d.sizes.buckets.length > 0) {
      out.push({
        name: t('baskets.sizesTitle'),
        columns: [
          { header: t('export.basketSize'), width: 16 },
          { header: t('export.baskets'), kind: 'number' },
          { header: t('export.share'), kind: 'percent' },
        ],
        rows: d.sizes.buckets.map((b) => [b.size === '1' ? t('baskets.size1') : t('baskets.sizeN', { size: b.size }), b.baskets, b.share]),
        totals: [tc('total'), d.sizes.baskets, sum(d.sizes.buckets.map((b) => b.share))],
      });
    }
    if (d.pairs.length > 0) {
      out.push({
        name: t('baskets.pairsTitle'),
        heading: [t('baskets.pairsHint', { min: d.minCount })],
        columns: [
          { header: t('export.itemA'), width: 24 },
          { header: t('export.itemB'), width: 24 },
          { header: t('export.together'), kind: 'number', width: 12 },
          { header: t('export.confidence'), kind: 'percent', width: 18 },
          { header: t('export.support'), kind: 'percent', width: 16 },
          { header: t('export.lift'), kind: 'number' },
          { header: t('export.excess'), kind: 'number', width: 16 },
        ],
        rows: d.pairs.map((p) => [p.aName, p.bName, p.together, p.confidence, p.support, p.lift, p.excess]),
      });
    }
    return out;
  };

  // ── Employees ──
  const cashierSheets = (d: Cashiers): ExcelSheet[] => {
    if (d.rows.length === 0) return [];
    return [
      {
        name: t('sections.cashiers'),
        heading: [
          t('cashiers.hint', { ratio: d.ratio, min: d.minSales, discount: d.floors.discount, refund: d.floors.refund, void: d.floors.void }),
        ],
        columns: [
          { header: t('export.cashier'), width: 20 },
          { header: t('kpi.sales'), kind: 'number' },
          { header: t('export.gross'), kind: 'money' },
          { header: t('cashiers.discounts'), kind: 'money' },
          { header: t('export.promotions'), kind: 'money' },
          { header: countOf(t('cashiers.refunds')), kind: 'number', width: 12 },
          { header: t('cashiers.refunds'), kind: 'money' },
          { header: countOf(t('cashiers.voids')), kind: 'number', width: 12 },
          { header: t('cashiers.voids'), kind: 'money' },
          { header: t('export.cancels'), kind: 'number', width: 12 },
          { header: pctOf(t('cashiers.discounts')), kind: 'percent' },
          { header: pctOf(t('cashiers.refunds')), kind: 'percent' },
          { header: pctOf(t('cashiers.voids')), kind: 'percent' },
          { header: t('export.flags'), width: 40 },
        ],
        rows: d.rows.map((r) => [
          r.name ?? t('cashiers.noName'),
          r.sales,
          ils(r.gross),
          ils(r.discounts),
          ils(r.promotions),
          r.refundsCount,
          ils(r.refunds),
          r.voidsCount,
          ils(r.voids),
          r.cancelsCount,
          r.discountPct,
          r.refundPct,
          r.voidPct,
          r.flags
            .map((f) => t('cashiers.flag', { metric: cashierMetric(f.metric), times: f.times.toFixed(1), team: f.team.toFixed(1) }))
            .join(' · ') || null,
        ]),
        // The team line the section shows above the list.
        totals: [
          tc('total'),
          d.team.sales,
          ils(d.team.gross),
          ils(d.team.discounts),
          ils(d.team.promotions),
          sum(d.rows.map((r) => r.refundsCount)),
          ils(d.team.refunds),
          sum(d.rows.map((r) => r.voidsCount)),
          ils(d.team.voids),
          sum(d.rows.map((r) => r.cancelsCount)),
          d.team.discountPct,
          d.team.refundPct,
          d.team.voidPct,
          null,
        ],
      },
    ];
  };

  // ── Tables over the period ──
  const tablesSheets = (d: TablesPeriod): ExcelSheet[] => {
    const cur = d.current;
    if (!d.hasTables || !cur || cur.orders === 0) return [];
    const row = (label: string, from: string, to: string, b: TablesPeriodBlock): ExcelValue[] => [
      label, from, to, b.covers, b.orders, ils(b.spendPerCover), ils(b.avgPerOrder), b.avgSeatedMinutes, b.medianSeatedMinutes,
      b.turnover, ils(b.revPash), b.seatOccupancyPct,
    ];
    const seatedCol: ExcelColumn = { header: minutesOf(t('tables.seated')), kind: 'number', width: 16 };
    const out: ExcelSheet[] = [
      {
        name: t('sections.tables'),
        columns: [
          ...periodCols,
          { header: t('tables.covers'), kind: 'number' },
          { header: t('export.orders'), kind: 'number', width: 12 },
          { header: t('tables.spendPerCover'), kind: 'money' },
          { header: t('tables.avgPerOrder'), kind: 'money' },
          seatedCol,
          { header: t('export.medianSeated'), kind: 'number', width: 16 },
          { header: t('tables.turnover'), kind: 'number', width: 14 },
          { header: t('tables.revPash'), kind: 'money', width: 16 },
          { header: t('export.seatOccupancy'), kind: 'percent', width: 14 },
        ],
        rows: [
          row(t('export.current'), d.period.from, d.period.to, cur),
          ...(d.previous ? [row(t('export.previous'), d.period.prevFrom, d.period.prevTo, d.previous)] : []),
        ],
      },
    ];
    if (cur.byParty.length > 0) {
      out.push({
        name: t('tables.byParty'),
        columns: [
          { header: t('export.partySize'), width: 14 },
          { header: t('export.orders'), kind: 'number', width: 12 },
          seatedCol,
          { header: t('tables.spendPerCover'), kind: 'money' },
        ],
        rows: cur.byParty.map((b) => [t('tables.party', { party: b.party }), b.orders, b.avgMinutes, ils(b.spendPerCover)]),
      });
    }
    return out;
  };

  // ── Repeat customers ──
  const customerSheets = (d: Customers): ExcelSheet[] => {
    const s = d.summary;
    if (!s) return [];
    return [
      {
        name: t('sections.customers'),
        columns: [
          { header: t('customers.customers'), kind: 'number', width: 14 },
          { header: t('export.identifiedPct'), kind: 'percent', width: 16 },
          { header: t('sections.customers'), kind: 'number', width: 14 },
          { header: pctOf(t('customers.repeat')), kind: 'percent' },
          { header: t('customers.repeatNet'), kind: 'money', width: 20 },
          { header: pctOf(t('customers.repeatNet')), kind: 'percent', width: 22 },
          { header: t('customers.visits'), kind: 'number', width: 14 },
        ],
        rows: [[s.customers, s.identifiedPct, s.repeatCustomers, s.repeatPct, ils(s.repeatNet), s.repeatNetPct, s.visitsPerCustomer]],
      },
    ];
  };

  const getSheets = async ({ params, menuParams, slowParams }: InsightsExportFilters): Promise<ExcelSheet[]> => {
    const load = <T>(queryKey: QueryKey, queryFn: () => Promise<T>) => qc.fetchQuery({ queryKey, queryFn, staleTime: FRESH_MS });
    const feed = load(['insights-feed', params], () => fetchInsightsFeed(params));
    // Stock and tables are sections only when the feed says the scope has them.
    const availability = feed.then(
      (f) => f.availability,
      () => undefined,
    );
    const none: ExcelSheet[] = [];
    // In the page's order; each resolves to its sheets, or rejects alone.
    const parts: Promise<ExcelSheet[]>[] = [
      feed.then(feedSheets),
      load(['insights-forecast', params], () => fetchForecast(params)).then(forecastSheets),
      load(['insights-trends', params], () => fetchTrends(params)).then(trendsSheets),
      load(['insights-heatmap', params], () => fetchHeatmap(params)).then(heatmapSheets),
      load(['insights-menu', menuParams], () => fetchMenuEngineering(menuParams)).then(menuSheets),
      load(['insights-abc', params], () => fetchAbc(params)).then(abcSheets),
      load(['insights-slow', slowParams], () => fetchSlowProducts(slowParams)).then(slowSheets),
      availability.then((a) =>
        a?.hasStock ? load(['insights-stock', params], () => fetchStockRisk(params)).then(stockSheets) : none,
      ),
      load(['insights-baskets', params], () => fetchBaskets(params)).then(basketSheets),
      load(['insights-cashiers', params], () => fetchCashierRates(params)).then(cashierSheets),
      availability.then((a) =>
        a?.hasTables ? load(['insights-tables', params], () => fetchTablesPeriod(params)).then(tablesSheets) : none,
      ),
      load(['insights-customers', params], () => fetchCustomers(params)).then(customerSheets),
    ];
    const settled = await Promise.allSettled(parts);
    const sheets = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    if (sheets.length === 0) {
      const failed = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');
      throw failed ? failed.reason : new Error(t('noData'));
    }
    return sheets;
  };

  return { scopeLabel, getSheets };
}
