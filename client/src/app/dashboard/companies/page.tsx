'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, fetchCompanySettings, patchCompanySettings } from '@/lib/api';
import { PosSettingsForm, type PosSettingsFormState } from '@/components/pos-settings-form';
import type { PosSettingsV1 } from '@/lib/types';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { Company } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { toast } from 'sonner';
import { Plus, Pencil, Trash2, Settings2 } from 'lucide-react';

const EMPTY: Partial<Company> = { name: '', vatNumber: '', address: '', city: '' };

export default function CompaniesPage() {
  const t = useTranslations('companies');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const tps = useTranslations('posSettings');
  const [open, setOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsCompanyId, setSettingsCompanyId] = useState<string | null>(null);
  const [posSettings, setPosSettings] = useState<PosSettingsFormState>({});
  const [editing, setEditing] = useState<Partial<Company>>(EMPTY);
  const isNew = !editing.id;

  const { data: companies = [], isLoading } = useQuery<Company[]>({
    queryKey: ['companies'],
    queryFn: () => api.get('/companies').then((r) => r.data),
  });

  const save = useMutation({
    mutationFn: (c: Partial<Company>) => {
      return c.id ? api.put(`/companies/${c.id}`, c) : api.post('/companies', c);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['companies'] });
      toast.success(isNew ? t('created') : t('updated'));
      setOpen(false);
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/companies/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['companies'] }); toast.success(t('deleted')); },
  });

  const openSettings = async (companyId: string) => {
    setSettingsCompanyId(companyId);
    setSettingsOpen(true);
    try {
      const res = await fetchCompanySettings(companyId);
      setPosSettings(res.settings ?? {});
    } catch (err: unknown) {
      toast.error(axiosErrorToToastMessage(err, tc('error')));
      setPosSettings({});
    }
  };

  const saveSettings = useMutation({
    mutationFn: (payload: { companyId: string; patch: Partial<PosSettingsV1> }) =>
      patchCompanySettings(payload.companyId, payload.patch),
    onSuccess: () => {
      toast.success(tps('saved'));
      setSettingsOpen(false);
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
              <TableHead>{t('vat')}</TableHead>
              <TableHead>{t('city')}</TableHead>
              <TableHead>{tc('status')}</TableHead>
              <TableHead className="w-20" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading
              ? Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: 5 }).map((_, j) => (
                      <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))
              : companies.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="font-medium">{c.name}</TableCell>
                    <TableCell className="text-muted-foreground">{c.vatNumber ?? '—'}</TableCell>
                    <TableCell>{c.city ?? '—'}</TableCell>
                    <TableCell>
                      <Badge variant={c.isActive ? 'outline' : 'destructive'}>
                        {c.isActive ? tc('active') : tc('inactive')}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button variant="ghost" size="icon" title={t('settings')} onClick={() => openSettings(c.id)}>
                          <Settings2 className="h-3.5 w-3.5" />
                        </Button>
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
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>{t('vat')}</Label>
                <Input value={editing.vatNumber ?? ''} placeholder={t('vatPlaceholder')}
                  onChange={(e) => setEditing((c) => ({ ...c, vatNumber: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label>{t('city')}</Label>
                <Input value={editing.city ?? ''} onChange={(e) => setEditing((c) => ({ ...c, city: e.target.value }))} />
              </div>
            </div>
            <div className="space-y-1">
              <Label>{t('address')}</Label>
              <Input value={editing.address ?? ''} onChange={(e) => setEditing((c) => ({ ...c, address: e.target.value }))} />
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

      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{tps('title')}</DialogTitle>
            <p className="text-sm text-muted-foreground">{tps('companySubtitle')}</p>
          </DialogHeader>
          <PosSettingsForm value={posSettings} onChange={setPosSettings} />
          <DialogFooter>
            <Button variant="outline" onClick={() => setSettingsOpen(false)}>{tc('cancel')}</Button>
            <Button
              onClick={() =>
                settingsCompanyId &&
                saveSettings.mutate({ companyId: settingsCompanyId, patch: posSettings })
              }
              disabled={saveSettings.isPending || !settingsCompanyId}
            >
              {saveSettings.isPending ? tc('saving') : tc('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
