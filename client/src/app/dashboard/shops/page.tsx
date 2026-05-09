'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { findBySameId } from '@/lib/entityLookup';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { Shop, Company } from '@/lib/types';
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

const EMPTY: Partial<Shop> = { name: '', branchId: '', address: '', city: '' };

export default function ShopsPage() {
  const t = useTranslations('shops');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Partial<Shop>>(EMPTY);
  const isNew = !editing.id;

  const { data: shops = [], isLoading } = useQuery<Shop[]>({
    queryKey: ['shops'],
    queryFn: () => api.get('/shops').then((r) => r.data),
  });

  const { data: companies = [] } = useQuery<Company[]>({
    queryKey: ['companies'],
    queryFn: () => api.get('/companies').then((r) => r.data),
  });

  const save = useMutation({
    mutationFn: (s: Partial<Shop>) =>
      s.id ? api.put(`/shops/${s.id}`, s) : api.post('/shops', s),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['shops'] });
      toast.success(isNew ? t('created') : t('updated'));
      setOpen(false);
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/shops/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['shops'] }); toast.success(t('deleted')); },
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
              <TableHead>{t('company')}</TableHead>
              <TableHead>{t('branchId')}</TableHead>
              <TableHead>{t('city')}</TableHead>
              <TableHead>{tc('status')}</TableHead>
              <TableHead className="w-20" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading
              ? Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 6 }).map((_, j) => (
                      <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))
              : shops.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">{s.name}</TableCell>
                    <TableCell>{companies.find((c) => c.id === s.companyId)?.name ?? '—'}</TableCell>
                    <TableCell className="text-muted-foreground">{s.branchId ?? '—'}</TableCell>
                    <TableCell>{s.city ?? '—'}</TableCell>
                    <TableCell>
                      <Badge variant={s.isActive ? 'outline' : 'destructive'}>
                        {s.isActive ? tc('active') : tc('inactive')}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" onClick={() => { setEditing(s); setOpen(true); }}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => remove.mutate(s.id)}
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
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{isNew ? t('addTitle') : t('editTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>{t('name')}</Label>
              <Input value={editing.name ?? ''} onChange={(e) => setEditing((s) => ({ ...s, name: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>{t('company')}</Label>
              <Select
                value={editing.companyId ?? ''}
                onValueChange={(v) => setEditing((s) => ({ ...s, companyId: v ?? undefined }))}
                itemToStringLabel={(v) => {
                  if (v == null || v === '') return '';
                  return findBySameId(companies, String(v))?.name ?? String(v);
                }}
              >
                <SelectTrigger><SelectValue placeholder={t('selectCompany')} /></SelectTrigger>
                <SelectContent>
                  {companies.map((c) => <SelectItem key={c.id} value={c.id} label={c.name}>{c.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>{t('branchId')}</Label>
                <Input value={editing.branchId ?? ''} placeholder={t('branchIdPlaceholder')}
                  onChange={(e) => setEditing((s) => ({ ...s, branchId: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label>{t('city')}</Label>
                <Input value={editing.city ?? ''} onChange={(e) => setEditing((s) => ({ ...s, city: e.target.value }))} />
              </div>
            </div>
            <div className="space-y-1">
              <Label>{t('address')}</Label>
              <Input value={editing.address ?? ''} onChange={(e) => setEditing((s) => ({ ...s, address: e.target.value }))} />
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
