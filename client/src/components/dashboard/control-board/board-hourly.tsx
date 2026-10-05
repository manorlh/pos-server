'use client';

/**
 * The day by the hour: the chosen day as a blue area with its points, the compared day
 * as a dashed line over it — by the hour, or running totals ("מצטבר"). A day still
 * running stops at the current hour.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatCurrency } from '@/lib/format';
import { peakHour, type HourPoint } from '@/lib/controlBoard';
import { Skeleton } from '@/components/ui/skeleton';
import { BoardCard, CardTitle, Delta, Segmented } from './board-ui';

const BLUE = 'var(--cb-blue)';
const GREY = 'var(--cb-muted)';

/** ₪1.2K on the axis: the exact figures are in the tooltip. */
function axisMoney(n: number): string {
  if (Math.abs(n) >= 1000) return `₪${(n / 1000).toLocaleString('he-IL', { maximumFractionDigits: 1 })}K`;
  return `₪${Math.round(n)}`;
}

function Legend({ labelA, labelB }: { labelA: string; labelB: string | null }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-cb-muted">
      <span className="inline-flex items-center gap-1.5">
        <span aria-hidden className="h-[3px] w-4 rounded-full bg-cb-blue" />
        {labelA}
      </span>
      {labelB ? (
        <span className="inline-flex items-center gap-1.5">
          <svg aria-hidden width="16" height="3" className="overflow-visible">
            <line x1="0" y1="1.5" x2="16" y2="1.5" stroke={GREY} strokeWidth="2" strokeDasharray="4 3" />
          </svg>
          {labelB}
        </span>
      ) : null}
    </div>
  );
}

export function BoardHourly({
  points,
  labelA,
  labelB,
  loading,
  className,
}: {
  points: HourPoint[];
  labelA: string;
  /** Null with no comparison. */
  labelB: string | null;
  loading: boolean;
  className?: string;
}) {
  const t = useTranslations('controlBoard.hourly');
  const [view, setView] = useState<'hourly' | 'cumulative'>('hourly');
  const cumulative = view === 'cumulative';
  const keyA = cumulative ? 'ca' : 'a';
  const keyB = cumulative ? 'cb' : 'b';
  const peak = peakHour(points);

  return (
    <BoardCard className={className} labelledBy="cb-hourly-title">
      <CardTitle
        id="cb-hourly-title"
        trailing={
          <Segmented
            label={t('title')}
            value={view}
            onChange={setView}
            options={[
              { id: 'hourly', label: t('byHour') },
              { id: 'cumulative', label: t('cumulative') },
            ]}
          />
        }
      >
        {t('title')}
      </CardTitle>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Legend labelA={labelA} labelB={labelB} />
        {peak !== null ? (
          <span className="text-xs text-cb-muted">
            {t('peak', { hour: `${String(peak).padStart(2, '0')}:00` })}
          </span>
        ) : null}
      </div>
      {loading && points.length === 0 ? (
        <Skeleton className="mt-3 h-52 w-full bg-cb-soft" />
      ) : points.length === 0 ? (
        <p className="flex h-52 items-center justify-center text-sm text-cb-muted">{t('empty')}</p>
      ) : (
        <div className="mt-2 h-52 md:h-60" dir="ltr">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={points} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
              <defs>
                <linearGradient id="cb-hourly-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={BLUE} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={BLUE} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="var(--cb-line)" />
              <XAxis
                dataKey="label"
                tick={{ fontSize: 11, fill: GREY }}
                axisLine={false}
                tickLine={false}
                interval="preserveStartEnd"
                minTickGap={16}
              />
              <YAxis
                orientation="right"
                tick={{ fontSize: 11, fill: GREY }}
                axisLine={false}
                tickLine={false}
                width={48}
                tickFormatter={axisMoney}
              />
              <Tooltip
                cursor={{ stroke: 'var(--cb-line)', strokeWidth: 1 }}
                content={({ active, payload }) => {
                  const p = payload?.[0]?.payload as HourPoint | undefined;
                  if (!active || !p) return null;
                  const va = cumulative ? p.ca : p.a;
                  const vb = cumulative ? p.cb : p.b;
                  return (
                    <div
                      dir="rtl"
                      className="min-w-40 rounded-xl border border-cb-line bg-cb-card px-3 py-2 text-xs text-cb-ink shadow-lg"
                    >
                      <p className="mb-1 font-semibold tabular-nums" dir="ltr">
                        {p.label}
                      </p>
                      <p className="flex items-center justify-between gap-3">
                        <span className="text-cb-muted">{labelA}</span>
                        <span className="font-semibold tabular-nums">{va === null ? '—' : formatCurrency(va)}</span>
                      </p>
                      {labelB && vb !== null ? (
                        <p className="flex items-center justify-between gap-3">
                          <span className="text-cb-muted">{labelB}</span>
                          <span className="tabular-nums">{formatCurrency(vb)}</span>
                        </p>
                      ) : null}
                      {labelB && va !== null && vb !== null ? (
                        <p className="mt-1 text-end">
                          <Delta a={va} b={vb} />
                        </p>
                      ) : null}
                    </div>
                  );
                }}
              />
              {labelB ? (
                <Line
                  type="monotone"
                  dataKey={keyB}
                  name={labelB}
                  stroke={GREY}
                  strokeWidth={2}
                  strokeDasharray="5 4"
                  dot={false}
                  activeDot={{ r: 4, fill: GREY, stroke: 'var(--cb-card)', strokeWidth: 2 }}
                  isAnimationActive={false}
                />
              ) : null}
              <Area
                type="monotone"
                dataKey={keyA}
                name={labelA}
                stroke={BLUE}
                strokeWidth={2.5}
                fill="url(#cb-hourly-fill)"
                dot={{ r: 3.5, fill: BLUE, stroke: 'var(--cb-card)', strokeWidth: 2 }}
                activeDot={{ r: 5, fill: BLUE, stroke: 'var(--cb-card)', strokeWidth: 2 }}
                connectNulls={false}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </BoardCard>
  );
}
