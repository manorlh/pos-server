'use client';

/**
 * Forecast (תחזית): today so far against a usual day of the same weekday up to the same
 * minute, the next seven days (the same weekday's last four weeks, weighted 4-3-2-1, a
 * holiday dropped; the bar's whisker is the range those weeks spanned), tomorrow by the
 * hour for staffing, and how accurate the method was on the last two weeks.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Bar, BarChart, CartesianGrid, ErrorBar, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { agorot, type Forecast } from '@/lib/insightsApi';
import { CHART, Card, Delta, Figure, Muted, Segmented, dayMonth, hh, tooltipStyle } from './ios';

export function compactMoney(value: number): string {
  return new Intl.NumberFormat('he-IL', {
    style: 'currency',
    currency: 'ILS',
    notation: 'compact',
    maximumFractionDigits: 1,
  }).format(value / 100);
}

export function ForecastSection({ data }: { data: Forecast }) {
  const t = useTranslations('insights.forecast');
  const tr = useTranslations('insights');
  const weekdays = tr.raw('weekdayNames') as string[];
  const short = tr.raw('weekdayShort') as string[];
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const pace = data.pace;
  const days = data.days.map((d) => ({
    ...d,
    label: `${short[d.weekday]} ${dayMonth(d.date)}`,
    value: d.net ?? 0,
    err: d.net !== null && d.low !== null && d.high !== null ? [Math.max(0, d.net - d.low), Math.max(0, d.high - d.net)] : [0, 0],
  }));
  const anyForecast = data.days.some((d) => d.net !== null);
  const tomorrow = data.days[0];
  const confidence = (c: string) =>
    c === 'high' ? t('confidence.high') : c === 'medium' ? t('confidence.medium') : c === 'low' ? t('confidence.low') : t('confidence.none');

  return (
    <div className="space-y-3">
      {pace ? (
        <Card className="p-0">
          <div className="px-4 pt-3 text-[13px] text-[#8E8E93]">
            {t('paceTitle', { weekday: weekdays[pace.weekday], hour: hh(pace.asOfHour), weeks: pace.weeks })}
          </div>
          <div className="grid grid-cols-3 divide-x divide-x-reverse divide-[#3C3C4349] py-3 dark:divide-[#54545899]">
            <Figure
              value={agorot(pace.actual)}
              label={t('soFar')}
              sub={pace.judgeable && pace.pacePct !== null ? <Delta a={pace.actual} b={pace.expectedSoFar} pct={pace.pacePct} /> : null}
            />
            <Figure value={agorot(pace.expectedSoFar)} label={t('usualSoFar')} sub={<span className="text-[#8E8E93]">{t('range', { low: agorot(pace.lowSoFar), high: agorot(pace.highSoFar) })}</span>} />
            <Figure value={agorot(pace.projected)} label={t('projected')} sub={<span className="text-[#8E8E93]">{t('usualDay', { value: agorot(pace.expectedFull) })}</span>} />
          </div>
          {!pace.judgeable ? <Muted className="px-4 pb-3 text-[13px]">{t('tooEarly')}</Muted> : null}
        </Card>
      ) : null}

      <Card>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-[17px] font-semibold">{t('nextDays')}</div>
            {data.nextWeekTotal !== null ? (
              <div className="flex flex-wrap items-center gap-2 text-[13px] text-[#8E8E93]">
                <span>{t('weekTotal', { total: agorot(data.nextWeekTotal), last: agorot(data.lastWeekTotal) })}</span>
                {data.nextWeekChangePct !== null ? <Delta a={data.nextWeekTotal} b={data.lastWeekTotal} pct={data.nextWeekChangePct} /> : null}
              </div>
            ) : null}
          </div>
          <Segmented
            value={view}
            onChange={setView}
            className="w-36"
            options={[{ id: 'chart', label: tr('chart') }, { id: 'table', label: tr('table') }]}
          />
        </div>
        {!anyForecast ? (
          <Muted>{t('noHistory')}</Muted>
        ) : view === 'chart' ? (
          <div className="h-56" dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={days} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
                <CartesianGrid vertical={false} stroke={CHART.grid} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#8E8E93' }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={compactMoney} tick={{ fontSize: 11, fill: '#8E8E93' }} axisLine={false} tickLine={false} width={56} orientation="right" />
                <Tooltip
                  cursor={{ fill: 'rgba(118,118,128,0.08)' }}
                  contentStyle={tooltipStyle}
                  formatter={(_v, _n, item) => {
                    const d = item?.payload as (typeof days)[number] | undefined;
                    return d ? [`${agorot(d.net)} (${agorot(d.low)}–${agorot(d.high)})`, t('forecast')] : ['', ''];
                  }}
                />
                <Bar dataKey="value" name={t('forecast')} fill={CHART.accent} radius={[4, 4, 0, 0]} maxBarSize={24}>
                  <ErrorBar dataKey="err" width={6} strokeWidth={1.5} stroke={CHART.muted} direction="y" />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <table className="w-full text-[15px]">
            <thead>
              <tr className="text-[13px] text-[#8E8E93]">
                <th className="py-1 text-start font-normal">{t('day')}</th>
                <th className="py-1 text-end font-normal">{t('forecast')}</th>
                <th className="py-1 text-end font-normal">{t('rangeCol')}</th>
                <th className="py-1 text-end font-normal">{t('confidenceCol')}</th>
              </tr>
            </thead>
            <tbody>
              {data.days.map((d) => (
                <tr key={d.date} className="border-t border-[#3C3C4349] dark:border-[#54545899]">
                  <td className="py-1.5">{weekdays[d.weekday]} {dayMonth(d.date)}</td>
                  <td className="py-1.5 text-end font-semibold tabular-nums">{agorot(d.net)}</td>
                  <td className="py-1.5 text-end tabular-nums text-[#8E8E93]">{d.net !== null ? `${agorot(d.low)}–${agorot(d.high)}` : '—'}</td>
                  <td className="py-1.5 text-end text-[13px]">{confidence(d.confidence)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="mt-2 text-[13px] text-[#8E8E93]">
          {data.accuracy.accuracy !== null
            ? t('accuracy', { pct: Math.round(data.accuracy.accuracy), days: data.accuracy.days })
            : t('accuracyUnknown')}{' '}
          {t('method')}
        </p>
      </Card>

      {tomorrow && tomorrow.net !== null && data.tomorrowHourly.length > 0 ? (
        <Card>
          <div className="mb-2 text-[17px] font-semibold">
            {t('tomorrowByHour', { weekday: weekdays[tomorrow.weekday], net: agorot(tomorrow.net) })}
          </div>
          <div className="h-44" dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data.tomorrowHourly.map((h) => ({ ...h, label: hh(h.hour) }))} margin={{ top: 6, right: 4, bottom: 0, left: 4 }}>
                <CartesianGrid vertical={false} stroke={CHART.grid} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#8E8E93' }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                <YAxis tickFormatter={compactMoney} tick={{ fontSize: 11, fill: '#8E8E93' }} axisLine={false} tickLine={false} width={56} orientation="right" />
                <Tooltip
                  cursor={{ fill: 'rgba(118,118,128,0.08)' }}
                  contentStyle={tooltipStyle}
                  formatter={(v, _n, item) => {
                    const h = item?.payload as { share: number; docs: number } | undefined;
                    return [`${agorot(Number(v ?? 0))} · ${t('hourShare', { share: h?.share ?? 0, docs: h?.docs ?? 0 })}`, t('forecast')];
                  }}
                />
                <Bar dataKey="net" fill={CHART.accent} radius={[4, 4, 0, 0]} maxBarSize={20} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-2 text-[13px] text-[#8E8E93]">{t('staffingHint')}</p>
        </Card>
      ) : null}
    </div>
  );
}
