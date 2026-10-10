'use client';

/**
 * The charts of "ביצועי קיוסקים" (recharts), in the insights' iOS language and chart tokens
 * (`CHART` — set on `InsightsSurface`, so dark mode follows). Each has a table view beside
 * it (the "גרף / טבלה" switch): a tooltip never is the only way to read a value.
 *
 * Marks follow the dataviz rules: bars ≤ 24px with a 4px rounded data end, 2px lines, one
 * y-axis per chart (orders and sessions are both counts, so they share it), hairline grid,
 * a legend for two series or more, the reasons' colours in a fixed order.
 */

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Area,
  LabelList,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { agorot } from '@/lib/insightsApi';
import {
  LEFT_REASONS,
  abandonmentRows,
  bucketMinutes,
  durationText,
  funnelRows,
  pctText,
  type Abandonment,
  type FunnelStage,
  type KioskDailyRow,
  type KioskHourRow,
  type LeftReason,
  type OrderTime,
} from '@/lib/kioskInsights';
import { CHART, Card, Figure, IOS, Muted, Segmented, dayMonth, hh, tooltipStyle } from '@/components/dashboard/insights/ios';
import { REASON_COLOR, REASON_VARS, useKioskLabels } from './labels';

const AXIS_TICK = { fontSize: 11, fill: '#8E8E93' };
const count = (n: number) => n.toLocaleString('he-IL');

/* ------------------------------------------------------------------ shell */

