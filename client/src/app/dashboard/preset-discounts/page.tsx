'use client';

/**
 * "הנחות קבועות" — preset basket discounts (P:/specs/preset-discounts.md): a list of ready
 * discounts on the whole sale ("הנחת עובדים" 40%, "הנחת מנוי" 10%), one tap each on the till, per
 * level — pick a company, optionally a shop, a point of sale and a till; the deepest one chosen is
 * the level edited (as the payment methods page). Nothing appears on the till until a list is set.
 *
 * The editor (components/dashboard/preset-discounts/preset-discounts-editor.tsx) shows what the
 * level inherits and from where, copies it to edit at this level, or goes back to inheriting.
 * Who uses them, and how much they took off: "מעקב הנחות קבועות" (/dashboard/preset-discounts-report).
 */

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/lib/auth';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  EMPTY_ORG_SCOPE,
  OrgScopeCascade,
  deepestOrgScope,
  type OrgScope,
} from '@/components/dashboard/org-scope-cascade';
import { PresetDiscountsEditor } from '@/components/dashboard/preset-discounts/preset-discounts-editor';
import { loadLayer, type LayerLevel, type LoadedLayer } from '@/components/dashboard/preset-discounts/settings-layer';

export default function PresetDiscountsPage() {
  const t = useTranslations('presetDiscounts');
  const { user, authHydrated } = useAuth();

  const [scope, setScope] = useState<OrgScope>(EMPTY_ORG_SCOPE);
  const target = deepestOrgScope(scope);
  const level = target?.level as LayerLevel | undefined;
  const entityId = target?.id ?? null;

  const { data: layer, isLoading } = useQuery<LoadedLayer>({
    queryKey: ['preset-discounts', level ?? null, entityId],
    queryFn: () => loadLayer(level as LayerLevel, entityId as string),
    enabled: !!level && !!entityId,
  });

  // The server's rule per level, as the payment methods page: company managers and up for a
  // company; anyone above a cashier who covers the shop for a shop, its points of sale and tills.
  const role = user?.role;
  const canWrite =
    authHydrated &&
    !!role &&
    (level === 'company'
      ? role === 'super_admin' || role === 'distributor' || role === 'company_manager'
      : role === 'super_admin' || role === 'distributor' || role === 'company_manager' || role === 'shop_manager');

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        <Link href="/dashboard/preset-discounts-report" className="text-sm font-medium text-primary hover:underline">
          {t('openReport')} ←
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('scopeTitle')}</CardTitle>
          <p className="text-xs text-muted-foreground">{t('scopeHint')}</p>
        </CardHeader>
        <CardContent>
          <OrgScopeCascade value={scope} onChange={setScope} />
        </CardContent>
      </Card>

      {!level || !entityId ? (
        <p className="text-sm text-muted-foreground">{t('chooseScope')}</p>
      ) : isLoading || !layer ? (
        <div className="space-y-3">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-32 w-full" />
        </div>
      ) : (
        // Keyed on what was loaded: a new level, or a save coming back, starts the draft afresh.
        <PresetDiscountsEditor
          key={`${level}:${entityId}:${layer.settingsUpdatedAt ?? ''}`}
          level={level}
          entityId={entityId}
          layer={layer}
          canWrite={canWrite}
        />
      )}
    </div>
  );
}
