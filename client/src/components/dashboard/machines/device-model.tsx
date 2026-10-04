'use client';

/**
 * Which hardware a till is: a Nova 55F (built-in printer) or a Modo (no printer).
 *
 * Chosen when a terminal is added (the pairing code carries it onto the machine) and
 * editable afterwards. The till reads `hasPrinter` from `GET /machines/me`; a till whose
 * model was never recorded is treated as a 55F, which every till before this was.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { updateMachineDeviceModel } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { DEVICE_MODELS, type DeviceModel, type PosMachine } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

/** The small model tag on a row. Nothing for a till whose model was never recorded. */
export function DeviceModelBadge({ m }: { m: Pick<PosMachine, 'deviceModel'> }) {
  const t = useTranslations('machines.deviceModel');
  if (!m.deviceModel) return null;
  return (
    <Badge
      variant="outline"
      className="h-4 px-1 text-[10px] font-normal text-muted-foreground"
      title={t(m.deviceModel)}
    >
      {t(`badge.${m.deviceModel}`)}
    </Badge>
  );
}

/** The model picker the add-terminal and edit dialogs share. */
export function DeviceModelSelect({
  value,
  onChange,
  id,
}: {
  value: DeviceModel | '';
  onChange: (next: DeviceModel) => void;
  id?: string;
}) {
  const t = useTranslations('machines.deviceModel');
  const items = DEVICE_MODELS.map((model) => ({ value: model, label: t(model) }));
  return (
    <Select
      value={value}
      onValueChange={(v) => (v ? onChange(v as DeviceModel) : undefined)}
      items={items}
    >
      <SelectTrigger id={id} aria-label={t('label')}>
        <SelectValue placeholder={t('placeholder')} />
      </SelectTrigger>
      <SelectContent>
        {items.map((i) => (
          <SelectItem key={i.value} value={i.value} label={i.label}>
            {i.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function DeviceModelDialog({
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
          <DeviceModelForm key={machine.id} machine={machine} onOpenChange={onOpenChange} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function DeviceModelForm({
  machine,
  onOpenChange,
}: {
  machine: PosMachine;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('machines.deviceModel');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [value, setValue] = useState<DeviceModel | ''>(machine.deviceModel ?? '');

  const save = useMutation({
    mutationFn: () => updateMachineDeviceModel(machine.id, value as DeviceModel),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['machines'] });
      qc.invalidateQueries({ queryKey: ['machine', machine.id] });
      toast.success(t('saved'));
      onOpenChange(false);
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('editTitle')}</DialogTitle>
      </DialogHeader>
      <div className="space-y-2">
        <p className="text-muted-foreground text-sm">{t('hint')}</p>
        <Label htmlFor="device-model-edit">{t('label')}</Label>
        <DeviceModelSelect id="device-model-edit" value={value} onChange={setValue} />
        {!machine.deviceModel ? (
          <p className="text-muted-foreground text-xs">{t('unknownHint')}</p>
        ) : null}
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          {tc('cancel')}
        </Button>
        <Button
          disabled={!value || save.isPending || value === (machine.deviceModel ?? '')}
          onClick={() => save.mutate()}
        >
          {save.isPending ? tc('saving') : tc('save')}
        </Button>
      </DialogFooter>
    </>
  );
}
