'use client';

/**
 * "עיצוב לרוחב" in the kiosk editor (P:/specs/kiosk-landscape-design.md §5): the "לאורך / לרוחב" switch over every
 * section — in landscape, the design fields that have a landscape counterpart edit `landscape.*` (editor-context
 * useKioskField) — and the card of the landscape sizes ("לא ענקיים"), each with its default and its range.
 */

import { useTranslations } from 'next-intl';
import { Monitor, RotateCcw, Tablet } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getPath } from '@/lib/kioskConfig';
import { LANDSCAPE_SIZE_KEYS, LANDSCAPE_SIZE_SPECS, type LandscapeSizeKey } from '@/lib/kioskLandscape';
import { sameSetting, useFieldErrors, useKioskEditor, type KioskEditorOrientation } from './editor-context';
import { NumberInput, SectionCard } from './fields';

/** How many landscape values this level sets (the switch's count). */
function landscapeCount(layer: unknown): number {
  let n = 0;
  const walk = (v: unknown) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && !('url' in (v as object))) Object.values(v as object).forEach(walk);
    else if (v !== null && v !== undefined) n++;
  };
  walk(layer);
  return n;
}

/** "לאורך / לרוחב": which design the editor's fields edit. */
export function OrientationBar() {
  const t = useTranslations('kiosks.landscape');
  const ed = useKioskEditor();
  const value: KioskEditorOrientation = ed.orientation ?? 'portrait';
  const n = landscapeCount(ed.draft.landscape);
  const options: { v: KioskEditorOrientation; icon: typeof Tablet }[] = [
    { v: 'portrait', icon: Tablet },
    { v: 'landscape', icon: Monitor },
  ];
  return (
    <div className={cn('flex flex-wrap items-center gap-3 rounded-2xl border p-2.5 transition-colors duration-300', value === 'landscape' && 'border-amber-300 bg-amber-50/60 dark:border-amber-800 dark:bg-amber-950/30')}>
      <div role="radiogroup" aria-label={t('switchLabel')} className="inline-flex rounded-xl bg-muted p-1">
        {options.map(({ v, icon: Icon }) => (
          <button
            key={v}
            type="button"
            role="radio"
            aria-checked={value === v}
            onClick={() => ed.setOrientation?.(v)}
            className={cn(
              'flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition-all duration-200',
              value === v ? 'bg-background font-medium shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon className={cn('h-4 w-4', v === 'landscape' && 'rotate-0')} />
            {t(v)}
            {v === 'landscape' && n > 0 ? (
              <Badge variant="secondary" className="h-4 min-w-4 px-1 text-[10px]">
                {n}
              </Badge>
            ) : null}
          </button>
        ))}
      </div>
      <p className="min-w-0 flex-1 text-xs text-muted-foreground">{value === 'landscape' ? t('landscapeHint') : t('portraitHint')}</p>
    </div>
  );
}

/** One landscape size: a slider and its number; unset — the default, greyed. */
function LandscapeSizeField({ k }: { k: LandscapeSizeKey }) {
  const t = useTranslations('kiosks.landscape');
  const ed = useKioskEditor();
  const path = `landscape.sizes.${k}`;
  const spec = LANDSCAPE_SIZE_SPECS[k];
  const own = getPath(ed.draft, path) as number | undefined | null;
  const inheritedOwn = getPath(ed.inherited, path) as number | undefined | null;
  const set = own !== undefined && own !== null;
  const overridden = !sameSetting(own, inheritedOwn);
  const value = set ? own : spec.default;
  const errors = useFieldErrors(path);
  const unit = k === 'textScalePct' ? '%' : k === 'productMinColumns' ? '' : 'dp';
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{t(`sizes.${k}`)}</span>
        {!set ? (
          <Badge variant="outline" className="text-[11px] font-normal text-muted-foreground">
            {t('default', { n: `${spec.default}${unit}` })}
          </Badge>
        ) : (
          <span className="inline-flex items-center gap-1">
            <Badge variant="secondary" className="bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200">
              {overridden ? t('setHere') : t('setAbove')}
            </Badge>
            {ed.canEdit && overridden ? (
              <Button type="button" size="xs" variant="ghost" className="h-6 gap-1 px-1.5 text-[11px]" onClick={() => ed.reset(path)}>
                <RotateCcw className="h-3 w-3" /> {t('resetDefault')}
              </Button>
            ) : null}
          </span>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t(`sizesHint.${k}`)}</p>
      <div className="flex items-center gap-3">
        <input
          type="range"
          className={cn('h-2 min-w-40 flex-1 cursor-pointer accent-primary', !set && 'opacity-50')}
          min={spec.min}
          max={spec.max}
          step={spec.step}
          value={value}
          disabled={!ed.canEdit}
          aria-label={t(`sizes.${k}`)}
          onPointerDown={() => ed.showScreen('catalog')}
          onChange={(e) => ed.set(path, Number(e.target.value))}
        />
        <NumberInput
          value={value}
          onChange={(n) => ed.set(path, n)}
          min={spec.min}
          max={spec.max}
          disabled={!ed.canEdit}
          suffix={unit || undefined}
          ariaLabel={t(`sizes.${k}`)}
        />
      </div>
      {errors.map((e) => (
        <p key={e} className="text-xs text-destructive">
          {e}
        </p>
      ))}
    </div>
  );
}

/** "גדלים לרוחב": the category column, a category's tile and picture, a dish's tile, columns and picture, the text. */
export function LandscapeSizesCard() {
  const t = useTranslations('kiosks.landscape');
  return (
    <SectionCard title={t('sizesTitle')} description={t('sizesHint.card')}>
      <div className="grid gap-5">
        {LANDSCAPE_SIZE_KEYS.map((k) => (
          <LandscapeSizeField key={k} k={k} />
        ))}
      </div>
    </SectionCard>
  );
}
