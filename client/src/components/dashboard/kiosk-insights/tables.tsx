'use client';

/**
 * The lists of "ביצועי קיוסקים": the top items, upsell (by rule, product and moment), the
 * payments' failures, and the per-kiosk table (a report table: sortable, the reader's
 * columns, a card per kiosk on a phone; a kiosk's name narrows the page to it).
 */

import { useMemo, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { agorot } from '@/lib/insightsApi';
import { formatQuantity } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  durationText,
  pctText,
  shekels,
  sortRows,
  type KioskInsightsReport,
  type KioskPayments,
  type KioskTopItem,
  type KioskUpsell,
  type PerKioskColumn,
  type PerKioskRow,
} from '@/lib/kioskInsights';
import { CHART, Capsule, Card, Figure, IOS, Muted, RowDivider } from '@/components/dashboard/insights/ios';
import { ReportTable, type ReportColumn, type ReportTableSpec } from '@/components/dashboard/report-framework';
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

/** The report key of "ביצועי קיוסקים": the reader's columns, the company's export default. */
export const KIOSK_INSIGHTS_REPORT = 'insights-kiosks';

/** A row narrowed to: the iOS blue wash, as the page's selection everywhere. */
const SELECTED = 'bg-[#007AFF14] dark:bg-[#0A84FF29]';

type PerKioskColumnDef = ReportColumn<PerKioskRow> & { key: PerKioskColumn; screenHeader?: string };

/**
 * The per-kiosk table as a report table (P:\specs\reports-upgrade.md §5): one column list for
 * the screen and the export. `exported` carries every column of the sheet (the CSV's
 * `PER_KIOSK_COLUMNS`, in its order and with its headers, the headline as the totals);
 * `screen` is the same table with the page's short headers, the columns the page never showed
 * kept to the export, and the kiosk's name as the button that narrows the page to it.
 * Sorted by revenue (most first) until the reader sorts it.
 */
