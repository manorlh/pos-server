'use client';

/**
 * The POS-settings dialog, in one place.
 *
 * It was pasted three times (sidebar → tenant, companies list → company, shops
 * list → shop) and the drill-down pages needed a fourth and fifth copy. The three
 * levels differ only in which endpoints they call and whether inherited values are
 * shown, so they are parameters here.
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  fetchCompanySettings,
  fetchShopSettings,
  fetchTenantSettings,
  patchCompanySettings,
  patchShopSettings,
  patchTenantSettings,
} from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { isNoPaymentOptionAllowedError, noPaymentOptionAllowed } from '@/lib/paymentOptions';
import { PosSettingsForm, type PosSettingsFormState } from '@/components/pos-settings-form';
import type { PosSettingsV1 } from '@/lib/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export type SettingsEntityLevel = 'tenant' | 'company' | 'shop';

export function EntityPosSettingsDialog({
  level,
  entityId,
  open,
  onOpenChange,
}: {
  level: SettingsEntityLevel;
  entityId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const tc = useTranslations('common');
  const tps = useTranslations('posSettings');
  const [value, setValue] = useState<PosSettingsFormState>({});
  const [inherited, setInherited] = useState<PosSettingsV1 | undefined>();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [paymentOptionsRejected, setPaymentOptionsRejected] = useState(false);

  useEffect(() => {
    if (!open || !entityId) return;
    let cancelled = false;
    setValue({});
    setInherited(undefined);
    setPaymentOptionsRejected(false);
    setLoading(true);
    const load = async () => {
      try {
        if (level === 'tenant') {
          const res = await fetchTenantSettings(entityId);
          if (!cancelled) setValue(res.settings ?? {});
        } else if (level === 'company') {
          const res = await fetchCompanySettings(entityId);
          if (!cancelled) setValue(res.settings ?? {});
        } else {
          const res = await fetchShopSettings(entityId, true);
          if (!cancelled) {
            setValue(res.settings ?? {});
            setInherited(res.effective);
          }
        }
      } catch (err: unknown) {
        if (!cancelled) {
          toast.error(axiosErrorToToastMessage(err, tc('error')));
          onOpenChange(false);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
    // `tc`/`onOpenChange` are stable enough; re-fetching on every render would
    // discard the operator's unsaved edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId, level, open]);

  const inheritedForForm = level === 'shop' ? inherited : undefined;
  const noneAllowed = noPaymentOptionAllowed(value, inheritedForForm);

  const handleChange = (next: PosSettingsFormState) => {
    setValue(next);
    setPaymentOptionsRejected(false);
  };

  const handleSave = async () => {
    if (!entityId || noneAllowed) return;
    // The form round-trips whatever the layer holds, including the legacy tip
    // switches it no longer shows. Leaving them out of the PATCH keeps their
    // stored value (the server's fallback) without the dashboard writing them.
    const patch = { ...value };
    delete patch.tipsEnabled;
    delete patch.cashTipsEnabled;
    setSaving(true);
    try {
      if (level === 'tenant') await patchTenantSettings(entityId, patch);
      else if (level === 'company') await patchCompanySettings(entityId, patch);
      else await patchShopSettings(entityId, patch);
      toast.success(tps('saved'));
      onOpenChange(false);
    } catch (err: unknown) {
      if (isNoPaymentOptionAllowedError(err)) {
        setPaymentOptionsRejected(true);
        toast.error(tps('payNoneAllowed'));
      } else {
        toast.error(axiosErrorToToastMessage(err, tc('error')));
      }
    } finally {
      setSaving(false);
    }
  };

  const subtitle =
    level === 'tenant'
      ? tps('tenantSubtitle')
      : level === 'company'
        ? tps('companySubtitle')
        : tps('shopSubtitle');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{level === 'tenant' ? tps('tenantTitle') : tps('title')}</DialogTitle>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </DialogHeader>
        <PosSettingsForm
          value={value}
          onChange={handleChange}
          inherited={inheritedForForm}
          showOverrideHints={level === 'shop'}
          paymentOptionsRejected={paymentOptionsRejected}
          tenantLevel={level === 'tenant'}
        />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tc('cancel')}
          </Button>
          <Button
            onClick={() => void handleSave()}
            disabled={saving || loading || !entityId || noneAllowed}
          >
            {saving ? tc('saving') : tc('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
