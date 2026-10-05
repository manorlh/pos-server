'use client';

/**
 * Items (top / bottom / by category / modifiers / items × tills) and the segmentation
 * ("פילוח"): tenders, categories, hour of day, cashier or waiter, area, card brand.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { EventItemRow, EventReport } from '@/lib/eventTypes';
import { CHART, Capsule, Card, IOS, Muted, Segmented, hh, tooltipStyle } from '@/components/dashboard/insights/ios';
import { IosTable, Td, Th, compactMoney, count, money, pctText, tillColor } from './event-parts';

type ItemsView = 'top' | 'bottom' | 'categories' | 'modifiers' | 'matrix';

function ItemList({ rows, max }: { rows: EventItemRow[]; max: number }) {
  const t = useTranslations('events.items');
  if (rows.length === 0) return <Muted className="px-2 py-3">{t('none')}</Muted>;
  return (
    <ul className="divide-y divide-[#3C3C4320] dark:divide-[#54545866]">
      {rows.map((r) => (
        <li key={r.key} className="grid grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 px-2 py-2">
          <span className="text-center text-[13px] font-semibold text-[#8E8E93]">{r.rank}</span>
          <div className="min-w-0 space-y-1">
            <div className="flex items-baseline justify-between gap-2">
              <span className="truncate text-[15px] font-medium">{r.name}</span>
              <span className="shrink-0 text-[12px] text-[#8E8E93]">{r.categoryName ?? ''}</span>
            </div>
            <Capsule value={Math.max(0, r.revenue)} max={max} color={IOS.orange} />
          </div>
          <div className="text-end">
            <div className="text-[14px] font-semibold tabular-nums">{money(r.revenue)}</div>
            <div className="text-[12px] tabular-nums text-[#8E8E93]">
              {t('qtyShare', { qty: count(r.quantity), pct: pctText(r.sharePct) })}
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

export function EventItems({ report }: { report: EventReport }) {
  const t = useTranslations('events.items');
  const [view, setView] = useState<ItemsView>('top');
  const items = report.items;
  const max = Math.max(1, ...items.rows.map((r) => r.revenue));
  const names = Object.fromEntries(report.tills.map((x) => [x.machineId, x.name]));
  return (
    <Card className="space-y-3">
      <div className="overflow-x-auto print:hidden">
        <Segmented
          value={view}
          onChange={setView}
          className="min-w-[440px]"
          label={t('view')}
          options={[
            { id: 'top', label: t('top') },
            { id: 'bottom', label: t('bottom') },
            { id: 'categories', label: t('categories') },
            { id: 'modifiers', label: t('modifiers') },
            { id: 'matrix', label: t('matrix') },
          ]}
        />
      </div>
      {view === 'top' ? <ItemList rows={items.top} max={max} /> : null}
      {view === 'bottom' ? <ItemList rows={items.bottom} max={max} /> : null}
      {view === 'categories' ? (
        items.categories.length === 0 ? (
          <Muted>{t('none')}</Muted>
        ) : (
          <IosTable>
            <thead>
              <tr>
                <Th>{t('category')}</Th>
                <Th end>{t('quantity')}</Th>
                <Th end>{t('revenue')}</Th>
                <Th end>{t('share')}</Th>
              </tr>
            </thead>
            <tbody>
              {items.categories.map((c) => (
                <tr key={c.categoryId ?? 'none'}>
                  <Td className="font-medium">{c.name}</Td>
                  <Td end>{count(c.quantity)}</Td>
                  <Td end>{money(c.revenue)}</Td>
                  <Td end>{pctText(c.sharePct)}</Td>
                </tr>
              ))}
            </tbody>
          </IosTable>
        )
      ) : null}
      {view === 'modifiers' ? (
        items.modifiers.length === 0 ? (
          <Muted>{t('noModifiers')}</Muted>
        ) : (
          <IosTable>
            <thead>
              <tr>
                <Th>{t('modifier')}</Th>
                <Th>{t('group')}</Th>
                <Th end>{t('quantity')}</Th>
                <Th end>{t('revenue')}</Th>
              </tr>
            </thead>
            <tbody>
              {items.modifiers.map((m) => (
                <tr key={m.key}>
                  <Td className="font-medium">{m.name}</Td>
                  <Td>{m.groupName ?? '—'}</Td>
                  <Td end>{count(m.quantity)}</Td>
                  <Td end>{money(m.revenue)}</Td>
                </tr>
              ))}
            </tbody>
          </IosTable>
        )
      ) : null}
      {view === 'matrix' ? (
        items.matrix.rows.length === 0 ? (
          <Muted>{t('none')}</Muted>
        ) : (
          <IosTable>
            <thead>
              <tr>
                <Th>{t('item')}</Th>
                {items.matrix.machineIds.map((id, i) => (
                  <Th key={id} end>
                    <span className="inline-flex items-center gap-1">
                      <span className="h-2 w-2 rounded-full" style={{ backgroundColor: tillColor(i) }} aria-hidden />
                      {names[id] ?? '—'}
                    </span>
                  </Th>
                ))}
                <Th end>{t('total')}</Th>
              </tr>
            </thead>
            <tbody>
              {items.matrix.rows.map((r) => {
                const peak = Math.max(0, ...Object.values(r.cells));
                return (
                  <tr key={r.key}>
                    <Td className="font-medium">{r.name}</Td>
                    {items.matrix.machineIds.map((id) => {
                      const v = r.cells[id] ?? 0;
                      const strength = peak > 0 ? Math.max(0, v) / peak : 0;
                      return (
                        <Td key={id} end>
                          <span
                            className="inline-block min-w-10 rounded-md px-1.5 py-0.5"
                            style={{ backgroundColor: v ? `rgba(0,122,255,${0.08 + strength * 0.32})` : undefined }}
                          >
                            {v ? count(v) : '·'}
                          </span>
                        </Td>
                      );
                    })}
                    <Td end className="font-semibold">{count(r.total)}</Td>
                  </tr>
                );
              })}
            </tbody>
          </IosTable>
        )
      ) : null}
      {items.singleTill.length > 0 && view !== 'matrix' ? (
        <p className="text-[12px] text-[#8E8E93]">
          {t('singleTill', { items: items.singleTill.slice(0, 3).map((s) => `${s.name} (${s.machineName})`).join(', ') })}
        </p>
      ) : null}
    </Card>
  );
}

const METHOD_COLOR: Record<string, string> = { cash: IOS.green, card: IOS.blue, other: IOS.purple, exchange: IOS.gray };

export function EventSegments({ report }: { report: EventReport }) {
  const t = useTranslations('events.segments');
  const seg = report.segments;
  const pay = seg.byPayment.filter((p) => p.amount > 0);
  const hours = seg.byHour.map((h) => ({ ...h, label: hh(h.hour) }));
  const cats = seg.byCategory.slice(0, 8);
  return (
    <div className="grid gap-3 lg:grid-cols-2 print:grid-cols-2">
      <Card>
        <div className="mb-2 text-[13px] text-[#8E8E93]">{t('payment')}</div>
        {pay.length === 0 ? (
          <Muted>{t('none')}</Muted>
        ) : (
          <div className="grid grid-cols-[10rem_1fr] items-center gap-3">
            <div className="h-40" dir="ltr">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={pay} dataKey="amount" nameKey="method" innerRadius="55%" outerRadius="95%" paddingAngle={2} stroke="none">
                    {pay.map((p) => (
                      <Cell key={p.method} fill={METHOD_COLOR[p.method] ?? IOS.gray} />
                    ))}
                  </Pie>
                  <Tooltip contentStyle={tooltipStyle} formatter={(v, name) => [money(Number(v ?? 0)), t(`method.${String(name)}`)]} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <ul className="space-y-1.5 text-[14px]">
              {seg.byPayment.map((p) => (
                <li key={p.method} className="flex items-center justify-between gap-2">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: METHOD_COLOR[p.method] }} aria-hidden />
                    {t(`method.${p.method}`)}
                  </span>
                  <span className="tabular-nums">
                    <span className="font-semibold">{money(p.amount)}</span>{' '}
                    <span className="text-[#8E8E93]">{pctText(p.sharePct, 0)}</span>
                  </span>
                </li>
              ))}
              {seg.byCardBrand.length > 0 ? (
                <li className="pt-1 text-[12px] text-[#8E8E93]">
                  {t('brands', { list: seg.byCardBrand.slice(0, 4).map((b) => `${b.brand} ${money(b.amount)}`).join(' · ') })}
                </li>
              ) : null}
            </ul>
          </div>
        )}
      </Card>

      <Card>
        <div className="mb-2 text-[13px] text-[#8E8E93]">{t('hour')}</div>
        {hours.length === 0 ? (
          <Muted>{t('none')}</Muted>
        ) : (
          <div className="h-40" dir="ltr">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={hours} margin={{ top: 4, right: 4, bottom: 0, left: 4 }}>
                <CartesianGrid vertical={false} stroke={CHART.grid} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#8E8E93' }} axisLine={false} tickLine={false} />
                <YAxis tickFormatter={compactMoney} tick={{ fontSize: 11, fill: '#8E8E93' }} axisLine={false} tickLine={false} width={48} orientation="right" />
                <Tooltip contentStyle={tooltipStyle} formatter={(v) => [money(Number(v ?? 0)), t('net')]} />
                <Bar dataKey="net" fill={IOS.teal} radius={[4, 4, 0, 0]} maxBarSize={26} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      <Card>
        <div className="mb-2 text-[13px] text-[#8E8E93]">{t('category')}</div>
        {cats.length === 0 ? (
          <Muted>{t('none')}</Muted>
        ) : (
          <ul className="space-y-2">
            {cats.map((c) => (
              <li key={c.categoryId ?? 'none'} className="grid grid-cols-[minmax(6rem,9rem)_1fr_auto] items-center gap-3 text-[14px]">
                <span className="truncate">{c.name}</span>
                <Capsule value={Math.max(0, c.revenue)} max={Math.max(1, cats[0].revenue)} color={IOS.orange} />
                <span className="tabular-nums">
                  {money(c.revenue)} <span className="text-[#8E8E93]">{pctText(c.sharePct, 0)}</span>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="p-2">
        <div className="mb-1 px-2 pt-2 text-[13px] text-[#8E8E93]">{t('cashier')}</div>
        {seg.byCashier.length === 0 ? (
          <Muted className="px-2">{t('none')}</Muted>
        ) : (
          <IosTable>
            <thead>
              <tr>
                <Th>{t('name')}</Th>
                <Th end>{t('net')}</Th>
                <Th end>{t('sales')}</Th>
                <Th end>{t('avgTicket')}</Th>
                <Th end>{t('tips')}</Th>
                <Th end>{t('refunds')}</Th>
              </tr>
            </thead>
            <tbody>
              {seg.byCashier.slice(0, 20).map((c) => (
                <tr key={c.id ?? 'none'}>
                  <Td className="font-medium">{c.name ?? t('unknown')}</Td>
                  <Td end>{money(c.net)}</Td>
                  <Td end>{count(c.salesCount)}</Td>
                  <Td end>{money(c.avgTicket)}</Td>
                  <Td end>
                    {money(c.tips)} <span className="text-[12px] text-[#8E8E93]">{pctText(c.tipPct)}</span>
                  </Td>
                  <Td end>{c.refundsCount ? `${money(c.refunds)} (${c.refundsCount})` : '—'}</Td>
                </tr>
              ))}
            </tbody>
          </IosTable>
        )}
      </Card>

      {seg.byArea.length > 0 ? (
        <Card>
          <div className="mb-2 text-[13px] text-[#8E8E93]">{t('area')}</div>
          <ul className="space-y-2">
            {seg.byArea.map((a) => (
              <li key={a.id ?? 'none'} className="grid grid-cols-[minmax(6rem,9rem)_1fr_auto] items-center gap-3 text-[14px]">
                <span className="truncate">{a.name}</span>
                <Capsule value={Math.max(0, a.net)} max={Math.max(1, seg.byArea[0].net)} color={IOS.indigo} />
                <span className="tabular-nums">
                  {money(a.net)} <span className="text-[#8E8E93]">{pctText(a.sharePct, 0)}</span>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}
