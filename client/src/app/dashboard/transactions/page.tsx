'use client';

/**
 * Transactions (עסקאות) — every document the tills synced, newest first, 50 to a page, with
 * the search that finds one: its number or amount, a kiosk pickup number, the buyer, a card's
 * last four digits, a product, the tender, several tills, document types, employees and
 * statuses, an amount range, a document number (docs/SPEC_REPORTS.md §1), a table ("שולחן":
 * the filter, or "ש12" / "שולחן 12" / a table's name in the search — lib/tableSearch.ts; each
 * row says its table beside its number, P:\specs\history-table-search.md).
 *
 * On the report framework (P:\specs\reports-upgrade.md §5): the days and the search in the
 * report bar, the list's own filters beside them (`lib/transactionsFilters.ts`), all in the URL —
 * a link is the search. A first visit lists the newest documents of every day, as always; a
 * range narrows them once run. The table sorts its page and has a column chooser; the tip of
 * each document is a column of its own (§2ה). Excel / PDF take every document the filters match
 * (`GET /transactions/export`), with the export's own columns to choose from
 * (lib/listExportColumns.ts). `?tx=<id>` opens that document (a link from another page).
 */

import { useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { receiptDocumentKey } from '@/lib/dealerType';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { usePageScope } from '@/lib/scope';
import { findBySameId } from '@/lib/entityLookup';
import { usePaymentMethodLabel } from '@/components/dashboard/shifts/shift-parts';
import { useCardBrandLabels } from '@/lib/cardBrands';
import {
  OfflineOutcome,
  Transaction,
  TransactionListResponse,
  TransactionStatus,
} from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { ChevronLeft, ChevronRight, FileDown, Printer } from 'lucide-react';
import { toast } from 'sonner';
import { formatCurrency, formatDateTime } from '@/lib/format';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  PrintDocument,
  PrintDocumentList,
  printDocumentsOf,
  printReceiptDocuments,
} from '@/components/print/receipt-print-document';
import { KioskPickupBadges } from '@/components/dashboard/kiosks/kiosk-pickup-badges';
import { tableLabel } from '@/lib/tableSearch';
import { FailedPaymentsTable } from '@/components/dashboard/failed-payments/failed-payments-table';
import { EntityMultiSelect } from '@/components/dashboard/entity-multi-select';
import { fetchTransactionsExport, type TransactionExportRow } from '@/lib/reportCenterApi';
import { transactionExportColumns } from '@/lib/listExportColumns';
import { numberedLabel } from '@/lib/orgNumber';
import { parseReportFilters, type ReportFilterSpec } from '@/lib/reportFilters';
import type { ReportFilterLine } from '@/lib/reportExport';
import { todayIso } from '@/lib/reportWindow';
import {
  TX_DOCUMENT_TYPES,
  TX_EXTRAS,
  TX_METHODS,
  TX_STATUSES,
  listOf,
  listValue,
  transactionsQuery,
  txExtrasOf,
  txMethodOf,
  type TxExtras,
} from '@/lib/transactionsFilters';
import {
  ReportPage,
  ReportTable,
  reportQueryState,
  useReportFilters,
  type ReportColumn,
  type ReportTableSpec,
} from '@/components/dashboard/report-framework';
import {
  RemoteCreditBadges,
  RemoteCreditButton,
  RemoteCreditSection,
} from '@/components/dashboard/remote-credit/remote-credit-actions';
import {
  CloudCardRefundLegBadge,
  CloudCardRefundLegButton,
  CloudCardRefundSection,
} from '@/components/dashboard/cloud-card-refund/cloud-card-refund-actions';

const PAGE_SIZE = 50;

/** The days and the free search in the bar; the list's own filters as the report's extras. */
const SPEC: ReportFilterSpec = { filters: ['search'], extras: TX_EXTRAS };

function statusVariant(s: TransactionStatus): 'default' | 'secondary' | 'outline' | 'destructive' {
  switch (s) {
    case 'completed': return 'default';
    case 'refunded': return 'destructive';
    case 'partial_refund': return 'secondary';
    case 'cancelled': return 'outline';
    default: return 'outline';
  }
}

/**
 * A card sale the terminal approved offline: red once the acquirer declined it on the
 * later authorization run (the document stands, the money will not come), quiet when
 * the run approved it.
 */
function OfflineOutcomeBadge({ outcome }: { outcome?: OfflineOutcome | null }) {
  const t = useTranslations('transactions');
  if (!outcome) return null;
  return (
    <Badge variant={outcome === 'declined' ? 'destructive' : 'outline'} className="ms-1">
      {t(`offlineOutcome.${outcome}`)}
    </Badge>
  );
}

