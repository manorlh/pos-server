'use client';

/**
 * "יומן חריגות" — every exception the system detected, in one log (`/exception-log`):
 * documents, shift closes and till events (the exceptions report's), Z anomalies, failed
 * card payments, refused documents, kiosk and device alerts, training mode, the terminal
 * check bypass. Filters (dates, company ▸ shop ▸ point of sale ▸ till, kind, severity,
 * employee, handled or not), Excel like the other reports, "טופל" with a note per row, the
 * link to the source document / shift / Z, and the SMS each exception made.
 *
 * An SMS link (`/x/<code>` → `?code=<code>`) opens the one entry it names, whatever its date.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BellRing, Check, CheckCheck, CircleDot, ExternalLink, MessageSquareText, RotateCcw, ScrollText } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { useAuth } from '@/lib/auth';
import { formatCurrency, formatDateTime } from '@/lib/format';
import { daysBackIso, todayIso } from '@/lib/reportWindow';
import { fetchAllPages } from '@/lib/fetchAllPages';
import {
  SEVERITIES,
  dispatchTone,
  logSheet,
  sourceLinks,
  type LogEntry,
  type LogFilters,
  type LogList,
  type LogSummary,
  type Severity,
  type SmsDispatch,
} from '@/lib/exceptionAlerts';
import { acknowledgeLogEntry, fetchLog, fetchLogKinds, fetchLogSummary } from '@/lib/exceptionAlertsApi';
import {
  ALL_COMPANIES,
  EMPTY_ORG_SCOPE,
  OrgScopeCascade,
  type OrgScope,
} from '@/components/dashboard/org-scope-cascade';
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';
import { ReportStatCard } from '@/components/dashboard/report-stat-card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DatePicker } from '@/components/ui/date-picker';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 50;
const ANY = '__any__';

const SEVERITY_TONE: Record<Severity, string> = {
  high: 'bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200',
  medium: 'bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200',
  low: 'bg-slate-200 text-slate-900 dark:bg-slate-800 dark:text-slate-200',
};

const TONE_CLASS = {
  ok: 'border-emerald-300 text-emerald-800 dark:border-emerald-800 dark:text-emerald-300',
  muted: 'border-slate-300 text-slate-700 dark:border-slate-700 dark:text-slate-300',
  warn: 'border-amber-300 text-amber-800 dark:border-amber-800 dark:text-amber-300',
  error: 'border-red-300 text-red-800 dark:border-red-800 dark:text-red-300',
} as const;

function FilterSelect({
  label,
  value,
  onChange,
  options,
  anyLabel,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  anyLabel: string;
}) {
  const items = [{ value: ANY, label: anyLabel }, ...options];
  return (
    <div className="min-w-0 space-y-1">
      <Label className="text-xs">{label}</Label>
      <Select value={value || ANY} onValueChange={(v) => onChange(!v || v === ANY ? '' : String(v))} items={items}>
        <SelectTrigger className="w-full">
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

export default function ExceptionsLogPage() {
  const t = useTranslations('exceptionsLog');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const code = (searchParams.get('code') ?? '').trim().toLowerCase();
  const { user } = useAuth();
  const canHandle = !!user?.role && user.role !== 'cashier' && user.role !== 'shift_supervisor';

  const [scope, setScope] = useState<OrgScope>(EMPTY_ORG_SCOPE);
  const [from, setFrom] = useState(daysBackIso(6));
  const [to, setTo] = useState(todayIso());
  const [kind, setKind] = useState('');
  const [severity, setSeverity] = useState('');
  const [employee, setEmployee] = useState('');
  const [status, setStatus] = useState<'' | 'true' | 'false'>('');
  const [page, setPage] = useState(1);
  const [handling, setHandling] = useState<{ row: LogEntry; acknowledged: boolean; note: string } | null>(null);

  const kinds = useQuery({ queryKey: ['exception-log-kinds'], queryFn: fetchLogKinds, staleTime: 60 * 60 * 1000 });

  const filters: LogFilters | null = useMemo(() => {
    if (code) return { from, to, code };
    if (!from || !to || from > to) return null;
    return {
      from,
      to,
      companyId: scope.companyId && scope.companyId !== ALL_COMPANIES ? scope.companyId : undefined,
      shopId: scope.shopId || undefined,
      areaId: scope.areaId || undefined,
      machineId: scope.machineId || undefined,
      kind: kind || undefined,
      severity: severity || undefined,
      employee: employee || undefined,
      acknowledged: status,
    };
  }, [code, from, to, scope, kind, severity, employee, status]);

  // A filter change is a different list: back to its first page.
  const filterKey = JSON.stringify(filters);
  const [seenKey, setSeenKey] = useState(filterKey);
  if (seenKey !== filterKey) {
    setSeenKey(filterKey);
    setPage(1);
  }

  const list = useQuery<LogList>({
    queryKey: ['exception-log', filters, page],
    queryFn: () => fetchLog(filters!, page, PAGE_SIZE),
    enabled: filters !== null,
    placeholderData: (prev) => prev,
  });
  const summary = useQuery<LogSummary>({
    queryKey: ['exception-log-summary', filters],
    queryFn: () => fetchLogSummary(filters!),
    enabled: filters !== null && !code,
  });

  const handle = useMutation({
    mutationFn: (h: { row: LogEntry; acknowledged: boolean; note: string }) =>
      acknowledgeLogEntry(h.row.id, h.acknowledged, h.note || null),
    onSuccess: () => {
      toast.success(t('saved'));
      setHandling(null);
      qc.invalidateQueries({ queryKey: ['exception-log'] });
      qc.invalidateQueries({ queryKey: ['exception-log-summary'] });
      // The exceptions report's review mirrors "טופל".
      qc.invalidateQueries({ queryKey: ['exceptions'] });
      qc.invalidateQueries({ queryKey: ['exceptions-summary'] });
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const items = list.data?.items ?? [];
  const totalPages = list.data ? Math.max(1, Math.ceil(list.data.total / list.data.pageSize)) : 1;
  const kindOptions = (kinds.data?.kinds ?? []).map((k) => ({ value: k.key, label: k.label }));
  const kindLabel = (key: string) => kinds.data?.kinds.find((k) => k.key === key)?.label ?? key;
  const smsSent = items.reduce((n, r) => n + r.sms.filter((d) => d.kind !== 'test').length, 0);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <ScrollText className="size-6" />
            {t('title')}
          </h1>
          <p className="text-muted-foreground max-w-3xl text-sm">{t('subtitle')}</p>
        </div>
        <div className="flex gap-4 text-sm print:hidden">
          <Link href="/dashboard/exceptions" className="text-primary hover:underline">
            {t('reportLink')}
          </Link>
          {canHandle ? (
            <Link href="/dashboard/exception-alerts" className="text-primary inline-flex items-center gap-1 hover:underline">
              <BellRing className="size-4" />
              {t('alertsLink')}
            </Link>
          ) : null}
        </div>
      </div>

      {code ? (
        <Card className="print:hidden">
          <CardContent className="flex flex-wrap items-center justify-between gap-2 pt-4 text-sm">
            <span>{t('codeFilter')}</span>
            <Button variant="outline" size="sm" onClick={() => router.replace('/dashboard/exceptions-log')}>
              {t('clearCode')}
            </Button>
          </CardContent>
        </Card>
      ) : (
        <Card className="print:hidden">
          <CardContent className="space-y-3 pt-4">
            <OrgScopeCascade value={scope} onChange={setScope} allowAll />
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
              <div className="space-y-1">
                <Label className="text-xs">{t('from')}</Label>
                <DatePicker
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                  range={{ from, to, onSelect: (r) => { setFrom(r.from); setTo(r.to); } }}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t('to')}</Label>
                <DatePicker
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                  range={{ from, to, onSelect: (r) => { setFrom(r.from); setTo(r.to); } }}
                />
              </div>
              <FilterSelect label={t('kind')} value={kind} onChange={setKind} anyLabel={t('allKinds')} options={kindOptions} />
              <FilterSelect
                label={t('severity')}
                value={severity}
                onChange={setSeverity}
                anyLabel={t('allSeverities')}
                options={SEVERITIES.map((s) => ({ value: s, label: t(`severities.${s}`) }))}
              />
              <FilterSelect
                label={t('employee')}
                value={employee}
                onChange={setEmployee}
                anyLabel={t('allEmployees')}
                options={(summary.data?.byEmployee ?? []).map((r) => ({ value: r.key, label: r.label || r.key }))}
              />
              <FilterSelect
                label={t('statusLabel')}
                value={status}
                onChange={(v) => setStatus(v as '' | 'true' | 'false')}
                anyLabel={t('allStatuses')}
                options={[
                  { value: 'false', label: t('open') },
                  { value: 'true', label: t('handled') },
                ]}
              />
            </div>
            {filters === null ? <p className="text-destructive text-xs">{t('badRange')}</p> : null}
          </CardContent>
        </Card>
      )}

      {!code && summary.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : !code && summary.data ? (
        <>
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <ReportStatCard title={t('total')} value={String(summary.data.total)} icon={ScrollText} emphasis />
            <ReportStatCard title={t('openCount')} value={String(summary.data.open)} icon={CircleDot} />
            <ReportStatCard title={t('handledCount')} value={String(summary.data.acknowledged)} icon={CheckCheck} />
            <ReportStatCard title={t('smsSent')} value={String(smsSent)} icon={MessageSquareText} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <CountTable
              title={t('byKind')}
              rows={summary.data.byKind.map((r) => ({ ...r, label: r.label || kindLabel(r.key) }))}
              onPick={(key) => setKind(key)}
              money
            />
            <CountTable
              title={t('byEmployee')}
              rows={summary.data.byEmployee.map((r) => ({ ...r, label: r.label || r.key }))}
              onPick={(key) => setEmployee(key)}
            />
          </div>
        </>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <ReportExportToolbar
          title={t('title')}
          from={from}
          to={to}
          disabled={!items.length}
          // Every entry of these filters, not just this page (the log's largest page is 500).
          getSheets={async () =>
            logSheet(
              await fetchAllPages((p, pageSize) => fetchLog(filters!, p, pageSize), { pageSize: 500 }),
              (k) => t(`col.${k}`),
              t('title'),
              {
                severity: (s) => t(`severities.${s}`),
                acknowledged: (yes) => (yes ? t('acknowledged.yes') : t('acknowledged.no')),
              },
            )
          }
        />
      </div>

      <div className="bg-card rounded-lg border">
        {list.isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full" />
            ))}
          </div>
        ) : list.isError ? (
          <p className="text-destructive p-6 text-center text-sm">{axiosErrorToToastMessage(list.error, tc('error'))}</p>
        ) : items.length === 0 ? (
          <p className="text-muted-foreground p-10 text-center text-sm">{t('empty')}</p>
        ) : (
          <ul className="divide-y">
            {items.map((row) => (
              <LogRow
                key={row.id}
                row={row}
                highlighted={!!code && row.code === code}
                canHandle={canHandle}
                onHandle={(acknowledged) => setHandling({ row, acknowledged, note: row.note ?? '' })}
              />
            ))}
          </ul>
        )}
      </div>

      {list.data && list.data.total > PAGE_SIZE ? (
        <div className="flex items-center justify-between text-sm print:hidden">
          <span className="text-muted-foreground">{t('pageOf', { page, pages: totalPages, total: list.data.total })}</span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
              {t('prev')}
            </Button>
            <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
              {t('next')}
            </Button>
          </div>
        </div>
      ) : null}

      <Dialog open={handling !== null} onOpenChange={(open) => (!open ? setHandling(null) : undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{handling?.acknowledged ? t('handleTitle') : t('reopenTitle')}</DialogTitle>
          </DialogHeader>
          {handling ? (
            <p className="text-muted-foreground text-sm">
              {handling.row.kindLabel} · {formatDateTime(handling.row.occurredAt)}
              {handling.row.amount != null ? ` · ${formatCurrency(handling.row.amount)}` : ''}
            </p>
          ) : null}
          <div className="space-y-2">
            <Label htmlFor="exception-log-note">{t('note')}</Label>
            <textarea
              id="exception-log-note"
              className="border-input bg-background min-h-24 w-full rounded-md border px-3 py-2 text-sm"
              value={handling?.note ?? ''}
              maxLength={2000}
              placeholder={t('notePlaceholder')}
              onChange={(e) => setHandling((h) => (h ? { ...h, note: e.target.value } : h))}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setHandling(null)}>
              {tc('cancel')}
            </Button>
            <Button onClick={() => handling && handle.mutate(handling)} disabled={handle.isPending}>
              {handling?.acknowledged ? t('markHandled') : t('reopen')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CountTable({
  title,
  rows,
  onPick,
  money = false,
}: {
  title: string;
  rows: { key: string; label: string; total: number; open: number; amount?: number }[];
  onPick: (key: string) => void;
  money?: boolean;
}) {
  const t = useTranslations('exceptionsLog');
  return (
    <div className="bg-card rounded-lg border">
      <h2 className="px-4 pt-3 text-sm font-medium">{title}</h2>
      {rows.length === 0 ? (
        <p className="text-muted-foreground px-4 py-6 text-center text-sm">{t('empty')}</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-muted-foreground text-xs">
              <th className="px-4 py-2 text-start font-medium">{t('col.name')}</th>
              <th className="px-2 py-2 text-end font-medium">{t('col.count')}</th>
              <th className="px-2 py-2 text-end font-medium">{t('openCount')}</th>
              {money ? <th className="px-4 py-2 text-end font-medium">{t('col.amount')}</th> : null}
            </tr>
          </thead>
          <tbody className="divide-y">
            {rows.slice(0, 12).map((r) => (
              <tr key={r.key} className="hover:bg-muted/50 cursor-pointer" onClick={() => onPick(r.key)}>
                <td className="px-4 py-2">{r.label}</td>
                <td className="px-2 py-2 text-end tabular-nums">{r.total}</td>
                <td className="px-2 py-2 text-end tabular-nums">{r.open || '—'}</td>
                {money ? (
                  <td className="px-4 py-2 text-end tabular-nums">{r.amount ? formatCurrency(r.amount) : '—'}</td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SmsChip({ d }: { d: SmsDispatch }) {
  const t = useTranslations('exceptionAlerts');
  const kind = d.kind !== 'alert' ? `${t(`dispatchKinds.${d.kind}`)} · ` : '';
  return (
    <span
      className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs', TONE_CLASS[dispatchTone(d.status)])}
      title={[d.ruleName, d.text].filter(Boolean).join('\n')}
    >
      <MessageSquareText className="size-3" />
      {kind}
      {d.statusLabel}
      <span className="opacity-80">· {d.recipientLabel || d.recipient}</span>
    </span>
  );
}

function LogRow({
  row,
  highlighted,
  canHandle,
  onHandle,
}: {
  row: LogEntry;
  highlighted: boolean;
  canHandle: boolean;
  onHandle: (acknowledged: boolean) => void;
}) {
  const t = useTranslations('exceptionsLog');
  const till = [row.machineName, row.posNumber ? t('register', { n: row.posNumber }) : null].filter(Boolean).join(' · ');
  const measure =
    row.value != null && (row.kind === 'discount' || row.kind === 'high_tip') ? `${row.value}%` : null;
  const links = sourceLinks(row);
  return (
    <li className={cn('flex gap-3 px-4 py-3', highlighted && 'bg-amber-50 dark:bg-amber-950/30')}>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap', SEVERITY_TONE[row.severity])}>
            {row.kindLabel}
          </span>
          <Badge variant={row.acknowledged ? 'default' : 'destructive'}>
            {row.acknowledged ? t('handled') : t('open')}
          </Badge>
          {row.severity === 'high' ? <Badge variant="outline">{t('severities.high')}</Badge> : null}
          {row.backfilled ? <Badge variant="secondary">{t('backfilled')}</Badge> : null}
          <span className="text-muted-foreground text-xs">{formatDateTime(row.occurredAt)}</span>
          {row.amount != null ? (
            <span className="ms-auto font-semibold tabular-nums">{formatCurrency(row.amount)}</span>
          ) : null}
        </div>
        <div className="text-sm">
          <span className="font-medium">{row.posUserName || row.posUserId || t('noEmployee')}</span>
          {till ? <span className="text-muted-foreground"> · {till}</span> : null}
          {row.areaName ? <span className="text-muted-foreground"> · {row.areaName}</span> : null}
          {row.shopName ? <span className="text-muted-foreground"> · {row.shopName}</span> : null}
        </div>
        {measure || row.summary ? (
          <div className="text-muted-foreground text-xs">{[measure, row.summary].filter(Boolean).join(' · ')}</div>
        ) : null}
        <div className="flex flex-wrap items-center gap-3 text-xs">
          {links.map((l) => (
            <Link key={l.kind} href={l.href} className="text-primary inline-flex items-center gap-1 hover:underline">
              <ExternalLink className="size-3" />
              {l.kind === 'document'
                ? l.number
                  ? t('document', { n: l.number })
                  : t('openDocument')
                : l.kind === 'shift'
                  ? l.number != null
                    ? t('shift', { n: l.number })
                    : t('openShift')
                  : l.number != null
                    ? t('z', { n: String(l.number) })
                    : t('openZ')}
            </Link>
          ))}
          {row.acknowledged ? (
            <span className="text-muted-foreground">
              {t('handledBy', { who: row.acknowledgedBy ?? '—', at: formatDateTime(row.acknowledgedAt) })}
              {row.note ? ` — ${row.note}` : ''}
            </span>
          ) : null}
        </div>
        {row.sms.length ? (
          <div className="flex flex-wrap gap-1.5">
            {row.sms.map((d) => (
              <SmsChip key={d.id} d={d} />
            ))}
          </div>
        ) : null}
      </div>
      {canHandle ? (
        <div className="flex shrink-0 flex-col gap-1 print:hidden sm:flex-row sm:items-start">
          {row.acknowledged ? (
            <Button size="sm" variant="ghost" onClick={() => onHandle(false)} title={t('reopen')}>
              <RotateCcw className="size-4" />
              <span className="hidden sm:inline">{t('reopen')}</span>
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={() => onHandle(true)} title={t('markHandled')}>
              <Check className="size-4" />
              <span className="hidden sm:inline">{t('markHandled')}</span>
            </Button>
          )}
        </div>
      ) : null}
    </li>
  );
}
