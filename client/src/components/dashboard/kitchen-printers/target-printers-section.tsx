'use client';

/**
 * "מדפסות בונים" inside the product and category edit forms (SPEC §4.4).
 *
 * Printers hang on whole categories: a product prints where its category does — the
 * category it is in now, so a product added or moved later follows by itself — and a
 * sub-category where its parent does. Here a product (or category) can instead name its
 * own printers, or "no ticket"; "inherit" clears that again. What it inherits is shown by
 * name ("לפי המחלקה: בר, מטבח").
 *
 * Printers belong to a shop, a product to the whole catalog, so the section works on one
 * shop: the one in the scope bar, or one picked here. It saves on its own button, like
 * the availability section beside it.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useScope } from '@/lib/scope';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  fetchTargetRoute,
  saveTargetRoute,
  type ProductRouteMode,
  type TargetRoute,
} from '@/lib/kitchenPrintersApi';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { SimpleSelect } from './printer-dialog';

export function TargetPrintersSection({ kind, id }: { kind: 'product' | 'category'; id: string }) {
  const t = useTranslations('kitchenPrinters.target');
  const tc = useTranslations('common');
  const scope = useScope();
  const qc = useQueryClient();
  const [pickedShop, setPickedShop] = useState<string | null>(null);
  const shopId = scope.shopId ?? pickedShop ?? '';
  const queryKey = ['kitchen-target-route', kind, id, shopId];

  const { data, isLoading, isError } = useQuery({
    queryKey,
    queryFn: () => fetchTargetRoute(shopId, kind, id),
    enabled: !!shopId && !!id,
    retry: false,
  });

  // Unsaved choice over what the cloud has; null = untouched.
  const [edit, setEdit] = useState<{ key: string; mode: ProductRouteMode; ids: string[] } | null>(null);
  const editKey = `${kind}:${id}:${shopId}`;
  const current = edit && edit.key === editKey ? edit : null;
  const mode: ProductRouteMode = current?.mode ?? data?.mode ?? 'inherit';
  const ids = current?.ids ?? data?.printerIds ?? [];

  const save = useMutation({
    mutationFn: () => saveTargetRoute(shopId, kind, id, mode, mode === 'printers' ? ids : []),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['kitchen-target-route', kind, id] });
      qc.invalidateQueries({ queryKey: ['kitchen-printer-routing', shopId] });
      setEdit(null);
      toast.success(t('saved'));
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  const names = useMemo(() => new Map((data?.printers ?? []).map((p) => [p.id, p.name])), [data]);
  const inherited = (data?.inheritedPrinterIds ?? []).map((pid) => names.get(pid) ?? '?');
  const inheritLabel =
    kind === 'product'
      ? t('inheritCategory', { printers: inherited.join(', ') || t('nothing') })
      : t('inheritParent', { printers: inherited.join(', ') || t('nothing') });

  const set = (nextMode: ProductRouteMode, nextIds: string[]) =>
    setEdit({ key: editKey, mode: nextMode, ids: nextIds });

  const shopOptions = scope.shops.map((s) => ({ value: s.id, label: s.name }));
  const dirty = current !== null;
  const invalid = mode === 'printers' && ids.length === 0;

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div>
        <div className="font-medium">{t('title')}</div>
        <p className="text-xs text-muted-foreground">{kind === 'product' ? t('hintProduct') : t('hintCategory')}</p>
      </div>

      {!scope.shopId && (
        <div className="space-y-1">
          <Label>{t('shop')}</Label>
          <SimpleSelect
            value={pickedShop ?? ''}
            onChange={(v) => setPickedShop(v || null)}
            options={[{ value: '', label: t('chooseShop') }, ...shopOptions]}
            ariaLabel={t('shop')}
          />
        </div>
      )}

      {!shopId ? null : isLoading ? (
        <p className="text-sm text-muted-foreground">{tc('loading')}</p>
      ) : isError || !data ? (
        <p className="text-sm text-muted-foreground">{t('unavailable')}</p>
      ) : data.printers.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('noPrinters')}</p>
      ) : (
        <TargetChoices data={data} mode={mode} ids={ids} inheritLabel={inheritLabel} onChange={set} />
      )}

      {data && data.printers.length > 0 && (
        <div className="flex items-center gap-2">
          <Button size="sm" disabled={!dirty || invalid || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? tc('saving') : t('save')}
          </Button>
          {invalid && <span className="text-xs text-destructive">{t('pickOne')}</span>}
        </div>
      )}
    </div>
  );
}

function TargetChoices({
  data,
  mode,
  ids,
  inheritLabel,
  onChange,
}: {
  data: TargetRoute;
  mode: ProductRouteMode;
  ids: string[];
  inheritLabel: string;
  onChange: (mode: ProductRouteMode, ids: string[]) => void;
}) {
  const t = useTranslations('kitchenPrinters.target');
  return (
    <div className="space-y-2 text-sm">
      <label className="flex items-center gap-2">
        <input type="radio" checked={mode === 'inherit'} onChange={() => onChange('inherit', ids)} />
        {inheritLabel}
      </label>
      <label className="flex items-center gap-2">
        <input type="radio" checked={mode === 'printers'} onChange={() => onChange('printers', ids)} />
        {t('printers')}
      </label>
      {mode === 'printers' && (
        <div className="flex flex-wrap gap-3 ps-6">
          {data.printers
            .filter((p) => p.isActive || ids.includes(p.id))
            .map((p) => (
              <label key={p.id} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={ids.includes(p.id)}
                  onChange={(e) =>
                    onChange('printers', e.target.checked ? [...ids, p.id] : ids.filter((x) => x !== p.id))
                  }
                />
                {p.name}
              </label>
            ))}
        </div>
      )}
      <label className="flex items-center gap-2">
        <input type="radio" checked={mode === 'none'} onChange={() => onChange('none', ids)} />
        {t('none')}
      </label>
    </div>
  );
}
