'use client';

/**
 * "סוג עוסק" on the company form (docs/SPEC_BUSINESS_TYPE.md): a select of the three types
 * with what each one means, so the choice is made knowing that an exempt dealer issues
 * receipts only and charges no VAT.
 *
 * On an existing company a change applies to new documents only, and only the company's
 * administrators may make it (the server refuses anyone else) — so the warning shows
 * when the choice differs from what is saved, and the select is read-only for others.
 */

import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';
import { DEALER_TYPES, dealerTypeOf, isDealerTypeChange, type DealerType } from '@/lib/dealerType';

export function DealerTypeField({
  value,
  saved,
  isNew,
  canChange,
  onChange,
}: {
  value: DealerType | undefined;
  /** The company's type as stored; undefined while creating. */
  saved: DealerType | undefined;
  isNew: boolean;
  canChange: boolean;
  onChange: (next: DealerType) => void;
}) {
  const t = useTranslations('businessType');
  const current = dealerTypeOf(value);
  const locked = !isNew && !canChange;
  const changing = !isNew && isDealerTypeChange(saved, current);

  return (
    <div className="space-y-1.5">
      <Label htmlFor="company-dealer-type">{t('title')}</Label>
      <select
        id="company-dealer-type"
        className="border-input bg-background h-9 w-full rounded-md border px-3 text-sm disabled:opacity-60"
        value={current}
        disabled={locked}
        onChange={(e) => onChange(dealerTypeOf(e.target.value))}
      >
        {DEALER_TYPES.map((type) => (
          <option key={type} value={type}>
            {t(type)}
          </option>
        ))}
      </select>
      <ul className="space-y-1 text-xs">
        {DEALER_TYPES.map((type) => (
          <li
            key={type}
            className={cn(
              'rounded-md px-2 py-1',
              type === current ? 'bg-muted text-foreground' : 'text-muted-foreground',
            )}
          >
            <span className="font-medium">{t(type)}:</span> {t(`${type}Hint`)}
          </li>
        ))}
      </ul>
      {locked ? <p className="text-muted-foreground text-xs">{t('changeForbidden')}</p> : null}
      {changing ? (
        <p className="flex items-start gap-1.5 rounded-md border border-amber-300 bg-amber-50 px-2 py-1.5 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-100">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {t('changeWarning')}
        </p>
      ) : null}
    </div>
  );
}
