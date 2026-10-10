'use client';

/**
 * "מימושים לפי קופה": one row per till under the page's filters — its shop, vouchers and items
 * redeemed, the value per accounting mode (a deduction, a payment, memo value — never "a discount"),
 * what is flagged; redemptions over time by day or by hour; a till's redemptions (time, voucher,
 * batch, items, employee). Excel / print / PDF through the reports' toolbar.
 *
 * Top-ups, refusals, overrides and offline redemptions are not recorded yet (reserve → confirm, the
 * override audit and offline sync come later): their columns say so rather than show a 0.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { X } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import type { ExcelSheet } from '@/lib/excelExport';
import { fetchAllPages } from '@/lib/fetchAllPages';
import { formatDateTime, formatShortDate, isoDate } from '@/lib/format';
import { agorotText, filtersToQuery, type VoucherFilters } from '@/lib/prepaidVoucherFilters';
import {
  fetchPrepaidRedemptions,
  fetchPrepaidTillReport,
  type PrepaidRedemptionRow,
  type PrepaidTillRow,
} from '@/lib/prepaidVouchersApi';
import { CHART, ChartTokens, Segmented, tooltipStyle } from '@/components/dashboard/insights/ios';
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { RedemptionFlags, useFlagTexts } from './redemption-flags';

const PAGE = 100;
const MODES = ['discount', 'payment', 'zero'] as const;

const when = (iso: string | null | undefined) => (isoDate(iso) ? formatDateTime(iso) : '');
const shekels = (agorot: number) => Math.round(agorot) / 100;

function itemsText(r: PrepaidRedemptionRow): string {
  if (r.uses) return `×${r.uses}`;
  return r.items.map((i) => `${i.quantity}× ${i.name ?? ''}`).join(', ');
}

export function TillsReport({ filters, onTill }: { filters: VoucherFilters; onTill?: (machineId: string) => void }) {
  const t = useTranslations('prepaidVouchers.tills');
  const flagTexts = useFlagTexts();
  const [bucket, setBucket] = useState<'day' | 'hour'>('day');
  const [openTill, setOpenTill] = useState<PrepaidTillRow | null>(null);
  const query = filtersToQuery(filters);
  const key = query.toString();
  const report = useQuery({
    queryKey: ['prepaid-till-report', key, bucket],
    queryFn: () => fetchPrepaidTillReport(query, bucket),
  });
  const rows = report.data?.items ?? [];
  const usedModes = MODES.filter((m) => rows.some((r) => r.value[m] !== 0));
  const modes = usedModes.length ? usedModes : (['discount'] as const);
  const notRecorded = <span className="text-xs text-muted-foreground">{t('notRecorded')}</span>;

  const getSheets = async (): Promise<ExcelSheet[]> => {
    const tills: ExcelSheet = {
      name: t('sheetTills'),
      heading: [t('valueNote')],
      columns: [
        { header: t('till'), width: 22 },
        { header: t('shop'), width: 18 },
        { header: t('redemptions'), kind: 'number' },
        { header: t('vouchers'), kind: 'number' },
        { header: t('items'), kind: 'number' },
        ...modes.map((m) => ({ header: t(`value.${m}`), kind: 'money' as const })),
        { header: t('value.total'), kind: 'money' },
        { header: t('flagged'), kind: 'number' },
      ],
      rows: rows.map((r) => [
        r.name ?? t('unknownTill'), r.shopName ?? '', r.redemptions, r.vouchers, r.items,
        ...modes.map((m) => shekels(r.value[m])), shekels(r.value.total), r.flagged,
      ]),
      totals: report.data
        ? [t('total'), '', report.data.totals.redemptions, report.data.totals.vouchers, report.data.totals.items,
          ...modes.map((m) => shekels(report.data!.totals.value[m])), shekels(report.data.totals.value.total), null]
        : undefined,
    };
    const all = await fetchAllPages((page, size) => fetchPrepaidRedemptions(query, size, (page - 1) * size), { pageSize: 1000 });
    const redemptions: ExcelSheet = {
      name: t('sheetRedemptions'),
      columns: [
        { header: t('time'), kind: 'datetime' },
        { header: t('till'), width: 18 },
        { header: t('voucher') },
        { header: t('batch'), width: 26 },
        { header: t('itemsCol'), width: 36 },
        { header: t('employee'), width: 16 },
        { header: t('valueCol'), kind: 'money' },
        { header: t('flagsCol'), width: 26 },
      ],
      rows: all.map((r) => [
        r.redeemedAt, r.machineName ?? '', r.serial ? `#${r.serial} ${r.displayCode ?? ''}` : '', r.batch.name, itemsText(r),
        r.employeeName ?? '', shekels(r.value), flagTexts(r.flags).join(', '),
      ]),
    };
    return [tills, redemptions];
  };

  return (
    <div className="space-y-3">
      <ReportExportToolbar title={t('title')} from={filters.from || undefined} to={filters.to || undefined} getSheets={getSheets}
        disabled={!report.data || rows.length === 0} />
      {report.data?.testBatchesExcluded ? (
        <p className="text-xs text-muted-foreground">{t('testExcluded', { count: report.data.testBatchesExcluded })}</p>
      ) : null}
      {report.isPending ? (
        <Skeleton className="h-48 w-full rounded-xl" />
      ) : report.isError ? (
        <p className="text-sm text-destructive">{axiosErrorToToastMessage(report.error, t('empty'))}</p>
      ) : rows.length === 0 ? (
        <p className="rounded-xl border border-dashed p-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <>
          <div className="rounded-xl bg-card p-3 ring-1 ring-foreground/10">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-medium">{t('chart')}</h3>
              <Segmented value={bucket} onChange={setBucket} className="w-44 print:hidden"
                options={[{ id: 'day', label: t('byDay') }, { id: 'hour', label: t('byHour') }]} />
            </div>
            <ChartTokens>
              <div className="h-56" dir="ltr">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={report.data!.series} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid vertical={false} stroke={CHART.grid} />
                    <XAxis dataKey="key" tick={{ fontSize: 11 }}
                      tickFormatter={(k) => (bucket === 'hour' ? `${String(k).padStart(2, '0')}:00` : formatShortDate(String(k)))} />
                    <YAxis allowDecimals={false} width={32} tick={{ fontSize: 11 }} />
                    <Tooltip contentStyle={tooltipStyle}
                      labelFormatter={(k) => (bucket === 'hour' ? `${String(k).padStart(2, '0')}:00` : formatShortDate(String(k)))}
                      formatter={(v) => [String(v), t('redemptions')]} />
                    <Bar dataKey="redemptions" fill={CHART.accent} radius={[4, 4, 0, 0]} maxBarSize={24} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </ChartTokens>
          </div>

          <div className="overflow-x-auto rounded-xl bg-card ring-1 ring-foreground/10">
            <table className="w-full text-sm">
              <thead className="text-xs text-muted-foreground">
                <tr className="border-b">
                  <th className="px-3 py-2 text-start font-medium">{t('till')}</th>
                  <th className="px-3 py-2 text-start font-medium">{t('shop')}</th>
                  <th className="px-3 py-2 text-end font-medium">{t('redemptions')}</th>
                  <th className="px-3 py-2 text-end font-medium">{t('vouchers')}</th>
                  <th className="px-3 py-2 text-end font-medium">{t('items')}</th>
                  {modes.map((m) => <th key={m} className="px-3 py-2 text-end font-medium">{t(`value.${m}`)}</th>)}
                  <th className="px-3 py-2 text-end font-medium">{t('topUp')}</th>
                  <th className="px-3 py-2 text-end font-medium">{t('refusals')}</th>
                  <th className="px-3 py-2 text-end font-medium">{t('overrides')}</th>
                  <th className="px-3 py-2 text-end font-medium">{t('offlinePending')}</th>
                  <th className="px-3 py-2 text-end font-medium">{t('flagged')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.machineId ?? 'none'} className={cn('cursor-pointer border-b last:border-0 hover:bg-muted/50',
                    openTill?.machineId === r.machineId && 'bg-muted/60')}
                    onClick={() => { setOpenTill(r); if (r.machineId) onTill?.(r.machineId); }}>
                    <td className="px-3 py-2 font-medium">{r.name ?? t('unknownTill')}</td>
                    <td className="px-3 py-2 text-muted-foreground">{r.shopName ?? ''}</td>
                    <td className="px-3 py-2 text-end tabular-nums">{r.redemptions}</td>
                    <td className="px-3 py-2 text-end tabular-nums">{r.vouchers}</td>
                    <td className="px-3 py-2 text-end tabular-nums">{r.items}</td>
                    {modes.map((m) => <td key={m} className="px-3 py-2 text-end tabular-nums">{agorotText(r.value[m])}</td>)}
                    <td className="px-3 py-2 text-end">{r.topUp == null ? notRecorded : agorotText(r.topUp)}</td>
                    <td className="px-3 py-2 text-end">{r.refusals == null ? notRecorded : r.refusals}</td>
                    <td className="px-3 py-2 text-end">{r.overrides == null ? notRecorded : r.overrides}</td>
                    <td className="px-3 py-2 text-end">{r.offlinePending == null ? notRecorded : r.offlinePending}</td>
                    <td className="px-3 py-2 text-end tabular-nums">{r.flagged || ''}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="border-t font-semibold">
                <tr>
                  <td className="px-3 py-2" colSpan={2}>{t('total')}</td>
                  <td className="px-3 py-2 text-end tabular-nums">{report.data!.totals.redemptions}</td>
                  <td className="px-3 py-2 text-end tabular-nums">{report.data!.totals.vouchers}</td>
                  <td className="px-3 py-2 text-end tabular-nums">{report.data!.totals.items}</td>
                  {modes.map((m) => <td key={m} className="px-3 py-2 text-end tabular-nums">{agorotText(report.data!.totals.value[m])}</td>)}
                  <td colSpan={5} />
                </tr>
              </tfoot>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">{t('valueNote')}</p>
          <p className="text-xs text-muted-foreground">{t('notRecordedNote')}</p>
          {openTill ? <TillRedemptions key={openTill.machineId ?? "none"} till={openTill} filters={filters} onClose={() => setOpenTill(null)} /> : null}
        </>
      )}
    </div>
  );
}

function TillRedemptions({ till, filters, onClose }: { till: PrepaidTillRow; filters: VoucherFilters; onClose: () => void }) {
  const t = useTranslations('prepaidVouchers.tills');
  const [offset, setOffset] = useState(0);
  const query = filtersToQuery({ ...filters, machineId: till.machineId ? [till.machineId] : [] });
  const key = query.toString();
  const list = useQuery({
    queryKey: ['prepaid-redemptions', key, offset],
    queryFn: () => fetchPrepaidRedemptions(query, PAGE, offset),
  });
  return (
    <div className="space-y-2 rounded-xl bg-card p-3 ring-1 ring-foreground/10">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{t('details', { name: till.name ?? t('unknownTill') })}</h3>
        <Button size="icon-sm" variant="ghost" aria-label={t('close')} onClick={onClose} className="print:hidden"><X className="h-4 w-4" /></Button>
      </div>
      {list.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-muted-foreground">
              <tr className="border-b">
                <th className="px-2 py-1.5 text-start font-medium">{t('time')}</th>
                <th className="px-2 py-1.5 text-start font-medium">{t('voucher')}</th>
                <th className="px-2 py-1.5 text-start font-medium">{t('batch')}</th>
                <th className="px-2 py-1.5 text-start font-medium">{t('itemsCol')}</th>
                <th className="px-2 py-1.5 text-start font-medium">{t('employee')}</th>
                <th className="px-2 py-1.5 text-end font-medium">{t('valueCol')}</th>
              </tr>
            </thead>
            <tbody>
              {(list.data?.items ?? []).map((r) => (
                <tr key={r.id} className="border-b last:border-0">
                  <td className="px-2 py-1.5 whitespace-nowrap tabular-nums">{when(r.redeemedAt)}</td>
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    {r.serial ? <span className="font-medium">#{r.serial}</span> : null}{' '}
                    <span dir="ltr" className="font-mono text-xs text-muted-foreground">{r.displayCode}</span>
                  </td>
                  <td className="px-2 py-1.5">{r.batch.name}{r.batch.customerName ? <span className="text-muted-foreground"> · {r.batch.customerName}</span> : null}</td>
                  <td className="px-2 py-1.5">{itemsText(r)}<RedemptionFlags flags={r.flags} /></td>
                  <td className="px-2 py-1.5">{r.employeeName ?? ''}</td>
                  <td className="px-2 py-1.5 text-end tabular-nums" title={t(`basis.${r.valueBasis}`)}>{agorotText(r.value)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.data && list.data.total > PAGE ? (
        <div className="flex items-center justify-center gap-2 print:hidden">
          <Button size="sm" variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>‹</Button>
          <span className="text-xs tabular-nums text-muted-foreground">{offset + 1}–{Math.min(offset + PAGE, list.data.total)} / {list.data.total}</span>
          <Button size="sm" variant="outline" disabled={offset + PAGE >= list.data.total} onClick={() => setOffset(offset + PAGE)}>›</Button>
        </div>
      ) : null}
    </div>
  );
}
