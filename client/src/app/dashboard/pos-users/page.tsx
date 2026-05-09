'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { findBySameId } from '@/lib/entityLookup';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  PosUser, PosUserCreate, PosUserUpdate, PosUserRole, Shop,
} from '@/lib/types';
import { useAuth } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription,
} from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { Plus, Pencil, KeyRound, Power } from 'lucide-react';

const ALL_ROLES: PosUserRole[] = ['cashier', 'shop_manager'];

interface UserForm {
  id?: string;
  username: string;
  firstName: string;
  lastName: string;
  workerNumber: string;
  role: PosUserRole;
  pin: string;
  isActive: boolean;
}

const EMPTY: UserForm = {
  username: '',
  firstName: '',
  lastName: '',
  workerNumber: '',
  role: 'cashier',
  pin: '',
  isActive: true,
};

const PIN_RE = /^\d{4,6}$/;

export default function PosUsersPage() {
  const t = useTranslations('posUsers');
  const tc = useTranslations('common');
  const { user: me } = useAuth();
  const qc = useQueryClient();

  const [shopId, setShopId] = useState<string>('');
  const [includeInactive, setIncludeInactive] = useState(false);

  const [openEdit, setOpenEdit] = useState(false);
  const [editing, setEditing] = useState<UserForm>(EMPTY);
  const [openReset, setOpenReset] = useState(false);
  const [resetTarget, setResetTarget] = useState<PosUser | null>(null);
  const [newPin, setNewPin] = useState('');

  const isNew = !editing.id;

  // Shops the dashboard user can see (server already RBAC-scopes /shops).
  const { data: shops = [] } = useQuery<Shop[]>({
    queryKey: ['shops'],
    queryFn: () => api.get('/shops').then((r) => r.data),
  });

  const selectedShop = useMemo(
    () => (shopId ? findBySameId(shops, shopId) : undefined),
    [shopId, shops],
  );

  const { data: users = [], isLoading } = useQuery<PosUser[]>({
    queryKey: ['pos-users', shopId, includeInactive],
    queryFn: () =>
      api
        .get(`/shops/${shopId}/pos-users`, {
          params: { include_inactive: includeInactive },
        })
        .then((r) => r.data),
    enabled: !!shopId,
  });

  const save = useMutation({
    mutationFn: (u: UserForm) => {
      if (u.id) {
        const payload: PosUserUpdate = {
          firstName: u.firstName || undefined,
          lastName: u.lastName || undefined,
          workerNumber: u.workerNumber || null,
          role: u.role,
          isActive: u.isActive,
        };
        if (u.pin) payload.pin = u.pin;
        return api.put(`/shops/${shopId}/pos-users/${u.id}`, payload);
      }
      const payload: PosUserCreate = {
        username: u.username,
        firstName: u.firstName || undefined,
        lastName: u.lastName || undefined,
        workerNumber: u.workerNumber || undefined,
        role: u.role,
        pin: u.pin,
      };
      return api.post(`/shops/${shopId}/pos-users`, payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pos-users', shopId] });
      toast.success(isNew ? t('created') : t('updated'));
      setOpenEdit(false);
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, t('saveError'))),
  });

  const resetPin = useMutation({
    mutationFn: () => {
      if (!resetTarget) return Promise.reject(new Error('no target'));
      return api.post(`/shops/${shopId}/pos-users/${resetTarget.id}/reset-pin`, { pin: newPin });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pos-users', shopId] });
      toast.success(t('pinReset'));
      setOpenReset(false);
      setNewPin('');
      setResetTarget(null);
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, t('saveError'))),
  });

  const deactivate = useMutation({
    mutationFn: (id: string) => api.delete(`/shops/${shopId}/pos-users/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['pos-users', shopId] });
      toast.success(t('deactivated'));
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const openCreate = () => {
    setEditing(EMPTY);
    setOpenEdit(true);
  };

  const openEditFor = (u: PosUser) => {
    setEditing({
      id: u.id,
      username: u.username,
      firstName: u.firstName ?? '',
      lastName: u.lastName ?? '',
      workerNumber: u.workerNumber ?? '',
      role: u.role,
      pin: '',
      isActive: u.isActive,
    });
    setOpenEdit(true);
  };

  const openResetFor = (u: PosUser) => {
    setResetTarget(u);
    setNewPin('');
    setOpenReset(true);
  };

  const canManage = me && me.role !== 'cashier';

  const handleSave = () => {
    if (!editing.username.trim()) return toast.error(tc('error'));
    if (isNew && !PIN_RE.test(editing.pin)) return toast.error(t('pinError'));
    if (!isNew && editing.pin && !PIN_RE.test(editing.pin)) return toast.error(t('pinError'));
    save.mutate(editing);
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>
        {canManage && shopId && (
          <Button onClick={openCreate} size="sm">
            <Plus className="h-4 w-4 ms-1" /> {t('add')}
          </Button>
        )}
      </div>

      <div className="rounded-lg border bg-card p-4 flex flex-wrap items-end gap-4">
        <div className="space-y-1 min-w-[220px]">
          <Label>{t('selectShop')}</Label>
          <Select
            value={shopId}
            onValueChange={(v) => setShopId(v ?? '')}
            itemToStringLabel={(v) => {
              if (v == null || v === '') return '';
              return findBySameId(shops, String(v))?.name ?? String(v);
            }}
          >
            <SelectTrigger><SelectValue placeholder={t('selectShopPlaceholder')} /></SelectTrigger>
            <SelectContent>
              {shops.map((s) => (
                <SelectItem key={s.id} value={s.id} label={s.name}>{s.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {shopId && (
          <div className="flex items-center gap-2">
            <Switch
              id="include-inactive"
              checked={includeInactive}
              onCheckedChange={setIncludeInactive}
            />
            <Label htmlFor="include-inactive" className="cursor-pointer">{t('showInactive')}</Label>
          </div>
        )}
      </div>

      {!shopId ? (
        <p className="text-sm text-muted-foreground">{t('pickShopHint')}</p>
      ) : (
        <div className="rounded-lg border bg-card overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('username')}</TableHead>
                <TableHead>{t('firstName')}</TableHead>
                <TableHead>{t('lastName')}</TableHead>
                <TableHead>{t('workerNumber')}</TableHead>
                <TableHead>{t('role')}</TableHead>
                <TableHead>{tc('status')}</TableHead>
                {canManage && <TableHead className="w-32" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: canManage ? 7 : 6 }).map((_, j) => (
                      <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))
              ) : users.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={canManage ? 7 : 6} className="text-center text-muted-foreground py-8">
                    {t('noUsers')}
                  </TableCell>
                </TableRow>
              ) : (
                users.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="font-medium">{u.username}</TableCell>
                    <TableCell>{u.firstName ?? ''}</TableCell>
                    <TableCell>{u.lastName ?? ''}</TableCell>
                    <TableCell>{u.workerNumber ?? '—'}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{t(`roles.${u.role}`)}</Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={u.isActive ? 'outline' : 'destructive'}>
                        {u.isActive ? tc('active') : tc('inactive')}
                      </Badge>
                    </TableCell>
                    {canManage && (
                      <TableCell>
                        <div className="flex gap-1">
                          <Button variant="ghost" size="icon" onClick={() => openEditFor(u)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button variant="ghost" size="icon" onClick={() => openResetFor(u)}>
                            <KeyRound className="h-3.5 w-3.5" />
                          </Button>
                          {u.isActive && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="text-destructive hover:text-destructive"
                              onClick={() => {
                                if (window.confirm(t('deactivateConfirm'))) deactivate.mutate(u.id);
                              }}
                            >
                              <Power className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Create / edit dialog */}
      <Dialog open={openEdit} onOpenChange={setOpenEdit}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{isNew ? t('addTitle') : t('editTitle')}</DialogTitle>
            {selectedShop && (
              <DialogDescription>{selectedShop.name}</DialogDescription>
            )}
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>{t('username')}</Label>
              <Input
                value={editing.username}
                disabled={!isNew}
                onChange={(e) => setEditing((u) => ({ ...u, username: e.target.value }))}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>{t('firstName')}</Label>
                <Input value={editing.firstName} onChange={(e) => setEditing((u) => ({ ...u, firstName: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label>{t('lastName')}</Label>
                <Input value={editing.lastName} onChange={(e) => setEditing((u) => ({ ...u, lastName: e.target.value }))} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>
                  {t('workerNumber')} <span className="text-muted-foreground text-xs">({t('workerNumberOptional')})</span>
                </Label>
                <Input value={editing.workerNumber} onChange={(e) => setEditing((u) => ({ ...u, workerNumber: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label>{t('role')}</Label>
                <Select
                  value={editing.role}
                  onValueChange={(v) => setEditing((u) => ({ ...u, role: v as PosUserRole }))}
                  itemToStringLabel={(v) =>
                    ALL_ROLES.includes(v as PosUserRole) ? t(`roles.${v as PosUserRole}`) : String(v)
                  }
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {ALL_ROLES.map((r) => (
                      <SelectItem key={r} value={r} label={t(`roles.${r}`)}>{t(`roles.${r}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1">
              <Label>
                {t('pin')}{' '}
                {!isNew && <span className="text-muted-foreground text-xs">({tc('cancel') === 'ביטול' ? 'אופציונלי' : 'optional'})</span>}
              </Label>
              <Input
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                placeholder={isNew ? '••••' : '••••'}
                value={editing.pin}
                onChange={(e) => setEditing((u) => ({ ...u, pin: e.target.value.replace(/\D/g, '') }))}
              />
              <p className="text-xs text-muted-foreground">{t('pinHint')}</p>
            </div>
            {!isNew && (
              <div className="flex items-center gap-2">
                <Switch
                  id="is-active"
                  checked={editing.isActive}
                  onCheckedChange={(v) => setEditing((u) => ({ ...u, isActive: v }))}
                />
                <Label htmlFor="is-active" className="cursor-pointer">{t('active')}</Label>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenEdit(false)}>{tc('cancel')}</Button>
            <Button onClick={handleSave} disabled={save.isPending}>
              {save.isPending ? tc('saving') : tc('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Reset PIN dialog */}
      <Dialog open={openReset} onOpenChange={setOpenReset}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('resetPinTitle')}</DialogTitle>
            {resetTarget && (
              <DialogDescription>{resetTarget.username}</DialogDescription>
            )}
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>{t('newPin')}</Label>
              <Input
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                placeholder="••••"
                value={newPin}
                onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ''))}
              />
              <p className="text-xs text-muted-foreground">{t('pinHint')}</p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpenReset(false)}>{tc('cancel')}</Button>
            <Button
              onClick={() => {
                if (!PIN_RE.test(newPin)) return toast.error(t('pinError'));
                resetPin.mutate();
              }}
              disabled={resetPin.isPending}
            >
              {resetPin.isPending ? tc('saving') : tc('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
