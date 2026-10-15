'use client';

/**
 * "יומן" — a cash station's transactions (P:/specs/cash-paylink.md §5, §11.5, §11.9): when, which kiosk, which
 * order / document, what was due, inserted, given as change, owed and held, its state and outcome. Filters by
 * dates, state, outcome and owed; 50 a page. A row opens to its pieces (what went in, what came out), its
 * error, why it was held or cancelled, and its owed item.
 */

import { Fragment, useState } from 'react';
import { useTranslations } from 'next-intl';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronUp } from 'lucide-react';
import { formatDateTime } from '@/lib/format';
import {
  EMPTY_JOURNAL_FILTERS,
  OWED_FILTERS,
  TX_OUTCOMES,
  TX_STATES,
  agorotText,
  journalParams,
  owedChoiceOf,
  pageInfo,
  piecesText,
  splitOf,
  txTone,
  type CashTx,
  type JournalFilters,
} from '@/lib/cashStations';
import { fetchCashJournal } from '@/lib/cashStationsApi';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DatePicker } from '@/components/ui/date-picker';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { NativeSelect, ToneBadge } from './parts';

function errorText(e: CashTx['error']): string | null {
  if (!e) return null;
  if (typeof e === 'string') return e;
  return [e.code, e.message].filter(Boolean).join(' · ') || null;
}

/** The tx's state and outcome as badges ("הושלמה · שולם", "מוחזק"). */
export function TxBadges({ tx }: { tx: Pick<CashTx, 'state' | 'outcome' | 'acked'> }) {
  const t = useTranslations('cashStations');
  const state = t.has(`txState.${tx.state}`) ? t(`txState.${tx.state}`) : tx.state;
  const outcome = tx.outcome ? (t.has(`outcome.${tx.outcome}`) ? t(`outcome.${tx.outcome}`) : tx.outcome) : null;
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <ToneBadge tone={txTone(tx)}>{outcome && tx.state === 'DONE' ? outcome : state}</ToneBadge>
      {tx.state === 'DONE' && !tx.acked ? <ToneBadge tone="warn">{t('journal.notAcked')}</ToneBadge> : null}
    </span>
  );
}

