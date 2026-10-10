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
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { AREA_NONE, fetchZReports, type ZReportListParams } from '@/lib/api';
import { useCanProduceZ, zWizardHref } from '@/lib/zAccess';
import { usePageScope } from '@/lib/scope';
import { findBySameId } from '@/lib/entityLookup';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { AreaFilterSelect, AreaName } from '@/components/dashboard/areas/area-filter';
import { formatCurrency, formatDate, formatDateTime } from '@/lib/format';
import { ZReport, ZReportListResponse } from '@/lib/types';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { Button, buttonVariants } from '@/components/ui/button';
import { OverShort } from '@/components/dashboard/shifts/shift-parts';
import { ZBadges } from '@/components/dashboard/z-report/z-badges';
import { ZScopeLine } from '@/components/dashboard/z-report/z-scope-line';
import { BranchCode, ZRun } from '@/components/dashboard/z-report/z-identity';
import { NumberPill } from '@/components/dashboard/number-pill';
import { numberedLabel } from '@/lib/orgNumber';
import { useZNumberLabel } from '@/components/dashboard/z-report/z-number';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DatePicker, DateTimePicker } from '@/components/ui/date-picker';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ReportErrorState } from '@/components/dashboard/report-window-summary';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { ChevronLeft, ChevronRight, FileDown, FilePlus2, ListOrdered, Printer } from 'lucide-react';
import { ZPrintViewToggle, type ZPrintView } from '@/components/dashboard/z-report/z-print-view-toggle';
import { ZA4Batch, useZSequencePrint } from '@/components/dashboard/z-report/z-sequence-print';
import { ZRangePrintDialog } from '@/components/dashboard/z-report/z-range-print-dialog';
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';
import { usePaymentMethodLabel } from '@/components/dashboard/shifts/shift-parts';
import { Z_TYPES, fetchZTable, type ZType } from '@/lib/reportCenterApi';
import { zTableSheets } from '@/lib/reportSheets';
import { businessToday } from '@/lib/format';
import {
  DEFAULT_Z_DATE_BASIS,
  groupByDay,
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
import { ZDayGroupHeading, ZDayGroupRow } from '@/components/dashboard/z-report/by-date/z-day-group-row';
import { ZMonthView } from '@/components/dashboard/z-report/by-date/z-month-view';
import { ZListCsvButton } from '@/components/dashboard/z-report/by-date/z-list-csv-button';
import { ZKindBadge } from '@/components/dashboard/z-report/by-date/z-by-date-parts';

const PAGE_SIZE = 50;
const ORIGIN_ANY = '__any__';
const COLS = 17;

type DateBasis = ZDateBasis;

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

export default function ZReportsPage() {
  const t = useTranslations('zReports');
  const tc = useTranslations('common');
  const zNumberLabel = useZNumberLabel();
  const router = useRouter();
  const canProduceZ = useCanProduceZ();
  // `GET /z-reports` filters by shopId and machineIds; there is no company filter.
  const { scope, resolution, effective } = usePageScope({
    maxLevel: 'machine',
    unsupported: ['company'],
  });
  const shopId = effective.shopId;
  const machineId = effective.machineId;

  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [closedFrom, setClosedFrom] = useState<string>('');
  const [closedTo, setClosedTo] = useState<string>('');
  const [page, setPage] = useState(1);
  /** `''` = any, `none` = Zs run for no area, else an area of the shop in scope. */
  const [area, setArea] = useState<string>('');
  /**
   * What `from`/`to`, the day groups and the order are on: "תאריך הפקת Z" (the default — a Z
   * produced at 02:00 on 1.10 is a Z of 1.10) or "יום עסקי".
   */
  const [dateBasis, setDateBasis] = useState<DateBasis>(DEFAULT_Z_DATE_BASIS);
  /** The list by day, or the month's Zs with their documents by document month. */
  const [view, setView] = useState<ZListView>('list');
  const tp = useTranslations('zReports.tillPrint');
  const tb = useTranslations('zByDate');
  /** Zs ticked for "הדפס רצף" — kept across pages and filters until cleared. */
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  /** Which paper a sequence prints on: A4, or the till's 80 mm roll. */
  const [printView, setPrintView] = useState<ZPrintView>('a4');
  const [rangeOpen, setRangeOpen] = useState(false);
  const sequence = useZSequencePrint();
  /** `''` = both, `cloud` = the shop's Zs, `till` = Zs the tills produced themselves. */
  const [origin, setOrigin] = useState<'' | 'cloud' | 'till'>('');
  /** "סוג Z" (docs/SPEC_REPORTS.md §4): none ticked = every type. */
  const [zTypes, setZTypes] = useState<ZType[]>([]);
  const tz = useTranslations('reportCenter');
  const tzc = useTranslations('reportCenter.cols');
  const paymentLabel = usePaymentMethodLabel();
  const toggleZType = (type: ZType) => {
    setZTypes((prev) => (prev.includes(type) ? prev.filter((x) => x !== type) : [...prev, type]));
    setPage(1);
  };

  /*
   * `?zReportId=` used to open a dialog here; the Z now has its own page. Old links
   * (the day summary, bookmarks) are forwarded rather than broken.
   */
  const searchParams = useSearchParams();
  const linkedId = searchParams.get('zReportId');
  useEffect(() => {
    if (linkedId) router.replace(`/dashboard/z-reports/${linkedId}`);
  }, [linkedId, router]);

  // Same reasoning as the transactions list: a new scope is a new result set, so
  // the page number resets during render rather than one frame later.
  const scopeKey = `${shopId ?? ''}|${machineId ?? ''}`;
  const [pageScopeKey, setPageScopeKey] = useState(scopeKey);
  if (pageScopeKey !== scopeKey) {
    // An area belongs to one shop: another shop drops it ("no area" still applies).
    if (pageScopeKey.split('|')[0] !== (shopId ?? '') && area !== AREA_NONE) setArea('');
    setPageScopeKey(scopeKey);
    setPage(1);
  }

  const params = useMemo<ZReportListParams>(() => {
    const p: ZReportListParams = { page, pageSize: PAGE_SIZE };
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
  }, [machineId, shopId, from, to, closedFrom, closedTo, area, dateBasis, origin, zTypes, page]);
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
  const originItems = [
    { value: ORIGIN_ANY, label: t('originAll') },
    { value: 'cloud', label: t('originCloudOption') },
    { value: 'till', label: t('originTillOption') },
  ];

  const { data, isLoading, isFetching, isError, error } = useQuery<ZReportListResponse>({
    queryKey: ['z-reports', params],
    queryFn: () => fetchZReports(params),
    placeholderData: (prev) => prev,
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const resetPage = () => setPage(1);
  const hasClosedFilter = Boolean(closedFrom || closedTo);
  const open = (z: ZReport) => router.push(`/dashboard/z-reports/${z.id}`);
  /** The shop's zone the server measured production days in. */
  const zone = data?.window?.timezone ?? undefined;
  const dayOf = (z: ZReport) => (dateBasis === 'production' ? z.productionDate : z.businessDate) ?? '';
  // The page cut into its days; a day's count and totals come from the summary when it covers it.
  const groups = groupByDay(data?.items ?? [], dayOf);
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

  return (
    <>
    <div className="space-y-4 print:hidden">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>
        {canProduceZ ? (
          <Link href={zWizardHref(shopId, machineId)} className={buttonVariants({ size: 'sm' })}>
            <FilePlus2 className="h-4 w-4 me-1" aria-hidden />
            {t('produce')}
          </Link>
        ) : null}
      </div>

      <ScopeGate resolution={resolution}>
      <div className="rounded-lg border bg-card p-4 space-y-3">
        {/* Which date the range, the day groups and the order are on. A Z produced after
            midnight is filed under the new day as produced, under the day before as a business date. */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <ZDateBasisToggle value={dateBasis} onChange={(basis) => { setDateBasis(basis); resetPage(); }} />
          <ZListViewToggle value={view} onChange={setView} />
        </div>
        <div className="grid gap-3 md:grid-cols-4">
          {view === 'list' ? (
          <>
          <div className="space-y-1">
            <Label className="text-xs">
              {dateBasis === 'production' ? t('filterFromProduction') : t('filterFrom')}
            </Label>
            <DatePicker
              value={from}
              onChange={(e) => { setFrom(e.target.value); resetPage(); }}
              range={{ from, to, onSelect: (r) => { setFrom(r.from); setTo(r.to); resetPage(); } }}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">
              {dateBasis === 'production' ? t('filterToProduction') : t('filterTo')}
            </Label>
            <DatePicker
              value={to}
              onChange={(e) => { setTo(e.target.value); resetPage(); }}
              range={{ from, to, onSelect: (r) => { setFrom(r.from); setTo(r.to); resetPage(); } }}
            />
          </div>
          </>
          ) : null}
          <AreaFilterSelect
            shopId={shopId}
            value={area}
            onChange={(next) => { setArea(next); resetPage(); }}
          />
          <div className="space-y-1">
            <Label className="text-xs">{t('filterOrigin')}</Label>
            <Select
              value={origin || ORIGIN_ANY}
              onValueChange={(v) => {
                setOrigin(v === 'cloud' || v === 'till' ? v : '');
                resetPage();
              }}
              items={originItems}
            >
              <SelectTrigger className="min-w-40">
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
        </div>
        {/* "סוג Z": the shop's Z, an independent till's, a per-till Z, a kiosk's. None = all. */}
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label={tz('zTypeFilter')}>
          <span className="text-muted-foreground text-xs">{tz('zTypeFilter')}</span>
          <Button
            size="sm"
            variant={zTypes.length === 0 ? 'default' : 'outline'}
            className="rounded-full"
            onClick={() => { setZTypes([]); resetPage(); }}
          >
            {tz('zTypeAll')}
          </Button>
          {Z_TYPES.map((type) => (
            <Button
              key={type}
              size="sm"
              variant={zTypes.includes(type) ? 'default' : 'outline'}
              className="rounded-full"
              aria-pressed={zTypes.includes(type)}
              onClick={() => toggleZType(type)}
            >
              {tz(`zType.${type}`)}
            </Button>
          ))}
        </div>
        {view === 'list' ? (
        <>
        <p className="text-muted-foreground text-xs">
          {dateBasis === 'production'
            ? t('productionDateFilterHint', { tz: data?.window?.timezone ?? '—' })
            : t('businessDateFilterHint')}
        </p>
        {/* With no date at all the server answers the last 90 days, not everything. */}
        {!from && !to && !closedFrom && !closedTo ? (
          <p className="text-muted-foreground text-xs">{t('defaultWindowHint')}</p>
        ) : null}

        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-1">
            <Label className="text-xs">{t('filterClosedFrom')}</Label>
            <DateTimePicker
              value={closedFrom}
              onChange={(e) => { setClosedFrom(e.target.value); resetPage(); }}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t('filterClosedTo')}</Label>
            <DateTimePicker
              value={closedTo}
              onChange={(e) => { setClosedTo(e.target.value); resetPage(); }}
            />
          </div>
        </div>
        <p className="text-muted-foreground text-xs">
          {t('closedAtFilterHint', { tz: BROWSER_TZ })}
        </p>

        {hasClosedFilter ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => { setClosedFrom(''); setClosedTo(''); resetPage(); }}
            >
              {t('clearClosedFilter')}
            </Button>
          </div>
        ) : null}
        </>
        ) : null}
      </div>

      {view === 'month' ? (
        <ZMonthView filters={byDateFilters} />
      ) : (
      <>
      {/* "דוחות Z שהופקו ב־1.10": the picked day (or range, else today) — count, totals, by shop and area. */}
      <ZDaySummaryCard from={card.from} to={card.to} filters={byDateFilters} closed={closedRange} />

      {/* Printing several Zs: the ticked ones, or a range of one shop, in Z-number order. */}
      <div className="flex flex-wrap items-center gap-2">
        <ZPrintViewToggle value={printView} onChange={setPrintView} />
        <span className="text-muted-foreground text-xs tabular-nums">
          {tp('selected', { count: selected.size })}
        </span>
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
        {/* "טבלת זדים מרוכזת": every Z the filters match (not this page) and each one's tills. */}
        <ReportExportToolbar
          className="ms-auto"
          excelOnly
          title={tz('zTableTitle')}
          from={from || undefined}
          to={to || undefined}
          disabled={!data || data.total === 0}
          getSheets={async () => {
            // The list's own filters without its page: the table is every Z they match.
            const table = await fetchZTable({ ...params, page: undefined, pageSize: undefined });
            return zTableSheets(table, tzc, paymentLabel);
          }}
        />
        {/* The whole list (every page) as CSV: both dates, kind, time produced, totals. */}
        <ZListCsvButton
          from={from}
          to={to}
          closedFrom={closedRange.closedFrom}
          closedTo={closedRange.closedTo}
          filters={byDateFilters}
          disabled={!data || data.total === 0}
        />
      </div>

      {isError ? (
        <ReportErrorState message={axiosErrorToToastMessage(error, tc('error'))} />
      ) : (
      <>
      {/* A phone gets one card per Z; the twelve-column table from md up. */}
      <ul className="divide-y rounded-lg border bg-card md:hidden">
        {isLoading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <li key={i} className="p-3"><Skeleton className="h-12 w-full" /></li>
          ))
        ) : !data || data.items.length === 0 ? (
          <li className="py-6 text-center text-sm text-muted-foreground">{t('noReports')}</li>
        ) : (
          groups.map((group, gi) => [
          <ZDayGroupHeading key={`day-${gi}-${group.day}`} day={group.day} basis={dateBasis} totals={totalsOfDay(group.day)} />,
          ...group.rows.map((z) => {
            const shopName = z.shopName ?? findBySameId(scope.shops, z.shopId)?.name;
            return (
              <li key={z.id} className="flex items-start">
                <input
                  type="checkbox"
                  className="ms-3 mt-4 h-4 w-4 shrink-0"
                  aria-label={tp('select')}
                  checked={selected.has(z.id)}
                  onChange={() => toggle(z.id)}
                />
                <Link href={`/dashboard/z-reports/${z.id}`} className="block min-w-0 flex-1 space-y-1 p-3 text-sm hover:bg-muted/50">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium tabular-nums">
                      {/* A till Z always names its till: "קופה 6 · Z 3". */}
                      {z.origin === 'till' ? zNumberLabel(z) : <>{t('zNumber')} {(z.zNumber ?? z.shopSequenceNumber) ?? '—'}</>}
                      <ZBadges z={z} />
                    </span>
                    <span className="font-medium tabular-nums">{formatCurrency(z.totalSales)}</span>
                  </div>
                  <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
                    <ZKindBadge kind={zKindOf(z)} />
                    {/* Both dates, the chosen basis first; the production with its time. */}
                    {dateBasis === 'production' && z.productionDate ? (
                      <>
                        <span>{t('productionDate')} {formatDate(z.productionDate)} {productionTimeOf(z.closedAt, zone)}</span>
                        <span>· {t('businessDate')} {formatDate(z.businessDate)}</span>
                      </>
                    ) : (
                      <>
                        <span>{t('businessDate')} {formatDate(z.businessDate)}</span>
                        {z.productionDate ? (
                          <span>· {t('productionDate')} {formatDate(z.productionDate)}</span>
                        ) : null}
                      </>
                    )}
                    <span>· {numberedLabel(z.shopNumber, shopName ?? '—')}</span>
                    {z.areaName ? <span>· {z.areaName}</span> : null}
                    {z.legacy && z.machineName ? <span>· {z.machineName}</span> : null}
                    {z.branchCode ? <span>· <BranchCode code={z.branchCode} /></span> : null}
                    <ZRun z={z} prefix="· " />
                  </div>
                  <ZScopeLine z={z} compact />
                  <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 text-xs">
                    <span>{t('cash')} {formatCurrency(z.totalCashSales)}</span>
                    <span>{t('card')} {formatCurrency(z.totalCardSales)}</span>
                    <span>{t('vat')} {formatCurrency(z.vatTotal)}</span>
                    <span>{t('tips')} {formatCurrency(z.totalTips)}</span>
                    <span>{t('transactionsCount')} {z.transactionsCount ?? '—'}</span>
                    <span className="inline-flex items-center gap-1">
                      {t('discrepancy')}{' '}
                      <OverShort value={z.discrepancy} uncountedLabel={t('discrepancyWithheld')} />
                    </span>
                  </div>
                </Link>
              </li>
            );
          }),
          ])
        )}
      </ul>

      <div className="hidden rounded-lg border bg-card overflow-x-auto md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-8">
                <input
                  type="checkbox"
                  className="h-4 w-4 align-middle"
                  aria-label={tp('selectAll')}
                  checked={allOnPage}
                  disabled={pageIds.length === 0}
                  onChange={togglePage}
                />
              </TableHead>
              {/* First column after the tick: it is the document's name, not an attribute of it. */}
              <TableHead>{t('zNumber')}</TableHead>
              <TableHead>{tb('cols.kind')}</TableHead>
              <TableHead className={dateBasis === 'production' ? 'text-foreground' : undefined}>
                {tb('cols.producedAt')}
              </TableHead>
              <TableHead className={dateBasis === 'business' ? 'text-foreground' : undefined}>
                {tb('cols.businessDay')}
              </TableHead>
              <TableHead>{t('shop')}</TableHead>
              <TableHead>{t('area')}</TableHead>
              <TableHead className="text-end">{t('tills')}</TableHead>
              <TableHead className="text-end">{t('shiftsCount')}</TableHead>
              <TableHead className="text-end">{t('totalSales')}</TableHead>
              <TableHead className="text-end">{t('totalRefunds')}</TableHead>
              <TableHead className="text-end">{t('vat')}</TableHead>
              <TableHead className="text-end">{t('cash')}</TableHead>
              <TableHead className="text-end">{t('card')}</TableHead>
              <TableHead className="text-end">{t('tips')}</TableHead>
              <TableHead className="text-end">{t('transactionsCount')}</TableHead>
              <TableHead className="text-end">{t('discrepancy')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={COLS}><Skeleton className="h-6 w-full" /></TableCell>
                </TableRow>
              ))
            ) : !data || data.items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={COLS} className="text-center text-muted-foreground py-6">
                  {t('noReports')}
                </TableCell>
              </TableRow>
            ) : (
              groups.map((group, gi) => [
              <ZDayGroupRow
                key={`day-${gi}-${group.day}`}
                day={group.day}
                basis={dateBasis}
                colSpan={COLS}
                totals={totalsOfDay(group.day)}
              />,
              ...group.rows.map((z) => {
                const shopName = z.shopName ?? findBySameId(scope.shops, z.shopId)?.name;
                return (
                  <TableRow key={z.id} className="cursor-pointer" onClick={() => open(z)}>
                    <TableCell className="w-8" onClick={(e) => e.stopPropagation()}>
                      <input
                        type="checkbox"
                        className="h-4 w-4 align-middle"
                        aria-label={tp('select')}
                        checked={selected.has(z.id)}
                        onChange={() => toggle(z.id)}
                      />
                    </TableCell>
                    <TableCell className="font-medium tabular-nums whitespace-nowrap">
                      <Link
                        href={`/dashboard/z-reports/${z.id}`}
                        className="hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {/* An em dash, not a 0: a shopless legacy Z has no number. A till Z
                            has none of the shop's either — it is "קופה 2 · Z 12". */}
                        {zNumberLabel(z)}
                      </Link>
                      <ZBadges z={z} />
                      {/* One till can have two "Z 1": a later run says when it started. */}
                      <ZRun z={z} className="block text-muted-foreground text-xs font-normal" />
                    </TableCell>
                    <TableCell><ZKindBadge kind={zKindOf(z)} /></TableCell>
                    <TableCell className="whitespace-nowrap tabular-nums">
                      {z.productionDate ? formatDate(z.productionDate) : '—'}{' '}
                      <span className="text-muted-foreground">{productionTimeOf(z.closedAt, zone)}</span>
                    </TableCell>
                    {/* The business day it covers; its shifts' span on hover. */}
                    <TableCell
                      className="whitespace-nowrap"
                      title={
                        z.periodStart || z.periodEnd
                          ? `${t('period')}: ${formatDateTime(z.periodStart)} – ${formatDateTime(z.periodEnd)}`
                          : undefined
                      }
                    >
                      {formatDate(z.businessDate)}
                    </TableCell>
                    <TableCell>
                      <NumberPill n={z.shopNumber} className="me-1" />
                      {shopName ?? '—'}
                      {(z.legacy || z.origin === 'till') && z.machineName ? (
                        <div className="text-muted-foreground text-xs">{z.machineName}</div>
                      ) : null}
                      <BranchCode code={z.branchCode} className="block text-muted-foreground text-xs" />
                      {/* What the Z includes ("קופה עצמאית בתוך סניף"), when the server says. */}
                      <ZScopeLine z={z} compact />
                    </TableCell>
                    <TableCell className="text-sm">
                      <AreaName name={z.areaName} />
                    </TableCell>
                    <TableCell className="text-end tabular-nums">
                      {z.machineCount ?? (z.legacy ? 1 : '—')}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">{z.shiftCount ?? '—'}</TableCell>
                    <TableCell className="text-end font-medium">{formatCurrency(z.totalSales)}</TableCell>
                    <TableCell className="text-end">{formatCurrency(z.totalRefunds)}</TableCell>
                    <TableCell className="text-end">{formatCurrency(z.vatTotal)}</TableCell>
                    <TableCell className="text-end">{formatCurrency(z.totalCashSales)}</TableCell>
                    <TableCell className="text-end">{formatCurrency(z.totalCardSales)}</TableCell>
                    <TableCell className="text-end">{formatCurrency(z.totalTips)}</TableCell>
                    <TableCell className="text-end tabular-nums">{z.transactionsCount ?? '—'}</TableCell>
                    <TableCell className="text-end">
                      {/* Withheld, not zero, when any of its shifts was not counted. */}
                      <OverShort value={z.discrepancy} uncountedLabel={t('discrepancyWithheld')} />
                    </TableCell>
                  </TableRow>
                );
              }),
              ])
            )}
          </TableBody>
        </Table>
      </div>
      </>
      )}

      {data && data.total > 0 && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <Button
            size="sm" variant="outline"
            disabled={page <= 1 || isFetching}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
          <span className="text-muted-foreground tabular-nums">{page} / {totalPages}</span>
          <Button
            size="sm" variant="outline"
            disabled={page >= totalPages || isFetching}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
        </div>
      )}
      </>
      )}
      </ScopeGate>
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
