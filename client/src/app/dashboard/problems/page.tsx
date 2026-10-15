'use client';

/**
 * "בעיות" — everything that needs a manager now, on one screen built for the phone (pos-server
 * `GET /problems`, app/services/problems.py; P:/specs/manager-problems.md §3): the open problems
 * counted by severity, then fixed groups — devices, Z and shifts, card, kitchen, and data
 * integrity (the super admin's only). Each card says what, where (shop · till) and since when,
 * links to the page that deals with it, and offers "טופל" when it is a row of the exceptions log.
 *
 * A group can be hidden (kept on the user, every device: `PUT /problems/preferences`); refreshed
 * every 30 seconds. A tap on a phone alert lands here on its own card (`?focus=<log row>`, and
 * `&code=` for the log entry should it be handled by then).
 *
 * "ייצוא" (P:\specs\reports-designed-pdf.md §2): the designed PDF, Excel and CSV of the problems
 * open now — the shown groups' cards, the counts by severity and the groups as a chart.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  OctagonAlert,
  Check,
  ChefHat,
  ChevronLeft,
  CircleCheck,
  CreditCard,
  Eye,
  EyeOff,
  FileWarning,
  Monitor,
  RefreshCw,
  Siren,
  type LucideIcon,
} from 'lucide-react';
import { usePageScope } from '@/lib/scope';
import { formatShortDate, formatTimeAgo } from '@/lib/format';
import { EXCEL_FILL } from '@/lib/excelExport';
import type { ReportChart, ReportKpi } from '@/lib/designedReport';
import type { ReportFilterLine } from '@/lib/reportExport';
import {
  PROBLEM_SEVERITIES,
  findFocus,
  isDayOnly,
  placeOf,
  sinceDate,
  toggleHidden,
  withHidden,
  withoutItem,
  type ProblemGroup,
  type ProblemGroupKey,
  type ProblemItem,
  type ProblemSeverity,
  type ProblemsResponse,
} from '@/lib/problems';
import { problemsKey, resolveProblem, saveProblemsHidden, useCanSeeProblems, useProblems } from '@/lib/problemsApi';
import { cn } from '@/lib/utils';
import { Card, InsightsSurface, Muted, SkeletonCard } from '@/components/dashboard/insights/ios';
import { StandaloneExportBar, type ReportTableSpec } from '@/components/dashboard/report-framework';
import { Button } from '@/components/ui/button';

const SEVERITY_COLOR: Record<ProblemSeverity, string> = { high: '#FF3B30', medium: '#FF9500', low: '#8E8E93' };
const SEVERITY_TILE: Record<ProblemSeverity, string> = {
  high: 'bg-[#FF3B30]/10 text-[#D70015] dark:bg-[#FF453A]/20 dark:text-[#FF6961]',
  medium: 'bg-[#FF9500]/12 text-[#C93400] dark:bg-[#FF9F0A]/20 dark:text-[#FFB340]',
  low: 'bg-[#8E8E93]/15 text-[#3C3C43] dark:bg-[#8E8E93]/25 dark:text-[#D1D1D6]',
};
const GROUP_ICON: Record<ProblemGroupKey, LucideIcon> = {
  devices: Monitor,
  z_shift: FileWarning,
  card: CreditCard,
  kitchen: ChefHat,
  integrity: OctagonAlert,
};

export default function ProblemsPage() {
  const t = useTranslations('problems');
  const qc = useQueryClient();
  const params = useSearchParams();
  const focus = params.get('focus');
  const focusCode = (params.get('code') ?? '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 16);
  const allowed = useCanSeeProblems();
  const { effective, scope: shared } = usePageScope({ maxLevel: 'shop', silent: true });
  const scope = { companyId: effective.companyId ?? null, shopId: effective.shopId ?? null };
  const key = problemsKey(scope);
  const query = useProblems(scope);
  const data = query.data;
  // Hidden groups opened for a look (a push alert's group opens by itself).
  const [opened, setOpened] = useState<Set<ProblemGroupKey>>(new Set());

  const hide = useMutation({
    mutationFn: (hidden: ProblemGroupKey[]) => saveProblemsHidden(hidden),
    onMutate: async (hidden) => {
      await qc.cancelQueries({ queryKey: ['problems'] });
      qc.setQueriesData<ProblemsResponse>({ queryKey: ['problems'] }, (old) => (old ? withHidden(old, hidden) : old));
    },
    onError: () => toast.error(t('hideFailed')),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['problems'] }),
  });

  const resolve = useMutation({
    mutationFn: (item: ProblemItem) => resolveProblem(item),
    onMutate: async (item) => {
      await qc.cancelQueries({ queryKey: ['problems'] });
      const before = qc.getQueryData<ProblemsResponse>(key);
      qc.setQueriesData<ProblemsResponse>({ queryKey: ['problems'] }, (old) => (old ? withoutItem(old, item.id) : old));
      return { before };
    },
    onSuccess: () => {
      toast.success(t('resolved'));
      void qc.invalidateQueries({ queryKey: ['alerts-feed'] });
      void qc.invalidateQueries({ queryKey: ['exception-log'] });
    },
    onError: (_err, _item, ctx) => {
      if (ctx?.before) qc.setQueryData(key, ctx.before);
      toast.error(t('resolveFailed'));
    },
    onSettled: () => void qc.invalidateQueries({ queryKey: ['problems'] }),
  });

  const focused = useMemo(() => findFocus(data, focus), [data, focus]);
  const focusedGroup = focused?.group ?? null;
  const focusedId = focused?.item.id ?? null;
  const scrolled = useRef<string | null>(null);
  useEffect(() => {
    if (!focusedId || scrolled.current === focusedId) return;
    scrolled.current = focusedId;
    // After the card has rendered (its group is open even when hidden: `open` below).
    requestAnimationFrame(() =>
      document.getElementById(`problem-${focusedId}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }),
    );
  }, [focusedId]);

  if (!allowed) {
    return (
      <InsightsSurface>
        <h1 className="px-1 text-[28px] font-bold leading-tight tracking-tight">{t('title')}</h1>
        <Card className="mt-4">
          <p className="font-medium">{t('noPermission')}</p>
        </Card>
      </InsightsSurface>
    );
  }

  const hidden = data?.hiddenGroups ?? [];
  const setHidden = (group: ProblemGroupKey) => hide.mutate(toggleHidden(hidden, group));

  return (
    <InsightsSurface>
      <div className="flex flex-wrap items-end justify-between gap-3 px-1">
        <div className="min-w-0 space-y-1">
          <h1 className="flex items-center gap-2 text-[28px] font-bold leading-tight tracking-tight">
            <Siren className="size-7 text-[#FF3B30]" aria-hidden />
            {t('title')}
          </h1>
          <Muted>{t('subtitle')}</Muted>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ProblemsExport data={data} place={effective.shopId ? (shared.shop?.name ?? null) : null} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
            aria-label={t('refresh')}
          >
            <RefreshCw className={cn('size-4', query.isFetching && 'animate-spin')} aria-hidden />
            <span className="max-sm:sr-only">{t('refresh')}</span>
          </Button>
        </div>
      </div>

      {/* The open problems by severity: red, orange, grey. */}
      <div className="mt-4 grid grid-cols-3 gap-2" role="group" aria-label={t('countsLabel')}>
        {PROBLEM_SEVERITIES.map((s) => (
          <div key={s} className={cn('rounded-[18px] px-3 py-3 text-center', SEVERITY_TILE[s])}>
            <div className="text-[28px] font-bold leading-none tabular-nums">
              {data ? data.counts[s] : '–'}
            </div>
            <div className="mt-1 text-[13px] font-medium">{t(`severity.${s}`)}</div>
          </div>
        ))}
      </div>
      {query.dataUpdatedAt > 0 ? (
        <Muted className="mt-2 px-1 text-xs">
          {t('updated', { ago: formatTimeAgo(query.dataUpdatedAt) })} · {t('autoRefresh')}
        </Muted>
      ) : null}

      {focus && data && !focused && !(resolve.variables?.exceptionId === focus && !resolve.isError) ? (
        <Card className="mt-4 border border-[#FF9500]/40">
          <p className="font-medium">{t('focusGone')}</p>
          {focusCode ? (
            <Link href={`/x/${focusCode}`} className="mt-1 inline-flex min-h-10 items-center text-sm font-medium text-[#007AFF]">
              {t('focusGoneLink')}
            </Link>
          ) : null}
        </Card>
      ) : null}

      <div className="mt-5 space-y-5">
        {query.isPending ? (
          <>
            <SkeletonCard className="h-28" />
            <SkeletonCard className="h-28" />
          </>
        ) : query.isError && !data ? (
          <Card>
            <p className="font-medium">{t('loadFailed')}</p>
            <Button className="mt-3" size="sm" variant="outline" onClick={() => void query.refetch()}>
              {t('retry')}
            </Button>
          </Card>
        ) : data ? (
          <>
            {data.total === 0 && data.groups.every((g) => g.hidden || g.total === 0) ? (
              <Card className="flex items-center gap-3">
                <CircleCheck className="size-8 shrink-0 text-[#34C759]" aria-hidden />
                <div>
                  <p className="font-semibold">{t('empty')}</p>
                  <Muted className="text-sm">{t('emptyHint')}</Muted>
                </div>
              </Card>
            ) : null}
            {data.groups.map((g) => (
              <GroupSection
                key={g.key}
                group={g}
                open={!g.hidden || opened.has(g.key) || g.key === focusedGroup}
                focusId={focusedId}
                onToggleHidden={() => setHidden(g.key)}
                onPeek={() => setOpened((prev) => new Set(prev).add(g.key))}
                onResolve={(item) => resolve.mutate(item)}
                resolving={resolve.isPending ? resolve.variables?.id ?? null : null}
              />
            ))}
          </>
        ) : null}
      </div>
    </InsightsSurface>
  );
}

