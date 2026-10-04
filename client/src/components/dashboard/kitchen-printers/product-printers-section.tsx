'use client';

/**
 * "מדפסות בונים" in the product edit form (SPEC §4.4).
 *
 * On top, the item itself, in every shop — two one-tap controls and what they changed:
 * "ללא בון" (no kitchen ticket anywhere) and "אפס להגדרת המחלקה" (every product-level
 * setting in every shop removed), with where the item prints now ("מודפס ב: מטבח חם, בר
 * (לפי מחלקה)" / "ללא בון (הגדרת פריט)").
 *
 * Below, for one shop (the scope bar's, or one picked here): by the category, or printers
 * of its own there — saved on its own button, like the availability section beside it.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useScope } from '@/lib/scope';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  fetchProductKitchen,
  saveProductRoute,
  type ProductKitchenState,
  type ProductRouteMode,
} from '@/lib/kitchenPrintersApi';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { SimpleSelect } from './printer-dialog';
import { ProductKitchenControls, effectiveText, productWideText } from './product-kitchen-controls';

export function ProductPrintersSection({ productId }: { productId: string }) {
  const t = useTranslations('kitchenPrinters.target');
  const tw = useTranslations('kitchenPrinters.productWide');
  const tc = useTranslations('common');
  const scope = useScope();
  const qc = useQueryClient();
  const [pickedShop, setPickedShop] = useState<string | null>(null);
  const shopId = scope.shopId ?? pickedShop ?? '';
  const queryKey = ['kitchen-product', productId, shopId];

  const { data, isLoading, isError } = useQuery({
    queryKey,
    queryFn: () => fetchProductKitchen(productId, shopId || null),
    enabled: !!productId,
    retry: false,
  });

  // Unsaved choice for this shop over what the cloud has; null = untouched.
  const [edit, setEdit] = useState<{ key: string; mode: ProductRouteMode; ids: string[] } | null>(null);
  const editKey = `${productId}:${shopId}`;
  const current = edit && edit.key === editKey ? edit : null;
  const mode: ProductRouteMode = current?.mode ?? data?.mode ?? 'inherit';
  const ids = current?.ids ?? data?.printerIds ?? [];

  const applyState = (state: ProductKitchenState) => {
    qc.setQueryData(queryKey, state);
    qc.invalidateQueries({ queryKey: ['kitchen-product', productId] });
    qc.invalidateQueries({ queryKey: ['kitchen-printer-routing'] });
    setEdit(null);
  };

  const save = useMutation({
    mutationFn: () => saveProductRoute(shopId, productId, mode, mode === 'printers' ? ids : []),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['kitchen-product', productId] });
      qc.invalidateQueries({ queryKey: ['kitchen-printer-routing', shopId] });
      setEdit(null);
      toast.success(t('saved'));
    },
    onError: (err: unknown) => {
      const e = err as { response?: { data?: { detail?: unknown } } };
      toast.error(
        e?.response?.data?.detail === 'product_no_ticket'
          ? tw('turnOffFirst')
          : axiosErrorToToastMessage(err, tc('error')),
      );
    },
  });

  const names = useMemo(() => new Map((data?.printers ?? []).map((p) => [p.id, p.name])), [data]);
  const inherited = (data?.inheritedPrinterIds ?? []).map((pid) => names.get(pid) ?? '?');
  const shopOptions = scope.shops.map((s) => ({ value: s.id, label: s.name }));
  const dirty = current !== null;
  const invalid = mode === 'printers' && ids.length === 0;
  const status = data
    ? data.effective
      ? effectiveText(tw, data.effective)
      : productWideText(tw, data)
    : '';

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <div>
        <div className="font-medium">{t('title')}</div>
        <p className="text-xs text-muted-foreground">{t('hintProduct')}</p>
      </div>

      {isLoading ? (
        <p className="text-sm text-muted-foreground">{tc('loading')}</p>
      ) : isError || !data ? (
        <p className="text-sm text-muted-foreground">{t('unavailable')}</p>
      ) : (
        <ProductKitchenControls
          productId={productId}
          shopId={shopId || null}
          noTicket={data.noTicket}
          overrideShopCount={data.overrideShops.length}
          canEdit={data.canEditProduct === true}
          status={status}
          onChanged={applyState}
        />
      )}

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

      {shopId && data && data.printers && (
        data.printers.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('noPrinters')}</p>
        ) : (
          <div className="space-y-2 text-sm">
            <div className="font-medium">{tw('thisShop')}</div>
            {data.noTicket ? (
              <p className="text-xs text-muted-foreground">{tw('turnOffFirst')}</p>
            ) : (
              <>
                <label className="flex items-center gap-2">
                  <input type="radio" checked={mode === 'inherit'} onChange={() => setEdit({ key: editKey, mode: 'inherit', ids })} />
                  {t('inheritCategory', { printers: inherited.join(', ') || t('nothing') })}
                </label>
                <label className="flex items-center gap-2">
                  <input type="radio" checked={mode === 'printers'} onChange={() => setEdit({ key: editKey, mode: 'printers', ids })} />
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
                              setEdit({
                                key: editKey,
                                mode: 'printers',
                                ids: e.target.checked ? [...ids, p.id] : ids.filter((x) => x !== p.id),
                              })
                            }
                          />
                          {p.name}
                        </label>
                      ))}
                  </div>
                )}
                {/* A "no ticket here" set earlier for this shop alone: shown, kept until changed. */}
                {mode === 'none' && (
                  <label className="flex items-center gap-2">
                    <input type="radio" checked readOnly />
                    {tw('noneHere')}
                  </label>
                )}
                <div className="flex items-center gap-2">
                  <Button size="sm" disabled={!dirty || invalid || save.isPending} onClick={() => save.mutate()}>
                    {save.isPending ? tc('saving') : t('save')}
                  </Button>
                  {invalid && <span className="text-xs text-destructive">{t('pickOne')}</span>}
                </div>
              </>
            )}
          </div>
        )
      )}
    </div>
  );
}
