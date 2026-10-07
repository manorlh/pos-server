'use client';

/**
 * The matrix editor: permissions (rows, in groups) × roles (columns), a tri-state chip per
 * cell and the limit boxes under an "allowed" chip that carries limits. Edits stay local
 * until "שמירה", which sends only the roles that changed and, per role, only what differs
 * from its template (lib/tillRoles.ts `matrixPayload`).
 */

import { Fragment, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Copy, MoreHorizontal, Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  changedCells,
  countStates,
  draftFromRoles,
  groupPermissions,
  matrixPayload,
  parseLimit,
  setCell,
  setLimit,
  visibleRoles,
  type MatrixDraft,
  type PermissionCatalogue,
  type TillRole,
  type TillRolesResponse,
} from '@/lib/tillRoles';
import { saveTillRoleMatrix } from '@/lib/tillRolesApi';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { StateChip } from './state-chip';
import { ApplyDefaultsDialog, DeleteRoleDialog, EditRoleDialog, NewRoleDialog } from './role-dialogs';

export function MatrixTab({
  companyId,
  catalogue,
  data,
}: {
  companyId: string;
  catalogue: PermissionCatalogue;
  data: TillRolesResponse;
}) {
  // Re-keyed on the server's answer, so a save (or another tab's change) restarts the draft.
  const key = data.roles.map((r) => `${r.id}:${r.updatedAt}`).join('|');
  return <Matrix key={key} companyId={companyId} catalogue={catalogue} data={data} />;
}

