'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { Voucher, PaginatedResponse } from '@/lib/types';
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

const EMPTY: Partial<Voucher> = {
  name: '',
  isActive: true,
  valueDisplayMode: 'product_price',
  printBarcode: true,
  printQr: true,
  language: 'he',
};

export default function VouchersPage() {
  const t = useTranslations('vouchers');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Partial<Voucher>>(EMPTY);
  const isNew = !editing.id;

  const { data, isLoading } = useQuery<PaginatedResponse<Voucher>>({
    queryKey: ['vouchers'],
    queryFn: () => api.get('/vouchers', { params: { page: 1, pageSize: 200 } }).then((r) => r.data),
  });

  const vouchers = data?.items ?? [];

  const save = useMutation({
    mutationFn: (v: Partial<Voucher>) =>
      v.id ? api.put(`/vouchers/${v.id}`, v) : api.post('/vouchers', v),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['vouchers'] });
      toast.success(isNew ? t('created') : t('updated'));
      setOpen(false);
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/vouchers/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['vouchers'] });
      toast.success(t('deleted'));
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>
        <Button onClick={() => { setEditing(EMPTY); setOpen(true); }} size="sm">
          <Plus className="h-4 w-4 ms-1" /> {t('add')}
        </Button>
      </div>

      <div className="rounded-lg border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('name')}</TableHead>
              <TableHead>{t('title')}</TableHead>
              <TableHead>{t('valueMode')}</TableHead>
              <TableHead>{tc('status')}</TableHead>
              <TableHead className="w-20" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading
              ? Array.from({ length: 4 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 5 }).map((_, j) => (
                      <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))
              : vouchers.length === 0
                ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                        {tc('noResults')}
                      </TableCell>
                    </TableRow>
                  )
                : vouchers.map((v) => (
                  <TableRow key={v.id}>
                    <TableCell className="font-medium">{v.name}</TableCell>
                    <TableCell>{v.title ?? v.name}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{t(`valueMode_${v.valueDisplayMode}`)}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={v.isActive ? 'outline' : 'destructive'}>
                        {v.isActive ? tc('active') : tc('inactive')}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" onClick={() => { setEditing(v); setOpen(true); }}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => remove.mutate(v.id)}
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
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{isNew ? t('addTitle') : t('editTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>{t('name')}</Label>
              <Input value={editing.name ?? ''} onChange={(e) => setEditing((v) => ({ ...v, name: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>{t('title')}</Label>
              <Input value={editing.title ?? ''} onChange={(e) => setEditing((v) => ({ ...v, title: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>{t('printSubtitle')}</Label>
              <Input value={editing.subtitle ?? ''} onChange={(e) => setEditing((v) => ({ ...v, subtitle: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>{t('bodyText')}</Label>
              <Input value={editing.bodyText ?? ''} onChange={(e) => setEditing((v) => ({ ...v, bodyText: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>{t('footerText')}</Label>
              <Input value={editing.footerText ?? ''} onChange={(e) => setEditing((v) => ({ ...v, footerText: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>{t('validityDays')}</Label>
                <Input type="number" min={0} value={editing.validityDays ?? ''}
                  onChange={(e) => setEditing((v) => ({ ...v, validityDays: e.target.value ? parseInt(e.target.value, 10) : undefined }))} />
              </div>
              <div className="space-y-1">
                <Label>{t('valueMode')}</Label>
                <Select
                  value={editing.valueDisplayMode ?? 'product_price'}
                  onValueChange={(val) => setEditing((v) => ({ ...v, valueDisplayMode: val as Voucher['valueDisplayMode'] }))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="product_price">{t('valueMode_product_price')}</SelectItem>
                    <SelectItem value="fixed">{t('valueMode_fixed')}</SelectItem>
                    <SelectItem value="none">{t('valueMode_none')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            {editing.valueDisplayMode === 'fixed' ? (
              <div className="space-y-1">
                <Label>{t('displayValue')}</Label>
                <Input type="number" step="0.01" min={0} value={editing.displayValue ?? ''}
                  onChange={(e) => setEditing((v) => ({ ...v, displayValue: parseFloat(e.target.value) }))} />
              </div>
            ) : null}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>{t('printBarcode')}</Label>
                <Select
                  value={editing.printBarcode ? 'yes' : 'no'}
                  onValueChange={(val) => setEditing((v) => ({ ...v, printBarcode: val === 'yes' }))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="yes">{tc('yes')}</SelectItem>
                    <SelectItem value="no">{tc('no')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>{t('printQr')}</Label>
                <Select
                  value={editing.printQr ? 'yes' : 'no'}
                  onValueChange={(val) => setEditing((v) => ({ ...v, printQr: val === 'yes' }))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="yes">{tc('yes')}</SelectItem>
                    <SelectItem value="no">{tc('no')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label>{tc('status')}</Label>
              <Select
                value={editing.isActive !== false ? 'active' : 'inactive'}
                onValueChange={(val) => setEditing((v) => ({ ...v, isActive: val === 'active' }))}
              >
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="active">{tc('active')}</SelectItem>
                  <SelectItem value="inactive">{tc('inactive')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>{tc('cancel')}</Button>
            <Button onClick={() => save.mutate(editing)} disabled={save.isPending || !editing.name?.trim()}>
              {save.isPending ? tc('saving') : tc('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
