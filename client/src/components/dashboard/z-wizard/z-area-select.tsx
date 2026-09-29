'use client';

/**
 * Which tills of a shop the Z wizard offers: all of them, or those of one area.
 *
 * Choosing an area only narrows the candidate list (and records the area on the run);
 * the Z is still the shop's, in the shop's own number sequence. Only live areas are
 * offered — an archived one cannot be run. A shop with no areas shows nothing here.
 */

import { useTranslations } from 'next-intl';
import { LayoutGrid } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useShopAreas } from '@/components/dashboard/areas/use-shop-areas';

const ALL = '__all__';

export function ZAreaSelect({
  shopId,
  shopName,
  value,
  onChange,
}: {
  shopId: string;
  shopName: string;
  value: string | null;
  onChange: (areaId: string | null) => void;
}) {
  const t = useTranslations('zWizard');
  const tc = useTranslations('common');
  const { data: areas = [], isSuccess } = useShopAreas(shopId, false);

  // Nothing to choose between: a shop with no areas is always run whole. A preselected
  // area that is not (or no longer) live still shows, so the operator can see and clear it.
  if (isSuccess && areas.length === 0 && !value) return null;
  if (!isSuccess && !value) return null;

  const items = [
    { value: ALL, label: t('areaAll') },
    ...areas.map((a) => ({ value: a.id, label: `${a.name} (${t('areaTills', { count: a.machineCount })})` })),
  ];
  if (value && !items.some((i) => i.value === value)) {
    items.push({ value, label: isSuccess ? t('areaUnavailable') : tc('loading') });
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border bg-muted/30 px-3 py-2">
      <span className="flex items-center gap-1.5 text-sm font-medium">
        <LayoutGrid className="h-4 w-4 text-muted-foreground" aria-hidden />
        {t('areaLabel', { shop: shopName })}
      </span>
      <Select
        value={value ?? ALL}
        onValueChange={(v) => onChange(!v || v === ALL ? null : String(v))}
        items={items}
      >
        <SelectTrigger className="w-auto min-w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {items.map((i) => (
            <SelectItem key={i.value} value={i.value} label={i.label}>
              {i.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="text-muted-foreground basis-full text-xs">{t('areaHint')}</span>
    </div>
  );
}
