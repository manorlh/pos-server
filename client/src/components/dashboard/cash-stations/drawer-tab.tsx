'use client';

/**
 * "מגירה ו-Z" — the station's own drawer (P:/specs/cash-paylink.md §5, §11.9; pos-server
 * cash_station_drawer.py): for a period, what came in and went out (accepted, change, refunds → net; float,
 * refills, collections), what should be in the unit, the last count, and the reconciliation — the kiosks'
 * cash documents against the station's net, with what it owes back (change owed, credits held); the
 * difference stands out when it is not zero. Below, each shop Z that took this period's rows, with its block.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Scale } from 'lucide-react';
import { addDaysIso, businessToday, formatDateTime } from '@/lib/format';
import {
  agorotText,
  rangeParams,
  reconciliationDifference,
  reconciliationState,
  signedAgorotText,
  type CashDrawerSummary,
  type CashReconciliation,
} from '@/lib/cashStations';
import { fetchCashDrawer } from '@/lib/cashStationsApi';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DatePicker } from '@/components/ui/date-picker';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { ToneBadge } from './parts';

function Figure({ label, value, strong, tone }: { label: string; value: string; strong?: boolean; tone?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2 border-b border-dashed py-1 last:border-0">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn('tabular-nums', strong ? 'font-semibold' : 'text-sm', tone)}>{value}</span>
    </div>
  );
}

function SummaryFigures({ s }: { s: CashDrawerSummary }) {
  const t = useTranslations('cashStations.drawer');
  return (
    <div className="grid gap-x-6 sm:grid-cols-2">
      <div>
        <Figure label={t('accepted')} value={agorotText(s.acceptedAgorot)} />
        <Figure label={t('change')} value={agorotText(-s.changeAgorot)} />
        <Figure label={t('refunds')} value={agorotText(-s.refundsAgorot)} />
        <Figure label={t('net')} value={agorotText(s.netAgorot)} strong />
      </div>
      <div>
        <Figure label={t('float')} value={agorotText(s.floatAgorot)} />
        <Figure label={t('refills')} value={agorotText(s.refillsAgorot)} />
        <Figure label={t('collections')} value={agorotText(-s.collectionsAgorot)} />
        {s.adjustmentsAgorot ? <Figure label={t('adjustments')} value={signedAgorotText(s.adjustmentsAgorot)} /> : null}
        <Figure label={t('expected')} value={agorotText(s.expectedAgorot)} strong />
      </div>
    </div>
  );
}

function Reconciliation({ r }: { r: CashReconciliation }) {
  const t = useTranslations('cashStations.drawer');
  const diff = reconciliationDifference(r);
  const state = reconciliationState(diff);
  return (
    <div className="space-y-1">
      <Figure label={t('kioskCash', { n: r.kioskDocuments })} value={agorotText(r.kioskCashAgorot)} />
      <Figure label={t('plusChangeOwed')} value={agorotText(r.changeOwedAgorot)} />
      <Figure label={t('plusHeld')} value={agorotText(r.heldAgorot)} />
      <Figure label={t('expectedNet')} value={agorotText(r.kioskCashAgorot + r.changeOwedAgorot + r.heldAgorot)} />
      <Figure label={t('stationNet')} value={agorotText(r.stationNetAgorot)} />
      <div
        className={cn(
          'mt-2 flex items-center justify-between gap-2 rounded-md px-3 py-2',
          state === 'ok'
            ? 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200'
            : 'bg-red-50 text-red-900 dark:bg-red-950/40 dark:text-red-200',
        )}
      >
        <span className="text-sm font-medium">{t(`difference.${state}`)}</span>
        <span className="text-lg font-bold tabular-nums">{signedAgorotText(diff)}</span>
      </div>
      {diff !== r.differenceAgorot ? <p className="text-xs text-amber-700 dark:text-amber-400">{t('serverDiffers', { n: signedAgorotText(r.differenceAgorot) })}</p> : null}
    </div>
  );
}

export function DrawerTab({ stationId }: { stationId: string }) {
  const t = useTranslations('cashStations.drawer');
  const today = businessToday();
  const [from, setFrom] = useState(() => addDaysIso(today, -6));
  const [to, setTo] = useState(today);
  const params = rangeParams(from, to);
  const query = useQuery({
    queryKey: ['cash-station-drawer', stationId, params],
    queryFn: () => fetchCashDrawer(stationId, params),
    placeholderData: keepPreviousData,
  });
  const d = query.data;

  return (
    <div className="space-y-3">
      <Card>
        <CardContent className="grid gap-3 pt-4 sm:grid-cols-2">
          <div className="space-y-1">
            <Label>{t('from')}</Label>
            <DatePicker
              value={from}
              max={to || undefined}
              onValueChange={setFrom}
              range={{ from, to, onSelect: (r) => { setFrom(r.from); setTo(r.to); } }}
            />
          </div>
          <div className="space-y-1">
            <Label>{t('to')}</Label>
            <DatePicker
              value={to}
              min={from || undefined}
              onValueChange={setTo}
              range={{ from, to, onSelect: (r) => { setFrom(r.from); setTo(r.to); } }}
            />
          </div>
        </CardContent>
      </Card>

      {query.isLoading ? (
        <Skeleton className="h-60 w-full" />
      ) : query.isError || !d ? (
        <p className="text-sm text-destructive">{t('loadError')}</p>
      ) : (
        <>
          <div className="grid gap-3 lg:grid-cols-2">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">{t('summaryTitle')}</CardTitle>
                <p className="text-xs text-muted-foreground">
                  {t('counts', {
                    tx: d.summary.txCount,
                    paid: d.summary.paidCount,
                    refunded: d.summary.refundedCount,
                    held: d.summary.heldCount,
                    nothing: d.summary.nothingInsertedCount,
                  })}
                </p>
              </CardHeader>
              <CardContent className="space-y-3">
                <SummaryFigures s={d.summary} />
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-md bg-muted/50 px-3 py-2">
                  <span className="text-sm">{t('balance')}</span>
                  <span className="text-lg font-bold tabular-nums">{agorotText(d.balanceAgorot)}</span>
                </div>
                {d.summary.lastCount ? (
                  <p className="text-xs text-muted-foreground">
                    {t('lastCount', {
                      at: d.summary.lastCount.at ? formatDateTime(d.summary.lastCount.at) : '—',
                      expected: agorotText(d.summary.lastCount.expectedAgorot),
                      counted: agorotText(d.summary.lastCount.countedAgorot),
                      variance: signedAgorotText(d.summary.lastCount.varianceAgorot),
                      by: d.summary.lastCount.by?.name ?? '—',
                    })}
                  </p>
                ) : (
                  <p className="text-xs text-muted-foreground">{t('noCount')}</p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="flex items-center gap-1 text-sm font-medium">
                  <Scale className="h-4 w-4" aria-hidden /> {t('reconciliationTitle')}
                </CardTitle>
                <p className="text-xs text-muted-foreground">{t('reconciliationHint')}</p>
              </CardHeader>
              <CardContent>
                <Reconciliation r={d.reconciliation} />
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium">{t('zTitle')}</CardTitle>
              <p className="text-xs text-muted-foreground">{t('zHint')}</p>
            </CardHeader>
            <CardContent className="space-y-3">
              {d.zReports.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('noZ')}</p>
              ) : (
                d.zReports.map((z) => {
                  const diff = z.station ? reconciliationDifference(z.station.reconciliation) : null;
                  return (
                    <div key={z.zReportId} className="space-y-2 rounded-lg border p-3">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-medium">
                          {z.zNumber != null ? t('zNumber', { n: String(z.zNumber) }) : t('zNoNumber')}
                          {z.closedAt ? <span className="ms-2 text-xs font-normal text-muted-foreground">{formatDateTime(z.closedAt)}</span> : null}
                        </span>
                        {diff !== null ? (
                          <ToneBadge tone={diff === 0 ? 'ok' : 'bad'}>
                            {t('zDifference', { n: signedAgorotText(diff) })}
                          </ToneBadge>
                        ) : null}
                      </div>
                      {z.station ? (
                        <div className="grid gap-3 lg:grid-cols-2">
                          <SummaryFigures s={z.station} />
                          <Reconciliation r={z.station.reconciliation} />
                        </div>
                      ) : (
                        <p className="text-xs text-muted-foreground">{t('zNoBlock')}</p>
                      )}
                    </div>
                  );
                })
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
