'use client';

/**
 * "לוגים ממכשירים" — the super admin's page (the device-logs contract, specs/device-logs-api.md
 * §3): every upload of every organization, filtered by organization, branch, device, reason and
 * date, with "חדש" on a manual upload with a note nobody opened yet. View (the first 2000 lines,
 * searchable) and download (.txt / .log.gz) as on the device's page. The server checks the role
 * again (app/services/device_logs.py); the content never reaches anyone else.
 *
 * "ייצוא" (P:\specs\reports-designed-pdf.md §2): the designed PDF, Excel and CSV of the uploads
 * list — every upload the filters match, read page by page (lib/fetchAllPages.ts), never the
 * logs' content.
 */
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';

import { fetchMachines, fetchShops } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { useAuth } from '@/lib/auth';
import type { ReportKpi } from '@/lib/designedReport';
import { LOG_REASONS, rangeLabel, type DeviceLogUpload, type LogFilters, type LogReason } from '@/lib/deviceLogs';
import { fetchDeviceLogs } from '@/lib/deviceLogsApi';
import { EXCEL_FILL } from '@/lib/excelExport';
import { EXPORT_PAGE_SIZE, fetchAllPages } from '@/lib/fetchAllPages';
import type { ReportFilterLine } from '@/lib/reportExport';
import { LogUploadsTable, LogViewerDialog } from '@/components/dashboard/machines/device-logs';
import { StandaloneExportBar, type ReportTableSpec } from '@/components/dashboard/report-framework';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { DatePicker } from '@/components/ui/date-picker';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';

const PAGE = 50;
const ALL = '__all__';

type Option = { value: string; label: string };

