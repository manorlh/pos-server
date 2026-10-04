'use client';

/**
 * "מצב דו״ח Z" on a shop: "Z סניפי" (one Z for the shop's tills) or "Z לכל קופה" (each till
 * its own Z — the till no longer works by shifts: its close is its Z, numbered from Z 1 by
 * its own counter). Set on the shop, and on any of its points of sale over it; unset
 * follows the layer above (the point of sale its shop, the shop the organization).
 *
 * The super admin's alone, and only over a clean break: the server refuses a change
 * (409 `z_scope_tills_open`) while a till it applies to has an open shift or closed
 * shifts no Z has taken, and this card lists those tills. Accounting takes every Z,
 * shop Zs and tills' own alike.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { ReceiptText } from 'lucide-react';
import { toast } from 'sonner';
import {
  fetchAreaSettings,
  fetchShopAreas,
  fetchShopSettings,
  fetchTenantSettings,
  patchAreaSettings,
  patchShopSettings,
} from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { useAuth } from '@/lib/auth';
import type { PosSettingsPatch } from '@/lib/types';
import { useIsSuperAdmin } from '@/components/dashboard/license-fields';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

type Scope = 'shop' | 'machine';
type Choice = Scope | 'inherit';

interface BlockingTill {
  machineId: string;
  posNumber?: string | null;
  name?: string | null;
  openShift: boolean;
  awaitingZ: number;
}

function scopeOf(settings: unknown): Scope | undefined {
  const raw = (settings as { zScope?: unknown } | null | undefined)?.zScope;
  return raw === 'shop' || raw === 'machine' ? raw : undefined;
}

function blockingTills(err: unknown): BlockingTill[] | null {
  const detail = (err as { response?: { status?: number; data?: { detail?: unknown } } } | null)?.response;
  const d = detail?.data?.detail as { code?: string; tills?: BlockingTill[] } | undefined;
  return detail?.status === 409 && d?.code === 'z_scope_tills_open' ? (d.tills ?? []) : null;
}

export function ZScopeCard({ shopId }: { shopId: string }) {
  const t = useTranslations('zScope');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const isSuperAdmin = useIsSuperAdmin();
  const tenantId = useAuth((s) => s.activeTenantId);
  const [blocking, setBlocking] = useState<BlockingTill[] | null>(null);

  const shopQuery = useQuery({
    queryKey: ['shop-settings', shopId, 'z-scope'],
    queryFn: () => fetchShopSettings(shopId, false),
  });
  // The organization's default, which an unset shop follows. Only a super admin reads it
  // (the tenant settings are the tenant admins'); anyone else sees "as the organization".
  const tenantQuery = useQuery({
    queryKey: ['tenant-settings', tenantId, 'z-scope'],
    queryFn: () => fetchTenantSettings(tenantId!),
    enabled: isSuperAdmin && !!tenantId,
  });
  const areasQuery = useQuery({
    queryKey: ['shop-areas', shopId],
    queryFn: () => fetchShopAreas(shopId),
  });
  const areas = areasQuery.data ?? [];
  const areaSettings = useQueries({
    queries: areas.map((a) => ({
      queryKey: ['area-settings', a.id, 'z-scope'],
      queryFn: () => fetchAreaSettings(a.id, false),
    })),
  });

  const orgScope: Scope = scopeOf(tenantQuery.data?.settings) ?? 'shop';
  const shopOwn = scopeOf(shopQuery.data?.settings);
  const shopEffective: Scope = shopOwn ?? orgScope;

  const save = useMutation({
    mutationFn: async ({ level, id, choice }: { level: 'shop' | 'area'; id: string; choice: Choice }) => {
      const patch = { zScope: choice === 'inherit' ? null : choice } as unknown as PosSettingsPatch;
      return level === 'shop' ? patchShopSettings(id, patch) : patchAreaSettings(id, patch);
    },
    onSuccess: () => {
      setBlocking(null);
      void qc.invalidateQueries({ queryKey: ['shop-settings', shopId] });
      void qc.invalidateQueries({ queryKey: ['area-settings'] });
      toast.success(t('saved'));
    },
    onError: (err: unknown) => {
      const tills = blockingTills(err);
      if (tills) {
        setBlocking(tills);
        toast.error(t('tillsOpen'));
      } else {
        toast.error(axiosErrorToToastMessage(err, tc('error')));
      }
    },
  });

  const label = (s: Scope) => (s === 'machine' ? t('machine') : t('shop'));

  const picker = (
    level: 'shop' | 'area',
    id: string,
    own: Scope | undefined,
    inheritedLabel: string,
  ) => (
    <select
      id={`${level}-${id}`}
      className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm disabled:opacity-70 sm:w-56"
      value={own ?? 'inherit'}
      disabled={!isSuperAdmin || save.isPending}
      onChange={(e) =>
        save.mutate({ level, id, choice: e.target.value as Choice })
      }
    >
      <option value="inherit">{inheritedLabel}</option>
      <option value="shop">{t('shop')}</option>
      <option value="machine">{t('machine')}</option>
    </select>
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <ReceiptText className="h-4 w-4" aria-hidden />
          {t('title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">{t('desc')}</p>

        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <label htmlFor={`shop-${shopId}`} className="text-sm font-medium">
            {t('shopLevel')}
          </label>
          {picker('shop', shopId, shopOwn, t('inheritOrg', { mode: label(orgScope) }))}
        </div>

        {areas.length > 0 ? (
          <div className="space-y-2 border-t pt-3">
            <p className="text-xs font-medium text-muted-foreground">{t('areasTitle')}</p>
            {areas.map((a, i) => {
              const own = scopeOf(areaSettings[i]?.data?.settings);
              return (
                <div
                  key={a.id}
                  className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between"
                >
                  <label htmlFor={`area-${a.id}`} className="text-sm">
                    {a.name}
                    <span className="ms-2 text-xs text-muted-foreground">
                      {t('effective', { mode: label(own ?? shopEffective) })}
                    </span>
                  </label>
                  {picker('area', a.id, own, t('inheritShop', { mode: label(shopEffective) }))}
                </div>
              );
            })}
          </div>
        ) : null}

        {blocking && blocking.length > 0 ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
            <p className="font-medium text-destructive">{t('tillsOpen')}</p>
            <ul className="mt-1 list-disc space-y-0.5 ps-5 text-xs">
              {blocking.map((b) => (
                <li key={b.machineId}>
                  {b.posNumber ? t('till', { n: b.posNumber }) : (b.name ?? '')}
                  {' — '}
                  {b.openShift ? t('openShift') : t('awaitingZ', { n: b.awaitingZ })}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {!isSuperAdmin ? <p className="text-xs text-amber-700 dark:text-amber-400">{t('readOnly')}</p> : null}
        <p className="text-xs text-muted-foreground">{t('cleanBreak')}</p>
      </CardContent>
    </Card>
  );
}
