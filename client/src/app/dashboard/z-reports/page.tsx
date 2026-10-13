'use client';

/**
 * Z reports (דוחות Z) — one per shop per run, built in the cloud from the documents of
 * the shifts it took, and — for tills that produce their own Z (zMode = till) — one per
 * till, numbered per till ("קופה 2 · Z 12"), sorted among the shop's by when they closed.
 * Each row opens the Z's own page, which also prints it.
 *
 * The till filter is the scope bar's (`machineIds`); the origin filter tells the shop's
 * Zs from the tills' own.
 *
 * By date ("תאריך הפקת Z", the default, or "יום עסקי" — lib/zByDate.ts): the list is cut into
 * days, the picked day's Zs are summed in a card (by shop, area and kind), and the month view
 * shows each Z's documents by document month. Presentation only — components/dashboard/z-report/by-date.
 *
 * On the report framework (P:\specs\reports-upgrade.md §5): the days and the area in the
 * report bar; the origin, the Z types and the closing time range beside them (the report's
 * extras); the date basis and the list / month view as the page's own switches — all in the
 * URL. A first visit lists the server's last 90 days, as always. The list is a ReportTable
 * (sort, column chooser) in runs of one day; "טבלת זדים מרוכזת" (Excel) takes every Z the
 * filters match with export columns (lib/listExportColumns.ts — a column per payment method of
 * the data); the CSV and the A4 / 80 mm sequence printing stay.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { fetchZReports, type ZReportListParams } from '@/lib/api';
import { useCanProduceZ, zWizardHref } from '@/lib/zAccess';
import { usePageScope } from '@/lib/scope';
import { findBySameId } from '@/lib/entityLookup';
import { AreaName } from '@/components/dashboard/areas/area-filter';
import { businessToday, formatDate, formatDateTime } from '@/lib/format';
import type { ZReport, ZReportListResponse } from '@/lib/types';
import { Button, buttonVariants } from '@/components/ui/button';
import { OverShort, usePaymentMethodLabel } from '@/components/dashboard/shifts/shift-parts';
import { ZBadges } from '@/components/dashboard/z-report/z-badges';
import { ZScopeLine } from '@/components/dashboard/z-report/z-scope-line';
import { BranchCode, ZRun } from '@/components/dashboard/z-report/z-identity';
import { NumberPill } from '@/components/dashboard/number-pill';
import { useZNumberLabel } from '@/components/dashboard/z-report/z-number';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DateTimePicker } from '@/components/ui/date-picker';
import { Label } from '@/components/ui/label';
import { ChevronLeft, ChevronRight, FileDown, FilePlus2, ListOrdered, Printer } from 'lucide-react';
import { ZPrintViewToggle, type ZPrintView } from '@/components/dashboard/z-report/z-print-view-toggle';
import { ZA4Batch, useZSequencePrint } from '@/components/dashboard/z-report/z-sequence-print';
import { ZRangePrintDialog } from '@/components/dashboard/z-report/z-range-print-dialog';
import { Z_TYPES, fetchZTable, type ZTable, type ZTableRow, type ZTableTillRow, type ZType } from '@/lib/reportCenterApi';
import { listOf, listValue } from '@/lib/transactionsFilters';
import { sumMoney, zTableColumns, zTillColumns, type ListExportColumn } from '@/lib/listExportColumns';
import { parseReportFilters, type ReportFilterSpec } from '@/lib/reportFilters';
import type { ReportFilterLine } from '@/lib/reportExport';
import { todayIso } from '@/lib/reportWindow';
import {
  DEFAULT_Z_DATE_BASIS,
  productionTimeOf,
  summaryWindow,
  zKindOf,
  type ZDateBasis,
} from '@/lib/zByDate';
import type { ZByDateFilters } from '@/lib/zByDateApi';
import {
  ZDateBasisToggle,
  ZListViewToggle,
  type ZListView,
} from '@/components/dashboard/z-report/by-date/z-date-basis-toggle';
import { ZDaySummaryCard, useZSummaryByDate } from '@/components/dashboard/z-report/by-date/z-day-summary-card';
import { ZDayGroupLabel } from '@/components/dashboard/z-report/by-date/z-day-group-row';
import { ZMonthView } from '@/components/dashboard/z-report/by-date/z-month-view';
import { ZListCsvButton } from '@/components/dashboard/z-report/by-date/z-list-csv-button';
import { ZKindBadge, useZKindLabel } from '@/components/dashboard/z-report/by-date/z-by-date-parts';
import {
  ReportPage,
  ReportTable,
  reportQueryState,
  useReportFilters,
  type ReportColumn,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';

const PAGE_SIZE = 50;
const ORIGIN_ANY = '__any__';

/**
 * The days and the area in the bar; the origin, the Z types and the closing time range as the
 * report's extras. The date basis (`basis`) and the view (`view`) are the page's own URL keys:
 * they switch at once, and "נקה הכל" leaves them.
 */
