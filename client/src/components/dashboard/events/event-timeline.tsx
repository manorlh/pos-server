'use client';

/**
 * The event's timeline: takings per 15 / 30 / 60 minutes (the server keeps 15; the page
 * re-buckets — lib/eventReport.ts), as the whole event with its running total, or stacked
 * per till; and each till's average per hour ("ממוצע לפי זמן") beside the event's own.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { BucketMinutes, EventReport } from '@/lib/eventTypes';
import { clockLabel, rebucket, timelineRows } from '@/lib/eventReport';
import { CHART, Capsule, Card, Muted, Segmented, tooltipStyle } from '@/components/dashboard/insights/ios';
import { compactMoney, money, tillColor } from './event-parts';

type View = 'total' | 'tills';

export function EventTimeline({
  report,
  bucket,
  onBucket,
}: {
  report: EventReport;
  bucket: BucketMinutes;
  onBucket: (b: BucketMinutes) => void;
}) {
  const t = useTranslations('events.timeline');
  const [view, setView] = useState<View>('total');
  const tz = report.timezone;
  const multiDay = report.event.startDate !== report.event.endDate;
  const activeTills = report.tills.filter((x) => x.documentsCount > 0);
  const tillIds = activeTills.map((x) => x.machineId);
  // At most 14 days of quarter hours: cheap enough to rebuild on every render.
  const rows = timelineRows(rebucket(report.timeline, bucket), tillIds, (iso) => clockLabel(iso, tz, multiDay));
  const hasSales = report.kpis.documentsCount > 0;
  const names = Object.fromEntries(report.tills.map((x) => [x.machineId, x.name]));
  const maxPerHour = Math.max(1, ...activeTills.map((x) => x.salesPerHour), report.kpis.avgPerActiveHour);

  return (
    <div className="space-y-3">
      <Card>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2 print:hidden">
          <Segmented
            value={String(bucket) as '15' | '30' | '60'}
            onChange={(v) => onBucket(Number(v) as BucketMinutes)}
            className="w-56"
            label={t('bucket')}
            options={[
              { id: '15', label: t('minutes', { n: 15 }) },
              { id: '30', label: t('minutes', { n: 30 }) },
              { id: '60', label: t('hour') },
            ]}
          />
          <Segmented
            value={view}
            onChange={setView}
            className="w-56"
            label={t('view')}
            options={[
              { id: 'total', label: t('total') },
              { id: 'tills', label: t('byTill') },
            ]}
          />
        </div>
        {!hasSales ? (
          <Muted>{t('empty')}</Muted>
        ) : (
          <div className="h-72 print:h-56" dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              {view === 'total' ? (
                <ComposedChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
                  <CartesianGrid vertical={false} stroke={CHART.grid} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#8E8E93' }} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={16} />
                  <YAxis yAxisId="net" tickFormatter={compactMoney} tick={{ fontSize: 11, fill: '#8E8E93' }} axisLine={false} tickLine={false} width={56} orientation="right" />
                  <YAxis yAxisId="cum" tickFormatter={compactMoney} tick={{ fontSize: 11, fill: '#8E8E93' }} axisLine={false} tickLine={false} width={56} orientation="left" />
                  <Tooltip
                    contentStyle={tooltipStyle}
                    formatter={(v, name) => [money(Number(v ?? 0)), name === 'cumulative' ? t('cumulative') : t('net')]}
                  />
                  <Bar yAxisId="net" dataKey="net" name="net" fill={CHART.accent} radius={[4, 4, 0, 0]} maxBarSize={28} />
                  <Line yAxisId="cum" type="monotone" dataKey="cumulative" name="cumulative" stroke={CHART.muted} strokeWidth={2} strokeDasharray="4 4" dot={false} />
                </ComposedChart>
              ) : (
                <BarChart data={rows} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
                  <CartesianGrid vertical={false} stroke={CHART.grid} />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#8E8E93' }} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={16} />
                  <YAxis tickFormatter={compactMoney} tick={{ fontSize: 11, fill: '#8E8E93' }} axisLine={false} tickLine={false} width={56} orientation="right" />
                  <Tooltip contentStyle={tooltipStyle} formatter={(v, name) => [money(Number(v ?? 0)), names[String(name)] ?? String(name)]} />
                  <Legend formatter={(value) => names[String(value)] ?? String(value)} wrapperStyle={{ fontSize: 12, direction: 'rtl' }} />
                  {tillIds.map((id, i) => (
                    <Bar key={id} dataKey={id} name={id} stackId="tills" fill={tillColor(i)} maxBarSize={28} />
                  ))}
                </BarChart>
              )}
            </ResponsiveContainer>
          </div>
        )}
        {view === 'total' && hasSales ? (
          <div className="mt-2 flex flex-wrap gap-4 text-[12px] text-[#8E8E93]">
            <span className="flex items-center gap-1">
              <span className="h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: CHART.accent }} aria-hidden />
              {t('netPerBucket', { minutes: bucket })}
            </span>
            <span className="flex items-center gap-1">
              <span className="h-0 w-4 border-t-2 border-dashed" style={{ borderColor: CHART.muted }} aria-hidden />
              {t('cumulative')}
            </span>
          </div>
        ) : null}
      </Card>

      {activeTills.length > 0 ? (
        <Card className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-[13px] text-[#8E8E93]">{t('perHourTitle')}</span>
            <span className="text-[13px] text-[#8E8E93]">
              {t('eventPerHour', { value: money(report.kpis.avgPerActiveHour) })}
              {report.medianSalesPerHour ? ` · ${t('median', { value: money(report.medianSalesPerHour) })}` : ''}
            </span>
          </div>
          <ul className="space-y-2">
            {activeTills
              .slice()
              .sort((a, b) => b.salesPerHour - a.salesPerHour)
              .map((till) => {
                const color = till.weak ? '#FF3B30' : tillColor(tillIds.indexOf(till.machineId));
                return (
                  <li key={till.machineId} className="grid grid-cols-[minmax(6rem,10rem)_1fr_auto] items-center gap-3">
                    <span className="truncate text-[14px]">{till.name}</span>
                    <Capsule value={till.salesPerHour} max={maxPerHour} color={color} />
                    <span className="text-[13px] font-semibold tabular-nums">{t('perHour', { value: money(till.salesPerHour) })}</span>
                  </li>
                );
              })}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
