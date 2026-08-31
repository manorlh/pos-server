'use client';

/**
 * One POS terminal, from the inside: health, sync state, its Z reports and its
 * transactions.
 *
 * The health panel and the clock-skew grading are the same components the
 * machines list uses, so a battery that reads "unknown" here means exactly what
 * it means there — not zero, not a fault. Actions that change a device (assign,
 * change shop, push catalogue, close day, remove) deliberately stay on the
 * machines list, which already implements them with their confirmations; this page
 * links across rather than growing a second copy of them.
 */

import { use, useMemo } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Monitor, Store, Wifi, WifiOff } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { he } from 'date-fns/locale';
import { api, fetchMachines, fetchShops, fetchZReports } from '@/lib/api';
import { usePageScope, useSyncScopeFromRoute } from '@/lib/scope';
import { findBySameId } from '@/lib/entityLookup';
import { formatCurrency, formatDate, formatDateTime } from '@/lib/format';
import { MachineHealthPanel, ClockSkewChip } from '@/components/dashboard/machine-health';
import { SalesStats } from '@/components/dashboard/sales-stats';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type {
  PosMachine,
  Shop,
  TransactionListResponse,
  ZReportListResponse,
} from '@/lib/types';

const RECENT_LIMIT = 10;

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-sm font-medium">{value ?? '—'}</p>
    </div>
  );
}

export default function MachineDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations('machineDetail');
  const tMachines = useTranslations('machines');
  const tZ = useTranslations('zReports');
  const tTx = useTranslations('transactions');

  usePageScope({ maxLevel: 'machine', silent: true });

  const machinesQuery = useQuery<PosMachine[]>({ queryKey: ['machines'], queryFn: fetchMachines });
  const shopsQuery = useQuery<Shop[]>({ queryKey: ['shops'], queryFn: () => fetchShops() });

  const machine = findBySameId(machinesQuery.data ?? [], id);
  const shop = findBySameId(shopsQuery.data ?? [], machine?.shopId);

  // Same as the shop page: the route drives the shared scope, and the shop and
  // company fill in as they resolve so the breadcrumb trail is complete.
  useSyncScopeFromRoute({
    companyId: shop?.companyId ?? null,
    shopId: machine?.shopId ?? null,
    machineId: id,
  });

  const zParams = useMemo(
    () => ({ machineIds: [id], page: 1, pageSize: RECENT_LIMIT }),
    [id],
  );
  const zReports = useQuery<ZReportListResponse>({
    queryKey: ['z-reports', zParams],
    queryFn: () => fetchZReports(zParams),
    enabled: !!machine,
  });

  const txParams = useMemo(
    () => ({ machineId: id, page: 1, pageSize: RECENT_LIMIT }),
    [id],
  );
  const transactions = useQuery<TransactionListResponse>({
    queryKey: ['transactions', txParams],
    queryFn: () => api.get('/transactions', { params: txParams }).then((r) => r.data),
    enabled: !!machine,
  });

  if (machinesQuery.isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }

  if (!machine) {
    return (
      <div className="space-y-3">
        <h1 className="text-2xl font-bold">{tMachines('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('notFound')}</p>
        <Link
          href="/dashboard/machines"
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          {tMachines('title')}
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Monitor className="h-5 w-5 text-muted-foreground" aria-hidden />
            <h1 className="text-2xl font-bold">{machine.name}</h1>
            <Badge variant="outline">
              {tMachines(`pairingStatusLabels.${machine.pairingStatus}`)}
            </Badge>
            <ClockSkewChip machine={machine} />
          </div>
          {shop ? (
            <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Store className="h-3.5 w-3.5" aria-hidden />
              <Link href={`/dashboard/shops/${shop.id}`} className="hover:underline">
                {shop.name}
              </Link>
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">{t('shopNone')}</p>
          )}
        </div>
        <Link
          href="/dashboard/machines"
          className={buttonVariants({ variant: 'outline', size: 'sm' })}
        >
          {t('manage')}
        </Link>
      </div>

      <Card>
        <CardContent className="grid grid-cols-2 gap-4 pt-4 sm:grid-cols-4">
          <Field label={t('machineCode')} value={<span className="font-mono">{machine.machineCode}</span>} />
          <Field
            label={tMachines('lastSeen')}
            value={
              machine.lastHeartbeatAt ? (
                <span className="flex items-center gap-1.5">
                  <Wifi className="h-3.5 w-3.5 text-green-500" aria-hidden />
                  {formatDistanceToNow(new Date(machine.lastHeartbeatAt), {
                    addSuffix: true,
                    locale: he,
                  })}
                </span>
              ) : (
                <span className="flex items-center gap-1.5">
                  <WifiOff className="h-3.5 w-3.5" aria-hidden />
                  {tMachines('neverSeen')}
                </span>
              )
            }
          />
          <Field
            label={tMachines('lastSync')}
            value={
              machine.lastSyncAt
                ? formatDistanceToNow(new Date(machine.lastSyncAt), {
                    addSuffix: true,
                    locale: he,
                  })
                : tMachines('neverSynced')
            }
          />
          <Field
            label={tMachines('tradingDayStatusLabel')}
            value={
              machine.closeDayPending
                ? tMachines('tradingDayPending')
                : machine.tradingDayStatus === 'open'
                  ? tMachines('tradingDayOpen')
                  : tMachines('tradingDayNone')
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {tMachines('health.title')}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <MachineHealthPanel machine={machine} />
        </CardContent>
      </Card>

      <SalesStats scope={{ companyId: null, shopId: null, machineId: machine.id }} />

      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t('zReports')}
            </CardTitle>
            <Link
              href={`/dashboard/z-reports?machine=${machine.id}`}
              className="text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              {t('allZReports')}
            </Link>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tZ('dayDate')}</TableHead>
                <TableHead>{tZ('closedAt')}</TableHead>
                <TableHead className="text-end">{tZ('totalSales')}</TableHead>
                <TableHead className="text-end">{tZ('discrepancy')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {zReports.isLoading ? (
                <TableRow>
                  <TableCell colSpan={4}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ) : (zReports.data?.items ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                    {t('noZReports')}
                  </TableCell>
                </TableRow>
              ) : (
                (zReports.data?.items ?? []).map((report) => (
                  <TableRow key={report.id}>
                    <TableCell>{formatDate(report.dayDate)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDateTime(report.closedAt)}
                    </TableCell>
                    <TableCell className="text-end font-medium">
                      {formatCurrency(report.totalSales)}
                    </TableCell>
                    <TableCell className="text-end">{formatCurrency(report.discrepancy)}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t('transactions')}
            </CardTitle>
            <Link
              href={`/dashboard/transactions?machine=${machine.id}`}
              className="text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              {t('allTransactions')}
            </Link>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tTx('createdAt')}</TableHead>
                <TableHead>{tTx('txNumber')}</TableHead>
                <TableHead>{tTx('status')}</TableHead>
                <TableHead className="text-end">{tTx('amount')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {transactions.isLoading ? (
                <TableRow>
                  <TableCell colSpan={4}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ) : (transactions.data?.items ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                    {t('noTransactions')}
                  </TableCell>
                </TableRow>
              ) : (
                (transactions.data?.items ?? []).map((tx) => (
                  <TableRow key={tx.id}>
                    <TableCell>{formatDateTime(tx.createdAt)}</TableCell>
                    <TableCell className="font-mono text-xs">{tx.transactionNumber}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{tTx(`statusLabels.${tx.status}`)}</Badge>
                    </TableCell>
                    <TableCell className="text-end font-medium">
                      {formatCurrency(tx.totalAmount)}
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
