'use client';

/** "הפוך קופה לקיוסק": pick a paired till, name it, who controls it, and lock the device. */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, MonitorSmartphone } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { EntityMultiSelect } from '@/components/dashboard/entity-multi-select';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { createKiosk, fetchKioskCandidates, type KioskSummary } from '@/lib/kioskApi';
import type { PosMachine, Shop } from '@/lib/types';
import { OptionSelect } from './fields';

/** Tills that may control a kiosk: the same company's, not itself, not a kiosk. */
export function controllerOptions(
  kioskShopId: string | null,
  kioskMachineId: string | null,
  shops: Shop[],
  machines: PosMachine[],
  kioskIds: Set<string>,
) {
  const companyId = shops.find((s) => s.id === kioskShopId)?.companyId ?? null;
  if (!companyId) return [];
  const shopById = new Map(shops.map((s) => [s.id, s]));
  return machines
    .filter((m) => m.shopId && shopById.get(m.shopId)?.companyId === companyId)
    .filter((m) => m.id !== kioskMachineId && !kioskIds.has(m.id) && m.isActive !== false)
    .map((m) => ({ id: m.id, label: m.name, hint: m.shopId ? shopById.get(m.shopId)?.name ?? null : null }));
}

export function ConvertDialog({
  open,
  onOpenChange,
  shopId,
  shops,
  machines,
  kiosks,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shopId: string | null;
  shops: Shop[];
  machines: PosMachine[];
  kiosks: KioskSummary[];
  onCreated: (k: KioskSummary) => void;
}) {
  const t = useTranslations('kiosks.convert');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [machineId, setMachineId] = useState('');
  const [name, setName] = useState('');
  const [controllers, setControllers] = useState<string[]>([]);
  const [lockDevice, setLockDevice] = useState(true);

  const candidates = useQuery({
    queryKey: ['kiosk-candidates', shopId],
    queryFn: () => fetchKioskCandidates(shopId),
    enabled: open,
  });
  const list = candidates.data ?? [];
  const candidate = list.find((c) => c.machineId === machineId) ?? null;
  const kioskIds = useMemo(() => new Set(kiosks.map((k) => k.machineId)), [kiosks]);
  const options = useMemo(
    () => (candidate ? controllerOptions(candidate.shopId, candidate.machineId, shops, machines, kioskIds) : []),
    [candidate, shops, machines, kioskIds],
  );

  const create = useMutation({
    mutationFn: () =>
      createKiosk({
        machineId,
        name: name.trim() || undefined,
        controllerMachineIds: controllers,
        lockDevice,
      }),
    onSuccess: (k) => {
      toast.success(t('created'));
      void qc.invalidateQueries({ queryKey: ['kiosks'] });
      void qc.invalidateQueries({ queryKey: ['kiosk-candidates'] });
      onOpenChange(false);
      onCreated(k);
    },
    onError: (err) => {
      const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
      toast.error(detail === 'already_kiosk' ? t('alreadyKiosk') : axiosErrorToToastMessage(err, tc('error')));
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MonitorSmartphone className="h-5 w-5" /> {t('title')}
          </DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <span className="text-sm font-medium">{t('till')}</span>
            {candidates.isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : list.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t('noCandidates')}</p>
            ) : (
              <OptionSelect
                value={machineId}
                placeholder={t('tillPlaceholder')}
                ariaLabel={t('till')}
                className="w-full"
                options={list.map((c) => ({
                  value: c.machineId,
                  label: [c.name, c.shopName, c.online ? t('online') : t('offline')].filter(Boolean).join(' · '),
                }))}
                onChange={(id) => {
                  setMachineId(id);
                  setControllers([]);
                  if (!name.trim()) setName(list.find((c) => c.machineId === id)?.name ?? '');
                }}
              />
            )}
          </div>

          <label className="block space-y-1.5">
            <span className="text-sm font-medium">{t('name')}</span>
            <Input value={name} placeholder={t('namePlaceholder')} maxLength={80} onChange={(e) => setName(e.target.value)} />
          </label>

          <div className="space-y-1">
            <EntityMultiSelect
              label={t('controllers')}
              options={options}
              selected={controllers}
              onChange={setControllers}
              allLabel={t('controllersNone')}
              clearLabel={t('controllersClear')}
              emptyLabel={candidate ? t('controllersEmpty') : t('pickTillFirst')}
              disabled={!candidate}
            />
            <p className="text-xs text-muted-foreground">{t('controllersHint')}</p>
          </div>

          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5 h-4 w-4" checked={lockDevice} onChange={(e) => setLockDevice(e.target.checked)} />
            <span>
              <span className="font-medium">{t('lockDevice')}</span>
              <span className="block text-xs text-muted-foreground">{t('lockDeviceHint')}</span>
            </span>
          </label>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tc('cancel')}
          </Button>
          <Button disabled={!machineId || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? <Loader2 className="animate-spin" /> : null}
            {t('submit')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
