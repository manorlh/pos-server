'use client';

/** "יומן שינויים": who changed which role or user, when, and what moved. */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { describeStateChanges, type PermState, type PermissionCatalogue, type TillRoleChange } from '@/lib/tillRoles';
import { fetchTillRoleChanges } from '@/lib/tillRolesApi';
import { formatDateTime } from '@/lib/format';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

function detailLines(
  c: TillRoleChange,
  labels: Record<string, string>,
  stateLabel: (s: PermState) => string,
  t: ReturnType<typeof useTranslations>,
): string[] {
  const oldV = (c.oldValue ?? {}) as Record<string, unknown>;
  const newV = (c.newValue ?? {}) as Record<string, unknown>;
  if (c.action === 'assign') return [t('audit.assignedTo', { role: String(newV.roleName ?? c.roleName ?? '') })];
  if (c.action === 'apply_defaults') {
    const reset = Array.isArray(newV.resetRoles) ? (newV.resetRoles as string[]).join(', ') : '';
    return [t('audit.appliedSummary', { roles: reset || '—', users: Number(newV.movedUsers ?? 0) })];
  }
  if (c.action === 'delete' && typeof newV.users === 'number' && newV.users > 0) {
    return [t('audit.reassigned', { users: newV.users })];
  }
  const lines: string[] = [];
  if (c.action === 'update' && oldV.name && newV.name && oldV.name !== newV.name) {
    lines.push(t('audit.renamed', { from: String(oldV.name), to: String(newV.name) }));
  }
  return lines.concat(describeStateChanges(c.oldValue, c.newValue, labels, stateLabel));
}

export function AuditTab({ companyId, catalogue }: { companyId: string; catalogue: PermissionCatalogue }) {
  const t = useTranslations('tillRoles');
  const changes = useQuery({ queryKey: ['till-role-changes', companyId], queryFn: () => fetchTillRoleChanges(companyId) });
  const labels = useMemo(
    () => Object.fromEntries(catalogue.permissions.map((p) => [p.code, p.label])),
    [catalogue.permissions],
  );
  const stateLabel = (s: PermState) => t(`states.${s}`);

  if (changes.isLoading) return <Skeleton className="h-48 w-full" />;
  const rows = changes.data ?? [];
  return (
    <div className="overflow-x-auto rounded-lg border bg-card">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('audit.when')}</TableHead>
            <TableHead>{t('audit.who')}</TableHead>
            <TableHead>{t('audit.action')}</TableHead>
            <TableHead>{t('audit.subject')}</TableHead>
            <TableHead>{t('audit.details')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                {t('audit.empty')}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((c) => (
              <TableRow key={c.id} className="align-top">
                <TableCell className="whitespace-nowrap">{c.createdAt ? formatDateTime(c.createdAt) : '—'}</TableCell>
                <TableCell>{c.userEmail ?? '—'}</TableCell>
                <TableCell>{t.has(`audit.actions.${c.action}`) ? t(`audit.actions.${c.action}`) : c.action}</TableCell>
                <TableCell>{[c.roleName, c.posUserName].filter(Boolean).join(' · ') || '—'}</TableCell>
                <TableCell>
                  <ul className="space-y-0.5 text-xs">
                    {detailLines(c, labels, stateLabel, t).map((line, i) => (
                      <li key={i}>{line}</li>
                    ))}
                  </ul>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
