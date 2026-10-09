'use client';

/**
 * "זה מול זה": two to four shops, points of sale, tills or cashiers over one period (or one
 * event), side by side — sales, documents, average ticket, items, the tender split and the
 * curves overlaid (`GET /reports/side-by-side`). What is compared and who are in the URL
 * (`side`, `ids`); only what the user may see is offered, and the server lists nothing else.
 */

import { useTranslations } from 'next-intl';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Check, Columns3 } from 'lucide-react';
import { fetchCashierSalesReport } from '@/lib/api';
import { fetchSideBySide, type SideBySideReport } from '@/lib/compareApi';
import { formatCurrency, formatQuantity, formatShortDate } from '@/lib/format';
import { numberedLabel } from '@/lib/orgNumber';
import { registerNumberOf } from '@/lib/registerNumber';
import { useScope } from '@/lib/scope';
import {
  FIGURE_ORDER,
  SIDE_KINDS,
  SIDE_MAX,
  figureKind,
  shares,
  sideReady,
  tenderSharesOf,
  toggleSideId,
  type CompareParams,
  type DayRange,
  type SideKind,
} from '@/lib/periodCompare';
import { cn } from '@/lib/utils';
import { Skeleton } from '@/components/ui/skeleton';
import { BoardCard, CardTitle, Segmented } from './board-ui';
import { axisMoney } from './compare-parts';

const LINE = ['var(--cb-blue)', 'var(--cb-purple)', 'var(--cb-teal)', 'var(--cb-amber)'];
const DOT = ['bg-cb-blue', 'bg-cb-purple', 'bg-cb-teal', 'bg-cb-amber'];
const TENDER_FILL = { card: 'bg-cb-blue', cash: 'bg-cb-teal', other: 'bg-cb-purple' } as const;

interface Candidate {
  id: string;
  label: string;
}

export function useSideBySide({
  params,
  range,
  eventId,
  scope,
}: {
  params: CompareParams;
  range: DayRange | null;
  eventId: string | null;
  /** The board's scope: cashiers compared on shop A count shop A's sales only. */
  scope: { companyId?: string; shopId?: string; areaId?: string; machineId?: string };
}) {
  // Only in its own mode: the periods view never asks for it.
  const ready = params.mode === 'side' && sideReady(params.ids) && (!!range || !!eventId);
  return useQuery<SideBySideReport>({
    queryKey: ['side-by-side', params.side, params.ids, range, eventId, scope],
    queryFn: () =>
      fetchSideBySide({
        kind: params.side,
        ids: params.ids,
        ...(eventId ? { eventId } : { from: range?.from, to: range?.to }),
        ...scope,
      }),
    enabled: ready,
    placeholderData: keepPreviousData,
  });
}

