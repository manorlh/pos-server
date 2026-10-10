'use client';

/**
 * "לא משמש כשרת מקומי" on the machine page (pos-server docs/SPEC_LAN_MODE.md §3,
 * `GET/PUT /machines/{id}/lan-server`): the device is never the shop's main till, tables host or
 * print server, and starts no LAN host of its own — yet stays in the shop Z and on the LAN, and
 * its own printers still print for everyone. A till showing a KDS screen is so by itself; a kiosk
 * or a handheld is suggested. The super admin's alone; refused for the shop's main till. The
 * rules are in lib/lanMode.ts.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Network } from 'lucide-react';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { machineSuggests, machineSwitchBlock } from '@/lib/lanMode';
import { fetchMachineLanServer, machineLanServerKey, saveMachineLanServer } from '@/lib/lanServerApi';
import { producerBusyOf, refusalOf, type ProducerBusy } from '@/lib/zParticipation';
import { ShopZForceDialog } from '@/components/dashboard/shop-z-force-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

export function MachineLanServerCard({ machineId, shopId }: { machineId: string; shopId: string | null | undefined }) {
  const t = useTranslations('machineLanServer');
  const tc = useTranslations('common');
  const tIndependent = useTranslations('independentTill');
  const qc = useQueryClient();
  const query = useQuery({ queryKey: machineLanServerKey(machineId), queryFn: () => fetchMachineLanServer(machineId), enabled: !!shopId });
  const [busy, setBusy] = useState<ProducerBusy | null>(null);
  const [confirmForce, setConfirmForce] = useState(false);
  const data = query.data;
  const save = useMutation({
    mutationFn: (force: boolean) =>
      saveMachineLanServer(machineId, { excluded: !data?.lanServerExcluded, ...(force ? { forceProducerSwitch: true } : {}) }),
    onSuccess: (out) => {
      setBusy(null);
      setConfirmForce(false);
      qc.setQueryData(machineLanServerKey(machineId), out);
      if (shopId) {
        void qc.invalidateQueries({ queryKey: ['main-till', shopId] });
        void qc.invalidateQueries({ queryKey: ['z-participation', shopId] });
      }
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
  if (!shopId) return null;
  const block = data ? machineSwitchBlock(data) : null;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Network className="h-4 w-4" aria-hidden />
          {t('title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {query.isLoading || !data ? (
          <Skeleton className="h-16 w-full" />
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label htmlFor={`lan-server-${machineId}`} className="flex items-center gap-2 text-sm font-medium">
                <input
                  id={`lan-server-${machineId}`}
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={data.lanServerExcluded}
                  disabled={!!block || save.isPending}
                  onChange={() => save.mutate(false)}
                />
                {t('label')}
              </label>
              <span className="text-xs text-muted-foreground">{data.lanServerExcluded ? t('on') : t('off')}</span>
            </div>
            <p className="text-xs text-muted-foreground">{t('desc')}</p>
            <p className="text-xs text-muted-foreground">{t('printers')}</p>
            {machineSuggests(data) ? <p className="text-xs text-amber-700 dark:text-amber-400">{t('suggested')}</p> : null}
            {block ? <p className="text-xs text-muted-foreground">{t(`blocked.${block}`)}</p> : null}
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
          </>
        )}
      </CardContent>
    </Card>
  );
}