type ExportRow = { group: ProblemGroupKey; item: ProblemItem };

/**
 * "ייצוא": a snapshot of the screen as it stands — the problems open now (the screen refreshes
 * every 30 seconds), the counts by severity as the tiles show them, and every group that is not
 * hidden with its cards. A hidden group is left out, as the counts leave it out; a group that
 * lists only its first cards says how many more it has, as the screen does.
 */
function ProblemsExport({ data, place }: { data: ProblemsResponse | undefined; place: string | null }) {
  const t = useTranslations('problems');
  const shown = useMemo(() => (data?.groups ?? []).filter((g) => !g.hidden), [data]);
  const table = useMemo<ReportTableSpec<ExportRow>>(
    () => ({
      id: 'main',
      title: t('title'),
      rows: shown.flatMap((g) => g.items.map((item) => ({ group: g.key, item }))),
      rowKey: (r) => r.item.id,
      rowFill: (r) => (r.item.severity === 'high' ? EXCEL_FILL.missing : r.item.severity === 'medium' ? EXCEL_FILL.difference : null),
      columns: [
        { key: 'group', header: t('export.group'), width: 14, value: (r) => t(`groups.${r.group}`) },
        { key: 'severity', header: t('export.severity'), width: 10, value: (r) => t(`severity.${r.item.severity}`) },
        { key: 'problem', header: t('export.problem'), width: 34, required: true, value: (r) => r.item.title },
        { key: 'detail', header: t('export.detail'), width: 40, value: (r) => r.item.detail },
        { key: 'shop', header: t('export.shop'), width: 18, value: (r) => r.item.shopName },
        {
          key: 'till',
          header: t('export.till'),
          width: 14,
          value: (r) => r.item.machineName || (r.item.posNumber ? t('register', { n: r.item.posNumber }) : null),
        },
        // A plain day ("2026-10-11") for a problem of a business day; Excel shows it as that day.
        { key: 'since', header: t('export.since'), kind: 'datetime', value: (r) => r.item.since },
      ],
    }),
    [shown, t],
  );
  const kpis: ReportKpi[] = data
    ? [
        { key: 'problems', label: t('export.total'), value: data.total, kind: 'count', icon: 'alert', better: 'down' },
        ...PROBLEM_SEVERITIES.map(
          (s): ReportKpi => ({ key: `severity_${s}`, label: t(`export.${s}`), value: data.counts[s], kind: 'count', better: 'down' }),
        ),
      ]
    : [];
  const chart: ReportChart | null = shown.length
    ? {
        type: 'donut',
        title: t('export.byGroup'),
        labels: shown.map((g) => t(`groups.${g.key}`)),
        series: [{ name: t('export.total'), values: shown.map((g) => g.total) }],
        kind: 'number',
      }
    : null;
  const notListed = shown.reduce((n, g) => n + Math.max(0, g.total - g.items.length), 0);
  const hiddenNames = (data?.groups ?? []).filter((g) => g.hidden).map((g) => t(`groups.${g.key}`));
  const filterLines: ReportFilterLine[] = [
    ...(hiddenNames.length ? [{ label: t('export.hiddenGroups'), value: hiddenNames.join(', ') }] : []),
    ...(notListed > 0 ? [{ label: t('export.listLabel'), value: t('export.notListed', { n: notListed }) }] : []),
  ];
  return (
    <StandaloneExportBar
      reportKey="problems"
      reportType="exceptions.problems"
      title={t('title')}
      tables={[table as ReportTableSpec<unknown>]}
      place={place}
      filterLines={filterLines}
      kpis={kpis}
      chart={chart}
      disabled={!data}
    />
  );
}

