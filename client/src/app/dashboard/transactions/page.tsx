'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { usePageScope } from '@/lib/scope';
import { findBySameId } from '@/lib/entityLookup';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import { usePaymentMethodLabel } from '@/components/dashboard/shifts/shift-parts';
import {
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
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { formatCurrency, formatDateTime } from '@/lib/format';

const PAGE_SIZE = 50;

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
function useDocumentTypeLabel() {
  const t = useTranslations('transactions');
  return (type: number | null | undefined): string =>
    type === 320 ? t('documentTypes.320') : type === 330 ? t('documentTypes.330') : String(type ?? '—');
}

export default function TransactionsPage() {
  const t = useTranslations('transactions');
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
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // A scope change is a different set of documents; page 7 of the old set is
  // meaningless in the new one. Reset during render, not in an effect, so no
  // request ever goes out for "page 7 of the shop we just switched to".
  const scopeKey = `${shopId ?? ''}|${machineId ?? ''}`;
  const [pageScopeKey, setPageScopeKey] = useState(scopeKey);
  if (pageScopeKey !== scopeKey) {
    setPageScopeKey(scopeKey);
    setPage(1);
  }

  const params = useMemo(() => {
    const p: Record<string, string | number> = { page, pageSize: PAGE_SIZE };
    if (machineId) p.machineId = machineId;
    if (shopId) p.shopId = shopId;
    if (from) p.from = from;
    if (to) p.to = to;
    return p;
  }, [machineId, shopId, from, to, page]);

  const { data, isLoading, isFetching } = useQuery<TransactionListResponse>({
    queryKey: ['transactions', params],
    queryFn: () => api.get('/transactions', { params }).then((r) => r.data),
    placeholderData: (prev) => prev,
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>

      <ScopeGate resolution={resolution}>
      <div className="rounded-lg border bg-card p-4 grid gap-3 md:grid-cols-2 lg:max-w-lg">
        <div className="space-y-1">
          <Label className="text-xs">{t('filterFrom')}</Label>
          <Input
            type="date"
            value={from}
            onChange={(e) => { setFrom(e.target.value); setPage(1); }}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t('filterTo')}</Label>
          <Input
            type="date"
            value={to}
            onChange={(e) => { setTo(e.target.value); setPage(1); }}
          />
        </div>
      </div>

      <div className="rounded-lg border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('createdAt')}</TableHead>
              <TableHead>{t('txNumber')}</TableHead>
              <TableHead>{t('machine')}</TableHead>
              <TableHead>{t('cashier')}</TableHead>
              <TableHead>{t('payment')}</TableHead>
              <TableHead>{t('status')}</TableHead>
              <TableHead className="text-end">{t('amount')}</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                <TableRow key={i}>
                  <TableCell colSpan={8}><Skeleton className="h-6 w-full" /></TableCell>
                </TableRow>
              ))
            ) : !data || data.items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={8} className="text-center text-muted-foreground py-6">
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
                      {tx.transactionNumber}
                      {tx.basketId && (
                        <Badge variant="outline" className="ms-2 font-sans">{t('basket')}</Badge>
                      )}
                    </TableCell>
                    <TableCell>{machine?.name ?? tx.machineId.slice(0, 8)}</TableCell>
                    <TableCell>{tx.cashierId ?? '—'}</TableCell>
                    <TableCell>{tx.paymentMethod ? paymentLabel(tx.paymentMethod) : '—'}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(tx.status)}>
                        {t(`statusLabels.${tx.status}`)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-end font-medium">
                      {formatCurrency(tx.totalAmount)}
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); setSelectedId(tx.id); }}>
                        {t('viewDetails')}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>

      {data && data.total > 0 && (
        <div className="flex items-center justify-between text-sm">
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
                <div className="font-mono">{data.transactionNumber}</div>
              </div>
              <div>
                <Label className="text-xs">{t('createdAt')}</Label>
                <div>{formatDateTime(data.createdAt)}</div>
              </div>
              <div>
                <Label className="text-xs">{t('status')}</Label>
                <Badge variant={statusVariant(data.status)}>{t(`statusLabels.${data.status}`)}</Badge>
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
            </div>

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
                      <span className="font-mono text-xs">{doc.transactionNumber}</span>
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
                  <div key={leg.id} className="flex justify-between">
                    <span>{paymentLabel(leg.method)}</span>
                    <span className="tabular-nums">{formatCurrency(leg.amount)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
