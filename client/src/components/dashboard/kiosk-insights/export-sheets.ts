'use client';

/**
 * "ביצועי קיוסקים" as Excel: the headline figures (this period and the one before), every
 * kiosk side by side, the funnel, where customers leave, the time to order, orders by hour,
 * the daily trend, the top items, upsell and payments — each table the page shows, as its
 * own sheet. The report is one response (`GET /insights/kiosks`), so every row is in it.
 *
 * Money arrives in agorot and leaves in shekels (`shekels`); percentages are 0–100, as the
 * percent cells want them; times are seconds.
 *
 * On the report framework's export bar (P:\specs\reports-upgrade.md §5): the headline
 * (`kpiTable`) and every kiosk (tables.tsx `usePerKioskTable`, the PDF's table) are report
 * tables — the first two sheets, with "עמודות לייצוא" and the company's default; the rest
 * follow as the bar's `extraSheets`, in the same order as always.
 */

import { useTranslations } from 'next-intl';
import type { ExcelSheet } from '@/lib/excelExport';
import {
  LEFT_REASONS,
  abandonmentRows,
  bucketMinutes,
  shekels,
  type KioskHeadline,
  type KioskInsightsReport,
} from '@/lib/kioskInsights';
import type { ReportColumn, ReportTableSpec } from '@/components/dashboard/report-framework';
import { useKioskLabels } from './labels';

/** A row of the headline's table: this period, or the one before. */
interface HeadlineRow {
  id: 'current' | 'previous';
  label: string;
  from: string;
  to: string;
  h: KioskHeadline;
}

