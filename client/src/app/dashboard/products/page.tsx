'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { findBySameId } from '@/lib/entityLookup';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { Product, Category } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { useAuth } from '@/lib/auth';

const EMPTY: Partial<Product> = {
  name: '', sku: '', price: 0, description: '', inStock: true, stockQuantity: 0, catalogLevel: 'global',
};

export default function ProductsPage() {
  const t = useTranslations('products');
  const tc = useTranslations('common');
  const { user } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Partial<Product>>(EMPTY);
  const isNew = !editing.id;

  const { data: products = [], isLoading } = useQuery<Product[]>({
    queryKey: ['products'],
    queryFn: () => api.get('/products').then((r) => r.data),
  });

  const { data: categories = [] } = useQuery<Category[]>({
    queryKey: ['categories'],
    queryFn: () => api.get('/categories').then((r) => r.data),
  });

  const save = useMutation({
    mutationFn: (p: Partial<Product>) => {
      const payload = { ...p, merchantId: p.merchantId ?? user?.merchantId };
      return p.id ? api.put(`/products/${p.id}`, payload) : api.post('/products', payload);
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
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['products'] }); toast.success(t('deleted')); },
  });

  const openNew = () => { setEditing(EMPTY); setOpen(true); };
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
              <TableHead>{t('name')}</TableHead>
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
                    {Array.from({ length: 7 }).map((_, j) => (
                      <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))
              : products.map((p) => (
                  <TableRow key={p.id}>
                    <TableCell className="font-medium">{p.name}</TableCell>
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

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{isNew ? t('addTitle') : t('editTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>{t('name')}</Label>
              <Input value={editing.name ?? ''} onChange={(e) => setEditing((p) => ({ ...p, name: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>{t('sku')}</Label>
                <Input value={editing.sku ?? ''} onChange={(e) => setEditing((p) => ({ ...p, sku: e.target.value }))} />
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
                itemToStringLabel={(v) => {
                  if (v == null || v === '') return '';
                  return findBySameId(categories, String(v))?.name ?? String(v);
                }}
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
            <Button onClick={() => save.mutate(editing)} disabled={save.isPending}>
              {save.isPending ? tc('saving') : tc('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
