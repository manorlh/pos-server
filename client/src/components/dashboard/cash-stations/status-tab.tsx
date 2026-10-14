'use client';

/**
 * "מצב" — a cash station as its host last reported it (P:/specs/cash-paylink.md §11.9): the state and why,
 * the change it can give, each denomination (how many, counted by the unit or estimated, its sensor level,
 * low), the cashbox, the queue and the transaction under way, and the open alerts naming the station.
 */

import { useTranslations } from 'next-intl';
import { AlertTriangle, Box, Coins, ListOrdered } from 'lucide-react';
import { formatDateTime } from '@/lib/format';
import { agorotText, denominationText, shortTxId, type CashStation } from '@/lib/cashStations';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Field, StationPill, ToneBadge } from './parts';

/** USBDriverStatus (NOT_USB … USB_ERROR) and DESStatus (UNLOCKED … APPLYING) → their words' keys. */
const DRIVER_KEYS: Record<number, string> = {
  [-1]: 'notUsb',
  0: 'idle',
  1: 'running',
  2: 'flashLoader',
  3: 'factoryTest',
  4: 'restarting',
  5: 'usbError',
};
const DES_KEYS: Record<number, string> = {
  0: 'unlocked',
  1: 'match',
  [-1]: 'none',
  [-2]: 'wrong',
  [-3]: 'checking',
  [-4]: 'applying',
};

export function StatusTab({ station }: { station: CashStation }) {
  const t = useTranslations('cashStations.status');
  const s = station.status;
  const denominations = [...(s?.denominations ?? [])].sort((a, b) => a.valueAgorot - b.valueAgorot);
  const cashbox = s?.cashbox ?? null;

  return (
    <div className="space-y-4">
      {!s ? (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
          {station.host ? t('noReport') : t('noHost')}
        </p>
      ) : s.stale ? (
        <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200">
          {t('stale', { at: s.reportedAt ? formatDateTime(s.reportedAt) : '—' })}
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs font-medium text-muted-foreground">{t('state')}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <StationPill station={station} />
            {s?.reportedAt ? <p className="text-xs text-muted-foreground">{t('reportedAt', { at: formatDateTime(s.reportedAt) })}</p> : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
              <Coins className="h-3.5 w-3.5" aria-hidden /> {t('change')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="text-xl font-semibold tabular-nums">{agorotText(s?.changeAvailableAgorot)}</p>
            {s?.exactOnly ? <ToneBadge tone="warn">{t('exactOnly')}</ToneBadge> : null}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
              <Box className="h-3.5 w-3.5" aria-hidden /> {t('cashbox')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {cashbox ? (
              <>
                <p className="text-xl font-semibold tabular-nums">{agorotText(cashbox.valueAgorot)}</p>
                <p className="text-xs text-muted-foreground">{t('cashboxCounts', { notes: cashbox.notes, coins: cashbox.coins })}</p>
                {cashbox.full ? (
                  <ToneBadge tone="bad">{t('cashboxFull')}</ToneBadge>
                ) : cashbox.nearFull ? (
                  <ToneBadge tone="warn">{t('cashboxNearFull')}</ToneBadge>
                ) : null}
              </>
            ) : (
              <p className="text-sm text-muted-foreground">—</p>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="flex items-center gap-1 text-xs font-medium text-muted-foreground">
              <ListOrdered className="h-3.5 w-3.5" aria-hidden /> {t('queue')}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            <p className="text-xl font-semibold tabular-nums">{s?.queue ?? '—'}</p>
            <p className="text-xs text-muted-foreground">
              {s?.activeTxId ? t('activeTx', { id: shortTxId(s.activeTxId) }) : t('noActiveTx')}
            </p>
            {s?.heldCount ? <ToneBadge tone="bad">{t('heldCount', { count: s.heldCount })}</ToneBadge> : null}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">{t('denominations')}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {denominations.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-muted-foreground">{t('noDenominations')}</p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('col.value')}</TableHead>
                    <TableHead>{t('col.kind')}</TableHead>
                    <TableHead className="text-end">{t('col.count')}</TableHead>
                    <TableHead className="text-end">{t('col.total')}</TableHead>
                    <TableHead>{t('col.accuracy')}</TableHead>
                    <TableHead>{t('col.state')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {denominations.map((d) => (
                    <TableRow key={`${d.kind}:${d.valueAgorot}`}>
                      <TableCell className="font-medium">{denominationText(d.valueAgorot)}</TableCell>
                      <TableCell>{d.kind === 'note' ? t('note') : t('coin')}</TableCell>
                      <TableCell className="text-end tabular-nums">{d.count}</TableCell>
                      <TableCell className="text-end tabular-nums">{agorotText(d.count * d.valueAgorot)}</TableCell>
                      <TableCell className="text-xs">
                        {d.accurate ? t('accurate') : t('estimate')}
                        {d.level ? ` · ${t('level', { level: t.has(`levels.${d.level}`) ? t(`levels.${d.level}`) : d.level })}` : ''}
                      </TableCell>
                      <TableCell>{d.isLow ? <ToneBadge tone="warn">{t('low')}</ToneBadge> : <ToneBadge tone="ok">{t('ok')}</ToneBadge>}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-1 text-sm font-medium text-muted-foreground">
            <AlertTriangle className="h-4 w-4" aria-hidden /> {t('alerts')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          {station.alerts.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noAlerts')}</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {station.alerts.map((a) => (
                <li key={a.id} className="flex flex-wrap items-start justify-between gap-2 px-3 py-2 text-sm">
                  <span className="min-w-0">
                    <span className="block font-medium">{a.text}</span>
                    <span className="block text-xs text-muted-foreground">
                      {a.since ? formatDateTime(a.since) : ''}
                      {a.txId ? ` · ${t('tx', { id: shortTxId(a.txId) })}` : ''}
                      {a.acknowledgedBy ? ` · ${t('acknowledgedBy', { name: a.acknowledgedBy })}` : ''}
                    </span>
                  </span>
                  <ToneBadge tone={a.severity === 'high' ? 'bad' : 'warn'}>
                    <span dir="ltr" className="font-mono">{a.code}</span>
                  </ToneBadge>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="grid grid-cols-2 gap-4 pt-4 sm:grid-cols-4">
          <Field label={t('deviceSerial')}>
            <span dir="ltr" className="font-mono text-xs">{s?.deviceSerial || '—'}</span>
          </Field>
          <Field label={t('firmware')}>
            <span dir="ltr" className="font-mono text-xs">{s?.firmware || '—'}</span>
          </Field>
          {/* USBDriverStatus / DESStatus as the PayLink manual numbers them (kiosk-desktop core/cash/paylinkApi.ts). */}
          <Field label={t('driver')}>
            {s?.driver == null ? '—' : DRIVER_KEYS[s.driver] ? t(`driverCodes.${DRIVER_KEYS[s.driver]}`) : String(s.driver)}
          </Field>
          <Field label={t('des')}>
            {s?.des == null ? '—' : DES_KEYS[s.des] ? t(`desCodes.${DES_KEYS[s.des]}`) : String(s.des)}
          </Field>
        </CardContent>
      </Card>
    </div>
  );
}
