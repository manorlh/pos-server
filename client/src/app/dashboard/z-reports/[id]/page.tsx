'use client';

/**
 * One Z report (דו״ח Z): the shop's figures, then each register's section, then the
 * shifts it took — each linking to that shift's X.
 *
 * The header (business name, VAT id, address, branch) is the one frozen on the Z when
 * it was built. It is shown as stored: a Z is a fiscal document, and re-deriving it from
 * today's settings would quietly rewrite every Z after a rename or a move.
 *
 * A Z the till produced itself (origin `till`, docs/SHIFTS_API.md §5) is a Z of that one
 * till: one register section, numbered per till ("קופה 2 · Z 12"), with no shop number.
 *
 * "Print" opens the browser's print dialog on an A4 layout (`ZPrintDocument`) that is
 * hidden on screen; "save as PDF" there gives the file. "ייצוא" is the reports' designed PDF
 * (P:\specs\reports-designed-pdf.md §7, type `z-report`), Excel and CSV, without a print of its own.
 */

import { use, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { zShowsExempt } from '@/lib/dealerType';
import { CashWithTipsCard, SectionTipsRows } from '@/components/dashboard/z-report/cash-with-tips';
import { NumberPill } from '@/components/dashboard/number-pill';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, FileBarChart, FileDown, Printer } from 'lucide-react';
import { toast } from 'sonner';
import { fetchZPrintDocument, fetchZReport } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { usePageScope } from '@/lib/scope';
import { cashMovementRows } from '@/lib/zCashMovements';
import { cashWalletRows, cashWithStaffRows } from '@/lib/zCashWallets';
import { formatCurrency, formatDate, formatDateTime, moneyValue } from '@/lib/format';
import type { Money, Shift, TablePaymentReversals, ZReportDetail, ZReportMachineSection } from '@/lib/types';
import { ReportErrorState } from '@/components/dashboard/report-window-summary';
import {
  CountedCash,
  Fact,
  hasBetweenShiftAdjustments,
  MoneyRow,
  OverShort,
  PaymentBreakdownRows,
  ShiftBadges,
  SignedMoney,
  TipsSplit,
  usePaymentMethodLabel,
  useShiftLabel,
  useTillHeading,
} from '@/components/dashboard/shifts/shift-parts';
import { ZBadges } from '@/components/dashboard/z-report/z-badges';
import { OfflineZPanel } from '@/components/dashboard/z-report/offline-z-panel';
import { ZVerificationPanel } from '@/components/dashboard/z-report/z-verification-panel';
import { latePartTitleOf, sectionKeyOf, sectionShiftsOf } from '@/lib/localShopZ';
import { AsPrintedBadge, ZScopeLine } from '@/components/dashboard/z-report/z-scope-line';
import { BranchCode, ZRun } from '@/components/dashboard/z-report/z-identity';
import { OpenTillsRecord } from '@/components/dashboard/z-wizard/open-tills';
import { ZPrintDocument } from '@/components/dashboard/z-report/z-print-document';
import { FailedPaymentsSection } from '@/components/dashboard/failed-payments/failed-payments-section';
import { CardBrandSummaryCard } from '@/components/dashboard/z-report/card-brand-summary';
import { WaiterSummaryCard } from '@/components/dashboard/z-report/waiter-summary';
import { ZReportSectionsCards } from '@/components/dashboard/z-report/z-report-sections';
import {
  printTillReceipts,
  zPrintTitle,
  ZTillReceipt,
} from '@/components/dashboard/z-report/z-till-receipt';
import { ZPrintViewToggle, type ZPrintView } from '@/components/dashboard/z-report/z-print-view-toggle';
import {
  OfflineDeclinedList,
  OfflineNotice,
  offlineOf,
  offlineOfZ,
} from '@/components/dashboard/z-report/offline-summary';
import { useZTitle, ZProducedBy, zNumberSourceOf } from '@/components/dashboard/z-report/z-number';
import { useZExportTables, zShiftsTableSpec } from '@/components/dashboard/z-report/z-export-sheets';
import { ReportTable, StandaloneExportBar, type ReportChart, type ReportKpi } from '@/components/dashboard/report-framework';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * The Z's shifts (under a till, or the Z's own when it has no till sections): a ReportTable on
 * the Z's columns (`z-report` · `shifts`), so the reader's columns are the Excel's too.
 */