function GroupSection({
  group,
  open,
  focusId,
  onToggleHidden,
  onPeek,
  onResolve,
  resolving,
}: {
  group: ProblemGroup;
  open: boolean;
  focusId: string | null;
  onToggleHidden: () => void;
  onPeek: () => void;
  onResolve: (item: ProblemItem) => void;
  resolving: string | null;
}) {
  const t = useTranslations('problems');
  const Icon = GROUP_ICON[group.key] ?? Monitor;
  const headingId = `problems-group-${group.key}`;
  return (
    <section aria-labelledby={headingId} className="space-y-2">
      <div className="flex items-center justify-between gap-2 px-1">
        <h2 id={headingId} className="flex min-w-0 items-center gap-2 text-[17px] font-semibold">
          <Icon className="size-5 shrink-0 text-[#007AFF]" aria-hidden />
          <span className="truncate">{t(`groups.${group.key}`)}</span>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-xs font-semibold tabular-nums',
              group.total > 0 ? 'bg-[#FF3B30] text-white' : 'bg-[#7676801F] text-[#6D6D72] dark:text-[#8E8E93]',
            )}
          >
            {group.total}
          </span>
          {group.key === 'integrity' ? (
            <span className="text-xs font-normal text-[#6D6D72] dark:text-[#8E8E93]">{t('superAdminOnly')}</span>
          ) : null}
        </h2>
        <Button
          variant="ghost"
          size="sm"
          className="min-h-10 shrink-0"
          onClick={onToggleHidden}
          aria-pressed={group.hidden}
          title={group.hidden ? t('show') : t('hide')}
        >
          {group.hidden ? <Eye className="size-4" aria-hidden /> : <EyeOff className="size-4" aria-hidden />}
          {group.hidden ? t('show') : t('hide')}
        </Button>
      </div>

      {!open ? (
        <button
          type="button"
          onClick={onPeek}
          className="flex min-h-11 w-full items-center justify-between rounded-[18px] bg-white px-4 py-2 text-start text-sm text-[#6D6D72] dark:bg-[#1C1C1E] dark:text-[#8E8E93]"
        >
          <span>{t('hiddenGroup', { n: group.total })}</span>
          <ChevronLeft className="size-4" aria-hidden />
        </button>
      ) : group.items.length === 0 ? (
        <Card className="py-3">
          <Muted className="text-sm">{t('groupEmpty')}</Muted>
        </Card>
      ) : (
        <ul className="space-y-2">
          {group.items.map((item) => (
            <ProblemCard
              key={item.id}
              item={item}
              focused={item.id === focusId}
              onResolve={() => onResolve(item)}
              resolving={resolving === item.id}
            />
          ))}
          {group.total > group.items.length ? (
            <li>
              <Muted className="px-2 text-xs">{t('more', { n: group.total - group.items.length })}</Muted>
            </li>
          ) : null}
        </ul>
      )}
    </section>
  );
}

