'use client';

/**
 * "מסך לקוח" (P:/specs/customer-display.md): the customer-facing screen — a till's second screen
 * (found by the till itself) or a device paired as one — per company, shop, point of sale or
 * device, field by field. The level comes from the cascade picker; it starts from
 * `?scopeType=&scopeId=` (the settings dialogs link here) or else from the shared scope bar.
 */

import { useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchMachines, fetchShops } from '@/lib/api';
import { findBySameId } from '@/lib/entityLookup';
import { useScope } from '@/lib/scope';
import type { PosMachine, Shop } from '@/lib/types';
import { CD_TEXT, LEVELS, type CdLayerView, type CdLevel } from '@/lib/customerDisplay';
import { getCustomerDisplayLayer } from '@/lib/customerDisplayApi';
import {
  EMPTY_ORG_SCOPE,
  OrgScopeCascade,
  deepestOrgScope,
  type OrgScope,
} from '@/components/dashboard/org-scope-cascade';
import { CustomerDisplayEditor } from '@/components/dashboard/customer-display/customer-display-editor';
import { CustomerDisplaysCard } from '@/components/dashboard/customer-display/customer-display-devices';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

function scopeFor(type: string | null, id: string | null, shops: Shop[], machines: PosMachine[]): OrgScope | null {
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

export default function CustomerDisplayPage() {
  const qc = useQueryClient();
  const params = useSearchParams();
  const shared = useScope();

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

  const [picked, setPicked] = useState<OrgScope | null>(null);
  const scope = picked ?? seed ?? EMPTY_ORG_SCOPE;
  const target = deepestOrgScope(scope);
  const level = target && (LEVELS as readonly string[]).includes(target.level) ? (target.level as CdLevel) : null;
  const entityId = target?.id ?? null;

  const [savedRev, setSavedRev] = useState(0);
  const queryKey = ['customer-display-layer', level, entityId];
  const { data, isLoading, isError } = useQuery<CdLayerView>({
    queryKey,
    queryFn: () => getCustomerDisplayLayer(level as CdLevel, entityId as string),
    enabled: !!level && !!entityId,
  });

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold">{CD_TEXT.title}</h1>
        <p className="text-sm text-muted-foreground">{CD_TEXT.subtitle}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{CD_TEXT.scopeTitle}</CardTitle>
          <p className="text-xs text-muted-foreground">{CD_TEXT.scopeHint}</p>
        </CardHeader>
        <CardContent>
          <OrgScopeCascade value={scope} onChange={setPicked} />
        </CardContent>
      </Card>

      {!level || !entityId ? (
        <p className="text-sm text-muted-foreground">{CD_TEXT.chooseScope}</p>
      ) : isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : isError || !data ? (
        <p className="text-sm text-destructive">{CD_TEXT.loadError}</p>
      ) : (
        <CustomerDisplayEditor
          key={`${level}:${entityId}:${savedRev}`}
          view={data}
          onSaved={(next) => {
            qc.invalidateQueries({ queryKey: ['customer-display-layer'], refetchType: 'none' });
            qc.setQueryData(queryKey, next);
            setSavedRev((n) => n + 1);
          }}
        />
      )}

      <CustomerDisplaysCard shopId={scope.shopId || null} />
    </div>
  );
}
