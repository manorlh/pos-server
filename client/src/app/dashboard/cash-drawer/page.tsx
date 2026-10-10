'use client';

/**
 * "מגירת מזומן" — the drawer reports of the owner's drawer spec §16
 * (docs/SPEC_ROLES_PERMISSIONS.md):
 *
 *  * "פתיחות מגירה": every opening and refused attempt, filtered by company / shop / till,
 *    employee, role, shift, dates, type, reason, manager approval, with / without a sale and
 *    exceptions only — with the KPI tiles (openings, from sales, manual, Cash In / Out,
 *    deposits, manager approvals, after Z, blocked attempts, count variances);
 *  * "תנועות מזומן": Cash In / Cash Out / deposits / counts with their snapshots;
 *  * "ציר זמן משמרת": one shift's openings, movements and counts in time order with the
 *    expected balance, to tie a cash gap to what happened around it.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Banknote, Lock, ShieldCheck, Unlock, Vault } from 'lucide-react';
import { formatCurrency, formatDateTime, formatTime } from '@/lib/format';
import { daysBackIso, todayIso } from '@/lib/reportWindow';
import {
  DRAWER_EVENT_TYPES,
  DRAWER_REASONS,
  MOVEMENT_TYPES,
  isNotable,
  runningExpected,
  type DrawerEventRow,
  type DrawerEventType,
  type DrawerFilters,
} from '@/lib/cashDrawer';
import { fetchCashMovements, fetchDrawerEvents, fetchShiftTimeline } from '@/lib/cashDrawerApi';
import { ALL_COMPANIES, EMPTY_ORG_SCOPE, OrgScopeCascade, type OrgScope } from '@/components/dashboard/org-scope-cascade';
import { ReportStatCard } from '@/components/dashboard/report-stat-card';
import { TabBar } from '@/components/dashboard/notifications/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DatePicker } from '@/components/ui/date-picker';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/lib/utils';

type Tab = 'events' | 'movements' | 'timeline';

const SELECT =
  'border-input bg-background h-9 w-full rounded-md border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

const PAGE_SIZE = 100;

function money(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : formatCurrency(v);
}

export default function CashDrawerPage() {
  const t = useTranslations('cashDrawer');
  const params = useSearchParams();
  const initialShift = params.get('shiftId') ?? '';
  const [tab, setTab] = useState<Tab>(initialShift ? 'timeline' : 'events');
  const [shiftId, setShiftId] = useState(initialShift);
  const [scope, setScope] = useState<OrgScope>(EMPTY_ORG_SCOPE);
  const [from, setFrom] = useState(daysBackIso(6));
  const [to, setTo] = useState(todayIso());
  const [eventType, setEventType] = useState('');
  const [reason, setReason] = useState('');
  const [approval, setApproval] = useState('');
  const [withSale, setWithSale] = useState('');
  const [result, setResult] = useState('');
  const [exceptionsOnly, setExceptionsOnly] = useState(false);
  const [role, setRole] = useState('');
  const [employee, setEmployee] = useState('');

  const filters: DrawerFilters | null = useMemo(() => {
    if (!from || !to || from > to) return null;
    return {
      from,
      to,
      companyId: scope.companyId && scope.companyId !== ALL_COMPANIES ? scope.companyId : undefined,
      shopId: scope.shopId || undefined,
      machineId: scope.machineId || undefined,
      eventType: eventType ? [eventType as DrawerEventType] : undefined,
      reason: reason || undefined,
      managerApproval: approval === '' ? null : approval === 'yes',
      withSale: withSale === '' ? null : withSale === 'yes',
      result: result ? [result as 'approved' | 'denied' | 'failed'] : undefined,
      exceptionsOnly,
      role: role.trim() || undefined,
      employee: employee || undefined,
    };
  }, [from, to, scope, eventType, reason, approval, withSale, result, exceptionsOnly, role, employee]);

  const openTimeline = (id: string | null) => {
    if (!id) return;
    setShiftId(id);
    setTab('timeline');
  };

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'events', label: t('tabs.events') },
    { id: 'movements', label: t('tabs.movements') },
    { id: 'timeline', label: t('tabs.timeline') },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <div className="flex gap-3 text-sm">
          <Link href="/dashboard/till-roles" className="text-primary hover:underline">{t('rolesLink')}</Link>
          <Link href="/dashboard/exceptions" className="text-primary hover:underline">{t('exceptionsLink')}</Link>
        </div>
      </div>
      <TabBar tabs={tabs} value={tab} onChange={setTab} label={t('tabs.label')} />

      {tab !== 'timeline' ? (
        <Card className="print:hidden">
          <CardContent className="space-y-3 pt-4">
            <OrgScopeCascade value={scope} onChange={setScope} allowAll />
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-1">
                <Label className="text-xs">{t('filters.from')}</Label>
                <DatePicker value={from} onChange={(e) => setFrom(e.target.value)} range={{ from, to, onSelect: (r) => { setFrom(r.from); setTo(r.to); } }} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t('filters.to')}</Label>
                <DatePicker value={to} onChange={(e) => setTo(e.target.value)} range={{ from, to, onSelect: (r) => { setFrom(r.from); setTo(r.to); } }} />
              </div>
              {tab === 'events' ? (
                <>
                  <label className="space-y-1 text-sm">
                    <span className="block text-xs">{t('filters.type')}</span>
                    <select className={SELECT} value={eventType} onChange={(e) => setEventType(e.target.value)}>
                      <option value="">{t('filters.all')}</option>
                      {DRAWER_EVENT_TYPES.map((k) => (
                        <option key={k} value={k}>{t(`types.${k}`)}</option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="block text-xs">{t('filters.reason')}</span>
                    <select className={SELECT} value={reason} onChange={(e) => setReason(e.target.value)}>
                      <option value="">{t('filters.all')}</option>
                      {DRAWER_REASONS.map((k) => (
                        <option key={k} value={k}>{t(`reasons.${k}`)}</option>
                      ))}
                    </select>
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="block text-xs">{t('filters.approval')}</span>
                    <select className={SELECT} value={approval} onChange={(e) => setApproval(e.target.value)}>
                      <option value="">{t('filters.all')}</option>
                      <option value="yes">{t('filters.withApproval')}</option>
                      <option value="no">{t('filters.withoutApproval')}</option>
                    </select>
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="block text-xs">{t('filters.sale')}</span>
                    <select className={SELECT} value={withSale} onChange={(e) => setWithSale(e.target.value)}>
                      <option value="">{t('filters.all')}</option>
                      <option value="yes">{t('filters.withSale')}</option>
                      <option value="no">{t('filters.withoutSale')}</option>
                    </select>
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="block text-xs">{t('filters.result')}</span>
                    <select className={SELECT} value={result} onChange={(e) => setResult(e.target.value)}>
                      <option value="">{t('filters.all')}</option>
                      <option value="approved">{t('results.approved')}</option>
                      <option value="denied">{t('results.denied')}</option>
                      <option value="failed">{t('results.failed')}</option>
                    </select>
                  </label>
                  <label className="space-y-1 text-sm">
                    <span className="block text-xs">{t('filters.role')}</span>
                    <Input value={role} onChange={(e) => setRole(e.target.value)} placeholder={t('filters.rolePlaceholder')} />
                  </label>
                  <label className="flex items-center gap-2 self-end pb-2 text-sm">
                    <input type="checkbox" className="h-4 w-4 accent-primary" checked={exceptionsOnly} onChange={(e) => setExceptionsOnly(e.target.checked)} />
                    {t('filters.exceptionsOnly')}
                  </label>
                </>
              ) : null}
            </div>
            {employee ? (
              <div className="flex items-center gap-2 text-xs">
                <span>{t('filters.employee')}: {employee}</span>
                <Button size="xs" variant="ghost" onClick={() => setEmployee('')}>✕</Button>
              </div>
            ) : null}
            {filters === null ? <p className="text-xs text-destructive">{t('filters.badRange')}</p> : null}
          </CardContent>
        </Card>
      ) : null}

      {tab === 'events' && filters ? (
        <EventsTab filters={filters} onShift={openTimeline} onEmployee={setEmployee} />
      ) : tab === 'movements' && filters ? (
        <MovementsTab filters={filters} onShift={openTimeline} />
      ) : tab === 'timeline' ? (
        <TimelineTab shiftId={shiftId} onShiftId={setShiftId} />
      ) : null}
    </div>
  );
}

function EventsTab({
  filters,
  onShift,
  onEmployee,
}: {
  filters: DrawerFilters;
  onShift: (id: string | null) => void;
  onEmployee: (id: string) => void;
}) {
  const t = useTranslations('cashDrawer');
  const te = useTranslations('exceptions');
  const [page, setPage] = useState(1);
  const key = JSON.stringify(filters);
  const [seen, setSeen] = useState(key);
  if (seen !== key) {
    setSeen(key);
    setPage(1);
  }
  const q = useQuery({
    queryKey: ['cash-drawer-events', filters, page],
    queryFn: () => fetchDrawerEvents(filters, page, PAGE_SIZE),
    placeholderData: (prev) => prev,
  });
  if (q.isLoading) return <Skeleton className="h-64 w-full" />;
  if (!q.data) return <p className="text-sm text-destructive">{t('loadError')}</p>;
  const k = q.data.kpis;
  const pages = Math.max(1, Math.ceil(q.data.total / q.data.pageSize));
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <ReportStatCard title={t('kpi.openings')} value={String(k.openings)} icon={Unlock} emphasis />
        <ReportStatCard title={t('kpi.saleOpenings')} value={String(k.saleOpenings)} icon={Banknote} />
        <ReportStatCard title={t('kpi.manualOpenings')} value={String(k.manualOpenings)} icon={Unlock} />
        <ReportStatCard title={t('kpi.cashIn')} value={money(k.cashIn)} subtitle={t('kpi.count', { count: k.cashInCount })} icon={ArrowDownToLine} />
        <ReportStatCard title={t('kpi.cashOut')} value={money(k.cashOut)} subtitle={t('kpi.count', { count: k.cashOutCount })} icon={ArrowUpFromLine} />
        <ReportStatCard title={t('kpi.deposits')} value={money(k.deposits)} subtitle={t('kpi.count', { count: k.depositCount })} icon={Vault} />
        <ReportStatCard title={t('kpi.managerApprovals')} value={String(k.managerApprovals)} icon={ShieldCheck} />
        <ReportStatCard title={t('kpi.afterClose')} value={String(k.afterCloseOpenings)} icon={AlertTriangle} />
        <ReportStatCard title={t('kpi.blocked')} value={String(k.blockedAttempts)} icon={Lock} />
        <ReportStatCard title={t('kpi.variances')} value={String(k.countVariances)} subtitle={money(k.countVarianceTotal)} icon={AlertTriangle} />
        <ReportStatCard title={t('kpi.exceptions')} value={String(k.exceptions)} icon={AlertTriangle} />
      </div>
      <div className="overflow-x-auto rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('col.time')}</TableHead>
              <TableHead>{t('col.till')}</TableHead>
              <TableHead>{t('col.employee')}</TableHead>
              <TableHead>{t('col.type')}</TableHead>
              <TableHead>{t('col.reason')}</TableHead>
              <TableHead>{t('col.amount')}</TableHead>
              <TableHead>{t('col.approver')}</TableHead>
              <TableHead>{t('col.result')}</TableHead>
              <TableHead>{t('col.expected')}</TableHead>
              <TableHead>{t('col.exceptions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.data.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} className="py-8 text-center text-muted-foreground">{t('empty')}</TableCell>
              </TableRow>
            ) : (
              q.data.rows.map((r) => (
                <EventRow key={r.id} r={r} te={te} onShift={onShift} onEmployee={onEmployee} />
              ))
            )}
          </TableBody>
        </Table>
      </div>
      {pages > 1 ? (
        <div className="flex items-center justify-center gap-2 text-sm">
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>‹</Button>
          <span>{t('pageOf', { page, pages })}</span>
          <Button size="sm" variant="outline" disabled={page >= pages} onClick={() => setPage((p) => p + 1)}>›</Button>
        </div>
      ) : null}
    </div>
  );
}

function EventRow({
  r,
  te,
  onShift,
  onEmployee,
}: {
  r: DrawerEventRow;
  te: ReturnType<typeof useTranslations>;
  onShift: (id: string | null) => void;
  onEmployee: (id: string) => void;
}) {
  const t = useTranslations('cashDrawer');
  return (
    <TableRow className={cn('align-top', isNotable(r) && 'bg-amber-50/60 dark:bg-amber-950/20')}>
      <TableCell className="whitespace-nowrap">
        {r.occurredAt ? formatDateTime(r.occurredAt) : '—'}
        {r.offline ? <Badge variant="outline" className="ms-1">{t('offline')}</Badge> : null}
      </TableCell>
      <TableCell>
        <div>{r.machineName ?? '—'}</div>
        <div className="text-xs text-muted-foreground">{r.shopName ?? ''}{r.drawerName ? ` · ${r.drawerName}` : ''}</div>
      </TableCell>
      <TableCell>
        {r.employeeId ? (
          <button type="button" className="text-start hover:underline" onClick={() => onEmployee(r.employeeId as string)}>
            {r.employeeName ?? r.employeeId}
          </button>
        ) : '—'}
        {r.employeeRole ? <div className="text-xs text-muted-foreground">{r.employeeRole}</div> : null}
      </TableCell>
      <TableCell>
        {t(`types.${r.eventType}`)}
        {r.saleId ? <div className="text-xs text-muted-foreground">{t('withSaleShort')}</div> : null}
      </TableCell>
      <TableCell>
        {r.reason ? t.has(`reasons.${r.reason}`) ? t(`reasons.${r.reason}`) : r.reason : '—'}
        {r.reasonNote ? <div className="text-xs text-muted-foreground">{r.reasonNote}</div> : null}
      </TableCell>
      <TableCell>{money(r.amount)}</TableCell>
      <TableCell>{r.approverName ?? '—'}</TableCell>
      <TableCell>
        <Badge variant={r.result === 'approved' ? 'outline' : 'destructive'}>{t(`results.${r.result}`)}</Badge>
        {r.resultReason ? <div className="mt-0.5 text-xs text-muted-foreground">{r.resultReason}</div> : null}
      </TableCell>
      <TableCell>
        {money(r.expectedBalance)}
        {r.shiftId ? (
          <div>
            <button type="button" className="text-xs text-primary hover:underline" onClick={() => onShift(r.shiftId)}>
              {t('openTimeline')}
            </button>
          </div>
        ) : null}
      </TableCell>
      <TableCell>
        <div className="flex flex-wrap gap-1">
          {r.exceptions.map((x) => (
            <Badge key={x} variant="secondary">{te.has(`types.${x}`) ? te(`types.${x}`) : x}</Badge>
          ))}
        </div>
      </TableCell>
    </TableRow>
  );
}

function MovementsTab({ filters, onShift }: { filters: DrawerFilters; onShift: (id: string | null) => void }) {
  const t = useTranslations('cashDrawer');
  const q = useQuery({
    queryKey: ['cash-movements', filters],
    queryFn: () => fetchCashMovements({ ...filters, eventType: undefined, reason: undefined, result: undefined }, 1, 500),
  });
  if (q.isLoading) return <Skeleton className="h-64 w-full" />;
  if (!q.data) return <p className="text-sm text-destructive">{t('loadError')}</p>;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {MOVEMENT_TYPES.map((type) => {
          const tot = q.data?.totals[type];
          return (
            <ReportStatCard
              key={type}
              title={t(`movement.${type}`)}
              value={type === 'count' ? String(tot?.count ?? 0) : money(tot?.amount ?? 0)}
              subtitle={type === 'count' ? t('kpi.varianceTotal', { amount: money(tot?.variance ?? 0) }) : t('kpi.count', { count: tot?.count ?? 0 })}
              icon={type === 'cash_in' ? ArrowDownToLine : type === 'count' ? AlertTriangle : ArrowUpFromLine}
            />
          );
        })}
      </div>
      <div className="overflow-x-auto rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('col.time')}</TableHead>
              <TableHead>{t('col.till')}</TableHead>
              <TableHead>{t('col.employee')}</TableHead>
              <TableHead>{t('col.movement')}</TableHead>
              <TableHead>{t('col.amount')}</TableHead>
              <TableHead>{t('col.expectedBefore')}</TableHead>
              <TableHead>{t('col.expectedAfter')}</TableHead>
              <TableHead>{t('col.variance')}</TableHead>
              <TableHead>{t('col.reason')}</TableHead>
              <TableHead>{t('col.approver')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.data.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={10} className="py-8 text-center text-muted-foreground">{t('empty')}</TableCell>
              </TableRow>
            ) : (
              q.data.rows.map((m) => (
                <TableRow key={m.id} className="align-top">
                  <TableCell className="whitespace-nowrap">{m.occurredAt ? formatDateTime(m.occurredAt) : '—'}</TableCell>
                  <TableCell>
                    <div>{m.machineName ?? '—'}</div>
                    <div className="text-xs text-muted-foreground">{m.shopName ?? ''}</div>
                  </TableCell>
                  <TableCell>{m.employeeName ?? m.employeeId ?? '—'}</TableCell>
                  <TableCell>
                    {t(`movement.${m.type}`)}
                    {m.blind ? <Badge variant="outline" className="ms-1">{t('blind')}</Badge> : null}
                  </TableCell>
                  <TableCell>{money(m.amount)}</TableCell>
                  <TableCell>{money(m.expectedBefore)}</TableCell>
                  <TableCell>{money(m.expectedAfter)}</TableCell>
                  <TableCell className={cn(m.variance && m.variance !== 0 ? 'font-semibold text-destructive' : '')}>{money(m.variance)}</TableCell>
                  <TableCell>
                    {m.reason ?? '—'}
                    {m.note ? <div className="text-xs text-muted-foreground">{m.note}</div> : null}
                    {m.source ? <div className="text-xs text-muted-foreground">{t('source')}: {m.source}</div> : null}
                  </TableCell>
                  <TableCell>
                    {m.approverName ?? '—'}
                    {m.shiftId ? (
                      <div>
                        <button type="button" className="text-xs text-primary hover:underline" onClick={() => onShift(m.shiftId)}>
                          {t('openTimeline')}
                        </button>
                      </div>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function TimelineTab({ shiftId, onShiftId }: { shiftId: string; onShiftId: (id: string) => void }) {
  const t = useTranslations('cashDrawer');
  const te = useTranslations('exceptions');
  const [typed, setTyped] = useState(shiftId);
  const q = useQuery({
    queryKey: ['cash-drawer-timeline', shiftId],
    queryFn: () => fetchShiftTimeline(shiftId),
    enabled: !!shiftId,
  });
  const balances = useMemo(
    () => (q.data ? runningExpected(q.data.items, q.data.shift.openingCash) : []),
    [q.data],
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2">
        <label className="space-y-1 text-sm">
          <span className="block text-xs">{t('timeline.shiftId')}</span>
          <Input value={typed} onChange={(e) => setTyped(e.target.value.trim())} className="w-80" dir="ltr" />
        </label>
        <Button size="sm" onClick={() => onShiftId(typed)} disabled={!typed}>{t('timeline.show')}</Button>
        <span className="text-xs text-muted-foreground">{t('timeline.hint')}</span>
      </div>
      {!shiftId ? null : q.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : !q.data ? (
        <p className="text-sm text-destructive">{t('loadError')}</p>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
            <ReportStatCard title={t('timeline.opening')} value={money(q.data.shift.openingCash)} icon={Banknote} />
            <ReportStatCard title={t('kpi.cashIn')} value={money(q.data.shift.cashIn)} icon={ArrowDownToLine} />
            <ReportStatCard title={t('kpi.cashOut')} value={money(q.data.shift.cashOut)} icon={ArrowUpFromLine} />
            <ReportStatCard title={t('kpi.deposits')} value={money(q.data.shift.deposits)} icon={Vault} />
            <ReportStatCard title={t('timeline.expected')} value={money(q.data.shift.expectedCash)} icon={Banknote} />
            <ReportStatCard title={t('timeline.counted')} value={money(q.data.shift.countedCash)} icon={Banknote} />
            <ReportStatCard title={t('timeline.discrepancy')} value={money(q.data.shift.discrepancy)} icon={AlertTriangle} emphasis />
          </div>
          <ol className="relative space-y-2 border-s ps-4">
            {q.data.items.map((item, i) => (
              <li key={`${item.kind}-${item.id}`} className="relative">
                <span
                  className={cn(
                    'absolute -start-[1.4rem] top-1.5 h-2.5 w-2.5 rounded-full',
                    item.kind === 'movement' ? 'bg-sky-500' : item.result !== 'approved' ? 'bg-rose-500' : item.exceptions.length ? 'bg-amber-500' : 'bg-emerald-500',
                  )}
                  aria-hidden
                />
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm">
                  <span className="font-mono text-xs text-muted-foreground">{item.occurredAt ? formatTime(item.occurredAt) : '—'}</span>
                  {item.kind === 'event' ? (
                    <>
                      <span className="font-medium">{t(`types.${item.eventType}`)}</span>
                      {item.reason ? <span>{t.has(`reasons.${item.reason}`) ? t(`reasons.${item.reason}`) : item.reason}</span> : null}
                      <span className="text-muted-foreground">{item.employeeName ?? ''}</span>
                      {item.approverName ? <span className="text-muted-foreground">{t('approvedBy', { name: item.approverName })}</span> : null}
                      {item.result !== 'approved' ? <Badge variant="destructive">{t(`results.${item.result}`)}</Badge> : null}
                      {item.exceptions.map((x) => (
                        <Badge key={x} variant="secondary">{te.has(`types.${x}`) ? te(`types.${x}`) : x}</Badge>
                      ))}
                    </>
                  ) : (
                    <>
                      <span className="font-medium">{t(`movement.${item.type}`)}</span>
                      <span>{money(item.amount)}</span>
                      {item.variance !== null ? <span className="text-destructive">{t('timeline.variance', { amount: money(item.variance) })}</span> : null}
                      {item.blind ? <Badge variant="outline">{t('blind')}</Badge> : null}
                      <span className="text-muted-foreground">{item.employeeName ?? ''}</span>
                      {item.approverName ? <span className="text-muted-foreground">{t('approvedBy', { name: item.approverName })}</span> : null}
                    </>
                  )}
                  <span className="ms-auto text-xs text-muted-foreground">{t('timeline.balance', { amount: money(balances[i]) })}</span>
                </div>
              </li>
            ))}
          </ol>
          {q.data.items.length === 0 ? <p className="text-sm text-muted-foreground">{t('empty')}</p> : null}
        </>
      )}
    </div>
  );
}
