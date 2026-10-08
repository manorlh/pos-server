'use client';

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, fetchShopStock, postGoodsReceipt, postStockAdjustment, postStocktake } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { fetchAllPages } from '@/lib/fetchAllPages';
import { usePageScope } from '@/lib/scope';
import { ScopeGate } from '@/components/dashboard/scope-gate';
import type { Product, ProductListResponse, StockLevel } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { PackagePlus, ClipboardList, SlidersHorizontal, PackageX } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
// "חסימות ואזל" (components/dashboard/live-control): block a product, the blocks in force.
import { ActiveBlocksList, BlockItemSheet } from '@/components/dashboard/live-control';
import { cn } from '@/lib/utils';
import { ReportExportToolbar } from '@/components/dashboard/report-export-toolbar';
import { AvailabilityReopenCard } from '@/components/dashboard/stock/availability-reopen-card';

type ActionKind = 'receipt' | 'adjust' | 'stocktake';
type StockTab = 'stock' | 'blocks';

const PRODUCTS_PAGE_SIZE = 200;

function mergeStockRows(levels: StockLevel[], tracked: Product[]): StockLevel[] {
  const byProductId = new Map(levels.map((l) => [l.productId, l]));
  const merged: StockLevel[] = [];

  for (const p of tracked) {
    const existing = byProductId.get(p.id);
    if (existing) {
      merged.push(existing);
      byProductId.delete(p.id);
    } else {
      merged.push({
        productId: p.id,
        productName: p.name,
        sku: p.sku,
        quantity: 0,
        reorderMin: null,
        reorderMax: null,
        reorderOpt: null,
        updatedAt: '',
      });
    }
  }

  for (const orphan of byProductId.values()) {
    merged.push(orphan);
  }

  return merged.sort((a, b) =>
    (a.productName ?? '').localeCompare(b.productName ?? '', undefined, { sensitivity: 'base' }),
  );
}

