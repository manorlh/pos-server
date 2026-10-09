'use client';

/**
 * "ברוכים הבאים" on the attract screen (attract.welcome): on or off, where (top / middle / bottom ×
 * start / centre / end), how big and bold, its colours, what is behind it and how wide. Its
 * place among the stacked blocks at the bottom is `welcome` in "סדר המסך" (attract.sections).
 */

import { useTranslations } from 'next-intl';
import { cn } from '@/lib/utils';
import {
  WELCOME_ALIGNS,
  WELCOME_BACKDROPS,
  WELCOME_POSITIONS,
  WELCOME_SIZES,
  WELCOME_WEIGHTS,
  type WelcomeAlign,
  type WelcomeBackdrop,
  type WelcomePosition,
  type WelcomeSize,
  type WelcomeWeight,
} from '@/lib/kioskLayout';
import { KIOSK_LIMITS } from '@/lib/kioskConfig';
import { useKioskField } from './editor-context';
import { ColorField, FieldShell, NumberField, OverrideMark, SectionCard, SegmentField, SwitchField, TextField } from './fields';

/** The 3 × 3 place of the block: rows top / middle / bottom, columns start / centre / end (right first in Hebrew). */
function WelcomePlace() {
  const t = useTranslations('kiosks.welcome');
  const pos = useKioskField<WelcomePosition>('attract.welcome.position');
  const align = useKioskField<WelcomeAlign>('attract.welcome.align');
  return (
    <FieldShell path="attract.welcome.position" label={t('place')} hint={t('placeHint')}>
      <div className="flex flex-wrap items-start gap-3">
        <div dir="rtl" role="radiogroup" aria-label={t('place')} className="grid w-28 grid-cols-3 gap-1 rounded-xl bg-muted p-1.5" style={{ aspectRatio: '9 / 14' }}>
          {WELCOME_POSITIONS.map((p) =>
            WELCOME_ALIGNS.map((a) => {
              const on = pos.value === p && align.value === a;
              return (
                <button
                  key={`${p}-${a}`}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  aria-label={`${t(`position.${p}`)} · ${t(`align.${a}`)}`}
                  title={`${t(`position.${p}`)} · ${t(`align.${a}`)}`}
                  disabled={pos.disabled}
                  onClick={() => {
                    if (pos.value !== p) pos.set(p);
                    if (align.value !== a) align.set(a);
                  }}
                  className={cn(
                    'flex items-center rounded-md transition-all duration-200',
                    a === 'start' ? 'justify-start' : a === 'end' ? 'justify-end' : 'justify-center',
                    on ? 'bg-primary/15 ring-1 ring-primary' : 'hover:bg-background',
                  )}
                >
                  <span className={cn('mx-1 block h-1.5 rounded-full', on ? 'w-6 bg-primary' : 'w-4 bg-muted-foreground/40')} />
                </button>
              );
            }),
          )}
        </div>
        <div className="space-y-1 text-xs text-muted-foreground">
          <div>
            {t(`position.${pos.value}`)} · {t(`align.${align.value}`)}
          </div>
          <div className="flex items-center gap-1">
            {t('alignLabel')} <OverrideMark path="attract.welcome.align" />
          </div>
        </div>
      </div>
    </FieldShell>
  );
}

export function WelcomeCard() {
  const t = useTranslations('kiosks.welcome');
  const tf = useTranslations('kiosks.fields');
  const tb = useTranslations('kiosks.builtin');
  const enabled = useKioskField<boolean>('attract.welcome.enabled');
  return (
    <SectionCard title={t('title')} description={t('hint')} paths={['attract.welcome']}>
      <SwitchField path="attract.welcome.enabled" label={t('enabled')} />
      {enabled.value ? (
        <div className="space-y-4 animate-in fade-in duration-200">
          <TextField path="texts.attractTitle" label={tf('texts.attractTitle')} max={KIOSK_LIMITS.textMax} placeholder={tb('attractTitle')} />
          <SwitchField path="attract.welcome.showSubtitle" label={t('showSubtitle')} />
          <TextField path="texts.attractSubtitle" label={tf('texts.attractSubtitle')} max={KIOSK_LIMITS.textMax} placeholder={tb('attractSubtitle')} multiline />
          <WelcomePlace />
          <SegmentField<WelcomeSize>
            path="attract.welcome.size"
            label={t('size')}
            options={WELCOME_SIZES.map((v) => ({ value: v, label: t(`sizes.${v}`) }))}
          />
          <SegmentField<WelcomeWeight>
            path="attract.welcome.weight"
            label={t('weight')}
            options={WELCOME_WEIGHTS.map((v) => ({ value: v, label: t(`weights.${v}`) }))}
          />
          <SegmentField<WelcomeBackdrop>
            path="attract.welcome.backdrop"
            label={t('backdrop')}
            hint={t('backdropHint')}
            options={WELCOME_BACKDROPS.map((v) => ({ value: v, label: t(`backdrops.${v}`) }))}
          />
          <ColorField path="attract.welcome.titleColor" label={t('titleColor')} nullable nullLabel={t('colorAuto')} fallback="#FFFFFF" />
          <ColorField path="attract.welcome.subtitleColor" label={t('subtitleColor')} nullable nullLabel={t('subtitleAuto')} fallback="#FFFFFF" />
          <NumberField path="attract.welcome.maxWidthPct" label={t('maxWidth')} hint={t('maxWidthHint')} min={40} max={100} suffix="%" slider />
        </div>
      ) : null}
    </SectionCard>
  );
}