export function useKioskInsightsSheets() {
  const t = useTranslations('kioskInsights');
  const tc = useTranslations('common');
  const L = useKioskLabels();

  /** The headline, one row per period (the first sheet); null without figures. */
  const kpiTable = (data: KioskInsightsReport): ReportTableSpec<unknown> | null => {
    const { period } = data;
    const cur = data.headline.current;
    const prev = data.headline.previous;
    if (!cur) return null;
    const columns: ReportColumn<HeadlineRow>[] = [
      { key: 'period', header: t('excel.period'), width: 16, value: (r) => r.label },
      { key: 'from', header: t('excel.from'), kind: 'date', value: (r) => r.from },
      { key: 'to', header: t('excel.to'), kind: 'date', value: (r) => r.to },
      { key: 'sessions', header: t('csv.col.sessions'), kind: 'number', value: (r) => r.h.sessions },
      { key: 'paidSessions', header: t('csv.col.paidSessions'), kind: 'number', value: (r) => r.h.paidSessions },
      { key: 'conversion', header: t('csv.col.conversion'), kind: 'percent', value: (r) => r.h.conversion },
      { key: 'abandoned', header: t('csv.col.abandoned'), kind: 'number', value: (r) => r.h.abandoned },
      { key: 'orders', header: t('csv.col.orders'), kind: 'number', value: (r) => r.h.orders },
      { key: 'revenue', header: t('csv.col.revenue'), kind: 'money', value: (r) => shekels(r.h.revenue) },
      { key: 'tips', header: t('excel.tips'), kind: 'money', value: (r) => shekels(r.h.tips) },
      { key: 'avgBasket', header: t('csv.col.avgBasket'), kind: 'money', value: (r) => shekels(r.h.avgBasket) },
      { key: 'itemsPerOrder', header: t('csv.col.itemsPerOrder'), kind: 'number', value: (r) => r.h.itemsPerOrder },
      { key: 'medianOrderSec', header: t('csv.col.medianOrderSec'), kind: 'number', value: (r) => r.h.medianOrderSec },
      { key: 'avgOrderSec', header: t('excel.avgOrderSec'), kind: 'number', value: (r) => r.h.avgOrderSec },
      { key: 'upsellShown', header: t('csv.col.upsellShown'), kind: 'number', value: (r) => r.h.upsellShown },
      { key: 'upsellAccepted', header: t('csv.col.upsellAccepted'), kind: 'number', value: (r) => r.h.upsellAccepted },
      { key: 'upsellRate', header: t('csv.col.upsellRate'), kind: 'percent', value: (r) => r.h.upsellRate },
      { key: 'payAttempts', header: t('csv.col.payAttempts'), kind: 'number', value: (r) => r.h.payAttempts },
      { key: 'payFailures', header: t('csv.col.payFailures'), kind: 'number', value: (r) => r.h.payFailures },
      { key: 'payFailureRate', header: t('csv.col.payFailureRate'), kind: 'percent', value: (r) => r.h.payFailureRate },
      { key: 'basketChanged', header: t('excel.basketChanged'), kind: 'number', value: (r) => r.h.basketChanged },
      { key: 'helpRequests', header: t('excel.helpRequests'), kind: 'number', value: (r) => r.h.helpRequests },
    ];
    const table: ReportTableSpec<HeadlineRow> = {
      id: 'kpi',
      title: t('kpi.title'),
      rowKey: (r) => r.id,
      rows: [
        { id: 'current', label: t('excel.current'), from: period.from, to: period.to, h: cur },
        ...(prev ? [{ id: 'previous' as const, label: t('excel.previous'), from: period.prevFrom, to: period.prevTo, h: prev }] : []),
      ],
      columns,
    };
    return table as ReportTableSpec<unknown>;
  };

  /** Every sheet after the headline and the per-kiosk table, in the page's order. */
  const extraSheets = (data: KioskInsightsReport): ExcelSheet[] => {
    const sheets: ExcelSheet[] = [];
    const cur = data.headline.current;

    if (!data.hasData) return sheets;

    // ── Funnel ──────────────────────────────────────────────────────────────
    sheets.push({
      name: t('sections.funnel'),
      columns: [
        { header: t('csv.col.stage'), width: 16 },
        { header: t('csv.col.stageSessions'), kind: 'number' },
        { header: t('csv.col.pctOfStart'), kind: 'percent' },
        { header: t('csv.col.dropToNext'), kind: 'number' },
        { header: t('csv.col.dropPct'), kind: 'percent' },
      ],
      rows: data.funnel.map((s) => [L.funnel(s.key), s.sessions, s.pctOfStart, s.dropToNext, s.dropPct]),
    });

    // ── Where they leave ────────────────────────────────────────────────────
    const abandon = abandonmentRows(data.abandonment);
    sheets.push({
      name: t('csv.abandonment'),
      columns: [
        { header: t('csv.col.step'), width: 16 },
        { header: t('csv.col.left'), kind: 'number' },
        { header: t('csv.col.leftPct'), kind: 'percent' },
        ...LEFT_REASONS.map((r) => ({ header: L.reason(r), kind: 'number' as const })),
      ],
      rows: abandon.map((r) => [L.step(r.step), r.count, r.pct, ...LEFT_REASONS.map((reason) => r[reason])]),
      totals: [
        tc('total'),
        data.abandonment.left,
        null,
        ...LEFT_REASONS.map((reason) => abandon.reduce((n, r) => n + r[reason], 0)),
      ],
    });

    // ── Time to order ───────────────────────────────────────────────────────
    const ot = data.orderTime;
    sheets.push({
      name: t('sections.orderTime'),
      heading: [
        `${t('excel.medianSec')}: ${ot.medianSec ?? '—'} · ${t('excel.avgSec')}: ${ot.avgSec ?? '—'} · ${t('excel.p90Sec')}: ${ot.p90Sec ?? '—'}`,
      ],
      columns: [
        { header: t('orderTime.range'), width: 14 },
        { header: t('orderTime.orders'), kind: 'number' },
      ],
      rows: ot.buckets.map((b) => {
        const m = bucketMinutes(b);
        return [
          m.to === null ? t('orderTime.bucketOpen', { from: m.from }) : t('orderTime.bucket', { from: m.from, to: m.to }),
          b.count,
        ];
      }),
      totals: [tc('total'), ot.count],
    });

    // ── By hour, daily ──────────────────────────────────────────────────────
    sheets.push({
      name: t('sections.byHour'),
      columns: [
        { header: t('byHour.hour'), width: 8 },
        { header: t('byHour.sessions'), kind: 'number' },
        { header: t('byHour.orders'), kind: 'number' },
        { header: t('byHour.revenue'), kind: 'money' },
      ],
      rows: data.byHour.map((r) => [`${String(r.hour).padStart(2, '0')}:00`, r.sessions, r.orders, shekels(r.revenue)]),
      totals: [
        tc('total'),
        data.byHour.reduce((n, r) => n + r.sessions, 0),
        data.byHour.reduce((n, r) => n + r.orders, 0),
        shekels(data.byHour.reduce((n, r) => n + r.revenue, 0)),
      ],
    });
    sheets.push({
      name: t('sections.daily'),
      columns: [
        { header: t('daily.day'), kind: 'date' },
        { header: t('daily.sessions'), kind: 'number' },
        { header: t('daily.orders'), kind: 'number' },
        { header: t('daily.revenue'), kind: 'money' },
        { header: t('daily.conversion'), kind: 'percent' },
      ],
      rows: data.daily.map((r) => [r.date, r.sessions, r.orders, shekels(r.revenue), r.conversion]),
      totals: [
        tc('total'),
        data.daily.reduce((n, r) => n + r.sessions, 0),
        data.daily.reduce((n, r) => n + r.orders, 0),
        shekels(data.daily.reduce((n, r) => n + r.revenue, 0)),
        cur?.conversion ?? null,
      ],
    });

    // ── Top items ───────────────────────────────────────────────────────────
    sheets.push({
      name: t('sections.topItems'),
      columns: [
        { header: t('excel.item'), width: 24 },
        { header: t('excel.units'), kind: 'number' },
        { header: t('excel.net'), kind: 'money' },
      ],
      rows: data.topItems.map((i) => [i.name ?? t('topItems.unnamed'), i.units, shekels(i.net)]),
    });

    // ── Upsell ──────────────────────────────────────────────────────────────
    const up = data.upsell;
    if (up.shown > 0 || up.byRule.length > 0 || up.byProduct.length > 0) {
      sheets.push({
        name: t('upsell.byRule'),
        heading: up.source === 'till_stats' ? [t('upsell.tillStats')] : undefined,
        columns: [
          { header: t('upsell.rule'), width: 22 },
          { header: t('upsell.shown'), kind: 'number' },
          { header: t('upsell.accepted'), kind: 'number' },
          { header: t('upsell.declined'), kind: 'number' },
          { header: t('upsell.rate'), kind: 'percent' },
        ],
        rows: up.byRule.map((r) => [r.name ?? t('upsell.unnamedRule'), r.shown, r.accepted, r.declined, r.rate]),
        totals: [tc('total'), up.shown, up.accepted, up.declined, up.rate],
      });
      sheets.push({
        name: t('upsell.byProduct'),
        columns: [
          { header: t('excel.product'), width: 24 },
          { header: t('upsell.accepted'), kind: 'number' },
        ],
        rows: up.byProduct.map((p) => [p.name ?? t('upsell.unknownProduct'), p.accepted]),
      });
      if (up.byMoment.length > 0) {
        sheets.push({
          name: t('upsell.byMoment'),
          columns: [
            { header: t('excel.moment'), width: 20 },
            { header: t('upsell.shown'), kind: 'number' },
            { header: t('upsell.accepted'), kind: 'number' },
            { header: t('upsell.declined'), kind: 'number' },
            { header: t('upsell.rate'), kind: 'percent' },
          ],
          rows: up.byMoment.map((m) => [L.moment(m.moment), m.shown, m.accepted, m.declined, m.rate]),
        });
      }
    }

    // ── Payments: by reason, by method, what the terminal said ──────────────
    const pay = data.payments;
    if (pay.attempts > 0 || pay.terminalOutcomes.length > 0) {
      sheets.push({
        name: t('payments.byReason'),
        heading: [
          `${t('payments.attempts')}: ${pay.attempts} · ${t('payments.approved')}: ${pay.approved} · ${t('payments.failures')}: ${pay.failures}`,
        ],
        columns: [
          { header: t('excel.result'), width: 14 },
          { header: t('excel.reason'), width: 26 },
          { header: t('excel.count'), kind: 'number' },
        ],
        rows: pay.byReason.map((r) => [L.payResult(r.result), L.payReason(r.reason), r.count]),
        totals: [tc('total'), null, pay.byReason.reduce((n, r) => n + r.count, 0)],
      });
      sheets.push({
        name: t('payments.byMethod'),
        columns: [
          { header: t('excel.method'), width: 18 },
          { header: t('excel.count'), kind: 'number' },
        ],
        rows: pay.byMethod.map((m) => [L.method(m.method), m.count]),
        totals: [tc('total'), pay.byMethod.reduce((n, m) => n + m.count, 0)],
      });
      if (pay.terminalOutcomes.length > 0) {
        sheets.push({
          name: t('payments.terminalOutcomes'),
          heading: [t('payments.terminalHint')],
          columns: [
            { header: t('excel.outcome'), width: 18 },
            { header: t('excel.count'), kind: 'number' },
          ],
          rows: pay.terminalOutcomes.map((o) => [L.outcome(o.outcome), o.count]),
          totals: [tc('total'), pay.terminalOutcomes.reduce((n, o) => n + o.count, 0)],
        });
      }
    }

    return sheets;
  };

  return { kpiTable, extraSheets };
}
