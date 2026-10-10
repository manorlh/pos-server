'use client';

/**
 * "מצב דו״ח Z" on a shop: who produces the Zs of its tills — the shop's Z, built in the
 * cloud ("Z בענן", `zMode = cloud`), or each till its own ("Z בקופה", `zMode = till`,
 * numbered per till from Z 1, docs/SHIFTS_API.md §5) — for the whole shop, and for each
 * of its points of sale. A till is also switched alone, on its own page.
 *
 * The super admin's alone, and only over a clean break: every till switched has its
 * shift closed and its closed shifts in a Z (pos-server app/services/z_mode_policy.py).
 * A shop or point of sale switches all or nothing; a refusal names the till that stopped
 * it. Accounting takes every Z, the shop's and the tills' own alike.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ReceiptText } from 'lucide-react';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { fetchShopZMode, saveShopZMode, type ShopZModeState, type ZModeTill } from '@/lib/zModeApi';
import type { ZMode } from '@/lib/types';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

type Summary = ZMode | 'mixed' | 'none';

function summaryOf(tills: ZModeTill[]): Summary {
  if (tills.length === 0) return 'none';
  const modes = new Set(tills.map((t) => t.zMode));
  return modes.size > 1 ? 'mixed' : (tills[0].zMode as ZMode);
}

interface Refusal {
  detail: string;
  machineId?: string;
  count?: number;
}

function refusalOf(err: unknown): Refusal | null {
  const data = (err as { response?: { status?: number; data?: unknown } } | null)?.response?.data as
    | Refusal
    | { detail?: unknown }
    | undefined;
  return data && typeof data.detail === 'string' ? (data as Refusal) : null;
}

export function ZScopeCard({ shopId }: { shopId: string }) {
  const t = useTranslations('zScope');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['shop-z-mode', shopId], queryFn: () => fetchShopZMode(shopId) });
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  const save = useMutation({
    mutationFn: ({ mode, areaId }: { mode: ZMode; areaId?: string }) => saveShopZMode(shopId, mode, areaId),
    onSuccess: (out) => {
      setRefusal(null);
      qc.setQueryData(['shop-z-mode', shopId], out);
      void qc.invalidateQueries({ queryKey: ['machines'] });
      void qc.invalidateQueries({ queryKey: ['z-candidates'] });
      void qc.invalidateQueries({ queryKey: ['z-participation', shopId] });
      toast.success(t('saved'));
    },
    onError: (err: unknown) => {
      const r = refusalOf(err);
      setRefusal(r);
      if (!r) toast.error(axiosErrorToToastMessage(err, tc('error')));
    },
  });

  const data = query.data;
  const tillName = (s: ShopZModeState, machineId?: string) => {
    const till = s.tills.find((x) => x.machineId === machineId);
    return till?.posNumber ? t('till', { n: till.posNumber }) : (till?.name ?? '');
  };
  const refusalText = (s: ShopZModeState, r: Refusal): string => {
    const till = tillName(s, r.machineId);
    if (r.detail === 'till_open') return t('refused.tillOpen', { till });
    if (r.detail === 'unreported_shifts') return t('refused.awaitingZ', { till, n: r.count ?? 1 });
    if (r.detail === 'z_in_progress') return t('refused.zInProgress', { till });
    if (r.detail === 'till_offline_zs_unsynced') return t('refused.offlineUnsynced', { till });
    if (r.detail === 'super_admin_only') return t('readOnly');
    return r.detail;
  };

  const picker = (id: string, summary: Summary, editable: boolean, areaId?: string) => (
    <select
      id={id}
      className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm disabled:opacity-70 sm:w-56"
      value={summary}
      disabled={!editable || save.isPending || summary === 'none'}
      onChange={(e) => {
        const v = e.target.value;
        if (v === 'cloud' || v === 'till') save.mutate({ mode: v, areaId });
      }}
    >
      {summary === 'mixed' ? <option value="mixed">{t('mixed')}</option> : null}
      {summary === 'none' ? <option value="none">{t('noTills')}</option> : null}
      <option value="cloud">{t('cloud')}</option>
      <option value="till">{t('till_mode')}</option>
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
        {query.isLoading || !data ? (
          <Skeleton className="h-20 w-full" />
        ) : (
          <>
            <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
              <label htmlFor={`zmode-shop-${shopId}`} className="text-sm font-medium">
                {t('shopLevel')}
              </label>
              {picker(`zmode-shop-${shopId}`, summaryOf(data.tills), data.canEdit)}
            </div>

            {data.areas.length > 0 ? (
              <div className="space-y-2 border-t pt-3">
                <p className="text-xs font-medium text-muted-foreground">{t('areasTitle')}</p>
                {data.areas.map((a) => {
                  const tills = data.tills.filter((x) => x.areaId === a.id);
                  return (
                    <div key={a.id} className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                      <label htmlFor={`zmode-area-${a.id}`} className="text-sm">
                        {a.name}
                        <span className="ms-2 text-xs text-muted-foreground">
                          {t('tillsCount', { n: tills.length })}
                        </span>
                      </label>
                      {picker(`zmode-area-${a.id}`, summaryOf(tills), data.canEdit, a.id)}
                    </div>
                  );
                })}
              </div>
            ) : null}

            {refusal ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
                {refusalText(data, refusal)}
              </div>
            ) : null}

            {!data.canEdit ? <p className="text-xs text-amber-700 dark:text-amber-400">{t('readOnly')}</p> : null}
            <p className="text-xs text-muted-foreground">{t('cleanBreak')}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
