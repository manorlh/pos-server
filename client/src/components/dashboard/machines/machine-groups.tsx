'use client';

/**
 * "קבוצות מכשירים" — named groups of tills across the shops of one company, a level a catalog
 * menu can be assigned to ("תפריטים › שיוך": קופה › קבוצת מכשירים › נקודת מכירה › סניף › חברה).
 * A tab of ארגון › מכשירים (/dashboard/machines).
 *
 * The list (each group: its company, its tills), a new group, renaming one, choosing its tills
 * (the active tills of shops under its company — lib/machineGroups.ts `eligibleTills`) and
 * deleting it, which removes the menus assigned to it too. Every change reaches the tills on
 * their next pull (pos-server app/services/machine_groups.py).
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowRight, Layers, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  cleanGroupName,
  eligibleTills,
  groupNameTaken,
  machineGroupErrorCode,
  sameMembers,
  toggleMember,
  type MachineGroup,
} from '@/lib/machineGroups';
import {
  MACHINE_GROUPS_KEY,
  createMachineGroup,
  deleteMachineGroup,
  fetchMachineGroups,
  renameMachineGroup,
  setMachineGroupTills,
} from '@/lib/machineGroupsApi';
import { registerNumberOf } from '@/lib/registerNumber';
import type { Company, PosMachine, Shop } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';

/** The menus' own queries ("תפריטים" — components/dashboard/catalog-menus/shared.tsx). */
const MENU_KEYS = [['catalog-menus-targets'], ['catalog-menus-now'], ['catalog-menus-simulate']] as const;

type View = { kind: 'list' } | { kind: 'edit'; group: MachineGroup | null };

function useGroupErrorText(): (err: unknown) => string {
  const t = useTranslations('machineGroups.errors');
  const tc = useTranslations('common');
  return (err: unknown) => {
    const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
    const code = machineGroupErrorCode(detail);
    return code ? t(code) : axiosErrorToToastMessage(err, tc('error'));
  };
}

