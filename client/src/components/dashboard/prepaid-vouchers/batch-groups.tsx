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
import { editValueText } from '@/lib/prepaidBatchEdit';
import { useEditFieldLabel, useEditValueFormat } from '@/components/dashboard/prepaid-vouchers/batch-edit';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatDateTime, isoDate } from '@/lib/format';
import type { ExcelSheet } from '@/lib/excelExport';
import {
  StandaloneExportBar,
  sheetAsTable,
  type ReportChart,
  type ReportKpi,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const NUM = 'text-end tabular-nums';

function when(iso: string | null): string {
  return isoDate(iso) ? formatDateTime(iso) : '';
}

/** An "update" line's changes ("ערוך סדרה"): each setting before → after (a production price only to whoever may see it). */
function changesOf(e: PrepaidBatchEvent): { field: string; before?: unknown; after?: unknown; secret?: string }[] {
  const changes = e.details?.changes;
  return Array.isArray(changes) ? (changes as { field: string; before?: unknown; after?: unknown; secret?: string }[]).filter((c) => c && typeof c.field === 'string') : [];
}

/** An audit line's action in words — "מצב בדיקה"'s in its own namespace (batch-test-mode.tsx). */
function useActionText() {
  const t = useTranslations('prepaidVouchers.events');
  const tm = useTranslations('prepaidVoucherTestMode.events');
  return (e: PrepaidBatchEvent) =>
    (t.has(`action.${e.action}`) || !tm.has(e.action)
      ? t(`action.${e.action}`, { count: e.count ?? 0, group: e.group ?? '', name: otherBatchOf(e)?.name ?? '' })
      : tm(e.action));
}

/** "שכפול סדרה": the other batch an audit line names (the source on the new one, the new one on the source). */
function otherBatchOf(e: PrepaidBatchEvent): { id: string; name: string } | null {
  if (e.action !== 'duplicated_from' && e.action !== 'duplicated_to') return null;
  const id = e.details?.batchId;
  const name = e.details?.batchName;
  return typeof id === 'string' && id ? { id, name: typeof name === 'string' ? name : '' } : null;
}

function EventLine({ e, batch, onOpenBatch }: {
  e: PrepaidBatchEvent;
  batch: PrepaidVoucherBatch;
  onOpenBatch?: (id: string) => void;
}) {
  const t = useTranslations('prepaidVouchers.events');
  const actionText = useActionText();
  const fmt = useEditValueFormat(batch);
  const label = useEditFieldLabel();
  const serial = typeof e.details?.serial === 'number' ? ` #${e.details.serial}` : '';
  const changes = e.action === 'update' ? changesOf(e) : [];
  const other = otherBatchOf(e);
  return (
    <li className="rounded border px-2 py-1 text-xs">
      <span className="font-medium tabular-nums">{when(e.createdAt)}</span>
      {' · '}
      {actionText(e)}
      {serial}
      {other && onOpenBatch ? (
        <>
          {' · '}
          <button type="button" className="text-primary underline underline-offset-2 hover:no-underline"
            onClick={() => onOpenBatch(other.id)}>
            {t('openBatch')}
          </button>
        </>
      ) : null}
      {e.userName ? <span className="text-muted-foreground"> · {t('by', { name: e.userName })}</span> : null}
      {e.reason ? <span className="block text-muted-foreground">{t('reason', { reason: e.reason })}</span> : null}
      {Array.isArray(e.details?.overrideText) && e.details.overrideText.length ? (
        <span className="block text-amber-800 dark:text-amber-200">{t('forced', { rules: (e.details.overrideText as string[]).join(', ') })}</span>
      ) : null}
      {changes.length ? (
        <ul className="mt-0.5 space-y-0.5 text-muted-foreground">
          {changes.map((c) => (
            <li key={c.field} className="break-words">
              {label(c.field)}
              {'before' in c || 'after' in c ? `: ${editValueText(c.field, c.before, fmt)} ← ${editValueText(c.field, c.after, fmt)}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export function PrepaidBatchGroupsView({
  batch,
  busy,
  onGroupPdf,
  onOpenBatch,
}: {
  batch: PrepaidVoucherBatch;
  busy: boolean;
  /** Download one group's PDF (cover sheet first) at the layout picked on the vouchers tab. */
  onGroupPdf: (group: number, range: [number, number]) => void;
  /** Open the batch an audit line names ("שוכפלה מסדרה …" / "שוכפלה לסדרה …"). */
  onOpenBatch?: (id: string) => void;
}) {
  const t = useTranslations('prepaidVouchers.groups');
  const tp = useTranslations('prepaidVouchers');
  const te = useTranslations('prepaidVouchers.events');
  const actionText = useActionText();
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

  // Redemption as a percent number (12.5 → 12.5%), blank where nothing could be redeemed.
  const ratio = (part: number, whole: number) => (whole ? Math.round((part / whole) * 10000) / 100 : null);
  /** The groups with their totals (the report's table), and the audit trail (all of it: the endpoint is not paged). */
  const groupsSheet: ExcelSheet = {
    name: t('title'),
    columns: [
      { key: 'group', header: t('col.group'), kind: 'number' },
      { key: 'serials', header: t('col.serials'), width: 14 },
      { key: 'total', header: t('col.total'), kind: 'number' },
      { key: 'active', header: t('col.active'), kind: 'number' },
      { key: 'partiallyUsed', header: t('col.partiallyUsed'), kind: 'number' },
      { key: 'used', header: t('col.used'), kind: 'number' },
      { key: 'cancelled', header: t('col.cancelled'), kind: 'number' },
      { key: 'redeemed', header: t('col.redeemed'), kind: 'percent' },
    ],
    rows: rows.map((r) => [
      r.group ?? t('noGroup'), serialRange(r.fromSerial, r.toSerial), r.total, r.active, r.partiallyUsed, r.used,
      r.cancelled, ratio(r.redeemed, r.total - r.cancelled),
    ]),
    totals: [
      t('totals'), null, sum('total'), sum('active'), sum('partiallyUsed'), sum('used'), sum('cancelled'),
      ratio(sum('redeemed'), sum('total') - sum('cancelled')),
    ],
  };
  const eventsSheet: ExcelSheet = {
    name: te('title'),
    columns: [
      { key: 'when', header: te('col.when'), kind: 'datetime' },
      { key: 'action', header: te('col.action'), width: 34 },
      { key: 'group', header: t('col.group'), kind: 'number' },
      { key: 'serial', header: te('col.serial'), kind: 'number' },
      { key: 'count', header: te('col.count'), kind: 'number' },
      { key: 'user', header: te('col.user') },
      { key: 'reason', header: te('col.reason'), width: 30 },
    ],
    rows: eventRows.map((e) => {
      const serial = e.details?.serial;
      return [
        e.createdAt, actionText(e), e.group,
        typeof serial === 'number' ? serial : null, e.count, e.userName, e.reason,
      ];
    }),
  };
  const exportTables = [
    ...(rows.length > 0 ? [sheetAsTable(groupsSheet, 'main')] : []),
    ...(eventRows.length > 0 ? [sheetAsTable(eventsSheet, 'events')] : []),
  ] as ReportTableSpec<unknown>[];
  // The footer's totals.
  const exportKpis: ReportKpi[] =
    rows.length > 0
      ? [
          { key: 'vouchers', label: t('kpiTotal'), value: sum('total'), kind: 'count', icon: 'voucher' },
          { key: 'active', label: t('col.active'), value: sum('active'), kind: 'count', icon: 'voucher' },
          { key: 'partiallyUsed', label: t('col.partiallyUsed'), value: sum('partiallyUsed'), kind: 'count', icon: 'voucher' },
          { key: 'used', label: t('col.used'), value: sum('used'), kind: 'count', icon: 'items' },
          { key: 'cancelled', label: t('col.cancelled'), value: sum('cancelled'), kind: 'count', icon: 'void' },
          { key: 'redeemedPct', label: t('col.redeemed'), value: ratio(sum('redeemed'), sum('total') - sum('cancelled')), kind: 'percent', icon: 'percent' },
        ]
      : [];
  // Redemption per group, in the groups' order (how many of each envelope came back).
  const exportChart: ReportChart | null =
    rows.length > 1
      ? {
          type: 'bar',
          title: t('col.redeemed'),
          labels: rows.map((r) => (r.group != null ? String(r.group) : t('noGroup'))),
          series: [{ name: t('col.redeemed'), values: rows.map((r) => ratio(r.redeemed, r.total - r.cancelled)) }],
          kind: 'percent',
        }
      : null;

  return (
    <div className="space-y-4">
      <StandaloneExportBar
        reportKey="prepaid-batch-groups"
        reportType="prepaid-vouchers.batch-groups"
        title={`${t('title')} · ${batch.name}`}
        tables={exportTables}
        disabled={rows.length === 0 && eventRows.length === 0}
        kpis={exportKpis}
        chart={exportChart}
        insightKeys={{ label: 'group', value: 'used' }}
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
              {events.data!.map((e) => <EventLine key={e.id} e={e} batch={batch} onOpenBatch={onOpenBatch} />)}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
