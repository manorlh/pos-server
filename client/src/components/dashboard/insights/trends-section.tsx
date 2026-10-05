'use client';

/**
 * Trends (מגמות): every day of the period against the median of its weekday's last four
 * weeks (a usual Tuesday, not an average day), this week against last, and the products
 * moving most — up or down by 15% or more on a meaningful volume.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { agorot, type ProductTrend, type Trends } from '@/lib/insightsApi';
import { formatQuantity } from '@/lib/format';
import { CHART, Card, Delta, Figure, Muted, RowDivider, Segmented, dayMonth, tooltipStyle } from './ios';
import { compactMoney } from './forecast-section';

function MoverList({ rows, empty }: { rows: ProductTrend[]; empty: string }) {
  const t = useTranslations('insights.trends');
  if (rows.length === 0) return <Muted className="px-4 py-3">{empty}</Muted>;
  return (
    <ul>
      {rows.map((r, i) => (
        <li key={r.key} className="relative flex items-center justify-between gap-3 px-4 py-2.5">
          {i > 0 ? <RowDivider /> : null}
          <div className="min-w-0">
            <div className="truncate text-[15px] font-medium">{r.name}</div>
            <div className="text-[13px] tabular-nums text-[#8E8E93]">
              {t('unitsLine', { units: formatQuantity(r.units), prev: formatQuantity(r.unitsPrev) })}
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-[13px] tabular-nums text-[#8E8E93]">{agorot(r.net)}</span>
            <Delta a={r.units} b={r.unitsPrev} pct={r.changePct} pill />
          </div>
        </li>
      ))}
    </ul>
  );
}

export function TrendsSection({ data }: { data: Trends }) {
  const t = useTranslations('insights.trends');
  const tr = useTranslations('insights');
  const short = tr.raw('weekdayShort') as string[];
  const weekdays = tr.raw('weekdayNames') as string[];
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const wow = data.weekOverWeek;
  const series = data.daily.map((d) => ({ ...d, label: `${short[d.weekday]} ${dayMonth(d.date)}` }));
  const hasSales = data.daily.some((d) => d.net !== 0);

  return (
    <div className="space-y-3">
      <Card>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-3 text-[12px] text-[#8E8E93]">
            <span className="flex items-center gap-1">
              <span className="h-[3px] w-4 rounded-full" style={{ backgroundColor: CHART.accent }} aria-hidden />
              {t('netLegend')}
            </span>
            <span className="flex items-center gap-1">
              <span className="h-0 w-4 border-t-2 border-dashed" style={{ borderColor: CHART.muted }} aria-hidden />
              {t('baselineLegend')}
            </span>
          </div>
          <Segmented
            value={view}
            onChange={setView}
            className="w-36"
            options={[{ id: 'chart', label: tr('chart') }, { id: 'table', label: tr('table') }]}
          />
        </div>
        {!hasSales ? (
          <Muted>{tr('noData')}</Muted>
        ) : view === 'chart' ? (
          <div className="h-60" dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={series} margin={{ top: 6, right: 4, bottom: 0, left: 4 }}>
                <CartesianGrid vertical={false} stroke={CHART.grid} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#8E8E93' }} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={18} />
                <YAxis tickFormatter={compactMoney} tick={{ fontSize: 11, fill: '#8E8E93' }} axisLine={false} tickLine={false} width={56} orientation="right" />
                <Tooltip
                  contentStyle={tooltipStyle}
                  formatter={(v, name) => [agorot(Number(v ?? 0)), name === 'baseline' ? t('baselineLegend') : t('netLegend')]}
                  labelFormatter={(_l, payload) => {
                    const d = payload?.[0]?.payload as (typeof series)[number] | undefined;
                    return d ? `${weekdays[d.weekday]} ${dayMonth(d.date)}` : '';
                  }}
                />
                <Area type="monotone" dataKey="net" name="net" stroke={CHART.accent} strokeWidth={2} fill={CHART.accentWash} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: CHART.surface }} />
                <Line type="monotone" dataKey="baseline" name="baseline" stroke={CHART.muted} strokeWidth={2} strokeDasharray="4 4" dot={false} connectNulls />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <div className="max-h-80 overflow-y-auto">
            <table className="w-full text-[15px]">
              <thead className="sticky top-0 bg-white dark:bg-[#1C1C1E]">
                <tr className="text-[13px] text-[#8E8E93]">
                  <th className="py-1 text-start font-normal">{t('day')}</th>
                  <th className="py-1 text-end font-normal">{t('netLegend')}</th>
                  <th className="py-1 text-end font-normal">{t('baselineLegend')}</th>
                  <th className="py-1 text-end font-normal">{t('deviation')}</th>
                </tr>
              </thead>
              <tbody>
                {data.daily.map((d) => (
                  <tr key={d.date} className="border-t border-[#3C3C4349] dark:border-[#54545899]">
                    <td className="py-1.5">{weekdays[d.weekday]} {dayMonth(d.date)}</td>
                    <td className="py-1.5 text-end tabular-nums">{agorot(d.net)}</td>
                    <td className="py-1.5 text-end tabular-nums text-[#8E8E93]">{d.baseline !== null ? agorot(d.baseline) : '—'}</td>
                    <td className="py-1.5 text-end">{d.deviationPct !== null && d.baseline ? <Delta a={d.net} b={d.baseline} pct={d.deviationPct} /> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {wow ? (
        <Card className="p-0">
          <div className="px-4 pt-3 text-[13px] text-[#8E8E93]">{t('wowTitle', { from: dayMonth(wow.from), to: dayMonth(wow.to) })}</div>
          <div className="grid grid-cols-3 divide-x divide-x-reverse divide-[#3C3C4349] py-3 dark:divide-[#54545899]">
            <Figure value={agorot(wow.net)} label={t('wowNet')} sub={<Delta a={wow.net} b={wow.netPrev} pct={wow.netChangePct} />} />
            <Figure value={wow.sales.toLocaleString('he-IL')} label={t('wowSales')} sub={<Delta a={wow.sales} b={wow.salesPrev} pct={wow.salesChangePct} />} />
            <Figure value={agorot(wow.avgCheck)} label={t('wowAvgCheck')} sub={<Delta a={wow.avgCheck} b={wow.avgCheckPrev} pct={wow.avgCheckChangePct} />} />
          </div>
        </Card>
      ) : null}

      <div className="grid gap-3 lg:grid-cols-2">
        <div>
          <div className="mb-1.5 px-4 text-[13px] text-[#6D6D72] dark:text-[#8E8E93]">{t('rising')}</div>
          <Card className="p-0">
            <MoverList rows={data.products.rising} empty={t('noRising')} />
          </Card>
        </div>
        <div>
          <div className="mb-1.5 px-4 text-[13px] text-[#6D6D72] dark:text-[#8E8E93]">{t('falling')}</div>
          <Card className="p-0">
            <MoverList rows={data.products.falling} empty={t('noFalling')} />
          </Card>
        </div>
      </div>
    </div>
  );
}
