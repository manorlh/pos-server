'use client';

/**
 * "התאמת אשראי מול Z-Credit" (docs/SPEC_ZCREDIT.md "חלק ג׳"): per day and Z-Credit terminal, our
 * card legs against the terminal's own report — transaction by transaction — and its deposits
 * against our transmissions. Matched and unmatched lists with filters, links to our documents,
 * "צור זיכוי" for a charge with no document (through the existing credit flows), "טופל" with a
 * note, and "הרץ התאמה עכשיו".
 *
 * On the report framework (P:\specs\reports-upgrade.md §4.6, §5): the days, the terminal, the open
 * run and the item filters live in the URL (`?from=&to=&terminal=&run=&cats=&open=1&q=`; `date` is
 * the day "הרץ התאמה עכשיו" offers, as the cockpit links it). The runs list loads at once, as it
 * always has. Excel: the runs, and with a run open its category summary, deposits and items (the
 * items as the list shows them — the chosen categories, open only, the search; every one of them,
 * not just the 300 on screen); PDF: the items with a run open, else the runs; with a run open the
 * items' CSV is the export's CSV.
 *
 * Read-only toward Z-Credit; the terminal is shown by its last four digits, a card by its last four.
 * Server: `/zcredit-reconciliation/*`.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Play, RotateCcw, Undo2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { ReportErrorState } from '@/components/dashboard/report-window-summary';
import { Section, SimpleTable } from '@/components/dashboard/report-center/parts';
import { ZCreditCreditDialog } from '@/components/dashboard/zcredit-recon/credit-dialog';
import { ZCreditHandleDialog } from '@/components/dashboard/zcredit-recon/handle-dialog';
import {
  ReportPage,
  ReportTable,
  reportQueryState,
  useReportFilters,
  type ReportColumn,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { canAccess } from '@/lib/dashboardAccess';
import { useDashboardAccess } from '@/lib/dashboardAccessApi';
import { downloadCsv, toCsv } from '@/lib/csv';
import { previousWindow, type PreviousPeriod, type ReportChart, type ReportKpi } from '@/lib/designedReport';
import { EXCEL_FILL, type ExcelCellKind } from '@/lib/excelExport';
import { formatDate, formatDateTime, formatQuantity } from '@/lib/format';
import { parseReportFilters, type ReportFilterSpec } from '@/lib/reportFilters';
import type { ReportFilterLine } from '@/lib/reportExport';
import { todayIso } from '@/lib/reportWindow';
import { usePageScope } from '@/lib/scope';
import {
  CSV_COLUMNS,
  RECON_CATEGORIES,
  SEVERITY_MARK,
  CATEGORY_SEVERITY,
  cardTail,
  countByCategory,
  csvFileName,
  defaultRunDay,
  filterItems,
  itemCsvRecord,
  itemFilterFromParams,
  itemFilterParams,
  itemsCsvRows,
  maskedTerminal,
  type CsvColumn,
  type ItemFilter,
  type ReconCategory,
  type ReconDeposit,
  type ReconItem,
  type ReconRun,
} from '@/lib/zcreditRecon';
import {
  fetchReconRun,
  fetchReconRuns,
  fetchReconTerminals,
  reopenReconItem,
  runReconNow,
} from '@/lib/zcreditReconApi';

const ROW_TONE: Record<string, string | undefined> = {
  error: 'bg-red-50 dark:bg-red-950/30',
  warning: 'bg-amber-50 dark:bg-amber-950/30',
  ok: undefined,
};
/** The same tones in the Excel. */
const ROW_FILL: Record<string, string | null> = {
  error: EXCEL_FILL.missing,
  warning: EXCEL_FILL.difference,
  ok: null,
};
const SCREEN_ROWS = 300;
const ANY = '__any__';

/**
 * Only the days in the bar; the terminal (a server filter), the open run and the item filters
 * (applied on the page) are the report's own.
 */
const SPEC: ReportFilterSpec = {
  filters: [],
  extras: { terminal: '', run: '', cats: '', open: '', q: '' },
};

/** The categories with a card in the designed PDF (the errors first), beside the open errors. */
const KPI_CATEGORIES: ReconCategory[] = ['zcredit_only', 'ours_only', 'amount_mismatch', 'status_mismatch', 'matched'];