export function JournalTab({ stationId }: { stationId: string }) {
  const t = useTranslations('cashStations.journal');
  const tr = useTranslations('cashStations');
  const [filters, setFilters] = useState<JournalFilters>(EMPTY_JOURNAL_FILTERS);
  const [page, setPage] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const params = journalParams(filters, page);
  const query = useQuery({
    queryKey: ['cash-station-journal', stationId, params],
    queryFn: () => fetchCashJournal(stationId, params),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  const items = query.data?.items ?? [];
  const info = query.data ? pageInfo({ ...query.data, count: items.length }) : null;
  const change = (patch: Partial<JournalFilters>) => {
    setFilters((f) => ({ ...f, ...patch }));
    setPage(0);
  };

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="grid gap-3 pt-4 sm:grid-cols-2 lg:grid-cols-5">
          <div className="space-y-1">
            <Label>{t('from')}</Label>
            <DatePicker value={filters.from} max={filters.to || undefined} onValueChange={(v) => change({ from: v })} />
          </div>
          <div className="space-y-1">
            <Label>{t('to')}</Label>
            <DatePicker value={filters.to} min={filters.from || undefined} onValueChange={(v) => change({ to: v })} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cash-journal-state">{t('state')}</Label>
            <NativeSelect
              id="cash-journal-state"
              value={filters.state}
              onChange={(v) => change({ state: v as JournalFilters['state'] })}
              options={[{ value: '', label: t('all') }, ...TX_STATES.map((s) => ({ value: s, label: tr(`txState.${s}`) }))]}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cash-journal-outcome">{t('outcome')}</Label>
            <NativeSelect
              id="cash-journal-outcome"
              value={filters.outcome}
              onChange={(v) => change({ outcome: v as JournalFilters['outcome'] })}
              options={[{ value: '', label: t('all') }, ...TX_OUTCOMES.map((o) => ({ value: o, label: tr(`outcome.${o}`) }))]}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cash-journal-owed">{t('owed')}</Label>
            <NativeSelect
              id="cash-journal-owed"
              value={filters.owed}
              onChange={(v) => change({ owed: v as JournalFilters['owed'] })}
              options={[{ value: '', label: t('all') }, ...OWED_FILTERS.map((o) => ({ value: o, label: t(`owedFilter.${o}`) }))]}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {query.isLoading ? (
            <div className="p-4">
              <Skeleton className="h-40 w-full" />
            </div>
          ) : query.isError ? (
            <p className="p-4 text-sm text-destructive">{t('loadError')}</p>
          ) : items.length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>{t('col.time')}</TableHead>
                    <TableHead>{t('col.kiosk')}</TableHead>
                    <TableHead>{t('col.order')}</TableHead>
                    <TableHead className="text-end">{t('col.due')}</TableHead>
                    <TableHead className="text-end">{t('col.inserted')}</TableHead>
                    <TableHead className="text-end">{t('col.change')}</TableHead>
                    <TableHead className="text-end">{t('col.owed')}</TableHead>
                    <TableHead className="text-end">{t('col.held')}</TableHead>
                    <TableHead>{t('col.state')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((tx) => {
                    const expanded = open === tx.txId;
                    const err = errorText(tx.error);
                    return (
                      <Fragment key={tx.txId}>
                        <TableRow className="cursor-pointer" onClick={() => setOpen(expanded ? null : tx.txId)}>
                          <TableCell>
                            {expanded ? <ChevronUp className="h-4 w-4" aria-hidden /> : <ChevronDown className="h-4 w-4" aria-hidden />}
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-xs">{formatDateTime(tx.doneAt ?? tx.createdAt)}</TableCell>
                          <TableCell>{tx.clientName ?? '—'}</TableCell>
                          <TableCell className="text-xs">
                            {tx.orderLabel ? t('orderLabel', { label: tx.orderLabel }) : '—'}
                            {tx.documentNumber ? <span className="block text-muted-foreground">{t('document', { n: String(tx.documentNumber) })}</span> : null}
                          </TableCell>
                          <TableCell className="text-end tabular-nums">
                            {agorotText(tx.dueAgorot ?? tx.amountAgorot)}
                            {splitOf(tx) ? <span className="block text-xs text-muted-foreground">{t('split')}</span> : null}
                          </TableCell>
                          <TableCell className="text-end tabular-nums">{agorotText(tx.insertedAgorot)}</TableCell>
                          <TableCell className="text-end tabular-nums">
                            {agorotText(tx.changePaidAgorot)}
                            {tx.changeDueAgorot && tx.changeDueAgorot !== tx.changePaidAgorot ? (
                              <span className="block text-xs text-muted-foreground">{t('ofDue', { due: agorotText(tx.changeDueAgorot) })}</span>
                            ) : null}
                          </TableCell>
                          <TableCell className="text-end tabular-nums">
                            {tx.changeOwedAgorot ? <span className="font-medium text-amber-700 dark:text-amber-400">{agorotText(tx.changeOwedAgorot)}</span> : '—'}
                            {owedChoiceOf(tx) ? <span className="block text-xs text-muted-foreground">{tr(`owedChoice.${owedChoiceOf(tx)}`)}</span> : null}
                          </TableCell>
                          <TableCell className="text-end tabular-nums">
                            {tx.heldAgorot ? <span className="font-medium text-destructive">{agorotText(tx.heldAgorot)}</span> : '—'}
                          </TableCell>
                          <TableCell>
                            <TxBadges tx={tx} />
                          </TableCell>
                        </TableRow>
                        {expanded ? (
                          <TableRow className="bg-muted/30 hover:bg-muted/30">
                            <TableCell />
                            <TableCell colSpan={9} className="whitespace-normal">
                              <dl className="grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
                                <div>
                                  <dt className="inline text-muted-foreground">{t('detail.txId')}: </dt>
                                  <dd className="inline font-mono" dir="ltr">{tx.txId}</dd>
                                </div>
                                <div>
                                  <dt className="inline text-muted-foreground">{t('detail.amount')}: </dt>
                                  <dd className="inline">
                                    {agorotText(tx.amountAgorot)}
                                    {tx.roundingAgorot ? ` (${t('detail.rounding', { n: agorotText(tx.roundingAgorot) })})` : ''}
                                  </dd>
                                </div>
                                <div>
                                  <dt className="inline text-muted-foreground">{t('detail.insertedPieces')}: </dt>
                                  <dd className="inline">{piecesText(tx.inserted) || '—'}</dd>
                                </div>
                                <div>
                                  <dt className="inline text-muted-foreground">{t('detail.paidOutPieces')}: </dt>
                                  <dd className="inline">{piecesText(tx.paidOut) || '—'}</dd>
                                </div>
                                {tx.refundDueAgorot || tx.refundPaidAgorot ? (
                                  <div>
                                    <dt className="inline text-muted-foreground">{t('detail.refund')}: </dt>
                                    <dd className="inline">{t('detail.refundOf', { paid: agorotText(tx.refundPaidAgorot), due: agorotText(tx.refundDueAgorot) })}</dd>
                                  </div>
                                ) : null}
                                {splitOf(tx) ? (
                                  <div>
                                    <dt className="inline text-muted-foreground">{t('split')}: </dt>
                                    <dd className="inline">
                                      {t('detail.split', { cash: agorotText(splitOf(tx)!.cashAgorot), card: agorotText(splitOf(tx)!.cardAgorot) })}
                                    </dd>
                                  </div>
                                ) : null}
                                {owedChoiceOf(tx) ? (
                                  <div>
                                    <dt className="inline text-muted-foreground">{t('detail.owedChoice')}: </dt>
                                    <dd className="inline">{tr(`owedChoice.${owedChoiceOf(tx)}`)}</dd>
                                  </div>
                                ) : null}
                                {tx.heldReason ? (
                                  <div>
                                    <dt className="inline text-muted-foreground">{t('detail.heldReason')}: </dt>
                                    <dd className="inline">{tr.has(`heldReason.${tx.heldReason}`) ? tr(`heldReason.${tx.heldReason}`) : tx.heldReason}</dd>
                                  </div>
                                ) : null}
                                {tx.cancelReason ? (
                                  <div>
                                    <dt className="inline text-muted-foreground">{t('detail.cancelReason')}: </dt>
                                    <dd className="inline">{tr.has(`cancelReason.${tx.cancelReason}`) ? tr(`cancelReason.${tx.cancelReason}`) : tx.cancelReason}</dd>
                                  </div>
                                ) : null}
                                {err ? (
                                  <div>
                                    <dt className="inline text-muted-foreground">{t('detail.error')}: </dt>
                                    <dd className="inline text-destructive">{err}</dd>
                                  </div>
                                ) : null}
                                {tx.slipCode ? (
                                  <div>
                                    <dt className="inline text-muted-foreground">{t('detail.slipCode')}: </dt>
                                    <dd className="inline font-mono" dir="ltr">{tx.slipCode}</dd>
                                  </div>
                                ) : null}
                                {tx.owed ? (
                                  <div className="sm:col-span-2">
                                    <dt className="inline text-muted-foreground">{t('detail.owedItem')}: </dt>
                                    <dd className="inline">
                                      {tr(`owedKind.${tx.owed.kind === 'held_credit' || tx.owed.kind === 'change_credit' ? tx.owed.kind : 'change_owed'}`)} · {agorotText(tx.owed.amountAgorot)} ·{' '}
                                      {tx.owed.status === 'resolved'
                                        ? t('detail.resolved', {
                                            how: tx.owed.resolution && tr.has(`resolution.${tx.owed.resolution}`) ? tr(`resolution.${tx.owed.resolution}`) : tx.owed.resolution ?? '',
                                            by: tx.owed.resolvedBy ?? '—',
                                            at: tx.owed.resolvedAt ? formatDateTime(tx.owed.resolvedAt) : '—',
                                          })
                                        : t('detail.open')}
                                      {tx.owed.note ? ` · ${tx.owed.note}` : ''}
                                    </dd>
                                  </div>
                                ) : null}
                                <div>
                                  <dt className="inline text-muted-foreground">{t('detail.inZ')}: </dt>
                                  <dd className="inline">{tx.zReportId ? t('detail.yes') : t('detail.no')}</dd>
                                </div>
                                {tx.deviceSerial ? (
                                  <div>
                                    <dt className="inline text-muted-foreground">{t('detail.deviceSerial')}: </dt>
                                    <dd className="inline font-mono" dir="ltr">{tx.deviceSerial}</dd>
                                  </div>
                                ) : null}
                              </dl>
                            </TableCell>
                          </TableRow>
                        ) : null}
                      </Fragment>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {info && query.data && query.data.total > 0 ? (
        <div className="flex items-center justify-between gap-2 text-sm">
          <span className="text-muted-foreground">{t('pageLine', { first: info.first, last: info.last, total: query.data.total })}</span>
          <span className="flex gap-1">
            <Button size="sm" variant="outline" disabled={!info.hasPrev || query.isFetching} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              <ChevronRight aria-hidden /> {t('prev')}
            </Button>
            <Button size="sm" variant="outline" disabled={!info.hasNext || query.isFetching} onClick={() => setPage((p) => p + 1)}>
              {t('next')} <ChevronLeft aria-hidden />
            </Button>
          </span>
        </div>
      ) : null}
    </div>
  );
}

