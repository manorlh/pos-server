'use client';

/**
 * "תצורת עבודה — קופה ראשית" on a shop: one till the rest of the shop leans on. Unless
 * another till is named for a job, it is the tables host of the LAN mode (every table,
 * its number and its order live on it), the print server, and the master of the shop Z —
 * one Z for the shop, with a section per till and a row per waiter. And where the shop Z
 * may come from: the main till alone (the default), also the dashboard, or any till.
 *
 * The super admin's alone, like the Z mode (pos-server app/routers/main_till.py); the
 * shop's managers see it read-only. Refused while a Z run is under way.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Crown } from 'lucide-react';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { fetchMainTill, saveMainTill, type MainTillState } from '@/lib/mainTillApi';
import type { TillRef } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/** The server's `shopZFrom` options, in its order: main only / main + dashboard / any till. */
const Z_FROM_KEYS = ['main', 'mainAndDashboard', 'any'] as const;

export function MainTillCard({ shopId }: { shopId: string }) {
  const t = useTranslations('mainTill');
  const query = useQuery({ queryKey: ['main-till', shopId], queryFn: () => fetchMainTill(shopId) });
  const data = query.data;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Crown className="h-4 w-4" aria-hidden />
          {t('title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-xs text-muted-foreground">{t('desc')}</p>
        {query.isLoading || !data ? (
          <Skeleton className="h-28 w-full" />
        ) : (
          // Keyed by what was saved: a save (or another admin's) starts the form afresh.
          <MainTillForm key={`${data.mainTill?.machineId ?? ''}|${data.zFrom}`} shopId={shopId} data={data} />
        )}
      </CardContent>
    </Card>
  );
}

function MainTillForm({ shopId, data }: { shopId: string; data: MainTillState }) {
  const t = useTranslations('mainTill');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [machineId, setMachineId] = useState<string>(data.mainTill?.machineId ?? '');
  const [zFrom, setZFrom] = useState<string>(data.zFrom);

  const save = useMutation({
    mutationFn: () => saveMainTill(shopId, { machineId: machineId || null, zFrom }),
    onSuccess: (out) => {
      qc.setQueryData(['main-till', shopId], out);
      void qc.invalidateQueries({ queryKey: ['kitchen-printers', shopId] });
      toast.success(t('saved'));
    },
    onError: (err: unknown) => {
      const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
      toast.error(detail === 'z_run_in_progress' ? t('runInProgress') : axiosErrorToToastMessage(err, tc('error')));
    },
  });

  const tillLabel = (ref: TillRef | null | undefined) =>
    !ref ? '—' : ref.posNumber ? t('till', { n: ref.posNumber, name: ref.name ?? '' }) : (ref.name ?? '—');
  const zFromLabel = (value: string, options: string[]) => {
    const i = options.indexOf(value);
    return i >= 0 && i < Z_FROM_KEYS.length ? t(`zFrom.${Z_FROM_KEYS[i]}`) : value;
  };
  const dirty = machineId !== (data.mainTill?.machineId ?? '') || zFrom !== data.zFrom;

  return (
    <>
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <label htmlFor={`main-till-${shopId}`} className="text-sm font-medium">
          {t('mainTill')}
        </label>
        <select
          id={`main-till-${shopId}`}
          className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm disabled:opacity-70 sm:w-56"
          value={machineId}
          disabled={!data.canEdit || save.isPending}
          onChange={(e) => setMachineId(e.target.value)}
        >
          <option value="">{t('none')}</option>
          {data.tills.map((m) => (
            <option key={m.machineId} value={m.machineId}>
              {tillLabel(m)}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
        <label htmlFor={`z-from-${shopId}`} className="text-sm font-medium">
          {t('zFromLabel')}
        </label>
        <select
          id={`z-from-${shopId}`}
          className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm disabled:opacity-70 sm:w-56"
          value={zFrom}
          disabled={!data.canEdit || save.isPending}
          onChange={(e) => setZFrom(e.target.value)}
        >
          {data.zFromOptions.map((o) => (
            <option key={o} value={o}>
              {zFromLabel(o, data.zFromOptions)}
            </option>
          ))}
        </select>
      </div>

      <Roles data={data} tillLabel={tillLabel} />

      {data.canEdit ? (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => save.mutate()} disabled={!dirty || save.isPending}>
            {save.isPending ? t('saving') : t('save')}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-amber-700 dark:text-amber-400">{t('readOnly')}</p>
      )}
    </>
  );
}

/** What leans on the main till today, and what another till holds instead. */
function Roles({ data, tillLabel }: { data: MainTillState; tillLabel: (r: TillRef | null | undefined) => string }) {
  const t = useTranslations('mainTill.roles');
  const main = data.mainTill;
  if (!main) return <p className="text-xs text-muted-foreground">{t('noMain')}</p>;
  const isMain = (r: TillRef | null) => !!r && r.machineId === main.machineId;
  const lines: { ok: boolean; text: string }[] = [
    data.tablesLan
      ? isMain(data.tablesHost)
        ? { ok: true, text: t('tables') }
        : { ok: false, text: t('tablesOther', { till: tillLabel(data.tablesHost) }) }
      : { ok: false, text: t('tablesNotLan') },
    isMain(data.printHost)
      ? { ok: true, text: t('print') }
      : { ok: false, text: t('printOther', { till: tillLabel(data.printHost) }) },
    data.zScope === 'shop' ? { ok: true, text: t('z') } : { ok: false, text: t('zPerTill') },
  ];
  return (
    <ul className="space-y-1 rounded-md border bg-muted/30 p-3 text-xs">
      {lines.map((l) => (
        <li key={l.text} className={l.ok ? '' : 'text-amber-700 dark:text-amber-400'}>
          {l.ok ? '✓ ' : '• '}
          {l.text}
        </li>
      ))}
    </ul>
  );
}
