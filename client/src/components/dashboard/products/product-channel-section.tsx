'use client';

/**
 * The product form's "היכן הפריט נמכר" (lib/productChannel.ts, pos-server
 * docs/SPEC_PRODUCT_CHANNELS.md): a segmented control, saved with the form's own "שמור"
 * — on a new product too — and the list's badge for a product not sold everywhere.
 */

import { useTranslations } from 'next-intl';
import {
  SALES_CHANNELS,
  SALES_CHANNEL_LABEL_KEYS,
  salesChannelBadgeKey,
  salesChannelOf,
  type SalesChannel,
} from '@/lib/productChannel';
import type { Product } from '@/lib/types';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { IosSegmented } from '@/components/dashboard/menu/ios';

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
  const value = salesChannelOf(product.salesChannel);
  return (
    <div className="space-y-2 rounded-md border p-3">
      <div>
        <Label>{t('salesChannel')}</Label>
        <p className="text-xs text-muted-foreground">{t('salesChannelHint')}</p>
      </div>
      <IosSegmented<SalesChannel>
        value={value}
        disabled={disabled}
        options={SALES_CHANNELS.map((id) => ({ id, label: t(SALES_CHANNEL_LABEL_KEYS[id]) }))}
        onChange={(salesChannel) => onChange({ salesChannel })}
      />
      {value === 'kiosk_only' ? (
        <p className="text-xs text-[#FF9500]" role="status">{t('salesChannelHintKioskOnly')}</p>
      ) : null}
      {value === 'pos_only' ? (
        <p className="text-xs text-[#FF9500]" role="status">{t('salesChannelHintPosOnly')}</p>
      ) : null}
    </div>
  );
}

/** "קיוסק בלבד" / "קופות בלבד" beside the product's name; nothing when sold everywhere. */
export function ProductChannelBadge({ channel }: { channel: unknown }) {
  const t = useTranslations('products');
  const key = salesChannelBadgeKey(channel);
  if (!key) return null;
  return (
    <Badge variant="outline" title={t('salesChannel')}>
      {t(key)}
    </Badge>
  );
}
