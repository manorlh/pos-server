'use client';

/**
 * "מגירת מזומן" — the drawer reports of the owner's drawer spec §16
 * (docs/SPEC_ROLES_PERMISSIONS.md):
 *
 *  * "פתיחות מגירה": every opening and refused attempt, filtered by company / shop / till,
 *    employee, role, shift, dates, type, reason, manager approval, with / without a sale and
 *    exceptions only — with the KPI tiles (openings, from sales, manual, Cash In / Out,
 *    deposits, manager approvals, after Z, blocked attempts, count variances);
 *  * "תנועות מזומן": Cash In / Cash Out / deposits / counts with their snapshots, by type,
 *    employee and shift;
 *  * "ציר זמן משמרת": one shift's openings, movements and counts in time order with the
 *    expected balance, to tie a cash gap to what happened around it (`?shiftId=`).
 *
 * On the report framework (P:\specs\reports-upgrade.md §5): the company / shop / till are the
 * dashboard's shared scope, the days and the report's own filters (`extras`) and the tab are
 * in the URL, the lists are `ReportTable`s (sort, columns), and each tab exports to Excel and
 * PDF with export columns (§4.6): the lists every row the filters match (every page), the
 * timeline its items and the shift's summary.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ArrowDownToLine, ArrowUpFromLine, Banknote, Lock, ShieldCheck, Unlock, Vault, X } from 'lucide-react';
import { formatCurrency, formatDateTime, formatHashNumber, formatTime, isoDate } from '@/lib/format';
import { todayIso } from '@/lib/reportWindow';
import { usePageScope } from '@/lib/scope';
import {
  defaultReportFilters,
  parseReportFilters,
  reportApiParams,
  scopeApiParams,
  writeReportFilters,
  type ReportFilterSpec,
} from '@/lib/reportFilters';
import type { ReportFilterLine } from '@/lib/reportExport';
import type { ExcelSheet } from '@/lib/excelExport';
import { previousWindow, type PreviousPeriod, type ReportChart, type ReportKpi } from '@/lib/designedReport';
import {
  DRAWER_EVENT_TYPES,
  DRAWER_EXTRAS,
  DRAWER_REASONS,
  MOVEMENT_TYPES,
  activeDrawerExtras,
  drawerFiltersFromExtras,
  isNotable,
  isShiftId,
  runningExpected,
  type DrawerEventRow,
  type DrawerEventsPage,
  type DrawerExtraKey,
  type DrawerKpis,
  type MovementRow,
  type MovementsPage,
  type ShiftTimeline,
  type TimelineItem,
} from '@/lib/cashDrawer';
import {
  fetchAllCashMovements,
  fetchAllDrawerEvents,
  fetchCashMovements,
  fetchDrawerEvents,
  fetchShiftTimeline,
} from '@/lib/cashDrawerApi';
import { ReportStatCard } from '@/components/dashboard/report-stat-card';
import { TabBar } from '@/components/dashboard/notifications/shared';
import {
  ReportPage,
  ReportTable,
  StandaloneExportBar,
  reportQueryState,
  useReportFilters,
  type ReportColumn,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

type Tab = 'events' | 'movements' | 'timeline';
type ListTab = Exclude<Tab, 'timeline'>;

/** The days and the report's own filters; the shop and the till are the shared scope. */
const SPEC: ReportFilterSpec = { filters: [], extras: DRAWER_EXTRAS };

/** Rows per page on screen; the export reads every page (`exportRows`). */
const PAGE_SIZE: Record<ListTab, number> = { events: 100, movements: 500 };
const NOTABLE_ROW = 'bg-amber-50/60 dark:bg-amber-950/20';
const ALL = '__all__';

function money(v: number | null | undefined): string {
  return v === null || v === undefined ? '—' : formatCurrency(v);
}

function isTab(v: string | null): v is Tab {
  return v === 'events' || v === 'movements' || v === 'timeline';
}

/** The openings' tiles the designed PDF shows and compares with the period before, by KPI key. */
function openingFigures(k: DrawerKpis): Record<string, number> {
  return {
    openings: k.openings,
    manualOpenings: k.manualOpenings,
    cashIn: k.cashIn,
    cashOut: k.cashOut,
    countVariances: k.countVariances,
    exceptions: k.exceptions,
  };
}

/** The movements' tiles, by KPI key. */
function movementFigures(totals: MovementsPage['totals']): Record<string, number> {
  return {
    cashIn: totals.cash_in?.amount ?? 0,
    cashOut: totals.cash_out?.amount ?? 0,
    deposits: totals.deposit?.amount ?? 0,
    counts: totals.count?.count ?? 0,
    countVariance: totals.count?.variance ?? 0,
  };
}

