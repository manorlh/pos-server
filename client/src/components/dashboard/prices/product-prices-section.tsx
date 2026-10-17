'use client';

/**
 * "מחירים" in the product editor (P:/specs/chain-areas.md §9): the chain's price, and per shop the user reaches
 * "כאן ₪Y" and each point of sale's — every field disabled with the server's reason when the chain's price policy
 * says so (`GET /products/{id}/prices`). "מחיר נעול ע״י הרשת" for the chain, and "יומן שינויי מחיר".
 * Each price saves on its own, apart from the dialog's "שמור".
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronDown, ChevronLeft, Lock, Tag, Undo2 } from 'lucide-react';
import { api } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { PRICE_LEVEL_LABEL, formatShekel, priceInput } from '@/lib/bulkPrice';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import type { PriceChangeRow, ProductPricesResponse, ShopPriceRow } from './types';

export const PRODUCT_PRICES_KEY = 'product-prices';

export function useProductPrices(productId: string | null | undefined) {
  return useQuery<ProductPricesResponse>({
    queryKey: [PRODUCT_PRICES_KEY, productId ?? null],
    queryFn: () => api.get(`/products/${productId}/prices`).then((r) => r.data),
    enabled: !!productId,
  });
}

function sameId(a: string | null | undefined, b: string | null | undefined) {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase();
}

export function ProductPricesSection({
  productId,
  preferredShopId,
}: {
  productId: string;
  preferredShopId?: string | null;
}) {
  const qc = useQueryClient();
  const query = useProductPrices(productId);
  const data = query.data;
  const shops = useMemo(() => {
    const list = [...(data?.shops ?? [])];
    list.sort((a, b) => Number(sameId(b.shopId, preferredShopId)) - Number(sameId(a.shopId, preferredShopId)));
    return list;
  }, [data, preferredShopId]);

  const lock = useMutation({
    mutationFn: (locked: boolean) => api.put(`/products/${productId}/price-lock`, { locked }),
    onSuccess: (_r, locked) => {
      toast.success(locked ? 'המחיר ננעל ע״י הרשת' : 'נעילת המחיר הוסרה');
      qc.invalidateQueries({ queryKey: [PRODUCT_PRICES_KEY, productId] });
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, 'השמירה נכשלה')),
  });

  return (
    <div className="space-y-3 rounded-md border p-3">
      <Label className="flex items-center gap-1.5">
        <Tag className="h-3.5 w-3.5" aria-hidden />
        מחירים
      </Label>
      {query.isLoading ? (
        <Skeleton className="h-20 w-full" />
      ) : query.isError || !data ? (
        <p className="text-xs text-destructive">{axiosErrorToToastMessage(query.error, 'טעינת המחירים נכשלה')}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm">
              מחיר הרשת <span className="font-semibold tabular-nums">{formatShekel(data.basePrice)}</span>
            </span>
            <span className="text-xs text-muted-foreground">
              {data.baseEditable ? 'נערך בשדה "מחיר" למעלה' : data.baseReason}
            </span>
          </div>
          {data.actorLevel === 'chain' ? (
            <label className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm">
              <span className="flex items-center gap-1.5">
                <Lock className="h-3.5 w-3.5" aria-hidden />
                מחיר נעול ע״י הרשת
                <span className="text-xs text-muted-foreground">— סניפים ונקודות לא משנים את המחיר</span>
              </span>
              <Switch checked={data.locked} disabled={lock.isPending} onCheckedChange={(on) => lock.mutate(on)} />
            </label>
          ) : data.locked ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Lock className="h-3 w-3" aria-hidden /> המחיר נעול ע״י הרשת
            </p>
          ) : null}
          {shops.length === 0 ? (
            <p className="text-xs text-muted-foreground">המוצר לא נמכר בסניפים שבאחריותך.</p>
          ) : (
            shops.map((s) => <ShopPrices key={s.shopId} productId={productId} shop={s} basePrice={data.basePrice} />)
          )}
          <PriceChangesLog productId={productId} />
        </>
      )}
    </div>
  );
}

function usePriceWrite(productId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { path: string; price: number | null }) => api.put(`/products/${productId}/prices/${args.path}`, { price: args.price }),
    onSuccess: (_r, args) => {
      toast.success(args.price === null ? 'המחיר חזר לירושה' : 'המחיר נשמר');
      qc.invalidateQueries({ queryKey: [PRODUCT_PRICES_KEY, productId] });
      qc.invalidateQueries({ queryKey: ['product-price-changes', productId] });
      qc.invalidateQueries({ queryKey: ['product-shops'] });
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, 'השמירה נכשלה')),
  });
}

function PriceField({
  label,
  shown,
  own,
  editable,
  reason,
  resetLabel,
  busy,
  onSave,
}: {
  label: React.ReactNode;
  shown: number;
  own: number | null;
  editable: boolean;
  reason: string | null;
  resetLabel: string;
  busy: boolean;
  onSave: (price: number | null) => void;
}) {
  const [draft, setDraft] = useState(own === null ? '' : String(own));
  const parsed = priceInput(draft);
  const changed = parsed !== undefined && parsed !== own;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="min-w-28 text-sm">{label}</span>
      <span className="text-sm font-medium tabular-nums">{formatShekel(shown)}</span>
      <Input
        className="h-8 w-24"
        dir="ltr"
        inputMode="decimal"
        placeholder={String(shown)}
        value={draft}
        disabled={!editable || busy}
        title={!editable ? reason ?? undefined : undefined}
        onChange={(e) => setDraft(e.target.value)}
        aria-label={typeof label === 'string' ? label : 'מחיר'}
      />
      {editable ? (
        <>
          <Button size="sm" variant="secondary" className="h-8" disabled={!changed || busy || parsed === null} onClick={() => onSave(parsed ?? null)}>
            שמור
          </Button>
          {own !== null ? (
            <Button
              size="sm"
              variant="ghost"
              className="h-8"
              disabled={busy}
              onClick={() => {
                setDraft('');
                onSave(null);
              }}
            >
              <Undo2 className="h-3.5 w-3.5" aria-hidden />
              {resetLabel}
            </Button>
          ) : null}
        </>
      ) : (
        <span className="text-xs text-muted-foreground">{reason}</span>
      )}
    </div>
  );
}

function ShopPrices({ productId, shop, basePrice }: { productId: string; shop: ShopPriceRow; basePrice: number }) {
  const write = usePriceWrite(productId);
  const policy = shop.policy;
  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{shop.shopName}</span>
        {policy?.maxDeltaPct !== null && policy?.maxDeltaPct !== undefined ? (
          <span className="text-xs text-muted-foreground">
            טווח מותר ±{policy.maxDeltaPct}% ממחיר הרשת ({formatShekel((basePrice * (100 - policy.maxDeltaPct)) / 100)}–
            {formatShekel((basePrice * (100 + policy.maxDeltaPct)) / 100)})
          </span>
        ) : null}
      </div>
      <PriceField
        key={`shop:${shop.price}`}
        label="כאן"
        shown={shop.effectivePrice}
        own={shop.price}
        editable={shop.editable}
        reason={shop.reason}
        resetLabel="חזרה למחיר הרשת"
        busy={write.isPending}
        onSave={(price) => write.mutate({ path: `shops/${shop.shopId}`, price })}
      />
      {shop.areas.length ? (
        <div className="space-y-1.5 border-s-2 ps-3">
          {shop.areas.map((a) => (
            <PriceField
              key={`${a.areaId}:${a.price}`}
              label={
                <span>
                  {a.areaName}
                  <span className="ms-1 text-xs text-muted-foreground">({PRICE_LEVEL_LABEL[a.effectiveLevel] ?? a.effectiveLevel})</span>
                </span>
              }
              shown={a.effectivePrice}
              own={a.price}
              editable={a.editable}
              reason={a.reason}
              resetLabel="חזרה למחיר הסניף"
              busy={write.isPending}
              onSave={(price) => write.mutate({ path: `areas/${a.areaId}`, price })}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function PriceChangesLog({ productId }: { productId: string }) {
  const [open, setOpen] = useState(false);
  const query = useQuery<{ changes: PriceChangeRow[] }>({
    queryKey: ['product-price-changes', productId],
    queryFn: () => api.get(`/products/${productId}/price-changes`).then((r) => r.data),
    enabled: open,
  });
  const rows = query.data?.changes ?? [];
  return (
    <div className="rounded-md border">
      <button
        type="button"
        className="flex w-full items-center gap-1.5 p-2 text-start text-sm font-medium"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        {open ? <ChevronDown className="h-4 w-4" aria-hidden /> : <ChevronLeft className="h-4 w-4" aria-hidden />}
        יומן שינויי מחיר
      </button>
      {open ? (
        <div className="max-h-64 overflow-y-auto border-t p-2">
          {query.isLoading ? (
            <Skeleton className="h-10 w-full" />
          ) : rows.length === 0 ? (
            <p className="text-xs text-muted-foreground">אין שינויי מחיר רשומים.</p>
          ) : (
            <ul className="space-y-1.5 text-xs">
              {rows.map((r) => (
                <li key={r.id} className="flex flex-wrap gap-x-2">
                  <span className="text-muted-foreground tabular-nums">{r.at ? new Date(r.at).toLocaleString('he-IL') : ''}</span>
                  <span className="font-medium">
                    {PRICE_LEVEL_LABEL[r.level] ?? r.level}
                    {r.targetName ? ` · ${r.targetName}` : ''}
                  </span>
                  <span className="tabular-nums" dir="ltr">
                    {formatShekel(r.oldPrice)} → {formatShekel(r.newPrice)}
                  </span>
                  <span className="text-muted-foreground">
                    {r.by ?? ''}
                    {r.machine ? ` · ${r.machine}` : ''}
                    {r.source === 'till' ? ' · מהקופה' : ''}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}
