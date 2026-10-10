'use client';

/**
 * What each voucher gives, in goods — the picker and the quantities. Shared by the batch form
 * (a batch made without a type) and the voucher type form. Every product of the company is
 * listed, each with whether it can go on a voucher and why not (docs/SPEC_VOUCHER_PRODUCTION.md
 * §7.14); a product sold by weight takes a decimal of its unit ("0.5 ק״ג").
 */

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { Minus, Plus, Search, X } from 'lucide-react';
import { searchPrepaidProducts } from '@/lib/prepaidVouchersApi';
import type { PrepaidProductOption } from '@/lib/prepaidVoucherProducts';
import { clampQuantity, DEFAULT_WEIGHT_UNIT, quantityStep } from '@/lib/prepaidVoucherProducts';
import { PrepaidProductPickList } from '@/components/dashboard/prepaid-vouchers/product-pick-list';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export interface DraftItem {
  product: PrepaidProductOption;
  quantity: number;
}

export function WeightInput({ value, label, onCommit }: { value: number; label: string; onCommit: (q: number) => void }) {
  const [text, setText] = useState(String(value));
  const commit = () => {
    const q = Number(text.replace(',', '.'));
    if (Number.isFinite(q) && q > 0) onCommit(q);
    else setText(String(value));
  };
  return (
    <Input inputMode="decimal" aria-label={label} className="h-8 w-20 text-center tabular-nums" value={text}
      onChange={(e) => setText(e.target.value)} onBlur={commit}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }} />
  );
}

export function GoodsEditor({
  companyId,
  shopIds,
  items,
  onChange,
  enabled = true,
}: {
  companyId: string;
  shopIds?: string[];
  items: DraftItem[];
  onChange: (next: DraftItem[]) => void;
  enabled?: boolean;
}) {
  const t = useTranslations('prepaidVouchers.create');
  const te = useTranslations('prepaidVouchers.eligibility');
  const tc = useTranslations('common');
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(search), 300);
    return () => window.clearTimeout(id);
  }, [search]);
  const ids = shopIds ?? [];
  const products = useQuery({
    queryKey: ['prepaid-voucher-products', companyId, debounced, 'items', ids],
    queryFn: () => searchPrepaidProducts(debounced, companyId, { purpose: 'items', shopIds: ids }),
    enabled: enabled && !!companyId,
  });

  const add = (p: PrepaidProductOption) =>
    onChange(items.some((i) => i.product.id === p.id) ? items : [...items, { product: p, quantity: 1 }]);
  const setQty = (id: string, q: number) =>
    onChange(items.map((i) => (i.product.id === id ? { ...i, quantity: clampQuantity(q, i.product.isWeighed) } : i)));

  return (
    <div className="space-y-2">
      <Label>{t('items')}</Label>
      {items.length ? (
        <ul className="divide-y rounded-lg border">
          {items.map((i) => (
            <li key={i.product.id} className="flex items-center gap-2 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{i.product.name}</span>
              <Button type="button" size="icon-sm" variant="outline" aria-label={t('less')}
                onClick={() => setQty(i.product.id, i.quantity - quantityStep(i.product.isWeighed))}>
                <Minus className="h-3.5 w-3.5" />
              </Button>
              {i.product.isWeighed ? (
                <span className="flex items-center gap-1" title={t('weightHint')}>
                  <WeightInput key={i.quantity} value={i.quantity} label={t('weightQty', { unit: i.product.unitLabel || DEFAULT_WEIGHT_UNIT })}
                    onCommit={(q) => setQty(i.product.id, q)} />
                  <span className="text-xs text-muted-foreground">{i.product.unitLabel || DEFAULT_WEIGHT_UNIT}</span>
                </span>
              ) : (
                <span className="w-6 text-center tabular-nums">{i.quantity}</span>
              )}
              <Button type="button" size="icon-sm" variant="outline" aria-label={t('more')}
                onClick={() => setQty(i.product.id, i.quantity + quantityStep(i.product.isWeighed))}>
                <Plus className="h-3.5 w-3.5" />
              </Button>
              <Button type="button" size="icon-sm" variant="ghost" aria-label={t('remove')}
                onClick={() => onChange(items.filter((x) => x.product.id !== i.product.id))}>
                <X className="h-3.5 w-3.5" />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{t('itemsEmpty')}</p>
      )}
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground ltr:left-2.5 rtl:right-2.5" aria-hidden />
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('searchProducts')} className="ps-8" />
      </div>
      <div className="max-h-48 overflow-y-auto rounded-lg border">
        <PrepaidProductPickList
          products={products.data}
          purpose="items"
          chosen={new Set(items.map((i) => i.product.id))}
          onPick={add}
          pending={!!companyId && products.isPending}
          pendingText={tc('loading')}
          emptyText={companyId ? t('noProducts') : t('pickCompany')}
        />
      </div>
      <p className="text-xs text-muted-foreground">{te('searchHint')}</p>
    </div>
  );
}