export function usePerKioskTable({
  data,
  selectedId,
  onSelect,
}: {
  data: Pick<KioskInsightsReport, 'perKiosk' | 'headline'> | undefined;
  selectedId: string;
  onSelect: (machineId: string) => void;
}): { screen: ReportTableSpec<PerKioskRow>; exported: ReportTableSpec<PerKioskRow> } {
  const t = useTranslations('kioskInsights');
  const tp = useTranslations('kioskInsights.perKiosk');
  const tc = useTranslations('common');
  const perKiosk = data?.perKiosk;
  const cur = data?.headline.current ?? null;
  const rows = useMemo(() => sortRows(perKiosk ?? [], 'revenue', 'desc'), [perKiosk]);

  return useMemo(() => {
    /** The headline's figure for a column: the table's totals row (as the sheet always had). */
    const total = (key: PerKioskColumn) => {
      if (!cur || key === 'name' || key === 'shopName') return undefined;
      const v = cur[key] as number | null;
      return key === 'revenue' || key === 'avgBasket' ? shekels(v) : v;
    };
    const defs: PerKioskColumnDef[] = [
      {
        key: 'name',
        header: t('csv.col.name'),
        screenHeader: tp('name'),
        required: true,
        width: 20,
        value: (r) => r.name || r.machineName,
        cell: (r) => (
          <button
            type="button"
            onClick={() => onSelect(r.machineId === selectedId ? '' : r.machineId)}
            className="text-start"
            title={tp('narrow')}
          >
            <span className="block font-medium text-[#007AFF] dark:text-[#0A84FF]">{r.name || r.machineName}</span>
            <span className="block text-[12px] text-[#8E8E93]">
              {[r.shopName, r.isKiosk ? null : tp('notKiosk')].filter(Boolean).join(' · ')}
            </span>
          </button>
        ),
      },
      { key: 'shopName', header: t('csv.col.shopName'), width: 20, exportOnly: true, value: (r) => r.shopName },
      { key: 'sessions', header: t('csv.col.sessions'), screenHeader: tp('sessions'), kind: 'number', value: (r) => r.sessions, cell: (r) => count(r.sessions) },
      { key: 'paidSessions', header: t('csv.col.paidSessions'), kind: 'number', exportOnly: true, value: (r) => r.paidSessions },
      { key: 'conversion', header: t('csv.col.conversion'), screenHeader: tp('conversion'), kind: 'percent', value: (r) => r.conversion },
      {
        key: 'abandoned',
        header: t('csv.col.abandoned'),
        screenHeader: tp('abandoned'),
        kind: 'number',
        firstSort: 'asc',
        value: (r) => r.abandoned,
        cell: (r) => count(r.abandoned),
      },
      { key: 'orders', header: t('csv.col.orders'), screenHeader: tp('orders'), kind: 'number', value: (r) => r.orders, cell: (r) => count(r.orders) },
      { key: 'revenue', header: t('csv.col.revenue'), screenHeader: tp('revenue'), kind: 'money', value: (r) => shekels(r.revenue) },
      { key: 'avgBasket', header: t('csv.col.avgBasket'), screenHeader: tp('avgBasket'), kind: 'money', value: (r) => shekels(r.avgBasket) },
      {
        key: 'itemsPerOrder',
        header: t('csv.col.itemsPerOrder'),
        screenHeader: tp('itemsPerOrder'),
        kind: 'number',
        value: (r) => r.itemsPerOrder,
        cell: (r) => (r.itemsPerOrder !== null ? r.itemsPerOrder.toFixed(2) : '—'),
        totalCell: cur && cur.itemsPerOrder !== null ? cur.itemsPerOrder.toFixed(2) : undefined,
      },
      {
        key: 'medianOrderSec',
        header: t('csv.col.medianOrderSec'),
        screenHeader: tp('medianOrder'),
        kind: 'number',
        firstSort: 'asc',
        value: (r) => r.medianOrderSec,
        cell: (r) => durationText(r.medianOrderSec),
        totalCell: cur ? durationText(cur.medianOrderSec) : undefined,
      },
      { key: 'upsellShown', header: t('csv.col.upsellShown'), kind: 'number', exportOnly: true, value: (r) => r.upsellShown },
      { key: 'upsellAccepted', header: t('csv.col.upsellAccepted'), kind: 'number', exportOnly: true, value: (r) => r.upsellAccepted },
      { key: 'upsellRate', header: t('csv.col.upsellRate'), screenHeader: tp('upsellRate'), kind: 'percent', value: (r) => r.upsellRate },
      { key: 'payAttempts', header: t('csv.col.payAttempts'), kind: 'number', exportOnly: true, value: (r) => r.payAttempts },
      { key: 'payFailures', header: t('csv.col.payFailures'), kind: 'number', exportOnly: true, value: (r) => r.payFailures },
      {
        key: 'payFailureRate',
        header: t('csv.col.payFailureRate'),
        screenHeader: tp('payFailureRate'),
        kind: 'percent',
        firstSort: 'asc',
        value: (r) => r.payFailureRate,
      },
    ];
    const base = {
      id: 'main',
      rows,
      rowKey: (r: PerKioskRow) => r.machineId,
      totalsLabel: cur ? tc('total') : undefined,
      emptyText: tp('empty'),
      rowClassName: (r: PerKioskRow) => (r.machineId === selectedId ? SELECTED : undefined),
    };
    const columns = (screen: boolean): ReportColumn<PerKioskRow>[] =>
      defs.map(({ screenHeader, ...c }) => ({ ...c, header: screen ? (screenHeader ?? c.header) : c.header, total: total(c.key) }));
    return {
      exported: { ...base, title: t('sections.perKiosk'), columns: columns(false) },
      screen: { ...base, columns: columns(true) },
    };
  }, [cur, onSelect, rows, selectedId, t, tc, tp]);
}

/** Every kiosk side by side: sortable, its columns the reader's, a card per kiosk on a phone. */
export function PerKioskTable({ table }: { table: ReportTableSpec<PerKioskRow> }) {
  const t = useTranslations('kioskInsights.perKiosk');
  if (table.rows.length === 0) return <Card><Muted>{t('empty')}</Muted></Card>;
  return <ReportTable table={table} reportKey={KIOSK_INSIGHTS_REPORT} />;
}
