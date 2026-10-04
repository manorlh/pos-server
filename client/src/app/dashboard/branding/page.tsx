'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { fetchTenantSettings, patchTenantSettings } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { useAuth } from '@/lib/auth';
import { usePageScope } from '@/lib/scope';
import { ScopeIgnoredNote } from '@/components/dashboard/scope-gate';
import type { BrandingImageKind, EntitySettingsResponse, PosSettingsPatch } from '@/lib/types';
import { BrandingImageField } from '@/components/branding-image-field';
import { BrandColorField } from '@/components/brand-color-field';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Only the roles the server accepts a branding write from. The tills' white
 * label belongs to the distributor, so anything narrower than a company manager
 * would only see a control that 403s on save.
 */
const BRANDING_ROLES = ['super_admin', 'distributor', 'company_manager'];

/** Present key = edited. `null` = remove it from the tenant (back to unset). */
type BrandingDraft = {
  brandLogoUrl?: string | null;
  brandHeroUrl?: string | null;
  brandPrimaryColor?: string | null;
  brandReceiptLogoUrl?: string | null;
};

const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

export default function BrandingPage() {
  const t = useTranslations('branding');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const activeTenantId = useAuth((s) => s.activeTenantId);
  // Branding is stored on the tenant and reaches every till in it; a company or
  // shop in scope does not make it narrower, which the note says out loud.
  const { resolution } = usePageScope({ maxLevel: 'tenant' });
  const role = useAuth((s) => s.user?.role);
  const authHydrated = useAuth((s) => s.authHydrated);
  const [draft, setDraft] = useState<BrandingDraft>({});

  const canEdit = authHydrated && !!role && BRANDING_ROLES.includes(role);

  const { data, isLoading } = useQuery<EntitySettingsResponse>({
    queryKey: ['tenant-settings', activeTenantId],
    queryFn: () => fetchTenantSettings(activeTenantId as string),
    enabled: !!activeTenantId && canEdit,
  });

  const save = useMutation({
    mutationFn: (patch: PosSettingsPatch) =>
      patchTenantSettings(activeTenantId as string, patch),
    onSuccess: () => {
      setDraft({});
      qc.invalidateQueries({ queryKey: ['tenant-settings', activeTenantId] });
      toast.success(t('saved'));
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const saved = data?.settings ?? {};

  const valueFor = (key: 'brandLogoUrl' | 'brandHeroUrl' | 'brandReceiptLogoUrl'): string | undefined => {
    if (key in draft) return draft[key] ?? undefined;
    return saved[key];
  };

  const setValue = (key: 'brandLogoUrl' | 'brandHeroUrl' | 'brandReceiptLogoUrl', url: string | undefined) => {
    setDraft((d) => ({ ...d, [key]: url ?? null }));
  };

  const colorValue =
    'brandPrimaryColor' in draft ? (draft.brandPrimaryColor ?? undefined) : saved.brandPrimaryColor || undefined;
  const colorInvalid = !!colorValue && !HEX_COLOR.test(colorValue);

  const dirty = Object.keys(draft).length > 0;

  const field = (kind: BrandingImageKind, key: 'brandLogoUrl' | 'brandHeroUrl' | 'brandReceiptLogoUrl') => (
    <BrandingImageField
      kind={kind}
      value={valueFor(key)}
      onChange={(url) => setValue(key, url)}
      title={t(`${kind}Title`)}
      description={t(`${kind}Where`)}
      hint={t(`${kind}Hint`)}
      disabled={save.isPending}
      // The startup hero may be a short video too: same setting, played by the till.
      allowVideo={kind === 'hero'}
    />
  );

  if (authHydrated && !canEdit) {
    return (
      <div className="max-w-2xl space-y-4">
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('noPermission')}</p>
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>

      {resolution.status === 'ok' && resolution.ignoredDeeper ? (
        <ScopeIgnoredNote maxLevel={resolution.maxLevel} />
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{t('imagesTitle')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-6">
          {isLoading ? (
            <div className="space-y-4">
              <Skeleton className="h-24 w-full" />
              <Skeleton className="h-24 w-full" />
            </div>
          ) : (
            <>
              {field('logo', 'brandLogoUrl')}
              <Separator />
              {field('hero', 'brandHeroUrl')}
              <Separator />
              {/* Superseded by the till parameter `receiptLogoUrl` (per company, shop, point
                  of sale or till), which the till prefers when set. Kept working for the
                  tills that have no value there. */}
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40">
                <p className="font-medium">{t('receiptSuperseded')}</p>
                <p className="text-muted-foreground text-xs">{t('receiptSupersededHint')}</p>
                {/* The till parameters page is the super admin's; others are told, not sent. */}
                {role === 'super_admin' ? (
                  <Link href="/dashboard/till-parameters" className="text-primary text-xs underline">
                    {t('receiptSupersededLink')}
                  </Link>
                ) : null}
              </div>
              {field('receipt', 'brandReceiptLogoUrl')}
              <Separator />
              <BrandColorField
                value={colorValue}
                disabled={save.isPending}
                onChange={(hex) => setDraft((d) => ({ ...d, brandPrimaryColor: hex ?? null }))}
              />
              <Separator />
              <p className="text-xs text-muted-foreground">{t('propagationNote')}</p>
              <div className="flex justify-start">
                <Button
                  onClick={() => save.mutate(draft as PosSettingsPatch)}
                  disabled={!dirty || colorInvalid || save.isPending || !activeTenantId}
                >
                  {save.isPending ? tc('saving') : tc('save')}
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
