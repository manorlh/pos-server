'use client';

/**
 * Production in groups of one prepaid voucher batch ("שוברי הפקה", pos-server
 * docs/SPEC_VOUCHER_PRODUCTION.md): every group (an envelope of 10, 20 …) with its serials and
 * how many of its vouchers came back — unused, partly used, used, cancelled — a PDF of one
 * group (opened by its cover sheet), and cancelling a whole group in one action (a lost
 * envelope), with the reason. Below: the batch's audit trail.
 */

import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Ban, FileDown, RefreshCw } from 'lucide-react';
import {
  cancelPrepaidGroup,
  fetchPrepaidEvents,
  fetchPrepaidGroups,
  type PrepaidBatchEvent,
  type PrepaidVoucherBatch,
} from '@/lib/prepaidVouchersApi';
import { serialRange } from '@/lib/prepaidVoucherGroups';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatDateTime, isoDate } from '@/lib/format';
import type { ExcelSheet } from '@/lib/excelExport';
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const NUM = 'text-end tabular-nums';

function when(iso: string | null): string {
  return isoDate(iso) ? formatDateTime(iso) : '';
}

function EventLine({ e }: { e: PrepaidBatchEvent }) {
  const t = useTranslations('prepaidVouchers.events');
  const serial = typeof e.details?.serial === 'number' ? ` #${e.details.serial}` : '';
  return (
    <li className="rounded border px-2 py-1 text-xs">
      <span className="font-medium tabular-nums">{when(e.createdAt)}</span>
      {' · '}
      {t(`action.${e.action}`, { count: e.count ?? 0, group: e.group ?? '' })}
      {serial}
      {e.userName ? <span className="text-muted-foreground"> · {t('by', { name: e.userName })}</span> : null}
      {e.reason ? <span className="block text-muted-foreground">{t('reason', { reason: e.reason })}</span> : null}
    </li>
  );
}

