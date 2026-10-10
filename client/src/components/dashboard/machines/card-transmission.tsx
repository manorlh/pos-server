'use client';

/**
 * Card transaction transmission to Shva ("שידור עסקאות"), docs/SHIFTS_API.md §4.
 *
 * The till's card application keeps every card sale until the till transmits the batch.
 * A sale never transmitted is never paid, and the card companies refuse one transmitted
 * more than 7 days after it was taken. Everything here is information the server already
 * resolved — the flags (`transmission_overdue` after 24 h, `transmission_critical` after
 * 4 days) come from the machines list, and are never re-derived here — plus the one action,
 * "transmit now", which travels to the till like a remote shift close does.
 *
 * Two sources are shown side by side on purpose: the till's own count (a last-known
 * reading, "as of") and our records (card sales in no successful batch). They can differ
 * for a while — a document not synced yet, a report not received yet — and neither is
 * presented as live.
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { he } from 'date-fns/locale';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Loader2, RadioTower, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import {
  cancelTransmitRequest,
  fetchMachineTransmission,
  fetchMachineTransmissions,
  fetchTransmitRequest,
  fetchUntransmittedCardSales,
  requestTransmit,
} from '@/lib/api';
import { phaseOfRequest } from '@/lib/deviceCommands';
import { trackCommand } from '@/lib/deviceCommandsStore';
import type { ExcelSheet } from '@/lib/excelExport';
import { fetchAllPages } from '@/lib/fetchAllPages';
import { formatCurrency, formatDateTime } from '@/lib/format';
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';
import type {
  CardTransmission,
  PeriodTransmission,
  PosMachine,
  TransmissionStatus as ReportStatus,
  TransmitRequest,
  TransmitRequestStatus,
} from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useZErrorText } from '@/components/dashboard/z-wizard/z-errors';

const PENDING = new Set<TransmitRequestStatus>(['waiting', 'transmitting']);

function ago(iso: string): string {
  return formatDistanceToNow(new Date(iso), { addSuffix: true, locale: he });
}

/** The HTTP status of a failed request, if it has one. */
function httpStatus(err: unknown): number | undefined {
  return (err as { response?: { status?: number } } | null)?.response?.status;
}

/** How urgent this till's pending transmission is — from the server's flags only. */
export type TransmissionLevel = 'untracked' | 'clear' | 'pending' | 'overdue' | 'critical';

export function transmissionLevel(m: PosMachine): TransmissionLevel {
  const flags = m.statusFlags ?? [];
  if (flags.includes('transmission_critical')) return 'critical';
  if (flags.includes('transmission_overdue')) return 'overdue';
  if (!m.transmissionTrackingStartedAt) return 'untracked';
  const pending = (m.pendingTransmissionCount ?? 0) > 0 || (m.untransmittedCardLegs ?? 0) > 0;
  return pending ? 'pending' : 'clear';
}

const LEVEL_TEXT: Record<TransmissionLevel, string> = {
  untracked: 'text-muted-foreground',
  clear: 'text-emerald-700 dark:text-emerald-400',
  pending: 'text-foreground',
  overdue: 'text-amber-700 dark:text-amber-400',
  critical: 'text-destructive',
};

/** Whether this till can be asked to transmit from the cloud. */
export function canTransmitRemotely(m: PosMachine): boolean {
  return m.isActive !== false && m.pairingStatus === 'assigned' && !!m.shopId;
}

/**
 * The till's transmission state: what waits, since when, the last successful batch and
 * the last error. Coloured by the server's flags.
 */
