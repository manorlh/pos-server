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
 *
 * Under it, "רשת מקומית" (pos-server docs/SPEC_LAN_MODE.md §4): the shop's switch (it needs a
 * main till, and moves the shop Z production only when the handover is clean), a row per
 * system with what works on the LAN through the main till today, and "סנכרון רשת מקומית" —
 * what the local server holds that the cloud copy lacks, an alert past a minute online.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Crown } from 'lucide-react';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { fetchMainTill, saveMainTill, type MainTillState } from '@/lib/mainTillApi';
import {
  ageText,
  healthRows,
  healthTone,
  localNetworkBlock,
  localNetworkView,
  syncTone,
  type Tone,
} from '@/lib/lanMode';
import { saveLocalNetwork } from '@/lib/lanServerApi';
import { producerBusyOf, refusalOf, type ProducerBusy } from '@/lib/zParticipation';
import { shopZProducerKey, zParticipationKey } from '@/lib/zParticipationApi';
import { ShopZForceDialog } from '@/components/dashboard/shop-z-force-dialog';
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
  const tIndependent = useTranslations('independentTill');
  const qc = useQueryClient();
  const [machineId, setMachineId] = useState<string>(data.mainTill?.machineId ?? '');
  const [zFrom, setZFrom] = useState<string>(data.zFrom);
  // 409 `shop_z_producer_busy`: the shop Z's producer has not handed over; a super admin may force it.
  const [busy, setBusy] = useState<ProducerBusy | null>(null);
  const [confirmForce, setConfirmForce] = useState(false);

  const save = useMutation({
    mutationFn: (force: boolean) =>
      saveMainTill(shopId, { machineId: machineId || null, zFrom, ...(force ? { forceProducerSwitch: true } : {}) }),
    onSuccess: (out) => {
      setBusy(null);
      setConfirmForce(false);
      qc.setQueryData(['main-till', shopId], out);
      void qc.invalidateQueries({ queryKey: shopZProducerKey(shopId) });
      void qc.invalidateQueries({ queryKey: ['kitchen-printers', shopId] });
      void qc.invalidateQueries({ queryKey: zParticipationKey(shopId) });
      void qc.invalidateQueries({ queryKey: ['local-shop-z-request', shopId] });
      toast.success(t('saved'));
    },
    onError: (err: unknown) => {
      const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
      // 409 {detail: {code, message}} (e.g. `main_till_independent`): the server's Hebrew text.
      const refusal = refusalOf(err);
      const producerBusy = producerBusyOf(err);
      setBusy(producerBusy);
      setConfirmForce(false);
      // A switch the producer holds up: said on the card, with the super admin's way past it.
      if (producerBusy) return;
      toast.error(
        detail === 'z_run_in_progress'
          ? t('runInProgress')
          : refusal?.message ??
              (refusal?.code === 'main_till_independent'
                ? tIndependent('errors.main_till_independent')
                : axiosErrorToToastMessage(err, tc('error'))),
      );
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

      <LocalNetwork shopId={shopId} data={data} tillLabel={tillLabel} />

      {busy ? (
        <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <p>{busy.message ?? tIndependent('errors.shop_z_producer_busy')}</p>
          {busy.canForce ? (
            <Button
              size="sm"
              variant="outline"
              className="border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={save.isPending}
              onClick={() => setConfirmForce(true)}
            >
              {tIndependent('producer.forceAnyway')}
            </Button>
          ) : null}
        </div>
      ) : null}
      <ShopZForceDialog
        open={confirmForce}
        pending={save.isPending}
        onConfirm={() => save.mutate(true)}
        onCancel={() => setConfirmForce(false)}
      />

      {data.canEdit ? (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => save.mutate(false)} disabled={!dirty || save.isPending}>
            {save.isPending ? t('saving') : t('save')}
          </Button>
        </div>
      ) : (
        <p className="text-xs text-amber-700 dark:text-amber-400">{t('readOnly')}</p>
      )}
    </>
  );
}

const TONE_CLASS: Record<Tone, string> = {
  ok: 'text-emerald-700 dark:text-emerald-400',
  warn: 'text-amber-700 dark:text-amber-400',
  bad: 'text-destructive',
  muted: 'text-muted-foreground',
};