/** A card with a legend on one side and the chart / table switch on the other. */
function ChartCard({
  legend,
  chart,
  table,
  footer,
}: {
  legend?: ReactNode;
  chart: ReactNode;
  table: ReactNode;
  footer?: ReactNode;
}) {
  const ti = useTranslations('insights');
  const [view, setView] = useState<'chart' | 'table'>('chart');
  return (
    <Card>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3 text-[12px] text-[#8E8E93]">{legend}</div>
        <Segmented
          value={view}
          onChange={setView}
          className="w-36"
          options={[
            { id: 'chart', label: ti('chart') },
            { id: 'table', label: ti('table') },
          ]}
        />
      </div>
      {view === 'chart' ? chart : <div className="max-h-96 overflow-y-auto">{table}</div>}
      {footer}
    </Card>
  );
}

export function LegendRect({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1">
      <span className="h-2.5 w-2.5 rounded-[3px]" style={{ backgroundColor: color }} aria-hidden />
      {children}
    </span>
  );
}

export function LegendLine({ color, children }: { color: string; children: ReactNode }) {
  return (
    <span className="flex items-center gap-1">
      <span className="h-[3px] w-4 rounded-full" style={{ backgroundColor: color }} aria-hidden />
      {children}
    </span>
  );
}

/** The tooltip: a title, then value-first rows keyed by a short stroke of the series colour. */
function TipBox({ title, rows }: { title: ReactNode; rows: { key: string; color?: string; label: ReactNode; value: ReactNode }[] }) {
  return (
    <div className="min-w-40 bg-white px-3 py-2 text-black dark:bg-[#2C2C2E] dark:text-white" style={tooltipStyle}>
      <div className="mb-1 text-[12px] text-[#8E8E93]">{title}</div>
      {rows.map((r) => (
        <div key={r.key} className="flex items-center gap-2 text-[13px]">
          {r.color ? <span className="h-[3px] w-3 shrink-0 rounded-full" style={{ backgroundColor: r.color }} aria-hidden /> : null}
          <span className="font-semibold tabular-nums">{r.value}</span>
          <span className="text-[#8E8E93]">{r.label}</span>
        </div>
      ))}
    </div>
  );
}

/** What recharts hands a custom axis tick (x / y may come as strings). */
type TickArgs = { x?: number | string; y?: number | string; payload?: { value?: unknown } };

type TipProps<T> = { active?: boolean; payload?: ReadonlyArray<{ payload?: T }> };
const datumOf = <T,>(p: TipProps<T>): T | undefined => (p.active ? p.payload?.[0]?.payload : undefined);

const TH = 'py-1 text-start font-normal';
const THE = 'py-1 text-end font-normal';
const TR = 'border-t border-[#3C3C4349] dark:border-[#54545899]';

/* ----------------------------------------------------------------- funnel */

/** A stage's name, and under it what is lost on the way to the next stage. */
function FunnelTick(props: TickArgs & { rows: { key: string; label: string; dropPct: number | null; biggestDrop: boolean }[] }) {
  const { payload, rows } = props;
  const x = Number(props.x ?? 0);
  const y = Number(props.y ?? 0);
  const row = rows.find((r) => r.key === payload?.value);
  if (!row) return null;
  return (
    <g transform={`translate(${x},${y})`}>
      <text x={8} y={row.dropPct !== null ? -3 : 4} textAnchor="start" fontSize={13} fill="currentColor" fontWeight={row.biggestDrop ? 700 : 500}>
        {row.label}
      </text>
      {row.dropPct !== null ? (
        <text x={8} y={12} textAnchor="start" fontSize={11} fill={row.biggestDrop ? IOS.red : '#8E8E93'} fontWeight={row.biggestDrop ? 700 : 400}>
          {`▼ ${pctText(row.dropPct)}`}
        </text>
      ) : null}
    </g>
  );
}

export function FunnelChart({ funnel }: { funnel: FunnelStage[] }) {
  const t = useTranslations('kioskInsights.funnel');
  const L = useKioskLabels();
  const rows = funnelRows(funnel).map((r) => ({
    ...r,
    label: L.funnel(r.key),
    end: `${count(r.sessions)} · ${pctText(r.pctOfStart, 0)}`,
  }));
  if (rows.length === 0 || rows[0].sessions === 0) return <Card><Muted>{t('empty')}</Muted></Card>;
  const height = rows.length * 52 + 8;
  return (
    <ChartCard
      legend={
        <>
          <span>{t('legend')}</span>
          <span className="flex items-center gap-1">
            <span className="font-bold" style={{ color: IOS.red }} aria-hidden>▼</span>
            {t('biggestDropLegend')}
          </span>
        </>
      }
      chart={
        <div style={{ height }} dir="ltr">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 0, bottom: 4, left: 4 }} barCategoryGap={14}>
              <XAxis type="number" hide reversed domain={[0, (max: number) => Math.max(1, Math.ceil(max * 1.3))]} />
              <YAxis
                type="category"
                dataKey="key"
                orientation="right"
                width={150}
                axisLine={false}
                tickLine={false}
                interval={0}
                tick={(p: TickArgs) => <FunnelTick {...p} rows={rows} />}
              />
              <Tooltip
                cursor={{ fill: CHART.accentWash }}
                content={(p: TipProps<(typeof rows)[number]>) => {
                  const d = datumOf(p);
                  if (!d) return null;
                  return (
                    <TipBox
                      title={d.label}
                      rows={[
                        { key: 's', color: CHART.accent, label: t('sessions'), value: count(d.sessions) },
                        { key: 'p', label: t('pctOfStart'), value: pctText(d.pctOfStart) },
                        ...(d.dropToNext !== null ? [{ key: 'd', label: t('dropTip'), value: `${count(d.dropToNext)} (${pctText(d.dropPct)})` }] : []),
                      ]}
                    />
                  );
                }}
              />
              <Bar dataKey="sessions" fill={CHART.accent} radius={[4, 0, 0, 4]} maxBarSize={24} isAnimationActive={false}>
                <LabelList dataKey="end" position="left" fontSize={12} fill="currentColor" />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      }
      table={
        <table className="w-full text-[15px]">
          <thead className="sticky top-0 bg-white dark:bg-[#1C1C1E]">
            <tr className="text-[13px] text-[#8E8E93]">
              <th className={TH}>{t('stage')}</th>
              <th className={THE}>{t('sessions')}</th>
              <th className={THE}>{t('pctOfStart')}</th>
              <th className={THE}>{t('dropPct')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className={TR}>
                <td className={r.biggestDrop ? 'py-1.5 font-semibold' : 'py-1.5'}>{r.label}</td>
                <td className="py-1.5 text-end tabular-nums">{count(r.sessions)}</td>
                <td className="py-1.5 text-end tabular-nums">{pctText(r.pctOfStart)}</td>
                <td className="py-1.5 text-end tabular-nums" style={r.biggestDrop ? { color: IOS.red } : undefined}>
                  {r.dropToNext !== null ? `${count(r.dropToNext)} · ${pctText(r.dropPct)}` : '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    />
  );
}

/* ------------------------------------------------------------ abandonment */

function StepTick(props: TickArgs & { rows: { step: string; label: string; worst: boolean; count: number; pct: number | null }[] }) {
  const { payload, rows } = props;
  const x = Number(props.x ?? 0);
  const y = Number(props.y ?? 0);
  const row = rows.find((r) => r.step === payload?.value);
  if (!row) return null;
  return (
    <g transform={`translate(${x},${y})`}>
      {row.worst ? <circle cx={4} cy={-1} r={4} fill={IOS.red} /> : null}
      <text x={row.worst ? 14 : 8} y={-3} textAnchor="start" fontSize={13} fill="currentColor" fontWeight={row.worst ? 700 : 500}>
        {row.label}
      </text>
      <text x={row.worst ? 14 : 8} y={12} textAnchor="start" fontSize={11} fill="#8E8E93">
        {`${count(row.count)} · ${pctText(row.pct)}`}
      </text>
    </g>
  );
}

export function AbandonmentChart({ abandonment }: { abandonment: Abandonment }) {
  const t = useTranslations('kioskInsights.abandonment');
  const L = useKioskLabels();
  const rows = abandonmentRows(abandonment).map((r) => ({ ...r, label: L.step(r.step) }));
  if (rows.length === 0) return <Card><Muted>{t('empty')}</Muted></Card>;
  const used = LEFT_REASONS.filter((r) => rows.some((row) => row[r] > 0));
  const height = rows.length * 48 + 8;
  return (
    <div className={REASON_VARS}>
      <ChartCard
        legend={
          <>
            {used.map((r) => (
              <LegendRect key={r} color={REASON_COLOR[r]}>
                {L.reason(r)}
              </LegendRect>
            ))}
            <span className="flex items-center gap-1">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: IOS.red }} aria-hidden />
              {t('worstLegend')}
            </span>
          </>
        }
        chart={
          <div style={{ height }} dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 0, bottom: 4, left: 4 }} barCategoryGap={12}>
                <XAxis type="number" hide reversed />
                <YAxis
                  type="category"
                  dataKey="step"
                  orientation="right"
                  width={150}
                  axisLine={false}
                  tickLine={false}
                  interval={0}
                  tick={(p: TickArgs) => <StepTick {...p} rows={rows} />}
                />
                <Tooltip
                  cursor={{ fill: CHART.accentWash }}
                  content={(p: TipProps<(typeof rows)[number]>) => {
                    const d = datumOf(p);
                    if (!d) return null;
                    return (
                      <TipBox
                        title={`${d.label} · ${count(d.count)} (${pctText(d.pct)})`}
                        rows={LEFT_REASONS.filter((r) => d[r] > 0).map((r) => ({ key: r, color: REASON_COLOR[r], label: L.reason(r), value: count(d[r]) }))}
                      />
                    );
                  }}
                />
                {used.map((r: LeftReason) => (
                  <Bar
                    key={r}
                    dataKey={r}
                    stackId="left"
                    fill={REASON_COLOR[r]}
                    stroke={CHART.surface}
                    strokeWidth={2}
                    maxBarSize={24}
                    isAnimationActive={false}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        }
        table={
          <table className="w-full text-[15px]">
            <thead className="sticky top-0 bg-white dark:bg-[#1C1C1E]">
              <tr className="text-[13px] text-[#8E8E93]">
                <th className={TH}>{t('step')}</th>
                <th className={THE}>{t('count')}</th>
                <th className={THE}>{t('pct')}</th>
                {used.map((r) => (
                  <th key={r} className={THE}>
                    {L.reason(r)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.step} className={TR}>
                  <td className={r.worst ? 'py-1.5 font-semibold' : 'py-1.5'}>{r.label}</td>
                  <td className="py-1.5 text-end tabular-nums">{count(r.count)}</td>
                  <td className="py-1.5 text-end tabular-nums">{pctText(r.pct)}</td>
                  {used.map((reason) => (
                    <td key={reason} className="py-1.5 text-end tabular-nums text-[#8E8E93]">
                      {r[reason] ? count(r[reason]) : '—'}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        }
      />
    </div>
  );
}

/* ------------------------------------------------------------- order time */

export function OrderTimeChart({ orderTime }: { orderTime: OrderTime }) {
  const t = useTranslations('kioskInsights.orderTime');
  if (orderTime.count === 0) return <Card><Muted>{t('empty')}</Muted></Card>;
  const data = orderTime.buckets.map((b) => {
    const m = bucketMinutes(b);
    return { ...b, label: m.to === null ? t('bucketOpen', { from: m.from }) : t('bucket', { from: m.from, to: m.to }) };
  });
  return (
    <ChartCard
      legend={<span>{t('hint', { n: count(orderTime.count) })}</span>}
      chart={
        <>
          <div className="mb-3 grid grid-cols-3 divide-x divide-x-reverse divide-[#3C3C4349] dark:divide-[#54545899]">
            <Figure value={durationText(orderTime.medianSec)} label={t('median')} />
            <Figure value={durationText(orderTime.avgSec)} label={t('avg')} />
            <Figure value={durationText(orderTime.p90Sec)} label={t('p90')} />
          </div>
          <div className="h-48" dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ top: 16, right: 4, bottom: 0, left: 4 }}>
                <CartesianGrid vertical={false} stroke={CHART.grid} />
                <XAxis dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} interval={0} />
                <YAxis allowDecimals={false} tick={AXIS_TICK} axisLine={false} tickLine={false} width={36} orientation="right" />
                <Tooltip
                  cursor={{ fill: CHART.accentWash }}
                  content={(p: TipProps<(typeof data)[number]>) => {
                    const d = datumOf(p);
                    if (!d) return null;
                    return <TipBox title={d.label} rows={[{ key: 'n', color: CHART.accent, label: t('orders'), value: count(d.count) }]} />;
                  }}
                />
                <Bar dataKey="count" fill={CHART.accent} radius={[4, 4, 0, 0]} maxBarSize={24} isAnimationActive={false}>
                  <LabelList dataKey="count" position="top" fontSize={11} fill="#8E8E93" />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </>
      }
      table={
        <table className="w-full text-[15px]">
          <thead className="sticky top-0 bg-white dark:bg-[#1C1C1E]">
            <tr className="text-[13px] text-[#8E8E93]">
              <th className={TH}>{t('range')}</th>
              <th className={THE}>{t('orders')}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.fromSec} className={TR}>
                <td className="py-1.5">{d.label}</td>
                <td className="py-1.5 text-end tabular-nums">{count(d.count)}</td>
              </tr>
            ))}
            <tr className={TR}>
              <td className="py-1.5 text-[#8E8E93]">{t('median')} · {t('avg')} · {t('p90')}</td>
              <td className="py-1.5 text-end tabular-nums" dir="ltr">
                {durationText(orderTime.medianSec)} · {durationText(orderTime.avgSec)} · {durationText(orderTime.p90Sec)}
              </td>
            </tr>
          </tbody>
        </table>
      }
    />
  );
}

