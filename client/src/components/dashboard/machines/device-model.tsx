'use client';

/**
 * "דגם מכשיר" — which hardware a till is: a Feitian F20 / Nova 55F (built-in printer and
 * terminal), a Modo (terminal only), a Kozen Nebullar P18 tablet, a LANDI or a Feitian
 * tablet (no printer / drawer driver yet — "בקרוב"), or a plain Android tablet
 * (pos-server docs/SPEC_DEVICE_ROLE_MODEL.md; capabilities in lib/deviceProfile.ts).
 *
 * Chosen when a terminal is added (the pairing code carries it onto the machine) and
 * editable afterwards; a P18 / LANDI names itself when it pairs, whatever the code says
 * (the machine page then warns). The till reads `hasPrinter` / `hasBuiltinTerminal` from
 * `GET /machines/me`; a till whose model was never recorded is treated as a 55F.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { updateMachineDeviceModel } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { deviceProfileErrorMessage } from '@/lib/deviceProfile';
import { deviceModelOptions } from '@/lib/deviceModelSearch';
import type { DeviceModel, PosMachine } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';

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

/**
 * The model picker the add-terminal, pairing, edit and device-profile dialogs share: a
 * combobox searched by the Hebrew label, the model's name, maker (also in Hebrew letters),
 * aliases and code (lib/deviceModelSearch.ts) — "t2", "a920pro", "סאנמי". The value is the
 * model id, as before; ✕ clears it back to "not chosen".
 */
export function DeviceModelSelect({
  value,
  onChange,
  id,
}: {
  value: DeviceModel | '';
  onChange: (next: DeviceModel | '') => void;
  id?: string;
}) {
  const t = useTranslations('machines.deviceModel');
  const tc = useTranslations('combobox.deviceModel');
  const options = useMemo(() => deviceModelOptions((model) => t(model)), [t]);
  return (
    <Combobox
      id={id}
      aria-label={t('label')}
      options={options}
      value={value}
      onValueChange={(next) => onChange(next ?? '')}
      placeholder={tc('placeholder')}
      emptyText={tc('noResults')}
      clearable
    />
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
    // A change waits for a clean break (no open shift, nothing unsynced): the server's Hebrew.
    onError: (err) => toast.error(deviceProfileErrorMessage(err) ?? axiosErrorToToastMessage(err, tc('error'))),
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
