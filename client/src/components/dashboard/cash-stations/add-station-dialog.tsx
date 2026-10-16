'use client';

/**
 * "הוספת עמדה" (P:/specs/cash-paylink.md §12): a cash station is one PayLink unit — its shop, name, where it
 * stands, its USB serial ('' = the unit's default, AE000001) and the cash server that runs it (a `cash_host`
 * device of that shop, or a "קיוסק מארח" — a Windows kiosk with the PayLink on USB, §14.1; none yet = chosen later).
 * `POST /cash-stations`.
 */

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { createCashStation } from '@/lib/cashStationsApi';
import { runsStations } from '@/lib/cashStations';
import type { PosMachine, Shop } from '@/lib/types';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ConfirmDialog, NativeSelect } from './parts';

export function AddStationDialog({
  open,
  onOpenChange,
  shops,
  machines,
  defaultShopId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shops: Shop[];
  machines: PosMachine[];
  defaultShopId: string | null;
}) {
  const t = useTranslations('cashStations.add');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const router = useRouter();
  const [shopId, setShopId] = useState(defaultShopId ?? '');
  const [name, setName] = useState('');
  const [location, setLocation] = useState('');
  const [serial, setSerial] = useState('');
  const [hostId, setHostId] = useState('');

  const hosts = useMemo(
    () => machines.filter((m) => runsStations(m) && !!shopId && String(m.shopId ?? '').toLowerCase() === shopId.toLowerCase()),
    [machines, shopId],
  );

  const create = useMutation({
    mutationFn: () =>
      createCashStation({
        shopId,
        name: name.trim(),
        location: location.trim() || null,
        serial: serial.trim(),
        hostMachineId: hostId || null,
      }),
    onSuccess: (station) => {
      void qc.invalidateQueries({ queryKey: ['cash-stations'] });
      toast.success(t('created'));
      onOpenChange(false);
      router.push(`/dashboard/cash-stations/${station.stationId}`);
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const ready = !!shopId && !!name.trim();

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('title')}
      description={t('description')}
      confirmLabel={t('submit')}
      onConfirm={() => create.mutate()}
      pending={create.isPending}
      disabled={!ready}
    >
      <div className="space-y-1.5">
        <Label htmlFor="cash-station-shop">{t('shop')}</Label>
        <NativeSelect
          id="cash-station-shop"
          value={shopId}
          onChange={(v) => {
            setShopId(v);
            setHostId('');
          }}
          options={[{ value: '', label: t('chooseShop') }, ...shops.map((s) => ({ value: s.id, label: s.name }))]}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="cash-station-name">{t('name')}</Label>
          <Input id="cash-station-name" value={name} maxLength={100} placeholder={t('namePlaceholder')} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="cash-station-location">{t('location')}</Label>
          <Input
            id="cash-station-location"
            value={location}
            maxLength={100}
            placeholder={t('locationPlaceholder')}
            onChange={(e) => setLocation(e.target.value)}
          />
        </div>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="cash-station-serial">{t('serial')}</Label>
        <Input
          id="cash-station-serial"
          dir="ltr"
          value={serial}
          maxLength={32}
          placeholder="AE000001"
          onChange={(e) => setSerial(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">{t('serialHint')}</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="cash-station-host">{t('host')}</Label>
        <NativeSelect
          id="cash-station-host"
          value={hostId}
          onChange={setHostId}
          disabled={!shopId}
          options={[{ value: '', label: t('noHost') }, ...hosts.map((m) => ({ value: m.id, label: m.cashHostEmbedded ? t('embeddedHost', { name: m.name }) : m.name }))]}
        />
        <p className="text-xs text-muted-foreground">{shopId && hosts.length === 0 ? t('noHostsInShop') : t('hostHint')}</p>
      </div>
    </ConfirmDialog>
  );
}
