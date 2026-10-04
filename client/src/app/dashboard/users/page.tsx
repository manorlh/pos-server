'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { activateUser, api, assignTillPin, deactivateUser, revokeTillPin } from '@/lib/api';
import { entitySelectItems } from '@/lib/selectItems';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { usePageScope } from '@/lib/scope';
import { ScopeIgnoredNote } from '@/components/dashboard/scope-gate';
import { User, UserRole, Company, Shop } from '@/lib/types';
import { useAuth } from '@/lib/auth';
import { ReportErrorState } from '@/components/dashboard/report-window-summary';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { toast } from 'sonner';
import { Plus, Pencil, UserRoundCheck, UserRoundX, KeyRound } from 'lucide-react';
import { TillPinDialog } from '@/components/dashboard/till-pin-dialog';

// A shift supervisor belongs to one shop, exactly like the cashiers they cover
// for: leave it off these lists and the dialog hides both pickers, so the user is
// created unattached and their PIN authorises nothing at any till.
const ROLE_NEEDS_COMPANY: UserRole[] = [
  'company_manager', 'shop_manager', 'shift_supervisor', 'cashier',
];
const ROLE_NEEDS_SHOP: UserRole[] = ['shop_manager', 'shift_supervisor', 'cashier'];

interface UserForm {
  id?: string;
  email: string;
  username: string;
  password: string;
  role: UserRole;
  /** The role the edited user already had. See `roleOptions`. */
  originalRole?: UserRole;
  companyId?: string;
  shopId?: string;
}

const EMPTY: UserForm = {
  email: '', username: '', password: '', role: 'cashier',
  companyId: undefined, shopId: undefined,
};

/**
 * `GET /users` is the one response in this app still serialised snake_case:
 * `UserResponse` on the server carries no camelCase aliases, unlike
 * `ShopResponse`, `PosUserResponse` and the rest. Read `isActive` straight off
 * the row and it is `undefined` — every user would render as deactivated, which
 * is precisely the signal this page now hangs on. Normalise on the way in, the
 * same way `lib/auth` already does for `/users/me`.
 */
function normalizeUser(row: Record<string, unknown>): User {
  const str = (camel: string, snake: string): string | undefined => {
    const v = row[camel] ?? row[snake];
    return v == null ? undefined : String(v);
  };
  return {
    id: String(row.id),
    email: String(row.email ?? ''),
    username: String(row.username ?? ''),
    role: row.role as UserRole,
    companyId: str('companyId', 'company_id'),
    shopId: str('shopId', 'shop_id'),
    isActive: Boolean(row.isActive ?? row.is_active),
    hasTillPin: Boolean(row.hasTillPin ?? row.has_till_pin),
    createdAt: str('createdAt', 'created_at') ?? '',
    updatedAt: str('updatedAt', 'updated_at') ?? '',
  };
}

function isForbidden(err: unknown): boolean {
  return (err as { response?: { status?: number } })?.response?.status === 403;
}