/** 320 / 330 in words; an exempt dealer's receipt (400) and receipt refund (-400); any other type as its number. */
function useDocumentTypeLabel() {
  const t = useTranslations('transactions');
  // An exempt dealer's receipt (400) and receipt refund (-400, docs/SPEC_BUSINESS_TYPE.md).
  const tb = useTranslations('businessType');
  return (type: number | null | undefined): string => {
    const receipt = receiptDocumentKey(type);
    if (receipt) return tb(receipt);
    return type === 320 ? t('documentTypes.320') : type === 330 ? t('documentTypes.330') : String(type ?? '—');
  };
}

const tipOf = (tx: Transaction): number => Number(tx.tipAmount ?? 0) || 0;

/**
 * Beside the number: the table the document paid ("שולחן 12", "שולחן 9012 · ש-12") and when its
 * order was opened — a table opened twice a day is two orders. Filled when the search found it by
 * its table ("ש12", a name, the "שולחן" filter).
 */
function TableBadge({ tx }: { tx: Transaction }) {
  const t = useTranslations('transactions');
  const label = tableLabel(t('tableWord'), tx.tableNumber, tx.tableName);
  if (!label) return null;
  return (
    <Badge variant={tx.matchedBy?.includes('table') ? 'default' : 'outline'} className="ms-2 font-sans" title={t('tableTitle')}>
      <bdi>{label}</bdi>
      {tx.tableOpenedAt ? <span className="ms-1 opacity-80">· {formatDateTime(tx.tableOpenedAt)}</span> : null}
    </Badge>
  );
}

