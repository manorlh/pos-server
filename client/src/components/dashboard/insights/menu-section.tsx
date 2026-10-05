'use client';

/**
 * Menu engineering (הנדסת תפריט, Kasavana & Smith): every item placed by popularity (its
 * share of its category's units against 70% of a fair share) and by contribution margin
 * (price excl. VAT − cost, against the category's weighted average). Both axes are
 * indices — 1 is the item's own category's line — so every category's quadrants meet at
 * the same cross. Without costs the vertical axis is the price, with neutral names, and
 * the costs can be typed in right here (per unit, excl. VAT).
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Dog, Puzzle, Star, Tractor } from 'lucide-react';
import {
  CartesianGrid,
  LabelList,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts';
import { agorot, saveProductCost, type MenuEngineering, type MenuItemRow, type Quadrant } from '@/lib/insightsApi';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatQuantity } from '@/lib/format';
import { CHART, Card, IOS, Muted, RowDivider, Switch, tooltipStyle } from './ios';

const QUADRANT_STYLE: Record<Quadrant, { color: string; icon: React.ReactNode; wash: string }> = {
  star: { color: IOS.green, icon: <Star className="h-4 w-4" />, wash: 'rgba(52,199,89,0.07)' },
  plowhorse: { color: IOS.blue, icon: <Tractor className="h-4 w-4" />, wash: 'rgba(0,122,255,0.06)' },
  puzzle: { color: IOS.purple, icon: <Puzzle className="h-4 w-4" />, wash: 'rgba(175,82,222,0.07)' },
  dog: { color: IOS.gray, icon: <Dog className="h-4 w-4" />, wash: 'rgba(142,142,147,0.08)' },
};

export function useQuadrantText(mode: MenuEngineering['mode']) {
  const t = useTranslations('insights.menu');
  const price = mode !== 'cost';
  return {
    name: (q: Quadrant) =>
      q === 'star'
        ? price ? t('q.starPrice') : t('q.star')
        : q === 'plowhorse'
          ? price ? t('q.plowhorsePrice') : t('q.plowhorse')
          : q === 'puzzle'
            ? price ? t('q.puzzlePrice') : t('q.puzzle')
            : price ? t('q.dogPrice') : t('q.dog'),
    advice: (q: Quadrant) =>
      q === 'star'
        ? price ? t('advice.starPrice') : t('advice.star')
        : q === 'plowhorse'
          ? price ? t('advice.plowhorsePrice') : t('advice.plowhorse')
          : q === 'puzzle'
            ? price ? t('advice.puzzlePrice') : t('advice.puzzle')
            : price ? t('advice.dogPrice') : t('advice.dog'),
  };
}

const X_MAX_CAP = 4;
const Y_MAX_CAP = 3;

function CostInput({ row, canEdit }: { row: MenuItemRow; canEdit: boolean }) {
  const t = useTranslations('insights.menu');
  const qc = useQueryClient();
  const initial = row.cost !== null ? (row.cost / 100).toFixed(2) : '';
  const [value, setValue] = useState(initial);
  const mutation = useMutation({
    mutationFn: (cost: number | null) => saveProductCost(row.productId as string, cost),
    onSuccess: () => {
      toast.success(t('costSaved', { name: row.name }));
      void qc.invalidateQueries({ queryKey: ['insights-menu'] });
      void qc.invalidateQueries({ queryKey: ['insights-feed'] });
    },
    onError: (err) => {
      setValue(initial);
      toast.error(axiosErrorToToastMessage(err, t('costError')));
    },
  });
  if (!canEdit || !row.productId) {
    return <span className="tabular-nums">{row.cost !== null ? agorot(row.cost) : '—'}</span>;
  }
  const commit = () => {
    const trimmed = value.trim();
    if (trimmed === initial) return;
    if (trimmed === '') {
      mutation.mutate(null);
      return;
    }
    const n = Number(trimmed.replace(',', '.'));
    if (!Number.isFinite(n) || n < 0) {
      setValue(initial);
      toast.error(t('costInvalid'));
      return;
    }
    mutation.mutate(n);
  };
  return (
    <input
      inputMode="decimal"
      dir="ltr"
      value={value}
      placeholder="₪"
      aria-label={t('costFor', { name: row.name })}
      disabled={mutation.isPending}
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      className="w-20 rounded-lg bg-[#7676801F] px-2 py-1 text-end text-[15px] tabular-nums text-[#007AFF] outline-none focus:ring-2 focus:ring-[#007AFF]/40 dark:bg-[#7676803D] dark:text-[#0A84FF]"
    />
  );
}

export function MenuSection({
  data,
  categoryId,
  onCategory,
  byCategory,
  onByCategory,
  canEdit,
}: {
  data: MenuEngineering;
  categoryId: string;
  onCategory: (id: string) => void;
  byCategory: boolean;
  onByCategory: (v: boolean) => void;
  canEdit: boolean;
}) {
  const t = useTranslations('insights.menu');
  const quad = useQuadrantText(data.mode);
  const [showAllCosts, setShowAllCosts] = useState(false);
  const isCost = data.mode === 'cost';

  const points = useMemo(() => {
    const top = new Set([...data.items].sort((a, b) => b.net - a.net).slice(0, 6).map((r) => r.key));
    return data.items
      .filter((r) => r.popIndex !== null && r.valueIndex !== null)
      .map((r) => ({
        ...r,
        x: Math.min(r.popIndex as number, X_MAX_CAP),
        y: Math.min(Math.max(r.valueIndex as number, 0), Y_MAX_CAP),
        label: top.has(r.key) ? r.name : '',
      }));
  }, [data.items]);
  const xMax = Math.max(2, Math.min(X_MAX_CAP, Math.ceil(Math.max(0, ...points.map((p) => p.x)) * 1.1 * 2) / 2));
  const yMax = Math.max(2, Math.min(Y_MAX_CAP, Math.ceil(Math.max(0, ...points.map((p) => p.y)) * 1.1 * 2) / 2));

  const byQuadrant = useMemo(() => {
    const out: Record<Quadrant, MenuItemRow[]> = { star: [], plowhorse: [], puzzle: [], dog: [] };
    for (const r of data.items) if (r.quadrant) out[r.quadrant].push(r);
    return out;
  }, [data.items]);

  const costRows = useMemo(
    () => [...data.items, ...data.missingCost].sort((a, b) => b.units - a.units),
    [data.items, data.missingCost],
  );
  const shownCosts = showAllCosts ? costRows : costRows.slice(0, 12);

  return (
    <div className="space-y-3">
      <Card className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex items-center gap-2 text-[15px]">
            <span className="text-[#8E8E93]">{t('category')}</span>
            <select
              value={categoryId}
              onChange={(e) => onCategory(e.target.value)}
              className="max-w-56 rounded-lg bg-[#7676801F] px-2 py-1 text-[15px] text-[#007AFF] outline-none dark:bg-[#7676803D] dark:text-[#0A84FF]"
            >
              <option value="">{t('allMenu')}</option>
              {data.categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name ?? '—'}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-center gap-3">
            <div className="text-end">
              <div className="text-[15px]">{t('byCategory')}</div>
              <div className="text-[12px] text-[#8E8E93]">{t('byCategoryHint')}</div>
            </div>
            <Switch checked={byCategory} onChange={onByCategory} label={t('byCategory')} />
          </div>
        </div>
        {data.mode === 'price' ? (
          <p className="rounded-xl bg-[#5856D61A] px-3 py-2 text-[14px] leading-snug">{t('priceModeBanner')}</p>
        ) : data.missingCost.length > 0 ? (
          <p className="rounded-xl bg-[#FF95001A] px-3 py-2 text-[14px] leading-snug">{t('missingBanner', { count: data.missingCost.length })}</p>
        ) : null}

        {points.length < 3 ? (
          <Muted>{t('tooFew')}</Muted>
        ) : (
          <>
            <div className="h-80" dir="ltr">
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 16, right: 12, bottom: 24, left: 4 }}>
                  <CartesianGrid stroke={CHART.grid} />
                  <ReferenceArea x1={1} x2={xMax} y1={1} y2={yMax} fill={QUADRANT_STYLE.star.wash} stroke="none" label={{ value: quad.name('star'), position: 'insideTopRight', fill: '#8E8E93', fontSize: 12 }} />
                  <ReferenceArea x1={1} x2={xMax} y1={0} y2={1} fill={QUADRANT_STYLE.plowhorse.wash} stroke="none" label={{ value: quad.name('plowhorse'), position: 'insideBottomRight', fill: '#8E8E93', fontSize: 12 }} />
                  <ReferenceArea x1={0} x2={1} y1={1} y2={yMax} fill={QUADRANT_STYLE.puzzle.wash} stroke="none" label={{ value: quad.name('puzzle'), position: 'insideTopLeft', fill: '#8E8E93', fontSize: 12 }} />
                  <ReferenceArea x1={0} x2={1} y1={0} y2={1} fill={QUADRANT_STYLE.dog.wash} stroke="none" label={{ value: quad.name('dog'), position: 'insideBottomLeft', fill: '#8E8E93', fontSize: 12 }} />
                  <ReferenceLine x={1} stroke={CHART.muted} />
                  <ReferenceLine y={1} stroke={CHART.muted} />
                  <XAxis
                    type="number"
                    dataKey="x"
                    domain={[0, xMax]}
                    tick={{ fontSize: 11, fill: '#8E8E93' }}
                    tickFormatter={(v: number) => `×${v}`}
                    label={{ value: t('xAxis'), position: 'insideBottom', offset: -14, fill: '#8E8E93', fontSize: 12 }}
                  />
                  <YAxis
                    type="number"
                    dataKey="y"
                    domain={[0, yMax]}
                    tick={{ fontSize: 11, fill: '#8E8E93' }}
                    tickFormatter={(v: number) => `×${v}`}
                    width={40}
                  />
                  <ZAxis range={[70, 70]} />
                  <Tooltip
                    cursor={{ strokeDasharray: '3 3' }}
                    contentStyle={tooltipStyle}
                    content={({ active, payload }) => {
                      const r = active ? (payload?.[0]?.payload as MenuItemRow | undefined) : undefined;
                      if (!r) return null;
                      return (
                        <div style={tooltipStyle} className="bg-white px-3 py-2 text-black dark:bg-[#2C2C2E] dark:text-white">
                          <div className="font-semibold">{r.name}</div>
                          {r.categoryName ? <div className="text-[12px] text-[#8E8E93]">{r.categoryName}</div> : null}
                          <div className="tabular-nums">{t('tipMix', { mix: r.menuMix.toFixed(1), units: formatQuantity(r.units) })}</div>
                          <div className="tabular-nums">
                            {isCost
                              ? t('tipMargin', { margin: agorot(r.margin), fc: r.foodCostPct ?? '—' })
                              : t('tipPrice', { price: agorot(r.avgPriceExVat) })}
                          </div>
                          {r.quadrant ? <div className="mt-0.5 font-semibold">{quad.name(r.quadrant)}</div> : null}
                        </div>
                      );
                    }}
                  />
                  <Scatter data={points} fill={CHART.accent} stroke={CHART.surface} strokeWidth={2}>
                    <LabelList dataKey="label" position="top" style={{ fontSize: 11, fill: '#8E8E93' }} />
                  </Scatter>
                </ScatterChart>
              </ResponsiveContainer>
            </div>
            <p className="text-[12px] text-[#8E8E93]">{isCost ? t('axesCost') : t('axesPrice')}</p>
          </>
        )}
      </Card>

      <div className="grid gap-3 md:grid-cols-2">
        {(['star', 'plowhorse', 'puzzle', 'dog'] as Quadrant[]).map((q) => {
          const rows = byQuadrant[q];
          const style = QUADRANT_STYLE[q];
          return (
            <Card key={q} className="p-0">
              <div className="flex items-start gap-3 px-4 pb-2 pt-3">
                <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-white" style={{ backgroundColor: style.color }} aria-hidden>
                  {style.icon}
                </span>
                <div className="min-w-0">
                  <div className="text-[17px] font-semibold">
                    {quad.name(q)} <span className="text-[15px] font-normal text-[#8E8E93]">· {rows.length}</span>
                  </div>
                  <p className="text-[13px] leading-snug text-[#8E8E93]">{quad.advice(q)}</p>
                </div>
              </div>
              {rows.length === 0 ? null : (
                <ul className="border-t border-[#3C3C4349] dark:border-[#54545899]">
                  {rows.slice(0, 6).map((r, i) => (
                    <li key={r.key} className="relative flex items-center justify-between gap-3 px-4 py-2">
                      {i > 0 ? <RowDivider /> : null}
                      <div className="min-w-0">
                        <div className="truncate text-[15px]">{r.name}</div>
                        <div className="text-[12px] tabular-nums text-[#8E8E93]">
                          {t('rowMix', { mix: r.menuMix.toFixed(1), units: formatQuantity(r.units) })}
                        </div>
                      </div>
                      <span className="shrink-0 text-[13px] tabular-nums text-[#8E8E93]">
                        {isCost ? t('rowMargin', { margin: agorot(r.margin) }) : agorot(r.avgPrice)}
                      </span>
                    </li>
                  ))}
                  {rows.length > 6 ? (
                    <li className="relative px-4 py-2 text-[13px] text-[#8E8E93]">
                      <RowDivider />
                      {t('more', { count: rows.length - 6 })}
                    </li>
                  ) : null}
                </ul>
              )}
            </Card>
          );
        })}
      </div>

      <div id="menu-costs" className="scroll-mt-4">
        <div className="mb-1.5 px-4 text-[13px] text-[#6D6D72] dark:text-[#8E8E93]">{t('costsTitle')}</div>
        <Card className="p-0">
          <p className="px-4 pb-2 pt-3 text-[13px] leading-snug text-[#8E8E93]">{canEdit ? t('costsHint') : t('costsReadOnly')}</p>
          {costRows.length === 0 ? (
            <Muted className="px-4 pb-3">{t('tooFew')}</Muted>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] text-[15px]">
                <thead>
                  <tr className="border-t border-[#3C3C4349] text-[12px] text-[#8E8E93] dark:border-[#54545899]">
                    <th className="px-4 py-1.5 text-start font-normal">{t('colItem')}</th>
                    <th className="px-2 py-1.5 text-end font-normal">{t('colPriceEx')}</th>
                    <th className="px-2 py-1.5 text-end font-normal">{t('colCost')}</th>
                    <th className="px-2 py-1.5 text-end font-normal">{t('colMargin')}</th>
                    <th className="px-4 py-1.5 text-end font-normal">{t('colFoodCost')}</th>
                  </tr>
                </thead>
                <tbody>
                  {shownCosts.map((r) => (
                    <tr key={r.key} className="border-t border-[#3C3C4349] dark:border-[#54545899]">
                      <td className="px-4 py-1.5">
                        <div className="truncate">{r.name}</div>
                        <div className="text-[12px] text-[#8E8E93]">{r.categoryName ?? ''}</div>
                      </td>
                      <td className="px-2 py-1.5 text-end tabular-nums">{agorot(r.avgPriceExVat)}</td>
                      <td className="px-2 py-1.5 text-end">
                        <CostInput key={`${r.key}-${r.cost ?? 'none'}`} row={r} canEdit={canEdit} />
                      </td>
                      <td className="px-2 py-1.5 text-end tabular-nums">{r.margin !== null ? agorot(r.margin) : '—'}</td>
                      <td className="px-4 py-1.5 text-end tabular-nums">
                        {r.foodCostPct !== null ? (
                          <span className={r.foodCostPct >= 45 ? 'font-semibold' : undefined}>
                            {r.foodCostPct >= 45 ? '⚠ ' : ''}
                            {r.foodCostPct.toFixed(0)}%
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {costRows.length > 12 ? (
            <button
              type="button"
              onClick={() => setShowAllCosts((v) => !v)}
              className="w-full border-t border-[#3C3C4349] px-4 py-2.5 text-[15px] text-[#007AFF] dark:border-[#54545899] dark:text-[#0A84FF]"
            >
              {showAllCosts ? t('showLess') : t('showAll', { count: costRows.length })}
            </button>
          ) : null}
        </Card>
      </div>
    </div>
  );
}
