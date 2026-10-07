'use client';

/**
 * "פרמטרי מגירה" (the drawer spec §17): the cash drawer's management parameters at one
 * level — company, shop, area (נקודת מכירה) or till. A level shows what it inherits and
 * what it sets itself; blank inherits. Stored as till parameters, so the till gets the
 * resolved value with the rest of its parameters.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { api, fetchShopAreas } from '@/lib/api';
import { useScope } from '@/lib/scope';
import { sameId } from '@/lib/entityLookup';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { SELECT } from './role-dialogs';

interface DrawerParam {
  key: string;
  label: string;
  description: string | null;
  valueType: 'boolean' | 'integer' | 'decimal' | 'string' | 'enum';
  enumOptions: string[] | null;
  defaultValue: unknown;
}

interface LevelView {
  scopeType: string;
  scopeId: string;
  own: Record<string, unknown>;
  inherited: Record<string, unknown>;
  parameters: DrawerParam[];
  canEdit: boolean;
}

type Level = { type: 'company' | 'shop' | 'area' | 'machine'; id: string };

const fetchLevel = (companyId: string, level: Level) =>
  api
    .get<LevelView>(`/companies/${companyId}/till-drawer-params`, { params: { scopeType: level.type, scopeId: level.id } })
    .then((r) => r.data);

/** What the editor keeps per key: '' = inherit; otherwise the typed text / chosen option. */
function toText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

function fromText(p: DrawerParam, text: string): unknown {
  if (text === '') return null;
  if (p.valueType === 'boolean') return text === 'true';
  if (p.valueType === 'integer') return Number.isInteger(Number(text)) ? Number(text) : undefined;
  if (p.valueType === 'decimal') return Number.isFinite(Number(text.replace(',', '.'))) ? Number(text.replace(',', '.')) : undefined;
  return text;
}

export function DrawerParamsTab({
  companyId,
  shopId,
  canEdit: canEditCompany,
}: {
  companyId: string;
  shopId: string | null;
  canEdit: boolean;
}) {
  const t = useTranslations('tillRoles.drawer');
  const { machines } = useScope();
  const [level, setLevel] = useState<Level>({ type: shopId ? 'shop' : 'company', id: shopId ?? companyId });
  const areas = useQuery({
    queryKey: ['shop-areas', shopId],
    queryFn: () => fetchShopAreas(shopId as string),
    enabled: !!shopId,
  });
  const shopMachines = useMemo(
    () => (shopId ? machines.filter((m) => sameId(m.shopId, shopId)) : []),
    [machines, shopId],
  );

  const options: Array<{ value: string; label: string }> = [
    { value: `company:${companyId}`, label: t('levels.company') },
    ...(shopId ? [{ value: `shop:${shopId}`, label: t('levels.shop') }] : []),
    ...(areas.data ?? []).map((a) => ({ value: `area:${a.id}`, label: `${t('levels.area')}: ${a.name}` })),
    ...shopMachines.map((m) => ({ value: `machine:${m.id}`, label: `${t('levels.machine')}: ${m.name}` })),
  ];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-sm">
          <span className="block text-xs text-muted-foreground">{t('level')}</span>
          <select
            className={`${SELECT} min-w-[16rem]`}
            value={`${level.type}:${level.id}`}
            onChange={(e) => {
              const [type, id] = e.target.value.split(':');
              setLevel({ type: type as Level['type'], id });
            }}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <p className="text-xs text-muted-foreground">{t('hint')}</p>
      </div>
      {!shopId ? <p className="text-xs text-muted-foreground">{t('pickShop')}</p> : null}
      <LevelCard key={`${level.type}:${level.id}`} companyId={companyId} level={level} canEditCompany={canEditCompany} />
    </div>
  );
}

