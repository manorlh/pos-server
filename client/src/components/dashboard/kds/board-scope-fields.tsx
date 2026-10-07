'use client';

/**
 * "אילו הזמנות יוצגו" of a screen — a kitchen screen (station / Expo / manager, on top of its
 * stations) or a "מסך מוכן / לא מוכן" board — in the KDS page's device dialog (docs/SPEC_KDS.md
 * §15): the whole shop (as before), or only the orders of some points of sale (`shop_areas`) and /
 * or of some tills and kiosks. Saved as `kds_devices.scope`; the cloud applies it when it builds
 * the screen's board, so every screen (Android, Windows, the browser) shows the same.
 */

import { useTranslations } from 'next-intl';
import type { KdsBoardScope, KdsShopMachine } from '@/lib/kdsApi';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';

export function scopeIsWholeShop(s: KdsBoardScope | null | undefined): boolean {
  return !s || (s.areaIds.length === 0 && s.machineIds.length === 0);
}

export function BoardScopeFields({
  value,
  onChange,
  areas,
  machines,
  tillLabel,
  kitchen = false,
}: {
  /** null = the whole shop. */
  value: KdsBoardScope | null;
  onChange: (next: KdsBoardScope | null) => void;
  areas: { id: string; name: string }[];
  /** The shop's machines that send orders (tills and kiosks — not the screens themselves). */
  machines: KdsShopMachine[];
  tillLabel: (m: KdsShopMachine) => string;
  /** A kitchen screen: the scope narrows its stations' orders. */
  kitchen?: boolean;
}) {
  const t = useTranslations('kds.page.devices.dialog.scope');
  const some = value !== null;
  const scope = value ?? { areaIds: [], machineIds: [] };
  const toggle = (key: 'areaIds' | 'machineIds', id: string, on: boolean) =>
    onChange({ ...scope, [key]: on ? [...scope[key], id] : scope[key].filter((x) => x !== id) });
  const box = (key: 'areaIds' | 'machineIds', id: string, label: React.ReactNode) => {
    const checked = scope[key].includes(id);
    return (
      <label key={id} className={cn('flex min-h-10 cursor-pointer items-center gap-2 rounded-md border-2 px-2.5 text-sm', checked ? 'border-primary/70 bg-primary/5' : 'border-border')}>
        <input type="checkbox" className="h-4 w-4 accent-primary" checked={checked} onChange={(e) => toggle(key, id, e.target.checked)} />
        {label}
      </label>
    );
  };
  return (
    <div className="space-y-3 rounded-lg border border-dashed p-3">
      <p className="text-sm font-medium">{t('title')}</p>
      <div role="radiogroup" aria-label={t('title')} className="grid gap-2 sm:grid-cols-2">
        {[false, true].map((s) => (
          <button
            key={String(s)}
            type="button"
            role="radio"
            aria-checked={some === s}
            onClick={() => onChange(s ? scope : null)}
            className={cn('min-h-10 rounded-md border-2 px-3 py-2 text-start text-sm', some === s ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50')}
          >
            {s ? t('some') : t('all')}
          </button>
        ))}
      </div>
      {some ? (
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            {t('hint')}
            {kitchen ? ` ${t('kitchenHint')}` : ''}
          </p>
          <div className="space-y-1.5">
            <p className="text-xs font-medium">{t('areas')}</p>
            {areas.length === 0 ? <p className="text-xs text-muted-foreground">{t('noAreas')}</p> : <div className="grid gap-1.5 sm:grid-cols-2">{areas.map((a) => box('areaIds', a.id, a.name))}</div>}
          </div>
          <div className="space-y-1.5">
            <p className="text-xs font-medium">{t('machines')}</p>
            <div className="grid gap-1.5 sm:grid-cols-2">
              {machines.map((m) =>
                box(
                  'machineIds',
                  m.id,
                  <span className="inline-flex items-center gap-1">
                    {tillLabel(m)}
                    {m.kiosk ? (
                      <Badge variant="outline" className="h-4 px-1 text-[10px] font-normal">
                        {t('kiosk')}
                      </Badge>
                    ) : null}
                  </span>,
                ),
              )}
            </div>
          </div>
          {scopeIsWholeShop(scope) ? <p className="text-xs text-destructive">{t('empty')}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
