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
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  fetchCompanySettings,
  fetchMachineSettings,
  fetchShopSettings,
  fetchTenantSettings,
  patchCompanySettings,
  patchMachineSettings,
  patchShopSettings,
  patchTenantSettings,
} from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { useAuth } from '@/lib/auth';
import { isNoPaymentOptionAllowedError, noPaymentOptionAllowed } from '@/lib/paymentOptions';
import { PosSettingsForm, type PosSettingsFormState } from '@/components/pos-settings-form';
import { usePaymentIntegrationValidation } from '@/components/payment-integration-section';
import { PI_TEXT, paymentIntegrationErrorMessage, withSendableSecrets } from '@/lib/paymentIntegration';
import type { PosSettingsV1 } from '@/lib/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/** `machine` is one till: the last layer, under its shop. */
export type SettingsEntityLevel = 'tenant' | 'company' | 'shop' | 'machine';

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
  // Only the super admin may change the Z mode (the server's Z_SCOPE_WRITE_ROLES);
  // everyone else sees it read-only. The shop's and its points of sale's are on the
  // shop page (ZScopeCard).
  const { user, authHydrated } = useAuth();
  const canChangeZScope = authHydrated && user?.role === 'super_admin';

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
          const res =
            level === 'shop'
              ? await fetchShopSettings(entityId, true)
              : await fetchMachineSettings(entityId, true);
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

  // Shop and till both sit on a layer above them, and show what they inherit.
  const showsInherited = level === 'shop' || level === 'machine';
  const inheritedForForm = showsInherited ? inherited : undefined;
  const noneAllowed = noPaymentOptionAllowed(value, inheritedForForm);
  // "סוג אינטגרציית אשראי": the same checks the section shows; Save waits for them.
  const qc = useQueryClient();
  const payment = usePaymentIntegrationValidation({
    level,
    entityId,
    value,
    inherited: inheritedForForm,
    enabled: open,
  });

  const handleChange = (next: PosSettingsFormState) => {
    setValue(next);
    setPaymentOptionsRejected(false);
  };

  const handleSave = async () => {
    if (!entityId || noneAllowed || !payment.valid) return;
    // The form round-trips whatever the layer holds, including the legacy tip
    // switches it no longer shows. Leaving them out of the PATCH keeps their
    // stored value (the server's fallback) without the dashboard writing them.
    // A Z-Credit secret goes only when typed (never the "••••" mask, never ''), and
    // only while Z-Credit is the type shown.
    const patch = withSendableSecrets({ ...value });
    if (payment.integration.effective !== 'zcredit') {
      delete patch.zcreditPassword;
      delete patch.zcreditKey;
    }
    delete patch.tipsEnabled;
    delete patch.cashTipsEnabled;
    // Never sent by someone who may not change it, nor from below the organization —
    // a shop's own mode is changed on its page (ZScopeCard), over a clean break.
    if (!canChangeZScope || level !== 'tenant') delete patch.zScope;
    setSaving(true);
    try {
      if (level === 'tenant') await patchTenantSettings(entityId, patch);
      else if (level === 'company') await patchCompanySettings(entityId, patch);
      else if (level === 'shop') await patchShopSettings(entityId, patch);
      else await patchMachineSettings(entityId, patch);
      toast.success(tps('saved'));
      // Every layer's context (a layer below inherits this one), and the machines list's
      // integration badges.
      void qc.invalidateQueries({ queryKey: ['payment-integration-context'] });
      void qc.invalidateQueries({ queryKey: ['machines'] });
      void qc.invalidateQueries({ queryKey: ['machine'] });
      onOpenChange(false);
    } catch (err: unknown) {
      const paymentMsg = paymentIntegrationErrorMessage(err);
      if (isNoPaymentOptionAllowedError(err)) {
        setPaymentOptionsRejected(true);
        toast.error(tps('payNoneAllowed'));
      } else if (paymentMsg) {
        // 422 `agamento_needs_builtin_terminal` / `secret_invalid`: the server's words.
        toast.error(paymentMsg);
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
        : level === 'shop'
          ? tps('shopSubtitle')
          : tps('machineSubtitle');

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md max-h-[90dvh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{level === 'tenant' ? tps('tenantTitle') : tps('title')}</DialogTitle>
          <p className="text-sm text-muted-foreground">{subtitle}</p>
        </DialogHeader>
        <PosSettingsForm
          value={value}
          onChange={handleChange}
          inherited={inheritedForForm}
          showOverrideHints={showsInherited}
          paymentOptionsRejected={paymentOptionsRejected}
          tenantLevel={level === 'tenant'}
          zScopeEditable={canChangeZScope}
          settingsLevel={level}
          entityId={entityId}
        />
        {!payment.valid && !loading ? (
          <p role="alert" className="text-sm text-destructive">
            {PI_TEXT.formInvalid}
          </p>
        ) : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {tc('cancel')}
          </Button>
          <Button
            onClick={() => void handleSave()}
            disabled={saving || loading || !entityId || noneAllowed || !payment.valid}
          >
            {saving ? tc('saving') : tc('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
