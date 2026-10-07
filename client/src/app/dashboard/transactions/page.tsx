'use client';

import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { receiptDocumentKey } from '@/lib/dealerType';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { usePageScope } from '@/lib/scope';
import { findBySameId } from '@/lib/entityLookup';
import { ScopeGate } from '@/components/dashboard/scope-gate';
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
import { DatePicker } from '@/components/ui/date-picker';
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
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';
import { FailedPaymentsTable } from '@/components/dashboard/failed-payments/failed-payments-table';
import { EntityMultiSelect } from '@/components/dashboard/entity-multi-select';
import { fetchTransactionsExport } from '@/lib/reportCenterApi';
import { transactionsSheet } from '@/lib/reportSheets';
import { numberedLabel } from '@/lib/orgNumber';
import {
  RemoteCreditBadges,
  RemoteCreditButton,
  RemoteCreditSection,
} from '@/components/dashboard/remote-credit/remote-credit-actions';

const PAGE_SIZE = 50;

/**
 * The tender filter: a tender of the document or of any of its legs; split; credit notes;
 * and `failed` — the failed payment attempts, which are no documents at all (their own
 * list, docs/SPEC_FAILED_PAYMENTS.md).
 */
const SEARCH_METHODS = ['cash', 'card', 'voucher', 'split', 'refunds', 'failed'] as const;
type SearchMethod = (typeof SEARCH_METHODS)[number];

/** The document types a search can narrow to (docs/SPEC_REPORTS.md §1); -400: an exempt dealer's refund. */
const SEARCH_DOCUMENT_TYPES = [320, 330, 400, -400] as const;
const SEARCH_STATUSES: TransactionStatus[] = ['completed', 'refunded', 'partial_refund', 'cancelled', 'pending'];

