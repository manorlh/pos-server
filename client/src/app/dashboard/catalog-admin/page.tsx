'use client';

/**
 * "ניהול קטלוג מהקופה" (pos-server specs/till-catalog-management.md §6): the till's catalog screen —
 * on or off, what it shows (`catalogAdminScope`), adding products, and without an open shift —
 * per company, shop, point of sale or till. Stored as till parameters, so super admin only, like
 * the parameters page (the server refuses everyone else, and so does the page).
 *
 * Under the levels: the points of sale with no catalog menu of their own. There is no product list
 * per point of sale — its "catalog" is the menu assigned to it — so their tills show the shop's
 * catalog, with a link to the menus page to set one.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { MapPin, RotateCcw } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { useAuth } from '@/lib/auth';
import { usePageScope } from '@/lib/scope';
import { fetchMenuTargets, type MenuTargets } from '@/lib/catalogMenusApi';
import {
  areasWithoutMenu,
  changedValues,
  levelOptions,
  ownKeys,
  parseLevelValue,
  shopOfLevel,
  toText,
  type CatalogAdminLevel,
} from '@/lib/catalogAdmin';
import {
  fetchCatalogAdminLevel,
  resetTillParameters,
  saveCatalogAdminLevel,
  type CatalogAdminLevelView,
  type CatalogAdminParam,
} from '@/lib/catalogAdminApi';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { TARGETS_KEY, useCatalogMenus } from '@/components/dashboard/catalog-menus/shared';

const SELECT =
  'border-input bg-background h-9 w-full rounded-md border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60';

export default function CatalogAdminPage() {
  const t = useTranslations('catalogAdmin');
  const authHydrated = useAuth((s) => s.authHydrated);
  const role = useAuth((s) => s.user?.role);

  if (!authHydrated) return <Skeleton className="h-40 w-full" />;
  if (role !== 'super_admin') {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">{t('noPermission')}</CardContent>
        </Card>
      </div>
    );
  }
  return <CatalogAdmin />;
}

function CatalogAdmin() {
  const t = useTranslations('catalogAdmin');
  const { effective } = usePageScope({ maxLevel: 'shop' });
  const params = { companyId: effective.companyId ?? null, shopId: effective.shopId ?? null };
  const targets = useQuery<MenuTargets>({
    queryKey: [...TARGETS_KEY, params],
    queryFn: () => fetchMenuTargets(params),
  });
  const menus = useCatalogMenus();
  const options = useMemo(
    () => levelOptions(targets.data?.targets ?? [], (n) => t('till', { number: n })),
    [targets.data, t],
  );
  const [picked, setPicked] = useState<string | null>(null);
  const fallback =
    (effective.shopId && options.find((o) => o.level === 'shop' && o.id === effective.shopId)) ||
    (effective.companyId && options.find((o) => o.level === 'company' && o.id === effective.companyId)) ||
    options[0];
  const value = picked && options.some((o) => o.value === picked) ? picked : (fallback?.value ?? null);
  const level = value ? parseLevelValue(value) : null;

  const activeMenuIds = useMemo(
    () => (menus.data ? new Set(menus.data.menus.filter((m) => m.isActive).map((m) => m.id)) : null),
    [menus.data],
  );
  const shopId = level && targets.data ? shopOfLevel(targets.data.targets, level.level, level.id) : null;
  const bare = targets.data
    ? areasWithoutMenu(targets.data.targets, targets.data.assignments, shopId, activeMenuIds)
    : [];
  const shopName = (id: string | null) => targets.data?.targets.find((x) => x.level === 'shop' && x.id === id)?.name;

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {targets.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : targets.isError || !level ? (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            {targets.isError ? t('loadError') : t('empty')}
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <label className="space-y-1 text-sm">
              <span className="block text-xs text-muted-foreground">{t('level')}</span>
              <select className={`${SELECT} min-w-[18rem]`} value={value ?? ''} onChange={(e) => setPicked(e.target.value)}>
                {options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {' '.repeat(o.depth * 3)}
                    {t(`levels.${o.level}`)}: {o.name}
                  </option>
                ))}
              </select>
            </label>
            <p className="max-w-xl text-xs text-muted-foreground">{t('levelHint')}</p>
          </div>

          <LevelCard key={value} level={level.level} id={level.id} />

          <section className="space-y-2">
            <h2 className="text-sm font-semibold">{t('areas.title')}</h2>
            {bare.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t('areas.allHaveMenus')}</p>
            ) : (
              <ul className="divide-y rounded-lg border bg-card">
                {bare.map((a) => (
                  <li key={a.id} className="flex flex-wrap items-center gap-2 p-3 text-sm">
                    <MapPin className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="font-medium">{a.name}</span>
                    {!shopId && shopName(a.parentId) ? (
                      <span className="text-xs text-muted-foreground">({shopName(a.parentId)})</span>
                    ) : null}
                    <span className="text-muted-foreground">
                      {t('areas.noMenu')} ·{' '}
                      <Link href="/dashboard/menus" className="text-primary underline">
                        {t('areas.setMenu')}
                      </Link>
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function LevelCard({ level, id }: { level: CatalogAdminLevel; id: string }) {
  const t = useTranslations('catalogAdmin');
  const qc = useQueryClient();
  const key = ['catalog-admin-level', level, id];
  const view = useQuery<CatalogAdminLevelView>({ queryKey: key, queryFn: () => fetchCatalogAdminLevel(level, id) });
  const [edits, setEdits] = useState<Record<string, string>>({});

  const save = useMutation({
    mutationFn: () => {
      const data = view.data!;
      const types = Object.fromEntries(data.parameters.map((p) => [p.key, p.valueType]));
      return saveCatalogAdminLevel(level, id, changedValues(data.own, edits, types));
    },
    onSuccess: (data) => {
      qc.setQueryData(key, data);
      setEdits({});
      toast.success(t('saved'));
    },
    onError: (e: unknown) => toast.error(axiosErrorToToastMessage(e, t('saveFailed'))),
  });
  const reset = useMutation({
    mutationFn: (keys: string[]) => resetTillParameters(level, id, keys),
    onSuccess: () => {
      setEdits({});
      qc.invalidateQueries({ queryKey: ['catalog-admin-level'] });
      toast.success(t('resetDone'));
    },
    onError: (e: unknown) => toast.error(axiosErrorToToastMessage(e, t('saveFailed'))),
  });

  if (view.isLoading) return <Skeleton className="h-64 w-full" />;
  if (!view.data) return <p className="text-sm text-destructive">{t('loadError')}</p>;
  const data = view.data;
  const own = ownKeys(data.own);
  const shown = (k: string) => (k in edits ? edits[k] : toText(data.own[k]));
  const optionLabel = (p: CatalogAdminParam, v: string) => {
    const path = `options.${p.key}.${v}`;
    return t.has(path) ? t(path) : v;
  };
  const describe = (p: CatalogAdminParam, v: unknown) =>
    v === undefined || v === null ? '—' : p.valueType === 'boolean' ? (v ? t('on') : t('off')) : optionLabel(p, String(v));
  const dirty = Object.keys(changedValues(data.own, edits, {})).length > 0;

  return (
    <div className="space-y-2">
      <div className="divide-y rounded-lg border bg-card">
        {data.parameters.map((p) => {
          const inherited = data.inherited[p.key] ?? p.defaultValue;
          const hintPath = `hints.${p.key}`;
          return (
            <div key={p.key} className="flex flex-wrap items-start gap-3 p-3">
              <div className="min-w-[16rem] flex-1 space-y-0.5">
                <div className="text-sm font-medium">{p.label}</div>
                <div className="text-xs text-muted-foreground">{t.has(hintPath) ? t(hintPath) : p.description}</div>
                <div className="text-xs text-muted-foreground">{t('inherited', { value: describe(p, inherited) })}</div>
              </div>
              <div className="w-60">
                <select
                  className={SELECT}
                  aria-label={p.label}
                  value={shown(p.key)}
                  onChange={(e) => setEdits((m) => ({ ...m, [p.key]: e.target.value }))}
                >
                  <option value="">{t('inherit')}</option>
                  {p.valueType === 'boolean' ? (
                    <>
                      <option value="true">{t('on')}</option>
                      <option value="false">{t('off')}</option>
                    </>
                  ) : (
                    (p.enumOptions ?? []).map((o) => (
                      <option key={o} value={o}>
                        {optionLabel(p, o)}
                      </option>
                    ))
                  )}
                </select>
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={own.length === 0 || reset.isPending}
          title={own.length === 0 ? t('resetNothing') : undefined}
          onClick={() => {
            if (window.confirm(t('resetConfirm'))) reset.mutate(own);
          }}
        >
          <RotateCcw className="h-4 w-4 ms-1" aria-hidden /> {t('reset')}
        </Button>
        {dirty ? (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setEdits({})}>
              {t('revert')}
            </Button>
            <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>
              {save.isPending ? t('saving') : t('save')}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
