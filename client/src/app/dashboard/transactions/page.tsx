'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import {
  PosMachine,
  Shop,
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
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { normalizePosMachine } from '@/lib/posMachine';

const PAGE_SIZE = 50;

function formatCurrency(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return '—';
  const n = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (Number.isNaN(n)) return '—';
  return new Intl.NumberFormat('he-IL', {
    style: 'currency',
    currency: 'ILS',
    maximumFractionDigits: 2,
  }).format(n);
}

function formatDateTime(iso: string | undefined | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('he-IL', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
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

export default function TransactionsPage() {
  const t = useTranslations('transactions');
  const [machineId, setMachineId] = useState<string>('all');
  const [shopId, setShopId] = useState<string>('all');
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: machines = [] } = useQuery<PosMachine[]>({
    queryKey: ['machines'],
    queryFn: async () => {
      const { data } = await api.get('/machines');
      const list = Array.isArray(data) ? data : [];
      return list.map((row: Record<string, unknown>) => normalizePosMachine(row));
    },
  });

  const { data: shops = [] } = useQuery<Shop[]>({
    queryKey: ['shops'],
    queryFn: () => api.get('/shops').then((r) => r.data),
  });

  const params = useMemo(() => {
    const p: Record<string, string | number> = { page, pageSize: PAGE_SIZE };
    if (machineId !== 'all') p.machineId = machineId;
    if (shopId !== 'all') p.shopId = shopId;
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

      <div className="rounded-lg border bg-card p-4 grid gap-3 md:grid-cols-4">
        <div className="space-y-1">
          <Label className="text-xs">{t('filterMachine')}</Label>
          <Select value={machineId} onValueChange={(v) => { setMachineId(v ?? 'all'); setPage(1); }}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('all')}</SelectItem>
              {machines.map((m) => (
                <SelectItem key={m.id} value={m.id}>{m.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs">{t('filterShop')}</Label>
          <Select value={shopId} onValueChange={(v) => { setShopId(v ?? 'all'); setPage(1); }}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('all')}</SelectItem>
              {shops.map((s) => (
                <SelectItem key={s.id} value={s.id}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
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
                const machine = machines.find((m) => m.id === tx.machineId);
                return (
                  <TableRow key={tx.id} className="cursor-pointer" onClick={() => setSelectedId(tx.id)}>
                    <TableCell>{formatDateTime(tx.createdAt)}</TableCell>
                    <TableCell className="font-mono text-xs">{tx.transactionNumber}</TableCell>
                    <TableCell>{machine?.name ?? tx.machineId.slice(0, 8)}</TableCell>
                    <TableCell>{tx.cashierId ?? '—'}</TableCell>
                    <TableCell>{tx.paymentMethod ?? '—'}</TableCell>
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

      <TransactionDetailsDialog id={selectedId} onClose={() => setSelectedId(null)} />
    </div>
  );
}

function TransactionDetailsDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const t = useTranslations('transactions');
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
                <div>{data.paymentMethod ?? '—'}</div>
              </div>
              <div>
                <Label className="text-xs">{t('cashier')}</Label>
                <div>{data.cashierId ?? '—'}</div>
              </div>
              {data.refundOfTransactionId && (
                <div>
                  <Label className="text-xs">{t('originalTransaction')}</Label>
                  <div className="font-mono text-xs">{data.refundOfTransactionId}</div>
                </div>
              )}
            </div>

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
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
