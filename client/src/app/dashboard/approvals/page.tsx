'use client';

/**
 * "בקשות אישור" (P:\specs\manager-approval-mobile.md §6): what the tills ask a manager to
 * approve from the phone.
 *
 * * **ממתינות** — live (every 5 seconds), a card per request: what, how much, the table, the till,
 *   who asked and why, the time left; "פתח" opens the request to decide it.
 * * **היסטוריה** — every request, filtered by type, shop, requester, approver, outcome, reason
 *   and dates; a table on a wide screen, cards on a phone; Excel / PDF of every matching row
 *   (the designed PDF: the counts, subtotals by shop and till).
 *
 * The tab sits in the URL (`?tab=history`). The menu's badge counts the same pending requests.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ClipboardCheck, Filter, Settings2 } from 'lucide-react';
import { api, fetchShops } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { useAuth } from '@/lib/auth';
import { canAccess } from '@/lib/dashboardAccess';
import { useDashboardAccess } from '@/lib/dashboardAccessApi';
import { fetchAllPages } from '@/lib/fetchAllPages';
import type { ReportFilterLine } from '@/lib/reportExport';
import {
  APPROVAL_COLUMNS,
  APPROVAL_STATUSES,
  EMPTY_HISTORY_FILTERS,
  activeFilterCount,
  approvalRowValues,
  approverOptions,
  historyParams,
  isPartial,
  type ApprovalCard,
  type ApprovalColumnKey,
  type ApprovalList,
  type HistoryFilters,
} from '@/lib/approvals';
import { fetchApprovalCatalog, fetchApprovals } from '@/lib/approvalsApi';
import type { Shop } from '@/lib/types';
import { previousWindow } from '@/lib/designedReport';
import {
  ReportTable,
  StandaloneExportBar,
  type PreviousPeriod,
  type ReportColumn,
  type ReportKpi,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';
import { ReportErrorState } from '@/components/dashboard/report-window-summary';
import { PENDING_COUNT_KEY } from '@/components/dashboard/approvals/pending-badge';
import { PendingApprovalCard, StatusPill } from '@/components/dashboard/approvals/shared';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

type Tab = 'pending' | 'history';
const HISTORY_PAGE = 100;
const ANY = '__any__';

export default function ApprovalsPage() {
  const t = useTranslations('approvals');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const tab: Tab = searchParams.get('tab') === 'history' ? 'history' : 'pending';
  const access = useDashboardAccess();
  const canSettings = canAccess(access, 'approval_settings', 'view');

  const setTab = (next: Tab) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === 'pending') params.delete('tab');
    else params.set('tab', next);
    const q = params.toString();
    router.replace(q ? `${pathname}?${q}` : pathname);
  };

  const qc = useQueryClient();
  // Live: every 5 seconds, also behind the history tab (its count heads the tabs).
  const pending = useQuery<ApprovalList>({
    queryKey: ['approvals', 'pending'],
    queryFn: async () => {
      const list = await fetchApprovals(historyParams(EMPTY_HISTORY_FILTERS, { status: 'pending', limit: 200 }));
      qc.setQueryData(PENDING_COUNT_KEY, list.pendingCount);
      return list;
    },
    refetchInterval: 5_000,
    refetchIntervalInBackground: false,
  });
  const pendingItems = pending.data?.items ?? [];

  return (
    <div className="min-w-0 space-y-4 max-sm:px-1">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <ClipboardCheck className="size-6" aria-hidden />
            {t('title')}
          </h1>
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>
        {canSettings ? (
          <Link href="/dashboard/approval-settings" className="text-primary inline-flex items-center gap-1 text-sm hover:underline">
            <Settings2 className="size-4" aria-hidden />
            {t('settingsLink')}
          </Link>
        ) : null}
      </div>

      <div className="flex gap-2" role="tablist" aria-label={t('tabs.label')}>
        {(['pending', 'history'] as const).map((id) => (
          <Button
            key={id}
            role="tab"
            aria-selected={tab === id}
            variant={tab === id ? 'default' : 'outline'}
            className="flex-1 sm:flex-none"
            onClick={() => setTab(id)}
          >
            {t(`tabs.${id}`)}
            {id === 'pending' && pendingItems.length ? (
              <span
                className={cn(
                  'rounded-full px-1.5 text-xs tabular-nums',
                  tab === id ? 'bg-primary-foreground text-primary' : 'bg-red-600 text-white',
                )}
              >
                {pendingItems.length}
              </span>
            ) : null}
          </Button>
        ))}
      </div>

      {tab === 'pending' ? (
        pending.isPending ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <Skeleton className="h-48" />
            <Skeleton className="h-48" />
          </div>
        ) : pending.isError && !pending.data ? (
          <ReportErrorState message={axiosErrorToToastMessage(pending.error, t('loadError'))} />
        ) : pendingItems.length === 0 ? (
          <div className="bg-card rounded-xl border p-6 text-center">
            <p className="font-medium">{t('noPending')}</p>
            <p className="text-muted-foreground mt-1 text-sm">{t('noPendingHint')}</p>
          </div>
        ) : (
          <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {pendingItems.map((card) => (
              <PendingApprovalCard key={card.id} card={card} />
            ))}
          </ul>
        )
      ) : (
        <HistoryTab />
      )}
    </div>
  );
}

function FilterSelect({
  id,
  label,
  value,
  onChange,
  options,
  anyLabel,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  anyLabel: string;
}) {
  const items = [{ value: ANY, label: anyLabel }, ...options];
  return (
    <div className="min-w-0 space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Select value={value || ANY} onValueChange={(v) => onChange(!v || v === ANY ? '' : String(v))} items={items}>
        <SelectTrigger id={id} className="w-full">
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

/** The users who may have decided (the users list, when this user may read it). */
function useApproverUsers(enabled: boolean) {
  return useQuery({
    queryKey: ['approvals', 'approver-users'],
    queryFn: async () => {
      const { data } = await api.get<Array<Record<string, unknown>>>('/users');
      return (Array.isArray(data) ? data : []).map((u) => ({ id: String(u.id ?? ''), name: String(u.username ?? u.email ?? '') }));
    },
    enabled,
    staleTime: 5 * 60_000,
    retry: false,
  });
}

