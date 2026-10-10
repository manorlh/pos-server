'use client';

/**
 * "תצורת עבודה" — how a till works (pos-server docs/SPEC_KDS.md §1–2): direct sale or
 * an order process, where orders go (printer, KDS, Expo, pickup screen), per company,
 * shop, point of sale or till — the most specific level winning. Stored as till
 * parameters the tills already sync; this card is the only place that edits them.
 *
 * The level comes from the cascade picker; it starts from `?scopeType=&scopeId=`
 * (the machine settings dialog links here with its till) or else from the shared
 * scope bar.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchMachines, fetchShops } from '@/lib/api';
import { findBySameId } from '@/lib/entityLookup';
import { getWorkflow } from '@/lib/kdsApi';
import { useScope } from '@/lib/scope';
import type { PosMachine, Shop } from '@/lib/types';
import type { WorkflowLevelView, WorkflowScopeType } from '@/lib/workflowMode';
import {
  EMPTY_ORG_SCOPE,
  OrgScopeCascade,
  deepestOrgScope,
  type OrgScope,
} from '@/components/dashboard/org-scope-cascade';
import { WorkflowEditor } from '@/components/dashboard/workflow/workflow-editor';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

const SCOPE_TYPES: WorkflowScopeType[] = ['company', 'shop', 'area', 'machine'];

/** The cascade's value for a level named by id, once the lists that place it have loaded. */
function scopeFor(
  type: string | null,
  id: string | null,
  shops: Shop[],
  machines: PosMachine[],
): OrgScope | null {
  if (!type || !id) return null;
  if (type === 'company') return { ...EMPTY_ORG_SCOPE, companyId: id };
  if (type === 'shop') {
    const shop = findBySameId(shops, id);
    return shop ? { ...EMPTY_ORG_SCOPE, companyId: shop.companyId, shopId: shop.id } : null;
  }
  if (type === 'machine') {
    const machine = findBySameId(machines, id);
    const shop = machine?.shopId ? findBySameId(shops, machine.shopId) : undefined;
    if (!machine || !shop) return null;
    return { companyId: shop.companyId, shopId: shop.id, areaId: machine.areaId ?? '', machineId: machine.id };
  }
  return null;
}

export default function WorkflowPage() {
  const t = useTranslations('kds.workflow');
  const qc = useQueryClient();
  const params = useSearchParams();
  const shared = useScope();

  // Where the page starts: the link's level, else the scope bar's.
  const linkType = params.get('scopeType');
  const linkId = params.get('scopeId');
  const seedType = linkType && linkId ? linkType : shared.machineId ? 'machine' : shared.shopId ? 'shop' : shared.companyId ? 'company' : null;
  const seedId = linkType && linkId ? linkId : (shared.machineId ?? shared.shopId ?? shared.companyId ?? null);

  const { data: shops = [] } = useQuery<Shop[]>({
    queryKey: ['shops'],
    queryFn: () => fetchShops(),
    enabled: seedType === 'shop' || seedType === 'machine',
  });
  const { data: machines = [] } = useQuery<PosMachine[]>({
    queryKey: ['machines'],
    queryFn: fetchMachines,
    enabled: seedType === 'machine',
  });
  const seed = useMemo(() => scopeFor(seedType, seedId, shops, machines), [seedType, seedId, shops, machines]);

  // The user's own pick replaces the seed for good.
  const [picked, setPicked] = useState<OrgScope | null>(null);
  const scope = picked ?? seed ?? EMPTY_ORG_SCOPE;
  const target = deepestOrgScope(scope);
  const level = target && SCOPE_TYPES.includes(target.level as WorkflowScopeType) ? (target.level as WorkflowScopeType) : null;
  const entityId = target?.id ?? null;

  // Bumped by a save, so the editor starts afresh from what was stored (a background
  // refetch must not wipe a draft in progress, so it is not keyed on the fetch).
  const [savedRev, setSavedRev] = useState(0);
  const queryKey = ['workflow-config', level, entityId];
  const { data, isLoading, isError } = useQuery<WorkflowLevelView>({
    queryKey,
    queryFn: () => getWorkflow(level as WorkflowScopeType, entityId as string),
    enabled: !!level && !!entityId,
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <Link href="/dashboard/kds" className="text-sm font-medium text-primary hover:underline">
          {t('kdsLink')}
        </Link>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('scopeTitle')}</CardTitle>
          <p className="text-xs text-muted-foreground">{t('scopeHint')}</p>
        </CardHeader>
        <CardContent>
          <OrgScopeCascade value={scope} onChange={setPicked} />
        </CardContent>
      </Card>

      {!level || !entityId ? (
        <p className="text-sm text-muted-foreground">{t('chooseScope')}</p>
      ) : isLoading ? (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(300px,380px)]">
          <Skeleton className="h-96 w-full" />
          <Skeleton className="h-96 w-full" />
        </div>
      ) : isError || !data ? (
        <p className="text-sm text-destructive">{t('loadError')}</p>
      ) : (
        // Another level — or a save coming back — starts the draft afresh.
        <WorkflowEditor
          key={`${level}:${entityId}:${savedRev}`}
          view={data}
          onSaved={(next) => {
            // The levels below inherit from this one: their cached views are stale now.
            qc.invalidateQueries({ queryKey: ['workflow-config'], refetchType: 'none' });
            qc.setQueryData(queryKey, next);
            qc.removeQueries({ queryKey: ['workflow-preview'] });
            setSavedRev((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}