/* ---------------------------------------------------------------- by hour */

export function ByHourChart({ rows }: { rows: KioskHourRow[] }) {
  const t = useTranslations('kioskInsights.byHour');
  // Only the hours that saw anything, edges trimmed (a kiosk is not open at 04:00).
  const active = rows.filter((r) => r.orders > 0 || r.sessions > 0).map((r) => r.hour);
  if (active.length === 0) return <Card><Muted>{t('empty')}</Muted></Card>;
  const lo = Math.min(...active);
  const hi = Math.max(...active);
  const data = rows.filter((r) => r.hour >= lo && r.hour <= hi).map((r) => ({ ...r, label: hh(r.hour) }));
  return (
    <ChartCard
      legend={
        <>
          <LegendRect color={CHART.accent}>{t('orders')}</LegendRect>
          <LegendLine color={CHART.muted}>{t('sessions')}</LegendLine>
        </>
      }
      chart={
        <div className="h-56" dir="ltr">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: 4 }}>
              <CartesianGrid vertical={false} stroke={CHART.grid} />
              <XAxis dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={10} />
              <YAxis allowDecimals={false} tick={AXIS_TICK} axisLine={false} tickLine={false} width={36} orientation="right" />
              <Tooltip
                cursor={{ fill: CHART.accentWash }}
                content={(p: TipProps<(typeof data)[number]>) => {
                  const d = datumOf(p);
                  if (!d) return null;
                  return (
                    <TipBox
                      title={d.label}
                      rows={[
                        { key: 'o', color: CHART.accent, label: t('orders'), value: count(d.orders) },
                        { key: 's', color: CHART.muted, label: t('sessions'), value: count(d.sessions) },
                        { key: 'r', label: t('revenue'), value: agorot(d.revenue) },
                      ]}
                    />
                  );
                }}
              />
              <Bar dataKey="orders" fill={CHART.accent} radius={[4, 4, 0, 0]} maxBarSize={18} isAnimationActive={false} />
              <Line type="monotone" dataKey="sessions" stroke={CHART.muted} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: CHART.surface }} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      }
      table={
        <table className="w-full text-[15px]">
          <thead className="sticky top-0 bg-white dark:bg-[#1C1C1E]">
            <tr className="text-[13px] text-[#8E8E93]">
              <th className={TH}>{t('hour')}</th>
              <th className={THE}>{t('sessions')}</th>
              <th className={THE}>{t('orders')}</th>
              <th className={THE}>{t('revenue')}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.hour} className={TR}>
                <td className="py-1.5 tabular-nums">{d.label}</td>
                <td className="py-1.5 text-end tabular-nums">{count(d.sessions)}</td>
                <td className="py-1.5 text-end tabular-nums">{count(d.orders)}</td>
                <td className="py-1.5 text-end tabular-nums">{agorot(d.revenue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    />
  );
}

