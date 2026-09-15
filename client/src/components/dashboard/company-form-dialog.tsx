'use client';

/**
 * Create / edit a company. Shared by the companies list and the company
 * drill-down page, so "edit" means the same form wherever it is reached from.
 *
 * `parentCompanyId` is offered **on create only**. A company that does not exist yet
 * has no shops, tills or receipts under it, so choosing its place in the group costs
 * nothing and is exactly when the operator knows the answer. *Moving* an existing
 * company is the dangerous half — it carries everything underneath — so it lives on
 * the drill-down page as a deliberate action with a confirmation that names what
 * moves, rather than as a quiet dropdown in an edit form.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, fetchParentOptions } from '@/lib/api';
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

  // Only while creating: on an existing company this picker would be the quiet
  // dropdown the module comment argues against.
  const { data: parents } = useQuery({
    queryKey: ['company-parent-options', 'new'],
    queryFn: () => fetchParentOptions(),
    enabled: isNew,
  });

  const save = useMutation({
    mutationFn: async (c: Partial<Company>) => {
      const payload = {
        name: c.name,
        vatNumber: c.vatNumber,
        address: c.address,
        city: c.city,
        // Only ever sent when creating. An edit must not carry it, or saving a name
        // change would silently re-assert a parent the operator never looked at.
        ...(c.id ? {} : { parentCompanyId: c.parentCompanyId || null }),
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

        {/* Create only. An empty value means a top-level company, which is the common
            case, so it leads rather than hiding behind a toggle. */}
        {isNew && (parents?.options.length ?? 0) > 0 ? (
          <div className="space-y-1">
            <Label htmlFor="company-parent">{t('parentLabel')}</Label>
            <select
              id="company-parent"
              className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm"
              value={draft.parentCompanyId ?? ''}
              onChange={(e) =>
                setDraft({ ...draft, parentCompanyId: e.target.value || null })
              }
            >
              <option value="">{t('parentNone')}</option>
              {parents!.options.map((o) => (
                <option key={o.id} value={o.id} disabled={!o.allowed}>
                  {/* Indented by depth so a group and its subsidiary do not read as
                      peers, and disabled rows say why rather than vanishing. */}
                  {'\u00A0'.repeat(o.depth * 3)}
                  {o.name}
                  {o.allowed ? '' : ` — ${o.reason ?? ''}`}
                </option>
              ))}
            </select>
            <p className="text-muted-foreground text-xs">{t('parentHint')}</p>
          </div>
        ) : null}
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