export function TransmissionSummary({ m, compact = false }: { m: PosMachine; compact?: boolean }) {
  const t = useTranslations('transmission');
  const level = transmissionLevel(m);
  const count = m.pendingTransmissionCount;
  const ours = m.untransmittedCardLegs ?? 0;

  if (level === 'untracked') {
    return <p className="text-xs text-muted-foreground">{t('untracked')}</p>;
  }

  return (
    <div className="space-y-0.5 text-xs">
      <p className={`font-medium ${LEVEL_TEXT[level]}`}>
        {(count ?? 0) > 0
          ? t('pendingSummary', {
              count: count ?? 0,
              amount: formatCurrency(m.pendingTransmissionAmount),
            })
          : t('nothingPending')}
      </p>
      {m.oldestPendingTransmissionAt && level !== 'clear' ? (
        <p className={LEVEL_TEXT[level]}>
          {t('oldestPending', { ago: ago(m.oldestPendingTransmissionAt) })}
        </p>
      ) : null}
      {!compact && ours > 0 && ours !== count ? (
        <p className="text-muted-foreground">
          {t('oursSummary', { count: ours, amount: formatCurrency(m.untransmittedCardAmount) })}
        </p>
      ) : null}
      <p className="text-muted-foreground">
        {m.lastTransmissionAt
          ? t('lastTransmission', { ago: ago(m.lastTransmissionAt) })
          : t('neverTransmitted')}
      </p>
      {/* The till counts these as transmitted, but the terminal never named them: said
          plainly, in grey — information, not an alarm. */}
      {(m.assumedTransmissionCount ?? 0) > 0 ? (
        <p className="text-muted-foreground">
          {t('assumed', { count: m.assumedTransmissionCount ?? 0 })}
        </p>
      ) : null}
      {m.lastTransmissionError ? (
        <p className="text-destructive">{t('lastError', { error: m.lastTransmissionError })}</p>
      ) : null}
      {!compact && m.transmissionReportedAt ? (
        <p className="text-muted-foreground">
          {t('reportedAsOf', { when: ago(m.transmissionReportedAt) })}
        </p>
      ) : null}
      {m.transmitPending ? <p className="text-primary">{t('requestPending')}</p> : null}
    </div>
  );
}

function requestVariant(s: TransmitRequestStatus): 'default' | 'secondary' | 'destructive' | 'outline' {
  if (s === 'completed') return 'default';
  if (s === 'failed' || s === 'expired') return 'destructive';
  if (s === 'cancelled') return 'outline';
  return 'secondary';
}

function reportVariant(s: ReportStatus): 'default' | 'destructive' | 'secondary' {
  if (s === 'success') return 'default';
  if (s === 'failed') return 'destructive';
  return 'secondary';
}

/** Follow a transmit request in "פקודות שנשלחו" (the tray reads `GET /transmit-requests/{id}`). */
function trackTransmit(r: TransmitRequest, machineName: string | null): void {
  const p = phaseOfRequest(r.status, r.errorMessage);
  trackCommand({
    kind: 'transmit',
    id: r.id,
    action: 'transmit',
    machineId: r.machineId,
    machineName,
    phase: p.phase,
    detail: p.detail,
  });
}

/**
 * "שדר עסקאות עכשיו": asks the till and closes — the request is followed in the background
 * ("פקודות שנשלחו"). Opened for a till whose transmit already waits, it shows that request's
 * progress and its cancel.
 */
