'use client';

/**
 * A license ("לקוח קבוע / זמני") changed on its own, by the super admin: the organization's
 * from the sidebar (it has no edit form) and a single till's from its page — a till lent
 * to an event out of a permanent shop. Companies and shops have theirs in their own forms.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { useAuth, type TenantSummary } from '@/lib/auth';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  LicenseFields,
  licenseIncomplete,
  licensePayload,
  type LicenseValue,
} from '@/components/dashboard/license-fields';

export function LicenseDialog({
  title,
  initial,
  onSave,
  open,
  onOpenChange,
}: {
  title: string;
  initial: LicenseValue;
  /** Sends the license; resolves once saved and re-read. */
  onSave: (v: LicenseValue) => Promise<unknown>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        {open ? <LicenseForm title={title} initial={initial} onSave={onSave} onOpenChange={onOpenChange} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function LicenseForm({
  title,
  initial,
  onSave,
  onOpenChange,
}: {
  title: string;
  initial: LicenseValue;
  onSave: (v: LicenseValue) => Promise<unknown>;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('license');
  const tc = useTranslations('common');
  const [draft, setDraft] = useState<LicenseValue>(() => ({
    licenseType: initial.licenseType ?? 'permanent',
    licenseExpiresOn: initial.licenseExpiresOn ?? null,
  }));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await onSave(licensePayload(draft, true));
      toast.success(t('saved'));
      onOpenChange(false);
    } catch (err: unknown) {
      toast.error(axiosErrorToToastMessage(err, tc('error')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
      </DialogHeader>
      <LicenseFields idPrefix="license-edit" value={draft} onChange={setDraft} />
      <DialogFooter>
        <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
          {tc('cancel')}
        </Button>
        <Button onClick={() => void save()} disabled={saving || licenseIncomplete(draft, true)}>
          {saving ? tc('saving') : tc('save')}
        </Button>
      </DialogFooter>
    </>
  );
}

/** The organization's, from the sidebar. */
export function TenantLicenseDialog({
  tenant,
  open,
  onOpenChange,
}: {
  tenant: TenantSummary | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('license');
  const fetchUser = useAuth((s) => s.fetchUser);
  if (!tenant) return null;
  return (
    <LicenseDialog
      title={t('tenantTitle', { name: tenant.name })}
      initial={tenant}
      open={open}
      onOpenChange={onOpenChange}
      onSave={async (v) => {
        await api.patch(`/tenants/${tenant.id}`, v);
        // The sidebar's organization list carries the license; re-read it.
        await fetchUser();
      }}
    />
  );
}
