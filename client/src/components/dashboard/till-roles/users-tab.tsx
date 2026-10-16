'use client';

/**
 * "עובדים": every till user of the company (or of the shop in scope) with their role, a
 * role picker, and "הרשאות אישיות" — a user's own exceptions over the role.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ClipboardCheck, SlidersHorizontal } from 'lucide-react';
import { ApprovalOverridesDialog, type OverridesTarget } from '@/components/dashboard/approvals/approval-overrides-dialog';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  groupPermissions,
  overridesCount,
  overridesDeniedUi,
  overridesDraft,
  overridesPayload,
  visibleRoles,
  type DeniedUi,
  type PermState,
  type PermissionCatalogue,
  type TillRoleUser,
  type TillRolesResponse,
} from '@/lib/tillRoles';
import { assignTillRole, fetchTillRoleUsers } from '@/lib/tillRolesApi';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { StateBadge } from './state-chip';
import { SELECT } from './role-dialogs';

function nameOf(u: Pick<TillRoleUser, 'firstName' | 'lastName' | 'username'>): string {
  return [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || u.username;
}

export function UsersTab({
  companyId,
  shopId,
  catalogue,
  data,
  canAssign,
}: {
  companyId: string;
  shopId: string | null;
  catalogue: PermissionCatalogue;
  data: TillRolesResponse;
  canAssign: boolean;
}) {
  const t = useTranslations('tillRoles');
  const qc = useQueryClient();
  const [includeInactive, setIncludeInactive] = useState(false);
  const [editing, setEditing] = useState<TillRoleUser | null>(null);
  // "בקשות אישור מרחוק": the employee's own overrides as an approver (beside "הרשאות אישיות").
  const [approvalTarget, setApprovalTarget] = useState<OverridesTarget | null>(null);
  const ta = useTranslations('approvals.overrides');
  const users = useQuery({
    queryKey: ['till-role-users', companyId, shopId, includeInactive],
    queryFn: () => fetchTillRoleUsers(companyId, shopId, includeInactive),
  });
  const roles = useMemo(() => visibleRoles(data.roles, true), [data.roles]);

  const assign = useMutation({
    mutationFn: ({ user, roleId }: { user: TillRoleUser; roleId: string }) =>
      assignTillRole(user.shopId, user.id, { tillRoleId: roleId }),
    onSuccess: () => {
      toast.success(t('usersTab.assigned'));
      qc.invalidateQueries({ queryKey: ['till-role-users', companyId] });
      qc.invalidateQueries({ queryKey: ['till-roles', companyId] });
      qc.invalidateQueries({ queryKey: ['till-role-changes', companyId] });
    },
    onError: (e: unknown) => toast.error(axiosErrorToToastMessage(e, t('saveFailed'))),
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-sm text-muted-foreground">{t('usersTab.hint')}</p>
        <label className="ms-auto flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />
          {t('usersTab.inactive')}
        </label>
      </div>
      <div className="overflow-x-auto rounded-lg border bg-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('usersTab.name')}</TableHead>
              <TableHead>{t('usersTab.shop')}</TableHead>
              <TableHead>{t('usersTab.role')}</TableHead>
              <TableHead>{t('usersTab.overrides')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {users.isLoading ? (
              Array.from({ length: 3 }).map((_, i) => (
                <TableRow key={i}>
                  {Array.from({ length: 4 }).map((__, j) => (
                    <TableCell key={j}>
                      <Skeleton className="h-4 w-full" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            ) : (users.data ?? []).length === 0 ? (
              <TableRow>
                <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                  {t('usersTab.none')}
                </TableCell>
              </TableRow>
            ) : (
              (users.data ?? []).map((u) => {
                const overrideCount = overridesCount(u);
                return (
                  <TableRow key={u.id} className={u.isActive ? undefined : 'opacity-60'}>
                    <TableCell className="font-medium">
                      {nameOf(u)} <span className="text-xs text-muted-foreground">({u.username})</span>
                    </TableCell>
                    <TableCell>{u.shopName ?? '—'}</TableCell>
                    <TableCell className="min-w-[12rem]">
                      {canAssign ? (
                        <select
                          className={SELECT}
                          aria-label={`${t('usersTab.role')} — ${nameOf(u)}`}
                          value={u.tillRoleId ?? ''}
                          disabled={assign.isPending}
                          onChange={(e) => e.target.value && assign.mutate({ user: u, roleId: e.target.value })}
                        >
                          {u.tillRoleId ? null : <option value="">{u.tillRoleName ?? '—'}</option>}
                          {roles.map((r) => (
                            <option key={r.id} value={r.id}>
                              {r.name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <Badge variant="secondary">{u.tillRoleName ?? '—'}</Badge>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="text-sm">{t('usersTab.overridesCount', { count: overrideCount })}</span>
                        {canAssign && u.tillRoleId ? (
                          <Button variant="ghost" size="sm" onClick={() => setEditing(u)}>
                            <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden /> {t('usersTab.edit')}
                          </Button>
                        ) : null}
                        {canAssign ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setApprovalTarget({ shopId: u.shopId, posUserId: u.id, name: nameOf(u) })}
                          >
                            <ClipboardCheck className="h-3.5 w-3.5" aria-hidden /> {ta('button')}
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
      <ApprovalOverridesDialog target={approvalTarget} onClose={() => setApprovalTarget(null)} />
      {editing ? (
        <OverridesDialog
          user={editing}
          companyId={companyId}
          catalogue={catalogue}
          data={data}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

function OverridesDialog({
  user,
  companyId,
  catalogue,
  data,
  onClose,
}: {
  user: TillRoleUser;
  companyId: string;
  catalogue: PermissionCatalogue;
  data: TillRolesResponse;
  onClose: () => void;
}) {
  const t = useTranslations('tillRoles');
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Record<string, PermState | ''>>(() => overridesDraft(user));
  // "כשאין הרשאה" for this employee alone (P:/specs/denied-actions-ui.md): '' = as the role.
  const [deniedUi, setDeniedUi] = useState<DeniedUi | ''>(() => overridesDeniedUi(user));
  const role = data.roles.find((r) => r.id === user.tillRoleId);
  const groups = useMemo(() => groupPermissions(catalogue), [catalogue]);
  const deniedUiLabel = (v: DeniedUi | null | undefined) =>
    v === 'show' ? t('deniedUiShow') : v === 'hide' ? t('deniedUiHide') : v === 'code' ? t('deniedUiCode') : t('deniedUiInherit');
  const save = useMutation({
    mutationFn: () => {
      const payload = overridesPayload(draft, deniedUi);
      return assignTillRole(user.shopId, user.id, {
        tillRoleId: user.tillRoleId as string,
        ...(payload ? { overrides: payload } : { clearOverrides: true }),
      });
    },
    onSuccess: () => {
      toast.success(t('usersTab.assigned'));
      qc.invalidateQueries({ queryKey: ['till-role-users', companyId] });
      qc.invalidateQueries({ queryKey: ['till-role-changes', companyId] });
      onClose();
    },
    onError: (e: unknown) => toast.error(axiosErrorToToastMessage(e, t('saveFailed'))),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t('usersTab.overridesTitle', { name: nameOf(user) })}</DialogTitle>
          <DialogDescription>{t('usersTab.overridesHint', { role: role?.name ?? user.tillRoleName ?? '—' })}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1 rounded-md border bg-primary/5 p-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="min-w-[12rem] flex-1 text-sm font-medium">{t('usersTab.deniedUi')}</span>
              <span className="text-xs text-muted-foreground">
                {t('usersTab.deniedUiRole', { value: deniedUiLabel(role?.deniedUi) })}
              </span>
              <select
                className={`${SELECT} w-40`}
                aria-label={t('usersTab.deniedUi')}
                value={deniedUi}
                onChange={(e) => setDeniedUi(e.target.value as DeniedUi | '')}
              >
                <option value="">{t('usersTab.deniedUiInherit')}</option>
                <option value="show">{t('deniedUiShow')}</option>
                <option value="hide">{t('deniedUiHide')}</option>
                <option value="code">{t('deniedUiCode')}</option>
              </select>
            </div>
            <p className="text-xs text-muted-foreground">{t('usersTab.deniedUiHint')}</p>
          </div>
          {groups.map((g) => (
            <div key={g.key} className="space-y-1">
              <div className="text-xs font-semibold text-muted-foreground">{g.label}</div>
              {g.permissions.map((p) => {
                const roleState = role?.permissions[p.code];
                return (
                  <div key={p.code} className="flex flex-wrap items-center gap-2 border-b py-1 last:border-0">
                    <span className="min-w-[12rem] flex-1 text-sm">{p.label}</span>
                    {roleState ? (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        {t('usersTab.roleValue', { state: '' })}
                        <StateBadge state={roleState} />
                      </span>
                    ) : null}
                    <select
                      className={`${SELECT} w-40`}
                      aria-label={p.label}
                      value={draft[p.code] ?? ''}
                      onChange={(e) => setDraft((d) => ({ ...d, [p.code]: e.target.value as PermState | '' }))}
                    >
                      <option value="">{t('states.inherit')}</option>
                      <option value="allow">{t('states.allow')}</option>
                      <option value="approval">{t('states.approval')}</option>
                      <option value="deny">{t('states.deny')}</option>
                    </select>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              setDraft({});
              setDeniedUi('');
            }}
          >
            {t('usersTab.clearAll')}
          </Button>
          <Button variant="outline" onClick={onClose}>
            {t('revert')}
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? t('saving') : t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