/* ------------------------------------------------------------------ daily */

export function DailyChart({ rows }: { rows: KioskDailyRow[] }) {
  const t = useTranslations('kioskInsights.daily');
  const ti = useTranslations('insights');
  const short = ti.raw('weekdayShort') as string[];
  if (!rows.some((r) => r.sessions > 0 || r.orders > 0)) return <Card><Muted>{t('empty')}</Muted></Card>;
  const label = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    return `${short[weekday] ?? ''} ${dayMonth(iso)}`.trim();
  };
  const data = rows.map((r) => ({ ...r, label: label(r.date) }));
  return (
    <ChartCard
      legend={
        <>
          <LegendLine color={CHART.accent}>{t('orders')}</LegendLine>
          <LegendLine color={CHART.muted}>{t('sessions')}</LegendLine>
        </>
      }
      chart={
        <div className="h-56" dir="ltr">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 6, right: 4, bottom: 0, left: 4 }}>
              <CartesianGrid vertical={false} stroke={CHART.grid} />
              <XAxis dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={18} />
              <YAxis allowDecimals={false} tick={AXIS_TICK} axisLine={false} tickLine={false} width={36} orientation="right" />
              <Tooltip
                content={(p: TipProps<(typeof data)[number]>) => {
                  const d = datumOf(p);
                  if (!d) return null;
                  return (
                    <TipBox
                      title={d.label}
                      rows={[
                        { key: 'o', color: CHART.accent, label: t('orders'), value: count(d.orders) },
                        { key: 's', color: CHART.muted, label: t('sessions'), value: count(d.sessions) },
                        { key: 'c', label: t('conversion'), value: pctText(d.conversion) },
                        { key: 'r', label: t('revenue'), value: agorot(d.revenue) },
                      ]}
                    />
                  );
                }}
              />
              <Line type="monotone" dataKey="sessions" stroke={CHART.muted} strokeWidth={2} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: CHART.surface }} isAnimationActive={false} />
              <Area type="monotone" dataKey="orders" stroke={CHART.accent} strokeWidth={2} fill={CHART.accentWash} dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: CHART.surface }} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      }
      table={
        <table className="w-full text-[15px]">
          <thead className="sticky top-0 bg-white dark:bg-[#1C1C1E]">
            <tr className="text-[13px] text-[#8E8E93]">
              <th className={TH}>{t('day')}</th>
              <th className={THE}>{t('sessions')}</th>
              <th className={THE}>{t('orders')}</th>
              <th className={THE}>{t('conversion')}</th>
              <th className={THE}>{t('revenue')}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.date} className={TR}>
                <td className="py-1.5">{d.label}</td>
                <td className="py-1.5 text-end tabular-nums">{count(d.sessions)}</td>
                <td className="py-1.5 text-end tabular-nums">{count(d.orders)}</td>
                <td className="py-1.5 text-end tabular-nums">{pctText(d.conversion)}</td>
                <td className="py-1.5 text-end tabular-nums">{agorot(d.revenue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      }
    />
  );
}
