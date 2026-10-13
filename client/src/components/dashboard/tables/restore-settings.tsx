'use client';

/**
 * "שחזור ותשלומים" (pos-server app/services/table_restore.py, P:/specs/table-restore-payments.md §3, §5):
 * the eight till parameters of restoring a closed table with its payments, reversing payments inside a
 * table and the bill with a balance — at one level: company, shop, point of sale or till. A level shows
 * what it inherits and what it sets itself; "ירושה" inherits. Stored as till parameters: the till gets
 * the resolved value with the rest of its parameters. Who restores and reverses is the roles editor's.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { api, fetchShopAreas } from '@/lib/api';
import { useScope } from '@/lib/scope';
import { sameId } from '@/lib/entityLookup';
import {
  METHODS,
  NO_METHODS,
  WINDOW_KINDS,
  changedValues,
  editError,
  formatWindow,
  parseMethods,
  parseWindow,
  textOf,
  toggleMethod,
  type RestoreLevel,
  type RestoreLevelView,
  type RestoreParam,
  type WindowKind,
} from '@/lib/tableRestore';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

const SELECT =
  'border-input bg-background h-9 w-full rounded-md border px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60';

type Level = { type: RestoreLevel; id: string };

const queryKey = (companyId: string, level: Level) => ['table-restore-params', companyId, level.type, level.id];

const fetchLevel = (companyId: string, level: Level) =>
  api
    .get<RestoreLevelView>(`/companies/${companyId}/table-restore-params`, {
      params: { scopeType: level.type, scopeId: level.id },
    })
    .then((r) => r.data);

export function RestoreSettings({ companyId: picked, shopId }: { companyId: string; shopId: string }) {
  const t = useTranslations('tables.restore');
  const { machines, shops } = useScope();
  // The page's company, else the shop's own (a shop picked on its own).
  const companyId = picked || shops.find((s) => sameId(s.id, shopId))?.companyId || '';
  const [level, setLevel] = useState<Level>({ type: 'shop', id: shopId });
  const areas = useQuery({ queryKey: ['shop-areas', shopId], queryFn: () => fetchShopAreas(shopId), enabled: !!shopId });
  const shopMachines = useMemo(() => machines.filter((m) => sameId(m.shopId, shopId)), [machines, shopId]);

  const options: Array<{ value: string; label: string }> = [
    ...(companyId ? [{ value: `company:${companyId}`, label: t('levels.company') }] : []),
    { value: `shop:${shopId}`, label: t('levels.shop') },
    ...(areas.data ?? []).map((a) => ({ value: `area:${a.id}`, label: `${t('levels.area')}: ${a.name}` })),
    ...shopMachines.map((m) => ({ value: `machine:${m.id}`, label: `${t('levels.machine')}: ${m.name}` })),
  ];

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-lg font-semibold">{t('title')}</h2>
        <p className="max-w-3xl text-sm text-muted-foreground">{t('hint')}</p>
      </div>
      <div className="flex flex-wrap items-end gap-3">
        <label className="space-y-1 text-sm">
          <span className="block text-xs text-muted-foreground">{t('level')}</span>
          <select
            className={`${SELECT} min-w-[16rem]`}
            value={`${level.type}:${level.id}`}
            onChange={(e) => {
              const [type, id] = e.target.value.split(':');
              setLevel({ type: type as RestoreLevel, id });
            }}
          >
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <p className="text-xs text-muted-foreground">
          <Link href="/dashboard/till-roles" className="text-primary underline">
            {t('permissionsHint')}
          </Link>
        </p>
      </div>
      {companyId ? (
        <LevelCard key={`${level.type}:${level.id}`} companyId={companyId} level={level} />
      ) : (
        <Skeleton className="h-64 w-full" />
      )}
    </div>
  );
}

function LevelCard({ companyId, level }: { companyId: string; level: Level }) {
  const t = useTranslations('tables.restore');
  const qc = useQueryClient();
  const view = useQuery({ queryKey: queryKey(companyId, level), queryFn: () => fetchLevel(companyId, level) });
  const [edits, setEdits] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: async () => {
      const data = view.data!;
      const types = Object.fromEntries(data.parameters.map((p) => [p.key, p.valueType]));
      const values = changedValues(data.own, edits, types);
      const { data: saved } = await api.put<RestoreLevelView>(`/companies/${companyId}/table-restore-params`, {
        scopeType: level.type,
        scopeId: level.id,
        values,
      });
      return saved;
    },
    onSuccess: (data) => {
      qc.setQueryData(queryKey(companyId, level), data);
      setEdits({});
      toast.success(t('saved'));
    },
    onError: (e: unknown) => toast.error(axiosErrorToToastMessage(e, t('saveFailed'))),
  });

  if (view.isLoading) return <Skeleton className="h-64 w-full" />;
  if (!view.data) return <p className="text-sm text-destructive">{t('loadError')}</p>;
  const data = view.data;
  const canEdit = data.canEdit;
  const shown = (key: string) => (key in edits ? edits[key] : textOf(key, data.own[key]));
  const set = (key: string, text: string) => setEdits((m) => ({ ...m, [key]: text }));
  const name = (p: RestoreParam) => (t.has(`names.${p.key}`) ? t(`names.${p.key}`) : p.label);
  const optionLabel = (p: RestoreParam, v: string) => {
    const path = `options.${p.key}.${v}`;
    return t.has(path) ? t(path) : (p.enumLabels?.[v] ?? v);
  };
  const methodLabel = (m: string) => (t.has(`methods.${m}`) ? t(`methods.${m}`) : m);
  const windowLabel = (value: unknown) => {
    const { kind, hours } = parseWindow(value);
    return kind === 'hours' ? t('window.hoursValue', { hours: hours ?? 0 }) : t(`window.${kind}`);
  };
  const describe = (p: RestoreParam, value: unknown): string => {
    if (value === undefined || value === null) return '—';
    if (p.valueType === 'boolean') return value ? t('on') : t('off');
    if (p.key === 'restoreWindow') return windowLabel(value);
    if (p.key === 'reverseMethods') {
      const list = parseMethods(value);
      return list.length ? list.map(methodLabel).join(', ') : t('methodsNone');
    }
    if (p.valueType === 'enum') return optionLabel(p, String(value));
    return String(value);
  };
  const errors = data.parameters
    .filter((p) => p.key in edits && editError(p.key, edits[p.key]))
    .map((p) => t('invalid', { label: name(p) }));
  const dirty = Object.keys(changedValues(data.own, edits, {})).length > 0;

  return (
    <div className="space-y-2">
      {!canEdit ? <p className="text-xs text-muted-foreground">{t('readOnly')}</p> : null}
      <div className="divide-y rounded-lg border bg-card">
        {data.parameters.map((p) => {
          const inherited = data.inherited[p.key] ?? p.defaultValue;
          const text = shown(p.key);
          const own = data.own[p.key] !== undefined && data.own[p.key] !== null;
          return (
            <div key={p.key} className="flex flex-wrap items-start gap-3 p-3">
              <div className="min-w-[16rem] flex-1 space-y-0.5">
                <div className="text-sm font-medium">
                  {name(p)}
                  {own ? <span className="ms-2 text-xs font-normal text-primary">{t('own')}</span> : null}
                </div>
                <div className="text-xs text-muted-foreground">{t.has(`hints.${p.key}`) ? t(`hints.${p.key}`) : p.description}</div>
                <div className="text-xs text-muted-foreground">{t('inherited', { value: describe(p, inherited) })}</div>
              </div>
              <div className="w-64 space-y-2">
                <Editor
                  p={p}
                  text={text}
                  inherited={inherited}
                  disabled={!canEdit}
                  onChange={(v) => set(p.key, v)}
                  optionLabel={(v) => optionLabel(p, v)}
                  methodLabel={methodLabel}
                  describe={(v) => describe(p, v)}
                />
              </div>
            </div>
          );
        })}
      </div>
      {errors.length ? (
        <ul className="text-sm text-destructive">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
      {canEdit && dirty ? (
        <div className="sticky bottom-0 flex justify-end gap-2 border-t bg-background/90 py-3 backdrop-blur">
          <Button variant="outline" onClick={() => setEdits({})}>
            {t('revert')}
          </Button>
          <Button onClick={() => save.mutate()} disabled={save.isPending || errors.length > 0}>
            {save.isPending ? t('saving') : t('save')}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function Editor({
  p,
  text,
  inherited,
  disabled,
  onChange,
  optionLabel,
  methodLabel,
  describe,
}: {
  p: RestoreParam;
  text: string;
  inherited: unknown;
  disabled: boolean;
  onChange: (text: string) => void;
  optionLabel: (v: string) => string;
  methodLabel: (m: string) => string;
  describe: (v: unknown) => string;
}) {
  const t = useTranslations('tables.restore');

  if (p.key === 'restoreWindow') {
    // "hours:" while its number is being typed is still hours (refused on save until it is 1–720).
    const typingHours = text.startsWith('hours:');
    const { kind, hours } =
      text === '' ? { kind: '' as const, hours: null } : typingHours ? { kind: 'hours' as const, hours: null } : parseWindow(text);
    const hoursText = typingHours ? text.slice('hours:'.length) : String(hours ?? '');
    return (
      <>
        <select
          className={SELECT}
          aria-label={p.label}
          disabled={disabled}
          value={kind}
          onChange={(e) => {
            const next = e.target.value as WindowKind | '';
            if (next === '') onChange('');
            else onChange(next === 'hours' ? `hours:${hours ?? 24}` : (formatWindow(next, null) ?? ''));
          }}
        >
          <option value="">{t('inherit')}</option>
          {WINDOW_KINDS.map((k) => (
            <option key={k} value={k}>
              {t(`window.${k}`)}
            </option>
          ))}
        </select>
        {kind === 'hours' ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              className={`${SELECT} w-24`}
              inputMode="numeric"
              dir="ltr"
              disabled={disabled}
              aria-label={t('window.hoursLabel')}
              value={hoursText}
              onChange={(e) => onChange(`hours:${e.target.value.replace(/[^0-9]/g, '')}`)}
            />
            {t('window.hoursLabel')}
          </label>
        ) : null}
      </>
    );
  }

  if (p.key === 'reverseMethods') {
    const custom = text !== '';
    const value = text === NO_METHODS ? '' : text;
    const on = new Set(parseMethods(value));
    return (
      <>
        <select
          className={SELECT}
          aria-label={p.label}
          disabled={disabled}
          value={custom ? 'set' : ''}
          onChange={(e) => {
            if (e.target.value === '') onChange('');
            else onChange(typeof inherited === 'string' && inherited ? inherited : NO_METHODS);
          }}
        >
          <option value="">{t('inherit')}</option>
          <option value="set">{t('own')}</option>
        </select>
        {custom ? (
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {METHODS.map((m) => (
              <label key={m} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  className="size-4"
                  disabled={disabled}
                  checked={on.has(m)}
                  onChange={() => {
                    const next = toggleMethod(value, m);
                    onChange(next === '' ? NO_METHODS : next);
                  }}
                />
                {methodLabel(m)}
              </label>
            ))}
          </div>
        ) : null}
      </>
    );
  }

  if (p.valueType === 'boolean' || p.valueType === 'enum') {
    return (
      <select
        className={SELECT}
        aria-label={p.label}
        disabled={disabled}
        value={text}
        onChange={(e) => onChange(e.target.value)}
      >
        <option value="">{t('inherit')}</option>
        {p.valueType === 'boolean' ? (
          <>
            <option value="true">{t('on')}</option>
            <option value="false">{t('off')}</option>
          </>
        ) : (
          (p.enumOptions ?? []).map((o) => (
            <option key={o} value={o}>
              {optionLabel(o)}
            </option>
          ))
        )}
      </select>
    );
  }

  return (
    <input
      className={SELECT}
      aria-label={p.label}
      disabled={disabled}
      placeholder={describe(inherited)}
      value={text}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
