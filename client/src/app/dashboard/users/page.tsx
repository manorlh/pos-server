'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { findBySameId } from '@/lib/entityLookup';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { User, UserRole, Company, Shop, Merchant } from '@/lib/types';
import { useAuth } from '@/lib/auth';
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

const ALL_ROLES: UserRole[] = [
  'super_admin', 'distributor', 'merchant_admin',
  'company_manager', 'shop_manager', 'cashier',
];

const ROLE_NEEDS_MERCHANT: UserRole[] = ['merchant_admin', 'company_manager', 'shop_manager', 'cashier'];
const ROLE_NEEDS_COMPANY: UserRole[] = ['company_manager', 'shop_manager', 'cashier'];
const ROLE_NEEDS_SHOP: UserRole[] = ['shop_manager', 'cashier'];

interface UserForm {
  id?: string;
  email: string;
  username: string;
  password: string;
  role: UserRole;
  merchantId?: string;
  companyId?: string;
  shopId?: string;
  isActive?: boolean;
}

const EMPTY: UserForm = {
  email: '', username: '', password: '', role: 'cashier',
  merchantId: undefined, companyId: undefined, shopId: undefined,
};

export default function UsersPage() {
  const t = useTranslations('users');
  const tc = useTranslations('common');
  const { user: me } = useAuth();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<UserForm>(EMPTY);
  const isNew = !editing.id;

  const { data: users = [], isLoading } = useQuery<User[]>({
    queryKey: ['users'],
    queryFn: () => api.get('/users').then((r) => r.data),
  });

  const { data: merchants = [] } = useQuery<Merchant[]>({
    queryKey: ['merchants'],
    queryFn: () => api.get('/merchants').then((r) => r.data),
  });

  const { data: companies = [] } = useQuery<Company[]>({
    queryKey: ['companies'],
    queryFn: () => api.get('/companies').then((r) => r.data),
  });

  const { data: shops = [] } = useQuery<Shop[]>({
    queryKey: ['shops'],
    queryFn: () => api.get('/shops').then((r) => r.data),
  });

  const filteredCompanies = editing.merchantId
    ? companies.filter((c) => c.merchantId === editing.merchantId)
    : companies;

  const filteredShops = editing.companyId
    ? shops.filter((s) => s.companyId === editing.companyId)
    : shops;

  const save = useMutation({
    mutationFn: (u: UserForm) => {
      const { password, ...rest } = u;
      if (u.id) {
        // Update: only send password if changed
        const payload: Record<string, unknown> = { ...rest };
        if (password) payload.password = password;
        return api.put(`/users/${u.id}`, payload);
      }
      return api.post('/users', u);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      toast.success(isNew ? t('created') : t('updated'));
      setOpen(false);
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/users/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      toast.success(t('deleted'));
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const openEdit = (u: User) => {
    setEditing({
      id: u.id, email: u.email, username: u.username, password: '',
      role: u.role, merchantId: u.merchantId, companyId: u.companyId,
      shopId: u.shopId, isActive: u.isActive,
    });
    setOpen(true);
  };

  const handleRoleChange = (role: UserRole) => {
    setEditing((prev) => ({
      ...prev,
      role,
      merchantId: ROLE_NEEDS_MERCHANT.includes(role) ? prev.merchantId : undefined,
      companyId: ROLE_NEEDS_COMPANY.includes(role) ? prev.companyId : undefined,
      shopId: ROLE_NEEDS_SHOP.includes(role) ? prev.shopId : undefined,
    }));
  };

  const scopeName = (u: User) => {
    if (u.shopId) return shops.find((s) => s.id === u.shopId)?.name;
    if (u.companyId) return companies.find((c) => c.id === u.companyId)?.name;
    if (u.merchantId) return merchants.find((m) => m.id === u.merchantId)?.name;
    return '—';
  };

  const canManage = me && me.role !== 'cashier';

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>
        {canManage && (
          <Button onClick={() => { setEditing(EMPTY); setOpen(true); }} size="sm">
            <Plus className="h-4 w-4 ms-1" /> {t('add')}
          </Button>
        )}
      </div>

      <div className="rounded-lg border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('username')}</TableHead>
              <TableHead>{t('email')}</TableHead>
              <TableHead>{t('role')}</TableHead>
              <TableHead>{t('scope')}</TableHead>
              <TableHead>{tc('status')}</TableHead>
              {canManage && <TableHead className="w-20" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading
              ? Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: canManage ? 6 : 5 }).map((_, j) => (
                      <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))
              : users.map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="font-medium">{u.username}</TableCell>
                    <TableCell className="text-muted-foreground">{u.email}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{t(`roles.${u.role}`)}</Badge>
                    </TableCell>
                    <TableCell>{scopeName(u)}</TableCell>
                    <TableCell>
                      <Badge variant={u.isActive ? 'outline' : 'destructive'}>
                        {u.isActive ? tc('active') : tc('inactive')}
                      </Badge>
                    </TableCell>
                    {canManage && (
                      <TableCell>
                        <div className="flex gap-1">
                          <Button variant="ghost" size="icon" onClick={() => openEdit(u)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          {me?.id !== u.id && (
                            <Button variant="ghost" size="icon" onClick={() => remove.mutate(u.id)}
                              className="text-destructive hover:text-destructive">
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
                      </TableCell>
                    )}
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
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>{t('username')}</Label>
                <Input value={editing.username} onChange={(e) => setEditing((u) => ({ ...u, username: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label>{t('email')}</Label>
                <Input type="email" value={editing.email} onChange={(e) => setEditing((u) => ({ ...u, email: e.target.value }))} />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>{t('password')}{!isNew && <span className="text-muted-foreground text-xs"> ({t('passwordOptional')})</span>}</Label>
                <Input type="password" value={editing.password}
                  placeholder={isNew ? '' : '••••••'}
                  onChange={(e) => setEditing((u) => ({ ...u, password: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label>{t('role')}</Label>
                <Select
                  value={editing.role}
                  onValueChange={(v) => handleRoleChange(v as UserRole)}
                  itemToStringLabel={(v) =>
                    ALL_ROLES.includes(v as UserRole) ? t(`roles.${v as UserRole}`) : String(v)
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

            {ROLE_NEEDS_MERCHANT.includes(editing.role) && (
              <div className="space-y-1">
                <Label>{t('merchant')}</Label>
                <Select
                  value={editing.merchantId ?? ''}
                  onValueChange={(v) =>
                    setEditing((u) => ({ ...u, merchantId: v || undefined, companyId: undefined, shopId: undefined }))
                  }
                  itemToStringLabel={(v) => {
                    if (v == null || v === '') return '';
                    return findBySameId(merchants, String(v))?.name ?? String(v);
                  }}
                >
                  <SelectTrigger><SelectValue placeholder={t('selectMerchant')} /></SelectTrigger>
                  <SelectContent>
                    {merchants.map((m) => (
                      <SelectItem key={m.id} value={m.id} label={m.name}>{m.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {ROLE_NEEDS_COMPANY.includes(editing.role) && (
              <div className="space-y-1">
                <Label>{t('company')}</Label>
                <Select
                  value={editing.companyId ?? ''}
                  onValueChange={(v) => setEditing((u) => ({ ...u, companyId: v || undefined, shopId: undefined }))}
                  itemToStringLabel={(v) => {
                    if (v == null || v === '') return '';
                    return findBySameId(filteredCompanies, String(v))?.name ?? String(v);
                  }}
                >
                  <SelectTrigger><SelectValue placeholder={t('selectCompany')} /></SelectTrigger>
                  <SelectContent>
                    {filteredCompanies.map((c) => (
                      <SelectItem key={c.id} value={c.id} label={c.name}>{c.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {ROLE_NEEDS_SHOP.includes(editing.role) && (
              <div className="space-y-1">
                <Label>{t('shop')}</Label>
                <Select
                  value={editing.shopId ?? ''}
                  onValueChange={(v) => setEditing((u) => ({ ...u, shopId: v || undefined }))}
                  itemToStringLabel={(v) => {
                    if (v == null || v === '') return '';
                    return findBySameId(filteredShops, String(v))?.name ?? String(v);
                  }}
                >
                  <SelectTrigger><SelectValue placeholder={t('selectShop')} /></SelectTrigger>
                  <SelectContent>
                    {filteredShops.map((s) => (
                      <SelectItem key={s.id} value={s.id} label={s.name}>{s.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {!isNew && (
              <div className="space-y-1">
                <Label>{tc('status')}</Label>
                <Select
                  value={editing.isActive ? 'active' : 'inactive'}
                  onValueChange={(v) => setEditing((u) => ({ ...u, isActive: v === 'active' }))}
                  itemToStringLabel={(v) => (v === 'active' ? tc('active') : tc('inactive'))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active" label={tc('active')}>{tc('active')}</SelectItem>
                    <SelectItem value="inactive" label={tc('inactive')}>{tc('inactive')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
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
