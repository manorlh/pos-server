'use client';

/**
 * The lists of "ביצועי קיוסקים": the top items, upsell (by rule, product and moment), the
 * payments' failures, and the per-kiosk table (sortable; a row narrows the page to its kiosk).
 */

import { useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import { agorot } from '@/lib/insightsApi';
import { formatQuantity } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  durationText,
  pctText,
  sortRows,
  type KioskPayments,
  type KioskTopItem,
  type KioskUpsell,
  type PerKioskRow,
  type SortDir,
} from '@/lib/kioskInsights';
import { CHART, Capsule, Card, Figure, IOS, Muted, RowDivider } from '@/components/dashboard/insights/ios';
import { useKioskLabels } from './labels';

const count = (n: number) => n.toLocaleString('he-IL');
const TH = 'px-2 py-1.5 text-start font-normal';
const THE = 'px-2 py-1.5 text-end font-normal';
const TR = 'border-t border-[#3C3C4349] dark:border-[#54545899]';

/** A small grey heading inside a card. */
function SubTitle({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className="mb-1 flex flex-wrap items-center justify-between gap-2 px-4 pt-3 text-[13px] text-[#8E8E93]">
      <span>{children}</span>
      {trailing}
    </div>
  );
}

/* -------------------------------------------------------------- top items */

