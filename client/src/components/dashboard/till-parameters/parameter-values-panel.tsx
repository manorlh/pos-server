'use client';

/**
 * One parameter's values per level, and the form that sets one.
 *
 * A value is set on a company, a shop, a point of sale (a shop area) or a single
 * till; each till takes the most specific one that applies to it, else the
 * parameter's default. The entity pickers list what the dashboard lists elsewhere —
 * the active organization's companies, shops, areas and tills — while the table
 * shows every value the server holds, with the names it resolved.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Pencil, Trash2 } from 'lucide-react';
import {
  deleteTillParameterValue,
  fetchCompanies,
  fetchMachines,
  fetchShops,
  fetchTillParameterValues,
  setTillParameterValue,
} from '@/lib/api';
import { findBySameId } from '@/lib/entityLookup';
import type {
  Company,
  PosMachine,
  Shop,
  TillParameter,
  TillParameterScope,
  TillParameterValue,
} from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  EMPTY_DRAFT,
  ParameterImageThumb,
  ParameterValueInput,
  draftToValue,
  useFormatParameterValue,
  valueToDraft,
  type ValueDraft,
} from './value-input';
import { useTillParameterErrorText } from './errors';
import { useShopAreas } from '../areas/use-shop-areas';

export const SCOPES: TillParameterScope[] = ['company', 'shop', 'area', 'machine'];

interface Option {
  value: string;
  label: string;
}

function OptionSelect({
  value,
  onChange,
  options,
  placeholder,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  options: Option[];
  placeholder: string;
  disabled?: boolean;
}) {
  return (
    <Select
      value={value || null}
      onValueChange={(v) => onChange(v ? String(v) : '')}
      items={options}
      disabled={disabled}
    >
      <SelectTrigger>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} label={o.label}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** An existing row being edited: its level and entity are fixed, only the value changes. */
interface EditingRow {
  scopeType: TillParameterScope;
  scopeId: string;
  label: string;
}

