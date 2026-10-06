'use client';

/**
 * "הנפשות ומעברים": one picker per transition of the kiosk (the category switch, its dishes
 * coming in, the screens, the windows, the add-to-cart) and the speed — each inherited like every
 * kiosk setting (company → shop → kiosk, the style's preset underneath) and each with "הצג",
 * which plays it in the live preview.
 */

import { useTranslations } from 'next-intl';
import { Info, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  ADD_TO_CART_FX,
  CATEGORY_SWITCH_FX,
  ITEMS_ENTER_FX,
  MOTION_SPEEDS,
  SCREEN_CHANGE_FX,
  SHEET_FX,
  type KioskMotionSettings,
} from '@/lib/kioskConfig';
import { useKioskEditor, useKioskField } from './editor-context';
import { FieldShell, SectionCard, Segmented } from './fields';
import type { MotionDemo } from './kiosk-preview';

type MotionKey = keyof KioskMotionSettings;

const PICKERS: { key: MotionKey; options: readonly string[] }[] = [
  { key: 'categorySwitch', options: CATEGORY_SWITCH_FX },
  { key: 'itemsEnter', options: ITEMS_ENTER_FX },
  { key: 'screenChange', options: SCREEN_CHANGE_FX },
  { key: 'sheet', options: SHEET_FX },
  { key: 'addToCart', options: ADD_TO_CART_FX },
  { key: 'speed', options: MOTION_SPEEDS },
];

function MotionPicker({ name, options }: { name: MotionKey; options: readonly string[] }) {
  const t = useTranslations('kiosks.motion');
  const tf = useTranslations('kiosks.fields');
  const ed = useKioskEditor();
  const path = `motion.${name}`;
  const f = useKioskField<string>(path);
  const label = tf(path);
  const optionLabel = (v: string) => (name === 'speed' ? t(`speedOption.${v}`) : t(`fx.${v}`));
  return (
    <FieldShell path={path} label={label} hint={t(`${name}Hint`)}>
      <div className="flex flex-wrap items-center gap-2">
        <Segmented<string>
          value={f.value}
          options={options.map((v) => ({ value: v, label: optionLabel(v) }))}
          onChange={f.set}
          disabled={f.disabled}
          ariaLabel={label}
        />
        <Button type="button" size="sm" variant="outline" title={t('showHint')} onClick={() => ed.playMotion(name as MotionDemo)}>
          <Play /> {t('show')}
        </Button>
      </div>
    </FieldShell>
  );
}

export function MotionSection() {
  const t = useTranslations('kiosks.motion');
  const ed = useKioskEditor();
  return (
    <SectionCard title={t('title')} description={t('hint')} paths={['motion']}>
      {ed.draft.general.reduceMotion ? (
        <p className="flex items-start gap-2 rounded-xl border border-amber-300/60 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <Info className="mt-0.5 h-4 w-4 shrink-0" /> {t('reduceMotionOn')}
        </p>
      ) : null}
      {PICKERS.map((p) => (
        <MotionPicker key={p.key} name={p.key} options={p.options} />
      ))}
      <p className="text-xs text-muted-foreground">{t('perfNote')}</p>
    </SectionCard>
  );
}
