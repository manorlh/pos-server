'use client';

/**
 * "Which area" filter for lists and reports: all, no area, or one area of the shop in
 * scope. Archived areas are offered too — history keeps pointing at them.
 *
 * The value is what the API's `areaId` filter takes: `''` (no filter), `none`, or an
 * area id. Without a shop in scope only "all" and "no area" make sense, since an area
 * belongs to one shop.
 */

import { useTranslations } from 'next-intl';
import { AREA_NONE } from '@/lib/api';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useShopAreas } from './use-shop-areas';

const ALL = '__all__';

export function AreaFilterSelect({
  shopId,
  value,
  onChange,
  className,
  label,
}: {
  shopId: string | null | undefined;
  value: string;
  onChange: (next: string) => void;
  className?: string;
  label?: string;
}) {
  const t = useTranslations('areas');
  const { data: areas = [] } = useShopAreas(shopId, true);

  const items = [
    { value: ALL, label: t('filter.all') },
    { value: AREA_NONE, label: t('filter.none') },
    ...areas.map((a) => ({
      value: a.id,
      label: a.archivedAt ? t('archivedName', { name: a.name }) : a.name,
    })),
  ];
  // An area id from a link, before the shop's areas have loaded (or of another shop),
  // still shows as selected rather than blank.
  if (value && !items.some((i) => i.value === value)) {
    items.push({ value, label: t('filter.unknownArea') });
  }

  return (
    <div className={`space-y-1 ${className ?? ''}`}>
      <Label className="text-xs">{label ?? t('filter.label')}</Label>
      <Select
        value={value || ALL}
        onValueChange={(v) => onChange(!v || v === ALL ? '' : String(v))}
        items={items}
      >
        <SelectTrigger className="min-w-40">
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
    </div>
  );
}

/** The area cell of a list row: the name, or a dash for none. */
export function AreaName({ name }: { name?: string | null }) {
  return name ? <span>{name}</span> : <span className="text-muted-foreground">—</span>;
}