/** "רשת מקומית": the switch, a row per system, and the local server's sync with the cloud. */
function LocalNetwork({
  shopId,
  data,
  tillLabel,
}: {
  shopId: string;
  data: MainTillState;
  tillLabel: (r: TillRef | null | undefined) => string;
}) {
  const t = useTranslations('mainTill.localNetwork');
  const tc = useTranslations('common');
  const tIndependent = useTranslations('independentTill');
  const qc = useQueryClient();
  const [busy, setBusy] = useState<ProducerBusy | null>(null);
  const [confirmForce, setConfirmForce] = useState(false);
  const state = { localNetwork: !!data.localNetwork, localMode: !!data.localMode, mainTill: data.mainTill };
  const view = localNetworkView(state);
  const block = localNetworkBlock(state);
  const toggle = useMutation({
    mutationFn: (force: boolean) =>
      saveLocalNetwork(shopId, { enabled: !state.localNetwork, ...(force ? { forceProducerSwitch: true } : {}) }),
    onSuccess: (out) => {
      setBusy(null);
      setConfirmForce(false);
      qc.setQueryData(['main-till', shopId], out);
      void qc.invalidateQueries({ queryKey: shopZProducerKey(shopId) });
      void qc.invalidateQueries({ queryKey: zParticipationKey(shopId) });
      void qc.invalidateQueries({ queryKey: ['local-shop-z-request', shopId] });
      toast.success(t('saved'));
    },
    onError: (err: unknown) => {
      const producerBusy = producerBusyOf(err);
      setBusy(producerBusy);
      setConfirmForce(false);
      if (producerBusy) return;
      toast.error(refusalOf(err)?.message ?? axiosErrorToToastMessage(err, tc('error')));
    },
  });
  const sync = data.lanSync ?? null;
  const age = ageText(sync?.oldestAgeSeconds);
  const ageLabel = age ? t(`sync.${age.key}`, age.values) : '';
  return (
    <div className="space-y-3 rounded-md border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="space-y-0.5">
          <p className="text-sm font-medium">{t('title')}</p>
          <p className={`text-xs ${view === 'on' ? TONE_CLASS.ok : view === 'inactive' ? TONE_CLASS.warn : TONE_CLASS.muted}`}>
            {t(view)}
          </p>
        </div>
        {data.canEdit ? (
          <Button
            size="sm"
            variant={state.localNetwork ? 'outline' : 'default'}
            disabled={toggle.isPending || !!block}
            onClick={() => toggle.mutate(false)}
          >
            {toggle.isPending ? t('switching') : state.localNetwork ? t('turnOff') : t('turnOn')}
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">{t('desc')}</p>
      {block ? <p className="text-xs text-amber-700 dark:text-amber-400">{t('needsMainTill')}</p> : null}
      {data.canEdit ? <p className="text-xs text-muted-foreground">{t('zNote')}</p> : null}
      {busy ? (
        <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          <p>{busy.message ?? tIndependent('errors.shop_z_producer_busy')}</p>
          {busy.canForce ? (
            <Button
              size="sm"
              variant="outline"
              className="border-destructive text-destructive hover:bg-destructive/10 hover:text-destructive"
              disabled={toggle.isPending}
              onClick={() => setConfirmForce(true)}
            >
              {tIndependent('producer.forceAnyway')}
            </Button>
          ) : null}
        </div>
      ) : null}
      <ShopZForceDialog
        open={confirmForce}
        pending={toggle.isPending}
        onConfirm={() => toggle.mutate(true)}
        onCancel={() => setConfirmForce(false)}
      />
      <ul className="space-y-1 rounded-md bg-muted/30 p-2 text-xs">
        {healthRows(data.lanHealth).map((row) => (
          <li key={row.system} className="flex flex-wrap justify-between gap-2">
            <span className="font-medium">{t(`systems.${row.system}`)}</span>
            <span className={TONE_CLASS[healthTone(row.state)]}>
              {t(`states.${row.state}`, { till: tillLabel(row.host) })}
            </span>
          </li>
        ))}
        {/* "סנכרון רשת מקומית": the owner's rule — the cloud copy follows the server in real time. */}
        <li className="flex flex-wrap justify-between gap-2 border-t pt-1">
          <span className="font-medium">{t('sync.title')}</span>
          <span className={TONE_CLASS[syncTone(sync)]}>
            {t(`sync.${sync?.state ?? 'unknown'}`, {
              n: String(sync?.pending ?? 0),
              age: ageLabel,
              till: tillLabel(sync?.host),
            })}
          </span>
        </li>
        {sync?.alert ? <li className="font-medium text-destructive">{t('sync.alert')}</li> : null}
      </ul>
    </div>
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
