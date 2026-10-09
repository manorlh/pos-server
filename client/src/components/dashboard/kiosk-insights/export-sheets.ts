'use client';

/**
 * "ביצועי קיוסקים" as Excel: the headline figures (this period and the one before), every
 * kiosk side by side, the funnel, where customers leave, the time to order, orders by hour,
 * the daily trend, the top items, upsell and payments — each table the page shows, as its
 * own sheet. The report is one response (`GET /insights/kiosks`), so every row is in it.
 *
 * Money arrives in agorot and leaves in shekels (`shekels`); percentages are 0–100, as the
 * percent cells want them; times are seconds.
 */

import { useTranslations } from 'next-intl';
import type { ExcelColumn, ExcelSheet, ExcelValue } from '@/lib/excelExport';
import {
  LEFT_REASONS,
  PER_KIOSK_COLUMNS,
  abandonmentRows,
  bucketMinutes,
  shekels,
  type KioskHeadline,
  type KioskInsightsReport,
  type PerKioskColumn,
} from '@/lib/kioskInsights';
import { useKioskLabels } from './labels';

const KIND: Partial<Record<PerKioskColumn, ExcelColumn['kind']>> = {
  revenue: 'money',
  avgBasket: 'money',
  conversion: 'percent',
  upsellRate: 'percent',
  payFailureRate: 'percent',
  itemsPerOrder: 'number',
};

export function useKioskInsightsSheets() {
  const t = useTranslations('kioskInsights');
  const tc = useTranslations('common');
  const L = useKioskLabels();

  /** A per-kiosk / headline cell: money in shekels, the rest as sent. */
  const cell = (row: Partial<Record<PerKioskColumn, unknown>>, col: PerKioskColumn): ExcelValue => {
    const v = row[col];
    if (col === 'revenue' || col === 'avgBasket') return shekels(v as number | null);
    return (v as ExcelValue) ?? null;
  };
  const kindOf = (col: PerKioskColumn): ExcelColumn['kind'] =>
    col === 'name' || col === 'shopName' ? 'text' : (KIND[col] ?? 'number');

  return (data: KioskInsightsReport): ExcelSheet[] => {
    const sheets: ExcelSheet[] = [];
    const { period } = data;
    const cur = data.headline.current;
    const prev = data.headline.previous;

    // ── Headline: one row per period ─────────────────────────────────────────
    if (cur) {
      const line = (label: string, from: string, to: string, h: KioskHeadline): ExcelValue[] => [
        label,
        from,
        to,
        h.sessions,
        h.paidSessions,
        h.conversion,
        h.abandoned,
        h.orders,
        shekels(h.revenue),
        shekels(h.tips),
        shekels(h.avgBasket),
        h.itemsPerOrder,
        h.medianOrderSec,
        h.avgOrderSec,
        h.upsellShown,
        h.upsellAccepted,
        h.upsellRate,
        h.payAttempts,
        h.payFailures,
        h.payFailureRate,
        h.basketChanged,
        h.helpRequests,
      ];
      sheets.push({
        name: t('kpi.title'),
        columns: [
          { header: t('excel.period'), width: 16 },
          { header: t('excel.from'), kind: 'date' },
          { header: t('excel.to'), kind: 'date' },
          { header: t('csv.col.sessions'), kind: 'number' },
          { header: t('csv.col.paidSessions'), kind: 'number' },
          { header: t('csv.col.conversion'), kind: 'percent' },
          { header: t('csv.col.abandoned'), kind: 'number' },
          { header: t('csv.col.orders'), kind: 'number' },
          { header: t('csv.col.revenue'), kind: 'money' },
          { header: t('excel.tips'), kind: 'money' },
          { header: t('csv.col.avgBasket'), kind: 'money' },
          { header: t('csv.col.itemsPerOrder'), kind: 'number' },
          { header: t('csv.col.medianOrderSec'), kind: 'number' },
          { header: t('excel.avgOrderSec'), kind: 'number' },
          { header: t('csv.col.upsellShown'), kind: 'number' },
          { header: t('csv.col.upsellAccepted'), kind: 'number' },
          { header: t('csv.col.upsellRate'), kind: 'percent' },
          { header: t('csv.col.payAttempts'), kind: 'number' },
          { header: t('csv.col.payFailures'), kind: 'number' },
          { header: t('csv.col.payFailureRate'), kind: 'percent' },
          { header: t('excel.basketChanged'), kind: 'number' },
          { header: t('excel.helpRequests'), kind: 'number' },
        ],
        rows: [
          line(t('excel.current'), period.from, period.to, cur),
          ...(prev ? [line(t('excel.previous'), period.prevFrom, period.prevTo, prev)] : []),
        ],
      });
    }

    // ── Every kiosk, the headline as its total ───────────────────────────────
    sheets.push({
      name: t('sections.perKiosk'),
      columns: PER_KIOSK_COLUMNS.map((c) => ({
        header: t(`csv.col.${c}`),
        kind: kindOf(c),
        width: c === 'name' || c === 'shopName' ? 20 : undefined,
      })),
      rows: data.perKiosk.map((r) =>
        PER_KIOSK_COLUMNS.map((c) => (c === 'name' ? (r.name ?? r.machineName) : cell(r, c))),
      ),
      totals: cur
        ? PER_KIOSK_COLUMNS.map((c) =>
            c === 'name' ? tc('total') : c === 'shopName' ? null : cell(cur as Partial<Record<PerKioskColumn, unknown>>, c),
          )
        : undefined,
    });

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
}
