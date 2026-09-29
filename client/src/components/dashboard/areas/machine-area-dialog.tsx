'use client';

/**
 * Move one till into an area of its own shop, or out of any area.
 *
 * Only the till's shop's live areas are offered — the server refuses any other
 * (`area_not_in_machine_shop`, `area_archived`). "No area" sends an explicit `null`,
 * which is what clears it; leaving `areaId` out would leave it unchanged.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { setMachineArea } from '@/lib/api';
import type { PosMachine } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { useAreaErrorText } from './area-errors';
import { useShopAreas } from './use-shop-areas';

const NO_AREA = '__none__';

export function MachineAreaDialog({
  machine,
  open,
  onOpenChange,
}: {
  machine: PosMachine | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {open && machine ? (
          <MachineAreaForm key={machine.id} machine={machine} onOpenChange={onOpenChange} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function MachineAreaForm({
  machine,
  onOpenChange,
}: {
  machine: PosMachine;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('areas');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const errors = useAreaErrorText();
  const [value, setValue] = useState<string>(machine.areaId ?? NO_AREA);
  const { data: areas = [], isLoading, isError, error } = useShopAreas(machine.shopId, false);

  const save = useMutation({
    mutationFn: () => setMachineArea(machine.id, value === NO_AREA ? null : value),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['machines'] });
      qc.invalidateQueries({ queryKey: ['machine', machine.id] });
      qc.invalidateQueries({ queryKey: ['shop-areas', machine.shopId ?? null] });
      toast.success(t('machineAreaSaved'));
      onOpenChange(false);
    },
    onError: (err) => toast.error(errors.forError(err)),
  });

  const items = [
    { value: NO_AREA, label: t('noArea') },
    ...areas.map((a) => ({ value: a.id, label: a.name })),
  ];

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('machineAreaTitle')}</DialogTitle>
      </DialogHeader>
      <div className="space-y-3">
        <p className="text-muted-foreground text-sm">{t('machineAreaHint')}</p>
        {!machine.shopId ? (
          <p className="text-sm">{t('machineNoShop')}</p>
        ) : isLoading ? (
          <Skeleton className="h-8 w-full" />
        ) : isError ? (
          <p className="text-destructive text-sm">{errors.forError(error)}</p>
        ) : (
          <div className="space-y-1">
            <Label>{t('area')}</Label>
            <Select value={value} onValueChange={(v) => setValue(v ? String(v) : NO_AREA)} items={items}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {items.map((i) => (
                  <SelectItem key={i.value} value={i.value} label={i.label}>
                    {i.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {areas.length === 0 ? (
              <p className="text-muted-foreground text-xs">{t('machineAreaNoAreas')}</p>
            ) : null}
          </div>
        )}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          {tc('cancel')}
        </Button>
        <Button
          disabled={!machine.shopId || save.isPending || value === (machine.areaId ?? NO_AREA)}
          onClick={() => save.mutate()}
        >
          {save.isPending ? tc('saving') : tc('save')}
        </Button>
      </DialogFooter>
    </>
  );
}
