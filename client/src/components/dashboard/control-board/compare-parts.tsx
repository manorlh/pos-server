'use client';

/**
 * The comparisons' cards (השוואות): the headline figures with their change as a number and
 * a percent, the two periods' curves overlaid, lists of A against B (cashiers, the scope's
 * breakdown, hour by hour), and the card brands. Built on the board's tokens (board-ui), so
 * light and dark follow the system exactly as the board does.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Area, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { BarChart3, CreditCard, Hash, Package, Percent, ReceiptText, RotateCcw, Tag, Wallet } from 'lucide-react';
import { formatCurrency, formatQuantity, formatShortDate } from '@/lib/format';
import { delta, peakIndex, type CurvePoint, type FiguresLike } from '@/lib/periodCompare';
import type { CardBrandsReport } from '@/lib/salesReportsApi';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { BoardCard, CardTitle, Delta, DeltaPill, IconBadge, Segmented, type BadgeTone } from './board-ui';

const BLUE = 'var(--cb-blue)';
const GREY = 'var(--cb-muted)';

/** The compared figure, whole shekels from ₪1,000 up: it has to fit beside the change on a phone. */
export function shortMoney(n: number): string {
  return new Intl.NumberFormat('he-IL', {
    style: 'currency',
    currency: 'ILS',
    maximumFractionDigits: Math.abs(n) >= 1000 ? 0 : 2,
  }).format(n);
}

/** ₪1.2K on the axis: the exact figures are in the tooltip. */
export function axisMoney(n: number): string {
  if (Math.abs(n) >= 1000) return `₪${(n / 1000).toLocaleString('he-IL', { maximumFractionDigits: 1 })}K`;
  return `₪${Math.round(n)}`;
}

/** "+₪1,234" / "−12" — the change as a number, signed. */
export function signedText(value: number, money: boolean): string {
  if (Math.abs(value) < (money ? 0.005 : 0.0005)) return money ? shortMoney(0) : '0';
  const sign = value > 0 ? '+' : '−';
  return `${sign}${money ? shortMoney(Math.abs(value)) : formatQuantity(Math.abs(value))}`;
}

// ── Headline figures ─────────────────────────────────────────────────────────

type FigureKey = keyof FiguresLike;

const KPI: { key: FigureKey; icon: React.ElementType; tone: BadgeTone; money: boolean; invert?: boolean }[] = [
  { key: 'sales', icon: BarChart3, tone: 'blue', money: true },
  { key: 'salesCount', icon: ReceiptText, tone: 'blue', money: false },
  { key: 'averageTicket', icon: Tag, tone: 'purple', money: true },
  { key: 'items', icon: Package, tone: 'teal', money: false },
  { key: 'documents', icon: Hash, tone: 'teal', money: false },
  { key: 'discounts', icon: Percent, tone: 'amber', money: true, invert: true },
  { key: 'refunds', icon: RotateCcw, tone: 'red', money: true, invert: true },
  { key: 'tips', icon: Wallet, tone: 'green', money: true },
];