/** The "קבוצות מכשירים" tab of ארגון › מכשירים. */
export function MachineGroupsPanel({
  machines,
  shops,
  companies,
  companyId,
  canCreate,
}: {
  machines: PosMachine[];
  shops: Shop[];
  companies: Company[];
  /** The page's scope: that company and those beneath it; null: every company the user sees. */
  companyId: string | null;
  /** A catalog writer over a company (the server decides per company; this only offers the button). */
  canCreate: boolean;
}) {
  const t = useTranslations('machineGroups');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const errorText = useGroupErrorText();
  const [view, setView] = useState<View>({ kind: 'list' });
  const [confirmDelete, setConfirmDelete] = useState<MachineGroup | null>(null);
  const { data: groups = [], isLoading, isError, error } = useQuery<MachineGroup[]>({
    queryKey: [...MACHINE_GROUPS_KEY, companyId],
    queryFn: () => fetchMachineGroups(companyId),
  });

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: MACHINE_GROUPS_KEY });
    for (const key of MENU_KEYS) void qc.invalidateQueries({ queryKey: key });
  };

  const remove = useMutation({
    mutationFn: (g: MachineGroup) => deleteMachineGroup(g.id),
    onSuccess: () => {
      toast.success(t('deleted'));
      setConfirmDelete(null);
      invalidate();
    },
    onError: (err) => toast.error(errorText(err)),
  });

  if (view.kind === 'edit') {
    return (
      <Card>
        <CardContent className="space-y-4 pt-6">
          <GroupEditor
            group={view.group}
            groups={groups}
            machines={machines}
            shops={shops}
            companies={companies}
            scopeCompanyId={companyId}
            onSaved={() => {
              invalidate();
              setView({ kind: 'list' });
            }}
            onBack={() => setView({ kind: 'list' })}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 max-w-3xl space-y-1">
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Layers className="h-5 w-5" aria-hidden /> {t('title')}
          </h2>
          <p className="text-muted-foreground text-sm">{t('hint')}</p>
        </div>
        {canCreate ? (
          <Button size="sm" onClick={() => setView({ kind: 'edit', group: null })}>
            <Plus className="ms-1 h-4 w-4" aria-hidden /> {t('new')}
          </Button>
        ) : null}
      </div>
      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      ) : isError ? (
        <p className="text-destructive text-sm">{errorText(error)}</p>
      ) : groups.length === 0 ? (
        <div className="text-muted-foreground flex flex-col items-center justify-center gap-3 py-16">
          <Layers className="h-10 w-10 opacity-30" aria-hidden />
          <p className="text-center text-sm">{t('empty')}</p>
        </div>
      ) : (
        <ul className="bg-card divide-y rounded-lg border">
          {groups.map((g) => (
            <li key={g.id} className="space-y-1.5 p-3">
              <div className="flex items-start gap-2">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{g.name}</p>
                  <p className="text-muted-foreground text-xs">
                    {g.companyName ? `${g.companyName} · ` : ''}
                    {t('tillsCount', { count: g.machines.length })}
                  </p>
                </div>
                {g.canEdit ? (
                  <>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t('edit')}
                      title={t('edit')}
                      onClick={() => setView({ kind: 'edit', group: g })}
                    >
                      <Pencil className="h-4 w-4" aria-hidden />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={t('delete')}
                      title={t('delete')}
                      onClick={() => setConfirmDelete(g)}
                    >
                      <Trash2 className="text-destructive h-4 w-4" aria-hidden />
                    </Button>
                  </>
                ) : (
                  <span className="text-muted-foreground text-xs">{t('readOnly')}</span>
                )}
              </div>
              {g.machines.length ? (
                <div className="flex flex-wrap gap-1">
                  {g.machines.map((m) => (
                    <span
                      key={m.id}
                      className="bg-muted rounded-full px-2 py-0.5 text-[11px]"
                      title={m.shopName ?? undefined}
                    >
                      {m.posNumber ? `${t('till', { number: m.posNumber })} · ${m.name}` : m.name}
                      {m.shopName ? <span className="text-muted-foreground"> · {m.shopName}</span> : null}
                    </span>
                  ))}
                </div>
              ) : null}
              {confirmDelete?.id === g.id ? (
                <div className="border-destructive/30 bg-destructive/5 space-y-2 rounded-md border p-2 text-sm">
                  <p>{t('deleteConfirm', { name: g.name })}</p>
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => setConfirmDelete(null)}>
                      {tc('cancel')}
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(g)}
                    >
                      {t('deleteYes')}
                    </Button>
                  </div>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <p className="text-muted-foreground text-xs">
        <Link href="/dashboard/menus" className="text-primary hover:underline">
          {t('menusLink')}
        </Link>
      </p>
    </div>
  );
}

function GroupEditor({
  group,
  groups,
  machines,
  shops,
  companies,
  scopeCompanyId,
  onSaved,
  onBack,
}: {
  /** Null: a new group. */
  group: MachineGroup | null;
  groups: MachineGroup[];
  machines: PosMachine[];
  shops: Shop[];
  companies: Company[];
  scopeCompanyId: string | null;
  onSaved: () => void;
  onBack: () => void;
}) {
  const t = useTranslations('machineGroups');
  const tc = useTranslations('common');
  const errorText = useGroupErrorText();
  const [name, setName] = useState(group?.name ?? '');
  const [companyId, setCompanyId] = useState<string>(
    group?.companyId ?? scopeCompanyId ?? (companies.length === 1 ? companies[0].id : ''),
  );
  const [members, setMembers] = useState<string[]>(group?.machineIds ?? []);
  const [search, setSearch] = useState('');

  const clean = cleanGroupName(name);
  const taken = !!companyId && groupNameTaken(groups, companyId, clean, group?.id);
  const shopName = useMemo(() => new Map(shops.map((s) => [s.id, s.name])), [shops]);
  const tills = useMemo(() => {
    if (!companyId) return [];
    const eligible = eligibleTills(machines, shops, companies, companyId);
    // A member the list no longer offers (retired since, or moved away) stays visible so it can be removed.
    const extra = (group?.machines ?? [])
      .filter((m) => members.includes(m.id) && !eligible.some((e) => e.id === m.id))
      .map((m) => ({ id: m.id, name: m.name, shopId: m.shopId ?? undefined, posNumber: m.posNumber }) as PosMachine);
    return [...eligible, ...extra];
  }, [machines, shops, companies, companyId, group, members]);
  const needle = search.trim().toLowerCase();
  const shown = needle
    ? tills.filter(
        (m) =>
          m.name.toLowerCase().includes(needle) ||
          (shopName.get(m.shopId ?? '') ?? '').toLowerCase().includes(needle) ||
          (registerNumberOf(m) !== null && String(registerNumberOf(m)).includes(needle)),
      )
    : tills;
  const byShop = useMemo(() => {
    const out = new Map<string, PosMachine[]>();
    for (const m of shown) {
      const key = m.shopId ?? '';
      out.set(key, [...(out.get(key) ?? []), m]);
    }
    return [...out.entries()].sort((a, b) =>
      (shopName.get(a[0]) ?? '').localeCompare(shopName.get(b[0]) ?? '', 'he'),
    );
  }, [shown, shopName]);

  const companyItems = companies
    .filter((c) => c.isActive !== false || c.id === companyId)
    .map((c) => ({ value: c.id, label: c.name }))
    .sort((a, b) => a.label.localeCompare(b.label, 'he'));

  const save = useMutation({
    mutationFn: async () => {
      if (!group) {
        await createMachineGroup({ name: clean, companyId, machineIds: members });
        return 'created' as const;
      }
      if (clean !== group.name) await renameMachineGroup(group.id, clean);
      if (!sameMembers(members, group.machineIds)) await setMachineGroupTills(group.id, members);
      return 'saved' as const;
    },
    onSuccess: (outcome) => {
      toast.success(t(outcome));
      onSaved();
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const unchanged = !!group && clean === group.name && sameMembers(members, group.machineIds);

  return (
    <>
      <h2 className="text-lg font-semibold">{group ? t('editTitle') : t('newTitle')}</h2>
      <div className="max-w-xl space-y-4">
        <div className="space-y-1">
          <Label htmlFor="machine-group-name">{t('name')}</Label>
          <Input
            id="machine-group-name"
            value={name}
            maxLength={80}
            placeholder={t('namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          {taken ? <p className="text-destructive text-xs">{t('errors.machine_group_name_taken')}</p> : null}
        </div>
        {group ? (
          group.companyName ? (
            <p className="text-muted-foreground text-sm">
              {t('company')}: {group.companyName}
            </p>
          ) : null
        ) : (
          <div className="space-y-1">
            <Label>{t('company')}</Label>
            <Select
              value={companyId || null}
              onValueChange={(v) => {
                setCompanyId(v ? String(v) : '');
                setMembers([]);
              }}
              items={companyItems}
            >
              <SelectTrigger aria-label={t('company')}>
                <SelectValue placeholder={t('companyPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {companyItems.map((i) => (
                  <SelectItem key={i.value} value={i.value} label={i.label}>
                    {i.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-muted-foreground text-xs">{t('companyHint')}</p>
          </div>
        )}
        {companyId ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label>{t('tills')}</Label>
              <span className="text-muted-foreground text-xs tabular-nums">
                {t('tillsCount', { count: members.length })}
              </span>
            </div>
            {tills.length > 8 ? (
              <div className="relative">
                <Search
                  className="text-muted-foreground pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2"
                  aria-hidden
                />
                <Input
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder={t('search')}
                  aria-label={t('search')}
                  className="ps-9 pe-2.5"
                />
              </div>
            ) : null}
            {tills.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('noTills')}</p>
            ) : (
              <div className="max-h-72 space-y-3 overflow-y-auto rounded-lg border p-2">
                {byShop.map(([shopId, list]) => (
                  <fieldset key={shopId || 'none'} className="space-y-1">
                    <legend className="text-muted-foreground text-xs font-medium">
                      {shopName.get(shopId) ?? t('noShop')}
                    </legend>
                    {list.map((m) => {
                      const number = registerNumberOf(m);
                      return (
                        <label key={m.id} className="flex cursor-pointer items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={members.includes(m.id)}
                            onChange={(e) => setMembers(toggleMember(members, m.id, e.target.checked))}
                          />
                          <span>{number !== null ? `${t('till', { number })} · ${m.name}` : m.name}</span>
                        </label>
                      );
                    })}
                  </fieldset>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="outline" onClick={onBack}>
          <ArrowRight className="ms-1 h-4 w-4" aria-hidden /> {t('back')}
        </Button>
        <Button
          disabled={!clean || !companyId || taken || unchanged || save.isPending}
          onClick={() => save.mutate()}
          title={!clean ? t('nameRequired') : undefined}
        >
          {save.isPending ? tc('saving') : tc('save')}
        </Button>
      </div>
    </>
  );
}
