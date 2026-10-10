'use client';

/**
 * The product form's "מופיע ב" (lib/productChannel.ts, pos-server app/services/product_channels.py,
 * specs/item-blocks-targets.md §11): four checkboxes — "קופה", "קיוסק", "הזמנות אונליין", "תפריט
 * דיגיטלי" — saved with the form's own "שמור" (on a new product too) as `appearsIn`, with
 * `salesChannel` ("היכן הפריט נמכר") following its pos / kiosk part; and the list's badge for a
 * product not at exactly the tills and the kiosk.
 */

import { useId } from 'react';
import { useTranslations } from 'next-intl';
import {
  APPEARS_IN_CHANNELS,
  APPEARS_IN_LABEL_KEYS,
  appearsAtNoDevice,
  appearsInBadge,
  appearsInOf,
  salesChannelForAppears,
  withAppearsIn,
  type AppearsInChannel,
} from '@/lib/productChannel';
import type { Product } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';

type Patch = (patch: Partial<Product>) => void;

export function ProductChannelSection({
  product,
  onChange,
  disabled,
}: {
  product: Partial<Product>;
  onChange: Patch;
  disabled?: boolean;
}) {
  const t = useTranslations('products');
  const labelId = useId();
  const appearsIn = appearsInOf(product);
  const set = (channel: AppearsInChannel, on: boolean) => {
    const next = withAppearsIn(appearsIn, channel, on);
    onChange({ appearsIn: next, salesChannel: salesChannelForAppears(next) });
  };
  const offDevices = !appearsIn.includes('online') || !appearsIn.includes('menu');
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div>
        <Label id={labelId}>{t('appearsIn')}</Label>
        <p className="text-xs text-muted-foreground">{t('appearsInHint')}</p>
      </div>
      <div className="grid grid-cols-2 gap-2" role="group" aria-labelledby={labelId}>
        {APPEARS_IN_CHANNELS.map((c) => (
          <label
            key={c}
            className="flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border px-2 text-sm hover:bg-muted has-[:disabled]:cursor-default has-[:disabled]:opacity-60"
          >
            <input
              type="checkbox"
              className="size-4 accent-primary"
              checked={appearsIn.includes(c)}
              disabled={disabled}
              onChange={(e) => set(c, e.target.checked)}
            />
            <span className="truncate">{t(APPEARS_IN_LABEL_KEYS[c])}</span>
          </label>
        ))}
      </div>
      {offDevices ? <p className="text-xs text-muted-foreground">{t('appearsInOffHint')}</p> : null}
      {appearsIn.length === 0 ? (
        <p className="text-xs text-[#FF9500]" role="status">{t('appearsInNone')}</p>
      ) : appearsAtNoDevice(appearsIn) ? (
        <p className="text-xs text-[#FF9500]" role="status">{t('appearsInNoDevices')}</p>
      ) : null}
    </div>
  );
}

/**
 * Beside the product's name: where it appears ("קיוסק · הזמנות אונליין", "כל הערוצים", "לא מופיע");
 * nothing for today's default, the tills and the kiosk.
 */
export function ProductChannelBadge({ product }: { product: Pick<Partial<Product>, 'appearsIn' | 'salesChannel'> }) {
  const t = useTranslations('products');
  const list = appearsInBadge(product);
  if (!list) return null;
  const text =
    list.length === 0
      ? t('appearsInBadgeNone')
      : list.length === APPEARS_IN_CHANNELS.length
        ? t('appearsInBadgeAll')
        : list.map((c) => t(APPEARS_IN_LABEL_KEYS[c])).join(' · ');
  return (
    <Badge variant="outline" title={t('appearsIn')}>
      {text}
    </Badge>
  );
}
