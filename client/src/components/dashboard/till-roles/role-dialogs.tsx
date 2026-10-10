'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import type { PermissionCatalogue, TillRole } from '@/lib/tillRoles';
import { applySpecDefaults, createTillRole, deleteTillRole, updateTillRole } from '@/lib/tillRolesApi';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export const SELECT =
  'border-input bg-background h-9 w-full rounded-md border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

function useRefresh(companyId: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['till-roles', companyId] });
    qc.invalidateQueries({ queryKey: ['till-role-users', companyId] });
    qc.invalidateQueries({ queryKey: ['till-role-changes', companyId] });
  };
}

/** "תפקיד חדש": blank from a built-in template, or a duplicate of an existing role. */
export function NewRoleDialog({
  open,
  onOpenChange,
  companyId,
  catalogue,
  roles,
  duplicateOf,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  catalogue: PermissionCatalogue;
  roles: TillRole[];
  /** Preselects "duplicate this role". */
  duplicateOf?: TillRole | null;
}) {
  const t = useTranslations('tillRoles');
  const refresh = useRefresh(companyId);
  const [name, setName] = useState(duplicateOf ? t('dialogs.copyName', { name: duplicateOf.name }) : '');
  const [description, setDescription] = useState('');
  const [base, setBase] = useState<string>(duplicateOf ? `copy:${duplicateOf.id}` : 'template:cashier');
  const templates = catalogue.builtinRoles.filter((r) => !r.legacy);

  const create = useMutation({
    mutationFn: () => {
      const [kind, value] = base.split(':');
      return createTillRole(companyId, {
        name: name.trim(),
        description: description.trim() || null,
        baseKey: kind === 'template' ? value : null,
        copyFromRoleId: kind === 'copy' ? value : null,
      });
    },
    onSuccess: () => {
      toast.success(t('dialogs.created'));
      refresh();
      onOpenChange(false);
    },
    onError: (e: unknown) => toast.error(axiosErrorToToastMessage(e, t('saveFailed'))),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('dialogs.newTitle')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="till-role-name">{t('dialogs.name')}</Label>
            <Input id="till-role-name" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="till-role-desc">{t('dialogs.description')}</Label>
            <Input id="till-role-desc" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="till-role-base">{t('dialogs.base')}</Label>
            <select id="till-role-base" className={SELECT} value={base} onChange={(e) => setBase(e.target.value)}>
              {templates.map((r) => (
                <option key={r.key} value={`template:${r.key}`}>
                  {t('dialogs.baseTemplate', { name: r.name })}
                </option>
              ))}
              {roles.map((r) => (
                <option key={r.id} value={`copy:${r.id}`}>
                  {t('dialogs.baseCopy', { name: r.name })}
                </option>
              ))}
            </select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('revert')}
          </Button>
          <Button onClick={() => create.mutate()} disabled={!name.trim() || create.isPending}>
            {create.isPending ? t('saving') : t('dialogs.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function EditRoleDialog({
  role,
  onClose,
  companyId,
}: {
  role: TillRole;
  onClose: () => void;
  companyId: string;
}) {
  const t = useTranslations('tillRoles');
  const refresh = useRefresh(companyId);
  const [name, setName] = useState(role.name);
  const [description, setDescription] = useState(role.description ?? '');
  const save = useMutation({
    mutationFn: () => updateTillRole(companyId, role.id, { name: name.trim(), description: description.trim() || null }),
    onSuccess: () => {
      toast.success(t('dialogs.updated'));
      refresh();
      onClose();
    },
    onError: (e: unknown) => toast.error(axiosErrorToToastMessage(e, t('saveFailed'))),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('dialogs.editTitle')}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="till-role-rename">{t('dialogs.name')}</Label>
            <Input id="till-role-rename" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="till-role-redesc">{t('dialogs.description')}</Label>
            <Input id="till-role-redesc" value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('revert')}
          </Button>
          <Button onClick={() => save.mutate()} disabled={!name.trim() || save.isPending}>
            {save.isPending ? t('saving') : t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function DeleteRoleDialog({
  role,
  roles,
  onClose,
  companyId,
}: {
  role: TillRole;
  roles: TillRole[];
  onClose: () => void;
  companyId: string;
}) {
  const t = useTranslations('tillRoles');
  const refresh = useRefresh(companyId);
  const targets = useMemo(() => roles.filter((r) => r.id !== role.id), [roles, role.id]);
  const [target, setTarget] = useState(targets.find((r) => r.builtinKey === 'cashier')?.id ?? targets[0]?.id ?? '');
  const remove = useMutation({
    mutationFn: () => deleteTillRole(companyId, role.id, role.users > 0 ? target : null),
    onSuccess: () => {
      toast.success(t('dialogs.deleted'));
      refresh();
      onClose();
    },
    onError: (e: unknown) => toast.error(axiosErrorToToastMessage(e, t('saveFailed'))),
  });
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t('dialogs.deleteTitle')}</DialogTitle>
          <DialogDescription>{t('dialogs.deleteBody', { name: role.name })}</DialogDescription>
        </DialogHeader>
        {role.users > 0 ? (
          <div className="space-y-1">
            <p className="text-sm">{t('dialogs.deleteInUse', { count: role.users })}</p>
            <Label htmlFor="till-role-reassign">{t('dialogs.reassignTo')}</Label>
            <select id="till-role-reassign" className={SELECT} value={target} onChange={(e) => setTarget(e.target.value)}>
              {targets.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('revert')}
          </Button>
          <Button variant="destructive" onClick={() => remove.mutate()} disabled={remove.isPending || (role.users > 0 && !target)}>
            {t('delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** "החל ברירות מחדל לפי האפיון". */
export function ApplyDefaultsDialog({
  open,
  onOpenChange,
  companyId,
  roles,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  roles: TillRole[];
}) {
  const t = useTranslations('tillRoles');
  const qc = useQueryClient();
  const [reset, setReset] = useState(true);
  const [move, setMove] = useState(false);
  const legacyUsers = roles.filter((r) => r.legacy).reduce((n, r) => n + r.users, 0);
  const apply = useMutation({
    mutationFn: () => applySpecDefaults(companyId, { resetBuiltins: reset, moveLegacyUsers: move }),
    onSuccess: (out) => {
      qc.setQueryData(['till-roles', companyId], out);
      qc.invalidateQueries({ queryKey: ['till-role-users', companyId] });
      qc.invalidateQueries({ queryKey: ['till-role-changes', companyId] });
      toast.success(
        t('dialogs.applied', { roles: out.applied?.resetRoles.length ?? 0, users: out.applied?.movedUsers ?? 0 }),
      );
      onOpenChange(false);
    },
    onError: (e: unknown) => toast.error(axiosErrorToToastMessage(e, t('saveFailed'))),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('dialogs.applyTitle')}</DialogTitle>
          <DialogDescription>{t('dialogs.applyBody')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-0.5 h-4 w-4 accent-primary" checked={reset} onChange={(e) => setReset(e.target.checked)} />
            <span>{t('dialogs.applyReset')}</span>
          </label>
          <label className="flex items-start gap-2">
            <input
              type="checkbox"
              className="mt-0.5 h-4 w-4 accent-primary"
              checked={move}
              disabled={legacyUsers === 0}
              onChange={(e) => setMove(e.target.checked)}
            />
            <span>{t('dialogs.applyMove', { count: legacyUsers })}</span>
          </label>
          {move ? <p className="rounded-md bg-amber-50 p-2 text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">{t('dialogs.applyMoveWarning')}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('revert')}
          </Button>
          <Button onClick={() => apply.mutate()} disabled={apply.isPending || (!reset && !move)}>
            {t('dialogs.apply')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