function ShiftTable({ shifts }: { shifts: Shift[] }) {
  const t = useTranslations('shifts');
  const shiftLabel = useShiftLabel();
  if (shifts.length === 0) return null;
  const spec = zShiftsTableSpec(shifts, {
    ts: t,
    shiftLabel,
    tillOf: (machineId, machineName) => machineName ?? machineId,
    screen: {
      shift: (s) => (
        <Link href={`/dashboard/shifts/${s.id}`} className="font-medium hover:underline">
          {shiftLabel(s)}
        </Link>
      ),
      opened: (s) => (
        <span className="text-xs">
          {formatDateTime(s.openedAt)}
          {s.openedByName ? <span className="text-muted-foreground"> · {s.openedByName}</span> : null}
        </span>
      ),
      closed: (s) => (
        <span className="text-xs">
          {formatDateTime(s.closedAt)}
          <span className="text-muted-foreground">
            {s.unattended ? ` · ${t('closedRemotely')}` : s.closedByName ? ` · ${s.closedByName}` : ''}
          </span>
        </span>
      ),
      counted: (s) => <CountedCash value={s.countedCash} />,
      overShort: (s) => <OverShort value={s.discrepancy} />,
      badges: (s) => <ShiftBadges shift={s} showStatus={false} showZ={false} />,
    },
  });
  return (
    <div className="p-3">
      <ReportTable reportKey="z-report" table={{ ...spec, title: undefined }} />
    </div>
  );
}

/** The figures a Z and each of its registers share. */
interface SalesFigures {
  grossSales?: Money | null;
  discountsTotal?: Money | null;
  totalSales?: Money | null;
  totalRefunds?: Money | null;
  netSales?: Money | null;
  vatTotal?: Money | null;
  vatMissingCount?: number | null;
  totalTips?: Money | null;
  totalCashTips?: Money | null;
  totalCardTips?: Money | null;
  /** "זיכויים וביטולי תשלום בשולחנות" — inside the refunds already; absent when none. */
  tablePaymentReversals?: TablePaymentReversals | null;
}

/**
 * Sales from gross to net, in the order they are computed, so no line reads as if it
 * still had to be subtracted: discounts are already out of "sales", and refunds come off
 * only in the net line. A server that does not send gross yet gets the same sales line,
 * with the discounts marked as already deducted.
 */
function SalesRows({ x, dealerType }: { x: SalesFigures; dealerType?: string | null }) {
  const t = useTranslations('zReports');
  const tb = useTranslations('businessType');
  const hasGross = x.grossSales != null;
  // An exempt dealer's Z has no VAT to split (docs/SPEC_BUSINESS_TYPE.md).
  const exempt = zShowsExempt(dealerType, x.vatTotal);
  return (
    <>
      {hasGross ? (
        <>
          <MoneyRow label={t('grossSales')} value={x.grossSales} />
          <MoneyRow label={t('discounts')} value={x.discountsTotal} />
        </>
      ) : null}
      <MoneyRow label={t('salesAfterDiscounts')} value={x.totalSales} strong />
      {!hasGross ? <MoneyRow label={t('discountsDeducted')} value={x.discountsTotal} /> : null}
      <MoneyRow label={t('refundsAndCredits')} value={x.totalRefunds} />
      {(x.tablePaymentReversals?.count ?? 0) > 0 ? (
        <div className="ps-3 text-xs text-muted-foreground" title={t('tablePaymentReversalsHint')}>
          <MoneyRow label={t('tablePaymentReversals')}>
            {t('tablePaymentReversalsValue', {
              count: x.tablePaymentReversals?.count ?? 0,
              amount: formatCurrency(x.tablePaymentReversals?.amount),
            })}
          </MoneyRow>
        </div>
      ) : null}
      {x.netSales != null ? <MoneyRow label={t('netSales')} value={x.netSales} strong /> : null}
      <MoneyRow label={t('vatNetOfCredits')}>
        {exempt ? (
          <span className="text-muted-foreground text-xs">{tb('zExemptNoVat')}</span>
        ) : x.vatTotal == null ? (
          <span className="text-muted-foreground text-xs">{t('vatMissing')}</span>
        ) : (
          <>
            {formatCurrency(x.vatTotal)}
            {(x.vatMissingCount ?? 0) > 0 ? (
              <span className="text-muted-foreground ms-1 text-xs">
                {t('vatMissingCount', { count: x.vatMissingCount ?? 0 })}
              </span>
            ) : null}
          </>
        )}
      </MoneyRow>
      <MoneyRow label={t('tips')} value={x.totalTips} />
      <TipsSplit total={x.totalTips} cash={x.totalCashTips} card={x.totalCardTips} />
    </>
  );
}

