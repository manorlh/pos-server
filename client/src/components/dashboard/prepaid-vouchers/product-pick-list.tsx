'use client';

/**
 * The product list of a prepaid voucher batch's pickers — goods and an item discount's targets
 * (pos-server docs/SPEC_VOUCHER_PRODUCTION.md §7.14). Every product the cloud returns is shown:
 * one that cannot go on the batch is greyed with why ("פריט כללי — לא לשובר פריטים"), instead of
 * being left out, so the owner sees why; one that can carries what to know about it (by weight,
 * options, a meal, kiosk only…). The save applies the same rule.
 */

import { useTranslations } from 'next-intl';
import { Ban, Plus } from 'lucide-react';
import {
  blockKeyOf,
  DEFAULT_WEIGHT_UNIT,
  noteKeysOf,
  type PrepaidProductOption,
  type PrepaidProductPurpose,
} from '@/lib/prepaidVoucherProducts';
import { cn } from '@/lib/utils';

export function PrepaidProductPickList({
  products,
  purpose,
  chosen,
  onPick,
  pending,
  emptyText,
  pendingText,
  className,
}: {
  products: PrepaidProductOption[] | undefined;
  purpose: PrepaidProductPurpose;
  /** Ids already on the batch: shown, not offered again. */
  chosen: ReadonlySet<string>;
  onPick: (p: PrepaidProductOption) => void;
  pending: boolean;
  emptyText: string;
  pendingText: string;
  className?: string;
}) {
  const t = useTranslations('prepaidVouchers.eligibility');
  if (pending) return <p className="p-2 text-xs text-muted-foreground">{pendingText}</p>;
  if (!products?.length) return <p className="p-2 text-xs text-muted-foreground">{emptyText}</p>;
  return (
    <ul className={className}>
      {products.map((p) => {
        const block = blockKeyOf(p, purpose);
        const unit = p.unitLabel || DEFAULT_WEIGHT_UNIT;
        const notes = noteKeysOf(p, purpose);
        const disabled = !!block || chosen.has(p.id);
        return (
          <li key={p.id}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPick(p)}
              title={block ? t(`blocked.${block}`) : undefined}
              className={cn(
                'flex w-full items-start gap-2 px-3 py-1.5 text-start text-sm hover:bg-muted disabled:cursor-not-allowed',
                chosen.has(p.id) && !block && 'opacity-50',
              )}
            >
              {block ? (
                <Ban className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
              ) : (
                <Plus className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              )}
              <span className="min-w-0 flex-1">
                <span className={cn('block truncate', block && 'text-muted-foreground')}>{p.name}</span>
                {block || notes.length || p.companyName ? (
                  <span className="mt-0.5 flex flex-wrap gap-1">
                    {block ? (
                      <span className="rounded-full bg-destructive/10 px-1.5 py-px text-[11px] text-destructive">
                        {t(`blocked.${block}`)}
                      </span>
                    ) : null}
                    {block && p.companyName ? (
                      <span className="rounded-full bg-muted px-1.5 py-px text-[11px] text-muted-foreground">
                        {t('companyOf', { name: p.companyName })}
                      </span>
                    ) : null}
                    {notes.map((n) => (
                      <span key={n} className="rounded-full bg-muted px-1.5 py-px text-[11px] text-muted-foreground">
                        {t(`notes.${n}`, { unit, shop: p.shopName ?? '' })}
                      </span>
                    ))}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                ₪{p.price.toFixed(2)}
                {p.isWeighed ? ` ${t('perUnit', { unit })}` : ''}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
