'use client';

import { useState } from 'react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { entitySelectItems } from '@/lib/selectItems';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { Product, Category, ProductListResponse, Voucher, PaginatedResponse } from '@/lib/types';
import { ProductImageUpload } from '@/components/product-image-upload';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Package, ChevronLeft, ChevronRight } from 'lucide-react';
import { useAuth } from '@/lib/auth';

type SkuMode = 'auto' | 'manual';

const PAGE_SIZE = 100;

const EMPTY: Partial<Product> = {
  name: '', price: 0, description: '', inStock: true, stockQuantity: 0, catalogLevel: 'global',
};

function ProductThumbnail({ imageUrl, name }: { imageUrl?: string; name: string }) {
  if (!imageUrl) {
    return (
      <div className="h-10 w-10 rounded-md bg-muted flex items-center justify-center shrink-0">
        <Package className="h-4 w-4 text-muted-foreground" />
      </div>
    );
  }
  return (
    <div className="relative h-10 w-10 rounded-md overflow-hidden bg-muted shrink-0">
      <Image src={imageUrl} alt={name} fill className="object-cover" sizes="40px" />
    </div>
  );
}

function buildSavePayload(
  p: Partial<Product>,
  companyId: string | undefined,
  skuMode: SkuMode,
  isNew: boolean,
): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...p, companyId: p.companyId ?? companyId };
  if (isNew && skuMode === 'auto') {
    delete payload.sku;
  }
  return payload;
}