function Matrix({
  companyId,
  catalogue,
  data,
}: {
  companyId: string;
  catalogue: PermissionCatalogue;
  data: TillRolesResponse;
}) {
  const t = useTranslations('tillRoles');
  const qc = useQueryClient();
  const canEdit = data.canEdit;
  const hasLegacyUsers = data.roles.some((r) => r.legacy && r.users > 0);
  const [showLegacy, setShowLegacy] = useState(false);
  const roles = useMemo(() => visibleRoles(data.roles, showLegacy), [data.roles, showLegacy]);
  const [draft, setDraft] = useState<MatrixDraft>(() => draftFromRoles(data.roles));
  const [limitText, setLimitText] = useState<Record<string, string>>({});
  const [invalidCells, setInvalidCells] = useState<string[]>([]);
  const [newOpen, setNewOpen] = useState(false);
  const [duplicate, setDuplicate] = useState<TillRole | null>(null);
  const [editing, setEditing] = useState<TillRole | null>(null);
  const [deleting, setDeleting] = useState<TillRole | null>(null);
  const [applyOpen, setApplyOpen] = useState(false);
  const groups = useMemo(() => groupPermissions(catalogue), [catalogue]);
  const changes = changedCells(data.roles, draft);
  const invalid = invalidCells.length > 0;

  const save = useMutation({
    mutationFn: () => saveTillRoleMatrix(companyId, matrixPayload(data.roles, draft, catalogue)),
    onSuccess: (out) => {
      qc.setQueryData(['till-roles', companyId], out);
      qc.invalidateQueries({ queryKey: ['till-role-users', companyId] });
      qc.invalidateQueries({ queryKey: ['till-role-changes', companyId] });
      toast.success(t('saved'));
    },
    onError: (e: unknown) => toast.error(axiosErrorToToastMessage(e, t('saveFailed'))),
  });

  const roleLabel = (r: TillRole) => r.name;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {canEdit ? (
          <>
            <Button size="sm" onClick={() => setNewOpen(true)}>
              <Plus className="h-4 w-4" aria-hidden /> {t('newRole')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setApplyOpen(true)}>
              <Sparkles className="h-4 w-4" aria-hidden /> {t('applyDefaults')}
            </Button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{t('readOnly')}</p>
        )}
        <label className="ms-auto flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 accent-primary"
            checked={showLegacy || hasLegacyUsers}
            disabled={hasLegacyUsers}
            onChange={(e) => setShowLegacy(e.target.checked)}
          />
          {t('showLegacy')}
        </label>
      </div>
      <p className="text-xs text-muted-foreground">{t('legend')}</p>

      <div className="overflow-x-auto rounded-lg border bg-card">
        <table className="w-full min-w-[720px] text-sm">
          <thead>
            <tr className="border-b bg-muted/40 align-bottom">
              <th className="sticky start-0 z-10 bg-muted/40 p-2 text-start font-medium" />
              {roles.map((r) => {
                const counts = countStates(draft.states[r.id] ?? r.permissions);
                return (
                  <th key={r.id} className="min-w-[8.5rem] p-2 text-center align-bottom font-medium">
                    <div className="flex items-start justify-center gap-1">
                      <div className="space-y-1">
                        <div className="whitespace-nowrap">{roleLabel(r)}</div>
                        <div className="flex flex-wrap justify-center gap-1">
                          {r.legacy ? <Badge variant="outline">{t('legacyBadge')}</Badge> : null}
                          {r.builtin && !r.legacy ? <Badge variant="secondary">{t('builtinBadge')}</Badge> : null}
                        </div>
                        <div className="text-[11px] font-normal text-muted-foreground">{t('users', { count: r.users })}</div>
                        <div className="text-[11px] font-normal text-muted-foreground" title={t('olderTills', { role: t(`legacyRoles.${r.legacyRole}`) })}>
                          {counts.allow}·{counts.approval}·{counts.deny}
                        </div>
                      </div>
                      {canEdit ? (
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button variant="ghost" size="sm" className="h-7 w-7 p-0" aria-label={`${t('roleMenu')} — ${r.name}`}>
                                <MoreHorizontal className="h-4 w-4" aria-hidden />
                              </Button>
                            }
                          />
                          <DropdownMenuContent align="end" className="w-48">
                            <DropdownMenuGroup>
                              <DropdownMenuLabel>{r.name}</DropdownMenuLabel>
                            </DropdownMenuGroup>
                            <DropdownMenuItem onClick={() => setEditing(r)}>
                              <Pencil aria-hidden /> {t('rename')}
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              onClick={() => {
                                setDuplicate(r);
                                setNewOpen(true);
                              }}
                            >
                              <Copy aria-hidden /> {t('duplicate')}
                            </DropdownMenuItem>
                            {!r.builtin ? (
                              <DropdownMenuItem onClick={() => setDeleting(r)}>
                                <Trash2 aria-hidden /> {t('delete')}
                              </DropdownMenuItem>
                            ) : null}
                          </DropdownMenuContent>
                        </DropdownMenu>
                      ) : null}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {groups.map((g) => (
              <Fragment key={g.key}>
                <tr className="border-b bg-muted/20">
                  <td colSpan={roles.length + 1} className="p-2 text-xs font-semibold text-muted-foreground">
                    {g.label}
                  </td>
                </tr>
                {g.permissions.map((p) => (
                  <tr key={p.code} className="border-b last:border-0 align-top">
                    <td className="sticky start-0 z-10 max-w-[18rem] bg-card p-2">
                      <div className="font-medium">{p.label}</div>
                      <div className="text-xs text-muted-foreground">{p.description}</div>
                      <div className="mt-0.5 font-mono text-[10px] text-muted-foreground" dir="ltr">
                        {p.code}
                      </div>
                    </td>
                    {roles.map((r) => {
                      const state = draft.states[r.id]?.[p.code] ?? r.permissions[p.code] ?? 'deny';
                      const changed = state !== r.permissions[p.code];
                      return (
                        <td key={r.id} className="p-2 text-center">
                          <StateChip
                            state={state}
                            disabled={!canEdit}
                            changed={changed}
                            label={`${p.label} — ${r.name}`}
                            onChange={(next) => setDraft((d) => setCell(d, r.id, p.code, next))}
                          />
                          {state === 'allow' && p.limits.length > 0
                            ? p.limits.map((lim) => {
                                const cellKey = `${r.id}|${p.code}|${lim.key}`;
                                const current = draft.limits[r.id]?.[p.code]?.[lim.key];
                                const shown =
                                  limitText[cellKey] ??
                                  (current === null || current === undefined || current >= lim.max ? '' : String(current));
                                return (
                                  <label key={lim.key} className="mt-1 flex items-center justify-center gap-1 text-[11px] text-muted-foreground" title={t('limitHint')}>
                                    {lim.unit === 'percent' ? t('limitPercent') : t('limitAmount')}
                                    <input
                                      inputMode="decimal"
                                      dir="ltr"
                                      disabled={!canEdit}
                                      aria-label={`${p.label} — ${r.name} — ${lim.label}`}
                                      className="h-6 w-16 rounded border border-input bg-background px-1 text-center text-xs"
                                      value={shown}
                                      onChange={(e) => {
                                        const text = e.target.value;
                                        const value = parseLimit(text, lim);
                                        setLimitText((m) => ({ ...m, [cellKey]: text }));
                                        setInvalidCells((cells) =>
                                          value === undefined
                                            ? Array.from(new Set([...cells, cellKey]))
                                            : cells.filter((c) => c !== cellKey),
                                        );
                                        if (value !== undefined) setDraft((d) => setLimit(d, r.id, p.code, lim.key, value));
                                      }}
                                    />
                                  </label>
                                );
                              })
                            : null}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {canEdit && changes > 0 ? (
        <div className="sticky bottom-0 flex flex-wrap items-center justify-end gap-2 border-t bg-background/90 py-3 backdrop-blur">
          <span className="me-auto text-sm text-muted-foreground">{t('changed', { count: changes })}</span>
          <Button
            variant="outline"
            onClick={() => {
              setDraft(draftFromRoles(data.roles));
              setLimitText({});
              setInvalidCells([]);
            }}
          >
            {t('revert')}
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || invalid}>
            {save.isPending ? t('saving') : t('save')}
          </Button>
        </div>
      ) : null}

      {newOpen ? (
        <NewRoleDialog
          open={newOpen}
          onOpenChange={(o) => {
            setNewOpen(o);
            if (!o) setDuplicate(null);
          }}
          companyId={companyId}
          catalogue={catalogue}
          roles={data.roles}
          duplicateOf={duplicate}
        />
      ) : null}
      {editing ? <EditRoleDialog role={editing} companyId={companyId} onClose={() => setEditing(null)} /> : null}
      {deleting ? (
        <DeleteRoleDialog role={deleting} roles={data.roles} companyId={companyId} onClose={() => setDeleting(null)} />
      ) : null}
      {applyOpen ? (
        <ApplyDefaultsDialog open={applyOpen} onOpenChange={setApplyOpen} companyId={companyId} roles={data.roles} />
      ) : null}
    </div>
  );
}
