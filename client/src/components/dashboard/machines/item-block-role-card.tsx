'use client';

/**
 * "קופה מנהלת לחסימות" — the till page's line for its part in item blocks
 * (P:/specs/item-block-control.md §2, §5): the role it has now (managing / regular / none) and where
 * that comes from (the main till, the shop, the till itself…), with a quick switch. Everything else
 * is set in "הגדרות ניהול מלאי" (the stock page's card "חסימות מהקופה").
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ShieldBan } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  LOCAL_LEVEL_LABELS,
  MANAGING_LEVEL_LABELS,
  SOURCE_LABELS,
  channelsText,
  type ControlView,
} from '@/lib/itemBlockControl';
import { fetchControl, itemBlockControlKeys, setMachineManaging } from '@/lib/itemBlockControlApi';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { RoleBadge } from '@/components/dashboard/stock/item-block-control-card';
import { cn } from '@/lib/utils';

export function ItemBlockRoleCard({ machineId }: { machineId: string }) {
  const t = useTranslations('itemBlockControl.tillCard');
  const tm = useTranslations('itemBlockControl.managing');
  const qc = useQueryClient();
  const { data: view, isLoading, isError, error } = useQuery<ControlView>({
    queryKey: itemBlockControlKeys.level('machine', machineId),
    queryFn: () => fetchControl('machine', machineId),
  });

  const toggle = useMutation({
    mutationFn: (managing: boolean) => setMachineManaging(machineId, managing),
    onSuccess: (next, managing) => {
      toast.success(managing ? t('savedOn') : t('savedOff'));
      qc.setQueryData(itemBlockControlKeys.level('machine', machineId), next);
      qc.invalidateQueries({ queryKey: itemBlockControlKeys.all });
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, t('saveError'))),
  });

  const till = view?.till;
  const role = till?.role;
  const scope = till
    ? role === 'managing'
      ? t('scopeManaging', { level: MANAGING_LEVEL_LABELS[till.itemBlocks.managingMaxLevel] })
      : role === 'local'
        ? t('scopeLocal', {
            level: LOCAL_LEVEL_LABELS[till.itemBlocks.localMaxLevel],
            channels: channelsText(till.itemBlocks.localChannels),
          })
        : till.itemBlocks.localRelease
          ? t('scopeNoneRelease')
          : t('scopeNone')
    : null;
  const switchId = `item-block-managing-${machineId}`;

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <ShieldBan className="size-4" aria-hidden />
            {t('title')}
          </CardTitle>
          <Link
            href="/dashboard/stock?tab=levels"
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'min-h-9')}
          >
            {t('settings')}
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : isError ? (
          <p className="text-sm text-destructive">{axiosErrorToToastMessage(error, t('loadError'))}</p>
        ) : !till || !role ? (
          <p className="text-sm text-muted-foreground">{t('noTill')}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-1.5 text-xs">
              <RoleBadge role={role} label={role === 'managing' ? t('managingBadge') : undefined} />
              {till.isMainTill ? <Badge variant="outline">{tm('mainTill')}</Badge> : null}
              <span className="text-muted-foreground">{SOURCE_LABELS[till.roleSource]}</span>
            </div>
            {scope ? <p className="text-xs text-muted-foreground">{scope}</p> : null}
            <div className="flex min-h-11 items-center justify-between gap-3 rounded-lg border px-3 py-2">
              <Label htmlFor={switchId}>{t('switch')}</Label>
              <Switch
                id={switchId}
                checked={role === 'managing'}
                disabled={!view?.canWrite || toggle.isPending}
                onCheckedChange={(on) => toggle.mutate(!!on)}
              />
            </div>
            {!view?.canWrite ? <p className="text-xs text-muted-foreground">{t('readOnly')}</p> : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