function HistoryTab() {
  const t = useTranslations('approvals');
  const tc = useTranslations('common');
  const router = useRouter();
  const canReadUsers = useAuth((s) => s.user?.canReadUsers === true);
  const [draft, setDraft] = useState<HistoryFilters>(EMPTY_HISTORY_FILTERS);
  const [applied, setApplied] = useState<HistoryFilters>(EMPTY_HISTORY_FILTERS);
  const [page, setPage] = useState(0);
  const [showFilters, setShowFilters] = useState(false);

  // Typing narrows the list once the typing stops; a pick applies as quickly.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setApplied(draft);
      setPage(0);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [draft]);

  const set = (patch: Partial<HistoryFilters>) => setDraft((d) => ({ ...d, ...patch }));

  const list = useQuery<ApprovalList>({
    queryKey: ['approvals', 'history', applied, page],
    queryFn: () => fetchApprovals(historyParams(applied, { status: 'all', limit: HISTORY_PAGE, offset: page * HISTORY_PAGE })),
    placeholderData: (prev) => prev,
    refetchInterval: 30_000,
  });
  const catalog = useQuery({ queryKey: ['approvals', 'catalog'], queryFn: fetchApprovalCatalog, staleTime: 60 * 60_000, retry: false });
  const shops = useQuery<Shop[]>({ queryKey: ['shops'], queryFn: () => fetchShops() });
  const users = useApproverUsers(canReadUsers);

  const rows = useMemo(() => list.data?.items ?? [], [list.data]);
  const total = list.data?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / HISTORY_PAGE));

  const typeOptions = useMemo(() => {
    const fromCatalog = (catalog.data?.types ?? []).map((x) => ({ value: x.key, label: x.label }));
    if (fromCatalog.length) return fromCatalog;
    const seen = new Map<string, string>();
    for (const r of rows) if (r.type && !seen.has(r.type)) seen.set(r.type, r.typeLabel);
    return [...seen.entries()].map(([value, label]) => ({ value, label }));
  }, [catalog.data, rows]);
  const shopOptions = useMemo(() => (shops.data ?? []).map((s) => ({ value: s.id, label: s.name })), [shops.data]);
  const approvers = useMemo(() => approverOptions(users.data ?? [], rows), [users.data, rows]);
  const statusOptions = APPROVAL_STATUSES.map((s) => ({ value: s, label: t(`statuses.${s}`) }));

  const table = useMemo<ReportTableSpec<ApprovalCard>>(() => {
    const labels = { status: (s: ApprovalCard['status']) => t(`statuses.${s}`) };
    const screen: Partial<Record<ApprovalColumnKey, Partial<ReportColumn<ApprovalCard>>>> = {
      createdAt: { required: true },
      type: { cell: (r) => <span className="font-medium">{r.typeLabel}</span> },
      status: {
        cell: (r) => (
          <span className="inline-flex items-center gap-1">
            <StatusPill status={r.status} />
            {isPartial(r) ? <span className="text-muted-foreground text-xs">{t('partial')}</span> : null}
          </span>
        ),
      },
      reason: { className: 'min-w-40 whitespace-normal' },
      note: { className: 'min-w-48 whitespace-normal', defaultHidden: true },
      sentTo: { className: 'min-w-40 whitespace-normal', defaultHidden: true },
      message: { className: 'min-w-40 whitespace-normal' },
    };
    const columns: ReportColumn<ApprovalCard>[] = APPROVAL_COLUMNS.map((c) => ({
      key: c.key,
      header: t(`col.${c.key}`),
      kind: c.kind,
      width: c.width,
      value: (r: ApprovalCard) => approvalRowValues(r, labels)[c.key],
      ...screen[c.key],
    }));
    return {
      id: 'main',
      title: t('tabs.history'),
      columns,
      rows,
      rowKey: (r) => r.id,
      emptyText: t('historyEmpty'),
      onRowClick: (r) => router.push(`/dashboard/approvals/${r.id}`),
    };
  }, [rows, router, t]);

  const exportTables = [
    {
      ...table,
      exportRows: () =>
        fetchAllPages(
          (p, size) => fetchApprovals(historyParams(applied, { status: 'all', limit: size, offset: (p - 1) * size })),
          { pageSize: 200 },
        ),
    } as ReportTableSpec<unknown>,
  ];

  const filterLines = useMemo<ReportFilterLine[]>(() => {
    const lines: ReportFilterLine[] = [];
    const pick = (opts: { value: string; label: string }[], v: string) => opts.find((o) => o.value === v)?.label ?? v;
    if (applied.type) lines.push({ label: t('filters.type'), value: pick(typeOptions, applied.type) });
    if (applied.shopId) lines.push({ label: t('filters.shop'), value: pick(shopOptions, applied.shopId) });
    if (applied.requester) lines.push({ label: t('filters.requester'), value: applied.requester });
    if (applied.approver) lines.push({ label: t('filters.approver'), value: pick(approvers, applied.approver) });
    if (applied.outcome) lines.push({ label: t('filters.outcome'), value: t(`statuses.${applied.outcome}`) });
    if (applied.reason) lines.push({ label: t('filters.reason'), value: applied.reason });
    return lines;
  }, [applied, approvers, shopOptions, t, typeOptions]);

  // The designed PDF (P:\specs\reports-designed-pdf.md §7): the requests found and those waiting
  // now; with both dates, the count of the days before them (one row is enough for its total).
  const exportKpis: ReportKpi[] = [
    { key: 'requests', label: t('kpi.total'), value: total, kind: 'count', icon: 'receipt' },
    { key: 'pending', label: t('tabs.pending'), value: list.data?.pendingCount ?? null, kind: 'count', icon: 'clock' },
  ];
  const previous = async (): Promise<PreviousPeriod | null> => {
    const before = previousWindow(applied.from || null, applied.to || null);
    if (!before) return null;
    const prev = await fetchApprovals(historyParams({ ...applied, ...before }, { status: 'all', limit: 1 }));
    return { kpis: { requests: prev.total }, ...before };
  };

  const activeCount = activeFilterCount(draft);

  return (
    <div className="space-y-3">
      <Button variant="outline" className="w-full md:hidden" onClick={() => setShowFilters((v) => !v)} aria-expanded={showFilters}>
        <Filter className="size-4" aria-hidden />
        {t('filters.title')}
        {activeCount ? <span className="bg-primary text-primary-foreground rounded-full px-1.5 text-xs">{activeCount}</span> : null}
      </Button>
      <div className={cn('bg-card space-y-3 rounded-lg border p-3', !showFilters && 'max-md:hidden')}>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <FilterSelect
            id="approvals-type"
            label={t('filters.type')}
            value={draft.type}
            onChange={(v) => set({ type: v })}
            options={typeOptions}
            anyLabel={t('filters.allTypes')}
          />
          <FilterSelect
            id="approvals-shop"
            label={t('filters.shop')}
            value={draft.shopId}
            onChange={(v) => set({ shopId: v })}
            options={shopOptions}
            anyLabel={t('filters.allShops')}
          />
          <FilterSelect
            id="approvals-outcome"
            label={t('filters.outcome')}
            value={draft.outcome}
            onChange={(v) => set({ outcome: v })}
            options={statusOptions}
            anyLabel={t('filters.allOutcomes')}
          />
          <FilterSelect
            id="approvals-approver"
            label={t('filters.approver')}
            value={draft.approver}
            onChange={(v) => set({ approver: v })}
            options={approvers}
            anyLabel={t('filters.allApprovers')}
          />
          <div className="min-w-0 space-y-1">
            <Label htmlFor="approvals-requester" className="text-xs">
              {t('filters.requester')}
            </Label>
            <Input
              id="approvals-requester"
              value={draft.requester}
              placeholder={t('filters.requesterPlaceholder')}
              onChange={(e) => set({ requester: e.target.value })}
            />
          </div>
          <div className="min-w-0 space-y-1">
            <Label htmlFor="approvals-reason" className="text-xs">
              {t('filters.reason')}
            </Label>
            <Input
              id="approvals-reason"
              value={draft.reason}
              placeholder={t('filters.reasonPlaceholder')}
              onChange={(e) => set({ reason: e.target.value })}
            />
          </div>
          <div className="min-w-0 space-y-1">
            <Label htmlFor="approvals-from" className="text-xs">
              {t('filters.from')}
            </Label>
            <DatePicker
              id="approvals-from"
              value={draft.from}
              max={draft.to || undefined}
              onValueChange={(v) => set({ from: v })}
              range={{ from: draft.from, to: draft.to, onSelect: (r) => set({ from: r.from, to: r.to }) }}
            />
          </div>
          <div className="min-w-0 space-y-1">
            <Label htmlFor="approvals-to" className="text-xs">
              {t('filters.to')}
            </Label>
            <DatePicker
              id="approvals-to"
              value={draft.to}
              min={draft.from || undefined}
              onValueChange={(v) => set({ to: v })}
              range={{ from: draft.from, to: draft.to, onSelect: (r) => set({ from: r.from, to: r.to }) }}
            />
          </div>
        </div>
        {activeCount ? (
          <Button variant="ghost" size="sm" onClick={() => setDraft(EMPTY_HISTORY_FILTERS)}>
            {t('filters.clear')}
          </Button>
        ) : null}
      </div>

      {list.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : list.isError && !list.data ? (
        <ReportErrorState message={axiosErrorToToastMessage(list.error, tc('error'))} />
      ) : (
        <>
          <StandaloneExportBar
            reportKey="approvals"
            title={t('title')}
            tables={exportTables}
            from={applied.from || null}
            to={applied.to || null}
            place={null}
            filterLines={filterLines}
            disabled={!rows.length}
            reportType="approvals"
            kpis={exportKpis}
            groupBy={['shop', 'till']}
            insightKeys={{ label: 'type', value: 'amount', employee: 'requester' }}
            previous={previous}
          />
          <ReportTable table={table} reportKey="approvals" />
          {total > HISTORY_PAGE ? (
            <div className="flex items-center justify-between gap-2 text-sm">
              <span className="text-muted-foreground">{t('pageOf', { page: page + 1, pages, total })}</span>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" disabled={page <= 0} onClick={() => setPage((p) => p - 1)}>
                  {t('prev')}
                </Button>
                <Button variant="outline" size="sm" disabled={page + 1 >= pages} onClick={() => setPage((p) => p + 1)}>
                  {t('next')}
                </Button>
              </div>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
