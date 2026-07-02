'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { api, fetchTipsReport } from '@/lib/api';
import { entitySelectItems } from '@/lib/selectItems';
import type { Shop, TipsReport } from '@/lib/types';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function TipsReportPage() {
  const t = useTranslations('tips');
  const tc = useTranslations('common');
  const [shopId, setShopId] = useState('');
  const [from, setFrom] = useState(todayIso());
  const [to, setTo] = useState(todayIso());
  const [runKey, setRunKey] = useState(0);

  const { data: shops = [] } = useQuery<Shop[]>({
    queryKey: ['shops'],
    queryFn: () => api.get('/shops').then((r) => r.data),
  });

  const { data: report, isLoading, isFetching } = useQuery<TipsReport>({
    queryKey: ['tips-report', shopId, from, to, runKey],
    queryFn: () => fetchTipsReport(shopId, { from, to }),
    enabled: Boolean(shopId) && Boolean(from) && Boolean(to) && runKey > 0,
  });

  const distLabel = (d: string) => {
    if (d === 'equal_pool') return t('distEqual');
    if (d === 'by_sales') return t('distBySales');
    return t('distDirect');
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>

      <div className="flex flex-wrap gap-4 items-end">
        <div className="space-y-1 min-w-[200px]">
          <Label>{t('shop')}</Label>
          <Select value={shopId} onValueChange={(v) => v && setShopId(v)} items={entitySelectItems(shops)}>
            <SelectTrigger>
              <SelectValue placeholder={t('selectShop')} />
            </SelectTrigger>
            <SelectContent>
              {shops.map((s) => (
                <SelectItem key={s.id} value={s.id} label={s.name}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>{t('from')}</Label>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>{t('to')}</Label>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </div>
        <Button
          disabled={!shopId || !from || !to || isFetching}
          onClick={() => setRunKey((k) => k + 1)}
        >
          {isFetching ? tc('loading') : t('runReport')}
        </Button>
      </div>

      {runKey === 0 ? (
        <p className="text-muted-foreground text-sm py-8 text-center">{t('selectFilters')}</p>
      ) : isLoading ? (
        <Skeleton className="h-48 w-full" />
      ) : report ? (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2 items-center">
            <Badge variant="outline">{distLabel(report.distribution)}</Badge>
            <span className="text-sm text-muted-foreground">
              {t('summary', {
                tips: report.totalTips.toFixed(2),
                cash: report.totalCashTips.toFixed(2),
                card: report.totalCardTips.toFixed(2),
              })}
            </span>
          </div>
          <div className="rounded-lg border bg-card overflow-hidden">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('cashier')}</TableHead>
                  <TableHead>{t('workerNumber')}</TableHead>
                  <TableHead>{t('tipsCollected')}</TableHead>
                  <TableHead>{t('cashTips')}</TableHead>
                  <TableHead>{t('cardTips')}</TableHead>
                  <TableHead>{t('sales')}</TableHead>
                  <TableHead>{t('amountOwed')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {report.cashiers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} className="text-center text-muted-foreground py-8">
                      {tc('noResults')}
                    </TableCell>
                  </TableRow>
                ) : (
                  report.cashiers.map((row, i) => (
                    <TableRow key={row.cashierId ?? `row-${i}`}>
                      <TableCell className="font-medium">{row.cashierName ?? '—'}</TableCell>
                      <TableCell>{row.workerNumber ?? '—'}</TableCell>
                      <TableCell>₪{Number(row.tipsCollected).toFixed(2)}</TableCell>
                      <TableCell>₪{Number(row.cashTips).toFixed(2)}</TableCell>
                      <TableCell>₪{Number(row.cardTips).toFixed(2)}</TableCell>
                      <TableCell>₪{Number(row.salesTotal).toFixed(2)}</TableCell>
                      <TableCell className="font-semibold">₪{Number(row.amountOwed).toFixed(2)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      ) : null}
    </div>
  );
}