function ProblemCard({
  item,
  focused,
  onResolve,
  resolving,
}: {
  item: ProblemItem;
  focused: boolean;
  onResolve: () => void;
  resolving: boolean;
}) {
  const t = useTranslations('problems');
  const place = placeOf(item, (n) => t('register', { n }));
  const day = isDayOnly(item.since) ? sinceDate(item.since) : null;
  const since = day ? t('sinceDay', { day: formatShortDate(day) }) : item.since ? formatTimeAgo(item.since) : null;
  return (
    <li
      id={`problem-${item.id}`}
      className={cn(
        'scroll-mt-24 rounded-[18px] bg-white p-3.5 shadow-[0_1px_2px_rgba(0,0,0,0.04)] dark:bg-[#1C1C1E] dark:shadow-none',
        focused && 'ring-2 ring-[#007AFF]',
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className="mt-1.5 size-2.5 shrink-0 rounded-full"
          style={{ background: SEVERITY_COLOR[item.severity] }}
          aria-label={t(`severity.${item.severity}`)}
          role="img"
        />
        <div className="min-w-0 flex-1">
          <p className="font-semibold leading-snug break-words">{item.title}</p>
          {item.detail ? <p className="mt-0.5 text-sm break-words text-[#3C3C43] dark:text-[#EBEBF5]">{item.detail}</p> : null}
          <Muted className="mt-1 text-xs">{[place, since].filter(Boolean).join(' · ')}</Muted>
        </div>
      </div>
      {item.link || item.resolvable ? (
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          {item.link ? (
            <Link
              href={item.link}
              className="inline-flex min-h-10 items-center gap-1 rounded-full px-3 text-sm font-medium text-[#007AFF] hover:bg-[#007AFF]/10"
            >
              {t('open')}
              <ChevronLeft className="size-4" aria-hidden />
            </Link>
          ) : null}
          {item.resolvable ? (
            <Button size="sm" variant="outline" className="min-h-10 rounded-full" onClick={onResolve} disabled={resolving}>
              <Check className="size-4" aria-hidden />
              {t('resolve')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
