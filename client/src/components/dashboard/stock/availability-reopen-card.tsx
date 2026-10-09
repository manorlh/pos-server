'use client';

/**
 * "פתיחת פריטים אוטומטית אחרי Z" — the stock page's availability setting
 * (pos-server docs/SPEC_AVAILABILITY.md).
 *
 * Set per company, shop or point of sale (or one till), inheriting like every POS setting
 * (tenant → company → shop → point of sale → till): off, reopen what was locked or marked
 * sold out during the day, or reopen every lock not marked "חסימה קבועה"; and whether an
 * item that tracks stock and has none is reopened too. The rule — which Z closes which
 * day, which locks it opens — is the server's; this card shows the level's own value, what
 * it inherits, and the log of what the Zs reopened in the chosen shop.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { History, RotateCcw } from 'lucide-react';
import {
  api,
  fetchAreaSettings,
  fetchCompanySettings,
  fetchMachineSettings,
  fetchShopSettings,
  patchAreaSettings,
  patchCompanySettings,
  patchMachineSettings,
  patchShopSettings,
} from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import {
  AUTO_REOPEN_MODES,
  autoReopenPatch,
  choiceOf,
  effectiveIgnoreStock,
  effectiveMode,
  ignoreStockChoiceOf,
  runItemNames,
  type AutoReopenChoice,
  type AutoReopenMode,
  type AvailabilityReopenRun,
  type IgnoreStockChoice,
} from '@/lib/availabilityReopen';
import type { EffectiveSources, PosSettingsPatch, PosSettingsV1 } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  EMPTY_ORG_SCOPE,
  OrgScopeCascade,
  deepestOrgScope,
  type OrgScope,
} from '@/components/dashboard/org-scope-cascade';

type EditLevel = 'company' | 'shop' | 'area' | 'machine';

interface Layer {
  settings: PosSettingsV1;
  settingsUpdatedAt?: string | null;
  effective?: PosSettingsV1;
  effectiveSources?: EffectiveSources | null;
}

async function loadLayer(level: EditLevel, id: string): Promise<Layer> {
  if (level === 'company') return fetchCompanySettings(id, true);
  if (level === 'shop') return fetchShopSettings(id, true);
  if (level === 'area') return fetchAreaSettings(id, true);
  return fetchMachineSettings(id, true);
}

async function saveLayer(level: EditLevel, id: string, patch: PosSettingsPatch) {
  if (level === 'company') return patchCompanySettings(id, patch);
  if (level === 'shop') return patchShopSettings(id, patch);
  if (level === 'area') return patchAreaSettings(id, patch);
  return patchMachineSettings(id, patch);
}

export function AvailabilityReopenCard({
  companyId,
  shopId,
}: {
  /** The page's own scope, to start from. */
  companyId?: string | null;
  shopId?: string | null;
}) {
  const t = useTranslations('availabilityReopen');
  const { user, authHydrated } = useAuth();
  const [scope, setScope] = useState<OrgScope>(() => ({
    ...EMPTY_ORG_SCOPE,
    companyId: companyId ?? '',
    shopId: companyId && shopId ? shopId : '',
  }));
  const target = deepestOrgScope(scope);
  const level = target && target.level !== 'tenant' ? (target.level as EditLevel) : undefined;
  const id = target?.id ?? null;

  const { data: layer, isLoading } = useQuery<Layer>({
    queryKey: ['availability-reopen-setting', level ?? null, id],
    queryFn: () => loadLayer(level as EditLevel, id as string),
    enabled: !!level && !!id,
  });

  // The server's rule per level, as on the payment methods page.
  const role = user?.role;
  const canWrite =
    authHydrated &&
    !!role &&
    (level === 'company'
      ? role === 'super_admin' || role === 'distributor' || role === 'company_manager'
      : role === 'super_admin' ||
        role === 'distributor' ||
        role === 'company_manager' ||
        role === 'shop_manager');

  return (
    <Card className="print:hidden">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <RotateCcw className="size-4" aria-hidden />
          {t('title')}
        </CardTitle>
        <CardDescription>{t('subtitle')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <OrgScopeCascade value={scope} onChange={setScope} />
        {!level || !id ? (
          <p className="text-muted-foreground text-sm">{t('chooseScope')}</p>
        ) : isLoading || !layer ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <Editor
            key={`${level}:${id}:${layer.settingsUpdatedAt ?? ''}`}
            level={level}
            id={id}
            layer={layer}
            canWrite={canWrite}
          />
        )}
        {scope.shopId ? <ReopenLog shopId={scope.shopId} /> : null}
      </CardContent>
    </Card>
  );
}

