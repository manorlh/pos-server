'use client';

/**
 * "קידומת מסמכים" — every till prints and exports its document numbers under its own
 * prefix, `2-57`, so two tills of a shop never issue the same number
 * (docs/SPEC_DOCUMENT_PREFIX.md).
 *
 * The default is the till's register number; a till may be given another (digits, 1–3).
 * The server refuses a prefix another till of the shop / branch holds — or that is already
 * on another till's documents — with a Hebrew message, shown here as it comes. Documents
 * already issued keep the prefix they were issued with.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { updateMachineDocumentPrefix } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import type { PosMachine } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const PREFIX = /^[0-9]{1,3}$/;

/** The prefix in force, marked when it is the default (the register number). */
export function DocumentPrefixValue({
  machine,
}: {
  machine: Pick<PosMachine, 'documentPrefix' | 'effectiveDocumentPrefix'>;
}) {
  const t = useTranslations('machines.documentPrefix');
  const effective = machine.effectiveDocumentPrefix;
  if (!effective) return <span className="text-muted-foreground">{t('none')}</span>;
  if (machine.documentPrefix) return <span className="tabular-nums">{effective}</span>;
  return <span className="tabular-nums">{t('defaultValue', { prefix: effective })}</span>;
}

export function DocumentPrefixDialog({
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
          <DocumentPrefixForm key={machine.id} machine={machine} onOpenChange={onOpenChange} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function DocumentPrefixForm({
  machine,
  onOpenChange,
}: {
  machine: PosMachine;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('machines.documentPrefix');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [value, setValue] = useState(machine.documentPrefix ?? '');
  const [serverError, setServerError] = useState<string | null>(null);

  const trimmed = value.trim();
  const invalid = trimmed !== '' && !PREFIX.test(trimmed);
  const unchanged = trimmed === (machine.documentPrefix ?? '');
  const example = `${trimmed || machine.effectiveDocumentPrefix || machine.posNumber || '2'}-57`;

  const save = useMutation({
    mutationFn: () => updateMachineDocumentPrefix(machine.id, trimmed === '' ? null : trimmed),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['machines'] });
      qc.invalidateQueries({ queryKey: ['machine', machine.id] });
      toast.success(t('saved'));
      onOpenChange(false);
    },
    onError: (err) => {
      const message = axiosErrorToToastMessage(err, tc('error'));
      setServerError(message);
      toast.error(message);
    },
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t('editTitle')}</DialogTitle>
      </DialogHeader>
      <div className="space-y-2">
        <p className="text-muted-foreground text-sm">{t('hint', { example })}</p>
        <Label htmlFor="document-prefix-edit">{t('inputLabel')}</Label>
        <Input
          id="document-prefix-edit"
          value={value}
          inputMode="numeric"
          maxLength={3}
          dir="ltr"
          placeholder={t('placeholder', { posNumber: machine.posNumber ?? '—' })}
          aria-invalid={invalid || !!serverError}
          onChange={(e) => {
            setValue(e.target.value.replace(/\D/g, '').slice(0, 3));
            setServerError(null);
          }}
        />
        {invalid ? <p className="text-destructive text-xs">{t('invalid')}</p> : null}
        {serverError ? <p className="text-destructive text-xs">{serverError}</p> : null}
        <p className="text-muted-foreground text-xs">{t('frozenNote')}</p>
      </div>
      <DialogFooter>
        {machine.documentPrefix ? (
          <Button variant="ghost" onClick={() => setValue('')} disabled={save.isPending}>
            {t('useDefault')}
          </Button>
        ) : null}
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          {tc('cancel')}
        </Button>
        <Button disabled={invalid || unchanged || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? tc('saving') : tc('save')}
        </Button>
      </DialogFooter>
    </>
  );
}
