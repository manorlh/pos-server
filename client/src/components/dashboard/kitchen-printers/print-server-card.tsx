'use client';

/**
 * "שרת הדפסות" — optional, off by default: one till of the shop takes every till's
 * tickets for the network / Bluetooth printers over the shop's LAN and prints them one
 * after the other. Picked here by till (it is the till parameter `printHostTill`, set at
 * that till's level); shows where the till last said it listens.
 */

import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { savePrintHost, type KitchenPrintersPage } from '@/lib/kitchenPrintersApi';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { SimpleSelect } from './printer-dialog';

const NONE = 'none';

export function PrintServerCard({ page }: { page: KitchenPrintersPage }) {
  const t = useTranslations('kitchenPrinters.printServer');
  const tc = useTranslations('common');
  const qc = useQueryClient();

  const save = useMutation({
    mutationFn: (machineId: string | null) => savePrintHost(page.shopId, machineId),
    onSuccess: (printHost) => {
      qc.setQueryData<KitchenPrintersPage>(['kitchen-printers', page.shopId], (old) =>
        old ? { ...old, printHost } : old,
      );
      toast.success(t('saved'));
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const host = page.printHost;
  const options = [
    { value: NONE, label: t('none') },
    ...page.machines.map((m) => ({ value: m.id, label: t('till', { name: m.name }) })),
  ];

  return (
    <section className="space-y-2 rounded-lg border p-4">
      <div>
        <h2 className="text-lg font-semibold">{t('title')}</h2>
        <p className="text-sm text-muted-foreground">{t('hint')}</p>
      </div>
      <div className="max-w-sm">
        <SimpleSelect
          value={host?.machineId ?? NONE}
          disabled={!page.canEdit || save.isPending}
          options={options}
          ariaLabel={t('title')}
          onChange={(v) => save.mutate(v === NONE ? null : v)}
        />
      </div>
      {host && (
        <p className="text-sm text-muted-foreground" dir="auto">
          {host.lanAddress ? t('where', { address: `${host.lanAddress}:${host.port}` }) : t('notReported')}
        </p>
      )}
    </section>
  );
}
