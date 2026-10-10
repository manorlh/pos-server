'use client';

/**
 * "קידומת מסמכים" — every till prints and exports its document numbers under its own
 * prefix — the prefix, then the number padded to 7 digits, no dash: `20000057` — so two
 * tills of the business never issue the same number (docs/SPEC_DOCUMENT_PREFIX.md).
 *
 * The default is the till's register number; a till may be given another (digits, 1–3).
 * The prefix must be unique in the whole business — every branch — because the
 * open-format file is one per business and the Tax Authority's simulator refuses two
 * documents of one type with one number in it, whatever their branch codes. The server
 * refuses a prefix another till of the business holds — or that is already on another
 * till's documents — with a Hebrew message, shown here as it comes. Documents already
 * issued keep the prefix they were issued with.
 *
 * Tills that already collide (two branches' "קופה 1" both on prefix 1) are listed by
 * `DocumentPrefixConflictsAlert`, and `DocumentPrefixBusinessStatus` says on the till's own
 * page whether its prefix is unique in the business; both offer "שיוך קידומת פנויה".
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { toast } from 'sonner';
import { updateMachineDocumentPrefix } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  assignFreeDocumentPrefix,
  fetchDocumentPrefixConflicts,
  fetchMachineDocumentPrefix,
  type DocumentPrefixConflict,
} from '@/lib/documentPrefixApi';
import type { PosMachine } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const PREFIX = /^[0-9]{1,3}$/;

/** Every query that shows a till's prefix, refreshed after one changes. */
function useInvalidatePrefixQueries() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ['machines'] });
    qc.invalidateQueries({ queryKey: ['machine'] });
    qc.invalidateQueries({ queryKey: ['document-prefix-conflicts'] });
    qc.invalidateQueries({ queryKey: ['machine-document-prefix'] });
  };
}

/** "שיוך קידומת פנויה" — the lowest free prefix of the business, for future documents only. */
function AssignFreePrefixButton({
  machineId,
  label,
  suggested,
}: {
  machineId: string;
  label: string;
  suggested?: string | null;
}) {
  const t = useTranslations('machines.documentPrefix');
  const tc = useTranslations('common');
  const invalidate = useInvalidatePrefixQueries();
  const assign = useMutation({
    mutationFn: () => assignFreeDocumentPrefix(machineId),
    onSuccess: (out) => {
      invalidate();
      if (out.changed) toast.success(t('assigned', { till: label, prefix: out.effectiveDocumentPrefix ?? '—' }));
      else toast.message(t('alreadyUnique'));
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });
  return (
    <Button size="sm" variant="outline" disabled={assign.isPending} onClick={() => assign.mutate()}>
      {assign.isPending ? tc('saving') : suggested ? t('assignFreeTo', { prefix: suggested }) : t('assignFree')}
    </Button>
  );
}

function tillLabel(row: Pick<DocumentPrefixConflict, 'posNumber' | 'machineName'>): string {
  const head = row.posNumber ? `קופה ${row.posNumber}` : 'קופה';
  return row.machineName ? `${head} (${row.machineName})` : head;
}

/**
 * The till's page: is its prefix unique in the business? If not, who else holds it, and
 * the button that moves it to a free one (the machine admins', as the prefix edit).
 */
export function DocumentPrefixBusinessStatus({ machineId, canEdit }: { machineId: string; canEdit: boolean }) {
  const t = useTranslations('machines.documentPrefix');
  const { data } = useQuery({
    queryKey: ['machine-document-prefix', machineId],
    queryFn: () => fetchMachineDocumentPrefix(machineId),
    staleTime: 30_000,
  });
  if (!data || !data.prefix) return null;
  if (data.uniqueInBusiness) {
    return (
      <span className="inline-flex items-center gap-1 text-xs text-green-700 dark:text-green-500">
        <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />
        {data.businessShopCount > 1 ? t('uniqueInBusiness', { shops: data.businessShopCount }) : t('uniqueInShop')}
      </span>
    );
  }
  return (
    <span className="flex flex-col gap-1 text-xs">
      <span className="inline-flex items-center gap-1 font-medium text-destructive">
        <AlertTriangle className="h-3.5 w-3.5" aria-hidden />
        {t('notUnique')}
      </span>
      {data.heldBy.map((h) => (
        <span key={`${h.kind}-${h.machineId}`} className="text-muted-foreground">
          {h.text}
        </span>
      ))}
      {canEdit ? (
        <span>
          <AssignFreePrefixButton machineId={machineId} label={t('thisTill')} suggested={data.suggestedPrefix} />
        </span>
      ) : null}
    </span>
  );
}

/**
 * "קידומות מסמכים כפולות בעסק": the active tills of the business whose prefix would repeat
 * another document's number in the business's one open-format file. Nothing when none.
 */
export function DocumentPrefixConflictsAlert({
  companyId,
  shopId,
  canEdit,
}: {
  companyId?: string | null;
  shopId?: string | null;
  canEdit: boolean;
}) {
  const t = useTranslations('machines.documentPrefix');
  const enabled = Boolean(shopId || companyId);
  const { data } = useQuery({
    queryKey: ['document-prefix-conflicts', shopId ?? null, shopId ? null : companyId ?? null],
    queryFn: () => fetchDocumentPrefixConflicts({ companyId, shopId }),
    enabled,
    staleTime: 30_000,
  });
  const rows = data?.conflicts ?? [];
  if (!enabled || rows.length === 0) return null;
  return (
    <div role="alert" className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
      <div className="flex min-w-0 gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" aria-hidden />
        <div className="min-w-0 space-y-1">
          <p className="font-medium text-destructive">{t('conflictsTitle', { count: rows.length })}</p>
          <p className="text-xs text-muted-foreground">{t('conflictsHint')}</p>
        </div>
      </div>
      <ul className="space-y-2">
        {rows.map((row) => (
          <li
            key={row.machineId}
            className="flex flex-wrap items-start justify-between gap-2 rounded-md border bg-background p-2"
          >
            <div className="min-w-0 space-y-0.5">
              <p className="font-medium">
                {row.shopName ?? '—'}
                {row.branchId ? <span className="text-muted-foreground"> · {t('branchCode', { code: row.branchId })}</span> : null}
                {' · '}
                {tillLabel(row)}
                {' · '}
                <span className="tabular-nums" dir="ltr">
                  {t('prefixIs', { prefix: row.prefix })}
                </span>
                {row.ownPrefix ? null : <span className="text-muted-foreground"> ({t('defaultShort')})</span>}
              </p>
              {row.heldBy.map((h) => (
                <p key={`${h.kind}-${h.machineId}`} className="text-xs text-muted-foreground">
                  {h.text}
                </p>
              ))}
            </div>
            {canEdit ? (
              <AssignFreePrefixButton machineId={row.machineId} label={tillLabel(row)} suggested={row.suggestedPrefix} />
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

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
  // As the till prints it (owner: "ללא מקף"): the prefix, then 57 padded to 7 digits.
  const example = `${trimmed || machine.effectiveDocumentPrefix || machine.posNumber || '2'}0000057`;

  const save = useMutation({
    mutationFn: () => updateMachineDocumentPrefix(machine.id, trimmed === '' ? null : trimmed),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['machines'] });
      qc.invalidateQueries({ queryKey: ['machine', machine.id] });
      qc.invalidateQueries({ queryKey: ['document-prefix-conflicts'] });
      qc.invalidateQueries({ queryKey: ['machine-document-prefix'] });
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
