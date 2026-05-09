'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { Category } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2 } from 'lucide-react';
import { useAuth } from '@/lib/auth';

const EMPTY: Partial<Category> = { name: '', description: '', color: '#6366f1', catalogLevel: 'global' };

export default function CategoriesPage() {
  const t = useTranslations('categories');
  const tc = useTranslations('common');
  const { user } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Partial<Category>>(EMPTY);
  const isNew = !editing.id;

  const { data: categories = [], isLoading } = useQuery<Category[]>({
    queryKey: ['categories'],
    queryFn: () => api.get('/categories').then((r) => r.data),
  });

  const save = useMutation({
    mutationFn: (c: Partial<Category>) => {
      const payload = { ...c, merchantId: c.merchantId ?? user?.merchantId };
      return c.id ? api.put(`/categories/${c.id}`, payload) : api.post('/categories', payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['categories'] });
      toast.success(isNew ? t('created') : t('updated'));
      setOpen(false);
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/categories/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['categories'] }); toast.success(t('deleted')); },
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
              <TableHead>{t('color')}</TableHead>
              <TableHead>{t('name')}</TableHead>
              <TableHead>{t('level')}</TableHead>
              <TableHead>{tc('status')}</TableHead>
              <TableHead>{t('sortOrder')}</TableHead>
              <TableHead className="w-20" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading
              ? Array.from({ length: 4 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 6 }).map((_, j) => (
                      <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))
              : categories.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <span className="inline-block h-5 w-5 rounded-full border"
                        style={{ background: c.color ?? '#e5e7eb' }} />
                    </TableCell>
                    <TableCell className="font-medium">{c.name}</TableCell>
                    <TableCell>
                      <Badge variant={c.catalogLevel === 'global' ? 'default' : 'secondary'}>
                        {c.catalogLevel}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={c.isActive ? 'outline' : 'destructive'}>
                        {c.isActive ? tc('active') : tc('inactive')}
                      </Badge>
                    </TableCell>
                    <TableCell>{c.sortOrder}</TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" onClick={() => { setEditing(c); setOpen(true); }}>
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => remove.mutate(c.id)}
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
              <Input value={editing.name ?? ''} onChange={(e) => setEditing((c) => ({ ...c, name: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <Label>{t('description')}</Label>
              <Input value={editing.description ?? ''} onChange={(e) => setEditing((c) => ({ ...c, description: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>{t('color')}</Label>
                <div className="flex items-center gap-2">
                  <input type="color" value={editing.color ?? '#6366f1'}
                    onChange={(e) => setEditing((c) => ({ ...c, color: e.target.value }))}
                    className="h-9 w-9 cursor-pointer rounded border p-0.5" />
                  <Input value={editing.color ?? ''} onChange={(e) => setEditing((c) => ({ ...c, color: e.target.value }))} className="flex-1" />
                </div>
              </div>
              <div className="space-y-1">
                <Label>{t('sortOrder')}</Label>
                <Input type="number" value={editing.sortOrder ?? 0}
                  onChange={(e) => setEditing((c) => ({ ...c, sortOrder: parseInt(e.target.value) }))} />
              </div>
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