function FilterSelect({
  id,
  label,
  value,
  options,
  allLabel,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  options: Option[];
  allLabel: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}) {
  const items = [{ value: ALL, label: allLabel }, ...options];
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      <Select value={value || ALL} onValueChange={(v) => onChange(!v || v === ALL ? '' : String(v))} items={items} disabled={disabled}>
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((i) => (
            <SelectItem key={i.value} value={i.value} label={i.label}>
              {i.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export default function DeviceLogsPage() {
  const t = useTranslations('deviceLogs');
  const authHydrated = useAuth((s) => s.authHydrated);
  const role = useAuth((s) => s.user?.role);

  if (!authHydrated) return <Skeleton className="h-40 w-full" />;
  if (role !== 'super_admin') {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">{t('page.title')}</h1>
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">{t('page.noPermission')}</CardContent>
        </Card>
      </div>
    );
  }
  return <DeviceLogsBrowser />;
}

function DeviceLogsBrowser() {
  const t = useTranslations('deviceLogs');
  const tenants = useAuth((s) => s.tenants);
  const activeTenantId = useAuth((s) => s.activeTenantId);
  const [tenantId, setTenantId] = useState('');
  const [shopId, setShopId] = useState('');
  const [machineId, setMachineId] = useState('');
  const [reason, setReason] = useState<LogReason | ''>('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [onlyNew, setOnlyNew] = useState(false);
  const [offset, setOffset] = useState(0);
  const [viewing, setViewing] = useState<DeviceLogUpload | null>(null);

  // Branches and devices come from the active organization's lists (the scope bar's).
  const inActiveOrg = !tenantId || tenantId === activeTenantId;
  const shops = useQuery({ queryKey: ['shops'], queryFn: () => fetchShops(), enabled: inActiveOrg });
  const machines = useQuery({ queryKey: ['machines'], queryFn: fetchMachines, enabled: inActiveOrg });

  const filters: LogFilters = {
    tenantId: tenantId || (shopId || machineId ? activeTenantId : null),
    shopId: inActiveOrg ? shopId || null : null,
    machineId: inActiveOrg ? machineId || null : null,
    reason: reason || null,
    dateFrom: dateFrom || null,
    dateTo: dateTo || null,
    onlyNew,
    limit: PAGE,
    offset,
  };
  const list = useQuery({
    queryKey: ['device-logs', 'list', filters],
    queryFn: () => fetchDeviceLogs(filters),
    placeholderData: (prev) => prev,
  });

  const reset = (fn: () => void) => {
    fn();
    setOffset(0);
  };
  const shopOptions = (shops.data ?? []).map((s) => ({ value: s.id, label: s.name }));
  const machineOptions = (machines.data ?? [])
    .filter((m) => !shopId || m.shopId === shopId)
    .map((m) => ({ value: m.id, label: m.name }));
  const total = list.data?.total ?? 0;

  // ── "ייצוא": every upload the filters match (page after page at the API's 200), not the page shown ──
  const tc = useTranslations('common');
  const exportFilters = useMemo<LogFilters>(
    () => ({
      tenantId: tenantId || (shopId || machineId ? activeTenantId : null),
      shopId: inActiveOrg ? shopId || null : null,
      machineId: inActiveOrg ? machineId || null : null,
      reason: reason || null,
      dateFrom: dateFrom || null,
      dateTo: dateTo || null,
      onlyNew,
    }),
    [activeTenantId, dateFrom, dateTo, inActiveOrg, machineId, onlyNew, reason, shopId, tenantId],
  );
  const pageRows = list.data?.items;
  const exportTable = useMemo<ReportTableSpec<DeviceLogUpload>>(
    () => ({
      id: 'main',
      title: t('page.title'),
      rows: pageRows ?? [],
      rowKey: (u) => u.id,
      rowFill: (u) => (u.reason === 'crash' ? EXCEL_FILL.missing : u.isNew ? EXCEL_FILL.info : null),
      exportRows: () =>
        fetchAllPages(async (page, pageSize) => {
          const d = await fetchDeviceLogs({ ...exportFilters, limit: pageSize, offset: (page - 1) * pageSize });
          return { items: d.items, total: d.total };
        }, { pageSize: EXPORT_PAGE_SIZE }),
      columns: [
        { key: 'receivedAt', header: t('col.time'), kind: 'datetime', required: true, value: (u) => u.receivedAt },
        { key: 'device', header: t('col.device'), width: 18, value: (u) => u.machineName ?? u.machineId.slice(0, 8) },
        { key: 'pos', header: t('export.pos'), width: 8, value: (u) => u.posNumber },
        { key: 'org', header: t('col.org'), width: 16, value: (u) => u.tenantName },
        { key: 'branch', header: t('col.branch'), width: 16, value: (u) => u.branchName },
        { key: 'reason', header: t('col.reason'), width: 10, value: (u) => t(`reason.${u.reason}`) },
        { key: 'isNew', header: t('new'), width: 6, value: (u) => (u.isNew ? tc('yes') : null) },
        { key: 'version', header: t('col.version'), width: 12, value: (u) => u.appVersion },
        { key: 'model', header: t('export.model'), width: 14, defaultHidden: true, value: (u) => u.deviceModel },
        { key: 'os', header: t('export.os'), width: 12, defaultHidden: true, value: (u) => u.os },
        { key: 'range', header: t('col.range'), width: 24, value: (u) => (u.fromMs != null && u.toMs != null ? rangeLabel(u.fromMs, u.toMs) : null) },
        { key: 'lines', header: t('export.lines'), kind: 'number', defaultHidden: true, value: (u) => u.lineCount },
        { key: 'sizeKb', header: t('export.sizeKb'), kind: 'number', value: (u) => Math.round((u.sizeBytes / 1024) * 10) / 10 },
        { key: 'note', header: t('col.note'), width: 30, value: (u) => u.note },
        { key: 'requestedBy', header: t('col.requestedBy'), width: 14, value: (u) => u.requestedBy },
        { key: 'openedBy', header: t('export.openedBy'), width: 14, defaultHidden: true, value: (u) => u.openedBy },
      ],
    }),
    [exportFilters, pageRows, t, tc],
  );
  const exportKpis: ReportKpi[] = list.data
    ? [
        { key: 'uploads', label: t('export.uploads'), value: list.data.total, kind: 'count', icon: 'box' },
        { key: 'newUploads', label: t('export.newUploads'), value: list.data.newCount, kind: 'count', icon: 'alert' },
      ]
    : [];
  // By reason only when the page holds every upload: a chart of one page would read as the whole.
  const allShown = !!pageRows && total <= PAGE;
  const byReason = LOG_REASONS.map((r) => ({ r, n: (pageRows ?? []).filter((u) => u.reason === r).length })).filter((x) => x.n > 0);
  const exportChart =
    allShown && byReason.length
      ? {
          type: 'donut' as const,
          title: t('col.reason'),
          labels: byReason.map((x) => t(`reason.${x.r}`)),
          series: [{ name: t('export.uploads'), values: byReason.map((x) => x.n) }],
          kind: 'number' as const,
        }
      : null;
  const exportPlace =
    [
      tenantId ? tenants.find((x) => x.id === tenantId)?.name : null,
      shopId ? shopOptions.find((o) => o.value === shopId)?.label : null,
      machineId ? (machines.data ?? []).find((m) => m.id === machineId)?.name : null,
    ]
      .filter(Boolean)
      .join(' · ') || null;
  const exportLines: ReportFilterLine[] = [
    ...(reason ? [{ label: t('filters.reason'), value: t(`reason.${reason}`) }] : []),
    ...(onlyNew ? [{ label: t('filters.onlyNew'), value: tc('yes') }] : []),
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">{t('page.title')}</h1>
          <p className="text-sm text-muted-foreground">{t('page.subtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {list.data ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <span>{t('page.count', { total })}</span>
              {list.data.newCount > 0 ? <Badge>{t('page.newCount', { count: list.data.newCount })}</Badge> : null}
            </div>
          ) : null}
          <StandaloneExportBar
            reportKey="device-logs"
            reportType="exceptions.device-logs"
            title={t('page.title')}
            tables={[exportTable as ReportTableSpec<unknown>]}
            from={dateFrom || null}
            to={dateTo || null}
            place={exportPlace}
            filterLines={exportLines}
            kpis={exportKpis}
            chart={exportChart}
            disabled={!list.data || total === 0}
          />
        </div>
      </div>

      <Card>
        <CardContent className="grid grid-cols-1 gap-3 pt-4 sm:grid-cols-2 lg:grid-cols-4">
          <FilterSelect
            id="dl-org"
            label={t('filters.org')}
            value={tenantId}
            allLabel={t('filters.allOrgs')}
            options={tenants.map((x) => ({ value: x.id, label: x.name }))}
            onChange={(v) =>
              reset(() => {
                setTenantId(v);
                if (v && v !== activeTenantId) {
                  setShopId('');
                  setMachineId('');
                }
              })
            }
          />
          <FilterSelect
            id="dl-branch"
            label={t('filters.branch')}
            value={shopId}
            allLabel={t('filters.allBranches')}
            options={shopOptions}
            disabled={!inActiveOrg}
            onChange={(v) =>
              reset(() => {
                setShopId(v);
                setMachineId('');
              })
            }
          />
          <FilterSelect
            id="dl-device"
            label={t('filters.device')}
            value={machineId}
            allLabel={t('filters.allDevices')}
            options={machineOptions}
            disabled={!inActiveOrg}
            onChange={(v) => reset(() => setMachineId(v))}
          />
          <FilterSelect
            id="dl-reason"
            label={t('filters.reason')}
            value={reason}
            allLabel={t('filters.allReasons')}
            options={LOG_REASONS.map((r) => ({ value: r, label: t(`reason.${r}`) }))}
            onChange={(v) => reset(() => setReason((v as LogReason) || ''))}
          />
          <div className="space-y-1">
            <Label htmlFor="dl-from">{t('filters.from')}</Label>
            <DatePicker
              id="dl-from"
              value={dateFrom}
              max={dateTo || undefined}
              onValueChange={(v) => reset(() => setDateFrom(v))}
              range={{ from: dateFrom, to: dateTo, onSelect: (r) => reset(() => { setDateFrom(r.from); setDateTo(r.to); }) }}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="dl-to">{t('filters.to')}</Label>
            <DatePicker
              id="dl-to"
              value={dateTo}
              min={dateFrom || undefined}
              onValueChange={(v) => reset(() => setDateTo(v))}
              range={{ from: dateFrom, to: dateTo, onSelect: (r) => reset(() => { setDateFrom(r.from); setDateTo(r.to); }) }}
            />
          </div>
          <div className="flex items-end gap-2 pb-1">
            <Switch id="dl-new" checked={onlyNew} onCheckedChange={(v) => reset(() => setOnlyNew(!!v))} />
            <Label htmlFor="dl-new">{t('filters.onlyNew')}</Label>
          </div>
          <div className="flex items-end justify-end">
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                reset(() => {
                  setTenantId('');
                  setShopId('');
                  setMachineId('');
                  setReason('');
                  setDateFrom('');
                  setDateTo('');
                  setOnlyNew(false);
                })
              }
            >
              {t('filters.clear')}
            </Button>
          </div>
          {!inActiveOrg ? <p className="col-span-full text-xs text-muted-foreground">{t('filters.activeOrgOnly')}</p> : null}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {list.isLoading ? (
            <div className="p-4">
              <Skeleton className="h-24 w-full" />
            </div>
          ) : list.isError ? (
            <p className="p-4 text-sm text-destructive">{axiosErrorToToastMessage(list.error, t('loadFailed'))}</p>
          ) : (list.data?.items ?? []).length === 0 ? (
            <p className="p-6 text-center text-sm text-muted-foreground">{t('page.empty')}</p>
          ) : (
            <LogUploadsTable rows={list.data?.items ?? []} onView={setViewing} showDevice />
          )}
        </CardContent>
      </Card>

      {total > PAGE ? (
        <div className="flex items-center justify-center gap-2">
          <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE))}>
            {t('page.prev')}
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums">
            {offset + 1}–{Math.min(offset + PAGE, total)} / {total}
          </span>
          <Button variant="outline" size="sm" disabled={offset + PAGE >= total} onClick={() => setOffset(offset + PAGE)}>
            {t('page.next')}
          </Button>
        </div>
      ) : null}

      <LogViewerDialog upload={viewing} onOpenChange={(open) => !open && setViewing(null)} />
    </div>
  );
}
