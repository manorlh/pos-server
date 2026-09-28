'use client';

/**
 * One POS terminal, from the inside: health, sync state, its shift, its recent shifts
 * and Z reports, its transactions, and which of its shop's products it sells (its own
 * catalog).
 *
 * The health panel and the clock-skew grading are the same components the
 * machines list uses, so a battery that reads "unknown" here means exactly what
 * it means there — not zero, not a fault. Actions that change a device (assign,
 * change shop, push catalogue, remove) deliberately stay on the
 * machines list, which already implements them with their confirmations; this page
 * links across rather than growing a second copy of them.
 */

import { use, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Monitor, Store, Wifi, WifiOff } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { he } from 'date-fns/locale';
import { api, fetchMachines, fetchShifts, fetchShops, fetchZReports } from '@/lib/api';
import { useCanProduceZ, zWizardHref } from '@/lib/zAccess';
import { usePageScope, useSyncScopeFromRoute } from '@/lib/scope';
import { findBySameId } from '@/lib/entityLookup';
import { registerNumberOf } from '@/lib/registerNumber';
import { formatCurrency, formatDate, formatDateTime } from '@/lib/format';
import { MachineHealthPanel, ClockSkewChip } from '@/components/dashboard/machine-health';
import { SalesStats } from '@/components/dashboard/sales-stats';
import { MachineCatalogCard } from '@/components/dashboard/machines/machine-catalog';
import { MachineShiftSummary } from '@/components/dashboard/machines/machine-row';
import {
  RemoteShiftCloseDialog,
  canCloseShiftRemotely,
} from '@/components/dashboard/machines/remote-shift-close';
import {
  CountedCash,
  OverShort,
  ShiftBadges,
  useShiftLabel,
} from '@/components/dashboard/shifts/shift-parts';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
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
  ShiftListResponse,
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
  const tShifts = useTranslations('shifts');
  const shiftLabel = useShiftLabel();
  const canProduceZ = useCanProduceZ();
  const [closeShiftOpen, setCloseShiftOpen] = useState(false);

  usePageScope({ maxLevel: 'machine', silent: true });

  const machinesQuery = useQuery<PosMachine[]>({ queryKey: ['machines'], queryFn: fetchMachines });
  const shopsQuery = useQuery<Shop[]>({ queryKey: ['shops'], queryFn: () => fetchShops() });

  const machine = findBySameId(machinesQuery.data ?? [], id);
  const shop = findBySameId(shopsQuery.data ?? [], machine?.shopId);
  const registerNumber = machine ? registerNumberOf(machine) : null;
  const registerLabel =
    registerNumber !== null ? tMachines('registerLabel', { number: registerNumber }) : null;

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

  const shiftParams = useMemo(
    () => ({ machineId: id, page: 1, pageSize: RECENT_LIMIT }),
    [id],
  );
  const shifts = useQuery<ShiftListResponse>({
    queryKey: ['shifts', shiftParams],
    queryFn: () => fetchShifts(shiftParams),
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
            {/* The register number is how the shop names this till; the free-text
                name stays beside it when it says something else. No shop, no number. */}
            <h1 className="text-2xl font-bold">{registerLabel ?? machine.name}</h1>
            {registerLabel && machine.name.trim() !== registerLabel ? (
              <span className="text-base text-muted-foreground">{machine.name}</span>
            ) : null}
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
        <div className="flex flex-wrap gap-2">
          {/* Two separate actions: closing the shift only files its X; the Z is the
              wizard's. */}
          {canProduceZ && canCloseShiftRemotely(machine) ? (
            <Button size="sm" variant="outline" onClick={() => setCloseShiftOpen(true)}>
              {tMachines('closeShiftRemotely')}
            </Button>
          ) : null}
          {canProduceZ && machine.shopId && machine.pairingStatus === 'assigned' ? (
            <Link
              href={zWizardHref(machine.shopId, machine.id)}
              className={buttonVariants({ size: 'sm' })}
            >
              {tMachines('produceZForTill')}
            </Link>
          ) : null}
          <Link
            href="/dashboard/machines"
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            {t('manage')}
          </Link>
        </div>
      </div>

      <Card>
        <CardContent className="grid grid-cols-2 gap-4 pt-4 sm:grid-cols-4 lg:grid-cols-5">
          {registerNumber !== null ? (
            <Field
              label={t('registerNumber')}
              value={<span className="tabular-nums">{registerNumber}</span>}
            />
          ) : null}
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
            label={tMachines('shift.label')}
            value={
              <span className="space-y-0.5">
                <MachineShiftSummary m={machine} />
                {/* Named from the machines response itself (openShiftSequence), so it
                    does not wait on, or depend on, the recent-shifts page below. */}
                {machine.shiftStatus === 'open' && machine.openShiftId ? (
                  <Link
                    href={`/dashboard/shifts/${machine.openShiftId}`}
                    className="block text-xs font-normal text-muted-foreground hover:underline"
                  >
                    {shiftLabel({ sequenceNumber: machine.openShiftSequence ?? null })}
                  </Link>
                ) : null}
              </span>
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

      <MachineCatalogCard machine={machine} />

      <Card>
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              {t('recentShifts')}
            </CardTitle>
            <Link
              href={`/dashboard/shifts?machine=${machine.id}`}
              className="text-xs text-muted-foreground hover:text-foreground hover:underline"
            >
              {t('allShifts')}
            </Link>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tShifts('col.shift')}</TableHead>
                <TableHead>{tShifts('col.businessDate')}</TableHead>
                <TableHead>{tShifts('col.opened')}</TableHead>
                <TableHead className="text-end">{tShifts('col.sales')}</TableHead>
                <TableHead className="text-end">{tShifts('col.counted')}</TableHead>
                <TableHead className="text-end">{tShifts('col.overShort')}</TableHead>
                <TableHead>{tShifts('col.state')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shifts.isLoading ? (
                <TableRow>
                  <TableCell colSpan={7}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ) : (shifts.data?.items ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="py-6 text-center text-muted-foreground">
                    {t('noShifts')}
                  </TableCell>
                </TableRow>
              ) : (
                (shifts.data?.items ?? []).map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">
                      <Link href={`/dashboard/shifts/${s.id}`} className="hover:underline">
                        {shiftLabel(s)}
                      </Link>
                    </TableCell>
                    <TableCell>{formatDate(s.businessDate)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDateTime(s.openedAt)}
                      {s.openedByName ? ` · ${s.openedByName}` : ''}
                    </TableCell>
                    <TableCell className="text-end font-medium">
                      {formatCurrency(s.serverTotals?.totalSales)}
                    </TableCell>
                    <TableCell className="text-end">
                      {s.status === 'open' ? '—' : <CountedCash value={s.countedCash} />}
                    </TableCell>
                    <TableCell className="text-end">
                      {s.status === 'open' ? '—' : <OverShort value={s.discrepancy} />}
                    </TableCell>
                    <TableCell>
                      <ShiftBadges shift={s} />
                    </TableCell>
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
          {/* A Z is per shop, so these are the shop's Zs that took a shift of this till;
              their figures cover every till in them. */}
          <p className="px-4 pb-2 text-xs text-muted-foreground">{t('zReportsHint')}</p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tZ('zNumber')}</TableHead>
                <TableHead>{tZ('businessDate')}</TableHead>
                <TableHead>{tZ('closedAt')}</TableHead>
                <TableHead className="text-end">{tZ('tills')}</TableHead>
                <TableHead className="text-end">{tZ('totalSales')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {zReports.isLoading ? (
                <TableRow>
                  <TableCell colSpan={5}>
                    <Skeleton className="h-6 w-full" />
                  </TableCell>
                </TableRow>
              ) : (zReports.data?.items ?? []).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                    {t('noZReports')}
                  </TableCell>
                </TableRow>
              ) : (
                (zReports.data?.items ?? []).map((report) => (
                  <TableRow key={report.id}>
                    <TableCell className="font-medium tabular-nums">
                      <Link href={`/dashboard/z-reports/${report.id}`} className="hover:underline">
                        {report.shopSequenceNumber ?? '—'}
                      </Link>
                    </TableCell>
                    <TableCell>{formatDate(report.businessDate)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDateTime(report.closedAt)}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">
                      {report.machineCount ?? (report.legacy ? 1 : '—')}
                    </TableCell>
                    <TableCell className="text-end font-medium">
                      {formatCurrency(report.totalSales)}
                    </TableCell>
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

      <RemoteShiftCloseDialog
        machine={machine}
        open={closeShiftOpen}
        onOpenChange={setCloseShiftOpen}
      />
    </div>
  );
}