function LevelCard({ companyId, level, canEditCompany }: { companyId: string; level: Level; canEditCompany: boolean }) {
  const t = useTranslations('tillRoles.drawer');
  const tr = useTranslations('tillRoles');
  const qc = useQueryClient();
  const view = useQuery({ queryKey: ['till-drawer-params', companyId, level.type, level.id], queryFn: () => fetchLevel(companyId, level) });
  const [edits, setEdits] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: async () => {
      const params = view.data?.parameters ?? [];
      const values: Record<string, unknown> = {};
      for (const [key, text] of Object.entries(edits)) {
        const p = params.find((x) => x.key === key);
        if (!p) continue;
        const value = fromText(p, text);
        if (value === undefined) throw new Error(`${p.label}: ${tr('limitInvalid')}`);
        values[key] = value;
      }
      const { data } = await api.put<LevelView>(`/companies/${companyId}/till-drawer-params`, {
        scopeType: level.type,
        scopeId: level.id,
        values,
      });
      return data;
    },
    onSuccess: (data) => {
      qc.setQueryData(['till-drawer-params', companyId, level.type, level.id], data);
      setEdits({});
      toast.success(t('saved'));
    },
    onError: (e: unknown) => toast.error(axiosErrorToToastMessage(e, tr('saveFailed'))),
  });

  if (view.isLoading) return <Skeleton className="h-64 w-full" />;
  if (!view.data) return <p className="text-sm text-destructive">{tr('loadError')}</p>;
  const data = view.data;
  const canEdit = data.canEdit || (level.type === 'company' && canEditCompany);
  const shown = (key: string) => (key in edits ? edits[key] : toText(data.own[key]));
  const describe = (p: DrawerParam, value: unknown) =>
    value === undefined || value === null
      ? '—'
      : p.valueType === 'boolean'
        ? value
          ? t('on')
          : t('off')
        : String(value);
  const dirty = Object.keys(edits).length > 0;

  return (
    <div className="space-y-2">
      <div className="divide-y rounded-lg border bg-card">
        {data.parameters.map((p) => {
          const inherited = data.inherited[p.key] ?? p.defaultValue;
          return (
            <div key={p.key} className="flex flex-wrap items-start gap-3 p-3">
              <div className="min-w-[16rem] flex-1 space-y-0.5">
                <div className="text-sm font-medium">{p.label}</div>
                {p.description ? <div className="text-xs text-muted-foreground">{p.description}</div> : null}
                <div className="text-xs text-muted-foreground">{t('inherited', { value: describe(p, inherited) })}</div>
              </div>
              <div className="w-56">
                {p.valueType === 'boolean' ? (
                  <select
                    className={SELECT}
                    aria-label={p.label}
                    disabled={!canEdit}
                    value={shown(p.key)}
                    onChange={(e) => setEdits((m) => ({ ...m, [p.key]: e.target.value }))}
                  >
                    <option value="">{t('clear')}</option>
                    <option value="true">{t('on')}</option>
                    <option value="false">{t('off')}</option>
                  </select>
                ) : p.valueType === 'enum' ? (
                  <select
                    className={SELECT}
                    aria-label={p.label}
                    disabled={!canEdit}
                    value={shown(p.key)}
                    onChange={(e) => setEdits((m) => ({ ...m, [p.key]: e.target.value }))}
                  >
                    <option value="">{t('clear')}</option>
                    {(p.enumOptions ?? []).map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input
                    className={SELECT}
                    aria-label={p.label}
                    inputMode="decimal"
                    dir="ltr"
                    disabled={!canEdit}
                    placeholder={describe(p, inherited)}
                    value={shown(p.key)}
                    onChange={(e) => setEdits((m) => ({ ...m, [p.key]: e.target.value }))}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
      {canEdit && dirty ? (
        <div className="sticky bottom-0 flex justify-end gap-2 border-t bg-background/90 py-3 backdrop-blur">
          <Button variant="outline" onClick={() => setEdits({})}>
            {tr('revert')}
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? tr('saving') : tr('save')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
