'use client';

/**
 * Create / edit a shop. Shared by the shops list and the shop drill-down page.
 *
 * The company field here is part of the record being edited — which company the
 * shop belongs to — and is not the dashboard's shared scope. It stays a field on
 * the form for that reason; it is not one of the per-page scope pickers that were
 * removed. It does show the company tree, so picking a parent or a child company
 * is unambiguous.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { api, fetchCompanies } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { buildCompanyTree, companyPathLabel, MAX_TREE_INDENT_DEPTH } from '@/lib/companyTree';
import { withoutTrainingFields } from '@/lib/trainingMode';
import type { Company, Shop } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  LicenseFields,
  licenseIncomplete,
  licensePayload,
  useIsSuperAdmin,
  withoutLicense,
} from '@/components/dashboard/license-fields';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

const EMPTY: Partial<Shop> = { name: '', branchId: '', address: '', city: '' };

export function ShopFormDialog({
  shop,
  open,
  onOpenChange,
  onSaved,
  /** Preselected company for a new shop — the company in scope, usually. */
  defaultCompanyId,
}: {
  shop: Partial<Shop> | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (saved: Shop) => void;
  defaultCompanyId?: string | null;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        {/*
          Mounted only while open: the form seeds its draft in `useState`, so no
          effect is needed to re-sync it, and closing discards the draft.
        */}
        {open ? (
          <ShopForm
            shop={shop}
            defaultCompanyId={defaultCompanyId}
            onOpenChange={onOpenChange}
            onSaved={onSaved}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ShopForm({
  shop,
  defaultCompanyId,
  onOpenChange,
  onSaved,
}: {
  shop: Partial<Shop> | null;
  defaultCompanyId?: string | null;
  onOpenChange: (open: boolean) => void;
  onSaved?: (saved: Shop) => void;
}) {
  const t = useTranslations('shops');
  const tc = useTranslations('common');
  const tTraining = useTranslations('trainingMode');
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Partial<Shop>>(
    () => shop ?? { ...EMPTY, companyId: defaultCompanyId ?? undefined },
  );
  const isNew = !draft.id;
  const isSuperAdmin = useIsSuperAdmin();
  // A new shop opens in training mode unless unticked; an existing one changes it on the
  // shop page's "מצב הדרכה" card, never through this form.
  const [trainingMode, setTrainingMode] = useState(true);

  const { data: companies = [] } = useQuery<Company[]>({
    queryKey: ['companies'],
    queryFn: fetchCompanies,
  });
  const tree = buildCompanyTree(companies);

  const save = useMutation({
    mutationFn: async (s: Partial<Shop>) => {
      // The draft is the row as read, license included; only a super admin may send that
      // part back ("לקוח קבוע / זמני"), so it is rebuilt rather than echoed.
      const payload = {
        ...withoutTrainingFields(withoutLicense(s)),
        ...licensePayload(s, isSuperAdmin),
        ...(s.id ? {} : { trainingMode }),
      };
      const { data } = s.id
        ? await api.put<Shop>(`/shops/${s.id}`, payload)
        : await api.post<Shop>('/shops', payload);
      return data;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['shops'] });
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
            onChange={(e) => setDraft((s) => ({ ...s, name: e.target.value }))}
          />
        </div>
        <div className="space-y-1">
          <Label>{t('company')}</Label>
          <Select
            value={draft.companyId ?? ''}
            onValueChange={(v) => setDraft((s) => ({ ...s, companyId: (v as string) ?? undefined }))}
            items={tree.flat.map((node) => ({
              value: node.company.id,
              label: companyPathLabel(tree, node.company.id, node.company.name),
            }))}
          >
            <SelectTrigger>
              <SelectValue placeholder={t('selectCompany')} />
            </SelectTrigger>
            <SelectContent>
              {tree.flat.map((node) => (
                <SelectItem
                  key={node.company.id}
                  value={node.company.id}
                  label={companyPathLabel(tree, node.company.id, node.company.name)}
                >
                  <span
                    style={{
                      paddingInlineStart: `${
                        Math.min(node.depth, MAX_TREE_INDENT_DEPTH) * 0.85
                      }rem`,
                    }}
                  >
                    {node.depth > 0 ? '↳ ' : ''}
                    {node.company.name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <Label>{t('branchId')}</Label>
            <Input
              value={draft.branchId ?? ''}
              placeholder={t('branchIdPlaceholder')}
              onChange={(e) => setDraft((s) => ({ ...s, branchId: e.target.value }))}
            />
          </div>
          <div className="space-y-1">
            <Label>{t('city')}</Label>
            <Input
              value={draft.city ?? ''}
              onChange={(e) => setDraft((s) => ({ ...s, city: e.target.value }))}
            />
          </div>
        </div>
        <div className="space-y-1">
          <Label>{t('address')}</Label>
          <Input
            value={draft.address ?? ''}
            onChange={(e) => setDraft((s) => ({ ...s, address: e.target.value }))}
          />
        </div>
        {isNew ? (
          <div className="flex items-start justify-between gap-3 rounded-md border border-orange-200 bg-orange-50/60 p-3 dark:border-orange-900 dark:bg-orange-950/30">
            <div>
              <Label htmlFor="shop-training-mode" className="cursor-pointer">
                {tTraining('createSwitch')}
              </Label>
              <p className="mt-0.5 text-xs text-muted-foreground">{tTraining('createHint')}</p>
            </div>
            <Switch id="shop-training-mode" checked={trainingMode} onCheckedChange={setTrainingMode} />
          </div>
        ) : null}
        <LicenseFields
          idPrefix="shop"
          value={draft}
          onChange={(v) => setDraft((s) => ({ ...s, ...v }))}
        />
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)}>
          {tc('cancel')}
        </Button>
        <Button onClick={() => save.mutate(draft)} disabled={save.isPending || licenseIncomplete(draft, isSuperAdmin)}>
          {save.isPending ? tc('saving') : tc('save')}
        </Button>
      </DialogFooter>
    </>
  );
}