export default function ShopStockPage() {
  const t = useTranslations('stock');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  // Stock is held per shop; there is no company-level or per-device stock, so the
  // page asks for a shop and says so rather than showing an empty table.
  const { resolution, effective } = usePageScope({ maxLevel: 'shop', minLevel: 'shop' });
  const shopId = effective.shopId ?? '';
  const [actionOpen, setActionOpen] = useState(false);
  const [actionKind, setActionKind] = useState<ActionKind>('receipt');
  const [productId, setProductId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [delta, setDelta] = useState('');
  const [note, setNote] = useState('');
  // The page's tabs: the stock, and "חסימות פעילות" (`?tab=blocks`, the board links there).
  const searchParams = useSearchParams();
  const [tab, setTab] = useState<StockTab>(searchParams.get('tab') === 'blocks' ? 'blocks' : 'stock');
  const [blockFor, setBlockFor] = useState<string | null | undefined>(undefined);
  const blockScope = { companyId: effective.companyId ?? null, shopId: effective.shopId ?? null };

  const { data: productsData, isError: productsError } = useQuery<ProductListResponse>({
    queryKey: ['products', 'stock-tracked'],
    queryFn: () =>
      api
        .get('/products', { params: { page: 1, pageSize: PRODUCTS_PAGE_SIZE } })
        .then((r) => r.data),
  });
  const trackedProducts = (productsData?.items ?? []).filter((p) => p.trackStock);

  const { data: levels = [], isLoading } = useQuery<StockLevel[]>({
    queryKey: ['shop-stock', shopId],
    queryFn: () => fetchShopStock(shopId),
    enabled: Boolean(shopId),
  });

  const displayRows = useMemo(
    () => mergeStockRows(levels, trackedProducts),
    [levels, trackedProducts],
  );

  const invalidate = () => qc.invalidateQueries({ queryKey: ['shop-stock', shopId] });

  const receiptMut = useMutation({
    mutationFn: () =>
      postGoodsReceipt(shopId, {
        productId,
        quantity: parseFloat(quantity),
        note: note || undefined,
      }),
    onSuccess: () => {
      toast.success(t('receiptDone'));
      setActionOpen(false);
      invalidate();
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const adjustMut = useMutation({
    mutationFn: () =>
      postStockAdjustment(shopId, {
        productId,
        delta: parseFloat(delta),
        note: note || undefined,
      }),
    onSuccess: () => {
      toast.success(t('adjustDone'));
      setActionOpen(false);
      invalidate();
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const stocktakeMut = useMutation({
    mutationFn: () =>
      postStocktake(shopId, {
        productId,
        quantity: parseFloat(quantity),
        note: note || undefined,
      }),
    onSuccess: () => {
      toast.success(t('stocktakeDone'));
      setActionOpen(false);
      invalidate();
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const openAction = (kind: ActionKind, row?: StockLevel) => {
    setActionKind(kind);
    setProductId(row?.productId ?? '');
    setQuantity(row ? String(row.quantity) : '');
    setDelta('');
    setNote('');
    setActionOpen(true);
  };

  const isLow = (row: StockLevel) =>
    row.reorderMin != null && row.quantity <= row.reorderMin;

  const submitAction = () => {
    if (!productId) return;
    if (actionKind === 'receipt') receiptMut.mutate();
    else if (actionKind === 'adjust') adjustMut.mutate();
    else stocktakeMut.mutate();
  };

  const pending = receiptMut.isPending || adjustMut.isPending || stocktakeMut.isPending;

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between print:hidden">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!shopId}
            onClick={() => openAction('receipt')}
          >
            <PackagePlus className="h-4 w-4 ms-1" />
            {t('goodsReceipt')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!shopId}
            onClick={() => openAction('stocktake')}
          >
            <ClipboardList className="h-4 w-4 ms-1" />
            {t('stocktake')}
          </Button>
        </div>
      </div>

      <div className="flex gap-1 rounded-xl bg-muted p-1 print:hidden" role="tablist">
        {(['stock', 'blocks'] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => setTab(id)}
            className={cn('min-h-10 flex-1 rounded-lg px-3 text-sm font-medium sm:flex-none', tab === id ? 'bg-background shadow-sm' : 'text-muted-foreground')}
          >
            {id === 'stock' ? 'מלאי מהיר' : 'חסימות פעילות'}
          </button>
        ))}
      </div>

      {tab === 'blocks' ? (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm text-muted-foreground">פריטים שסומנו &quot;אזל&quot; או &quot;חסום&quot; — לכל אחד: איפה, מי, עד מתי. אפשר להאריך או לבטל מיד.</p>
            <Button size="sm" className="min-h-10 gap-1" onClick={() => setBlockFor(null)}>
              <PackageX className="h-4 w-4" /> חסום / אזל
            </Button>
          </div>
          <ActiveBlocksList scope={blockScope} />
        </section>
      ) : null}
      {blockFor !== undefined ? (
        <BlockItemSheet scope={blockScope} context={{ productId: blockFor }} onDone={() => setBlockFor(undefined)} />
      ) : null}

      {tab === 'stock' ? (
      <ScopeGate resolution={resolution}>
      <ReportExportToolbar
        title={t('title')}
        disabled={displayRows.length === 0}
        // The shop's levels come whole; the tracked products with no level yet are read from
        // every page of the catalog (the screen merges only the first 200 products).
        getSheets={async () => {
          const products = await fetchAllPages<Product>(
            (page, pageSize) => api.get('/products', { params: { page, pageSize } }).then((r) => r.data),
            { pageSize: PRODUCTS_PAGE_SIZE },
          );
          const all = mergeStockRows(levels, products.filter((p) => p.trackStock));
          return {
            name: t('title'),
            columns: [
              { header: t('product'), width: 30 },
              { header: t('sku'), width: 14 },
              { header: t('onHand'), kind: 'number' },
              { header: t('reorderMin'), kind: 'number' },
              { header: t('lowStock'), width: 10 },
            ],
            rows: all.map((row) => [
              row.productName ?? null, row.sku ?? null, row.quantity, row.reorderMin ?? null,
              isLow(row) ? t('lowStock') : null,
            ]),
            totals: [null, null, all.reduce((sum, r) => sum + Number(r.quantity || 0), 0), null, null],
          };
        }}
      />
      <div className="rounded-lg border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('product')}</TableHead>
              <TableHead>{t('sku')}</TableHead>
              <TableHead>{t('onHand')}</TableHead>
              <TableHead>{t('reorderMin')}</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 4 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 5 }).map((_, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : displayRows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                  {productsError
                    ? t('productsLoadError')
                    : trackedProducts.length === 0
                      ? t('emptyNoTracked')
                      : t('empty')}
                </TableCell>
              </TableRow>
            ) : (
              displayRows.map((row) => (
                <TableRow key={row.productId}>
                  <TableCell className="font-medium">{row.productName ?? '—'}</TableCell>
                  <TableCell className="text-muted-foreground">{row.sku ?? '—'}</TableCell>
                  <TableCell>
                    <span className={row.quantity < 0 ? 'text-destructive font-medium' : ''}>
                      {row.quantity}
                    </span>
                    {isLow(row) && (
                      <Badge variant="destructive" className="ms-2 text-xs">
                        {t('lowStock')}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>{row.reorderMin ?? '—'}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        title={t('adjust')}
                        onClick={() => openAction('adjust', row)}
                      >
                        <SlidersHorizontal className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        title={t('stocktake')}
                        onClick={() => openAction('stocktake', row)}
                      >
                        <ClipboardList className="h-3.5 w-3.5" />
                      </Button>
                      <Button variant="ghost" size="icon" title="חסום / אזל" aria-label="חסום / אזל" onClick={() => setBlockFor(row.productId)}>
                        <PackageX className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      </ScopeGate>
      ) : null}

      {/* "פתיחת פריטים אוטומטית אחרי Z": the inventory setting, per company, shop or point of sale. */}
      {tab === 'stock' ? <AvailabilityReopenCard companyId={effective.companyId} shopId={effective.shopId} /> : null}

      <Dialog open={actionOpen} onOpenChange={setActionOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {actionKind === 'receipt'
                ? t('goodsReceipt')
                : actionKind === 'adjust'
                  ? t('adjust')
                  : t('stocktake')}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>{t('product')}</Label>
              <Select value={productId} onValueChange={(v) => v && setProductId(v)}>
                <SelectTrigger>
                  <SelectValue placeholder={t('selectProduct')} />
                </SelectTrigger>
                <SelectContent>
                  {trackedProducts.map((p: Product) => (
                    <SelectItem key={p.id} value={p.id} label={p.name}>
                      {p.name} ({p.sku})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {actionKind === 'adjust' ? (
              <div className="space-y-1">
                <Label>{t('delta')}</Label>
                <Input
                  type="number"
                  value={delta}
                  onChange={(e) => setDelta(e.target.value)}
                  placeholder={t('deltaPlaceholder')}
                />
              </div>
            ) : (
              <div className="space-y-1">
                <Label>{actionKind === 'receipt' ? t('quantityAdd') : t('countedQty')}</Label>
                <Input
                  type="number"
                  min={actionKind === 'stocktake' ? 0 : undefined}
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              </div>
            )}
            <div className="space-y-1">
              <Label>{t('note')}</Label>
              <Input value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setActionOpen(false)}>
              {tc('cancel')}
            </Button>
            <Button onClick={submitAction} disabled={pending || !productId}>
              {pending ? tc('saving') : tc('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