export function TransmitNowDialog({
  machine,
  open,
  onOpenChange,
}: {
  machine: PosMachine | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('transmission.now');
  const tr = useTranslations('transmission');
  const tc = useTranslations('common');
  const errors = useZErrorText();
  const qc = useQueryClient();
  const [requestId, setRequestId] = useState<string | null>(null);

  // A fresh dialog for each opening (asking again returns the pending request).
  const [wasOpen, setWasOpen] = useState(open);
  if (wasOpen !== open) {
    setWasOpen(open);
    if (open) setRequestId(null);
  }
  const handleOpenChange = (next: boolean) => {
    if (!next) setRequestId(null);
    onOpenChange(next);
  };

  const {
    data: request,
    isError: pollFailed,
    error: pollError,
    refetch,
  } = useQuery<TransmitRequest>({
    queryKey: ['transmit-request', requestId],
    queryFn: () => fetchTransmitRequest(requestId!),
    enabled: open && !!requestId,
    refetchInterval: (q) => {
      const code = httpStatus(q.state.error);
      if (code === 403 || code === 404) return false;
      return q.state.data && !PENDING.has(q.state.data.status) ? false : 2000;
    },
  });

  const refreshLists = (machineId: string) => {
    for (const key of ['machines', 'transmissions', 'untransmitted']) {
      qc.invalidateQueries({ queryKey: [key] });
    }
    qc.invalidateQueries({ queryKey: ['machine', machineId] });
  };

  const settle = (next: TransmitRequest) => {
    qc.setQueryData(['transmit-request', next.id], next);
    setRequestId(next.id);
  };

  // A transmit already waits for this till: reopening (and asking again) shows its progress.
  const reopenedPending = !!machine?.transmitPending;
  const create = useMutation({
    mutationFn: () => requestTransmit(machine!.id),
    onSuccess: (next) => {
      refreshLists(next.machineId);
      // "פקודות שנשלחו" (lib/deviceCommandsStore.ts): followed in the background (its popup,
      // the tray, the till's chip) — the dialog closes, nothing waits for the till.
      trackTransmit(next, machine?.name ?? null);
      if (reopenedPending) {
        settle(next);
        return;
      }
      handleOpenChange(false);
    },
    onError: (e) => toast.error(errors.forError(e)),
  });
  const cancel = useMutation({
    mutationFn: () => cancelTransmitRequest(requestId!),
    onSuccess: (next) => {
      settle(next);
      refreshLists(next.machineId);
      trackTransmit(next, machine?.name ?? null);
    },
    onError: (e) => {
      toast.error(errors.forError(e));
      void refetch();
    },
  });

  // Once it has ended, the lists that showed it pending (and the batch history) are stale.
  const endedFor = request && !PENDING.has(request.status) ? request.machineId : null;
  useEffect(() => {
    if (!endedFor) return;
    for (const key of ['machines', 'transmissions', 'untransmitted']) {
      qc.invalidateQueries({ queryKey: [key] });
    }
    qc.invalidateQueries({ queryKey: ['machine', endedFor] });
  }, [endedFor, qc]);

  if (!machine) return null;

  const busy = create.isPending || cancel.isPending;
  const why = request ? errors.forItem(request.errorCode, request.errorMessage) : null;
  const batch = request?.transmission ?? null;
  const failed = request?.status === 'failed' || request?.status === 'expired';

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <p className="text-sm text-muted-foreground">{machine.name}</p>
        </DialogHeader>

        {!request ? (
          <div className="space-y-2 text-sm">
            <p>{t('confirm')}</p>
            <TransmissionSummary m={machine} compact />
            {machine.online === false ? (
              <p className="text-amber-700 dark:text-amber-400">{t('confirmOffline')}</p>
            ) : null}
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            {pollFailed ? (
              <p className="text-xs text-destructive">
                {t('pollFailed', { error: errors.forError(pollError) })}
              </p>
            ) : null}
            <div className="flex items-center justify-between gap-2">
              <span className="font-medium">{t('requestLabel')}</span>
              <Badge variant={requestVariant(request.status)}>
                {PENDING.has(request.status) ? <Loader2 className="animate-spin" aria-hidden /> : null}
                {t(`status.${request.status}`)}
              </Badge>
            </div>
            <p className={`flex items-start gap-1 text-xs ${failed ? 'text-destructive' : 'text-muted-foreground'}`}>
              {failed ? <XCircle className="h-3.5 w-3.5 shrink-0" aria-hidden /> : null}
              {t(`hint.${request.status}`)}
            </p>
            {why && request.status !== 'completed' ? (
              <p className={`text-xs ${failed ? 'text-destructive' : 'text-muted-foreground'}`}>{why}</p>
            ) : null}
            {PENDING.has(request.status) && request.online === false ? (
              <p className="text-xs text-amber-700 dark:text-amber-400">{t('confirmOffline')}</p>
            ) : null}
            {batch ? (
              <div className="flex gap-2 rounded-md border border-emerald-300 bg-emerald-50 p-3 dark:border-emerald-800 dark:bg-emerald-950">
                <CheckCircle2 className="h-5 w-5 shrink-0 text-emerald-600" aria-hidden />
                <div className="min-w-0 space-y-0.5 text-xs">
                  <p>
                    {tr('col.batch')}:{' '}
                    <span className="font-medium tabular-nums" dir="ltr">
                      {batch.batchNumber ?? '—'}
                    </span>
                  </p>
                  <p>
                    {tr('col.count')}:{' '}
                    <span className="tabular-nums">{batch.transactionCount ?? '—'}</span>
                    {' · '}
                    {tr('col.amount')}:{' '}
                    <span className="tabular-nums">{formatCurrency(batch.amount)}</span>
                  </p>
                </div>
              </div>
            ) : null}
          </div>
        )}

        <DialogFooter>
          {!request ? (
            <>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                {tc('cancel')}
              </Button>
              <Button disabled={busy} onClick={() => create.mutate()}>
                {create.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
                {t('submit')}
              </Button>
            </>
          ) : (
            <>
              {PENDING.has(request.status) ? (
                <Button variant="outline" disabled={busy} onClick={() => cancel.mutate()}>
                  {t('cancelRequest')}
                </Button>
              ) : null}
              <Button variant="secondary" onClick={() => handleOpenChange(false)}>
                {t('close')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The button that opens the dialog; for the machine page. */
export function TransmitNowButton({ m }: { m: PosMachine }) {
  const t = useTranslations('transmission.now');
  const [open, setOpen] = useState(false);
  if (!canTransmitRemotely(m)) return null;
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <RadioTower className="h-4 w-4 ms-1" aria-hidden />
        {t('button')}
      </Button>
      <TransmitNowDialog key={m.id} machine={m} open={open} onOpenChange={setOpen} />
    </>
  );
}

/** What the terminal printed for one batch, fetched when asked for. */
function ReportDialog({
  machineId,
  row,
  onClose,
}: {
  machineId: string;
  row: CardTransmission | null;
  onClose: () => void;
}) {
  const t = useTranslations('transmission');
  const detail = useQuery({
    queryKey: ['transmission', machineId, row?.id],
    queryFn: () => fetchMachineTransmission(machineId, row!.id),
    enabled: !!row,
  });
  return (
    <Dialog open={!!row} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('reportTitle', { batch: row?.batchNumber ?? '—' })}</DialogTitle>
        </DialogHeader>
        {detail.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <div className="space-y-2 text-xs">
            {detail.data?.error ? <p className="text-destructive">{detail.data.error}</p> : null}
            {detail.data?.statusMessage ? (
              <p className="text-muted-foreground">
                {t('statusMessage', {
                  code: detail.data.statusCode ?? '—',
                  message: detail.data.statusMessage,
                })}
              </p>
            ) : null}
            <pre
              className="max-h-80 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 font-mono text-[11px]"
              dir="auto"
            >
              {detail.data?.reportText || t('noReportText')}
            </pre>
            <p className="text-muted-foreground">
              {t('terminalIds', { count: detail.data?.terminalTransactionIds?.length ?? 0 })}
            </p>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Every batch the till reported, newest first. */
export function TransmissionHistory({ machineId }: { machineId: string }) {
  const t = useTranslations('transmission');
  const [shown, setShown] = useState<CardTransmission | null>(null);
  const list = useQuery({
    queryKey: ['transmissions', machineId],
    queryFn: () => fetchMachineTransmissions(machineId, { limit: 50 }),
  });
  const rows = list.data?.items ?? [];

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('col.startedAt')}</TableHead>
            <TableHead>{t('col.trigger')}</TableHead>
            <TableHead>{t('col.status')}</TableHead>
            <TableHead>{t('col.batch')}</TableHead>
            <TableHead className="text-end">{t('col.count')}</TableHead>
            <TableHead className="text-end">{t('col.amount')}</TableHead>
            <TableHead className="text-end">{t('col.matched')}</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.isLoading ? (
            <TableRow>
              <TableCell colSpan={8}>
                <Skeleton className="h-6 w-full" />
              </TableCell>
            </TableRow>
          ) : list.isError ? (
            <TableRow>
              <TableCell colSpan={8} className="py-6 text-center text-destructive">
                {t('loadFailed')}
              </TableCell>
            </TableRow>
          ) : rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={8} className="py-6 text-center text-muted-foreground">
                {t('noHistory')}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="text-xs">{formatDateTime(r.startedAt)}</TableCell>
                <TableCell className="text-xs">{t(`trigger.${r.trigger}`)}</TableCell>
                <TableCell>
                  <Badge variant={reportVariant(r.status)}>{t(`reportStatus.${r.status}`)}</Badge>
                  {r.status !== 'success' && (r.error || r.statusMessage) ? (
                    <p className="mt-0.5 max-w-48 truncate text-[11px] text-destructive" title={r.error ?? r.statusMessage ?? ''}>
                      {r.error ?? r.statusMessage}
                    </p>
                  ) : null}
                </TableCell>
                <TableCell className="text-xs tabular-nums" dir="ltr">
                  {r.batchNumber ?? '—'}
                </TableCell>
                <TableCell className="text-end tabular-nums">{r.transactionCount ?? '—'}</TableCell>
                <TableCell className="text-end tabular-nums">{formatCurrency(r.amount)}</TableCell>
                <TableCell className="text-end text-xs tabular-nums text-muted-foreground">
                  {t('matchedOf', { matched: r.legsMatched, total: r.terminalTransactionCount })}
                </TableCell>
                <TableCell className="text-end">
                  <Button size="sm" variant="ghost" onClick={() => setShown(r)}>
                    {t('showReport')}
                  </Button>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      <ReportDialog machineId={machineId} row={shown} onClose={() => setShown(null)} />
    </>
  );
}

/**
 * Card sales in no successful batch, from our records — what a shop takes to the card
 * company when a terminal dies with its batch. Exported to Excel with the last four digits
 * only (the server never holds more), beside every transmission the till reported.
 */
export function UntransmittedSales({ m }: { m: PosMachine }) {
  const t = useTranslations('transmission.untransmitted');
  const tr = useTranslations('transmission');
  const tc = useTranslations('common');
  const list = useQuery({
    queryKey: ['untransmitted', m.id],
    queryFn: () => fetchUntransmittedCardSales(m.id),
  });
  const data = list.data;
  const items = data?.items ?? [];

  // The untransmitted list (all of it — the endpoint is not paged) and the whole batch
  // history, page after page at the endpoint's largest limit (the screen shows the last 50).
  const getSheets = async (): Promise<ExcelSheet[]> => {
    const history = await fetchAllPages(
      (page, pageSize) => fetchMachineTransmissions(m.id, { limit: pageSize, offset: (page - 1) * pageSize }),
      { pageSize: 200 },
    );
    return [
      {
        name: tr('untransmittedTitle'),
        columns: [
          { header: t('col.date'), kind: 'datetime' },
          { header: t('col.document'), width: 16 },
          { header: t('col.amount'), kind: 'money' },
          { header: t('col.approval'), width: 14 },
          { header: t('col.terminalId'), width: 20 },
          { header: t('col.card'), width: 10 },
          { header: t('col.payments'), kind: 'number' },
        ],
        rows: items.map((i) => [
          i.createdAt,
          i.documentNumber ?? i.transactionNumber,
          i.amount,
          i.approvalNumber ?? null,
          i.terminalTransactionId ?? null,
          i.cardLast4 ? `****${i.cardLast4}` : null,
          i.creditPayments ?? null,
        ]),
        totals: [tc('total'), String(data?.count ?? items.length), data?.amount ?? null, null, null, null, null],
      },
      {
        name: tr('historyTitle'),
        columns: [
          { header: tr('col.startedAt'), kind: 'datetime' },
          { header: tr('export.finishedAt'), kind: 'datetime' },
          { header: tr('col.trigger'), width: 12 },
          { header: tr('col.status'), width: 10 },
          { header: tr('export.message'), width: 28 },
          { header: tr('col.batch'), width: 12 },
          { header: tr('col.count'), kind: 'number' },
          { header: tr('col.amount'), kind: 'money' },
          { header: tr('col.matched'), kind: 'number' },
          { header: tr('export.terminalCount'), kind: 'number' },
        ],
        rows: history.map((r) => [
          r.startedAt,
          r.finishedAt ?? null,
          tr(`trigger.${r.trigger}`),
          tr(`reportStatus.${r.status}`),
          r.error ?? r.statusMessage ?? null,
          r.batchNumber ?? null,
          r.transactionCount ?? null,
          r.amount ?? null,
          r.legsMatched,
          r.terminalTransactionCount,
        ]),
      },
    ];
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-1 text-xs text-muted-foreground">
        <span>
          {data?.trackingStartedAt
            ? t('summary', { count: data.count, amount: formatCurrency(data.amount) })
            : t('untracked')}
        </span>
        <ReportExportToolbar
          title={tr('title')}
          scopeLabel={m.name}
          disabled={!data}
          getSheets={getSheets}
        />
      </div>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('col.date')}</TableHead>
            <TableHead>{t('col.document')}</TableHead>
            <TableHead className="text-end">{t('col.amount')}</TableHead>
            <TableHead>{t('col.approval')}</TableHead>
            <TableHead>{t('col.terminalId')}</TableHead>
            <TableHead>{t('col.card')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.isLoading ? (
            <TableRow>
              <TableCell colSpan={6}>
                <Skeleton className="h-6 w-full" />
              </TableCell>
            </TableRow>
          ) : list.isError ? (
            <TableRow>
              <TableCell colSpan={6} className="py-6 text-center text-destructive">
                {t('loadFailed')}
              </TableCell>
            </TableRow>
          ) : items.length === 0 ? (
            <TableRow>
              <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                {t('empty')}
              </TableCell>
            </TableRow>
          ) : (
            items.map((i) => (
              <TableRow key={i.legId}>
                <TableCell className="text-xs">{formatDateTime(i.createdAt)}</TableCell>
                <TableCell className="text-xs tabular-nums">{i.documentNumber ?? i.transactionNumber}</TableCell>
                <TableCell className="text-end tabular-nums">{formatCurrency(i.amount)}</TableCell>
                <TableCell className="text-xs tabular-nums" dir="ltr">
                  {i.approvalNumber ?? '—'}
                </TableCell>
                <TableCell className="text-xs tabular-nums" dir="ltr">
                  {i.terminalTransactionId ?? '—'}
                </TableCell>
                <TableCell className="text-xs tabular-nums" dir="ltr">
                  {i.cardLast4 ? `•••• ${i.cardLast4}` : '—'}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

/**
 * The X's card transmission, for information only: a shift closes and a Z is built
 * whatever is still waiting for Shva.
 */
export function PeriodTransmissionSummary({ block }: { block: PeriodTransmission }) {
  const t = useTranslations('transmission.period');
  const tr = useTranslations('transmission');
  if (block.cardLegs === 0 && block.batches.length === 0) {
    return <p className="text-xs text-muted-foreground">{t('noCardSales')}</p>;
  }
  return (
    <div className="space-y-2 text-xs">
      <p>
        {t('legs', { total: block.cardLegs, transmitted: block.transmittedLegs })}
      </p>
      {block.untransmittedLegs > 0 ? (
        <p className="text-amber-700 dark:text-amber-400">
          {t('untransmitted', {
            count: block.untransmittedLegs,
            amount: formatCurrency(block.untransmittedAmount),
          })}
        </p>
      ) : null}
      {block.untrackedLegs > 0 ? (
        <p className="text-muted-foreground">{t('untracked', { count: block.untrackedLegs })}</p>
      ) : null}
      {block.batches.length > 0 ? (
        <ul className="space-y-0.5">
          {block.batches.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-2">
              <Badge variant={reportVariant(b.status)}>{tr(`reportStatus.${b.status}`)}</Badge>
              <span className="tabular-nums" dir="ltr">
                {b.batchNumber ?? '—'}
              </span>
              <span className="text-muted-foreground">
                {b.startedAt ? formatDateTime(b.startedAt) : ''} · {tr(`trigger.${b.trigger}`)}
              </span>
              <span className="tabular-nums">{formatCurrency(b.amount)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground">{t('noBatches')}</p>
      )}
      <p className="text-muted-foreground">{t('informational')}</p>
    </div>
  );
}

/** The X's (or a Z section's) batches as an Excel sheet, its leg counts as the heading. */
export function usePeriodTransmissionSheet() {
  const t = useTranslations('transmission.period');
  const tr = useTranslations('transmission');
  return (block: PeriodTransmission): ExcelSheet => ({
    name: tr('title'),
    heading: [
      block.cardLegs === 0 && block.batches.length === 0
        ? t('noCardSales')
        : t('legs', { total: block.cardLegs, transmitted: block.transmittedLegs }),
      block.untransmittedLegs > 0
        ? t('untransmitted', { count: block.untransmittedLegs, amount: formatCurrency(block.untransmittedAmount) })
        : '',
      block.untrackedLegs > 0 ? t('untracked', { count: block.untrackedLegs }) : '',
    ].filter(Boolean),
    columns: [
      { header: tr('col.startedAt'), kind: 'datetime' },
      { header: tr('export.finishedAt'), kind: 'datetime' },
      { header: tr('col.trigger'), width: 12 },
      { header: tr('col.status'), width: 10 },
      { header: tr('col.batch'), width: 12 },
      { header: tr('col.count'), kind: 'number' },
      { header: tr('col.amount'), kind: 'money' },
      { header: tr('export.legsInPeriod'), kind: 'number' },
    ],
    rows: block.batches.map((b) => [
      b.startedAt ?? null,
      b.finishedAt ?? null,
      tr(`trigger.${b.trigger}`),
      tr(`reportStatus.${b.status}`),
      b.batchNumber ?? null,
      b.transactionCount ?? null,
      b.amount ?? null,
      b.legsInPeriod,
    ]),
  });
}
