'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { PosMachine, Shop, ZReport, ZReportListResponse } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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

function formatDate(iso: string | undefined | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('he-IL');
}

function formatDateTime(iso: string | undefined | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('he-IL', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function ZReportsPage() {
  const t = useTranslations('zReports');
  const [machineId, setMachineId] = useState<string>('all');
  const [shopId, setShopId] = useState<string>('all');
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<ZReport | null>(null);

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

  const { data, isLoading, isFetching } = useQuery<ZReportListResponse>({
    queryKey: ['z-reports', params],
    queryFn: () => api.get('/z-reports', { params }).then((r) => r.data),
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
              <TableHead>{t('dayDate')}</TableHead>
              <TableHead>{t('machine')}</TableHead>
              <TableHead className="text-end">{t('totalSales')}</TableHead>
              <TableHead className="text-end">{t('totalRefunds')}</TableHead>
              <TableHead className="text-end">{t('cash')}</TableHead>
              <TableHead className="text-end">{t('card')}</TableHead>
              <TableHead className="text-end">{t('transactionsCount')}</TableHead>
              <TableHead className="text-end">{t('discrepancy')}</TableHead>
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
                  {t('noReports')}
                </TableCell>
              </TableRow>
            ) : (
              data.items.map((z) => {
                const machine = machines.find((m) => m.id === z.machineId);
                const disc = z.discrepancy ?? 0;
                return (
                  <TableRow key={z.id} className="cursor-pointer" onClick={() => setSelected(z)}>
                    <TableCell>{formatDate(z.dayDate)}</TableCell>
                    <TableCell>{machine?.name ?? z.machineId.slice(0, 8)}</TableCell>
                    <TableCell className="text-end font-medium">{formatCurrency(z.totalSales)}</TableCell>
                    <TableCell className="text-end">{formatCurrency(z.totalRefunds)}</TableCell>
                    <TableCell className="text-end">{formatCurrency(z.totalCashSales)}</TableCell>
                    <TableCell className="text-end">{formatCurrency(z.totalCardSales)}</TableCell>
                    <TableCell className="text-end">{z.transactionsCount ?? 0}</TableCell>
                    <TableCell className={`text-end font-medium ${disc < 0 ? 'text-destructive' : disc > 0 ? 'text-emerald-600' : ''}`}>
                      {formatCurrency(disc)}
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); setSelected(z); }}>
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

      <Dialog open={!!selected} onOpenChange={(open) => { if (!open) setSelected(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('details')}</DialogTitle>
          </DialogHeader>
          {selected && (
            <div className="space-y-4 text-sm">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">{t('dayDate')}</Label>
                  <div>{formatDate(selected.dayDate)}</div>
                </div>
                <div>
                  <Label className="text-xs">{t('closedAt')}</Label>
                  <div>{formatDateTime(selected.closedAt)}</div>
                </div>
                <div>
                  <Label className="text-xs">{t('openingCash')}</Label>
                  <div>{formatCurrency(selected.openingCash)}</div>
                </div>
                <div>
                  <Label className="text-xs">{t('closingCash')}</Label>
                  <div>{formatCurrency(selected.closingCash)}</div>
                </div>
                <div>
                  <Label className="text-xs">{t('expectedCash')}</Label>
                  <div>{formatCurrency(selected.expectedCash)}</div>
                </div>
                <div>
                  <Label className="text-xs">{t('actualCash')}</Label>
                  <div>{formatCurrency(selected.actualCash)}</div>
                </div>
              </div>

              <div className="rounded border bg-muted/40 p-3 space-y-1">
                <div className="flex justify-between"><span>{t('totalSales')}</span><span className="font-bold">{formatCurrency(selected.totalSales)}</span></div>
                <div className="flex justify-between"><span>{t('totalRefunds')}</span><span>{formatCurrency(selected.totalRefunds)}</span></div>
                <div className="flex justify-between"><span>{t('cash')}</span><span>{formatCurrency(selected.totalCashSales)}</span></div>
                <div className="flex justify-between"><span>{t('card')}</span><span>{formatCurrency(selected.totalCardSales)}</span></div>
                <div className="flex justify-between"><span>{t('transactionsCount')}</span><span>{selected.transactionsCount ?? 0}</span></div>
                <div className="flex justify-between"><span>{t('discrepancy')}</span><span>{formatCurrency(selected.discrepancy)}</span></div>
              </div>

              {selected.payload && (
                <details className="rounded border p-2">
                  <summary className="cursor-pointer text-xs text-muted-foreground">{t('rawPayload')}</summary>
                  <pre className="text-xs mt-2 max-h-72 overflow-auto bg-muted/40 p-2 rounded">{JSON.stringify(selected.payload, null, 2)}</pre>
                </details>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
