'use client';

/**
 * "מצב לא מקוון" on the device page (P:/specs/nayax-deferred-all.md §1, §10): whether this till is a
 * "קופה מנהלת מצב לא מקוון" — the till that shows "מסופונים ברשת — מצב לא מקוון" — and its own values of the
 * automatic switch to offline (`deferredAutoOn`, the failures, the seconds, "the whole shop"), each with
 * what it inherits. The controllers' list is kept at the SHOP's level (`deferredControlTills`), so every
 * till of the shop knows the feature is on; this switch adds or removes this till there. Hidden for a
 * user the server refuses (not one of the shop's managers).
 */

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CloudOff } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import type { DeviceDeferredKey, DeviceDeferredView } from '@/lib/deferredTerminals';
import {
  deferredTerminalsKeys,
  fetchDeviceDeferred,
  saveDeviceDeferred,
  setDeferredController,
} from '@/lib/deferredTerminalsApi';
import { buttonVariants, Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

type Scalar = string | number | boolean | null;
/** '' — the till sets nothing (it inherits). */
type Draft = Record<string, string>;

const INHERIT = '__inherit__';

function toDraft(value: Scalar): string {
  return value === null || value === undefined ? '' : String(value);
}

function fromDraft(key: DeviceDeferredKey, text: string): Scalar {
  if (text === '') return null;
  if (key.valueType === 'boolean') return text === 'true';
  if (key.valueType === 'integer') return Number.parseInt(text, 10);
  return text;
}

export function DeferredTerminalCard({ machineId, shopId }: { machineId: string; shopId: string }) {
  const t = useTranslations('deferredTerminals.device');
  const qc = useQueryClient();
  const { data: view, isLoading, isError } = useQuery<DeviceDeferredView>({
    queryKey: deferredTerminalsKeys.device(machineId),
    queryFn: () => fetchDeviceDeferred(machineId),
    retry: false,
  });
  const [draft, setDraft] = useState<Draft | null>(null);

  const controller = useMutation({
    mutationFn: (on: boolean) => setDeferredController(shopId, machineId, on),
    onSuccess: (_out, on) => {
      toast.success(on ? t('controllerOn') : t('controllerOff'));
      qc.invalidateQueries({ queryKey: deferredTerminalsKeys.all });
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, t('saveError'))),
  });

  const save = useMutation({
    mutationFn: (values: Record<string, Scalar>) => saveDeviceDeferred(machineId, values),
    onSuccess: (next) => {
      toast.success(t('saved'));
      qc.setQueryData(deferredTerminalsKeys.device(machineId), next);
      setDraft(null);
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, t('saveError'))),
  });

  // Not one of the shop's managers (or no such till): the server says so — nothing to show.
  if (isError) return null;

  const own: Draft = Object.fromEntries((view?.keys ?? []).map((k) => [k.key, toDraft(k.own)]));
  const current = draft ?? own;
  const changed = (view?.keys ?? []).filter((k) => (current[k.key] ?? '') !== (own[k.key] ?? ''));
  const valid = changed.every((k) => {
    if (k.valueType !== 'integer' || current[k.key] === '') return true;
    const n = Number(current[k.key]);
    return Number.isInteger(n) && (k.min == null || n >= k.min) && (k.max == null || n <= k.max);
  });
  const switchId = `deferred-controller-${machineId}`;

  return (
    <Card id="deferred-terminal">
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="space-y-1">
            <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
              <CloudOff className="size-4" aria-hidden />
              {t('title')}
            </CardTitle>
            <p className="text-xs text-muted-foreground">{t('hint')}</p>
          </div>
          <Link
            href="/dashboard/deferred-terminals"
            className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), 'min-h-9')}
          >
            {t('openPage')}
          </Link>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading || !view ? (
          <Skeleton className="h-24 w-full" />
        ) : (
          <>
            <div className="space-y-1">
              <div className="flex min-h-11 items-center justify-between gap-3 rounded-lg border px-3 py-2">
                <Label htmlFor={switchId}>{t('controller')}</Label>
                <Switch
                  id={switchId}
                  checked={view.isController}
                  disabled={!view.canEditController || controller.isPending}
                  onCheckedChange={(on) => controller.mutate(!!on)}
                />
              </div>
              <p className="text-xs text-muted-foreground">{t('controllerHint')}</p>
              {!view.capable ? <p className="text-xs text-amber-700 dark:text-amber-300">{t('needsUpdate')}</p> : null}
            </div>

            <div className="space-y-3">
              <p className="text-sm font-medium">{t('autoTitle')}</p>
              {view.keys.map((k) => (
                <KeyField
                  key={k.key}
                  field={k}
                  value={current[k.key] ?? ''}
                  disabled={!view.canEdit || save.isPending}
                  onChange={(text) => setDraft({ ...current, [k.key]: text })}
                />
              ))}
              {view.canEdit ? (
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={changed.length === 0 || !valid || save.isPending}
                    onClick={() => save.mutate(Object.fromEntries(changed.map((k) => [k.key, fromDraft(k, current[k.key] ?? '')])))}
                  >
                    {t('save')}
                  </Button>
                  {changed.length > 0 ? (
                    <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>
                      {t('discard')}
                    </Button>
                  ) : null}
                </div>
              ) : (
                <p className="text-xs text-muted-foreground">{t('readOnly')}</p>
              )}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function shown(field: DeviceDeferredKey, value: Scalar, yes: string, no: string): string {
  if (value === null || value === undefined) return '—';
  if (field.valueType === 'boolean') return value ? yes : no;
  if (field.valueType === 'enum') return field.enumLabels?.[String(value)] ?? String(value);
  return String(value);
}

function KeyField({
  field,
  value,
  disabled,
  onChange,
}: {
  field: DeviceDeferredKey;
  value: string;
  disabled: boolean;
  onChange: (text: string) => void;
}) {
  const t = useTranslations('deferredTerminals.device');
  const id = `deferred-${field.key}`;
  const inherited = t('inherits', { value: shown(field, field.inherited, t('yes'), t('no')) });
  if (field.valueType === 'integer') {
    return (
      <div className="space-y-1">
        <Label htmlFor={id}>{field.label}</Label>
        <div className="flex items-center gap-2">
          <Input
            id={id}
            type="number"
            inputMode="numeric"
            dir="ltr"
            className="max-w-32"
            min={field.min ?? undefined}
            max={field.max ?? undefined}
            value={value}
            placeholder={shown(field, field.inherited, '', '')}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value.trim())}
          />
          {value !== '' ? (
            <Button size="sm" variant="ghost" disabled={disabled} onClick={() => onChange('')}>
              {t('clear')}
            </Button>
          ) : null}
        </div>
        <p className="text-xs text-muted-foreground">
          {value === '' ? inherited : t('range', { min: field.min ?? '', max: field.max ?? '' })}
        </p>
      </div>
    );
  }
  const options =
    field.valueType === 'boolean'
      ? [
          { value: 'true', label: t('yes') },
          { value: 'false', label: t('no') },
        ]
      : (field.enumOptions ?? []).map((o) => ({ value: o, label: field.enumLabels?.[o] ?? o }));
  const items = [{ value: INHERIT, label: inherited }, ...options];
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{field.label}</Label>
      <Select
        value={value === '' ? INHERIT : value}
        onValueChange={(v) => onChange(!v || v === INHERIT ? '' : String(v))}
        items={items}
        disabled={disabled}
      >
        <SelectTrigger id={id} className="max-w-sm">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((i) => (
            <SelectItem key={i.value} value={i.value} label={i.label}>
              {i.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