export function CompareKpis({
  current,
  previous,
  labelB,
  loading,
  compareLoading,
}: {
  current: FiguresLike | null;
  previous: FiguresLike | null;
  /** "מול שבוע שעבר"; null with no comparison. */
  labelB: string | null;
  loading: boolean;
  compareLoading: boolean;
}) {
  const t = useTranslations('controlBoard.compareView');
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
      {KPI.map(({ key, icon, tone, money, invert }) => {
        const a = current?.[key] ?? 0;
        const b = previous?.[key] ?? 0;
        const d = delta(a, b);
        return (
          <div
            key={key}
            className="flex min-w-0 flex-col gap-1 rounded-2xl border border-cb-line bg-cb-card p-3.5 shadow-[var(--cb-shadow)] md:p-5"
          >
            <div className="flex items-start justify-between gap-2">
              <span className="min-w-0 pt-0.5 text-[13px] font-medium text-cb-muted md:text-sm">{t(`figures.${key}`)}</span>
              <IconBadge icon={icon} tone={tone} className="max-md:size-8 max-md:[&>svg]:size-4" />
            </div>
            {loading ? (
              <Skeleton className="mt-1 h-8 w-24 bg-cb-soft" />
            ) : (
              <>
                <p className="truncate text-[22px] font-bold leading-tight tracking-tight tabular-nums text-cb-ink md:text-[26px]">
                  {money ? formatCurrency(a) : formatQuantity(a)}
                </p>
                {previous && labelB && !compareLoading ? (
                  <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-cb-muted" title={labelB}>
                    <Delta a={a} b={b} invert={invert} />
                    <span className="tabular-nums" dir="ltr">{signedText(d.abs, money)}</span>
                    <span className="w-full truncate tabular-nums">
                      {t('versus', { value: money ? shortMoney(b) : formatQuantity(b) })}
                    </span>
                  </div>
                ) : null}
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── The curves ───────────────────────────────────────────────────────────────

export function CompareChart({
  points,
  labelA,
  labelB,
  granularity,
  alignment,
  loading,
  className,
}: {
  points: CurvePoint[];
  labelA: string;
  labelB: string | null;
  granularity: 'hour' | 'day';
  alignment: 'clock' | 'elapsed';
  loading: boolean;
  className?: string;
}) {
  const t = useTranslations('controlBoard.compareView.chart');
  const [view, setView] = useState<'bucket' | 'cumulative'>('bucket');
  const cumulative = view === 'cumulative';
  const keyA = cumulative ? 'ca' : 'a';
  const keyB = cumulative ? 'cb' : 'b';
  const byDay = granularity === 'day';
  const tick = (p: CurvePoint) => (byDay && p.dateA ? formatShortDate(p.dateA) : p.label);
  const data = points.map((p) => ({ ...p, tick: tick(p) }));
  const peak = peakIndex(points);
  const peakPoint = points.find((p) => p.index === peak);
  const subtitle = alignment === 'elapsed' ? t('sinceStart') : byDay ? t('byDay') : t('byHour');

  return (
    <BoardCard className={className} labelledBy="cb-compare-chart">
      <CardTitle
        id="cb-compare-chart"
        trailing={
          <Segmented
            label={t('title')}
            value={view}
            onChange={setView}
            options={[
              { id: 'bucket', label: t('perBucket') },
              { id: 'cumulative', label: t('cumulative') },
            ]}
          />
        }
      >
        {t('title')} · {subtitle}
      </CardTitle>
      <div className="flex flex-wrap items-center justify-between gap-2">
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
        {peakPoint ? <span className="text-xs text-cb-muted">{t('peak', { label: tick(peakPoint) })}</span> : null}
      </div>
      {loading && points.length === 0 ? (
        <Skeleton className="mt-3 h-56 w-full bg-cb-soft" />
      ) : points.length === 0 ? (
        <p className="flex h-56 items-center justify-center text-sm text-cb-muted">{t('empty')}</p>
      ) : (
        <div className="mt-2 h-56 md:h-64" dir="ltr">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
              <defs>
                <linearGradient id="cb-compare-fill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={BLUE} stopOpacity={0.28} />
                  <stop offset="100%" stopColor={BLUE} stopOpacity={0.02} />
                </linearGradient>
              </defs>
              <CartesianGrid vertical={false} stroke="var(--cb-line)" />
              <XAxis dataKey="tick" tick={{ fontSize: 11, fill: GREY }} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={16} />
              <YAxis orientation="right" tick={{ fontSize: 11, fill: GREY }} axisLine={false} tickLine={false} width={48} tickFormatter={axisMoney} />
              <Tooltip
                cursor={{ stroke: 'var(--cb-line)', strokeWidth: 1 }}
                content={({ active, payload }) => {
                  const p = payload?.[0]?.payload as (CurvePoint & { tick: string }) | undefined;
                  if (!active || !p) return null;
                  const va = cumulative ? p.ca : p.a;
                  const vb = cumulative ? p.cb : p.b;
                  return (
                    <div dir="rtl" className="min-w-44 rounded-xl border border-cb-line bg-cb-card px-3 py-2 text-xs text-cb-ink shadow-lg">
                      <p className="mb-1 font-semibold tabular-nums">{p.tick}</p>
                      <p className="flex items-center justify-between gap-3">
                        <span className="text-cb-muted">{labelA}</span>
                        <span className="font-semibold tabular-nums">{va === null ? '—' : formatCurrency(va)}</span>
                      </p>
                      {labelB ? (
                        <p className="flex items-center justify-between gap-3">
                          <span className="text-cb-muted">
                            {labelB}
                            {byDay && p.dateB ? ` (${formatShortDate(p.dateB)})` : ''}
                          </span>
                          <span className="tabular-nums">{vb === null ? '—' : formatCurrency(vb)}</span>
                        </p>
                      ) : null}
                      {labelB && va !== null && vb !== null ? (
                        <p className="mt-1 flex items-center justify-end gap-2">
                          <span className="tabular-nums" dir="ltr">{signedText(va - vb, true)}</span>
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
                  connectNulls={false}
                  isAnimationActive={false}
                />
              ) : null}
              <Area
                type="monotone"
                dataKey={keyA}
                name={labelA}
                stroke={BLUE}
                strokeWidth={2.5}
                fill="url(#cb-compare-fill)"
                dot={points.length <= 31 ? { r: 3, fill: BLUE, stroke: 'var(--cb-card)', strokeWidth: 2 } : false}
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

// ── Lists of A against B ─────────────────────────────────────────────────────

export interface CompareRow {
  id: string;
  name: string;
  /** A quiet line under the name. */
  sub?: string;
  a: number;
  b: number;
}

/** Rows of A against B: the figure, the compared one under it, the change, two thin bars. */
export function CompareRowsCard({
  id,
  title,
  icon,
  rows,
  comparing,
  loading,
  empty,
  money = true,
  trailing,
  className,
}: {
  id: string;
  title: string;
  icon?: React.ElementType;
  rows: CompareRow[];
  comparing: boolean;
  loading: boolean;
  empty: string;
  money?: boolean;
  trailing?: React.ReactNode;
  className?: string;
}) {
  const max = Math.max(1, ...rows.map((r) => Math.max(r.a, comparing ? r.b : 0)));
  const fmt = (n: number) => (money ? formatCurrency(n) : formatQuantity(n));
  return (
    <BoardCard className={className} labelledBy={id}>
      <CardTitle id={id} icon={icon} trailing={trailing}>
        {title}
      </CardTitle>
      {loading && rows.length === 0 ? (
        <div className="space-y-2">
          <Skeleton className="h-10 w-full bg-cb-soft" />
          <Skeleton className="h-10 w-full bg-cb-soft" />
        </div>
      ) : rows.length === 0 ? (
        <p className="py-6 text-center text-sm text-cb-muted">{empty}</p>
      ) : (
        <ul className="divide-y divide-cb-line">
          {rows.map((r) => (
            <li key={r.id} className="py-2.5">
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-cb-ink">{r.name}</p>
                  {r.sub ? <p className="truncate text-xs tabular-nums text-cb-muted">{r.sub}</p> : null}
                </div>
                <div className="shrink-0 text-end">
                  <p className="text-sm font-semibold tabular-nums text-cb-ink">{fmt(r.a)}</p>
                  {comparing ? <p className="text-xs tabular-nums text-cb-muted">{fmt(r.b)}</p> : null}
                </div>
                {comparing ? <DeltaPill a={r.a} b={r.b} /> : null}
              </div>
              <div className="mt-1.5 space-y-1" aria-hidden>
                <div className="h-1.5 rounded-full bg-cb-soft">
                  <div className="h-1.5 rounded-full bg-cb-blue" style={{ width: `${(Math.max(0, r.a) / max) * 100}%` }} />
                </div>
                {comparing ? (
                  <div className="h-1 rounded-full bg-cb-soft">
                    <div className="h-1 rounded-full bg-cb-muted/50" style={{ width: `${(Math.max(0, r.b) / max) * 100}%` }} />
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}
    </BoardCard>
  );
}

// ── Card brands ──────────────────────────────────────────────────────────────

const BRAND_FILL = ['bg-cb-blue', 'bg-cb-teal', 'bg-cb-purple', 'bg-cb-amber', 'bg-cb-green', 'bg-cb-red'];

export function CardBrandsCard({
  report,
  loading,
  className,
}: {
  report: CardBrandsReport | undefined;
  loading: boolean;
  className?: string;
}) {
  const t = useTranslations('controlBoard.compareView');
  const tBrand = useTranslations('cardBrands.brand');
  const brands = (report?.byBrand ?? []).filter((b) => b.net !== 0);
  const total = brands.reduce((s, b) => s + Math.max(0, b.net), 0);
  return (
    <BoardCard className={className} labelledBy="cb-compare-brands">
      <CardTitle id="cb-compare-brands" icon={CreditCard}>
        {t('brands')}
      </CardTitle>
      {loading && !report ? (
        <Skeleton className="h-20 w-full bg-cb-soft" />
      ) : brands.length === 0 ? (
        <p className="py-6 text-center text-sm text-cb-muted">{t('brandsEmpty')}</p>
      ) : (
        <div className="space-y-3">
          <div className="flex h-3 w-full gap-0.5 overflow-hidden rounded-full bg-cb-soft" aria-hidden>
            {brands.map((b, i) => (
              <span
                key={b.key}
                className={cn('h-full', BRAND_FILL[i % BRAND_FILL.length])}
                style={{ width: `${total > 0 ? (Math.max(0, b.net) / total) * 100 : 0}%` }}
              />
            ))}
          </div>
          <ul className="space-y-2">
            {brands.map((b, i) => (
              <li key={b.key} className="flex items-center justify-between gap-2 text-sm">
                <span className="flex min-w-0 items-center gap-2">
                  <span aria-hidden className={cn('size-2.5 shrink-0 rounded-full', BRAND_FILL[i % BRAND_FILL.length])} />
                  <span className="truncate text-cb-ink">{tBrand.has(b.key) ? tBrand(b.key) : b.key}</span>
                </span>
                <span className="flex shrink-0 items-center gap-2 tabular-nums">
                  <span className="font-semibold text-cb-ink">{formatCurrency(b.net)}</span>
                  <span className="text-cb-muted">• {total > 0 ? Math.round((Math.max(0, b.net) / total) * 100) : 0}%</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </BoardCard>
  );
}