export function TopItemsList({ items }: { items: KioskTopItem[] }) {
  const t = useTranslations('kioskInsights.topItems');
  if (items.length === 0) return <Card><Muted>{t('empty')}</Muted></Card>;
  const max = Math.max(...items.map((i) => i.units), 1);
  return (
    <Card className="p-0">
      <ol>
        {items.map((item, i) => (
          <li key={item.productId ?? `${item.name}-${i}`} className="relative flex items-center gap-3 px-4 py-2.5">
            {i > 0 ? <RowDivider /> : null}
            <span className="w-5 shrink-0 text-center text-[13px] tabular-nums text-[#8E8E93]">{i + 1}</span>
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-[15px] font-medium">{item.name || t('unnamed')}</span>
                <span className="shrink-0 text-[13px] tabular-nums text-[#8E8E93]">{agorot(item.net)}</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="flex-1">
                  <Capsule value={item.units} max={max} />
                </div>
                <span className="w-16 shrink-0 text-end text-[13px] tabular-nums">{t('units', { n: formatQuantity(item.units) })}</span>
              </div>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/* ----------------------------------------------------------------- upsell */

export function UpsellBlock({ upsell }: { upsell: KioskUpsell }) {
  const t = useTranslations('kioskInsights.upsell');
  const L = useKioskLabels();
  if (upsell.shown === 0 && upsell.accepted === 0) {
    return (
      <Card>
        <Muted>{t('empty')}</Muted>
        {upsell.source === 'till_stats' ? <p className="mt-1 text-[12px] text-[#8E8E93]">{t('tillStats')}</p> : null}
      </Card>
    );
  }
  const maxProduct = Math.max(...upsell.byProduct.map((p) => p.accepted), 1);
  return (
    <div className="space-y-3">
      <Card className="p-0">
        <div className="grid grid-cols-4 divide-x divide-x-reverse divide-[#3C3C4349] py-3 dark:divide-[#54545899]">
          <Figure value={count(upsell.shown)} label={t('shown')} />
          <Figure value={count(upsell.accepted)} label={t('accepted')} />
          <Figure value={count(upsell.declined)} label={t('declined')} />
          <Figure value={pctText(upsell.rate)} label={t('rate')} />
        </div>
        {upsell.source === 'till_stats' ? <p className="px-4 pb-3 text-[12px] text-[#8E8E93]">{t('tillStats')}</p> : null}
      </Card>

      <div className="grid gap-3 xl:grid-cols-2">
        <Card className="p-0">
          <SubTitle>{t('byRule')}</SubTitle>
          {upsell.byRule.length === 0 ? (
            <Muted className="px-4 pb-3">{t('noRules')}</Muted>
          ) : (
            <div className="overflow-x-auto px-2 pb-2">
              <table className="w-full text-[15px]">
                <thead>
                  <tr className="text-[13px] text-[#8E8E93]">
                    <th className={TH}>{t('rule')}</th>
                    <th className={THE}>{t('shown')}</th>
                    <th className={THE}>{t('accepted')}</th>
                    <th className={THE}>{t('declined')}</th>
                    <th className={cn(THE, 'w-32')}>{t('rate')}</th>
                  </tr>
                </thead>
                <tbody>
                  {upsell.byRule.map((r, i) => (
                    <tr key={r.ruleId ?? `rule-${i}`} className={TR}>
                      <td className="max-w-56 truncate px-2 py-1.5">{r.name || t('unnamedRule')}</td>
                      <td className="px-2 py-1.5 text-end tabular-nums">{count(r.shown)}</td>
                      <td className="px-2 py-1.5 text-end tabular-nums">{count(r.accepted)}</td>
                      <td className="px-2 py-1.5 text-end tabular-nums text-[#8E8E93]">{count(r.declined)}</td>
                      <td className="px-2 py-1.5">
                        <div className="flex items-center gap-2">
                          <div className="flex-1">
                            <Capsule value={r.rate ?? 0} max={100} />
                          </div>
                          <span className="w-12 text-end text-[13px] tabular-nums">{pctText(r.rate, 0)}</span>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>

        <div className="space-y-3">
          <Card className="p-0">
            <SubTitle>{t('byProduct')}</SubTitle>
            {upsell.byProduct.length === 0 ? (
              <Muted className="px-4 pb-3">{t('noProducts')}</Muted>
            ) : (
              <ul className="pb-1">
                {upsell.byProduct.map((p, i) => (
                  <li key={p.productId ?? `p-${i}`} className="relative flex items-center gap-3 px-4 py-2">
                    {i > 0 ? <RowDivider /> : null}
                    <span className="min-w-0 flex-1 truncate text-[15px]">{p.name || t('unknownProduct')}</span>
                    <div className="w-24">
                      <Capsule value={p.accepted} max={maxProduct} />
                    </div>
                    <span className="w-10 text-end text-[13px] tabular-nums">{count(p.accepted)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
          {upsell.byMoment.length > 0 ? (
            <Card className="p-0">
              <SubTitle>{t('byMoment')}</SubTitle>
              <ul className="pb-1">
                {upsell.byMoment.map((m, i) => (
                  <li key={m.moment} className="relative flex items-center gap-3 px-4 py-2">
                    {i > 0 ? <RowDivider /> : null}
                    <span className="min-w-0 flex-1 truncate text-[15px]">{L.moment(m.moment)}</span>
                    <span className="text-[13px] tabular-nums text-[#8E8E93]">{t('acceptedOf', { accepted: count(m.accepted), shown: count(m.shown) })}</span>
                    <span className="w-12 text-end text-[13px] font-semibold tabular-nums">{pctText(m.rate, 0)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- payments */

export function PaymentsBlock({ payments }: { payments: KioskPayments }) {
  const t = useTranslations('kioskInsights.payments');
  const L = useKioskLabels();
  if (payments.attempts === 0 && payments.failures === 0 && payments.terminalOutcomes.length === 0) {
    return <Card><Muted>{t('empty')}</Muted></Card>;
  }
  const maxReason = Math.max(...payments.byReason.map((r) => r.count), 1);
  const maxOutcome = Math.max(...payments.terminalOutcomes.map((r) => r.count), 1);
  return (
    <div className="space-y-3">
      <Card className="p-0">
        <div className="grid grid-cols-4 divide-x divide-x-reverse divide-[#3C3C4349] py-3 dark:divide-[#54545899]">
          <Figure value={count(payments.attempts)} label={t('attempts')} />
          <Figure value={count(payments.approved)} label={t('approved')} />
          <Figure value={count(payments.failures)} label={t('failures')} />
          <Figure value={pctText(payments.failureRate)} label={t('failureRate')} />
        </div>
      </Card>
      <div className="grid gap-3 xl:grid-cols-2">
        <Card className="p-0">
          <SubTitle>{t('byReason')}</SubTitle>
          {payments.byReason.length === 0 ? (
            <Muted className="px-4 pb-3">{t('noFailures')}</Muted>
          ) : (
            <ul className="pb-1">
              {payments.byReason.map((r, i) => (
                <li key={`${r.result}:${r.reason}`} className="relative flex items-center gap-3 px-4 py-2">
                  {i > 0 ? <RowDivider /> : null}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[15px]">{L.payReason(r.reason)}</div>
                    <div className="text-[12px] text-[#8E8E93]">{L.payResult(r.result)}</div>
                  </div>
                  <div className="w-24">
                    <Capsule value={r.count} max={maxReason} color={IOS.red} />
                  </div>
                  <span className="w-10 text-end text-[13px] tabular-nums">{count(r.count)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <div className="space-y-3">
          {payments.byMethod.length > 0 ? (
            <Card className="p-0">
              <SubTitle>{t('byMethod')}</SubTitle>
              <ul className="pb-1">
                {payments.byMethod.map((m, i) => (
                  <li key={m.method} className="relative flex items-center justify-between gap-3 px-4 py-2">
                    {i > 0 ? <RowDivider /> : null}
                    <span className="truncate text-[15px]">{L.method(m.method)}</span>
                    <span className="text-[13px] tabular-nums">{count(m.count)}</span>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
          <Card className="p-0">
            <SubTitle trailing={<span className="text-[12px]">{t('terminalHint')}</span>}>{t('terminalOutcomes')}</SubTitle>
            {payments.terminalOutcomes.length === 0 ? (
              <Muted className="px-4 pb-3">{t('noOutcomes')}</Muted>
            ) : (
              <ul className="pb-1">
                {payments.terminalOutcomes.map((o, i) => (
                  <li key={o.outcome} className="relative flex items-center gap-3 px-4 py-2">
                    {i > 0 ? <RowDivider /> : null}
                    <span className="min-w-0 flex-1 truncate text-[15px]">{L.outcome(o.outcome)}</span>
                    <div className="w-24">
                      <Capsule value={o.count} max={maxOutcome} color={CHART.muted} />
                    </div>
                    <span className="w-10 text-end text-[13px] tabular-nums">{count(o.count)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------- per kiosk */

type Col = {
  key: keyof PerKioskRow;
  label: string;
  render: (r: PerKioskRow) => ReactNode;
  /** Less is better: the column's default sort is ascending. */
  low?: boolean;
};

export function PerKioskTable({
  rows,
  selectedId,
  onSelect,
}: {
  rows: PerKioskRow[];
  selectedId: string;
  onSelect: (machineId: string) => void;
}) {
  const t = useTranslations('kioskInsights.perKiosk');
  const [sort, setSort] = useState<{ key: keyof PerKioskRow; dir: SortDir }>({ key: 'revenue', dir: 'desc' });
  const cols: Col[] = [
    { key: 'sessions', label: t('sessions'), render: (r) => count(r.sessions) },
    { key: 'conversion', label: t('conversion'), render: (r) => pctText(r.conversion) },
    { key: 'abandoned', label: t('abandoned'), render: (r) => count(r.abandoned), low: true },
    { key: 'orders', label: t('orders'), render: (r) => count(r.orders) },
    { key: 'revenue', label: t('revenue'), render: (r) => agorot(r.revenue) },
    { key: 'avgBasket', label: t('avgBasket'), render: (r) => agorot(r.avgBasket) },
    { key: 'itemsPerOrder', label: t('itemsPerOrder'), render: (r) => (r.itemsPerOrder !== null ? r.itemsPerOrder.toFixed(2) : '—') },
    { key: 'medianOrderSec', label: t('medianOrder'), render: (r) => durationText(r.medianOrderSec), low: true },
    { key: 'upsellRate', label: t('upsellRate'), render: (r) => pctText(r.upsellRate) },
    { key: 'payFailureRate', label: t('payFailureRate'), render: (r) => pctText(r.payFailureRate), low: true },
  ];
  const sorted = sortRows(rows, sort.key, sort.dir);
  const toggle = (key: keyof PerKioskRow, low?: boolean) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: low || key === 'name' ? 'asc' : 'desc' }));
  const header = (key: keyof PerKioskRow, label: string, low?: boolean, start?: boolean) => {
    const on = sort.key === key;
    const Icon = !on ? ArrowUpDown : sort.dir === 'asc' ? ArrowUp : ArrowDown;
    return (
      <th key={String(key)} className={start ? TH : THE} aria-sort={on ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
        <button
          type="button"
          onClick={() => toggle(key, low)}
          className={cn('inline-flex items-center gap-1 whitespace-nowrap', on && 'font-semibold text-black dark:text-white')}
          title={t('sortBy', { col: label })}
        >
          {label}
          <Icon className="h-3 w-3 shrink-0" aria-hidden />
        </button>
      </th>
    );
  };

  if (rows.length === 0) return <Card><Muted>{t('empty')}</Muted></Card>;
  return (
    <Card className="p-0">
      <div className="overflow-x-auto px-2 py-2">
        <table className="w-full min-w-[880px] text-[14px]">
          <thead>
            <tr className="text-[12px] text-[#8E8E93]">
              {header('name', t('name'), false, true)}
              {cols.map((c) => header(c.key, c.label, c.low))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((r) => (
              <tr key={r.machineId} className={cn(TR, r.machineId === selectedId && 'bg-[#007AFF14] dark:bg-[#0A84FF29]')}>
                <td className="px-2 py-2">
                  <button
                    type="button"
                    onClick={() => onSelect(r.machineId === selectedId ? '' : r.machineId)}
                    className="text-start"
                    title={t('narrow')}
                  >
                    <span className="block font-medium text-[#007AFF] dark:text-[#0A84FF]">{r.name || r.machineName}</span>
                    <span className="block text-[12px] text-[#8E8E93]">
                      {[r.shopName, r.isKiosk ? null : t('notKiosk')].filter(Boolean).join(' · ')}
                    </span>
                  </button>
                </td>
                {cols.map((c) => (
                  <td key={String(c.key)} className="px-2 py-2 text-end tabular-nums">
                    {c.render(r)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