const SPEC: ReportFilterSpec = {
  filters: ['area'],
  extras: { origin: '', zTypes: '', closedFrom: '', closedTo: '' },
};

/** The zone a `datetime-local` input's value is read in — the browser's own. */
const BROWSER_TZ = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
})();

/**
 * `datetime-local` gives a wall-clock string with no zone ("2026-08-27T18:00").
 * The server reads a naive datetime as UTC, so sending it through untouched would
 * shift an Israeli user's filter by two or three hours without saying so. Convert
 * to an absolute instant here instead, and label the field with the zone used.
 */
function localInputToIso(value: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return undefined;
  return d.toISOString();
}

const isZType = (v: string): v is ZType => (Z_TYPES as readonly string[]).includes(v);

/** The payment methods of a Z table's rows, cash and card first (as the server orders them). */
function methodsOf(rows: { payments: Record<string, string> }[]): string[] {
  const all = new Set<string>();
  for (const r of rows) for (const m of Object.keys(r.payments ?? {})) all.add(m);
  const rank = (m: string) => (m === 'cash' ? 0 : m === 'card' ? 1 : 2);
  return [...all].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** The list's columns → report columns; a column per payment method in place of `payments`. */
function exportColumns<R extends { payments: Record<string, string> }>(
  cols: ListExportColumn<R>[],
  paymentsHeader: string,
  methodLabel: (m: string) => string,
  methodsFor: (rows: R[]) => string[],
  withTotals: boolean,
): ReportColumn<R>[] {
  const out: ReportColumn<R>[] = cols.map((c) => ({
    key: c.key,
    header: c.header,
    kind: c.kind,
    width: c.width,
    value: c.value,
    ...(c.total ? { totalOf: c.total } : {}),
  }));
  const at = out.findIndex((c) => c.key === 'netOfVat') + 1;
  out.splice(at, 0, {
    key: 'payments',
    header: paymentsHeader,
    kind: 'money',
    value: () => null,
    expandInExport: (rows) =>
      methodsFor(rows).map((m) => ({
        key: m.replace(/[^A-Za-z0-9_.:-]/g, '_'),
        header: methodLabel(m),
        kind: 'money' as const,
        value: (r: R) => r.payments?.[m] ?? null,
        ...(withTotals ? { totalOf: (all: R[]) => sumMoney(all.map((r) => r.payments?.[m] ?? null)) } : {}),
      })),
  });
  return out;
}

export default function ZReportsPage() {
  const t = useTranslations('zReports');
  const tz = useTranslations('reportCenter');
  const tzc = useTranslations('reportCenter.cols');
  const tp = useTranslations('zReports.tillPrint');
  const tb = useTranslations('zByDate');
  const tr = useTranslations('zReports.report');
  const zNumberLabel = useZNumberLabel();
  const kindLabel = useZKindLabel();
  const paymentLabel = usePaymentMethodLabel();
  const router = useRouter();
  const pathname = usePathname();
  const canProduceZ = useCanProduceZ();
  // `GET /z-reports` filters by shopId and machineIds; there is no company filter.
  const { scope, resolution, effective } = usePageScope({
    maxLevel: 'machine',
    unsupported: ['company'],
  });
  const shopId = effective.shopId;
  const machineId = effective.machineId;
  const filters = useReportFilters(SPEC);

  /*
   * `?zReportId=` used to open a dialog here; the Z now has its own page. Old links
   * (the day summary, bookmarks) are forwarded rather than broken.
   */
  const searchParams = useSearchParams();
  const linkedId = searchParams.get('zReportId');
  useEffect(() => {
    if (linkedId) router.replace(`/dashboard/z-reports/${linkedId}`);
  }, [linkedId, router]);

  // ── What the list runs on: the URL (before a range is run, the server's last 90 days) ──
  const urlKey = searchParams.toString();
  const parsed = useMemo(() => parseReportFilters(new URLSearchParams(urlKey), SPEC, todayIso()), [urlKey]);
  /**
   * What `from`/`to`, the day groups and the order are on: "תאריך הפקת Z" (the default — a Z
   * produced at 02:00 on 1.10 is a Z of 1.10) or "יום עסקי".
   */
  const dateBasis: ZDateBasis = searchParams.get('basis') === 'business' ? 'business' : DEFAULT_Z_DATE_BASIS;
  /** The list by day, or the month's Zs with their documents by document month. */
  const view: ZListView = searchParams.get('view') === 'month' ? 'month' : 'list';
  const setPageKey = (key: 'basis' | 'view', value: string | null) => {
    const q = new URLSearchParams(urlKey);
    if (value) q.set(key, value);
    else q.delete(key);
    const s = q.toString();
    router.replace(s ? `${pathname}?${s}` : pathname, { scroll: false });
  };
  const from = parsed.applied ? parsed.values.from : '';
  const to = parsed.applied ? parsed.values.to : '';
  /** `''` = any, `none` = Zs run for no area, else an area of the shop in scope. */
  const area = parsed.values.areaId;
  /** `''` = both, `cloud` = the shop's Zs, `till` = Zs the tills produced themselves. */
  const origin: '' | 'cloud' | 'till' = parsed.extras.origin === 'cloud' || parsed.extras.origin === 'till' ? parsed.extras.origin : '';
  /** "סוג Z" (docs/SPEC_REPORTS.md §4): none ticked = every type. */
  const zTypes = useMemo(() => listOf(parsed.extras.zTypes).filter(isZType), [parsed.extras.zTypes]);
  const closedFrom = parsed.extras.closedFrom ?? '';
  const closedTo = parsed.extras.closedTo ?? '';

  /** Zs ticked for "הדפס רצף" — kept across pages and filters until cleared. */
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  /** Which paper a sequence prints on: A4, or the till's 80 mm roll. */
  const [printView, setPrintView] = useState<ZPrintView>('a4');
  const [rangeOpen, setRangeOpen] = useState(false);
  const sequence = useZSequencePrint();

  /** The list's filters without its page: the table, the Z table export and the CSV share them. */
  const filterParams = useMemo<ZReportListParams>(() => {
    const p: ZReportListParams = {};
    // The endpoint takes a repeatable machineIds (a Z containing that till); the scope
    // names one device, so it goes in as a single-element list.
    if (machineId) p.machineIds = [machineId];
    if (shopId) p.shopId = shopId;
    if (from) p.from = from;
    if (to) p.to = to;
    const cf = localInputToIso(closedFrom);
    const ct = localInputToIso(closedTo);
    if (cf) p.closedFrom = cf;
    if (ct) p.closedTo = ct;
    if (area) p.areaId = area;
    // Always sent: the server's own default is the business date.
    p.dateBasis = dateBasis;
    if (origin) p.origin = origin;
    if (zTypes.length) p.zTypes = zTypes;
    return p;
  }, [machineId, shopId, from, to, closedFrom, closedTo, area, dateBasis, origin, zTypes]);

  // A new scope or filter is a new result set: back to its first page, during render.
  const [page, setPage] = useState(1);
  const filterKey = JSON.stringify(filterParams);
  const [pageKey, setPageKeyState] = useState(filterKey);
  if (pageKey !== filterKey) {
    setPageKeyState(filterKey);
    setPage(1);
  }
  const params = useMemo<ZReportListParams>(() => ({ ...filterParams, page, pageSize: PAGE_SIZE }), [filterParams, page]);

  /** The list's filters other than dates, for the day card, the month and the CSV. */
  const byDateFilters = useMemo<ZByDateFilters>(() => {
    const f: ZByDateFilters = { dateBasis };
    if (shopId) f.shopId = shopId;
    if (machineId) f.machineIds = [machineId];
    if (area) f.areaId = area;
    if (origin) f.origin = origin;
    if (zTypes.length) f.zTypes = zTypes;
    return f;
  }, [dateBasis, shopId, machineId, area, origin, zTypes]);
  // The day card: the picked day (or range), else today on the shop's clock.
  const card = summaryWindow(from, to, businessToday());
  const closedRange = { closedFrom: localInputToIso(closedFrom), closedTo: localInputToIso(closedTo) };
  const daySummary = useZSummaryByDate(card.from, card.to, byDateFilters, closedRange);
  const dayTotals = useMemo(
    () => new Map((daySummary.data?.byDay ?? []).map((d) => [d.date ?? '', d])),
    [daySummary.data],
  );

  const list = useQuery<ZReportListResponse>({
    queryKey: ['z-reports', params],
    queryFn: () => fetchZReports(params),
    placeholderData: (prev) => prev,
    enabled: view === 'list',
  });
  const data = list.data;

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  /** The shop's zone the server measured production days in. */
  const zone = data?.window?.timezone ?? undefined;
  const dayOf = (z: ZReport) => (dateBasis === 'production' ? z.productionDate : z.businessDate) ?? '';
  const totalsOfDay = (day: string) => (day >= card.from && day <= card.to ? dayTotals.get(day) ?? null : null);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const pageIds = data?.items.map((z) => z.id) ?? [];
  const allOnPage = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const togglePage = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allOnPage) pageIds.forEach((id) => next.delete(id));
      else pageIds.forEach((id) => next.add(id));
      return next;
    });
  const printSelected = (pdf: boolean) => void sequence.run({ ids: [...selected] }, printView, pdf);

  // ── The report's own filters in the bar (the draft; "הפק דוח" runs them) ──
  const draftOrigin = filters.draftExtras.origin ?? '';
  const draftTypes = listOf(filters.draftExtras.zTypes).filter(isZType);
  const toggleDraftType = (type: ZType) =>
    filters.setExtra('zTypes', listValue(draftTypes.includes(type) ? draftTypes.filter((x) => x !== type) : [...draftTypes, type]));
  const originItems = [
    { value: ORIGIN_ANY, label: t('originAll') },
    { value: 'cloud', label: t('originCloudOption') },
    { value: 'till', label: t('originTillOption') },
  ];
  const barFields = (
    <>
      <div className="min-w-0 space-y-1">
        <Label className="text-xs">{t('filterOrigin')}</Label>
        <Select
          value={draftOrigin || ORIGIN_ANY}
          onValueChange={(v) => filters.setExtra('origin', v === 'cloud' || v === 'till' ? v : '')}
          items={originItems}
        >
          <SelectTrigger className="w-full min-w-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {originItems.map((i) => (
              <SelectItem key={i.value} value={i.value} label={i.label}>
                {i.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="min-w-0 space-y-1">
        <Label className="text-xs">{t('filterClosedFrom')}</Label>
        <DateTimePicker
          value={filters.draftExtras.closedFrom ?? ''}
          onChange={(e) => filters.setExtra('closedFrom', e.target.value)}
        />
      </div>
      <div className="min-w-0 space-y-1">
        <Label className="text-xs">{t('filterClosedTo')}</Label>
        <DateTimePicker
          value={filters.draftExtras.closedTo ?? ''}
          onChange={(e) => filters.setExtra('closedTo', e.target.value)}
        />
      </div>
      {/* "סוג Z": the shop's Z, an independent till's, a per-till Z, a kiosk's. None = all. */}
      <div className="col-span-full flex flex-wrap items-center gap-2" role="group" aria-label={tz('zTypeFilter')}>
        <span className="text-muted-foreground text-xs">{tz('zTypeFilter')}</span>
        <Button
          size="sm"
          variant={draftTypes.length === 0 ? 'default' : 'outline'}
          className="rounded-full"
          onClick={() => filters.setExtra('zTypes', '')}
        >
          {tz('zTypeAll')}
        </Button>
        {Z_TYPES.map((type) => (
          <Button
            key={type}
            size="sm"
            variant={draftTypes.includes(type) ? 'default' : 'outline'}
            className="rounded-full"
            aria-pressed={draftTypes.includes(type)}
            onClick={() => toggleDraftType(type)}
          >
            {tz(`zType.${type}`)}
          </Button>
        ))}
        {filters.draftExtras.closedFrom || filters.draftExtras.closedTo ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              filters.setExtra('closedFrom', '');
              filters.setExtra('closedTo', '');
            }}
          >
            {t('clearClosedFilter')}
          </Button>
        ) : null}
      </div>
    </>
  );
  const hint = [
    view === 'month'
      ? tr('monthHint')
      : dateBasis === 'production'
        ? t('productionDateFilterHint', { tz: data?.window?.timezone ?? '—' })
        : t('businessDateFilterHint'),
    // With no date at all the server answers the last 90 days, not everything.
    view === 'list' && !from && !to && !closedFrom && !closedTo ? t('defaultWindowHint') : '',
    t('closedAtFilterHint', { tz: BROWSER_TZ }),
  ]
    .filter(Boolean)
    .join(' ');

  // ── The list on screen: this page's Zs, in runs of one day ──
  const table = useMemo<ReportTableSpec<ZReport>>(() => {
    const shopNameOf = (z: ZReport) => z.shopName ?? findBySameId(scope.shops, z.shopId)?.name;
    const columns: ReportColumn<ZReport>[] = [
      {
        // The document's name, with its tick for "הדפס רצף".
        key: 'zNumber',
        header: t('zNumber'),
        required: true,
        value: (z) => zNumberLabel(z),
        className: 'font-medium tabular-nums',
        cell: (z) => (
          <span className="inline-flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-1 h-4 w-4 shrink-0 align-middle"
              aria-label={tp('select')}
              checked={selected.has(z.id)}
              onClick={(e) => e.stopPropagation()}
              onChange={() => toggle(z.id)}
            />
            <span>
              {/* An em dash, not a 0: a shopless legacy Z has no number. A till Z
                  has none of the shop's either — it is "קופה 2 · Z 12". */}
              <Link href={`/dashboard/z-reports/${z.id}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>
                {zNumberLabel(z)}
              </Link>
              <ZBadges z={z} />
              {/* One till can have two "Z 1": a later run says when it started. */}
              <ZRun z={z} className="block text-muted-foreground text-xs font-normal" />
            </span>
          </span>
        ),
      },
      { key: 'kind', header: tb('cols.kind'), value: (z) => {
          const kind = zKindOf(z);
          return kind ? kindLabel(kind) : null;
        },
        cell: (z) => <ZKindBadge kind={zKindOf(z)} /> },
      {
        key: 'producedAt',
        header: tb('cols.producedAt'),
        kind: 'date',
        value: (z) => z.productionDate ?? null,
        headClassName: dateBasis === 'production' ? 'text-foreground' : undefined,
        cell: (z) => (
          <span className="tabular-nums">
            {z.productionDate ? formatDate(z.productionDate) : '—'}{' '}
            <span className="text-muted-foreground">{productionTimeOf(z.closedAt, zone)}</span>
          </span>
        ),
      },
      {
        // The business day it covers; its shifts' span on hover.
        key: 'businessDay',
        header: tb('cols.businessDay'),
        kind: 'date',
        value: (z) => z.businessDate,
        headClassName: dateBasis === 'business' ? 'text-foreground' : undefined,
        cell: (z) => (
          <span
            title={
              z.periodStart || z.periodEnd
                ? `${t('period')}: ${formatDateTime(z.periodStart)} – ${formatDateTime(z.periodEnd)}`
                : undefined
            }
          >
            {formatDate(z.businessDate)}
          </span>
        ),
      },
      {
        key: 'shop',
        header: t('shop'),
        value: (z) => shopNameOf(z) ?? null,
        cell: (z) => (
          <div className="whitespace-normal">
            <NumberPill n={z.shopNumber} className="me-1" />
            {shopNameOf(z) ?? '—'}
            {(z.legacy || z.origin === 'till') && z.machineName ? (
              <div className="text-muted-foreground text-xs">{z.machineName}</div>
            ) : null}
            <BranchCode code={z.branchCode} className="block text-muted-foreground text-xs" />
            {/* What the Z includes ("קופה עצמאית בתוך סניף"), when the server says. */}
            <ZScopeLine z={z} compact />
          </div>
        ),
      },
      { key: 'area', header: t('area'), value: (z) => z.areaName ?? null, cell: (z) => <AreaName name={z.areaName} /> },
      { key: 'tills', header: t('tills'), kind: 'number', value: (z) => z.machineCount ?? (z.legacy ? 1 : null) },
      { key: 'shifts', header: t('shiftsCount'), kind: 'number', value: (z) => z.shiftCount ?? null },
      { key: 'totalSales', header: t('totalSales'), kind: 'money', value: (z) => z.totalSales ?? null, className: 'font-medium' },
      { key: 'totalRefunds', header: t('totalRefunds'), kind: 'money', value: (z) => z.totalRefunds ?? null },
      { key: 'vat', header: t('vat'), kind: 'money', value: (z) => z.vatTotal ?? null },
      { key: 'cash', header: t('cash'), kind: 'money', value: (z) => z.totalCashSales ?? null },
      { key: 'card', header: t('card'), kind: 'money', value: (z) => z.totalCardSales ?? null },
      { key: 'tips', header: t('tips'), kind: 'money', value: (z) => z.totalTips ?? null },
      { key: 'documents', header: t('transactionsCount'), kind: 'number', value: (z) => z.transactionsCount ?? null },
      {
        // Withheld, not zero, when any of its shifts was not counted.
        key: 'discrepancy',
        header: t('discrepancy'),
        kind: 'money',
        value: (z) => z.discrepancy ?? null,
        cell: (z) => <OverShort value={z.discrepancy} uncountedLabel={t('discrepancyWithheld')} />,
      },
    ];
    return {
      id: 'main',
      title: t('title'),
      columns,
      rows: data?.items ?? [],
      rowKey: (z) => z.id,
      emptyText: t('noReports'),
      onRowClick: (z) => router.push(`/dashboard/z-reports/${z.id}`),
      groupOf: dayOf,
      groupHeading: (day) => <ZDayGroupLabel day={day} basis={dateBasis} totals={totalsOfDay(day)} />,
      // The export is "טבלת זדים מרוכזת" (every Z the filters match), below.
      noExport: true,
    };
    // dayOf / totalsOfDay / toggle read the basis, the day card and the selection, all deps here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, dateBasis, dayTotals, card.from, card.to, kindLabel, router, scope.shops, selected, t, tb, tp, zNumberLabel, zone]);

  // ── "טבלת זדים מרוכזת": every Z the filters match and each one's tills, one request for both sheets ──
  const zTableLoad = useRef<{ key: string; at: number; promise: Promise<ZTable> } | null>(null);
  const loadZTable = (): Promise<ZTable> => {
    const now = Date.now();
    const cached = zTableLoad.current;
    if (cached && cached.key === filterKey && now - cached.at < 30_000) return cached.promise;
    const promise = fetchZTable({ ...filterParams });
    zTableLoad.current = { key: filterKey, at: now, promise };
    promise.catch(() => {
      zTableLoad.current = null;
    });
    return promise;
  };
  const zsTable: ReportTableSpec<ZTableRow> = {
    id: 'zs',
    title: tzc('sheetZs'),
    columns: exportColumns(zTableColumns(tzc, paymentLabel, []), tr('paymentMethods'), paymentLabel, methodsOf, true),
    rows: [],
    rowKey: (z) => z.id,
    totalsLabel: tzc('total'),
    exportRows: async () => (await loadZTable()).zs,
  };
  const tillsTable: ReportTableSpec<ZTableTillRow> = {
    id: 'tills',
    title: tzc('sheetZTills'),
    columns: exportColumns(zTillColumns(tzc, paymentLabel, []), tr('paymentMethods'), paymentLabel, methodsOf, false),
    rows: [],
    rowKey: (l, i) => `${l.zReportId}-${i}`,
    exportRows: async () => (await loadZTable()).tills,
  };

  // ── What the export header says the report's own filters are ──
  const extraLines: ReportFilterLine[] = [
    { label: tr('basis'), value: dateBasis === 'production' ? tr('basisProduction') : tr('basisBusiness') },
    ...(origin ? [{ label: t('filterOrigin'), value: origin === 'cloud' ? t('originCloudOption') : t('originTillOption') }] : []),
    ...(zTypes.length ? [{ label: tz('zTypeFilter'), value: zTypes.map((x) => tz(`zType.${x}`)).join(', ') }] : []),
    ...(closedFrom ? [{ label: t('filterClosedFrom'), value: formatDateTime(localInputToIso(closedFrom)) }] : []),
    ...(closedTo ? [{ label: t('filterClosedTo'), value: formatDateTime(localInputToIso(closedTo)) }] : []),
  ];

  const monthQuery = { isLoading: false, isFetching: false, isError: false, hasData: true };

  return (
    <>
      <div className="print:hidden">
        <ReportPage
          reportKey="z-reports"
          title={t('title')}
          subtitle={t('subtitle')}
          headerExtra={
            <div className="flex flex-wrap items-center justify-between gap-2">
              {/* Which date the range, the day groups and the order are on. A Z produced after
                  midnight is filed under the new day as produced, under the day before as a business date. */}
              <ZDateBasisToggle
                value={dateBasis}
                onChange={(basis) => setPageKey('basis', basis === DEFAULT_Z_DATE_BASIS ? null : basis)}
              />
              <div className="flex flex-wrap items-center gap-2">
                <ZListViewToggle value={view} onChange={(next) => setPageKey('view', next === 'list' ? null : next)} />
                {canProduceZ ? (
                  <Link href={zWizardHref(shopId, machineId)} className={buttonVariants({ size: 'sm' })}>
                    <FilePlus2 className="h-4 w-4 me-1" aria-hidden />
                    {t('produce')}
                  </Link>
                ) : null}
              </div>
            </div>
          }
          resolution={resolution}
          filters={filters}
          bar={{ shopId, children: barFields, hint }}
          query={view === 'month' ? monthQuery : reportQueryState(list)}
          prompt={t('noReports')}
          ready
          loading="table"
          export={
            view === 'month'
              ? null
              : {
                  title: tz('zTableTitle'),
                  tables: [zsTable, tillsTable] as ReportTableSpec<unknown>[],
                  from: from || null,
                  to: to || null,
                  filterLines: extraLines,
                  // The Z list prints its own documents (A4 / 80 mm, below): the table goes to Excel.
                  excelOnly: true,
                  disabled: !data || data.total === 0,
                }
          }
        >
          {view === 'month' ? (
            <ZMonthView filters={byDateFilters} />
          ) : (
            <>
              {/* "דוחות Z שהופקו ב־1.10": the picked day (or range, else today) — count, totals, by shop and area. */}
              <ZDaySummaryCard from={card.from} to={card.to} filters={byDateFilters} closed={closedRange} />

              {/* Printing several Zs: the ticked ones, or a range of one shop, in Z-number order. */}
              <div className="flex flex-wrap items-center gap-2">
                <ZPrintViewToggle value={printView} onChange={setPrintView} />
                <span className="text-muted-foreground text-xs tabular-nums">{tp('selected', { count: selected.size })}</span>
                {selected.size > 0 ? (
                  <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>
                    {tp('clearSelection')}
                  </Button>
                ) : null}
                <Button size="sm" disabled={selected.size === 0 || sequence.busy} onClick={() => printSelected(false)}>
                  <Printer className="h-4 w-4 me-1" aria-hidden />
                  {tp('printSequence')}
                </Button>
                <Button size="sm" variant="outline" disabled={selected.size === 0 || sequence.busy} onClick={() => printSelected(true)}>
                  <FileDown className="h-4 w-4 me-1" aria-hidden />
                  {tp('pdfSequence')}
                </Button>
                <Button size="sm" variant="outline" disabled={sequence.busy} onClick={() => setRangeOpen(true)}>
                  <ListOrdered className="h-4 w-4 me-1" aria-hidden />
                  {tp('printRange')}
                </Button>
                {/* The whole list (every page) as CSV: both dates, kind, time produced, totals. */}
                <ZListCsvButton
                  className="ms-auto"
                  from={from}
                  to={to}
                  closedFrom={closedRange.closedFrom}
                  closedTo={closedRange.closedTo}
                  filters={byDateFilters}
                  disabled={!data || data.total === 0}
                />
              </div>

              <ReportTable
                table={table}
                actions={
                  <Button size="sm" variant="ghost" disabled={pageIds.length === 0} onClick={togglePage} aria-pressed={allOnPage}>
                    {allOnPage ? tr('unselectPage') : tp('selectAll')}
                  </Button>
                }
              />

              {data && data.total > 0 ? (
                <div className="flex items-center justify-end gap-2 text-sm">
                  <span className="text-muted-foreground me-auto text-xs">{tr('zCount', { count: data.total })}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={page <= 1 || list.isFetching}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    <ChevronRight className="h-4 w-4" />
                  </Button>
                  <span className="text-muted-foreground tabular-nums">
                    {page} / {totalPages}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={page >= totalPages || list.isFetching}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  >
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                </div>
              ) : null}
            </>
          )}
        </ReportPage>
        <ZRangePrintDialog
          open={rangeOpen}
          onOpenChange={setRangeOpen}
          shopId={shopId}
          dateBasis={dateBasis}
          view={printView}
          onViewChange={setPrintView}
          busy={sequence.busy}
          onPrint={(range, pdf) => sequence.run({ range }, printView, pdf)}
        />
      </div>
      {/* The A4 documents of a sequence: hidden on screen, one per printed page. */}
      <ZA4Batch batch={sequence.a4} />
    </>
  );
}
