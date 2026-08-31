'use client';

/**
 * Create / edit a company. Shared by the companies list and the company
 * drill-down page, so "edit" means the same form wherever it is reached from.
 *
 * `parentCompanyId` is deliberately **not** editable here. The field is read from
 * the company response and rendered on the drill-down page, but re-parenting a
 * company moves every shop, till and receipt underneath it, and the write path
 * for it is not something this dashboard can claim to have verified. Showing the
 * link and leaving the move to a deliberate operation is the safer half.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import type { Company } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const EMPTY: Partial<Company> = { name: '', vatNumber: '', address: '', city: '' };

export function CompanyFormDialog({
  company,
  open,
  onOpenChange,
  onSaved,
}: {
  /** `null` (or a row with no id) creates. */
  company: Partial<Company> | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (saved: Company) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        {/*
          Mounted only while open, so the form seeds itself from `company` in
          `useState` and never needs an effect to re-sync a draft — closing the
          dialog discards the draft by unmounting it.
        */}
        {open ? (
          <CompanyForm company={company} onOpenChange={onOpenChange} onSaved={onSaved} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function CompanyForm({
  company,
  onOpenChange,
  onSaved,
}: {
  company: Partial<Company> | null;
  onOpenChange: (open: boolean) => void;
  onSaved?: (saved: Company) => void;
}) {
  const t = useTranslations('companies');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Partial<Company>>(() => company ?? EMPTY);
  const isNew = !draft.id;

  const save = useMutation({
    mutationFn: async (c: Partial<Company>) => {
      const payload = {
        name: c.name,
        vatNumber: c.vatNumber,
        address: c.address,
        city: c.city,
      };
      const { data } = c.id
        ? await api.put<Company>(`/companies/${c.id}`, payload)
        : await api.post<Company>('/companies', payload);
      return data;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['companies'] });
      toast.success(isNew ? t('created') : t('updated'));
      onOpenChange(false);
      onSaved?.(data);
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  return (
    <>
      <DialogHeader>
        <DialogTitle>{isNew ? t('addTitle') : t('editTitle')}</DialogTitle>
      </DialogHeader>
      <div className="space-y-3">
        <div className="space-y-1">
          <Label>{t('name')}</Label>
          <Input
            value={draft.name ?? ''}
            onChange={(e) => setDraft((c) => ({ ...c, name: e.target.value }))}
          />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label>{t('vat')}</Label>
            <Input
              value={draft.vatNumber ?? ''}
              placeholder={t('vatPlaceholder')}
              onChange={(e) => setDraft((c) => ({ ...c, vatNumber: e.target.value }))}
            />
          </div>
          <div className="space-y-1">
            <Label>{t('city')}</Label>
            <Input
              value={draft.city ?? ''}
              onChange={(e) => setDraft((c) => ({ ...c, city: e.target.value }))}
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label>{t('address')}</Label>
          <Input
            value={draft.address ?? ''}
            onChange={(e) => setDraft((c) => ({ ...c, address: e.target.value }))}
          />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          {tc('cancel')}
        </Button>
        <Button onClick={() => save.mutate(draft)} disabled={save.isPending}>
          {save.isPending ? tc('saving') : tc('save')}
        </Button>
      </DialogFooter>
    </>
  );
}
