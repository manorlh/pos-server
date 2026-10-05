'use client';

/**
 * ABC (Pareto): items by their share of the net, biggest first, with the running total.
 * A = the items that make the first 80% (the one that crosses 80% included), B = the next
 * 15%, C = the last 5% and anything that earned nothing. Bars and the running line share
 * one axis — both are a percentage of the same net.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Bar, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { agorot, type AbcReport } from '@/lib/insightsApi';
import { formatQuantity } from '@/lib/format';
import { CHART, Card, Figure, Muted, RowDivider, tooltipStyle } from './ios';

const CHART_ITEMS = 30;

export function AbcSection({ data }: { data: AbcReport }) {
  const t = useTranslations('insights.abc');
  const tr = useTranslations('insights');
  const [showAll, setShowAll] = useState(false);
  const sold = data.items.filter((i) => i.net > 0);
  if (data.total <= 0 || sold.length === 0) {
    return (
      <Card>
        <Muted>{tr('noData')}</Muted>
      </Card>
    );
  }
  const chart = sold.slice(0, CHART_ITEMS).map((i, n) => ({ ...i, rank: n + 1 }));
  const rows = showAll ? data.items : data.items.slice(0, 15);
  const classLabel = (c: 'A' | 'B' | 'C') => (c === 'A' ? t('classA') : c === 'B' ? t('classB') : t('classC'));

  return (
    <div className="space-y-3">
      <Card className="grid grid-cols-3 divide-x divide-x-reverse divide-[#3C3C4349] p-0 py-3 dark:divide-[#54545899]">
        {(['A', 'B', 'C'] as const).map((c) => (
          <Figure
            key={c}
            value={`${data.classes[c].share.toFixed(0)}%`}
            label={classLabel(c)}
            sub={<span className="text-[#8E8E93]">{t('classLine', { count: data.classes[c].count, pct: data.classes[c].itemShare.toFixed(0) })}</span>}
          />
        ))}
      </Card>
      <Card>
        <div className="mb-2 flex flex-wrap items-center gap-3 text-[12px] text-[#8E8E93]">
          <span className="flex items-center gap-1">
            <span className="h-3 w-3 rounded-[3px]" style={{ backgroundColor: CHART.accent }} aria-hidden />
            {t('shareLegend')}
          </span>
          <span className="flex items-center gap-1">
            <span className="h-[3px] w-4 rounded-full" style={{ backgroundColor: CHART.muted }} aria-hidden />
            {t('cumLegend')}
          </span>
        </div>
        <div className="h-56" dir="ltr">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chart} margin={{ top: 6, right: 4, bottom: 0, left: 4 }}>
              <CartesianGrid vertical={false} stroke={CHART.grid} />
              <XAxis dataKey="rank" tick={{ fontSize: 11, fill: '#8E8E93' }} axisLine={false} tickLine={false} />
              <YAxis domain={[0, 100]} tickFormatter={(v: number) => `${v}%`} tick={{ fontSize: 11, fill: '#8E8E93' }} axisLine={false} tickLine={false} width={40} orientation="right" />
              <ReferenceLine y={data.cuts.A} stroke={CHART.muted} label={{ value: 'A | B', position: 'insideTopLeft', fill: '#8E8E93', fontSize: 11 }} />
              <ReferenceLine y={data.cuts.B} stroke={CHART.muted} label={{ value: 'B | C', position: 'insideTopLeft', fill: '#8E8E93', fontSize: 11 }} />
              <Tooltip
                contentStyle={tooltipStyle}
                labelFormatter={(_l, payload) => {
                  const d = payload?.[0]?.payload as (typeof chart)[number] | undefined;
                  return d ? `${d.rank}. ${d.name} (${d.class})` : '';
                }}
                formatter={(v, name) => [`${Number(v ?? 0).toFixed(1)}%`, name === 'cumShare' ? t('cumLegend') : t('shareLegend')]}
              />
              <Bar dataKey="share" name="share" fill={CHART.accent} radius={[4, 4, 0, 0]} maxBarSize={18} />
              <Line type="monotone" dataKey="cumShare" name="cumShare" stroke={CHART.muted} strokeWidth={2} dot={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        {sold.length > CHART_ITEMS ? <p className="mt-1 text-[12px] text-[#8E8E93]">{t('chartTop', { count: CHART_ITEMS })}</p> : null}
      </Card>
      <Card className="p-0">
        <ul>
          {rows.map((r, i) => (
            <li key={r.key} className="relative flex items-center justify-between gap-3 px-4 py-2">
              {i > 0 ? <RowDivider /> : null}
              <div className="flex min-w-0 items-center gap-3">
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[#7676801F] text-[13px] font-bold dark:bg-[#7676803D]">
                  {r.class}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-[15px]">{r.name}</div>
                  <div className="text-[12px] tabular-nums text-[#8E8E93]">{t('rowLine', { units: formatQuantity(r.units), share: r.share.toFixed(1) })}</div>
                </div>
              </div>
              <span className="shrink-0 text-[15px] font-semibold tabular-nums">{agorot(r.net)}</span>
            </li>
          ))}
        </ul>
        {data.items.length > 15 ? (
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="w-full border-t border-[#3C3C4349] px-4 py-2.5 text-[15px] text-[#007AFF] dark:border-[#54545899] dark:text-[#0A84FF]"
          >
            {showAll ? t('showLess') : t('showAll', { count: data.items.length })}
          </button>
        ) : null}
      </Card>
      <p className="px-4 text-[13px] leading-snug text-[#8E8E93]">{t('advice')}</p>
    </div>
  );
}