export function ParameterValuesPanel({ parameter }: { parameter: TillParameter }) {
  const t = useTranslations('tillParameters');
  const tv = useTranslations('tillParameters.values');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const errorText = useTillParameterErrorText();
  const formatValue = useFormatParameterValue();

  const [editing, setEditing] = useState<EditingRow | null>(null);
  const [level, setLevel] = useState<TillParameterScope | ''>('');
  const [companyId, setCompanyId] = useState('');
  const [shopId, setShopId] = useState('');
  const [areaId, setAreaId] = useState('');
  const [machineId, setMachineId] = useState('');
  const [draft, setDraft] = useState<ValueDraft>(EMPTY_DRAFT);

  const valuesKey = ['till-parameter-values', parameter.id];
  const { data: values = [], isLoading } = useQuery<TillParameterValue[]>({
    queryKey: valuesKey,
    queryFn: () => fetchTillParameterValues(parameter.id),
  });

  const { data: companies = [] } = useQuery<Company[]>({
    queryKey: ['companies'],
    queryFn: fetchCompanies,
    // Also names the company of each shop in the shop picker.
    enabled: level === 'company' || level === 'shop' || level === 'area',
  });
  const { data: shops = [] } = useQuery<Shop[]>({
    queryKey: ['shops'],
    queryFn: () => fetchShops(),
    enabled: level === 'shop' || level === 'area' || level === 'machine',
  });
  const { data: machines = [] } = useQuery<PosMachine[]>({
    queryKey: ['machines'],
    queryFn: fetchMachines,
    enabled: level === 'machine',
  });
  const { data: areas = [], isLoading: areasLoading } = useShopAreas(
    level === 'area' && shopId ? shopId : null,
  );

  const resetForm = () => {
    setEditing(null);
    setLevel('');
    setCompanyId('');
    setShopId('');
    setAreaId('');
    setMachineId('');
    setDraft(EMPTY_DRAFT);
  };

  // From editing a row to adding the same value for another entity — "this value, but
  // for till 3" — keeping what was typed. The row being edited stays as it is.
  const switchToAdd = (preset: TillParameterScope) => {
    setEditing(null);
    setLevel(preset);
    setCompanyId('');
    setShopId('');
    setAreaId('');
    setMachineId('');
  };

  const scopeId = editing
    ? editing.scopeId
    : level === 'company'
      ? companyId
      : level === 'shop'
        ? shopId
        : level === 'area'
          ? areaId
          : level === 'machine'
            ? machineId
            : '';
  const scopeType = editing ? editing.scopeType : level;
  const imageKind = parameter.widget === 'image' ? (parameter.imageKind ?? null) : null;
  const value = draftToValue(parameter.valueType, draft, parameter.enumOptions, imageKind);
  const canSave = !!scopeType && !!scopeId && value !== null;
  // "ניהול שולחנות = קופה אחת" above a single till means every till under it runs its
  // own tables; choosing *which* till is a value on that till.
  const singleTillHint =
    parameter.key === 'tablesMode' && value === 'קופה אחת' && !!scopeType && scopeType !== 'machine';

  const save = useMutation({
    mutationFn: () =>
      setTillParameterValue(parameter.id, {
        scopeType: scopeType as TillParameterScope,
        scopeId,
        value: value as NonNullable<typeof value>,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: valuesKey });
      qc.invalidateQueries({ queryKey: ['till-parameters'] });
      toast.success(tv('saved'));
      resetForm();
    },
    onError: (err: unknown) => toast.error(errorText(err, tc('error'))),
  });

  const remove = useMutation({
    mutationFn: (valueId: string) => deleteTillParameterValue(parameter.id, valueId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: valuesKey });
      qc.invalidateQueries({ queryKey: ['till-parameters'] });
      toast.success(tv('deleted'));
    },
    onError: (err: unknown) => toast.error(errorText(err, tc('error'))),
  });

  const levelItems = SCOPES.map((s) => ({ value: s, label: t(`levels.${s}`) }));
  const shopLabel = (s: Shop) => {
    const company = findBySameId(companies, s.companyId);
    return company ? `${s.name} · ${company.name}` : s.name;
  };
  // "קופה מס׳ 3 · קופה בר" — the till's number first, as the till itself shows it.
  const tillNumber = (m: PosMachine) => {
    const n = Number(m.posNumber);
    return Number.isFinite(n) && n > 0 ? n : Number.MAX_SAFE_INTEGER;
  };
  const tillLabel = (m: PosMachine) => {
    const n = m.posNumber;
    return n ? `${tv('tillNumber', { n: String(n) })} · ${m.name}` : m.name;
  };
  const machineLabel = (m: PosMachine) => {
    const shop = m.shopId ? findBySameId(shops, m.shopId) : undefined;
    return shop ? `${tillLabel(m)} · ${shop.name}` : tillLabel(m);
  };

  const entityLabel = (row: TillParameterValue) =>
    row.scopeName
      ? row.scopeContext
        ? `${row.scopeName} · ${row.scopeContext}`
        : row.scopeName
      : tv('deletedEntity');

  const hasDefault = parameter.defaultValue !== null && parameter.defaultValue !== undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{tv('title', { label: parameter.label })}</CardTitle>
        <p className="text-muted-foreground text-sm">
          <span className="font-mono" dir="ltr">
            {parameter.key}
          </span>
          {' · '}
          {imageKind ? t('image') : t(`types.${parameter.valueType}`)}
          {' · '}
          {t('default')}:{' '}
          {hasDefault && !imageKind ? formatValue(parameter.defaultValue) : null}
          {hasDefault && imageKind ? (
            <span className="font-mono" dir="ltr">
              {String(parameter.defaultValue)}
            </span>
          ) : null}
          {!hasDefault ? t('noDefault') : null}
        </p>
        {!parameter.isActive ? (
          <p className="text-sm text-amber-600 dark:text-amber-400">{tv('inactiveNote')}</p>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="rounded-lg border overflow-hidden">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tv('level')}</TableHead>
                <TableHead>{tv('entity')}</TableHead>
                <TableHead>{tv('value')}</TableHead>
                <TableHead className="w-20" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow>
                  <TableCell colSpan={4}>
                    <Skeleton className="h-4 w-full" />
                  </TableCell>
                </TableRow>
              ) : values.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                    {hasDefault ? tv('empty') : tv('emptyNoDefault')}
                  </TableCell>
                </TableRow>
              ) : (
                values.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>
                      <Badge variant="outline">{t(`levels.${row.scopeType}`)}</Badge>
                    </TableCell>
                    <TableCell className={row.scopeName ? '' : 'text-muted-foreground'}>
                      {entityLabel(row)}
                    </TableCell>
                    <TableCell className="font-medium" dir="auto">
                      {imageKind ? (
                        <ParameterImageThumb url={String(row.value)} alt={parameter.label} />
                      ) : (
                        formatValue(row.value)
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          title={tc('edit')}
                          onClick={() => {
                            setEditing({
                              scopeType: row.scopeType,
                              scopeId: row.scopeId,
                              label: `${t(`levels.${row.scopeType}`)}: ${entityLabel(row)}`,
                            });
                            setDraft(valueToDraft(row.value));
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title={tc('delete')}
                          className="text-destructive hover:text-destructive"
                          disabled={remove.isPending}
                          onClick={() => {
                            if (window.confirm(tv('deleteConfirm'))) remove.mutate(row.id);
                          }}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        <div className="space-y-3 rounded-lg border p-3">
          <p className="text-sm font-medium">{editing ? tv('formEdit') : tv('formAdd')}</p>
          {editing ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <p className="text-sm">{editing.label}</p>
              <Button size="sm" variant="link" className="h-auto p-0" onClick={() => switchToAdd('machine')}>
                {tv('applyToOther')}
              </Button>
            </div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>{tv('level')}</Label>
                <OptionSelect
                  value={level}
                  onChange={(v) => {
                    setLevel(v as TillParameterScope | '');
                    setCompanyId('');
                    setShopId('');
                    setAreaId('');
                    setMachineId('');
                  }}
                  options={levelItems}
                  placeholder={tv('chooseLevel')}
                />
              </div>
              {level === 'company' ? (
                <div className="space-y-1">
                  <Label>{t('levels.company')}</Label>
                  <OptionSelect
                    value={companyId}
                    onChange={setCompanyId}
                    options={companies.map((c) => ({ value: c.id, label: c.name }))}
                    placeholder={tv('chooseCompany')}
                  />
                </div>
              ) : null}
              {level === 'shop' || level === 'area' ? (
                <div className="space-y-1">
                  <Label>{t('levels.shop')}</Label>
                  <OptionSelect
                    value={shopId}
                    onChange={(v) => {
                      setShopId(v);
                      setAreaId('');
                    }}
                    options={shops.map((s) => ({ value: s.id, label: shopLabel(s) }))}
                    placeholder={tv('chooseShop')}
                  />
                </div>
              ) : null}
              {level === 'area' && shopId ? (
                <div className="space-y-1">
                  <Label>{t('levels.area')}</Label>
                  {areasLoading ? (
                    <Skeleton className="h-8 w-full" />
                  ) : areas.length === 0 ? (
                    <p className="text-muted-foreground text-sm">{tv('noAreas')}</p>
                  ) : (
                    <OptionSelect
                      value={areaId}
                      onChange={setAreaId}
                      options={areas.map((a) => ({ value: a.id, label: a.name }))}
                      placeholder={tv('chooseArea')}
                    />
                  )}
                </div>
              ) : null}
              {level === 'machine' ? (
                <>
                  {/* The shop first, then its tills by number — "קופה 1" alone says
                      nothing when every shop has one. */}
                  <div className="space-y-1">
                    <Label>{t('levels.shop')}</Label>
                    <OptionSelect
                      value={shopId}
                      onChange={(v) => {
                        setShopId(v);
                        setMachineId('');
                      }}
                      options={shops.map((s) => ({ value: s.id, label: shopLabel(s) }))}
                      placeholder={tv('chooseShop')}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>{t('levels.machine')}</Label>
                    <OptionSelect
                      value={machineId}
                      onChange={setMachineId}
                      options={machines
                        .filter((m) => !shopId || String(m.shopId) === String(shopId))
                        .sort((a, b) => tillNumber(a) - tillNumber(b) || a.name.localeCompare(b.name, 'he'))
                        .map((m) => ({ value: m.id, label: shopId ? tillLabel(m) : machineLabel(m) }))}
                      placeholder={tv('chooseMachine')}
                    />
                  </div>
                </>
              ) : null}
            </div>
          )}
          {editing || level ? (
            <div className="space-y-1">
              <Label>{tv('value')}</Label>
              <ParameterValueInput
                type={parameter.valueType}
                enumOptions={parameter.enumOptions}
                imageKind={imageKind}
                draft={draft}
                onChange={setDraft}
                disabled={save.isPending}
              />
            </div>
          ) : null}
          {singleTillHint ? (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200">
              <span className="flex-1">{tv('singleTillHint')}</span>
              <Button size="sm" variant="outline" onClick={() => switchToAdd('machine')}>
                {tv('chooseTill')}
              </Button>
            </div>
          ) : null}
          {!editing ? <p className="text-muted-foreground text-xs">{tv('entityHint')}</p> : null}
          <div className="flex gap-2">
            <Button size="sm" disabled={!canSave || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? tc('saving') : tc('save')}
            </Button>
            {editing || level ? (
              <Button size="sm" variant="outline" onClick={resetForm}>
                {tc('cancel')}
              </Button>
            ) : null}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