export function SideBySide({
  params,
  write,
  range,
  areas,
  areaId,
  report,
  loading,
}: {
  params: CompareParams;
  write: (next: Partial<CompareParams>) => void;
  /** The period's days (an event's own days, for the cashiers worth offering). */
  range: DayRange | null;
  /** The chosen shop's points of sale (none without a shop). */
  areas: { id: string; name: string }[];
  areaId: string | null;
  report: SideBySideReport | undefined;
  loading: boolean;
}) {
  const t = useTranslations('controlBoard.compareView');
  const tTenders = useTranslations('controlBoard.tenders');
  const tBoard = useTranslations('controlBoard');
  const scope = useScope();

  // The cashiers who sold in the period, in the scope — the ones worth comparing.
  const cashiers = useQuery({
    queryKey: ['side-cashiers', range, scope.shopId, scope.machineId, areaId],
    queryFn: () =>
      fetchCashierSalesReport({
        from: range?.from,
        to: range?.to,
        shopId: scope.shopId ?? undefined,
        machineId: scope.machineId ?? undefined,
        areaId: areaId ?? undefined,
      }),
    enabled: params.side === 'cashier' && !!range,
    staleTime: 60_000,
  });

  const candidates: Candidate[] =
    params.side === 'shop'
      ? scope.shopOptions.map((s) => ({ id: s.id, label: numberedLabel(s.shopNumber, s.name) }))
      : params.side === 'area'
        ? areas.map((a) => ({ id: a.id, label: a.name }))
        : params.side === 'machine'
          ? scope.machineOptions
              .filter((m) => !areaId || m.areaId === areaId)
              .map((m) => {
                const n = registerNumberOf(m);
                return { id: m.id, label: n ? `${tBoard('tillLabel', { number: String(n).padStart(2, '0') })} · ${m.name}` : m.name };
              })
          : (cashiers.data?.rows ?? [])
              .filter((r) => r.cashierId)
              .map((r) => ({ id: r.cashierId as string, label: r.cashierName ?? (r.cashierId as string) }));

  const labelOf = (id: string) => candidates.find((c) => c.id === id)?.label;
  const entities = (report?.entities ?? []).filter((e) => params.ids.includes(e.id));
  const colorOf = (id: string) => Math.max(0, params.ids.indexOf(id)) % LINE.length;
  const salesShares = shares(entities.map((e) => e.figures.sales));

  // A few dozen buckets at most: built on each render.
  const chart = (report?.buckets ?? []).map((label, i) => {
    const row: Record<string, string | number | null> = {
      tick: report?.granularity === 'day' && /^\d{4}-\d{2}-\d{2}$/.test(label) ? formatShortDate(label) : label,
    };
    for (const e of entities) row[e.id] = e.series[i] ?? null;
    return row;
  });
  // Quiet hours at both ends of a day are left out of the chart.
  const busy = (r: Record<string, string | number | null>) => entities.some((e) => (r[e.id] ?? 0) !== 0);
  let trimmed = chart;
  if (report?.granularity === 'hour' && report.alignment === 'clock') {
    const first = chart.findIndex(busy);
    let last = chart.length - 1;
    while (last > first && first >= 0 && !busy(chart[last])) last--;
    trimmed = first < 0 ? [] : chart.slice(first, last + 1);
  }

  return (
    <div className="space-y-4 md:space-y-5">
      <BoardCard labelledBy="cb-side-pick">
        <CardTitle
          id="cb-side-pick"
          icon={Columns3}
          trailing={
            <Segmented
              label={t('side.label')}
              value={params.side}
              onChange={(side: SideKind) => write({ side, ids: [] })}
              options={SIDE_KINDS.map((k) => ({ id: k, label: t(`side.${k}`) }))}
            />
          }
        >
          {t('side.pick')}
        </CardTitle>
        <p className="mb-2 text-xs text-cb-muted">
          {t('side.picked', { count: params.ids.length })}
          {params.side === 'cashier' ? ` · ${t('side.cashiersHint')}` : ''}
        </p>
        {params.side === 'area' && !scope.shopId ? (
          <p className="py-3 text-sm text-cb-muted">{t('side.needShop')}</p>
        ) : params.side === 'cashier' && cashiers.isPending && !!range ? (
          <Skeleton className="h-11 w-full bg-cb-soft" />
        ) : candidates.length === 0 ? (
          <p className="py-3 text-sm text-cb-muted">{t('side.noCandidates')}</p>
        ) : (
          <div className="flex max-h-48 flex-wrap gap-2 overflow-y-auto" role="group" aria-label={t('side.pick')}>
            {candidates.map((c) => {
              const on = params.ids.includes(c.id);
              return (
                <button
                  key={c.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => write({ ids: toggleSideId(params.ids, c.id, SIDE_MAX) })}
                  className={cn(
                    'inline-flex min-h-11 max-w-full items-center gap-1.5 rounded-full border px-3 text-sm transition-colors outline-none focus-visible:ring-2 focus-visible:ring-cb-blue/40',
                    on ? 'border-cb-blue bg-cb-blue/10 font-semibold text-cb-ink' : 'border-cb-line bg-cb-card text-cb-ink hover:bg-cb-soft',
                  )}
                >
                  {on ? <span aria-hidden className={cn('size-2.5 shrink-0 rounded-full', DOT[colorOf(c.id)])} /> : null}
                  <span className="truncate">{c.label}</span>
                  {on ? <Check className="size-3.5 shrink-0 text-cb-blue-ink" aria-hidden /> : null}
                </button>
              );
            })}
          </div>
        )}
      </BoardCard>

      {!sideReady(params.ids) ? (
        <p className="rounded-2xl border border-dashed border-cb-line p-6 text-center text-sm text-cb-muted">{t('side.pickMore')}</p>
      ) : loading && !report ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {params.ids.map((id) => (
            <Skeleton key={id} className="h-56 rounded-2xl bg-cb-card" />
          ))}
        </div>
      ) : (
        <>
          <div className={cn('grid gap-3 lg:gap-4', entities.length > 2 ? 'grid-cols-2 lg:grid-cols-4' : 'grid-cols-2')}>
            {entities.map((e, i) => {
              const tenders = tenderSharesOf(e.figures);
              return (
                <section
                  key={e.id}
                  aria-label={e.name ?? labelOf(e.id) ?? e.id}
                  className="min-w-0 overflow-hidden rounded-2xl border border-cb-line bg-cb-card shadow-[var(--cb-shadow)]"
                >
                  <div className={cn('h-1.5', DOT[colorOf(e.id)])} aria-hidden />
                  <div className="space-y-2 p-3.5 md:p-4">
                    <p className="truncate text-sm font-semibold text-cb-ink" title={e.name ?? undefined}>
                      {e.name ?? labelOf(e.id) ?? e.id}
                    </p>
                    {!e.found ? <p className="text-[11px] text-cb-muted">{t('side.unknown')}</p> : null}
                    <p className="truncate text-[22px] font-bold leading-tight tabular-nums text-cb-ink">{formatCurrency(e.figures.sales)}</p>
                    <p className="text-xs text-cb-muted">{t('side.share', { pct: salesShares[i] ?? 0 })}</p>
                    <dl className="space-y-1 text-xs">
                      {(['salesCount', 'averageTicket', 'items', 'documents'] as const).map((key) => (
                        <div key={key} className="flex items-center justify-between gap-2">
                          <dt className="truncate text-cb-muted">{t(`figures.${key}`)}</dt>
                          <dd className="shrink-0 font-semibold tabular-nums text-cb-ink">
                            {figureKind(key) === 'money' ? formatCurrency(e.figures[key]) : formatQuantity(e.figures[key])}
                          </dd>
                        </div>
                      ))}
                    </dl>
                    <div
                      className="flex h-2.5 w-full gap-0.5 overflow-hidden rounded-full bg-cb-soft"
                      role="img"
                      aria-label={tenders.map((s) => `${tTenders(s.key)} ${s.share}%`).join(', ')}
                    >
                      {tenders
                        .filter((s) => s.share > 0)
                        .map((s) => (
                          <span key={s.key} className={cn('h-full', TENDER_FILL[s.key])} style={{ width: `${s.share}%` }} />
                        ))}
                    </div>
                    <p className="flex flex-wrap gap-x-2 text-[11px] tabular-nums text-cb-muted">
                      {tenders.map((s) => (
                        <span key={s.key} className="inline-flex items-center gap-1">
                          <span aria-hidden className={cn('size-2 rounded-full', TENDER_FILL[s.key])} />
                          {tTenders(s.key)} {s.share}%
                        </span>
                      ))}
                    </p>
                  </div>
                </section>
              );
            })}
          </div>

          <BoardCard labelledBy="cb-side-chart">
            <CardTitle id="cb-side-chart">{t('chart.title')}</CardTitle>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-cb-muted">
              {entities.map((e) => (
                <span key={e.id} className="inline-flex items-center gap-1.5">
                  <span aria-hidden className={cn('h-[3px] w-4 rounded-full', DOT[colorOf(e.id)])} />
                  {e.name ?? labelOf(e.id) ?? e.id}
                </span>
              ))}
            </div>
            {trimmed.length === 0 ? (
              <p className="flex h-56 items-center justify-center text-sm text-cb-muted">{t('chart.empty')}</p>
            ) : (
              <div className="mt-2 h-56 md:h-64" dir="ltr">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={trimmed} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
                    <CartesianGrid vertical={false} stroke="var(--cb-line)" />
                    <XAxis dataKey="tick" tick={{ fontSize: 11, fill: 'var(--cb-muted)' }} axisLine={false} tickLine={false} interval="preserveStartEnd" minTickGap={16} />
                    <YAxis orientation="right" tick={{ fontSize: 11, fill: 'var(--cb-muted)' }} axisLine={false} tickLine={false} width={48} tickFormatter={axisMoney} />
                    <Tooltip
                      cursor={{ stroke: 'var(--cb-line)', strokeWidth: 1 }}
                      content={({ active, payload, label }) => {
                        if (!active || !payload?.length) return null;
                        return (
                          <div dir="rtl" className="min-w-44 rounded-xl border border-cb-line bg-cb-card px-3 py-2 text-xs text-cb-ink shadow-lg">
                            <p className="mb-1 font-semibold tabular-nums">{String(label ?? '')}</p>
                            {entities.map((e) => {
                              const v = payload.find((p) => p.dataKey === e.id)?.value;
                              return (
                                <p key={e.id} className="flex items-center justify-between gap-3">
                                  <span className="inline-flex items-center gap-1 text-cb-muted">
                                    <span aria-hidden className={cn('size-2 rounded-full', DOT[colorOf(e.id)])} />
                                    {e.name ?? labelOf(e.id) ?? e.id}
                                  </span>
                                  <span className="font-semibold tabular-nums">{typeof v === 'number' ? formatCurrency(v) : '—'}</span>
                                </p>
                              );
                            })}
                          </div>
                        );
                      }}
                    />
                    {entities.map((e) => (
                      <Line
                        key={e.id}
                        type="monotone"
                        dataKey={e.id}
                        name={e.name ?? e.id}
                        stroke={LINE[colorOf(e.id)]}
                        strokeWidth={2.25}
                        dot={false}
                        connectNulls={false}
                        isAnimationActive={false}
                      />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </BoardCard>

          <BoardCard labelledBy="cb-side-table" className="hidden md:block">
            <CardTitle id="cb-side-table">{t('side.table')}</CardTitle>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-cb-line text-xs text-cb-muted">
                    <th className="py-2 text-start font-medium" />
                    {entities.map((e) => (
                      <th key={e.id} className="py-2 text-end font-semibold text-cb-ink">
                        <span className="inline-flex items-center gap-1.5">
                          <span aria-hidden className={cn('size-2 rounded-full', DOT[colorOf(e.id)])} />
                          {e.name ?? labelOf(e.id) ?? e.id}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-cb-line">
                  {FIGURE_ORDER.map((key) => {
                    const values = entities.map((e) => e.figures[key]);
                    const best = Math.max(...values);
                    return (
                      <tr key={key}>
                        <th scope="row" className="py-2 text-start font-normal text-cb-muted">{t(`figures.${key}`)}</th>
                        {entities.map((e) => (
                          <td
                            key={e.id}
                            className={cn(
                              'py-2 text-end tabular-nums text-cb-ink',
                              e.figures[key] === best && best > 0 && entities.length > 1 && 'font-semibold',
                            )}
                          >
                            {figureKind(key) === 'money' ? formatCurrency(e.figures[key]) : formatQuantity(e.figures[key])}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </BoardCard>
        </>
      )}
    </div>
  );
}