function TillCard({
  s,
  shifts,
  dealerType,
  zId,
}: {
  s: ZReportMachineSection;
  shifts: Shift[];
  dealerType?: string | null;
  /** The Z, for this till's "עסקאות שלא הושלמו" (docs/SPEC_FAILED_PAYMENTS.md). */
  zId?: string;
}) {
  const t = useTranslations('zReports');
  const heading = useTillHeading()(s);
  // A local shop Z's "late documents" part of a till: its label, not a second "קופה N".
  const lateTitle = latePartTitleOf(s);
  const uncounted = (s.uncountedShiftCount ?? 0) > 0;
  const offline = offlineOf(s.offline);
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <CardTitle className="text-base">
            <Link href={`/dashboard/machines/${s.machineId}`} className="hover:underline">
              {lateTitle ?? heading.title}
            </Link>
            {heading.name && !lateTitle ? (
              <span className="text-muted-foreground ms-2 text-sm font-normal">{heading.name}</span>
            ) : null}
          </CardTitle>
          <span className="text-muted-foreground text-xs">
            {s.firstShiftSequence != null && s.lastShiftSequence != null
              ? t('till.shiftRange', {
                  count: s.shiftCount ?? 0,
                  first: s.firstShiftSequence,
                  last: s.lastShiftSequence,
                })
              : t('till.shiftCount', { count: s.shiftCount ?? 0 })}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
          <Fact label={t('till.firstDocument')}>
            <span className="font-mono text-xs" dir="ltr">{s.firstDocumentNumber ?? '—'}</span>
          </Fact>
          <Fact label={t('till.lastDocument')}>
            <span className="font-mono text-xs" dir="ltr">{s.lastDocumentNumber ?? '—'}</span>
          </Fact>
          <Fact label={t('till.documents')}>
            {t('till.documentsSplit', {
              sales: s.salesCount ?? '—',
              credit: s.creditNotesCount ?? '—',
              other: s.nonSaleDocumentsCount ?? '—',
            })}
          </Fact>
          <Fact label={t('till.flags')}>
            {(s.reconstructedShiftCount ?? 0) + (s.unattendedShiftCount ?? 0) === 0
              ? '—'
              : [
                  (s.reconstructedShiftCount ?? 0) > 0
                    ? t('till.reconstructed', { count: s.reconstructedShiftCount ?? 0 })
                    : null,
                  (s.unattendedShiftCount ?? 0) > 0
                    ? t('till.unattended', { count: s.unattendedShiftCount ?? 0 })
                    : null,
                ]
                  .filter(Boolean)
                  .join(' · ')}
          </Fact>
        </div>
        <div className="grid gap-4 md:grid-cols-3 text-sm">
          <div className="space-y-1 rounded border bg-muted/30 p-3">
            <SalesRows x={s} dealerType={dealerType} />
          </div>
          <div className="rounded border bg-muted/30 p-3">
            <PaymentBreakdownRows breakdown={s.paymentBreakdown} />
          </div>
          <div className="space-y-1 rounded border bg-muted/30 p-3">
            <MoneyRow label={t('openingCash')} value={s.openingCash} />
            {hasBetweenShiftAdjustments(s.betweenShiftAdjustments) ? (
              <MoneyRow label={t('betweenShiftAdjustments')}>
                <SignedMoney value={s.betweenShiftAdjustments} />
              </MoneyRow>
            ) : null}
            {/* "Z — מזומן צפוי כולל הפקדות ותנועות מזומן": only on a Z the parameter applied to. */}
            {cashMovementRows(s.cashMovements).map((r) => (
              <MoneyRow key={r.key} label={t(r.key)}>
                <SignedMoney value={r.value} />
              </MoneyRow>
            ))}
            {/* "הכסף אצלי" (P:/specs/drawer-away.md §5.6): only when this till had any. */}
            {cashWalletRows(s.cashWallets).map((r) => (
              <MoneyRow key={r.key} label={t(r.key)}>
                <SignedMoney value={r.value} />
              </MoneyRow>
            ))}
            <MoneyRow label={t('expectedCash')} value={s.expectedCash} />
            <MoneyRow label={t('actualCash')}>
              {uncounted ? (
                <span className="text-muted-foreground text-xs">
                  {t('uncountedShifts', { count: s.uncountedShiftCount ?? 0 })}
                </span>
              ) : (
                <CountedCash value={s.countedCash} />
              )}
            </MoneyRow>
            <MoneyRow label={t('discrepancy')}>
              <OverShort value={uncounted ? null : s.overShort} uncountedLabel={t('discrepancyWithheld')} />
            </MoneyRow>
            {/* "מזומן במגירה כולל טיפים" (x-z-cash-with-tips §1): where the old two rows were — the card
                tips this drawer paid and owes, and "חסר במגירה" below zero (the Z's block is above). */}
            <SectionTipsRows s={s} />
          </div>
        </div>
        {offline ? (
          <div className="space-y-2">
            <OfflineNotice figures={offline} />
            <OfflineDeclinedList declined={s.offline?.declined ?? []} />
          </div>
        ) : null}
        {/* This till's failed payment attempts and cancelled sales — information only. */}
        {zId && s.machineId && !lateTitle ? (
          <FailedPaymentsSection query={{ zReportId: zId, machineId: s.machineId }} bare />
        ) : null}
      </CardContent>
      {shifts.length > 0 ? (
        <CardContent className="border-t p-0">
          <ShiftTable shifts={shifts} />
        </CardContent>
      ) : null}
    </Card>
  );
}

