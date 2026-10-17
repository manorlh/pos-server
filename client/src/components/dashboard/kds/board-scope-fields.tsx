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
  follow = false,
  onFollow,
  deviceAreaName = null,
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
  /** "תצוגה לפי נקודת המכירה של המסך": the orders of the point of sale the screen's device stands in. */
  follow?: boolean;
  onFollow?: (on: boolean) => void;
  /** The point of sale of the screen's device (null: none — the option is not offered). */
  deviceAreaName?: string | null;
}) {
  const t = useTranslations('kds.page.devices.dialog.scope');
  const followOn = follow && !!deviceAreaName;
  const some = value !== null && !followOn;
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
      <div role="radiogroup" aria-label={t('title')} className={cn('grid gap-2', deviceAreaName ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}>
        {deviceAreaName ? (
          <button
            type="button"
            role="radio"
            aria-checked={followOn}
            onClick={() => onFollow?.(true)}
            className={cn('min-h-10 rounded-md border-2 px-3 py-2 text-start text-sm', followOn ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50')}
          >
            {t('follow', { area: deviceAreaName })}
          </button>
        ) : null}
        {[false, true].map((s) => (
          <button
            key={String(s)}
            type="button"
            role="radio"
            aria-checked={!followOn && some === s}
            onClick={() => {
              onFollow?.(false);
              onChange(s ? scope : null);
            }}
            className={cn('min-h-10 rounded-md border-2 px-3 py-2 text-start text-sm', !followOn && some === s ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50')}
          >
            {s ? t('some') : t('all')}
          </button>
        ))}
      </div>
      {followOn ? <p className="text-xs text-muted-foreground">{t('followHint', { area: deviceAreaName ?? '' })}</p> : null}
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