/** `value`, once it has stopped changing for `ms` — so typing does not query per key. */
function useDebounced<T>(value: T, ms = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

function statusVariant(s: TransactionStatus): 'default' | 'secondary' | 'outline' | 'destructive' {
  switch (s) {
    case 'completed': return 'default';
    case 'refunded': return 'destructive';
    case 'partial_refund': return 'secondary';
    case 'cancelled': return 'outline';
    default: return 'outline';
  }
}

/** 320 / 330 in words; any other document type as its number. */
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

export default function TransactionsPage() {
  const t = useTranslations('transactions');
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

  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [page, setPage] = useState(1);
  // The search: number or amount, a card's last four digits, a product, the tender.
  const [q, setQ] = useState('');
  const [cardLast4, setCardLast4] = useState('');
  const [item, setItem] = useState('');
  const [method, setMethod] = useState<SearchMethod | ''>('');
  // "חיפוש לפי קופה" and the rest (docs/SPEC_REPORTS.md §1): several tills, document types,
  // employees, statuses, an amount range and a document number — all filtered by the server.
  const [tillIds, setTillIds] = useState<string[]>([]);
  const [docTypes, setDocTypes] = useState<string[]>([]);
  const [cashierIds, setCashierIds] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);
  const [amountMin, setAmountMin] = useState('');
  const [amountMax, setAmountMax] = useState('');
  const [docNumber, setDocNumber] = useState('');
  const searchQ = useDebounced(q.trim());
  const searchItem = useDebounced(item.trim());
  const searchDocNumber = useDebounced(docNumber.trim());
  const searchAmountMin = useDebounced(amountMin.trim());
  const searchAmountMax = useDebounced(amountMax.trim());
  const searchCard = cardLast4.length === 4 ? cardLast4 : '';
  const searching = !!(
    q || cardLast4 || item || method || tillIds.length || docTypes.length || cashierIds.length ||
    statuses.length || amountMin || amountMax || docNumber
  );
  const clearSearch = () => {
    setQ(''); setCardLast4(''); setItem(''); setMethod('');
    setTillIds([]); setDocTypes([]); setCashierIds([]); setStatuses([]);
    setAmountMin(''); setAmountMax(''); setDocNumber('');
    setPage(1);
  };
  // `?tx=<id>` opens that document — the link from another page (e.g. exceptions).
  const searchParams = useSearchParams();
  const [selectedId, setSelectedId] = useState<string | null>(() => searchParams.get('tx'));

  // A scope change is a different set of documents; page 7 of the old set is
  // meaningless in the new one. Reset during render, not in an effect, so no
  // request ever goes out for "page 7 of the shop we just switched to".
  const scopeKey = `${shopId ?? ''}|${machineId ?? ''}`;
  const [pageScopeKey, setPageScopeKey] = useState(scopeKey);
  if (pageScopeKey !== scopeKey) {
    setPageScopeKey(scopeKey);
    setPage(1);
  }

  // The filters without the page: what the list and its export (every row, not the page) share.
  const filterParams = useMemo(() => {
    const p: Record<string, string | number | string[]> = {};
    if (machineId) p.machineId = machineId;
    if (shopId) p.shopId = shopId;
    if (from) p.from = from;
    if (to) p.to = to;
    if (searchQ) p.q = searchQ;
    if (searchCard) p.cardLast4 = searchCard;
    if (searchItem) p.item = searchItem;
    if (method && method !== 'failed') p.method = method;
    if (tillIds.length && !machineId) p.machineIds = tillIds;
    if (docTypes.length) p.documentTypes = docTypes;
    if (cashierIds.length) p.cashierIds = cashierIds;
    if (statuses.length) p.statuses = statuses;
    if (searchAmountMin && Number.isFinite(Number(searchAmountMin))) p.amountMin = searchAmountMin;
    if (searchAmountMax && Number.isFinite(Number(searchAmountMax))) p.amountMax = searchAmountMax;
    if (searchDocNumber) p.documentNumber = searchDocNumber;
    return p;
  }, [
    machineId, shopId, from, to, searchQ, searchCard, searchItem, method, tillIds, docTypes, cashierIds,
    statuses, searchAmountMin, searchAmountMax, searchDocNumber,
  ]);
  const params = useMemo(() => ({ ...filterParams, page, pageSize: PAGE_SIZE }), [filterParams, page]);

  const { data, isLoading, isFetching } = useQuery<TransactionListResponse>({
    queryKey: ['transactions', params],
    // Lists go as `machineIds=a&machineIds=b`: FastAPI ignores axios' default `machineIds[]=`.
    queryFn: () => api.get('/transactions', { params, paramsSerializer: { indexes: null } }).then((r) => r.data),
    placeholderData: (prev) => prev,
    enabled: method !== 'failed',
  });

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
  const { data: cashierReport } = useQuery<{ rows: { cashierId: string | null; cashierName: string | null }[] }>({
    queryKey: ['transactions-cashiers', shopId, machineId, from, to],
    queryFn: () =>
      api
        .get('/reports/cashiers', {
          params: { ...(shopId ? { shopId } : {}), ...(machineId ? { machineId } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}) },
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
  const typeOptions = SEARCH_DOCUMENT_TYPES.map((n) => ({ id: String(n), label: documentTypeLabel(n) }));
  const statusOptions = SEARCH_STATUSES.map((s) => ({ id: s, label: t(`statusLabels.${s}`) }));
  const tc = useTranslations('reportCenter.cols');

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>

      <ScopeGate resolution={resolution}>
      <div className="rounded-lg border bg-card p-4 grid gap-3 md:grid-cols-2 lg:max-w-lg print:hidden">
        <div className="space-y-1">
          <Label className="text-xs">{t('filterFrom')}</Label>
          <DatePicker
            value={from}
            onChange={(e) => { setFrom(e.target.value); setPage(1); }}
            range={{ from, to, onSelect: (r) => { setFrom(r.from); setTo(r.to); setPage(1); } }}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t('filterTo')}</Label>
          <DatePicker
            value={to}
            onChange={(e) => { setTo(e.target.value); setPage(1); }}
            range={{ from, to, onSelect: (r) => { setFrom(r.from); setTo(r.to); setPage(1); } }}
          />
        </div>
      </div>

      {/* The search: number or amount, a card's last four digits, a product, the tender. */}
      <div className="rounded-lg border bg-card p-4 space-y-3 print:hidden">
        <div className="grid gap-3 md:grid-cols-3">
          <div className="space-y-1">
            <Label className="text-xs">{t('searchText')}</Label>
            <Input
              value={q}
              inputMode="decimal"
              onChange={(e) => { setQ(e.target.value); setPage(1); }}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t('searchCard')}</Label>
            <Input
              value={cardLast4}
              inputMode="numeric"
              maxLength={4}
              dir="ltr"
              placeholder="••••"
              onChange={(e) => { setCardLast4(e.target.value.replace(/\D/g, '').slice(0, 4)); setPage(1); }}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t('searchItem')}</Label>
            <Input
              value={item}
              onChange={(e) => { setItem(e.target.value); setPage(1); }}
            />
          </div>
        </div>
        {/* By till (several at once), document type, employee, status, amount and number. */}
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
          {machineId ? null : (
            <EntityMultiSelect
              label={t('filterTills')}
              options={tillOptions}
              selected={tillIds}
              onChange={(next) => { setTillIds(next); setPage(1); }}
              allLabel={t('filterAllTills')}
              clearLabel={t('filterClear')}
              emptyLabel={t('filterNoTills')}
            />
          )}
          <EntityMultiSelect
            label={t('filterDocumentTypes')}
            options={typeOptions}
            selected={docTypes}
            onChange={(next) => { setDocTypes(next); setPage(1); }}
            allLabel={t('filterAllTypes')}
            clearLabel={t('filterClear')}
            emptyLabel={t('filterAllTypes')}
          />
          <EntityMultiSelect
            label={t('filterEmployees')}
            options={cashierOptions}
            selected={cashierIds}
            onChange={(next) => { setCashierIds(next); setPage(1); }}
            allLabel={t('filterAllEmployees')}
            clearLabel={t('filterClear')}
            emptyLabel={t('filterNoEmployees')}
          />
          <EntityMultiSelect
            label={t('filterStatuses')}
            options={statusOptions}
            selected={statuses}
            onChange={(next) => { setStatuses(next); setPage(1); }}
            allLabel={t('filterAllStatuses')}
            clearLabel={t('filterClear')}
            emptyLabel={t('filterAllStatuses')}
          />
        </div>
        <div className="grid gap-3 md:grid-cols-3">
          <div className="space-y-1">
            <Label className="text-xs">{t('filterDocumentNumber')}</Label>
            <Input
              value={docNumber}
              inputMode="numeric"
              dir="ltr"
              placeholder="20000057"
              onChange={(e) => { setDocNumber(e.target.value.replace(/[^\d-]/g, '').slice(0, 20)); setPage(1); }}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t('filterAmountMin')}</Label>
            <Input
              value={amountMin}
              inputMode="decimal"
              dir="ltr"
              onChange={(e) => { setAmountMin(e.target.value.replace(/[^\d.-]/g, '')); setPage(1); }}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t('filterAmountMax')}</Label>
            <Input
              value={amountMax}
              inputMode="decimal"
              dir="ltr"
              onChange={(e) => { setAmountMax(e.target.value.replace(/[^\d.-]/g, '')); setPage(1); }}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground text-xs">{t('searchMethod')}</span>
          <Button
            size="sm"
            variant={method === '' ? 'default' : 'outline'}
            className="rounded-full"
            onClick={() => { setMethod(''); setPage(1); }}
          >
            {t('all')}
          </Button>
          {SEARCH_METHODS.map((m) => (
            <Button
              key={m}
              size="sm"
              variant={method === m ? 'default' : 'outline'}
              className="rounded-full"
              onClick={() => { setMethod(m); setPage(1); }}
            >
              {t(`searchMethods.${m}`)}
            </Button>
          ))}
          {searching ? (
            <Button size="sm" variant="ghost" className="ms-auto" onClick={clearSearch}>
              {t('searchClear')}
            </Button>
          ) : null}
        </div>
      </div>

      {/* "ניסיונות תשלום שנכשלו": no documents — their own list, in the same till / shop / dates. */}
      {method === 'failed' ? (
        <FailedPaymentsTable
          machineId={machineId}
          shopId={shopId}
          from={from || undefined}
          to={to || undefined}
          cardLast4={searchCard || undefined}
          onOpenTransaction={setSelectedId}
        />
      ) : (
      <>
      <ReportExportToolbar
        title={t('title')}
        from={from || undefined}
        to={to || undefined}
        disabled={!data || data.items.length === 0}
        // Every document the filters match — the server's export, not the page on screen.
        getSheets={async () => {
          const all = await fetchTransactionsExport(filterParams);
          return transactionsSheet(all.items, tc, t('title'), {
            documentType: documentTypeLabel,
            status: (s) => t(`statusLabels.${s}`),
            method: paymentLabel,
          });
        }}
      />
      {/* A phone gets one card per document; the eight-column table from md up. */}
      <ul className="divide-y rounded-lg border bg-card md:hidden print:hidden">
        {isLoading ? (
          Array.from({ length: 5 }).map((_, i) => (
            <li key={i} className="p-3"><Skeleton className="h-10 w-full" /></li>
          ))
        ) : !data || data.items.length === 0 ? (
          <li className="py-6 text-center text-sm text-muted-foreground">{t('noTransactions')}</li>
        ) : (
          data.items.map((tx) => {
            const machine = findBySameId(scope.machines, tx.machineId);
            return (
              <li key={tx.id}>
                <button
                  type="button"
                  className="w-full space-y-1 p-3 text-start text-sm hover:bg-muted/50"
                  onClick={() => setSelectedId(tx.id)}
                >
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-mono text-xs">
                      {/* As the till printed it: `20000057` ("קידומת מסמכים"), with its type —
                          each type has its own number series. */}
                      {tx.documentNumber ?? tx.transactionNumber}
                      <span className="text-muted-foreground ms-2 font-sans">{documentTypeLabel(tx.documentType)}</span>
                      {tx.basketId && (
                        <Badge variant="outline" className="ms-2 font-sans">{t('basket')}</Badge>
                      )}
                    </span>
                    <span className="font-medium tabular-nums">{formatCurrency(tx.totalAmount)}</span>
                  </div>
                  <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                    <span>{formatDateTime(tx.createdAt)}</span>
                    <span>· {machine?.name ?? tx.machineId.slice(0, 8)}</span>
                    {tx.paymentMethod ? <span>· {paymentLabel(tx.paymentMethod)}</span> : null}
                    {tx.cardBrands?.length ? <span>· {tx.cardBrands.map(brandLabels.brand).join(', ')}</span> : null}
                    <Badge variant={statusVariant(tx.status)}>{t(`statusLabels.${tx.status}`)}</Badge>
                    <OfflineOutcomeBadge outcome={tx.offlineOutcome} />
                    <RemoteCreditBadges tx={tx} />
                  </div>
                </button>
              </li>
            );
          })
        )}
      </ul>

      <div className="hidden rounded-lg border bg-card overflow-hidden md:block print:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('createdAt')}</TableHead>
              <TableHead>{t('txNumber')}</TableHead>
              <TableHead>{t('machine')}</TableHead>
              <TableHead>{t('cashier')}</TableHead>
              <TableHead>{t('payment')}</TableHead>
              <TableHead>{t('cardBrand')}</TableHead>
              <TableHead>{t('status')}</TableHead>
              <TableHead className="text-end">{t('amount')}</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={9}><Skeleton className="h-6 w-full" /></TableCell>
                </TableRow>
              ))
            ) : !data || data.items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-muted-foreground py-6">
                  {t('noTransactions')}
                </TableCell>
              </TableRow>
            ) : (
              data.items.map((tx) => {
                const machine = findBySameId(scope.machines, tx.machineId);
                return (
                  <TableRow key={tx.id} className="cursor-pointer" onClick={() => setSelectedId(tx.id)}>
                    <TableCell>{formatDateTime(tx.createdAt)}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {/* As the till printed it: `20000057` ("קידומת מסמכים"), with its type —
                          each type has its own number series. */}
                      {tx.documentNumber ?? tx.transactionNumber}
                      <span className="text-muted-foreground ms-2 font-sans">{documentTypeLabel(tx.documentType)}</span>
                      {tx.basketId && (
                        <Badge variant="outline" className="ms-2 font-sans">{t('basket')}</Badge>
                      )}
                    </TableCell>
                    <TableCell>{machine?.name ?? tx.machineId.slice(0, 8)}</TableCell>
                    <TableCell>{tx.cashierId ?? '—'}</TableCell>
                    <TableCell>{tx.paymentMethod ? paymentLabel(tx.paymentMethod) : '—'}</TableCell>
                    <TableCell>{tx.cardBrands?.length ? tx.cardBrands.map(brandLabels.brand).join(', ') : '—'}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(tx.status)}>
                        {t(`statusLabels.${tx.status}`)}
                      </Badge>
                      <OfflineOutcomeBadge outcome={tx.offlineOutcome} />
                      <RemoteCreditBadges tx={tx} />
                    </TableCell>
                    <TableCell className="text-end font-medium">
                      {formatCurrency(tx.totalAmount)}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); setSelectedId(tx.id); }}>
                          {t('viewDetails')}
                        </Button>
                        {/* "צור זיכוי" (docs/SPEC_REMOTE_CREDIT.md): owners and managers, sales only. */}
                        <RemoteCreditButton tx={tx} size="sm" variant="ghost" stopPropagation onOpenDocument={setSelectedId} />
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {data && data.total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-sm print:hidden">
          <span className="text-muted-foreground">
            {t('pageInfo', { page: String(page), pages: String(totalPages) })}
          </span>
          <div className="flex items-center gap-2">
            <Button
              size="sm" variant="outline"
              disabled={page <= 1 || isFetching}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ChevronRight className="h-4 w-4" />
              {t('previousPage')}
            </Button>
            <Button
              size="sm" variant="outline"
              disabled={page >= totalPages || isFetching}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              {t('nextPage')}
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}
      </>
      )}
      </ScopeGate>

      <TransactionDetailsDialog
        id={selectedId}
        onClose={() => setSelectedId(null)}
        onSelect={setSelectedId}
      />
    </div>
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
              {(data.customerName || data.customerPhone || data.customerAddress) && (
                <div className="col-span-2">
                  <Label className="text-xs">{t('customer')}</Label>
                  <div>
                    {[data.customerName, data.customerPhone, data.customerAddress].filter(Boolean).join(' · ')}
                  </div>
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
                      {leg.noMoneyMovement ? <RemoteCreditBadges tx={{ noMoneyMovement: true }} /> : null}
                    </span>
                    <span className="tabular-nums">{formatCurrency(leg.amount)}</span>
                  </div>
                ))}
              </div>
            )}

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
