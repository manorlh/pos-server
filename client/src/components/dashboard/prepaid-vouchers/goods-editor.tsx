'use client';

/**
 * What each voucher gives, in goods — the quantities and the shared two-pane picker
 * (voucher-catalog-picker.tsx: a category's tick lists all its products, search across the
 * catalog, filters, shift-click ranges). Shared by the batch form (a batch made without a type)
 * and the voucher type form. Every product of the company is listed, each with whether it can go
 * on a voucher and why not (docs/SPEC_VOUCHER_PRODUCTION.md §7.14); a product sold by weight
 * takes a decimal of its unit ("0.5 ק״ג").
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Minus, Plus, X } from 'lucide-react';
import type { PrepaidProductOption } from '@/lib/prepaidVoucherProducts';
import { clampQuantity, DEFAULT_WEIGHT_UNIT, quantityStep } from '@/lib/prepaidVoucherProducts';
import { VoucherItemsPicker } from '@/components/dashboard/prepaid-vouchers/voucher-catalog-picker';
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

  const setQty = (id: string, q: number) =>
    onChange(items.map((i) => (i.product.id === id ? { ...i, quantity: clampQuantity(q, i.product.isWeighed) } : i)));

  const stepper = (i: DraftItem, compact = false) => (
    <span className="flex items-center gap-1">
      <Button type="button" size="icon-sm" variant="outline" aria-label={`${t('less')}: ${i.product.name}`} className={compact ? 'h-7 w-7' : undefined}
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
      <Button type="button" size="icon-sm" variant="outline" aria-label={`${t('more')}: ${i.product.name}`} className={compact ? 'h-7 w-7' : undefined}
        onClick={() => setQty(i.product.id, i.quantity + quantityStep(i.product.isWeighed))}>
        <Plus className="h-3.5 w-3.5" />
      </Button>
    </span>
  );

  return (
    <div className="space-y-2">
      <Label>{t('items')}</Label>
      {items.length ? (
        <ul className="divide-y rounded-lg border">
          {items.map((i) => (
            <li key={i.product.id} className="flex items-center gap-2 px-3 py-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{i.product.name}</span>
              {stepper(i)}
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
      <VoucherItemsPicker
        companyId={enabled ? companyId : ''}
        shopIds={shopIds}
        purpose="items"
        wholeCategories={false}
        unavailableText={companyId ? null : t('pickCompany')}
        value={{ categoryIds: [], productIds: items.map((i) => i.product.id) }}
        onChange={(next, options) => {
          const have = new Map(items.map((i) => [i.product.id, i]));
          onChange(
            next.productIds
              .map((id) => have.get(id) ?? (options.get(id) ? { product: options.get(id)!, quantity: 1 } : null))
              .filter((i): i is DraftItem => !!i),
          );
        }}
        renderItemExtra={(p) => {
          const i = items.find((x) => x.product.id === p.id);
          return i ? stepper(i, true) : null;
        }}
      />
      <p className="text-xs text-muted-foreground">{te('searchHint')}</p>
    </div>
  );
}