export default function CashDrawerPage() {
  const t = useTranslations('cashDrawer');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlKey = searchParams.toString();
  const shiftParam = searchParams.get('shiftId') ?? '';
  const tabParam = searchParams.get('tab');
  // A link to one shift (`?shiftId=`, from the shift's page) opens its timeline.
  const tab: Tab = isTab(tabParam) ? tabParam : shiftParam ? 'timeline' : 'events';

  const { resolution, effective } = usePageScope({ maxLevel: 'machine' });
  const filters = useReportFilters(SPEC);

  const go = (patch: Record<string, string | null>, mode: 'push' | 'replace') => {
    const next = new URLSearchParams(urlKey);
    for (const [k, v] of Object.entries(patch)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    const q = next.toString();
    const href = q ? `${pathname}?${q}` : pathname;
    if (mode === 'push') router.push(href, { scroll: false });
    else router.replace(href, { scroll: false });
  };
  const setTab = (next: Tab) => go({ tab: next === 'events' && !shiftParam ? null : next }, 'replace');
  const openTimeline = (id: string | null) => {
    if (id) go({ tab: 'timeline', shiftId: id }, 'push');
  };

  const tabs: Array<{ id: Tab; label: string }> = [
    { id: 'events', label: t('tabs.events') },
    { id: 'movements', label: t('tabs.movements') },
    { id: 'timeline', label: t('tabs.timeline') },
  ];

  const header = (
    <div className="space-y-3 print:hidden">
      <div className="flex flex-wrap gap-3 text-sm">
        <Link href="/dashboard/till-roles" className="text-primary hover:underline">
          {t('rolesLink')}
        </Link>
        <Link href="/dashboard/exceptions" className="text-primary hover:underline">
          {t('exceptionsLink')}
        </Link>
      </div>
      <TabBar tabs={tabs} value={tab} onChange={setTab} label={t('tabs.label')} />
    </div>
  );

  if (tab === 'timeline') {
    return (
      <div className="min-w-0 space-y-4 max-sm:px-1">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>
        {header}
        <TimelineTab
          key={shiftParam}
          shiftId={shiftParam}
          onShiftId={(id) => go({ tab: 'timeline', shiftId: id }, 'push')}
          onList={(list, id) => go({ tab: list, shift: id, shiftId: null }, 'push')}
        />
      </div>
    );
  }

  return (
    <DrawerLists
      key={tab}
      tab={tab}
      header={header}
      resolution={resolution}
      scope={effective}
      filters={filters}
      urlKey={urlKey}
      onShift={openTimeline}
      push={(query) => router.push(query ? `${pathname}?${query}` : pathname, { scroll: false })}
    />
  );
}

// ── The two lists ────────────────────────────────────────────────────────────

function DrawerLists({
  tab,
  header,
  resolution,
  scope,
  filters,
  urlKey,
  onShift,
  push,
}: {
  tab: ListTab;
  header: React.ReactNode;
  resolution: ReturnType<typeof usePageScope>['resolution'];
  scope: { companyId?: string | null; shopId?: string | null; machineId?: string | null };
  filters: ReturnType<typeof useReportFilters>;
  urlKey: string;
  onShift: (id: string | null) => void;
  push: (query: string) => void;
}) {
  const t = useTranslations('cashDrawer');
  const te = useTranslations('exceptions');
  const today = todayIso();

  // The report's own filters as the URL has them (also before the first "הפק דוח": the page
  // shows the last 7 days at once, as it always has).
  const extras = useMemo(() => parseReportFilters(new URLSearchParams(urlKey), SPEC, today).extras, [today, urlKey]);
  const range = filters.apiParams ?? reportApiParams(defaultReportFilters(SPEC, today), SPEC);
  const { companyId, shopId, machineId } = scope;
  const listFilters = useMemo(
    () => ({
      from: String(range.from),
      to: String(range.to),
      ...(scopeApiParams({ companyId, shopId, machineId }) as { companyId?: string; shopId?: string; machineId?: string }),
      ...drawerFiltersFromExtras(extras, tab),
    }),
    [companyId, extras, machineId, range.from, range.to, shopId, tab],
  );
  const shiftFiltered = Boolean(listFilters.shiftId);

  /** Write one of the report's own filters to the URL now (a click on an employee). */
  const applyNow = (patch: Partial<Record<DrawerExtraKey, string>>) => {
    const values = filters.applied?.values ?? defaultReportFilters(SPEC, today);
    push(writeReportFilters(new URLSearchParams(urlKey), values, { ...extras, ...patch }, SPEC).toString());
  };

  const [page, setPage] = useState(1);
  const filtersKey = JSON.stringify(listFilters);
  const [seen, setSeen] = useState(filtersKey);
  if (seen !== filtersKey) {
    setSeen(filtersKey);
    setPage(1);
  }

  const ok = resolution.status === 'ok';
  const eventsQuery = useQuery<DrawerEventsPage>({
    queryKey: ['cash-drawer-events', listFilters, page],
    queryFn: () => fetchDrawerEvents(listFilters, page, PAGE_SIZE.events),
    enabled: ok && tab === 'events',
    placeholderData: (prev) => prev,
  });
  const movementsQuery = useQuery<MovementsPage>({
    queryKey: ['cash-movements', listFilters, page],
    queryFn: () => fetchCashMovements(listFilters, page, PAGE_SIZE.movements),
    enabled: ok && tab === 'movements',
    placeholderData: (prev) => prev,
  });
  const events = eventsQuery.data;
  const movements = movementsQuery.data;
  const data = tab === 'events' ? events : movements;

  const typeLabel = (v: string) => (t.has(`types.${v}`) ? t(`types.${v}`) : v);
  const reasonLabel = (v: string | null) => (v ? (t.has(`reasons.${v}`) ? t(`reasons.${v}`) : v) : null);
  const exceptionLabel = (x: string) => (te.has(`types.${x}`) ? te(`types.${x}`) : x);
  const yesNo = (v: boolean) => (v ? t('filters.yes') : t('filters.no'));
  const till = (r: { machineName: string | null; machineId: string }) => r.machineName ?? r.machineId;
  const employeeName = (id: string) =>
    events?.rows.find((r) => r.employeeId === id)?.employeeName ??
    movements?.rows.find((r) => r.employeeId === id)?.employeeName ??
    id;

  const eventsTable = useMemo<ReportTableSpec<DrawerEventRow>>(() => {
    const rows = events?.rows ?? [];
    const hasPos = rows.some((r) => r.posNumber !== undefined);
    const columns: ReportColumn<DrawerEventRow>[] = [
      {
        key: 'time',
        header: t('col.time'),
        kind: 'datetime',
        required: true,
        value: (r) => r.occurredAt,
        cell: (r) => (
          <span className="whitespace-nowrap">
            {r.occurredAt ? formatDateTime(r.occurredAt) : '—'}
            {r.offline ? (
              <Badge variant="outline" className="ms-1">
                {t('offline')}
              </Badge>
            ) : null}
          </span>
        ),
      },
      { key: 'offline', header: t('offline'), exportOnly: true, value: (r) => (r.offline ? t('filters.yes') : null) },
      {
        key: 'till',
        header: t('col.till'),
        value: till,
        cell: (r) => (
          <div className="whitespace-normal">
            <div>{r.machineName ?? '—'}</div>
            <div className="text-muted-foreground text-xs">
              {r.shopName ?? ''}
              {r.drawerName ? ` · ${r.drawerName}` : ''}
            </div>
          </div>
        ),
      },
      ...(hasPos
        ? [{ key: 'posNumber', header: t('col.posNumber'), value: (r: DrawerEventRow) => r.posNumber ?? null, width: 10 }]
        : []),
      { key: 'shop', header: t('col.shop'), exportOnly: true, value: (r) => r.shopName },
      { key: 'drawer', header: t('col.drawer'), exportOnly: true, value: (r) => r.drawerName },
      {
        key: 'employee',
        header: t('col.employee'),
        value: (r) => r.employeeName ?? r.employeeId,
        cell: (r) => (
          <div className="whitespace-normal">
            {r.employeeId ? (
              <button
                type="button"
                className="text-start hover:underline"
                title={t('filters.byEmployee')}
                onClick={() => applyNow({ employee: r.employeeId as string })}
              >
                {r.employeeName ?? r.employeeId}
              </button>
            ) : (
              '—'
            )}
            {r.employeeRole ? <div className="text-muted-foreground text-xs">{r.employeeRole}</div> : null}
          </div>
        ),
      },
      { key: 'role', header: t('col.role'), exportOnly: true, value: (r) => r.employeeRole },
      {
        key: 'type',
        header: t('col.type'),
        value: (r) => typeLabel(r.eventType),
        cell: (r) => (
          <div className="whitespace-normal">
            {typeLabel(r.eventType)}
            {r.saleId ? <div className="text-muted-foreground text-xs">{t('withSaleShort')}</div> : null}
          </div>
        ),
      },
      { key: 'withSale', header: t('col.withSale'), exportOnly: true, value: (r) => yesNo(Boolean(r.saleId)) },
      {
        key: 'reason',
        header: t('col.reason'),
        value: (r) => reasonLabel(r.reason),
        cell: (r) => (
          <div className="whitespace-normal">
            {reasonLabel(r.reason) ?? '—'}
            {r.reasonNote ? <div className="text-muted-foreground text-xs">{r.reasonNote}</div> : null}
          </div>
        ),
      },
      { key: 'reasonNote', header: t('col.note'), exportOnly: true, value: (r) => r.reasonNote },
      { key: 'amount', header: t('col.amount'), kind: 'money', value: (r) => r.amount },
      { key: 'approver', header: t('col.approver'), value: (r) => r.approverName },
      {
        key: 'result',
        header: t('col.result'),
        value: (r) => t(`results.${r.result}`),
        cell: (r) => (
          <div className="whitespace-normal">
            <Badge variant={r.result === 'approved' ? 'outline' : 'destructive'}>{t(`results.${r.result}`)}</Badge>
            {r.resultReason ? <div className="text-muted-foreground mt-0.5 text-xs">{r.resultReason}</div> : null}
          </div>
        ),
      },
      { key: 'resultReason', header: t('col.resultReason'), exportOnly: true, value: (r) => r.resultReason },
      {
        key: 'expected',
        header: t('col.expected'),
        kind: 'money',
        value: (r) => r.expectedBalance,
        cell: (r) => (
          <div>
            {money(r.expectedBalance)}
            {r.shiftId ? (
              <div>
                <button type="button" className="text-primary text-xs hover:underline" onClick={() => onShift(r.shiftId)}>
                  {t('openTimeline')}
                </button>
              </div>
            ) : null}
          </div>
        ),
      },
      {
        key: 'exceptions',
        header: t('col.exceptions'),
        value: (r) => r.exceptions.map(exceptionLabel).join(', ') || null,
        cell: (r) => (
          <div className="flex flex-wrap gap-1 whitespace-normal">
            {r.exceptions.map((x) => (
              <Badge key={x} variant="secondary">
                {exceptionLabel(x)}
              </Badge>
            ))}
          </div>
        ),
      },
    ];
    return {
      id: 'main',
      title: t('tabs.events'),
      columns,
      rows,
      rowKey: (r) => r.id,
      emptyText: t('empty'),
      rowClassName: (r) => (isNotable(r) ? NOTABLE_ROW : undefined),
      exportRows: () => fetchAllDrawerEvents(listFilters),
    };
    // The label helpers only read `t` / `te`; `applyNow` and `onShift` write the URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, listFilters, t, te]);

  const movementsTable = useMemo<ReportTableSpec<MovementRow>>(() => {
    const rows = movements?.rows ?? [];
    const hasPos = rows.some((r) => r.posNumber !== undefined);
    const columns: ReportColumn<MovementRow>[] = [
      { key: 'time', header: t('col.time'), kind: 'datetime', required: true, value: (r) => r.occurredAt },
      {
        key: 'till',
        header: t('col.till'),
        value: till,
        cell: (r) => (
          <div className="whitespace-normal">
            <div>{r.machineName ?? '—'}</div>
            <div className="text-muted-foreground text-xs">{r.shopName ?? ''}</div>
          </div>
        ),
      },
      ...(hasPos
        ? [{ key: 'posNumber', header: t('col.posNumber'), value: (r: MovementRow) => r.posNumber ?? null, width: 10 }]
        : []),
      { key: 'shop', header: t('col.shop'), exportOnly: true, value: (r) => r.shopName },
      { key: 'employee', header: t('col.employee'), value: (r) => r.employeeName ?? r.employeeId },
      {
        key: 'movement',
        header: t('col.movement'),
        value: (r) => t(`movement.${r.type}`),
        cell: (r) => (
          <span>
            {t(`movement.${r.type}`)}
            {r.blind ? (
              <Badge variant="outline" className="ms-1">
                {t('blind')}
              </Badge>
            ) : null}
          </span>
        ),
      },
      { key: 'blind', header: t('col.blind'), exportOnly: true, value: (r) => (r.blind ? t('filters.yes') : null) },
      { key: 'amount', header: t('col.amount'), kind: 'money', value: (r) => r.amount },
      { key: 'expectedBefore', header: t('col.expectedBefore'), kind: 'money', value: (r) => r.expectedBefore },
      { key: 'expectedAfter', header: t('col.expectedAfter'), kind: 'money', value: (r) => r.expectedAfter },
      {
        key: 'variance',
        header: t('col.variance'),
        kind: 'money',
        value: (r) => r.variance,
        cell: (r) => (
          <span className={cn(r.variance && r.variance !== 0 ? 'text-destructive font-semibold' : '')}>{money(r.variance)}</span>
        ),
      },
      {
        key: 'reason',
        header: t('col.reason'),
        value: (r) => r.reason,
        cell: (r) => (
          <div className="whitespace-normal">
            {r.reason ?? '—'}
            {r.note ? <div className="text-muted-foreground text-xs">{r.note}</div> : null}
            {r.source ? (
              <div className="text-muted-foreground text-xs">
                {t('source')}: {r.source}
              </div>
            ) : null}
          </div>
        ),
      },
      { key: 'note', header: t('col.note'), exportOnly: true, value: (r) => r.note },
      { key: 'source', header: t('source'), exportOnly: true, value: (r) => r.source },
      {
        key: 'approver',
        header: t('col.approver'),
        value: (r) => r.approverName,
        cell: (r) => (
          <div>
            {r.approverName ?? '—'}
            {r.shiftId ? (
              <div>
                <button type="button" className="text-primary text-xs hover:underline" onClick={() => onShift(r.shiftId)}>
                  {t('openTimeline')}
                </button>
              </div>
            ) : null}
          </div>
        ),
      },
    ];
    return {
      id: 'main',
      title: t('tabs.movements'),
      columns,
      rows,
      rowKey: (r) => r.id,
      emptyText: t('empty'),
      exportRows: () => fetchAllCashMovements(listFilters),
    };
    // `till` only reads the row; `onShift` writes the URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listFilters, movements, t]);

  /** The report's own filters as the export header names them. */
  const filterLines: ReportFilterLine[] = activeDrawerExtras(extras, tab).map((key) => {
    const v = extras[key] ?? '';
    const label: Record<DrawerExtraKey, string> = {
      eventType: t('filters.type'),
      reason: t('filters.reason'),
      approval: t('filters.approval'),
      sale: t('filters.sale'),
      result: t('filters.result'),
      role: t('filters.role'),
      employee: t('filters.employee'),
      exceptions: t('filters.exceptionsOnly'),
      movementType: t('filters.movementType'),
      shift: t('filters.shift'),
    };
    const value: Record<DrawerExtraKey, () => string> = {
      eventType: () => typeLabel(v),
      reason: () => reasonLabel(v) ?? v,
      approval: () => (v === 'yes' ? t('filters.withApproval') : t('filters.withoutApproval')),
      sale: () => (v === 'yes' ? t('filters.withSale') : t('filters.withoutSale')),
      result: () => t(`results.${v}`),
      role: () => v,
      employee: () => employeeName(v),
      exceptions: () => t('filters.yes'),
      movementType: () => t(`movement.${v}`),
      shift: () => v,
    };
    return { label: label[key], value: value[key]() };
  });

  const total = data?.total ?? 0;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const pager = data ? (
    <div className="flex items-center gap-2 text-sm">
      <span className="text-muted-foreground text-xs">{t('rowsTotal', { total })}</span>
      {pages > 1 ? (
        <>
          <Button size="sm" variant="outline" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label={t('prevPage')}>
            ‹
          </Button>
          <span className="text-xs">{t('pageOf', { page, pages })}</span>
          <Button
            size="sm"
            variant="outline"
            disabled={page >= pages}
            onClick={() => setPage((p) => p + 1)}
            aria-label={t('nextPage')}
          >
            ›
          </Button>
        </>
      ) : null}
    </div>
  ) : null;

  const draft = filters.draftExtras;
  const setDraft = (key: DrawerExtraKey, value: string) => filters.setExtra(key, value);
  const draftShift = (draft.shift ?? '').trim();
  const barFields = (
    <>
      {tab === 'events' ? (
        <>
          <ExtraSelect
            label={t('filters.type')}
            value={draft.eventType ?? ''}
            onChange={(v) => setDraft('eventType', v)}
            allLabel={t('filters.all')}
            options={DRAWER_EVENT_TYPES.map((k) => ({ value: k, label: typeLabel(k) }))}
          />
          <ExtraSelect
            label={t('filters.reason')}
            value={draft.reason ?? ''}
            onChange={(v) => setDraft('reason', v)}
            allLabel={t('filters.all')}
            options={DRAWER_REASONS.map((k) => ({ value: k, label: reasonLabel(k) ?? k }))}
          />
          <ExtraSelect
            label={t('filters.approval')}
            value={draft.approval ?? ''}
            onChange={(v) => setDraft('approval', v)}
            allLabel={t('filters.all')}
            options={[
              { value: 'yes', label: t('filters.withApproval') },
              { value: 'no', label: t('filters.withoutApproval') },
            ]}
          />
          <ExtraSelect
            label={t('filters.sale')}
            value={draft.sale ?? ''}
            onChange={(v) => setDraft('sale', v)}
            allLabel={t('filters.all')}
            options={[
              { value: 'yes', label: t('filters.withSale') },
              { value: 'no', label: t('filters.withoutSale') },
            ]}
          />
          <ExtraSelect
            label={t('filters.result')}
            value={draft.result ?? ''}
            onChange={(v) => setDraft('result', v)}
            allLabel={t('filters.all')}
            options={(['approved', 'denied', 'failed'] as const).map((k) => ({ value: k, label: t(`results.${k}`) }))}
          />
          <div className="min-w-0 space-y-1">
            <Label className="text-xs" htmlFor="drawer-role">
              {t('filters.role')}
            </Label>
            <Input
              id="drawer-role"
              value={draft.role ?? ''}
              onChange={(e) => setDraft('role', e.target.value)}
              placeholder={t('filters.rolePlaceholder')}
            />
          </div>
        </>
      ) : (
        <ExtraSelect
          label={t('filters.movementType')}
          value={draft.movementType ?? ''}
          onChange={(v) => setDraft('movementType', v)}
          allLabel={t('filters.all')}
          options={MOVEMENT_TYPES.map((k) => ({ value: k, label: t(`movement.${k}`) }))}
        />
      )}
      <div className="min-w-0 space-y-1">
        <Label className="text-xs" htmlFor="drawer-shift">
          {t('filters.shift')}
        </Label>
        <Input
          id="drawer-shift"
          dir="ltr"
          value={draft.shift ?? ''}
          onChange={(e) => setDraft('shift', e.target.value.trim())}
          placeholder={t('filters.shiftPlaceholder')}
          aria-invalid={draftShift && !isShiftId(draftShift) ? true : undefined}
        />
        {draftShift && !isShiftId(draftShift) ? <p className="text-destructive text-xs">{t('filters.shiftInvalid')}</p> : null}
      </div>
      {tab === 'events' ? (
        <label className="flex items-center gap-2 self-end pb-2 text-sm">
          <input
            type="checkbox"
            className="accent-primary h-4 w-4"
            checked={draft.exceptions === '1'}
            onChange={(e) => setDraft('exceptions', e.target.checked ? '1' : '')}
          />
          {t('filters.exceptionsOnly')}
        </label>
      ) : null}
      {extras.employee ? (
        <div className="flex items-center gap-2 self-end pb-2 text-xs">
          <span>
            {t('filters.employee')}: {employeeName(extras.employee)}
          </span>
          <Button size="xs" variant="ghost" onClick={() => applyNow({ employee: '' })} aria-label={t('filters.clearEmployee')}>
            <X className="h-3.5 w-3.5" aria-hidden />
          </Button>
        </div>
      ) : null}
    </>
  );

  const k = events?.kpis;
  const exportTable = (tab === 'events' ? eventsTable : movementsTable) as ReportTableSpec<unknown>;
  const served = data?.window;

  // The designed PDF (P:\specs\reports-designed-pdf.md §7): the tab's tiles as cards, against the
  // same filters on the period before (one page of it: only its tiles are compared — a list of
  // openings has no row to set against another). One shift's rows have no period before.
  const designed = (() => {
    if (tab === 'events') {
      if (!k) return null;
      const f = openingFigures(k);
      const kpis: ReportKpi[] = [
        { key: 'openings', label: t('kpi.openings'), value: f.openings, kind: 'count', icon: 'cash' },
        { key: 'manualOpenings', label: t('kpi.manualOpenings'), value: f.manualOpenings, kind: 'count', better: 'down' },
        { key: 'cashIn', label: t('kpi.cashIn'), value: f.cashIn, kind: 'money' },
        { key: 'cashOut', label: t('kpi.cashOut'), value: f.cashOut, kind: 'money' },
        { key: 'countVariances', label: t('kpi.variances'), value: f.countVariances, kind: 'count', better: 'down', icon: 'alert' },
        { key: 'exceptions', label: t('kpi.exceptions'), value: f.exceptions, kind: 'count', better: 'down', icon: 'alert' },
      ];
      return {
        kpis,
        chart: null,
        // The tiles only: a page of one row carries them.
        figures: async (w: { from: string; to: string }) =>
          openingFigures((await fetchDrawerEvents({ ...listFilters, ...w }, 1, 1)).kpis),
      };
    }
    if (!movements) return null;
    const f = movementFigures(movements.totals);
    const kpis: ReportKpi[] = [
      { key: 'cashIn', label: t('movement.cash_in'), value: f.cashIn, kind: 'money', icon: 'cash' },
      { key: 'cashOut', label: t('movement.cash_out'), value: f.cashOut, kind: 'money', icon: 'cash' },
      { key: 'deposits', label: t('movement.deposit'), value: f.deposits, kind: 'money' },
      { key: 'counts', label: t('movement.count'), value: f.counts, kind: 'count' },
      { key: 'countVariance', label: t('col.variance'), value: f.countVariance, kind: 'money', icon: 'alert' },
    ];
    const types = MOVEMENT_TYPES.filter((type) => type !== 'count');
    const chart: ReportChart = {
      type: 'hbar',
      title: t('tabs.movements'),
      labels: types.map((type) => t(`movement.${type}`)),
      series: [{ name: t('col.amount'), values: types.map((type) => movements.totals[type]?.amount ?? 0) }],
      kind: 'money',
    };
    return {
      kpis,
      chart,
      figures: async (w: { from: string; to: string }) =>
        movementFigures((await fetchCashMovements({ ...listFilters, ...w }, 1, 1)).totals),
    };
  })();
  const previous = async (): Promise<PreviousPeriod | null> => {
    const w = shiftFiltered ? null : previousWindow(served?.from ?? String(range.from), served?.to ?? String(range.to));
    if (!designed || !w) return null;
    return { kpis: await designed.figures(w), ...w };
  };

  return (
    <ReportPage
      reportKey={tab === 'events' ? 'cash-drawer' : 'cash-drawer-movements'}
      title={t('title')}
      subtitle={t('subtitle')}
      headerExtra={header}
      resolution={resolution}
      filters={filters}
      bar={{ children: barFields, hint: shiftFiltered ? t('filters.shiftHint') : undefined }}
      query={reportQueryState(tab === 'events' ? eventsQuery : movementsQuery)}
      prompt={t('empty')}
      ready
      export={
        data
          ? {
              title: `${t('title')} · ${tab === 'events' ? t('tabs.events') : t('tabs.movements')}`,
              tables: [exportTable],
              // One shift's rows: the days do not apply (the server reads the whole shift).
              from: shiftFiltered ? '' : (served?.from ?? String(range.from)),
              to: shiftFiltered ? '' : (served?.to ?? String(range.to)),
              filterLines,
              disabled: data.total === 0,
              reportType: tab === 'events' ? 'cash-drawer' : 'cash-drawer-movements',
              kpis: designed?.kpis,
              chart: designed?.chart,
              insightKeys: { label: tab === 'events' ? 'type' : 'movement', value: 'amount', employee: 'employee' },
              groupBy: ['shop', 'till'],
              previous,
            }
          : null
      }
    >
      {tab === 'events' && events && k ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
            <ReportStatCard title={t('kpi.openings')} value={String(k.openings)} icon={Unlock} emphasis />
            <ReportStatCard title={t('kpi.saleOpenings')} value={String(k.saleOpenings)} icon={Banknote} />
            <ReportStatCard title={t('kpi.manualOpenings')} value={String(k.manualOpenings)} icon={Unlock} />
            <ReportStatCard
              title={t('kpi.cashIn')}
              value={money(k.cashIn)}
              subtitle={t('kpi.count', { count: k.cashInCount })}
              icon={ArrowDownToLine}
            />
            <ReportStatCard
              title={t('kpi.cashOut')}
              value={money(k.cashOut)}
              subtitle={t('kpi.count', { count: k.cashOutCount })}
              icon={ArrowUpFromLine}
            />
            <ReportStatCard
              title={t('kpi.deposits')}
              value={money(k.deposits)}
              subtitle={t('kpi.count', { count: k.depositCount })}
              icon={Vault}
            />
            <ReportStatCard title={t('kpi.managerApprovals')} value={String(k.managerApprovals)} icon={ShieldCheck} />
            <ReportStatCard title={t('kpi.afterClose')} value={String(k.afterCloseOpenings)} icon={AlertTriangle} />
            <ReportStatCard title={t('kpi.blocked')} value={String(k.blockedAttempts)} icon={Lock} />
            <ReportStatCard
              title={t('kpi.variances')}
              value={String(k.countVariances)}
              subtitle={money(k.countVarianceTotal)}
              icon={AlertTriangle}
            />
            <ReportStatCard title={t('kpi.exceptions')} value={String(k.exceptions)} icon={AlertTriangle} />
          </div>
          <ReportTable table={eventsTable} actions={pager} />
          {pages > 1 ? <p className="text-muted-foreground text-xs">{t('pagedNote')}</p> : null}
        </>
      ) : tab === 'movements' && movements ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {MOVEMENT_TYPES.map((type) => {
              const tot = movements.totals[type];
              return (
                <ReportStatCard
                  key={type}
                  title={t(`movement.${type}`)}
                  value={type === 'count' ? String(tot?.count ?? 0) : money(tot?.amount ?? 0)}
                  subtitle={
                    type === 'count'
                      ? t('kpi.varianceTotal', { amount: money(tot?.variance ?? 0) })
                      : t('kpi.count', { count: tot?.count ?? 0 })
                  }
                  icon={type === 'cash_in' ? ArrowDownToLine : type === 'count' ? AlertTriangle : ArrowUpFromLine}
                />
              );
            })}
          </div>
          <ReportTable table={movementsTable} actions={pager} />
          {pages > 1 ? <p className="text-muted-foreground text-xs">{t('pagedNote')}</p> : null}
        </>
      ) : null}
    </ReportPage>
  );
}

function ExtraSelect({
  label,
  value,
  onChange,
  options,
  allLabel,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  allLabel: string;
}) {
  const items = [{ value: ALL, label: allLabel }, ...options];
  return (
    <div className="min-w-0 space-y-1">
      <Label className="text-xs">{label}</Label>
      <Select value={value || ALL} onValueChange={(v) => onChange(!v || v === ALL ? '' : String(v))} items={items}>
        <SelectTrigger className="w-full min-w-0" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((o) => (
            <SelectItem key={o.value} value={o.value} label={o.label}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

// ── One shift's timeline ─────────────────────────────────────────────────────

interface TimelineRow {
  item: TimelineItem;
  balance: number | null;
}

function TimelineTab({
  shiftId,
  onShiftId,
  onList,
}: {
  shiftId: string;
  onShiftId: (id: string) => void;
  onList: (tab: ListTab, shiftId: string) => void;
}) {
  const t = useTranslations('cashDrawer');
  const te = useTranslations('exceptions');
  const [typed, setTyped] = useState(shiftId);
  const q = useQuery<ShiftTimeline>({
    queryKey: ['cash-drawer-timeline', shiftId],
    queryFn: () => fetchShiftTimeline(shiftId),
    enabled: !!shiftId,
  });
  const data = q.data;
  const balances = useMemo(() => (data ? runningExpected(data.items, data.shift.openingCash) : []), [data]);

  const typeLabel = (v: string) => (t.has(`types.${v}`) ? t(`types.${v}`) : v);
  const reasonLabel = (v: string | null) => (v ? (t.has(`reasons.${v}`) ? t(`reasons.${v}`) : v) : null);
  const exceptionLabel = (x: string) => (te.has(`types.${x}`) ? te(`types.${x}`) : x);

  const table = useMemo<ReportTableSpec<TimelineRow>>(() => {
    const columns: ReportColumn<TimelineRow>[] = [
      { key: 'time', header: t('col.time'), kind: 'datetime', required: true, value: (r) => r.item.occurredAt },
      {
        key: 'kind',
        header: t('col.kind'),
        value: (r) => (r.item.kind === 'event' ? t('timeline.kindEvent') : t('timeline.kindMovement')),
      },
      {
        key: 'type',
        header: t('col.type'),
        value: (r) => (r.item.kind === 'event' ? typeLabel(r.item.eventType) : t(`movement.${r.item.type}`)),
      },
      { key: 'reason', header: t('col.reason'), value: (r) => (r.item.kind === 'event' ? reasonLabel(r.item.reason) : r.item.reason) },
      { key: 'amount', header: t('col.amount'), kind: 'money', value: (r) => r.item.amount },
      { key: 'variance', header: t('col.variance'), kind: 'money', value: (r) => (r.item.kind === 'movement' ? r.item.variance : null) },
      {
        key: 'blind',
        header: t('col.blind'),
        value: (r) => (r.item.kind === 'movement' && r.item.blind ? t('filters.yes') : null),
      },
      { key: 'employee', header: t('col.employee'), value: (r) => r.item.employeeName ?? r.item.employeeId },
      { key: 'approver', header: t('col.approver'), value: (r) => r.item.approverName },
      { key: 'result', header: t('col.result'), value: (r) => (r.item.kind === 'event' ? t(`results.${r.item.result}`) : null) },
      {
        key: 'exceptions',
        header: t('col.exceptions'),
        value: (r) => (r.item.kind === 'event' ? r.item.exceptions.map(exceptionLabel).join(', ') || null : null),
      },
      { key: 'balance', header: t('col.expected'), kind: 'money', value: (r) => r.balance },
    ];
    return {
      id: 'main',
      title: t('tabs.timeline'),
      columns,
      rows: (data?.items ?? []).map((item, i) => ({ item, balance: balances[i] ?? null })),
      rowKey: (r) => `${r.item.kind}-${r.item.id}`,
      emptyText: t('empty'),
    };
    // The label helpers only read `t` / `te`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [balances, data, t, te]);

  const shift = data?.shift;
  const shiftLabel = shift ? (shift.sequenceNumber !== null ? formatHashNumber(shift.sequenceNumber) : shift.id) : shiftId;
  const first = data?.items[0];
  const place = first ? [first.shopName, first.machineName].filter(Boolean).join(' · ') || null : null;

  /** The shift's own figures — the tiles — as a sheet of their own. */
  const summarySheet = (): ExcelSheet[] =>
    shift
      ? [
          {
            name: t('timeline.summarySheet'),
            columns: [
              { key: 'shift', header: t('filters.shift'), kind: 'text' },
              { key: 'openedAt', header: t('timeline.openedAt'), kind: 'datetime' },
              { key: 'closedAt', header: t('timeline.closedAt'), kind: 'datetime' },
              { key: 'opening', header: t('timeline.opening'), kind: 'money' },
              { key: 'cashIn', header: t('kpi.cashIn'), kind: 'money' },
              { key: 'cashOut', header: t('kpi.cashOut'), kind: 'money' },
              { key: 'deposits', header: t('kpi.deposits'), kind: 'money' },
              { key: 'expected', header: t('timeline.expected'), kind: 'money' },
              { key: 'counted', header: t('timeline.counted'), kind: 'money' },
              { key: 'discrepancy', header: t('timeline.discrepancy'), kind: 'money' },
            ],
            rows: [
              [
                shiftLabel,
                shift.openedAt,
                shift.closedAt,
                shift.openingCash,
                shift.cashIn,
                shift.cashOut,
                shift.deposits,
                shift.expectedCash,
                shift.countedCash,
                shift.discrepancy,
              ],
            ],
            autoFilter: false,
          },
        ]
      : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-2 print:hidden">
        <div className="space-y-1">
          <Label className="text-xs" htmlFor="timeline-shift">
            {t('timeline.shiftId')}
          </Label>
          <Input id="timeline-shift" value={typed} onChange={(e) => setTyped(e.target.value.trim())} className="w-80 max-w-full" dir="ltr" />
        </div>
        <Button size="sm" onClick={() => onShiftId(typed)} disabled={!typed}>
          {t('timeline.show')}
        </Button>
        <span className="text-muted-foreground text-xs">{t('timeline.hint')}</span>
      </div>
      {!shiftId ? null : q.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : !data || !shift ? (
        <p className="text-destructive text-sm">{t('loadError')}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <StandaloneExportBar
              reportKey="cash-drawer-timeline"
              title={`${t('title')} · ${t('tabs.timeline')}`}
              tables={[table as ReportTableSpec<unknown>]}
              extraSheets={summarySheet}
              extraSheetsFirst
              from={shift.openedAt ? isoDate(shift.openedAt) : null}
              to={shift.closedAt ? isoDate(shift.closedAt) : shift.openedAt ? isoDate(shift.openedAt) : null}
              place={place}
              filterLines={[{ label: t('filters.shift'), value: shiftLabel }]}
              disabled={data.items.length === 0}
              // The designed PDF (P:\specs\reports-designed-pdf.md §7): the shift's tiles as cards.
              // One shift: no period before it.
              reportType="cash-drawer-timeline"
              kpis={[
                { key: 'opening', label: t('timeline.opening'), value: shift.openingCash, kind: 'money', icon: 'cash' },
                { key: 'cashIn', label: t('kpi.cashIn'), value: shift.cashIn, kind: 'money' },
                { key: 'cashOut', label: t('kpi.cashOut'), value: shift.cashOut, kind: 'money' },
                { key: 'expected', label: t('timeline.expected'), value: shift.expectedCash, kind: 'money' },
                { key: 'counted', label: t('timeline.counted'), value: shift.countedCash, kind: 'money' },
                { key: 'discrepancy', label: t('timeline.discrepancy'), value: shift.discrepancy, kind: 'money', icon: 'alert' },
              ]}
            />
            <div className="flex flex-wrap gap-3 text-sm print:hidden">
              <button type="button" className="text-primary hover:underline" onClick={() => onList('events', shift.id)}>
                {t('timeline.openingsOfShift')}
              </button>
              <button type="button" className="text-primary hover:underline" onClick={() => onList('movements', shift.id)}>
                {t('timeline.movementsOfShift')}
              </button>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
            <ReportStatCard title={t('timeline.opening')} value={money(shift.openingCash)} icon={Banknote} />
            <ReportStatCard title={t('kpi.cashIn')} value={money(shift.cashIn)} icon={ArrowDownToLine} />
            <ReportStatCard title={t('kpi.cashOut')} value={money(shift.cashOut)} icon={ArrowUpFromLine} />
            <ReportStatCard title={t('kpi.deposits')} value={money(shift.deposits)} icon={Vault} />
            <ReportStatCard title={t('timeline.expected')} value={money(shift.expectedCash)} icon={Banknote} />
            <ReportStatCard title={t('timeline.counted')} value={money(shift.countedCash)} icon={Banknote} />
            <ReportStatCard title={t('timeline.discrepancy')} value={money(shift.discrepancy)} icon={AlertTriangle} emphasis />
          </div>
          <ol className="relative space-y-2 border-s ps-4">
            {data.items.map((item, i) => (
              <li key={`${item.kind}-${item.id}`} className="relative">
                <span
                  className={cn(
                    'absolute -start-[1.4rem] top-1.5 h-2.5 w-2.5 rounded-full',
                    item.kind === 'movement'
                      ? 'bg-sky-500'
                      : item.result !== 'approved'
                        ? 'bg-rose-500'
                        : item.exceptions.length
                          ? 'bg-amber-500'
                          : 'bg-emerald-500',
                  )}
                  aria-hidden
                />
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm">
                  <span className="text-muted-foreground font-mono text-xs">{item.occurredAt ? formatTime(item.occurredAt) : '—'}</span>
                  {item.kind === 'event' ? (
                    <>
                      <span className="font-medium">{typeLabel(item.eventType)}</span>
                      {item.reason ? <span>{reasonLabel(item.reason)}</span> : null}
                      <span className="text-muted-foreground">{item.employeeName ?? ''}</span>
                      {item.approverName ? (
                        <span className="text-muted-foreground">{t('approvedBy', { name: item.approverName })}</span>
                      ) : null}
                      {item.result !== 'approved' ? <Badge variant="destructive">{t(`results.${item.result}`)}</Badge> : null}
                      {item.exceptions.map((x) => (
                        <Badge key={x} variant="secondary">
                          {exceptionLabel(x)}
                        </Badge>
                      ))}
                    </>
                  ) : (
                    <>
                      <span className="font-medium">{t(`movement.${item.type}`)}</span>
                      <span>{money(item.amount)}</span>
                      {item.variance !== null ? (
                        <span className="text-destructive">{t('timeline.variance', { amount: money(item.variance) })}</span>
                      ) : null}
                      {item.blind ? <Badge variant="outline">{t('blind')}</Badge> : null}
                      <span className="text-muted-foreground">{item.employeeName ?? ''}</span>
                      {item.approverName ? (
                        <span className="text-muted-foreground">{t('approvedBy', { name: item.approverName })}</span>
                      ) : null}
                    </>
                  )}
                  <span className="text-muted-foreground ms-auto text-xs">{t('timeline.balance', { amount: money(balances[i]) })}</span>
                </div>
              </li>
            ))}
          </ol>
          {data.items.length === 0 ? <p className="text-muted-foreground text-sm">{t('empty')}</p> : null}
        </>
      )}
    </div>
  );
}