function Header({ z }: { z: ZReportDetail }) {
  const t = useTranslations('zReports');
  const b = z.business;
  if (!b) {
    return <p className="text-muted-foreground text-xs">{t('noHeader')}</p>;
  }
  const address = [b.address, b.addressNumber].filter(Boolean).join(' ');
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-5">
      <Fact label={t('header.businessName')}>{b.businessName ?? '—'}</Fact>
      <Fact label={t('header.vatNumber')}>{b.vatNumber ?? '—'}</Fact>
      <Fact label={t('header.address')}>
        {[address, b.city, b.zip].filter(Boolean).join(', ') || '—'}
      </Fact>
      <Fact label={t('header.branch')}>
        {b.shopName ?? '—'}
        {b.branchId ? <span className="text-muted-foreground text-xs"> · {b.branchId}</span> : null}
      </Fact>
      {b.areaName ?? z.areaName ? (
        <Fact label={t('header.area')}>{b.areaName ?? z.areaName}</Fact>
      ) : null}
      <Fact label={t('header.capturedAt')}>{formatDateTime(b.capturedAt)}</Fact>
    </div>
  );
}

export default function ZReportDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations('zReports');
  const zTitle = useZTitle();
  const zExport = useZExportTables();
  const methodLabel = usePaymentMethodLabel();
  usePageScope({ maxLevel: 'machine', silent: true });
  // Stamped when the print dialog opens, so the paper says when it was printed.
  const [printedAt, setPrintedAt] = useState(() => new Date().toISOString());
  const tp = useTranslations('zReports.tillPrint');
  /** A4: the dashboard's document. Till: the 80 mm paper the till prints. */
  const [view, setView] = useState<ZPrintView>('a4');

  const { data: z, isLoading, isError, error } = useQuery({
    queryKey: ['z-report', id],
    queryFn: () => fetchZReport(id),
  });
  const tillDoc = useQuery({
    queryKey: ['z-report-print-document', id],
    queryFn: () => fetchZPrintDocument(id),
    enabled: view === 'till',
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (isError || !z) {
    return <ReportErrorState message={axiosErrorToToastMessage(error, t('notFound'))} />;
  }

  const uncountedShifts = z.perMachine.reduce((n, s) => n + (s.uncountedShiftCount ?? 0), 0);
  const withheld = z.actualCash == null;
  const late = z.lateDocuments ?? 0;
  const offline = offlineOfZ(z);
  // Frozen in the header when the Z was built, so a later rename does not rewrite it.
  const areaName = z.business?.areaName ?? z.areaName ?? null;
  // A till with two parts (regular + "late documents") splits its shifts by each part's ids.
  const sectionShifts = (s: ZReportMachineSection) => sectionShiftsOf(s, z.perMachine, z.shifts);

  const title = zPrintTitle([(z.zNumber ?? z.shopSequenceNumber)]);
  // Excel with export columns: the Z, its tills, card brands, waiters and shifts (keyed tables).
  const exported = zExport(z);
  // The designed PDF (P:\specs\reports-designed-pdf.md §7): the Z's main figures as its cards —
  // the over / short once counted — the tenders as a donut, and the tills (when the Z has
  // sections) as its table: the Z's own row is the cards already.
  const zKpis: ReportKpi[] = [
    { key: 'sales', label: t('salesAfterDiscounts'), value: z.totalSales ?? null, kind: 'money', icon: 'sales' },
    { key: 'net', label: t('netSales'), value: z.netSales ?? null, kind: 'money', icon: 'chart' },
    { key: 'refunds', label: t('refundsAndCredits'), value: z.totalRefunds ?? null, kind: 'money', icon: 'refund' },
    { key: 'documents', label: t('documentsSalesAndCredits'), value: z.transactionsCount ?? null, kind: 'count', icon: 'receipt' },
    { key: 'tips', label: t('tips'), value: z.totalTips ?? null, kind: 'money', icon: 'tip' },
    { key: 'discrepancy', label: t('discrepancy'), value: withheld ? null : (z.discrepancy ?? null), kind: 'money', icon: 'alert' },
  ];
  // A figure the Z does not have (no net from an older server, a cash count withheld): no card.
  const exportKpis = zKpis.filter((k) => k.value != null);
  const tenderRank = (m: string) => (m === 'cash' ? 0 : m === 'card' ? 1 : 2);
  const tenders = Object.entries(z.paymentBreakdown ?? {}).sort(([a], [b]) => tenderRank(a) - tenderRank(b) || a.localeCompare(b));
  const exportChart: ReportChart | null = tenders.length
    ? {
        type: 'donut',
        title: t('paymentsTitle'),
        labels: tenders.map(([m]) => methodLabel(m)),
        series: [{ name: t('paymentsTitle'), values: tenders.map(([, amount]) => moneyValue(amount)) }],
        kind: 'money',
      }
    : null;
  const pdfTableId = exported.tables.some((tb) => tb.id === 'tills') ? 'tills' : undefined;
  const print = (pdf = false) => {
    if (pdf) toast.info(tp('pdfHint'));
    if (view === 'till') {
      if (tillDoc.data) void printTillReceipts([tillDoc.data], title);
      return;
    }
    setPrintedAt(new Date().toISOString());
    // Let the new timestamp render before the dialog snapshots the page; the title
    // names the file when it is saved as PDF.
    const parentTitle = document.title;
    document.title = title;
    window.setTimeout(() => {
      window.print();
      document.title = parentTitle;
    }, 50);
  };
  const printDisabled = view === 'till' && !tillDoc.data;

  return (
    <>
      <div className="space-y-6 print:hidden">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-1">
              <FileBarChart className="h-5 w-5 text-muted-foreground me-1" aria-hidden />
              <h1 className="text-2xl font-bold">{zTitle(zNumberSourceOf(z))}</h1>
              <ZBadges z={z} />
              {/* A local shop Z: the printed Z is the Z. A till Z of a later run: its start. */}
              <AsPrintedBadge z={z} />
              <ZRun z={z} className="ms-2 text-sm text-muted-foreground" />
            </div>
            <p className="text-muted-foreground text-sm">
              <NumberPill n={z.shopNumber} className="me-1" />
              {z.shopName ?? z.business?.shopName ?? '—'} ·{' '}
              {/* On every Z: two Z sequences of one branch are told apart by the till. */}
              {z.branchCode ? <><BranchCode code={z.branchCode} /> · </> : null}
              {areaName ? <>{t('areaValue', { area: areaName })} · </> : null}
              {t('businessDateValue', { date: formatDate(z.businessDate) })}
            </p>
            <ZProducedBy z={z} className="text-muted-foreground text-xs" />
            <ZScopeLine z={z} />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {/* The designed PDF, Excel and CSV — no print template: the Z prints its own fiscal
                document (A4 or the till's paper) with the buttons beside it. */}
            <StandaloneExportBar
              reportKey="z-report"
              title={zTitle(zNumberSourceOf(z))}
              tables={exported.tables}
              extraSheets={exported.extraSheets}
              pdfTableId={pdfTableId}
              from={z.businessDate}
              to={z.businessDate}
              place={[z.shopName ?? z.business?.shopName, areaName].filter(Boolean).join(' · ') || null}
              noPrint
              reportType="z-report"
              kpis={exportKpis}
              chart={exportChart}
              insightKeys={pdfTableId ? { label: 'machineName', value: 'salesAfterDiscounts', count: 'documents' } : undefined}
            />
            <ZPrintViewToggle value={view} onChange={setView} />
            <Button size="sm" onClick={() => print()} disabled={printDisabled}>
              <Printer className="h-4 w-4 me-1" aria-hidden />
              {t('printButton')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => print(true)} disabled={printDisabled}>
              <FileDown className="h-4 w-4 me-1" aria-hidden />
              {tp('pdf')}
            </Button>
            <Link href="/dashboard/z-reports" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              {t('backToList')}
            </Link>
          </div>
        </div>

        {z.totalsMismatch ? (
          <div className="flex gap-2 rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
            {t('totalsMismatchNotice')}
          </div>
        ) : null}
        {/* Closed at the till with no connection, and the card transmission before it. */}
        <OfflineZPanel z={z} />
        {/* A local shop Z: its check against the cloud's documents, and support's close. */}
        <ZVerificationPanel z={z} />
        {z.reconstructed ? (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
            {t('reconstructedNotice')}
          </div>
        ) : null}
        {late > 0 ? (
          <div className="flex gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            <AlertTriangle className="h-4 w-4 shrink-0 mt-0.5" aria-hidden />
            {t('lateNotice', { count: late })}
          </div>
        ) : null}
        {offline ? <OfflineNotice figures={offline} /> : null}
        {/* Frozen at build: the tills the operator confirmed producing this shop Z without. */}
        <OpenTillsRecord left={z.business?.openTillsLeftOut} />
        {z.legacy ? (
          <div className="rounded-md border bg-muted/40 p-3 text-sm">
            {t('legacyNotice', { till: z.machineName ?? z.machineId ?? '—' })}
          </div>
        ) : null}

        {view === 'till' ? (
          <div className="space-y-2">
            <p className="text-muted-foreground text-xs">{tp('tillHint')}</p>
            {tillDoc.isLoading ? (
              <Skeleton className="h-96 w-[80mm] max-w-full" />
            ) : tillDoc.isError || !tillDoc.data ? (
              <ReportErrorState message={axiosErrorToToastMessage(tillDoc.error, tp('loadError'))} />
            ) : (
              <ZTillReceipt doc={tillDoc.data} />
            )}
          </div>
        ) : (
        <>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">{t('header.title')}</CardTitle>
          </CardHeader>
          <CardContent>
            <Header z={z} />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="grid grid-cols-2 gap-4 pt-4 sm:grid-cols-3 lg:grid-cols-5">
            <Fact label={t('periodStart')}>{formatDateTime(z.periodStart)}</Fact>
            <Fact label={t('periodEnd')}>{formatDateTime(z.periodEnd)}</Fact>
            <Fact label={t('closedAt')}>{formatDateTime(z.closedAt)}</Fact>
            <Fact label={t('tills')}>{z.machineCount ?? z.perMachine.length}</Fact>
            <Fact label={t('shiftsCount')}>{z.shiftCount ?? z.shifts.length}</Fact>
          </CardContent>
        </Card>

        <div className="grid gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{t('totalsTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              <SalesRows x={z} dealerType={z.business?.dealerType} />
              <MoneyRow label={t('documentsSalesAndCredits')}>{z.transactionsCount ?? '—'}</MoneyRow>
              <p className="text-muted-foreground pt-1 text-xs">{t('salesNetHint')}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{t('paymentsTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="text-sm">
              <PaymentBreakdownRows breakdown={z.paymentBreakdown} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">{t('cashTitle')}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1 text-sm">
              <MoneyRow label={t('openingCash')} value={z.openingCash} />
              {hasBetweenShiftAdjustments(z.betweenShiftAdjustments) ? (
                <MoneyRow label={t('betweenShiftAdjustments')}>
                  <SignedMoney value={z.betweenShiftAdjustments} />
                </MoneyRow>
              ) : null}
              {cashMovementRows(z.cashMovements).map((r) => (
                <MoneyRow key={r.key} label={t(r.key)}>
                  <SignedMoney value={r.value} />
                </MoneyRow>
              ))}
              {cashWalletRows(z.cashWallets).map((r) => (
                <MoneyRow key={r.key} label={t(r.key)}>
                  <SignedMoney value={r.value} />
                </MoneyRow>
              ))}
              <MoneyRow label={t('expectedCash')} value={z.expectedCash} />
              <MoneyRow label={t('actualCash')}>
                {withheld ? (
                  <span className="text-muted-foreground text-xs">
                    {uncountedShifts > 0 ? t('uncountedShifts', { count: uncountedShifts }) : t('notCounted')}
                  </span>
                ) : (
                  formatCurrency(z.actualCash)
                )}
              </MoneyRow>
              <MoneyRow label={t('discrepancy')}>
                <OverShort value={z.discrepancy} uncountedLabel={t('discrepancyWithheld')} />
              </MoneyRow>
              {withheld ? <p className="text-muted-foreground pt-1 text-xs">{t('cashWithheldHint')}</p> : null}
              {/* "מזומן אצל עובדים (טרם הופקד)" (drawer-away §5.6): as frozen when the Z was built. */}
              {cashWithStaffRows(z.cashWithStaff).rows.length > 0 ? (
                <div className="mt-2 space-y-1 border-t pt-2">
                  <p className="text-xs font-medium">{t('cashWithStaff')}</p>
                  {cashWithStaffRows(z.cashWithStaff).rows.map((r) => (
                    <MoneyRow key={r.employeeId} label={r.name} value={r.amount} />
                  ))}
                  <MoneyRow label={t('cashWithStaffTotal')} value={cashWithStaffRows(z.cashWithStaff).total} strong />
                </div>
              ) : null}
            </CardContent>
          </Card>
        </div>

        {/* "מזומן במגירה" (P:/specs/x-z-cash-with-tips.md): always; over several drawers, per till. */}
        <CashWithTipsCard z={z} />

        {/* "דו״ח Z — גרסה 2": the owner's sections, the lines the till and the cloud print. */}
        <ZReportSectionsCards
          sections={z.reportSections}
          source={z.reportSectionsSource}
          exempt={z.business?.dealerType === 'exempt'}
        />

        <CardBrandSummaryCard rows={z.cardBrands} source={z.cardBrandsSource} />

        <WaiterSummaryCard rows={z.byWaiter} source={z.byWaiterSource} />

        {z.perMachine.length > 0 ? (
          <div className="space-y-3">
            <h2 className="text-lg font-semibold">{t('tillsTitle')}</h2>
            {z.perMachine.map((s) => (
              <TillCard key={sectionKeyOf(s)} s={s} shifts={sectionShifts(s)} dealerType={z.business?.dealerType} zId={z.id} />
            ))}
          </div>
        ) : z.shifts.length > 0 ? (
          <Card>
            <CardContent className="p-0">
              <ShiftTable shifts={z.shifts} />
            </CardContent>
          </Card>
        ) : null}

        {z.legacy && z.payload ? (
          <details className="rounded border p-2">
            <summary className="cursor-pointer text-xs text-muted-foreground">{t('rawPayload')}</summary>
            <pre className="mt-2 max-h-72 overflow-auto rounded bg-muted/40 p-2 text-xs" dir="ltr">
              {JSON.stringify(z.payload, null, 2)}
            </pre>
          </details>
        ) : null}
        </>
        )}
      </div>

      <ZPrintDocument z={z} printedAt={printedAt} />
    </>
  );
}