export default function TransactionsPage() {
  const t = useTranslations('transactions');
  const tr = useTranslations('transactions.report');
  const tcols = useTranslations('reportCenter.cols');
  // Each type has its own number series: a number is shown with its type.
  const documentTypeLabel = useDocumentTypeLabel();
  const brandLabels = useCardBrandLabels();
  const paymentLabel = usePaymentMethodLabel();
  // `GET /transactions` filters by machineId and shopId. There is no companyId
  // filter, so a company in scope is called out instead of being dropped, which
  // would have shown the whole tenant under a company heading.
  const { scope, resolution, effective } = usePageScope({
    maxLevel: 'machine',
    unsupported: ['company'],
  });
  const shopId = effective.shopId;
  const machineId = effective.machineId;

  const filters = useReportFilters(SPEC);
  const searchParams = useSearchParams();
  // `?tx=<id>` opens that document — the link from another page (e.g. exceptions).
  const [selectedId, setSelectedId] = useState<string | null>(() => searchParams.get('tx'));

  // What the list runs on: the URL. Before a range is run the newest documents of every day
  // (as this list always opened), with whatever else a link narrows by.
  const urlKey = searchParams.toString();
  const parsed = useMemo(() => parseReportFilters(new URLSearchParams(urlKey), SPEC, todayIso()), [urlKey]);
  const extras = useMemo(() => txExtrasOf(parsed.extras), [parsed.extras]);
  const method = txMethodOf(extras.method);
  const q = parsed.values.q;
  const filterParams = useMemo(
    () =>
      transactionsQuery({
        from: parsed.applied ? parsed.values.from : null,
        to: parsed.applied ? parsed.values.to : null,
        q,
        extras,
        shopId,
        machineId,
      }),
    [extras, machineId, parsed.applied, parsed.values.from, parsed.values.to, q, shopId],
  );

  // A new search or scope is a new set of documents: page 7 of the old one means nothing.
  // Reset during render, so no request goes out for "page 7 of the shop we just switched to".
  const [page, setPage] = useState(1);
  const filterKey = JSON.stringify(filterParams);
  const [pageKey, setPageKey] = useState(filterKey);
  if (pageKey !== filterKey) {
    setPageKey(filterKey);
    setPage(1);
  }
  const params = useMemo(() => ({ ...filterParams, page, pageSize: PAGE_SIZE }), [filterParams, page]);

  const list = useQuery<TransactionListResponse>({
    queryKey: ['transactions', params],
    // Lists go as `machineIds=a&machineIds=b`: FastAPI ignores axios' default `machineIds[]=`.
    queryFn: () => api.get('/transactions', { params, paramsSerializer: { indexes: null } }).then((r) => r.data),
    placeholderData: (prev) => prev,
    enabled: method !== 'failed',
  });
  const data = list.data;

  // The tills to pick from: the scope's shop's, else every till the reader sees.
  const tillOptions = useMemo(
    () =>
      scope.machines
        .filter((m) => !shopId || m.shopId === shopId)
        .map((m) => ({
          id: m.id,
          label: m.posNumber ? `${t('tillPrefix')} ${m.posNumber} · ${m.name}` : m.name,
          hint: shopId ? null : (() => {
            const shop = findBySameId(scope.shops, m.shopId);
            return shop ? numberedLabel(shop.shopNumber, shop.name) : null;
          })(),
        })),
    [scope.machines, scope.shops, shopId, t],
  );
  // The employees who issued documents in the window (the cashier report's rows).
  const days = { from: filterParams.from as string | undefined, to: filterParams.to as string | undefined };
  const { data: cashierReport } = useQuery<{ rows: { cashierId: string | null; cashierName: string | null }[] }>({
    queryKey: ['transactions-cashiers', shopId, machineId, days.from, days.to],
    queryFn: () =>
      api
        .get('/reports/cashiers', {
          params: {
            ...(shopId ? { shopId } : {}),
            ...(machineId ? { machineId } : {}),
            ...(days.from ? { from: days.from } : {}),
            ...(days.to ? { to: days.to } : {}),
          },
        })
        .then((r) => r.data),
    staleTime: 60_000,
  });
  const cashierOptions = useMemo(
    () =>
      (cashierReport?.rows ?? [])
        .filter((r) => r.cashierId)
        .map((r) => ({ id: r.cashierId as string, label: r.cashierName ?? (r.cashierId as string) })),
    [cashierReport],
  );
  const typeOptions = TX_DOCUMENT_TYPES.map((n) => ({ id: String(n), label: documentTypeLabel(n) }));
  const statusOptions = TX_STATUSES.map((s) => ({ id: s, label: t(`statusLabels.${s}`) }));
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  // ── The list's own filters in the bar (the draft, run with "הפק דוח" or Enter) ──
  const draft = txExtrasOf(filters.draftExtras);
  const setDraft = (key: keyof TxExtras, value: string) => filters.setExtra(key, value);
  const canRun = Boolean(filters.draft.from && filters.draft.to && filters.draft.from <= filters.draft.to);
  const runOnEnter = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && canRun) filters.run();
  };
  const barFields = (
    <>
      <div className="min-w-0 space-y-1">
        <Label className="text-xs">{t('searchCard')}</Label>
        <Input
          value={draft.card}
          inputMode="numeric"
          maxLength={4}
          dir="ltr"
          placeholder="••••"
          onChange={(e) => setDraft('card', e.target.value.replace(/\D/g, '').slice(0, 4))}
          onKeyDown={runOnEnter}
        />
      </div>
      <div className="min-w-0 space-y-1">
        <Label className="text-xs">{t('searchItem')}</Label>
        <Input value={draft.item} onChange={(e) => setDraft('item', e.target.value.slice(0, 80))} onKeyDown={runOnEnter} />
      </div>
      <div className="min-w-0 space-y-1">
        <Label className="text-xs">{t('filterDocumentNumber')}</Label>
        <Input
          value={draft.doc}
          inputMode="numeric"
          dir="ltr"
          placeholder="20000057"
          onChange={(e) => setDraft('doc', e.target.value.replace(/[^\d-]/g, '').slice(0, 20))}
          onKeyDown={runOnEnter}
        />
      </div>
      {/* "שולחן": "12" is table 12 (never a document number or an amount), other text a table's
          name ("VIP", "ש-12"). As typed (a name has spaces): the query trims it. */}
      <div className="min-w-0 space-y-1">
        <Label className="text-xs">{t('filterTable')}</Label>
        <Input
          value={filters.draftExtras.table ?? ''}
          placeholder={t('filterTablePlaceholder')}
          onChange={(e) => setDraft('table', e.target.value.slice(0, 60))}
          onKeyDown={runOnEnter}
        />
      </div>
      <div className="grid min-w-0 grid-cols-2 gap-2">
        <div className="min-w-0 space-y-1">
          <Label className="text-xs">{t('filterAmountMin')}</Label>
          <Input
            value={draft.amountMin}
            inputMode="decimal"
            dir="ltr"
            onChange={(e) => setDraft('amountMin', e.target.value.replace(/[^\d.-]/g, ''))}
            onKeyDown={runOnEnter}
          />
        </div>
        <div className="min-w-0 space-y-1">
          <Label className="text-xs">{t('filterAmountMax')}</Label>
          <Input
            value={draft.amountMax}
            inputMode="decimal"
            dir="ltr"
            onChange={(e) => setDraft('amountMax', e.target.value.replace(/[^\d.-]/g, ''))}
            onKeyDown={runOnEnter}
          />
        </div>
      </div>
      {/* By till (several at once), document type, employee and status. */}
      {machineId ? null : (
        <EntityMultiSelect
          label={t('filterTills')}
          options={tillOptions}
          selected={listOf(draft.tills)}
          onChange={(next) => setDraft('tills', listValue(next))}
          allLabel={t('filterAllTills')}
          clearLabel={t('filterClear')}
          emptyLabel={t('filterNoTills')}
        />
      )}
      <EntityMultiSelect
        label={t('filterDocumentTypes')}
        options={typeOptions}
        selected={listOf(draft.types)}
        onChange={(next) => setDraft('types', listValue(next))}
        allLabel={t('filterAllTypes')}
        clearLabel={t('filterClear')}
        emptyLabel={t('filterAllTypes')}
      />
      <EntityMultiSelect
        label={t('filterEmployees')}
        options={cashierOptions}
        selected={listOf(draft.employees)}
        onChange={(next) => setDraft('employees', listValue(next))}
        allLabel={t('filterAllEmployees')}
        clearLabel={t('filterClear')}
        emptyLabel={t('filterNoEmployees')}
      />
      <EntityMultiSelect
        label={t('filterStatuses')}
        options={statusOptions}
        selected={listOf(draft.statuses)}
        onChange={(next) => setDraft('statuses', listValue(next))}
        allLabel={t('filterAllStatuses')}
        clearLabel={t('filterClear')}
        emptyLabel={t('filterAllStatuses')}
      />
      {/* The tender: a tender of the document or of any of its legs; split; credit notes; failed attempts. */}
      <div className="col-span-full flex flex-wrap items-center gap-2" role="group" aria-label={t('searchMethod')}>
        <span className="text-muted-foreground text-xs">{t('searchMethod')}</span>
        <Button
          size="sm"
          variant={draft.method === '' ? 'default' : 'outline'}
          className="rounded-full"
          onClick={() => setDraft('method', '')}
        >
          {t('all')}
        </Button>
        {TX_METHODS.map((m) => (
          <Button
            key={m}
            size="sm"
            variant={draft.method === m ? 'default' : 'outline'}
            className="rounded-full"
            aria-pressed={draft.method === m}
            onClick={() => setDraft('method', m)}
          >
            {t(`searchMethods.${m}`)}
          </Button>
        ))}
        {extras.basket ? (
          <Badge variant="outline" className="gap-1">
            {t('basket')}
            <button type="button" className="hover:text-destructive" aria-label={t('filterClear')} onClick={() => setDraft('basket', '')}>
              ×
            </button>
          </Badge>
        ) : null}
      </div>
    </>
  );

  // ── What the export header says the list's own filters are ──
  const extraLines = useMemo<ReportFilterLine[]>(() => {
    const names = (ids: string[], options: { id: string; label: string }[]) =>
      ids.map((id) => options.find((o) => o.id === id)?.label ?? id).join(', ');
    const lines: ReportFilterLine[] = [];
    const tills = listOf(extras.tills);
    if (tills.length && !machineId) lines.push({ label: t('filterTills'), value: names(tills, tillOptions) });
    const types = listOf(extras.types);
    if (types.length) lines.push({ label: t('filterDocumentTypes'), value: names(types, typeOptions) });
    const employees = listOf(extras.employees);
    if (employees.length) lines.push({ label: t('filterEmployees'), value: names(employees, cashierOptions) });
    const statuses = listOf(extras.statuses);
    if (statuses.length) lines.push({ label: t('filterStatuses'), value: names(statuses, statusOptions) });
    if (method) lines.push({ label: t('searchMethod'), value: t(`searchMethods.${method}`) });
    if (/^\d{4}$/.test(extras.card)) lines.push({ label: t('searchCard'), value: extras.card });
    if (extras.item) lines.push({ label: t('searchItem'), value: extras.item });
    if (extras.doc) lines.push({ label: t('filterDocumentNumber'), value: extras.doc });
    if (extras.table) lines.push({ label: t('filterTable'), value: extras.table });
    if (extras.amountMin) lines.push({ label: t('filterAmountMin'), value: extras.amountMin });
    if (extras.amountMax) lines.push({ label: t('filterAmountMax'), value: extras.amountMax });
    if (extras.basket) lines.push({ label: t('basket'), value: extras.basket.slice(0, 8) });
    return lines;
  }, [cashierOptions, extras, machineId, method, statusOptions, t, tillOptions, typeOptions]);

  // ── The table on screen: this page of documents ──
  const table = useMemo<ReportTableSpec<Transaction>>(() => {
    const machineName = (tx: Transaction) => findBySameId(scope.machines, tx.machineId)?.name ?? tx.machineId.slice(0, 8);
    const columns: ReportColumn<Transaction>[] = [
      {
        key: 'txNumber',
        header: t('txNumber'),
        required: true,
        value: (tx) => tx.documentNumber ?? tx.transactionNumber,
        className: 'font-mono text-xs',
        cell: (tx) => (
          <>
            {/* As the till printed it: `20000057` ("קידומת מסמכים"), with its type —
                each type has its own number series. */}
            {tx.documentNumber ?? tx.transactionNumber}
            <span className="text-muted-foreground ms-2 font-sans">{documentTypeLabel(tx.documentType)}</span>
            {tx.basketId && (
              <Badge variant="outline" className="ms-2 font-sans">{t('basket')}</Badge>
            )}
            <KioskPickupBadges pickup={tx.kioskPickup} matchedBy={tx.matchedBy} query={q} className="ms-2" />
            <TableBadge tx={tx} />
            {tx.reissueOfTransactionId && (
              <Badge variant="outline" className="ms-2 font-sans">{t('reissueBadge')}</Badge>
            )}
            {/* "פרטי לקוח לחשבונית": who the invoice is made out to — what the search finds. */}
            {(tx.customerName || tx.customerVatNumber) && (
              <div className="font-sans text-muted-foreground whitespace-normal">
                {[tx.customerName, tx.customerVatNumber].filter(Boolean).join(' · ')}
              </div>
            )}
          </>
        ),
      },
      { key: 'createdAt', header: t('createdAt'), kind: 'datetime', value: (tx) => tx.createdAt },
      { key: 'machine', header: t('machine'), value: machineName },
      { key: 'cashier', header: t('cashier'), value: (tx) => tx.cashierId ?? null },
      { key: 'payment', header: t('payment'), value: (tx) => (tx.paymentMethod ? paymentLabel(tx.paymentMethod) : null) },
      {
        key: 'cardBrand',
        header: t('cardBrand'),
        value: (tx) => (tx.cardBrands?.length ? tx.cardBrands.map(brandLabels.brand).join(', ') : null),
      },
      {
        key: 'status',
        header: t('status'),
        value: (tx) => t(`statusLabels.${tx.status}`),
        cell: (tx) => (
          <>
            <Badge variant={statusVariant(tx.status)}>{t(`statusLabels.${tx.status}`)}</Badge>
            <OfflineOutcomeBadge outcome={tx.offlineOutcome} />
            {/* A re-issue pair moves no money by design — its own badge, not "עסקה שלא בוצעה". */}
            <RemoteCreditBadges tx={tx.reissueOfTransactionId ? { ...tx, noMoneyMovement: false } : tx} />
          </>
        ),
      },
      { key: 'amount', header: t('amount'), kind: 'money', value: (tx) => tx.totalAmount, className: 'font-medium' },
      {
        // The tip apart from the amount — never inside a tender (§2ה) — and the tender it went on.
        key: 'tip',
        header: tr('tip'),
        kind: 'money',
        value: (tx) => (tipOf(tx) ? tipOf(tx) : null),
        cell: (tx) =>
          tipOf(tx) ? (
            <span>
              {formatCurrency(tipOf(tx))}
              {tx.tipPaymentMethod ? (
                <span className="text-muted-foreground block text-xs">{paymentLabel(tx.tipPaymentMethod)}</span>
              ) : null}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        key: 'actions',
        header: tr('actions'),
        screenOnly: true,
        sortable: false,
        value: () => null,
        cell: (tx) => (
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                setSelectedId(tx.id);
              }}
            >
              {t('viewDetails')}
            </Button>
            {/* "צור זיכוי" (docs/SPEC_REMOTE_CREDIT.md): owners and managers, sales only. */}
            <RemoteCreditButton tx={tx} size="sm" variant="ghost" stopPropagation onOpenDocument={setSelectedId} />
          </div>
        ),
      },
    ];
    return {
      id: 'main',
      title: t('title'),
      columns,
      rows: data?.items ?? [],
      rowKey: (tx) => tx.id,
      emptyText: t('noTransactions'),
      onRowClick: (tx) => setSelectedId(tx.id),
      // The export is every document the filters match (below), not this page.
      noExport: true,
    };
  }, [brandLabels, data, documentTypeLabel, paymentLabel, q, scope.machines, t, tr]);

  // ── The export: every document the filters match, with the export's own columns ──
  const exportTable = useMemo<ReportTableSpec<TransactionExportRow>>(() => {
    const text = (key: string) => (key === 'tipMethod' ? tr('tipMethod') : tcols(key));
    const cols = transactionExportColumns(text, {
      documentType: documentTypeLabel,
      status: (s) => t(`statusLabels.${s}`),
      method: paymentLabel,
    });
    return {
      id: 'documents',
      columns: cols.map((c) => ({ key: c.key, header: c.header, kind: c.kind, width: c.width, value: c.value, totalOf: c.total })),
      rows: [],
      rowKey: (r) => r.id,
      totalsLabel: tcols('total'),
      exportRows: async () => (await fetchTransactionsExport(filterParams)).items,
    };
  }, [documentTypeLabel, filterParams, paymentLabel, t, tcols, tr]);

  const failed = method === 'failed';
  const query = failed
    ? { isLoading: false, isFetching: false, isError: false, hasData: true }
    : reportQueryState(list);

  return (
    <>
      <ReportPage
        reportKey="transactions"
        title={t('title')}
        subtitle={t('subtitle')}
        resolution={resolution}
        filters={filters}
        bar={{
          shopId,
          children: barFields,
          hint: [tr('searchHint', { what: t('searchText') }), parsed.applied ? '' : tr('allDays')].filter(Boolean).join(' '),
        }}
        query={query}
        prompt={t('noTransactions')}
        ready
        loading="table"
        export={
          failed
            ? null
            : {
                tables: [exportTable as ReportTableSpec<unknown>],
                from: parsed.applied ? parsed.values.from : null,
                to: parsed.applied ? parsed.values.to : null,
                filterLines: extraLines,
                disabled: !data || data.total === 0,
              }
        }
      >
        {failed ? (
          /* "ניסיונות תשלום שנכשלו": no documents — their own list, in the same till / shop / dates. */
          <FailedPaymentsTable
            machineId={machineId}
            shopId={shopId}
            from={parsed.applied ? parsed.values.from : undefined}
            to={parsed.applied ? parsed.values.to : undefined}
            cardLast4={/^\d{4}$/.test(extras.card) ? extras.card : undefined}
            onOpenTransaction={setSelectedId}
          />
        ) : (
          <>
            <ReportTable table={table} />
            {data && data.total > 0 ? (
              <div className="flex flex-wrap items-center justify-between gap-2 text-sm print:hidden">
                <span className="text-muted-foreground">
                  {t('pageInfo', { page: String(page), pages: String(totalPages) })}
                  {' · '}
                  {tr('documents', { count: data.total })}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={page <= 1 || list.isFetching}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    <ChevronRight className="h-4 w-4" />
                    {t('previousPage')}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={page >= totalPages || list.isFetching}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  >
                    {t('nextPage')}
                    <ChevronLeft className="h-4 w-4" />
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </ReportPage>

      <TransactionDetailsDialog
        id={selectedId}
        onClose={() => setSelectedId(null)}
        onSelect={setSelectedId}
      />
    </>
  );
}

function TransactionDetailsDialog({
  id,
  onClose,
  onSelect,
}: {
  id: string | null;
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  const t = useTranslations('transactions');
  const brandLabels = useCardBrandLabels();
  const paymentLabel = usePaymentMethodLabel();
  const documentTypeLabel = useDocumentTypeLabel();
  const enabled = !!id;
  const { data, isLoading } = useQuery<Transaction>({
    queryKey: ['transaction', id],
    queryFn: () => api.get(`/transactions/${id}`).then((r) => r.data),
    enabled,
  });

  return (
    <Dialog open={enabled} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('details')}</DialogTitle>
        </DialogHeader>
        {isLoading || !data ? (
          <div className="space-y-2">
            <Skeleton className="h-6 w-2/3" />
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : (
          <div className="space-y-4 text-sm">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">{t('txNumber')}</Label>
                <div className="font-mono">{data.documentNumber ?? data.transactionNumber}</div>
                <div className="text-muted-foreground text-xs">{documentTypeLabel(data.documentType)}</div>
              </div>
              <div>
                <Label className="text-xs">{t('createdAt')}</Label>
                <div>{formatDateTime(data.createdAt)}</div>
              </div>
              <div>
                <Label className="text-xs">{t('status')}</Label>
                <Badge variant={statusVariant(data.status)}>{t(`statusLabels.${data.status}`)}</Badge>
                <OfflineOutcomeBadge outcome={data.offlineOutcome} />
              </div>
              <div>
                <Label className="text-xs">{t('payment')}</Label>
                <div>{data.paymentMethod ? paymentLabel(data.paymentMethod) : '—'}</div>
              </div>
              <div>
                <Label className="text-xs">{t('cashier')}</Label>
                <div>{data.cashierId ?? '—'}</div>
              </div>
              {data.refundOfTransactionId && (
                <div>
                  <Label className="text-xs">{t('originalTransaction')}</Label>
                  <div className="font-mono text-xs">
                    {data.refundOfTransactionNumber ?? data.refundOfTransactionId}
                  </div>
                </div>
              )}
              {data.reissueOfTransactionId && (
                <div>
                  <Label className="text-xs">{t('reissueOf')}</Label>
                  <div className="font-mono text-xs">
                    {data.reissueOfTransactionNumber ?? data.reissueOfTransactionId}
                  </div>
                </div>
              )}
              {(data.customerName || data.customerPhone || data.customerAddress || data.customerVatNumber || data.customerEmail) && (
                <div className="col-span-2">
                  <Label className="text-xs">{t('customer')}</Label>
                  <div>
                    {[data.customerName, data.customerPhone, data.customerAddress].filter(Boolean).join(' · ')}
                  </div>
                  {data.customerVatNumber && (
                    <div>
                      {t('customerVatNumber')}: <span className="font-mono">{data.customerVatNumber}</span>
                    </div>
                  )}
                  {data.customerEmail && (
                    <div>
                      {t('customerEmail')}: <span dir="ltr">{data.customerEmail}</span>
                    </div>
                  )}
                </div>
              )}
              {(data.customerDetailsAdded ?? []).length > 0 && (
                <div className="col-span-2 rounded border border-dashed p-3 space-y-2" data-testid="customer-details-added">
                  <Label className="text-xs">{t('customerDetailsAdded')}</Label>
                  <div className="text-xs text-muted-foreground">{t('customerDetailsAddedNote')}</div>
                  {(data.customerDetailsAdded ?? []).map((d) => (
                    <div key={d.id} className="space-y-0.5">
                      <div>{[d.customerName, d.customerPhone, d.customerAddress].filter(Boolean).join(' · ')}</div>
                      <div>
                        {t('customerVatNumber')}: <span className="font-mono">{d.customerVatNumber}</span>
                      </div>
                      {d.customerEmail && (
                        <div>
                          {t('customerEmail')}: <span dir="ltr">{d.customerEmail}</span>
                        </div>
                      )}
                      <div className="text-xs text-muted-foreground">
                        {t('customerDetailsAddedBy', {
                          date: formatDateTime(d.addedAt),
                          name: d.addedByName ?? d.addedById ?? '—',
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {(data.claimedApproverPosUserId || data.claimedApproverUserId) && (
                <div className="col-span-2">
                  <Label className="text-xs">{t('claimedApprover')}</Label>
                  <div className="font-mono text-xs">
                    {[data.claimedApproverPosUserId, data.claimedApproverUserId].filter(Boolean).join(' · ')}
                  </div>
                </div>
              )}
            </div>

            {/* Quiet notes of ingest (docs/SHIFTS_API.md §1.2b): informational, never an alarm. */}
            {(data.ingestNotes ?? []).length > 0 && (
              <div className="rounded border border-dashed p-3 space-y-1">
                <Label className="text-xs text-muted-foreground">{t('ingestNotes')}</Label>
                <ul className="text-muted-foreground space-y-1 text-xs">
                  {(data.ingestNotes ?? []).map((note) => (
                    <li key={note.code}>{note.text}</li>
                  ))}
                </ul>
              </div>
            )}

            {(data.reissueDocuments ?? []).length > 0 && (
              <div className="rounded border p-3 space-y-2">
                <Label className="text-xs">{t('reissueDocuments')}</Label>
                {(data.reissueDocuments ?? []).map((doc) => (
                  <button
                    key={doc.id}
                    type="button"
                    className="flex w-full items-center justify-between gap-3 rounded px-2 py-1 text-start hover:bg-muted"
                    onClick={() => onSelect(doc.id)}
                  >
                    <span>
                      {documentTypeLabel(doc.documentType)}{' '}
                      <span className="font-mono text-xs">{doc.documentNumber ?? doc.transactionNumber}</span>
                    </span>
                    <span className="font-medium tabular-nums">{formatCurrency(doc.totalAmount)}</span>
                  </button>
                ))}
              </div>
            )}

            {(data.basketDocuments ?? []).length > 0 && (
              <div className="rounded border p-3 space-y-2">
                <Label className="text-xs">{t('basketDocuments')}</Label>
                {(data.basketDocuments ?? []).map((doc) => (
                  <button
                    key={doc.id}
                    type="button"
                    className="flex w-full items-center justify-between gap-3 rounded px-2 py-1 text-start hover:bg-muted"
                    onClick={() => onSelect(doc.id)}
                  >
                    <span>
                      {documentTypeLabel(doc.documentType)}{' '}
                      <span className="font-mono text-xs">{doc.documentNumber ?? doc.transactionNumber}</span>
                    </span>
                    <span className="font-medium tabular-nums">{formatCurrency(doc.totalAmount)}</span>
                  </button>
                ))}
              </div>
            )}

            <div className="rounded border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('items')}</TableHead>
                    <TableHead className="w-16 text-end">×</TableHead>
                    <TableHead className="w-28 text-end">{t('amount')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(data.items ?? []).map((it) => (
                    <TableRow key={it.id}>
                      <TableCell>
                        {it.productName ?? it.sku ?? it.productId ?? '—'}
                      </TableCell>
                      <TableCell className="text-end">{it.quantity}</TableCell>
                      <TableCell className="text-end font-medium">
                        {formatCurrency(it.totalPrice)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className="space-y-1 rounded border bg-muted/40 p-3">
              <div className="flex justify-between"><span>{t('totalAmount')}</span><span className="font-bold">{formatCurrency(data.totalAmount)}</span></div>
              {data.amountTendered != null && (
                <div className="flex justify-between"><span>{t('amountTendered')}</span><span>{formatCurrency(data.amountTendered)}</span></div>
              )}
              {data.changeAmount != null && (
                <div className="flex justify-between"><span>{t('changeAmount')}</span><span>{formatCurrency(data.changeAmount)}</span></div>
              )}
              {data.documentDiscount != null && data.documentDiscount > 0 && (
                <div className="flex justify-between"><span>{t('discount')}</span><span>{formatCurrency(data.documentDiscount)}</span></div>
              )}
              {/* The tip: apart from the document's amount, on the tender it went on. */}
              {tipOf(data) > 0 && (
                <div className="flex justify-between">
                  <span>
                    {t('report.tip')}
                    {data.tipPaymentMethod ? <span className="text-muted-foreground text-xs"> · {paymentLabel(data.tipPaymentMethod)}</span> : null}
                  </span>
                  <span>{formatCurrency(tipOf(data))}</span>
                </div>
              )}
            </div>

            {(data.payments ?? []).length > 0 && (
              <div className="space-y-1 rounded border p-3">
                <Label className="text-xs">{t('payments')}</Label>
                {(data.payments ?? []).map((leg) => (
                  <div key={leg.id} className="flex justify-between gap-2">
                    <span>
                      {paymentLabel(leg.method)}
                      {leg.cardBrand || leg.cardAcquirer ? (
                        <span className="text-muted-foreground text-xs">
                          {' · '}
                          {[
                            leg.cardBrand ? brandLabels.brand(leg.cardBrand) : null,
                            leg.cardAcquirer ? t('cardAcquirerShort', { name: brandLabels.acquirer(leg.cardAcquirer) }) : null,
                            leg.cardIssuer ? t('cardIssuerShort', { name: brandLabels.issuer(leg.cardIssuer) }) : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </span>
                      ) : null}
                      {leg.noMoneyMovement && data.reissueOfTransactionId ? (
                        <Badge variant="outline" className="ms-1">{t('reissueNoMoney')}</Badge>
                      ) : leg.noMoneyMovement ? (
                        <RemoteCreditBadges tx={{ noMoneyMovement: true }} />
                      ) : null}
                      <CloudCardRefundLegBadge leg={leg} />
                    </span>
                    <span className="flex items-center gap-2">
                      {/* "זיכוי באשראי (Z-Credit)" (SPEC_REMOTE_CREDIT.md §11): only on a Z-Credit leg. */}
                      <CloudCardRefundLegButton tx={data} leg={leg} onOpenDocument={onSelect} />
                      <span className="tabular-nums">{formatCurrency(leg.amount)}</span>
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* The card refunds the cloud made for this deal, and their credit notes. */}
            <CloudCardRefundSection tx={data} onOpenDocument={onSelect} />

            {/* "זיכוי מרחוק" (docs/SPEC_REMOTE_CREDIT.md): create one, follow it, or where this credit came from. */}
            <RemoteCreditSection tx={data} onOpenDocument={onSelect} />

            <TransactionPrintActions tx={data} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

type PrintKind = 'invoice' | 'card_slip';

/** A declined or abandoned tap is stored too, and has no voucher (the server agrees). */
const NO_VOUCHER_STATUSES: TransactionStatus[] = ['pending', 'cancelled'];

/**
 * Reprints of the document from the cloud, on 80 mm: a copy of its tax document, and
 * the card voucher of its card payments (all of them, or one when there are several).
 * Both are marked "העתק" by the server. "PDF" is the same print, to "Save as PDF".
 */
function TransactionPrintActions({ tx }: { tx: Transaction }) {
  const t = useTranslations('transactions.print');
  const [busy, setBusy] = useState(false);
  const cardLegs = NO_VOUCHER_STATUSES.includes(tx.status)
    ? []
    : (tx.payments ?? []).filter((leg) => leg.method.trim().toLowerCase() === 'card');

  const run = async (kind: PrintKind, pdf: boolean, paymentId?: string) => {
    setBusy(true);
    try {
      const params: Record<string, string> = { kind };
      if (paymentId) params.paymentId = paymentId;
      const body = await api
        .get<PrintDocument | PrintDocumentList>(`/transactions/${tx.id}/print-document`, { params })
        .then((r) => r.data);
      if (pdf) toast.info(t('pdfHint'));
      const name = kind === 'invoice' ? 'invoice' : 'card-slip';
      await printReceiptDocuments(printDocumentsOf(body), `${name}-${tx.documentNumber ?? tx.transactionNumber}`);
    } catch (err) {
      toast.error(axiosErrorToToastMessage(err, t('failed')));
    } finally {
      setBusy(false);
    }
  };

  const pair = (kind: PrintKind, label: string, paymentId?: string) => (
    <div className="inline-flex gap-1" key={`${kind}:${paymentId ?? ''}`}>
      <Button size="sm" variant="outline" disabled={busy} onClick={() => run(kind, false, paymentId)}>
        <Printer className="h-4 w-4" aria-hidden />
        {label}
      </Button>
      <Button
        size="sm"
        variant="ghost"
        disabled={busy}
        title={t('pdfHint')}
        aria-label={t('pdfLabel', { what: label })}
        onClick={() => run(kind, true, paymentId)}
      >
        <FileDown className="h-4 w-4" aria-hidden />
        {t('pdf')}
      </Button>
    </div>
  );

  return (
    <div className="space-y-2 rounded border p-3">
      <Label className="text-xs">{t('title')}</Label>
      <div className="flex flex-wrap gap-2">
        {pair('invoice', t('invoice'))}
        {cardLegs.length > 0 && pair('card_slip', cardLegs.length > 1 ? t('cardSlipAll', { count: cardLegs.length }) : t('cardSlip'))}
      </div>
      {cardLegs.length > 1 && (
        <div className="flex flex-wrap gap-2">
          {cardLegs.map((leg) => pair('card_slip', t('cardSlipLeg', { amount: formatCurrency(leg.amount) }), leg.id))}
        </div>
      )}
    </div>
  );
}