function Editor({
  level,
  id,
  layer,
  canWrite,
}: {
  level: EditLevel;
  id: string;
  layer: Layer;
  canWrite: boolean;
}) {
  const t = useTranslations('availabilityReopen');
  const qc = useQueryClient();
  const [choice, setChoice] = useState<AutoReopenChoice>(choiceOf(layer.settings.autoReopenAfterZ));
  const [ignore, setIgnore] = useState<IgnoreStockChoice>(
    ignoreStockChoiceOf(layer.settings.autoReopenIgnoreStock),
  );

  const inheritedMode = effectiveMode('inherit', layer.effective?.autoReopenAfterZ);
  const effective = effectiveMode(choice, layer.effective?.autoReopenAfterZ);
  const inheritedIgnore = effectiveIgnoreStock('inherit', layer.effective?.autoReopenIgnoreStock);
  const patch = autoReopenPatch(layer.settings, choice, ignore);
  const dirty = Object.keys(patch).length > 0;
  const source = layer.effectiveSources?.autoReopenAfterZ;

  const save = useMutation({
    mutationFn: () => saveLayer(level, id, patch as PosSettingsPatch),
    onSuccess: () => {
      toast.success(t('saved'));
      qc.invalidateQueries({ queryKey: ['availability-reopen-setting'] });
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, t('saveError'))),
  });

  const modeLabel = (m: AutoReopenMode) => t(`mode_${m}`);
  const modeItems = [
    { value: 'inherit', label: t('inheritWith', { value: modeLabel(inheritedMode.mode) }) },
    ...AUTO_REOPEN_MODES.map((m) => ({ value: m, label: modeLabel(m) })),
  ];
  const stockItems = [
    { value: 'inherit', label: t('inheritWith', { value: inheritedIgnore ? t('stockIgnore') : t('stockKeep') }) },
    { value: 'off', label: t('stockKeep') },
    { value: 'on', label: t('stockIgnore') },
  ];

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">{t(`editing_${level}`)}</p>

      <div className="space-y-1">
        <Label>{t('modeLabel')}</Label>
        <Select
          value={choice}
          onValueChange={(v) => setChoice(v as AutoReopenChoice)}
          items={modeItems}
          disabled={!canWrite}
        >
          <SelectTrigger className="w-full sm:w-96">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {modeItems.map((i) => (
              <SelectItem key={i.value} value={i.value} label={i.label}>
                {i.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t(`modeHint_${effective.mode}`)}</p>
        <div className="flex flex-wrap items-center gap-1 text-xs">
          <span className="text-muted-foreground">{t('effective')}:</span>
          <Badge variant={effective.mode === 'off' ? 'outline' : 'secondary'}>{modeLabel(effective.mode)}</Badge>
          {effective.from === 'inherited' && source ? (
            <span className="text-muted-foreground">{t('fromLevel', { level: t(`level_${source}`) })}</span>
          ) : effective.from === 'default' ? (
            <span className="text-muted-foreground">{t('fromDefault')}</span>
          ) : null}
        </div>
      </div>

      <div className="space-y-1">
        <Label>{t('stockLabel')}</Label>
        <Select
          value={ignore}
          onValueChange={(v) => setIgnore(v as IgnoreStockChoice)}
          items={stockItems}
          disabled={!canWrite || effective.mode === 'off'}
        >
          <SelectTrigger className="w-full sm:w-96">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {stockItems.map((i) => (
              <SelectItem key={i.value} value={i.value} label={i.label}>
                {i.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t('stockHint')}</p>
      </div>

      {effective.mode === 'all' ? (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">{t('allWarning')}</p>
      ) : null}

      <ul className="list-disc space-y-0.5 ps-5 text-xs text-muted-foreground">
        <li>{t('rulePermanent')}</li>
        <li>{t('ruleWhichZ')}</li>
        <li>{t('ruleLevels')}</li>
        <li>{t('ruleOffline')}</li>
      </ul>

      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!canWrite || !dirty || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? t('saving') : t('save')}
        </Button>
        {!canWrite ? <span className="text-xs text-muted-foreground">{t('readOnly')}</span> : null}
      </div>
    </div>
  );
}

function ReopenLog({ shopId }: { shopId: string }) {
  const t = useTranslations('availabilityReopen');
  const { data: runs = [], isLoading, isError } = useQuery<AvailabilityReopenRun[]>({
    queryKey: ['availability-reopens', shopId],
    queryFn: () =>
      api.get('/availability/reopens', { params: { shopId, limit: 20 } }).then((r) => r.data),
  });
  const when = (iso: string) => formatDateTime(iso);

  return (
    <div className="space-y-2 border-t pt-3">
      <p className="flex items-center gap-1.5 text-sm font-medium">
        <History className="size-4" aria-hidden />
        {t('logTitle')}
      </p>
      {isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : isError ? (
        <p className="text-sm text-destructive">{t('logError')}</p>
      ) : runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('logEmpty')}</p>
      ) : (
        <ul className="max-h-72 space-y-2 overflow-y-auto">
          {runs.map((run) => {
            const names = runItemNames(run);
            return (
              <li key={`${run.zReportId}:${run.level}:${run.targetId}`} className="rounded-md border p-2 text-xs">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-medium">{when(run.closedAt)}</span>
                  <Badge variant="outline">
                    {run.zNumber != null ? t('zNumber', { n: run.zNumber }) : t('zUnnumbered')}
                  </Badge>
                  <span>
                    {t(`level_${run.level}`)}
                    {run.targetName ? ` · ${run.targetName}` : ''}
                  </span>
                  <Badge variant="secondary">{t(`mode_${run.mode}`)}</Badge>
                </div>
                {names.reopened.length > 0 ? (
                  <p className="mt-1">
                    <span className="text-muted-foreground">{t('reopened', { count: names.reopened.length })}: </span>
                    {names.reopened.join(', ')}
                  </p>
                ) : null}
                {names.kept.length > 0 ? (
                  <p className="mt-1">
                    <span className="text-muted-foreground">{t('keptForStock', { count: names.kept.length })}: </span>
                    {names.kept.join(', ')}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