export default function UsersPage() {
  const t = useTranslations('users');
  const tc = useTranslations('common');
  const tp = useTranslations('tillPin');
  const [pinTarget, setPinTarget] = useState<User | null>(null);
  const { user: me, authHydrated } = useAuth();
  // `GET /users` takes no scope filters — the server decides which staff a caller
  // may see from their own role. So the shared scope does not narrow this list,
  // and the page says so instead of implying the selection was applied.
  const { resolution } = usePageScope({ maxLevel: 'tenant' });
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<UserForm>(EMPTY);
  const isNew = !editing.id;

  // Straight from GET /users/me. Nothing here re-derives who may do what: that
  // rule set lives in the server's users router and only it can be right.
  const canRead = me?.canReadUsers === true;
  const canManage = me?.canManageUsers === true;
  const creatableRoles = useMemo<UserRole[]>(() => me?.creatableRoles ?? [], [me]);

  const {
    data: users = [],
    isLoading,
    isError,
    error,
  } = useQuery<User[]>({
    queryKey: ['users'],
    queryFn: () => api.get('/users').then((r) => (r.data as unknown[]).map((row) => normalizeUser(row as Record<string, unknown>))),
    enabled: canRead,
  });

  // Both exist only to name the scope column and fill the dialog's pickers, so
  // they follow the same gate rather than firing for a caller with no table.
  const { data: companies = [] } = useQuery<Company[]>({
    queryKey: ['companies'],
    queryFn: () => api.get('/companies').then((r) => r.data),
    enabled: canRead,
  });

  const { data: shops = [] } = useQuery<Shop[]>({
    queryKey: ['shops'],
    queryFn: () => api.get('/shops').then((r) => r.data),
    enabled: canRead,
  });

  const filteredCompanies = companies;

  const filteredShops = editing.companyId
    ? shops.filter((s) => s.companyId === editing.companyId)
    : shops;

  const save = useMutation({
    mutationFn: (u: UserForm) => {
      // `originalRole` is local bookkeeping for the role picker, never a field.
      const payload: Record<string, unknown> = {
        email: u.email,
        username: u.username,
        role: u.role,
        companyId: u.companyId,
        shopId: u.shopId,
      };
      if (u.id) {
        // Update: only send password if changed
        if (u.password) payload.password = u.password;
        return api.put(`/users/${u.id}`, payload);
      }
      payload.password = u.password;
      return api.post('/users', payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      toast.success(isNew ? t('created') : t('updated'));
      setOpen(false);
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  /** One switch, both ways. Deactivating destroys nothing and activating undoes it. */
  const issuePin = useMutation({
    mutationFn: ({ id, pin }: { id: string; pin: string }) => assignTillPin(id, pin),
    onSuccess: () => {
      setPinTarget(null);
      toast.success(tp('issued'));
      qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, tp('issueFailed'))),
  });

  const revokePin = useMutation({
    mutationFn: (id: string) => revokeTillPin(id),
    onSuccess: () => {
      toast.success(tp('revoked'));
      qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, tp('revokeFailed'))),
  });

  const setActive = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      active ? activateUser(id) : deactivateUser(id),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['users'] });
      toast.success(vars.active ? t('activated') : t('deactivated'));
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const openEdit = (u: User) => {
    setEditing({
      id: u.id, email: u.email, username: u.username, password: '',
      role: u.role, originalRole: u.role, companyId: u.companyId,
      shopId: u.shopId,
    });
    setOpen(true);
  };

  const openCreate = () => {
    // Lead with the least authority the caller can delegate — `creatableRoles`
    // arrives highest-first, so the last entry is the safest default.
    setEditing({ ...EMPTY, role: creatableRoles[creatableRoles.length - 1] ?? 'cashier' });
    setOpen(true);
  };

  /**
   * The role picker offers exactly what the server said this caller may assign.
   *
   * One extra entry: when editing someone whose current role is not in that set
   * — a shop manager looking at a peer shop manager, say — the role still has to
   * appear, or the field renders blank and misstates what the row is today. It
   * is shown disabled, so the truth is visible without the UI offering a change
   * the server would refuse.
   */
  const roleOptions = useMemo(() => {
    const options = creatableRoles.map((r) => ({ value: r, label: t(`roles.${r}`), assignable: true }));
    const current = editing.originalRole;
    if (current && !creatableRoles.includes(current)) {
      options.push({
        value: current,
        label: `${t(`roles.${current}`)} — ${t('roleNotAssignable')}`,
        assignable: false,
      });
    }
    return options;
  }, [creatableRoles, editing.originalRole, t]);

  const handleRoleChange = (role: UserRole) => {
    setEditing((prev) => ({
      ...prev,
      role,
      companyId: ROLE_NEEDS_COMPANY.includes(role) ? prev.companyId : undefined,
      shopId: ROLE_NEEDS_SHOP.includes(role) ? prev.shopId : undefined,
    }));
  };

  const scopeName = (u: User) => {
    if (u.shopId) return shops.find((s) => s.id === u.shopId)?.name;
    if (u.companyId) return companies.find((c) => c.id === u.companyId)?.name;
    return '—';
  };

  // Hidden nav is not access control: a cashier can still type the URL. Say why
  // the table is missing instead of rendering an empty one, which would read as
  // "this company has no staff".
  const denied = authHydrated && !canRead;
  const loadFailed = isError;
  // Before /users/me answers, the list query is disabled and therefore not
  // "loading" — show the skeleton anyway rather than flashing "no users".
  const listLoading = !authHydrated || isLoading;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
        </div>
        {canManage && creatableRoles.length > 0 && (
          <Button onClick={openCreate} size="sm">
            <Plus className="h-4 w-4 ms-1" /> {t('add')}
          </Button>
        )}
      </div>

      {resolution.status === 'ok' && resolution.ignoredDeeper ? (
        <ScopeIgnoredNote maxLevel={resolution.maxLevel} />
      ) : null}

      {denied || loadFailed ? (
        <ReportErrorState
          message={
            denied || isForbidden(error)
              ? t('forbidden')
              : axiosErrorToToastMessage(error, tc('error'))
          }
        />
      ) : (
      <div className="rounded-lg border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('username')}</TableHead>
              <TableHead>{t('email')}</TableHead>
              <TableHead>{t('role')}</TableHead>
              <TableHead>{t('scope')}</TableHead>
              <TableHead>{tc('status')}</TableHead>
              <TableHead>{tp('column')}</TableHead>
              {canManage && <TableHead className="w-40" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {listLoading
              ? Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={i}>
                    {Array.from({ length: canManage ? 7 : 6 }).map((_, j) => (
                      <TableCell key={j}><Skeleton className="h-4 w-full" /></TableCell>
                    ))}
                  </TableRow>
                ))
              : users.length === 0
              ? (
                  <TableRow>
                    <TableCell colSpan={canManage ? 7 : 6} className="text-center text-muted-foreground py-8">
                      {t('noUsers')}
                    </TableCell>
                  </TableRow>
                )
              : users.map((u) => (
                  // Deactivated staff stay in the list — that is the whole point
                  // of a reversible switch — but read as switched off, not as a
                  // failure. Dimmed row, muted badge; nothing here is red.
                  <TableRow key={u.id} className={u.isActive ? undefined : 'opacity-60'}>
                    <TableCell className="font-medium">{u.username}</TableCell>
                    <TableCell className="text-muted-foreground">{u.email}</TableCell>
                    <TableCell>
                      <Badge variant="secondary">{t(`roles.${u.role}`)}</Badge>
                    </TableCell>
                    <TableCell>{scopeName(u)}</TableCell>
                    <TableCell>
                      <Badge
                        variant="outline"
                        className={u.isActive ? undefined : 'border-dashed text-muted-foreground'}
                      >
                        {u.isActive ? tc('active') : tc('inactive')}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {u.hasTillPin ? (
                        <Badge variant="default">{tp('stateSet')}</Badge>
                      ) : (
                        <span className="text-muted-foreground text-xs">{tp('stateNone')}</span>
                      )}
                    </TableCell>
                    {canManage && (
                      <TableCell>
                        <div className="flex items-center gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            title={u.hasTillPin ? tp('reissue') : tp('issue')}
                            onClick={() => setPinTarget(u)}
                          >
                            <KeyRound className="h-3.5 w-3.5" />
                          </Button>
                          {u.hasTillPin && (
                            <Button
                              variant="ghost"
                              size="icon"
                              title={tp('revoke')}
                              disabled={revokePin.isPending}
                              onClick={() => {
                                if (window.confirm(tp('revokeConfirm', { username: u.username }))) {
                                  revokePin.mutate(u.id);
                                }
                              }}
                            >
                              <UserRoundX className="h-3.5 w-3.5" />
                            </Button>
                          )}
                          <Button variant="ghost" size="icon" title={tc('edit')} onClick={() => openEdit(u)}>
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          {me?.id !== u.id && (
                            u.isActive ? (
                              <Button
                                variant="ghost"
                                size="sm"
                                className="gap-1 text-muted-foreground hover:text-foreground"
                                disabled={setActive.isPending}
                                onClick={() => {
                                  if (window.confirm(t('deactivateConfirm', { username: u.username }))) {
                                    setActive.mutate({ id: u.id, active: false });
                                  }
                                }}
                              >
                                <UserRoundX className="h-3.5 w-3.5" />
                                {t('deactivate')}
                              </Button>
                            ) : (
                              // No confirm on the way back: restoring an account
                              // the caller just switched off is the cheap,
                              // reversible direction.
                              <Button
                                variant="outline"
                                size="sm"
                                className="gap-1"
                                disabled={setActive.isPending}
                                onClick={() => setActive.mutate({ id: u.id, active: true })}
                              >
                                <UserRoundCheck className="h-3.5 w-3.5" />
                                {t('activate')}
                              </Button>
                            )
                          )}
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))}
          </TableBody>
        </Table>
      </div>
      )}

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
                  items={roleOptions.map(({ value, label }) => ({ value, label }))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {roleOptions.map((o) => (
                      <SelectItem key={o.value} value={o.value} label={o.label} disabled={!o.assignable}>
                        {o.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {/*
                  אחמ"ש reads as "senior cashier" and says nothing about what the
                  role actually buys — till authority, no desk. Roles whose name
                  already carries that get no hint and render nothing here.
                */}
                {t.has(`roleHints.${editing.role}`) && (
                  <p className="text-muted-foreground text-xs">{t(`roleHints.${editing.role}`)}</p>
                )}
              </div>
            </div>

            {ROLE_NEEDS_COMPANY.includes(editing.role) && (
              <div className="space-y-1">
                <Label>{t('company')}</Label>
                <Select
                  value={editing.companyId ?? ''}
                  onValueChange={(v) => setEditing((u) => ({ ...u, companyId: v || undefined, shopId: undefined }))}
                  items={entitySelectItems(filteredCompanies)}
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
                  items={entitySelectItems(filteredShops)}
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

            {/*
              The status picker that used to sit here is gone. It sent
              `isActive` in the PUT body, which the server's `UserUpdate` — no
              camelCase aliases, no `populate_by_name` — dropped on the floor, so
              it silently did nothing. Activation now has one control that works:
              the row's Deactivate/Activate switch.
            */}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>{tc('cancel')}</Button>
            <Button onClick={() => save.mutate(editing)} disabled={save.isPending}>
              {save.isPending ? tc('saving') : tc('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <TillPinDialog
        open={pinTarget !== null}
        title={pinTarget?.hasTillPin ? tp('reissue') : tp('issue')}
        description={tp('issueBlurb', { username: pinTarget?.username ?? '' })}
        saving={issuePin.isPending}
        onSubmit={(pin) => {
          if (pinTarget) issuePin.mutate({ id: pinTarget.id, pin });
        }}
        onOpenChange={(next) => {
          if (!next) setPinTarget(null);
        }}
      />
    </div>
  );
}