/** The runs' (or one run's) open errors and counts per category, by KPI key. */
function reconFigures(runs: readonly ReconRun[]): Record<string, number> {
  const out: Record<string, number> = { openErrors: runs.reduce((s, r) => s + (r.openHard ?? 0), 0) };
  for (const c of RECON_CATEGORIES) out[c] = runs.reduce((s, r) => s + (r.summary[c]?.count ?? 0), 0);
  return out;
}

function CategoryBadge({ category, label }: { category: ReconCategory; label: string }) {
  const severity = CATEGORY_SEVERITY[category];
  return (
    <Badge
      variant={severity === 'error' ? 'destructive' : severity === 'ok' ? 'secondary' : 'outline'}
      className={severity === 'warning' ? 'border-amber-500 text-amber-700 dark:text-amber-400' : undefined}
    >
      {SEVERITY_MARK[severity]} {label}
    </Badge>
  );
}

export default function ZCreditReconciliationPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full" />}>
      <ZCreditReconciliation />
    </Suspense>
  );
}

function ZCreditReconciliation() {
  const t = useTranslations('zcreditRecon');
  const tcommon = useTranslations('common');
  const tf = useTranslations('reportFramework.filters');
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const urlKey = params.toString();
  const access = useDashboardAccess();
  const canEdit = canAccess(access, 'reports', 'edit') || canAccess(access, 'z', 'edit');
  const { resolution, effective } = usePageScope({ maxLevel: 'shop' });
  const shopId = effective.shopId ?? null;
  const filters = useReportFilters(SPEC);
  const today = todayIso();

  // What runs is what the URL says: the runs load at once on the default days (`ready`), and a
  // link from the cockpit (`?run=` / `?terminal=&date=`) opens what it names.
  const url = useMemo(() => parseReportFilters(new URLSearchParams(urlKey), SPEC, today), [urlKey, today]);
  const { from, to } = url.values;
  const terminalKey = url.extras.terminal;
  const selected = url.extras.run || null;
  const urlFilter = useMemo(
    () => itemFilterFromParams({ cats: url.extras.cats, open: url.extras.open, q: url.extras.q }),
    [url.extras.cats, url.extras.open, url.extras.q],
  );

  const [runDay, setRunDay] = useState(() => params.get('date') ?? defaultRunDay(todayIso()));
  const [creditItem, setCreditItem] = useState<ReconItem | null>(null);
  const [handleItem, setHandleItem] = useState<ReconItem | null>(null);

  // The item search narrows as it is typed; the URL follows a moment later (no history entry per key).
  const [search, setSearch] = useState({ text: urlFilter.search, seen: urlFilter.search });
  if (search.seen !== urlFilter.search) {
    // Back / a link: the box shows what the URL says (our own write keeps what is being typed).
    setSearch({
      text: search.text.trim() === urlFilter.search ? search.text : urlFilter.search,
      seen: urlFilter.search,
    });
  }
  const searchTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    },
    [],
  );
  const onSearch = (text: string) => {
    setSearch((s) => ({ ...s, text }));
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      searchTimer.current = null;
      const next = new URLSearchParams(window.location.search);
      if (text.trim()) next.set('q', text.trim());
      else next.delete('q');
      const query = next.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    }, 300);
  };
  const filter: ItemFilter = useMemo(() => ({ ...urlFilter, search: search.text }), [search.text, urlFilter]);

  const terminals = useQuery({
    queryKey: ['zcredit-recon-terminals', shopId],
    queryFn: () => fetchReconTerminals(shopId),
  });
  const runs = useQuery({
    queryKey: ['zcredit-recon-runs', from, to, terminalKey, shopId],
    queryFn: () => fetchReconRuns({ from, to, terminalKey, shopId }),
    enabled: Boolean(from && to && from <= to),
  });
  const detail = useQuery({
    queryKey: ['zcredit-recon-run', selected],
    queryFn: () => fetchReconRun(selected!),
    enabled: !!selected,
  });

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['zcredit-recon-runs'] });
    qc.invalidateQueries({ queryKey: ['zcredit-recon-run'] });
    qc.invalidateQueries({ queryKey: ['zcredit-recon-terminals'] });
    qc.invalidateQueries({ queryKey: ['zcredit-recon-attention'] });
  };

  const apply = filters.apply;
  const selectRun = useCallback((id: string) => apply({ extras: { run: id } }), [apply]);
  /** A chip, "הכל", the switch or a summary row: at once, in the URL (the typed search kept). */
  const applyItemFilter = useCallback(
    (patch: Partial<ItemFilter>) => {
      const next = itemFilterParams({ ...urlFilter, search: search.text, ...patch });
      apply({ extras: { cats: next.cats, open: next.open, q: next.q.trim() } });
    },
    [apply, search.text, urlFilter],
  );

  const runNow = useMutation({
    // The terminal the bar shows (as the select always was).
    mutationFn: () => runReconNow({ date: runDay, terminalKey: filters.draftExtras.terminal || null, shopId }),
    onSuccess: (out) => {
      const failed = out.runs.filter((r) => r.status === 'failed');
      if (failed.length) toast.error(t('runFailed', { message: failed[0].errorMessage ?? '' }));
      else toast.success(t('runDone', { count: out.runs.length }));
      if (out.runs.length === 1) selectRun(out.runs[0].id);
      refresh();
    },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, tcommon('error'))),
  });
  const reopen = useMutation({
    mutationFn: (id: string) => reopenReconItem(id),
    onSuccess: refresh,
    onError: (e) => toast.error(axiosErrorToToastMessage(e, tcommon('error'))),
  });
  const reopenItem = reopen.mutate;
  const reopening = reopen.isPending;

  const terminalItems = useMemo(
    () => [
      { value: ANY, label: t('allTerminals') },
      ...(terminals.data?.terminals ?? []).map((x) => ({
        value: x.key,
        label: `${x.terminal} · ${x.shops.map((s) => s.name).join(', ')}`,
      })),
    ],
    [terminals.data, t],
  );
  const run = detail.data ?? null;
  const counts = useMemo(() => countByCategory(run?.items ?? []), [run]);
  const shown = useMemo(() => filterItems(run?.items ?? [], filter), [run, filter]);
  const toggle = (c: ReconCategory) =>
    applyItemFilter({
      categories: filter.categories.includes(c) ? filter.categories.filter((x) => x !== c) : [...filter.categories, c],
    });
  const runTitle = run ? t('runTitle', { day: formatDate(run.businessDate), terminal: run.terminal }) : null;

  const exportCsv = () => {
    if (!run) return;
    const header = CSV_COLUMNS.map((c) => t(`csv.${c}`));
    const rows = itemsCsvRows(run, shown, {
      header,
      category: (c) => t(`category.${c}`),
      yes: t('yes'),
      no: t('no'),
    });
    downloadCsv(csvFileName(run), toCsv(header, rows));
  };

  // ── The tables: one definition for the screen, Excel and the PDF ──

  const runsTable = useMemo<ReportTableSpec<ReconRun>>(
    () => ({
      id: 'main',
      title: t('runs'),
      rows: runs.data ?? [],
      rowKey: (r) => r.id,
      emptyText: t('noRuns'),
      rowClassName: (r) => (r.id === selected ? 'bg-muted' : r.openHard ? ROW_TONE.error : undefined),
      rowFill: (r) => (r.openHard ? EXCEL_FILL.missing : null),
      columns: [
        {
          key: 'day',
          header: t('cols.day'),
          kind: 'date',
          required: true,
          value: (r) => r.businessDate,
          cell: (r) => (
            <button type="button" className="font-medium hover:underline" onClick={() => selectRun(r.id)}>
              {formatDate(r.businessDate)}
            </button>
          ),
        },
        {
          key: 'terminal',
          header: t('cols.terminal'),
          value: (r) => r.terminal,
          cell: (r) => <span className="font-mono">{r.terminal}</span>,
        },
        {
          key: 'shops',
          header: t('cols.shops'),
          exportOnly: true,
          value: (r) => r.shops.map((s) => s.name).join(', ') || null,
        },
        {
          key: 'status',
          header: t('cols.status'),
          value: (r) => `${t(`status.${r.status}`)} · ${t(`trigger.${r.trigger}`)}`,
          cell: (r) => (
            <span className={r.status === 'failed' ? 'text-destructive' : undefined} title={r.errorMessage ?? undefined}>
              {t(`status.${r.status}`)} · {t(`trigger.${r.trigger}`)}
            </span>
          ),
        },
        ...RECON_CATEGORIES.map(
          (c): ReportColumn<ReconRun> => ({
            key: c,
            header: `${SEVERITY_MARK[CATEGORY_SEVERITY[c]]} ${t(`categoryShort.${c}`)}`,
            kind: 'number',
            value: (r) => r.summary[c]?.count ?? 0,
            cell: (r) => {
              const n = r.summary[c]?.count ?? 0;
              return <span className={n && c !== 'matched' ? 'font-semibold' : 'text-muted-foreground'}>{formatQuantity(n)}</span>;
            },
          }),
        ),
        {
          key: 'openErrors',
          header: t('cols.openErrors'),
          kind: 'number',
          value: (r) => r.openHard ?? 0,
          cell: (r) => (
            <span className={r.openHard ? 'font-bold text-destructive' : undefined}>{formatQuantity(r.openHard ?? 0)}</span>
          ),
        },
        { key: 'finishedAt', header: t('cols.finishedAt'), kind: 'datetime', value: (r) => r.finishedAt },
        { key: 'zcreditRows', header: t('cols.zcreditCount'), kind: 'number', exportOnly: true, value: (r) => r.zcreditRows },
        { key: 'ourLegs', header: t('report.col.ourLegs'), kind: 'number', exportOnly: true, value: (r) => r.ourLegs },
        { key: 'lookups', header: t('report.col.lookups'), kind: 'number', exportOnly: true, value: (r) => r.lookups },
        { key: 'error', header: t('report.col.error'), exportOnly: true, value: (r) => r.errorMessage },
      ],
    }),
    [runs.data, selectRun, selected, t],
  );

  const summaryTable = useMemo<ReportTableSpec<ReconCategory>>(
    () => ({
      id: 'summary',
      title: t('summary'),
      sheetHeading: runTitle ? [runTitle] : undefined,
      rows: RECON_CATEGORIES,
      rowKey: (c) => c,
      emptyText: t('noItems'),
      columns: [
        {
          key: 'category',
          header: t('cols.category'),
          required: true,
          value: (c) => t(`category.${c}`),
          // A click narrows the list to it.
          cell: (c) => (
            <button type="button" className="hover:underline" onClick={() => applyItemFilter({ categories: [c] })}>
              <CategoryBadge category={c} label={t(`category.${c}`)} />
            </button>
          ),
        },
        { key: 'count', header: t('cols.count'), kind: 'number', value: (c) => run?.summary[c]?.count ?? 0 },
        { key: 'zcreditSum', header: t('cols.zcreditSum'), kind: 'money', value: (c) => run?.summary[c]?.zcredit ?? 0 },
        { key: 'oursSum', header: t('cols.oursSum'), kind: 'money', value: (c) => run?.summary[c]?.ours ?? 0 },
      ],
    }),
    [applyItemFilter, run, runTitle, t],
  );

  const depositsTable = useMemo<ReportTableSpec<ReconDeposit>>(
    () => ({
      id: 'deposits',
      title: t('deposits'),
      sheetHeading: runTitle ? [runTitle, t('depositsNote')] : [t('depositsNote')],
      rows: run?.deposits ?? [],
      rowKey: (d, i) => `${d.depositId ?? '—'}:${i}`,
      emptyText: t('noDeposits'),
      rowClassName: (d) => (d.status === 'missing' ? ROW_TONE.error : d.status === 'difference' ? ROW_TONE.warning : undefined),
      rowFill: (d) => (d.status === 'missing' ? EXCEL_FILL.missing : d.status === 'difference' ? EXCEL_FILL.difference : null),
      columns: [
        { key: 'deposit', header: t('cols.deposit'), required: true, value: (d) => d.depositId },
        { key: 'status', header: t('cols.status'), value: (d) => t(`depositStatus.${d.status}`) },
        { key: 'zcreditNet', header: t('cols.zcreditNet'), kind: 'money', value: (d) => d.zcredit?.net ?? null },
        { key: 'zcreditCount', header: t('cols.zcreditCount'), kind: 'number', value: (d) => d.zcredit?.count ?? null },
        { key: 'oursNet', header: t('cols.oursNet'), kind: 'money', value: (d) => d.ours?.legsNet ?? null },
        { key: 'oursCount', header: t('cols.oursCount'), kind: 'number', value: (d) => d.ours?.legsCount ?? null },
        {
          key: 'transmissions',
          header: t('cols.transmissions'),
          className: 'whitespace-normal',
          width: 40,
          value: (d) =>
            (d.ours?.transmissions ?? [])
              .map((x) => `${x.machineName ?? '—'} ${x.startedAt ? formatDateTime(x.startedAt) : ''}`)
              .join(' · ') || null,
        },
        {
          key: 'reason',
          header: t('cols.reason'),
          className: 'min-w-64 whitespace-normal',
          width: 40,
          value: (d) => d.reason,
          cell: (d) => <span className="text-xs">{d.reason}</span>,
        },
      ],
    }),
    [run, runTitle, t],
  );

  const itemsTable = useMemo<ReportTableSpec<ReconItem>>(() => {
    const labels = { category: (c: ReconCategory) => t(`category.${c}`), yes: t('yes'), no: t('no') };
    const records = new Map(run ? shown.map((i) => [i.id, itemCsvRecord(run, i, labels)]) : []);
    const flat = (key: CsvColumn, kind?: ExcelCellKind): ReportColumn<ReconItem> => ({
      key,
      header: t(`csv.${key}`),
      kind,
      exportOnly: true,
      value: (i) => records.get(i.id)?.[key] ?? null,
    });
    // `ours.shopName` is new (§4.6): its column only when the server sends it.
    const hasShop = shown.some((i) => i.ours?.shopName !== undefined);
    const columns: ReportColumn<ReconItem>[] = [
      {
        key: 'category',
        header: t('cols.category'),
        required: true,
        value: (i) => t(`category.${i.category}`),
        cell: (i) => <CategoryBadge category={i.category} label={i.categoryLabel} />,
      },
      { key: 'severity', header: t('csv.severity'), exportOnly: true, value: (i) => t(`report.severity.${i.severity}`) },
      flat('terminal'),
      flat('businessDate', 'date'),
      {
        key: 'zcredit',
        header: t('cols.zcredit'),
        screenOnly: true,
        className: 'whitespace-normal',
        value: (i) => i.zcredit?.reference ?? null,
        cell: (i) =>
          i.zcredit ? (
            <div className="text-xs">
              <div className="font-mono text-sm">{i.zcredit.reference ?? '—'}</div>
              <div>
                {i.zcredit.isRefund ? t('refund') : t('charge')} · {i.zcredit.statusLabel ?? i.zcredit.statusCode ?? '—'}
                {i.zcredit.source === 'lookup' ? ` · ${t('byLookup')}` : ''}
              </div>
              <div className="text-muted-foreground">
                {i.zcredit.savedAt ? i.zcredit.savedAt.replace('T', ' ') : ''}
                {i.zcredit.depositId ? ` · ${t('depositShort', { id: i.zcredit.depositId })}` : ''}
              </div>
            </div>
          ) : (
            '—'
          ),
      },
      flat('zcReference'),
      flat('zcSavedAt', 'datetime'),
      { key: 'zcAmount', header: t('cols.zcreditAmount'), kind: 'money', value: (i) => i.zcredit?.amount ?? null },
      flat('zcStatus'),
      flat('zcDeal'),
      flat('zcDeposit'),
      {
        key: 'card',
        header: t('cols.card'),
        screenOnly: true,
        value: (i) => cardTail(i.zcredit?.cardLast4 ?? i.ours?.cardLast4),
      },
      flat('zcCard'),
      flat('zcPayments', 'number'),
      flat('zcSource'),
      {
        key: 'ourDocument',
        header: t('cols.document'),
        screenOnly: true,
        className: 'whitespace-normal',
        value: (i) => i.ours?.documentNumber ?? null,
        cell: (i) =>
          i.ours?.transactionId ? (
            <div className="text-xs">
              <Link className="text-sm font-medium hover:underline" href={`/dashboard/transactions?tx=${i.ours.transactionId}`}>
                {i.ours.documentNumber ?? '—'}
              </Link>
              <div className="text-muted-foreground">
                {i.ours.machineName ?? ''}
                {i.ours.createdAt ? ` · ${formatDateTime(i.ours.createdAt)}` : ''}
              </div>
              <div className="text-muted-foreground">
                {i.ours.transmitted ? t('transmitted', { batch: i.ours.batch ?? '—' }) : t('notTransmitted')}
              </div>
            </div>
          ) : (
            '—'
          ),
      },
      flat('document'),
      flat('till'),
      ...(hasShop
        ? [
            {
              key: 'shop',
              header: t('report.col.shop'),
              exportOnly: true,
              value: (i: ReconItem) => i.ours?.shopName ?? null,
            } satisfies ReportColumn<ReconItem>,
          ]
        : []),
      { key: 'oursAmount', header: t('cols.oursAmount'), kind: 'money', value: (i) => i.ours?.amount ?? null },
      flat('oursStatus'),
      flat('oursCard'),
      flat('oursCreatedAt', 'datetime'),
      flat('transmitted'),
      flat('batch'),
      {
        key: 'reason',
        header: t('cols.reason'),
        className: 'min-w-72 whitespace-normal',
        width: 40,
        value: (i) => i.reason,
        cell: (i) => <span className="text-xs">{i.reason}</span>,
      },
      {
        key: 'handled',
        header: t('cols.handled'),
        screenOnly: true,
        className: 'min-w-40 whitespace-normal',
        value: (i) => i.handled?.at ?? null,
        cell: (i) =>
          i.handled ? (
            <div className="text-xs">
              <div>{t('handledBy', { by: i.handled.by ?? '—', at: i.handled.at ? formatDateTime(i.handled.at) : '' })}</div>
              {i.handled.note ? <div className="text-muted-foreground">{i.handled.note}</div> : null}
            </div>
          ) : (
            '—'
          ),
      },
      flat('handledAt', 'datetime'),
      flat('handledBy'),
      flat('handledNote'),
    ];
    if (canEdit) {
      columns.push({
        key: 'actions',
        header: t('cols.actions'),
        screenOnly: true,
        sortable: false,
        className: 'min-w-48',
        value: () => null,
        cell: (i) => (
          <div className="flex flex-wrap gap-1">
            {i.canCredit && !i.handled ? (
              <Button size="xs" variant="outline" onClick={() => setCreditItem(i)}>
                <Undo2 className="h-3 w-3" aria-hidden />
                {t('createCredit')}
              </Button>
            ) : null}
            {i.category !== 'matched' && !i.handled ? (
              <Button size="xs" variant="outline" onClick={() => setHandleItem(i)}>
                {t('markHandled')}
              </Button>
            ) : null}
            {i.handled ? (
              <Button size="xs" variant="ghost" onClick={() => reopenItem(i.id)} disabled={reopening}>
                <RotateCcw className="h-3 w-3" aria-hidden />
                {t('reopen')}
              </Button>
            ) : null}
          </div>
        ),
      });
    }
    return {
      id: 'items',
      title: t('items', { count: shown.length }),
      sheetHeading: runTitle && run ? [runTitle, t('runMeta', { rows: run.zcreditRows, legs: run.ourLegs, lookups: run.lookups })] : undefined,
      // Every item the filters leave goes out; the screen shows the first 300 (below).
      rows: shown,
      rowKey: (i) => i.id,
      emptyText: t('noItems'),
      rowClassName: (i) => (i.handled ? 'opacity-60' : ROW_TONE[i.severity]),
      rowFill: (i) => (i.handled ? null : ROW_FILL[i.severity]),
      columns,
    };
  }, [canEdit, reopenItem, reopening, run, runTitle, shown, t]);
  const itemsOnScreen = useMemo(
    () => ({ ...itemsTable, rows: itemsTable.rows.slice(0, SCREEN_ROWS) }),
    [itemsTable],
  );

  const filterLines = useMemo<ReportFilterLine[]>(() => {
    const lines: ReportFilterLine[] = [];
    if (terminalKey) {
      const named = terminals.data?.terminals.find((x) => x.key === terminalKey)?.terminal;
      lines.push({ label: t('terminal'), value: named ?? maskedTerminal(null) });
    }
    if (run && runTitle) {
      // What the items sheet (and the PDF) hold.
      lines.push({ label: t('report.runLine'), value: runTitle });
      const all = filter.categories.length === 0 || filter.categories.length === RECON_CATEGORIES.length;
      lines.push({
        label: t('cols.category'),
        value: all ? t('allCategories') : filter.categories.map((c) => t(`categoryShort.${c}`)).join(', '),
      });
      if (filter.openOnly) lines.push({ label: t('openOnly'), value: t('yes') });
      if (filter.search.trim()) lines.push({ label: tf('search'), value: `"${filter.search.trim()}"` });
    }
    return lines;
  }, [filter, run, runTitle, t, terminalKey, terminals.data, tf]);

  // The designed PDF (P:\specs\reports-designed-pdf.md §7): the open errors and the categories'
  // counts as cards — of the open run, else of every run listed — the categories as bars, and the
  // runs of the period before (an open run's items have no period before).
  const figures = reconFigures(run ? [run] : (runs.data ?? []));
  const kpis: ReportKpi[] = [
    { key: 'openErrors', label: t('kpiOpenErrors'), value: figures.openErrors, kind: 'count', better: 'down', icon: 'alert' },
    ...KPI_CATEGORIES.map(
      (c): ReportKpi => ({
        key: c,
        label: t(`category.${c}`),
        value: figures[c],
        kind: 'count',
        ...(c === 'matched' ? {} : { better: 'down' as const }),
      }),
    ),
  ];
  const chart: ReportChart = {
    type: 'hbar',
    title: t('summary'),
    labels: RECON_CATEGORIES.map((c) => t(`category.${c}`)),
    series: [{ name: t('cols.count'), values: RECON_CATEGORIES.map((c) => figures[c]) }],
    kind: 'number',
  };
  const previous = async (): Promise<PreviousPeriod | null> => {
    const w = run ? null : previousWindow(from, to);
    if (!w) return null;
    const before = await fetchReconRuns({ ...w, terminalKey, shopId });
    return { rows: before, kpis: reconFigures(before), ...w };
  };

  // Terminals, and the Z-Credit tills whose terminal cannot be read.
  const terminalsSection = (
    <Section title={t('terminals')} note={t('terminalsNote')}>
      {terminals.isLoading ? (
        <Skeleton className="m-3 h-16" />
      ) : terminals.isError ? (
        <ReportErrorState message={axiosErrorToToastMessage(terminals.error, tcommon('error'))} />
      ) : (
        <SimpleTable
          empty={t('noTerminals')}
          rows={terminals.data?.terminals ?? []}
          columns={[
            { label: t('cols.terminal'), cell: (x) => <span className="font-mono">{x.terminal}</span> },
            { label: t('cols.shops'), cell: (x) => x.shops.map((s) => s.name).join(', ') || '—' },
            { label: t('cols.tills'), cell: (x) => x.machines.map((m) => m.name).join(', ') || '—', className: 'whitespace-normal' },
            { label: t('cols.nightly'), cell: (x) => (x.enabled ? t('nightlyAt', { time: x.runTime }) : t('nightlyOff')) },
            {
              label: t('cols.lastRun'),
              cell: (x) =>
                x.lastRun ? (
                  <button type="button" className="hover:underline" onClick={() => selectRun(x.lastRun!.id)}>
                    {formatDate(x.lastRun.businessDate)} · {t(`status.${x.lastRun.status}`)}
                  </button>
                ) : (
                  '—'
                ),
            },
          ]}
        />
      )}
      {terminals.data?.problems.length ? (
        <ul className="space-y-1 p-3 text-sm text-destructive">
          {terminals.data.problems.map((p) => (
            <li key={p.machineId}>
              {p.machineName}: {p.message}
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  );

  return (
    <>
      <ReportPage
        reportKey="zcredit-reconciliation"
        title={t('title')}
        subtitle={t('subtitle')}
        headerExtra={terminalsSection}
        resolution={resolution}
        filters={filters}
        bar={{
          hint: t('readOnlyNote'),
          // The terminal, and "הרץ התאמה עכשיו" with its day.
          children: (
            <>
              <div className="min-w-0 space-y-1">
                <Label className="text-xs" htmlFor="zc-terminal">
                  {t('terminal')}
                </Label>
                <select
                  id="zc-terminal"
                  className="border-input bg-background h-9 w-full rounded-md border px-2 text-sm"
                  value={filters.draftExtras.terminal || ANY}
                  onChange={(e) => filters.setExtra('terminal', e.target.value === ANY ? '' : e.target.value)}
                >
                  {terminalItems.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              {canEdit ? (
                <div className="min-w-0 space-y-1">
                  <Label className="text-xs">{t('runDay')}</Label>
                  <div className="flex gap-2">
                    <DatePicker value={runDay} onValueChange={setRunDay} max={todayIso()} />
                    <Button onClick={() => runNow.mutate()} disabled={runNow.isPending || !runDay}>
                      {runNow.isPending ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Play className="h-4 w-4" aria-hidden />}
                      {t('runNow')}
                    </Button>
                  </div>
                </div>
              ) : null}
            </>
          ),
        }}
        query={reportQueryState(runs)}
        ready
        loading="table"
        prompt={t('pickRun')}
        export={
          runs.data
            ? {
                // With a run open, the export names it (the file, the header, the PDF's title).
                title: runTitle ? `${t('title')} · ${runTitle}` : undefined,
                tables: [
                  runsTable as ReportTableSpec<unknown>,
                  ...(run
                    ? [
                        summaryTable as ReportTableSpec<unknown>,
                        depositsTable as ReportTableSpec<unknown>,
                        itemsTable as ReportTableSpec<unknown>,
                      ]
                    : []),
                ],
                pdfTableId: run ? 'items' : 'main',
                filterLines,
                from,
                to,
                // With a run open, the items' CSV the page always offered is the export's CSV.
                csv: run ? exportCsv : undefined,
                reportType: 'zcredit-reconciliation',
                kpis,
                chart,
                previous,
              }
            : null
        }
      >
        {/* Per day and terminal. */}
        <ReportTable table={runsTable} />

        {selected ? (
          detail.isLoading ? (
            <Skeleton className="h-96 w-full" />
          ) : detail.isError ? (
            <ReportErrorState message={axiosErrorToToastMessage(detail.error, tcommon('error'))} />
          ) : run ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold">{runTitle}</h2>
                <span className="text-muted-foreground text-xs">
                  {t('runMeta', { rows: run.zcreditRows, legs: run.ourLegs, lookups: run.lookups })}
                </span>
              </div>
              {run.status === 'failed' ? <p className="text-destructive text-sm">{run.errorMessage}</p> : null}

              {/* Totals per category — a click narrows the list to it. */}
              <ReportTable table={summaryTable} />

              {/* Deposits against our transmissions. */}
              <div className="space-y-1">
                <ReportTable table={depositsTable} />
                <p className="text-muted-foreground text-xs">{t('depositsNote')}</p>
              </div>

              {/* The items, filtered. */}
              <div className="flex flex-wrap items-center gap-2 print:hidden">
                {RECON_CATEGORIES.map((c) => (
                  <Button
                    key={c}
                    size="sm"
                    variant={filter.categories.includes(c) ? 'default' : 'outline'}
                    className="rounded-full"
                    aria-pressed={filter.categories.includes(c)}
                    onClick={() => toggle(c)}
                  >
                    {SEVERITY_MARK[CATEGORY_SEVERITY[c]]} {t(`categoryShort.${c}`)} ({formatQuantity(counts[c] ?? 0)})
                  </Button>
                ))}
                <Button size="sm" variant="ghost" onClick={() => applyItemFilter({ categories: [...RECON_CATEGORIES] })}>
                  {t('allCategories')}
                </Button>
                <label className="ms-2 flex items-center gap-2 text-sm">
                  <Switch checked={filter.openOnly} onCheckedChange={(v) => applyItemFilter({ openOnly: Boolean(v) })} />
                  {t('openOnly')}
                </label>
                <Input
                  className="ms-auto h-8 w-56"
                  value={search.text}
                  placeholder={t('search')}
                  onChange={(e) => onSearch(e.target.value)}
                />
              </div>

              <div className="space-y-1">
                <ReportTable table={itemsOnScreen} />
                {shown.length > SCREEN_ROWS ? (
                  <p className="text-muted-foreground px-4 py-2 text-xs">{t('moreInCsv', { count: shown.length - SCREEN_ROWS })}</p>
                ) : null}
              </div>
            </div>
          ) : null
        ) : (
          <p className="text-muted-foreground py-8 text-center text-sm">{t('pickRun')}</p>
        )}
      </ReportPage>

      <ZCreditCreditDialog
        item={creditItem}
        open={!!creditItem}
        onOpenChange={(o) => !o && setCreditItem(null)}
        onHandle={(i) => {
          setCreditItem(null);
          setHandleItem(i);
        }}
      />
      <ZCreditHandleDialog item={handleItem} open={!!handleItem} onOpenChange={(o) => !o && setHandleItem(null)} onDone={refresh} />
    </>
  );
}