export function PrepaidBatchGroupsView({
  batch,
  busy,
  onGroupPdf,
}: {
  batch: PrepaidVoucherBatch;
  busy: boolean;
  /** Download one group's PDF (cover sheet first) at the layout picked on the vouchers tab. */
  onGroupPdf: (group: number, range: [number, number]) => void;
}) {
  const t = useTranslations('prepaidVouchers.groups');
  const tp = useTranslations('prepaidVouchers');
  const te = useTranslations('prepaidVouchers.events');
  const tc = useTranslations('common');
  const qc = useQueryClient();

  const groups = useQuery({ queryKey: ['prepaid-voucher-groups', batch.id], queryFn: () => fetchPrepaidGroups(batch.id) });
  const events = useQuery({ queryKey: ['prepaid-voucher-events', batch.id], queryFn: () => fetchPrepaidEvents(batch.id) });

  const cancel = useMutation({
    mutationFn: ({ group, reason }: { group: number; reason: string }) => cancelPrepaidGroup(batch.id, group, reason),
    onSuccess: (out) => {
      if (out.cancelled) toast.success(t('cancelled', { group: out.group, n: out.cancelled }));
      else toast.info(t('nothingToCancel', { group: out.group }));
      void qc.invalidateQueries({ queryKey: ['prepaid-voucher-groups', batch.id] });
      void qc.invalidateQueries({ queryKey: ['prepaid-voucher-events', batch.id] });
      void qc.invalidateQueries({ queryKey: ['prepaid-voucher-batches'] });
      void qc.invalidateQueries({ queryKey: ['prepaid-vouchers', batch.id] });
    },
    onError: (err) => {
      const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
      toast.error(
        typeof detail === 'string' && tp.has(`errors.${detail}`) ? tp(`errors.${detail}`) : axiosErrorToToastMessage(err, tc('error')),
      );
    },
  });

  const askCancel = (group: number, range: string) => {
    const reason = window.prompt(t('cancelPrompt', { group, range }));
    if (reason === null) return;
    cancel.mutate({ group, reason: reason.trim() });
  };

  const rows = groups.data?.items ?? [];
  const sum = (k: 'total' | 'active' | 'partiallyUsed' | 'used' | 'cancelled' | 'redeemed') =>
    rows.reduce((s, r) => s + r[k], 0);
  const pct = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : '—');
  const cancelled = batch.status === 'cancelled';
  const eventRows = events.data ?? [];

  /** The groups with their totals, and the audit trail (all of it: the endpoint is not paged). */
  const exportSheets = (): ExcelSheet[] => {
    // Redemption as a percent number (12.5 → 12.5%), blank where nothing could be redeemed.
    const ratio = (part: number, whole: number) => (whole ? Math.round((part / whole) * 10000) / 100 : null);
    const sheets: ExcelSheet[] = [];
    if (rows.length > 0) {
      sheets.push({
        name: t('title'),
        columns: [
          { header: t('col.group'), kind: 'number' },
          { header: t('col.serials'), width: 14 },
          { header: t('col.total'), kind: 'number' },
          { header: t('col.active'), kind: 'number' },
          { header: t('col.partiallyUsed'), kind: 'number' },
          { header: t('col.used'), kind: 'number' },
          { header: t('col.cancelled'), kind: 'number' },
          { header: t('col.redeemed'), kind: 'percent' },
        ],
        rows: rows.map((r) => [
          r.group ?? t('noGroup'), serialRange(r.fromSerial, r.toSerial), r.total, r.active, r.partiallyUsed, r.used,
          r.cancelled, ratio(r.redeemed, r.total - r.cancelled),
        ]),
        totals: [
          t('totals'), null, sum('total'), sum('active'), sum('partiallyUsed'), sum('used'), sum('cancelled'),
          ratio(sum('redeemed'), sum('total') - sum('cancelled')),
        ],
      });
    }
    if (eventRows.length > 0) {
      sheets.push({
        name: te('title'),
        columns: [
          { header: te('col.when'), kind: 'datetime' },
          { header: te('col.action'), width: 34 },
          { header: t('col.group'), kind: 'number' },
          { header: te('col.serial'), kind: 'number' },
          { header: te('col.count'), kind: 'number' },
          { header: te('col.user') },
          { header: te('col.reason'), width: 30 },
        ],
        rows: eventRows.map((e) => {
          const serial = e.details?.serial;
          return [
            e.createdAt, te(`action.${e.action}`, { count: e.count ?? 0, group: e.group ?? '' }), e.group,
            typeof serial === 'number' ? serial : null, e.count, e.userName, e.reason,
          ];
        }),
      });
    }
    return sheets;
  };

  return (
    <div className="space-y-4">
      <ReportExportToolbar
        title={`${t('title')} · ${batch.name}`}
        disabled={rows.length === 0 && eventRows.length === 0}
        getSheets={exportSheets}
      />
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle className="text-base">{t('title')}</CardTitle>
          <Button size="icon-sm" variant="ghost" aria-label={tp('report.refresh')} title={tp('report.refresh')}
            onClick={() => { void groups.refetch(); void events.refetch(); }}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </CardHeader>
        <CardContent>
          {groups.isPending ? (
            <Skeleton className="h-32 w-full" />
          ) : groups.isError ? (
            <p className="text-sm text-destructive">{t('loadError')}</p>
          ) : rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
          ) : (
            <div className="max-h-[60vh] overflow-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('col.group')}</TableHead>
                    <TableHead>{t('col.serials')}</TableHead>
                    <TableHead className="text-end">{t('col.total')}</TableHead>
                    <TableHead className="text-end">{t('col.active')}</TableHead>
                    <TableHead className="text-end">{t('col.partiallyUsed')}</TableHead>
                    <TableHead className="text-end">{t('col.used')}</TableHead>
                    <TableHead className="text-end">{t('col.cancelled')}</TableHead>
                    <TableHead className="text-end">{t('col.redeemed')}</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => {
                    const range = serialRange(r.fromSerial, r.toSerial);
                    const open = r.active + r.partiallyUsed;
                    return (
                      <TableRow key={r.group ?? 'none'}>
                        <TableCell className="font-semibold tabular-nums">{r.group ?? t('noGroup')}</TableCell>
                        <TableCell className="tabular-nums" dir="ltr">{range}</TableCell>
                        <TableCell className={NUM}>{r.total}</TableCell>
                        <TableCell className={NUM}>{r.active}</TableCell>
                        <TableCell className={NUM}>{r.partiallyUsed}</TableCell>
                        <TableCell className={NUM}>{r.used}</TableCell>
                        <TableCell className={NUM}>{r.cancelled}</TableCell>
                        <TableCell className={NUM}>{pct(r.redeemed, r.total - r.cancelled)}</TableCell>
                        <TableCell className="text-end">
                          {r.group != null ? (
                            <div className="flex justify-end gap-1">
                              <Button size="icon-sm" variant="ghost" aria-label={t('pdf')} title={t('pdf')}
                                disabled={busy || r.total === r.cancelled}
                                onClick={() => onGroupPdf(r.group!, [r.fromSerial, r.toSerial])}>
                                <FileDown className="h-4 w-4" />
                              </Button>
                              {!cancelled && open > 0 ? (
                                <Button size="icon-sm" variant="ghost" aria-label={t('cancel')} title={t('cancel')}
                                  disabled={cancel.isPending}
                                  onClick={() => askCancel(r.group!, range)}>
                                  <Ban className="h-4 w-4 text-destructive" />
                                </Button>
                              ) : null}
                            </div>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
                <TableFooter>
                  <TableRow>
                    <TableCell className="font-semibold">{t('totals')}</TableCell>
                    <TableCell />
                    <TableCell className={NUM}>{sum('total')}</TableCell>
                    <TableCell className={NUM}>{sum('active')}</TableCell>
                    <TableCell className={NUM}>{sum('partiallyUsed')}</TableCell>
                    <TableCell className={NUM}>{sum('used')}</TableCell>
                    <TableCell className={NUM}>{sum('cancelled')}</TableCell>
                    <TableCell className={NUM}>{pct(sum('redeemed'), sum('total') - sum('cancelled'))}</TableCell>
                    <TableCell />
                  </TableRow>
                </TableFooter>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{te('title')}</CardTitle>
        </CardHeader>
        <CardContent>
          {events.isPending ? (
            <Skeleton className="h-16 w-full" />
          ) : events.isError ? (
            <p className="text-sm text-destructive">{te('loadError')}</p>
          ) : (events.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">{te('empty')}</p>
          ) : (
            <ul className="space-y-1">
              {events.data!.map((e) => <EventLine key={e.id} e={e} />)}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
