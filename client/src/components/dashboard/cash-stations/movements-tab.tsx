'use client';

/**
 * "תנועות" — the station drawer's movements (P:/specs/cash-paylink.md §5, §11.9): opening float, refills,
 * collections (the cashbox emptied), counts against the expected, internal dumps (a change unit into the
 * cashbox — never in the drawer's total) and adjustments; who did each, its pieces and its note.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { formatDateTime } from '@/lib/format';
import {
  JOURNAL_PAGE,
  MOVEMENT_KINDS,
  agorotText,
  pageInfo,
  piecesText,
  rangeParams,
  signedAgorotText,
  type MovementKind,
  type Tone,
} from '@/lib/cashStations';
import { fetchCashMovements } from '@/lib/cashStationsApi';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DatePicker } from '@/components/ui/date-picker';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { NativeSelect, ToneBadge } from './parts';

const KIND_TONE: Record<string, Tone> = { float: 'info', refill: 'info', collect: 'warn', count: 'ok', dump: 'muted', adjust: 'muted' };

export function MovementsTab({ stationId }: { stationId: string }) {
  const t = useTranslations('cashStations.movements');
  const tr = useTranslations('cashStations');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [kind, setKind] = useState<MovementKind | ''>('');
  const [page, setPage] = useState(0);
  const params: Record<string, string | number> = {
    ...rangeParams(from, to),
    ...(kind ? { kind } : {}),
    limit: JOURNAL_PAGE,
    offset: page * JOURNAL_PAGE,
  };
  const query = useQuery({
    queryKey: ['cash-station-movements', stationId, params],
    queryFn: () => fetchCashMovements(stationId, params),
    placeholderData: keepPreviousData,
  });
  const items = query.data?.items ?? [];
  const info = query.data ? pageInfo({ ...query.data, count: items.length }) : null;

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="grid gap-3 pt-4 sm:grid-cols-3">
          <div className="space-y-1">
            <Label>{t('from')}</Label>
            <DatePicker value={from} max={to || undefined} onValueChange={(v) => { setFrom(v); setPage(0); }} />
          </div>
          <div className="space-y-1">
            <Label>{t('to')}</Label>
            <DatePicker value={to} min={from || undefined} onValueChange={(v) => { setTo(v); setPage(0); }} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="cash-movements-kind">{t('kind')}</Label>
            <NativeSelect
              id="cash-movements-kind"
              value={kind}
              onChange={(v) => {
                setKind(v as MovementKind | '');
                setPage(0);
              }}
              options={[{ value: '', label: t('all') }, ...MOVEMENT_KINDS.map((k) => ({ value: k, label: tr(`movementKind.${k}`) }))]}
            />
          </div>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="p-0">
          {query.isLoading ? (
            <div className="p-4">
              <Skeleton className="h-32 w-full" />
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
                    <TableHead>{t('col.at')}</TableHead>
                    <TableHead>{t('col.kind')}</TableHead>
                    <TableHead className="text-end">{t('col.amount')}</TableHead>
                    <TableHead>{t('col.count')}</TableHead>
                    <TableHead>{t('col.pieces')}</TableHead>
                    <TableHead>{t('col.by')}</TableHead>
                    <TableHead>{t('col.note')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((m) => {
                    const variance =
                      m.countedAgorot != null && m.expectedAgorot != null ? m.countedAgorot - m.expectedAgorot : null;
                    return (
                      <TableRow key={m.id}>
                        <TableCell className="whitespace-nowrap text-xs">{formatDateTime(m.at)}</TableCell>
                        <TableCell>
                          <ToneBadge tone={KIND_TONE[m.kind] ?? 'muted'}>
                            {tr.has(`movementKind.${m.kind}`) ? tr(`movementKind.${m.kind}`) : m.kind}
                          </ToneBadge>
                          {m.zReportId ? <span className="ms-1 text-[10px] text-muted-foreground">{t('inZ')}</span> : null}
                        </TableCell>
                        <TableCell className="text-end tabular-nums">{agorotText(m.amountAgorot)}</TableCell>
                        <TableCell className="text-xs">
                          {m.expectedAgorot != null || m.countedAgorot != null ? (
                            <>
                              {t('expectedCounted', { expected: agorotText(m.expectedAgorot), counted: agorotText(m.countedAgorot) })}
                              {variance !== null ? (
                                <span className={variance === 0 ? 'ms-1 text-emerald-700 dark:text-emerald-400' : 'ms-1 font-medium text-destructive'}>
                                  ({signedAgorotText(variance)})
                                </span>
                              ) : null}
                            </>
                          ) : (
                            '—'
                          )}
                        </TableCell>
                        <TableCell className="text-xs">{piecesText(m.pieces) || '—'}</TableCell>
                        <TableCell className="text-xs">{m.by?.name ?? '—'}</TableCell>
                        <TableCell className="max-w-56 truncate text-xs" title={m.note ?? undefined}>
                          {m.note ?? '—'}
                        </TableCell>
                      </TableRow>
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
          <span className="text-muted-foreground">{tr('journal.pageLine', { first: info.first, last: info.last, total: query.data.total })}</span>
          <span className="flex gap-1">
            <Button size="sm" variant="outline" disabled={!info.hasPrev || query.isFetching} onClick={() => setPage((p) => Math.max(0, p - 1))}>
              <ChevronRight aria-hidden /> {tr('journal.prev')}
            </Button>
            <Button size="sm" variant="outline" disabled={!info.hasNext || query.isFetching} onClick={() => setPage((p) => p + 1)}>
              {tr('journal.next')} <ChevronLeft aria-hidden />
            </Button>
          </span>
        </div>
      ) : null}
    </div>
  );
}
