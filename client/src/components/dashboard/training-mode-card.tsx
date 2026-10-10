'use client';

/**
 * "מצב הדרכה" on a shop (docs/SPEC_TRAINING_MODE.md). While it is on, the shop's tills
 * sell for practice: no accounting document, no card charge, a separate "ה-" numbering,
 * and what they send lands in a quarantine table that no real report reads. This card
 * shows where the shop stands (on or off, since when and by whom, what sits in
 * quarantine), turns the mode on, opens the "מעבר לעבודה אמיתית" wizard that turns it
 * off, and holds the training report — the practice sales summed, to see they arrive.
 *
 * Turning it on is disabled, with a note, while the server says it is not `available`: no
 * device implements it yet, so a practice sale would be a real tax document (PARITY.md gap 6).
 *
 * Everyone who sees the shop sees the card; the buttons are for `canManage` (super admin,
 * dealer, or a manager who manages the shop — pos-server app/routers/training_mode.py).
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, GraduationCap } from 'lucide-react';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  enableTrainingMode,
  fetchTrainingMode,
  fetchTrainingReport,
  type TrainingModeStatus,
  type TrainingTillRef,
} from '@/lib/trainingModeApi';
import { apiErrorInfo, hasQuarantinedData, trainingCanBeEnabled } from '@/lib/trainingMode';
import { formatCurrency, formatDateTime, formatQuantity } from '@/lib/format';
import { usePaymentMethodLabel } from '@/components/dashboard/shifts/shift-parts';
import { TrainingModeDisableWizard } from '@/components/dashboard/training-mode-disable-wizard';
import { useTrainingTillLabel } from '@/components/dashboard/training-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

const COUNT_KEYS = ['transaction', 'shift', 'z', 'x', 'other'] as const;

export function TrainingModeCard({ shopId, shopName }: { shopId: string; shopName: string }) {
  const t = useTranslations('trainingMode.card');
  const query = useQuery({ queryKey: ['training-mode', shopId], queryFn: () => fetchTrainingMode(shopId) });
  const data = query.data;
  const on = data?.trainingMode === true;

  return (
    <Card className={on ? 'ring-orange-400 dark:ring-orange-700' : undefined}>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <GraduationCap className="h-4 w-4" aria-hidden />
          {t('title')}
          {data ? (
            on ? (
              <Badge className="bg-orange-500 text-white">{t('on')}</Badge>
            ) : (
              <Badge variant="outline">{t('off')}</Badge>
            )
          ) : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">{t('desc')}</p>
        {query.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : query.isError || !data ? (
          <p className="text-sm text-destructive">{t('loadError')}</p>
        ) : (
          <TrainingModeBody shopId={shopId} shopName={data.shopName || shopName} data={data} />
        )}
      </CardContent>
    </Card>
  );
}

function TrainingModeBody({ shopId, shopName, data }: { shopId: string; shopName: string; data: TrainingModeStatus }) {
  const t = useTranslations('trainingMode.card');
  const [enableOpen, setEnableOpen] = useState(false);
  const [wizardOpen, setWizardOpen] = useState(false);
  const on = data.trainingMode;
  const quarantined = hasQuarantinedData(data.counts);
  // Not implemented on any device yet: a practice sale would be a real document (server 409).
  const available = trainingCanBeEnabled(data);

  const statusLine = on
    ? data.startedAt
      ? data.startedBy?.name
        ? t('sinceBy', { at: formatDateTime(data.startedAt), name: data.startedBy.name })
        : t('since', { at: formatDateTime(data.startedAt) })
      : t('onNoDate')
    : data.endedAt
      ? data.endedBy?.name
        ? t('endedBy', { at: formatDateTime(data.endedAt), name: data.endedBy.name })
        : t('endedAt', { at: formatDateTime(data.endedAt) })
      : available
        ? t('neverEnabled')
        : t('neverEnabledUnavailable');

  return (
    <>
      <p className={on ? 'text-sm font-medium text-orange-700 dark:text-orange-300' : 'text-sm'}>{statusLine}</p>

      {on || quarantined ? (
        <div className="space-y-1">
          <p className="text-xs font-medium text-muted-foreground">{t('quarantine')}</p>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
            {COUNT_KEYS.map((k) => (
              <div key={k} className="rounded-md border bg-muted/30 px-2 py-1.5">
                <p className="text-lg font-semibold tabular-nums">{formatQuantity(data.counts?.[k] ?? 0)}</p>
                <p className="text-xs text-muted-foreground">{t(`counts.${k}`)}</p>
              </div>
            ))}
          </div>
          {!on && quarantined ? <p className="text-xs text-amber-700 dark:text-amber-400">{t('leftover')}</p> : null}
        </div>
      ) : null}

      {data.canManage ? (
        <div className="flex flex-wrap justify-end gap-2">
          {on ? (
            <Button size="sm" onClick={() => setWizardOpen(true)}>
              {t('disable')}
            </Button>
          ) : (
            <Button size="sm" variant="outline" disabled={!available} onClick={() => setEnableOpen(true)}>
              <GraduationCap className="h-3.5 w-3.5" aria-hidden />
              {t('enable')}
            </Button>
          )}
        </div>
      ) : (
        <p className="text-xs text-amber-700 dark:text-amber-400">{t('readOnly')}</p>
      )}
      {!on && !available ? <p className="text-xs text-amber-700 dark:text-amber-400">{t('notAvailable')}</p> : null}

      {on || quarantined ? <TrainingReportSection shopId={shopId} /> : null}

      {data.log?.length ? <TrainingLog data={data} /> : null}

      <Dialog open={enableOpen} onOpenChange={setEnableOpen}>
        <DialogContent className="max-w-md">
          {enableOpen ? (
            <EnableDialogBody shopId={shopId} shopName={shopName} onClose={() => setEnableOpen(false)} />
          ) : null}
        </DialogContent>
      </Dialog>
      <TrainingModeDisableWizard
        shopId={shopId}
        shopName={shopName}
        open={wizardOpen}
        onOpenChange={setWizardOpen}
      />
    </>
  );
}

function EnableDialogBody({ shopId, shopName, onClose }: { shopId: string; shopName: string; onClose: () => void }) {
  const t = useTranslations('trainingMode.enableDialog');
  const tc = useTranslations('common');
  const tillLabel = useTrainingTillLabel();
  const qc = useQueryClient();
  // Tills with a real shift open — the server refuses until they close it.
  const [blockedBy, setBlockedBy] = useState<TrainingTillRef[] | null>(null);

  const enable = useMutation({
    mutationFn: () => enableTrainingMode(shopId),
    onSuccess: (out) => {
      qc.setQueryData(['training-mode', shopId], out);
      void qc.invalidateQueries({ queryKey: ['shops'] });
      void qc.invalidateQueries({ queryKey: ['training-report', shopId] });
      void qc.invalidateQueries({ queryKey: ['training-disable-preview', shopId] });
      toast.success(t('enabled'));
      onClose();
    },
    onError: (err: unknown) => {
      const { status, code, detail } = apiErrorInfo(err);
      if (code === 'real_shift_open') {
        setBlockedBy(Array.isArray(detail?.tills) ? (detail.tills as TrainingTillRef[]) : []);
        return;
      }
      if (code === 'training_not_available') {
        void qc.invalidateQueries({ queryKey: ['training-mode', shopId] });
        toast.error(t('notAvailable'));
        onClose();
        return;
      }
      toast.error(status === 403 ? t('forbidden') : axiosErrorToToastMessage(err, tc('error')));
    },
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('title')}</DialogTitle>
      </DialogHeader>
      <div className="space-y-2 text-sm">
        <p>{t('body', { shop: shopName })}</p>
        <p className="text-muted-foreground">{t('bodyKeep')}</p>
        {blockedBy ? (
          <div className="space-y-1 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-destructive">
            <p>{t('realShiftOpen')}</p>
            {blockedBy.length > 0 ? (
              <ul className="list-inside list-disc">
                {blockedBy.map((till) => (
                  <li key={till.machineId}>{tillLabel(till)}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose} disabled={enable.isPending}>
          {tc('cancel')}
        </Button>
        <Button className="bg-orange-500 text-white hover:bg-orange-600" onClick={() => enable.mutate()} disabled={enable.isPending}>
          {enable.isPending ? t('working') : blockedBy ? t('retry') : t('confirm')}
        </Button>
      </DialogFooter>
    </>
  );
}

/** "דוח הדרכה": the quarantined sales summed by till, item and tender — folded until opened. */
function TrainingReportSection({ shopId }: { shopId: string }) {
  const t = useTranslations('trainingMode.report');
  const tc = useTranslations('common');
  const tillLabel = useTrainingTillLabel();
  const methodLabel = usePaymentMethodLabel();
  const [open, setOpen] = useState(false);
  const report = useQuery({
    queryKey: ['training-report', shopId],
    queryFn: () => fetchTrainingReport(shopId),
    enabled: open,
  });
  const r = report.data;

  return (
    <div className="rounded-md border">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-sm font-medium hover:bg-muted/50"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{t('title')}</span>
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      {open ? (
        <div className="space-y-4 border-t p-3">
          <p className="text-xs text-muted-foreground">{t('desc')}</p>
          {report.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : report.isError || !r ? (
            <p className="text-sm text-destructive">{axiosErrorToToastMessage(report.error, t('loadError'))}</p>
          ) : r.count === 0 && r.shifts === 0 && r.zReports === 0 ? (
            <p className="text-sm text-muted-foreground">{t('empty')}</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                <Stat label={t('count')} value={formatQuantity(r.count)} />
                <Stat label={t('total')} value={formatCurrency(r.total)} />
                <Stat
                  label={t('refunds')}
                  value={r.refunds?.count ? t('refundsValue', { count: r.refunds.count, total: formatCurrency(r.refunds.total) }) : '0'}
                />
                <Stat label={t('shiftsAndZ')} value={t('shiftsAndZValue', { shifts: r.shifts, z: r.zReports })} />
              </div>
              {r.firstAt ? (
                <p className="text-xs text-muted-foreground">
                  {t('range', { from: formatDateTime(r.firstAt), to: formatDateTime(r.lastAt ?? r.firstAt) })}
                </p>
              ) : null}

              <ReportTable
                title={t('byTill')}
                head={[t('col.till'), t('col.count'), t('col.total')]}
                rows={r.byTill.map((row) => ({
                  key: row.machineId,
                  cells: [tillLabel(row), formatQuantity(row.count), formatCurrency(row.total)],
                }))}
                empty={tc('noResults')}
              />
              <ReportTable
                title={t('topItems')}
                head={[t('col.item'), t('col.quantity'), t('col.total')]}
                rows={r.topItems.map((row, i) => ({
                  key: `${row.name}-${i}`,
                  cells: [row.name, formatQuantity(row.quantity), formatCurrency(row.total)],
                }))}
                empty={tc('noResults')}
              />
              <ReportTable
                title={t('byPayment')}
                head={[t('col.method'), t('col.count'), t('col.amount')]}
                rows={r.byPayment.map((row) => ({
                  key: row.method,
                  cells: [methodLabel(row.method), formatQuantity(row.count), formatCurrency(row.amount)],
                }))}
                empty={tc('noResults')}
              />
            </>
          )}
        </div>
      ) : null}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-muted/30 px-2 py-1.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function ReportTable({
  title,
  head,
  rows,
  empty,
}: {
  title: string;
  head: [string, string, string];
  rows: { key: string; cells: [string, string, string] }[];
  empty: string;
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{title}</p>
      <div className="overflow-hidden rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{head[0]}</TableHead>
              <TableHead className="text-end">{head[1]}</TableHead>
              <TableHead className="text-end">{head[2]}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={3} className="py-3 text-center text-xs text-muted-foreground">
                  {empty}
                </TableCell>
              </TableRow>
            ) : (
              rows.map((row) => (
                <TableRow key={row.key}>
                  <TableCell>{row.cells[0]}</TableCell>
                  <TableCell className="text-end tabular-nums">{row.cells[1]}</TableCell>
                  <TableCell className="text-end tabular-nums">{row.cells[2]}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

/** The shop's training log: on, off (and what was deleted), and late documents dropped. */
function TrainingLog({ data }: { data: TrainingModeStatus }) {
  const t = useTranslations('trainingMode.card');
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-sm font-medium hover:bg-muted/50"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span>{t('log', { count: data.log.length })}</span>
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
      </button>
      {open ? (
        <ul className="space-y-1.5 border-t p-3 text-xs">
          {data.log.map((entry) => (
            <li key={entry.id} className="flex flex-wrap gap-x-2">
              <span className="tabular-nums text-muted-foreground">{formatDateTime(entry.at)}</span>
              <span className="font-medium">
                {t.has(`logAction.${entry.action}`) ? t(`logAction.${entry.action}`) : entry.action}
              </span>
              {entry.userName ? <span className="text-muted-foreground">{t('logBy', { name: entry.userName })}</span> : null}
              {entry.machineName ? (
                <span className="text-muted-foreground">{t('logTill', { name: entry.machineName })}</span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
