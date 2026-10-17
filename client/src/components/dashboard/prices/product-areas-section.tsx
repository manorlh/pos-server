'use client';

/**
 * "נקודות מכירה" in the product editor (P:/specs/chain-areas.md §6): per shop the user reaches (the top bar's shop
 * first) — "כל הנקודות" or some of them. Points of sale that are not the user's are shown locked. Each shop saves on
 * its own (`PUT /products/{id}/areas`), apart from the dialog's "שמור".
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { MapPin } from 'lucide-react';
import { api } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { productAreasPayload } from '@/lib/bulkPrice';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { AreaChips } from './area-chips';
import type { ProductAreasResponse, ProductAreasShop } from './types';

export const PRODUCT_AREAS_KEY = 'product-areas';

function sameId(a: string | null | undefined, b: string | null | undefined) {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

export function ProductAreasSection({ productId, preferredShopId }: { productId: string; preferredShopId?: string | null }) {
  const query = useQuery<ProductAreasResponse>({
    queryKey: [PRODUCT_AREAS_KEY, productId],
    queryFn: () => api.get(`/products/${productId}/areas`).then((r) => r.data),
  });
  const shops = useMemo(() => {
    const list = [...(query.data?.shops ?? [])];
    list.sort((a, b) => Number(sameId(b.shopId, preferredShopId)) - Number(sameId(a.shopId, preferredShopId)));
    return list;
  }, [query.data, preferredShopId]);

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div>
        <Label className="flex items-center gap-1.5">
          <MapPin className="h-3.5 w-3.5" aria-hidden />
          נקודות מכירה
        </Label>
        <p className="text-xs text-muted-foreground">
          איפה המוצר נמכר בכל סניף. נקודה שלא נבחרה — המוצר לא מוצג במכשירים שלה. נשמר לכל סניף בנפרד.
        </p>
      </div>
      {query.isLoading ? (
        <Skeleton className="h-16 w-full" />
      ) : query.isError ? (
        <p className="text-xs text-destructive">{axiosErrorToToastMessage(query.error, 'הטעינה נכשלה')}</p>
      ) : shops.length === 0 ? (
        <p className="text-xs text-muted-foreground">אין סניפים עם נקודות מכירה.</p>
      ) : (
        shops.map((s) => <ShopAreasRow key={`${s.shopId}:${s.allAreas}:${s.areas.map((a) => a.sold).join()}`} productId={productId} shop={s} />)
      )}
    </div>
  );
}

function ShopAreasRow({ productId, shop }: { productId: string; shop: ProductAreasShop }) {
  const qc = useQueryClient();
  const allIds = shop.areas.map((a) => a.id);
  const anyLocked = shop.areas.some((a) => !a.editable);
  const [all, setAll] = useState(shop.listed && shop.allAreas);
  const [picked, setPicked] = useState<string[]>(shop.areas.filter((a) => a.sold).map((a) => a.id));

  const initialAll = shop.listed && shop.allAreas;
  const initialPicked = shop.areas.filter((a) => a.sold).map((a) => a.id);
  const dirty =
    all !== initialAll || (!all && (picked.length !== initialPicked.length || picked.some((id) => !initialPicked.includes(id))));

  const save = useMutation({
    mutationFn: () =>
      api.put(`/products/${productId}/areas`, {
        shopId: shop.shopId,
        areaIds: all ? null : productAreasPayload(allIds, picked),
      }),
    onSuccess: () => {
      toast.success('נקודות המכירה נשמרו');
      qc.invalidateQueries({ queryKey: [PRODUCT_AREAS_KEY, productId] });
      qc.invalidateQueries({ queryKey: ['product-prices', productId] });
      qc.invalidateQueries({ queryKey: ['product-shops'] });
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, 'השמירה נכשלה')),
  });

  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{shop.shopName}</span>
        {!shop.listed ? <span className="text-xs text-muted-foreground">הסניף לא מוכר את המוצר</span> : null}
        <label className="flex items-center gap-2 text-sm">
          <Switch
            checked={all}
            disabled={anyLocked || save.isPending}
            onCheckedChange={(on) => {
              setAll(on);
              if (!on && picked.length === 0) setPicked(allIds);
            }}
          />
          כל הנקודות
        </label>
      </div>
      {!all ? (
        <AreaChips
          areas={shop.areas.map((a) => ({
            id: a.id,
            name: a.name,
            disabled: !a.editable,
            title: a.editable ? null : 'נקודת מכירה שאינה באחריותך',
          }))}
          value={picked}
          onChange={setPicked}
          disabled={save.isPending}
        />
      ) : null}
      {!all && picked.length === 0 ? (
        <p className="text-xs text-amber-700 dark:text-amber-400">בלי נקודות — הסניף יפסיק למכור את המוצר.</p>
      ) : null}
      {dirty ? (
        <div className="flex justify-end">
          <Button size="sm" variant="secondary" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? 'שומר…' : 'שמור נקודות מכירה'}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