export default function ProductsPage() {
  const t = useTranslations('products');
  const tc = useTranslations('common');
  const { user } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Partial<Product>>(EMPTY);
  const [skuMode, setSkuMode] = useState<SkuMode>('auto');
  const [page, setPage] = useState(1);
  const isNew = !editing.id;
  const skuReadOnly = !isNew && editing.skuAutoAssigned === true;

  const { data, isLoading } = useQuery<ProductListResponse>({
    queryKey: ['products', page],
    queryFn: () =>
      api
        .get('/products', { params: { page, pageSize: PAGE_SIZE } })
        .then((r) => r.data),
  });

  const products = data?.items ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const { data: categories = [] } = useQuery<Category[]>({
    queryKey: ['categories'],
    queryFn: () => api.get('/categories').then((r) => r.data),
  });

  const { data: vouchersData } = useQuery<PaginatedResponse<Voucher>>({
    queryKey: ['vouchers'],
    queryFn: () => api.get('/vouchers', { params: { page: 1, pageSize: 200 } }).then((r) => r.data),
  });
  const vouchers = vouchersData?.items ?? [];

  const save = useMutation({
    mutationFn: (args: { product: Partial<Product>; mode: SkuMode }) => {
      const payload = buildSavePayload(args.product, user?.companyId, args.mode, !args.product.id);
      return args.product.id
        ? api.put(`/products/${args.product.id}`, payload)
        : api.post('/products', payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['products'] });
      toast.success(isNew ? t('created') : t('updated'));
      setOpen(false);
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, t('saveError'))),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/products/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['products'] });
      toast.success(t('deleted'));
    },
  });

  const openNew = () => {
    setEditing(EMPTY);
    setSkuMode('auto');
    setOpen(true);
  };
  const openEdit = (p: Product) => { setEditing(p); setOpen(true); };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>
        <Button onClick={openNew} size="sm">
          <Plus className="h-4 w-4 ms-1" /> {t('add')}
        </Button>
      </div>

      <div className="rounded-lg border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-14" />
              <TableHead>{t('name')}</TableHead>
              <TableHead>{t('globalSku')}</TableHead>
              <TableHead>{t('sku')}</TableHead>
              <TableHead>{t('price')}</TableHead>
              <TableHead>{t('category')}</TableHead>
              <TableHead>{t('level')}</TableHead>
              <TableHead>{t('stock')}</TableHead>
              <TableHead className="w-20" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading
              ? Array.from({ length: 5 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 9 }).map((_, j) => (
                      <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))
              : products.length === 0
                ? (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                        {tc('noResults')}
                      </TableCell>
                    </TableRow>
                  )
                : products.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell>
                      <ProductThumbnail imageUrl={p.imageUrl} name={p.name} />
                    </TableCell>
                    <TableCell className="font-medium">{p.name}</TableCell>
                    <TableCell className="text-muted-foreground font-mono text-sm">{p.globalSku ?? '—'}</TableCell>
                    <TableCell className="text-muted-foreground">{p.sku}</TableCell>
                    <TableCell>₪{Number(p.price).toFixed(2)}</TableCell>
                    <TableCell>{categories.find((c) => c.id === p.categoryId)?.name ?? '—'}</TableCell>
                    <TableCell>
                      <Badge variant={p.catalogLevel === 'global' ? 'default' : 'secondary'}>
                        {p.catalogLevel}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={p.inStock ? 'outline' : 'destructive'}>
                        {p.inStock ? `${p.stockQuantity} ${t('inStock')}` : t('outOfStock')}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" onClick={() => openEdit(p)}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => remove.mutate(p.id)}
                          className="text-destructive hover:text-destructive">
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      </div>

      {total > 0 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            {t('pageInfo', { page: String(page), pages: String(totalPages) })}
          </span>
          <div className="flex items-center gap-2">
            <Button
              size="sm" variant="outline"
              disabled={page <= 1 || isLoading}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              <ChevronRight className="h-4 w-4" />
              {t('previousPage')}
            </Button>
            <Button
              size="sm" variant="outline"
              disabled={page >= totalPages || isLoading}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              {t('nextPage')}
              <ChevronLeft className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{isNew ? t('addTitle') : t('editTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <ProductImageUpload
              value={editing.imageUrl}
              onChange={(url) => setEditing((p) => ({ ...p, imageUrl: url }))}
            />
            <div className="space-y-1">
              <Label>{t('name')}</Label>
              <Input value={editing.name ?? ''} onChange={(e) => setEditing((p) => ({ ...p, name: e.target.value }))} />
            </div>
            {isNew ? (
              <div className="space-y-2">
                <Label>{t('skuMode')}</Label>
                <Select
                  value={skuMode}
                  onValueChange={(v) => setSkuMode(v as SkuMode)}
                  items={[
                    { value: 'auto', label: t('skuModeAuto') },
                    { value: 'manual', label: t('skuModeManual') },
                  ]}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto" label={t('skuModeAuto')}>{t('skuModeAuto')}</SelectItem>
                    <SelectItem value="manual" label={t('skuModeManual')}>{t('skuModeManual')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>{t('globalSku')}</Label>
                {isNew ? (
                  <>
                    <Input disabled placeholder={t('skuAssignedOnSave')} />
                    <p className="text-xs text-muted-foreground">{t('globalSkuHint')}</p>
                  </>
                ) : (
                  <Input value={editing.globalSku ?? ''} disabled />
                )}
              </div>
              <div className="space-y-1">
                <Label>{t('sku')}</Label>
                {isNew && skuMode === 'auto' ? (
                  <>
                    <Input disabled placeholder={t('skuAssignedOnSave')} />
                    <p className="text-xs text-muted-foreground">{t('skuAutoHint')}</p>
                  </>
                ) : (
                  <>
                    <Input
                      value={editing.sku ?? ''}
                      disabled={skuReadOnly}
                      onChange={(e) => setEditing((p) => ({ ...p, sku: e.target.value }))}
                    />
                    {skuReadOnly ? (
                      <p className="text-xs text-muted-foreground">{t('skuAutoReadOnly')}</p>
                    ) : null}
                  </>
                )}
              </div>
              <div className="space-y-1">
                <Label>{t('price')}</Label>
                <Input type="number" step="0.01" value={editing.price ?? 0}
                  onChange={(e) => setEditing((p) => ({ ...p, price: parseFloat(e.target.value) }))} />
              </div>
            </div>
            <div className="space-y-1">
              <Label>{t('category')}</Label>
              <Select
                value={editing.categoryId ?? ''}
                onValueChange={(v) => setEditing((p) => ({ ...p, categoryId: v ?? undefined }))}
                items={entitySelectItems(categories)}
              >
                <SelectTrigger><SelectValue placeholder={t('selectCategory')} /></SelectTrigger>
                <SelectContent>
                  {categories.length === 0 ? (
                    <div className="py-3 px-2 text-sm text-muted-foreground text-center">{t('noCategories')}</div>
                  ) : (
                    categories.map((c) => <SelectItem key={c.id} value={c.id} label={c.name}>{c.name}</SelectItem>)
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>{t('voucher')}</Label>
              <Select
                value={editing.voucherId ?? '__none__'}
                onValueChange={(v) =>
                  setEditing((p) => ({
                    ...p,
                    voucherId: !v || v === '__none__' ? undefined : v,
                  }))
                }
              >
                <SelectTrigger><SelectValue placeholder={t('noVoucher')} /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">{t('noVoucher')}</SelectItem>
                  {vouchers.map((v) => (
                    <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between gap-4 rounded-md border p-3">
              <div>
                <Label>{t('trackStock')}</Label>
                <p className="text-xs text-muted-foreground">{t('trackStockHint')}</p>
              </div>
              <Switch
                checked={editing.trackStock ?? false}
                onCheckedChange={(c) => setEditing((p) => ({ ...p, trackStock: c }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>{t('barcode')}</Label>
                <Input value={editing.barcode ?? ''} onChange={(e) => setEditing((p) => ({ ...p, barcode: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label>{t('stockQty')}</Label>
                <Input type="number" value={editing.stockQuantity ?? 0}
                  onChange={(e) => setEditing((p) => ({ ...p, stockQuantity: parseInt(e.target.value) }))} />
              </div>
            </div>
            <div className="space-y-1">
              <Label>{t('description')}</Label>
              <Input value={editing.description ?? ''} onChange={(e) => setEditing((p) => ({ ...p, description: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>{tc('cancel')}</Button>
            <Button
              onClick={() => save.mutate({ product: editing, mode: skuMode })}
              disabled={save.isPending || (isNew && skuMode === 'manual' && !editing.sku?.trim())}
            >
              {save.isPending ? tc('saving') : tc('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
