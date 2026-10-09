'use client';

/** A redemption's flags as tags ("מעבר למכסה", "מומש בזמן השהיה", …) — the labels of `prepaidVouchers.kinds.flag`. */

import { useTranslations } from 'next-intl';
import { flagTexts } from '@/lib/prepaidRedemptionFlags';
import { cn } from '@/lib/utils';

/** Turns flag codes into their Hebrew labels (an unknown one stays its code) — for the screen and the exports. */
export function useFlagTexts(): (flags: readonly string[] | null | undefined) => string[] {
  const tk = useTranslations('prepaidVouchers.kinds');
  return (flags) => flagTexts(flags, (f) => (tk.has(`flag.${f}`) ? tk(`flag.${f}`) : null));
}

export function RedemptionFlags({ flags, className }: { flags: readonly string[] | null | undefined; className?: string }) {
  const texts = useFlagTexts()(flags);
  if (!texts.length) return null;
  return (
    <>
      {texts.map((text) => (
        <span
          key={text}
          className={cn(
            'ms-1 inline-block rounded bg-amber-100 px-1 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-300',
            className,
          )}
        >
          {text}
        </span>
      ))}
    </>
  );
}
