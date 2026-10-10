'use client';

/**
 * "כפתור מסך הפתיחה" — the attract screen's call to action (attract.cta): size, a physical
 * place (3×3, full width at the bottom, or anywhere — dragged in the preview), colours,
 * type, corners, border, icon, motion, a second line and "כל המסך פותח הזמנה".
 */

import { useTranslations } from 'next-intl';
import { Hand, Move, RectangleHorizontal } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import {
  CTA_ANIMATIONS,
  CTA_ICONS,
  CTA_WEIGHTS,
  KIOSK_LIMITS,
  resolveThemeColors,
  type CtaAnimation,
  type CtaIcon,
  type CtaIconPosition,
  type CtaPosition,
  type CtaSize,
  type CtaWeight,
} from '@/lib/kioskConfig';
import { useKioskEditor, useKioskField } from './editor-context';
import { ColorField, FieldShell, NumberField, NumberInput, SectionCard, SegmentField, SwitchField, TextField } from './fields';

const P = 'attract.cta';

/** The 3×3 grid, laid out physically (left is the screen's left in every language). */
const GRID: CtaPosition[][] = [
  ['top_left', 'top_center', 'top_right'],
  ['middle_left', 'middle_center', 'middle_right'],
  ['bottom_left', 'bottom_center', 'bottom_right'],
];

function PositionPicker() {
  const t = useTranslations('kiosks.cta');
  const tf = useTranslations('kiosks.fields');
  const f = useKioskField<CtaPosition>(`${P}.position`);
  const x = useKioskField<number>(`${P}.x`);
  const y = useKioskField<number>(`${P}.y`);
  return (
    <FieldShell path={`${P}.position`} label={tf('cta.position')} hint={t('positionHint')}>
      <div className="flex flex-wrap items-start gap-4">
        <div dir="ltr" className="grid w-36 grid-cols-3 gap-1 rounded-xl border bg-muted/40 p-1.5" role="radiogroup" aria-label={tf('cta.position')}>
          {GRID.flat().map((pos) => {
            const on = f.value === pos;
            return (
              <button
                key={pos}
                type="button"
                role="radio"
                aria-checked={on}
                title={t(`positions.${pos}`)}
                aria-label={t(`positions.${pos}`)}
                disabled={f.disabled}
                onClick={() => f.set(pos)}
                className={cn(
                  'flex h-9 items-center justify-center rounded-lg transition-all duration-150 disabled:opacity-50',
                  on ? 'bg-primary text-primary-foreground shadow-sm' : 'bg-background hover:bg-muted',
                )}
              >
                <span className={cn('h-2 w-5 rounded-full', on ? 'bg-primary-foreground' : 'bg-muted-foreground/40')} />
              </button>
            );
          })}
        </div>
        <div className="flex flex-col gap-2">
          <Button
            type="button"
            size="sm"
            variant={f.value === 'bottom_full' ? 'default' : 'outline'}
            disabled={f.disabled}
            onClick={() => f.set('bottom_full')}
          >
            <RectangleHorizontal /> {t('positions.bottom_full')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant={f.value === 'custom' ? 'default' : 'outline'}
            disabled={f.disabled}
            onClick={() => f.set('custom')}
          >
            <Move /> {t('positions.custom')}
          </Button>
        </div>
      </div>
      {f.value === 'custom' ? (
        <div className="mt-3 space-y-2 rounded-xl border bg-muted/30 p-3">
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Hand className="h-3.5 w-3.5" /> {t('dragHint')}
          </p>
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-sm">
              {t('xLabel')}
              <NumberInput value={x.value} min={0} max={100} suffix="%" disabled={x.disabled} onChange={x.set} ariaLabel={t('xLabel')} />
            </label>
            <label className="flex items-center gap-2 text-sm">
              {t('yLabel')}
              <NumberInput value={y.value} min={0} max={100} suffix="%" disabled={y.disabled} onChange={y.set} ariaLabel={t('yLabel')} />
            </label>
          </div>
        </div>
      ) : null}
    </FieldShell>
  );
}

function RadiusField() {
  const t = useTranslations('kiosks.cta');
  const tf = useTranslations('kiosks.fields');
  const f = useKioskField<number | null>(`${P}.radius`);
  const value = f.value;
  return (
    <FieldShell path={`${P}.radius`} label={tf('cta.radius')}>
      <div className="flex flex-wrap items-center gap-3">
        {value === null ? (
          <>
            <Badge variant="outline">{t('byTheme')}</Badge>
            <Button type="button" size="xs" variant="ghost" disabled={f.disabled} onClick={() => f.set(50)}>
              {t('customRadius')}
            </Button>
          </>
        ) : (
          <>
            <span className="text-xs text-muted-foreground">{t('square')}</span>
            <input
              type="range"
              className="h-2 min-w-40 flex-1 cursor-pointer accent-primary"
              min={KIOSK_LIMITS.ctaRadius.min}
              max={KIOSK_LIMITS.ctaRadius.max}
              value={value}
              disabled={f.disabled}
              aria-label={tf('cta.radius')}
              onChange={(e) => f.set(Number(e.target.value))}
            />
            <span className="text-xs text-muted-foreground">{t('pill')}</span>
            <Button type="button" size="xs" variant="ghost" disabled={f.disabled} onClick={() => f.set(null)}>
              {t('byTheme')}
            </Button>
          </>
        )}
      </div>
    </FieldShell>
  );
}

export function CtaSection() {
  const t = useTranslations('kiosks.cta');
  const tf = useTranslations('kiosks.fields');
  const ed = useKioskEditor();
  const size = useKioskField<CtaSize>(`${P}.size`);
  const colors = resolveThemeColors(ed.draft.theme);
  const cta = ed.draft.attract.cta;
  const textColor = cta.textColor ?? colors.buttonText;
  return (
    <SectionCard title={t('title')} description={t('hint')} paths={[P]}>
      <VisibleFields />
      <SegmentField<CtaSize>
        path={`${P}.size`}
        label={tf('cta.size')}
        options={(['s', 'm', 'l', 'xl', 'custom'] as const).map((v) => ({ value: v, label: t(`sizes.${v}`) }))}
      />
      {size.value === 'custom' ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <NumberField
            path={`${P}.widthPct`}
            label={tf('cta.widthPct')}
            min={KIOSK_LIMITS.ctaWidthPct.min}
            max={KIOSK_LIMITS.ctaWidthPct.max}
            suffix="%"
            slider
          />
          <NumberField
            path={`${P}.heightDp`}
            label={tf('cta.heightDp')}
            hint={t('heightHint')}
            min={KIOSK_LIMITS.ctaHeightDp.min}
            max={KIOSK_LIMITS.ctaHeightDp.max}
            suffix="dp"
            slider
          />
        </div>
      ) : null}
      <PositionPicker />
      <ColorField path={`${P}.fillColor`} label={tf('cta.fillColor')} nullable nullLabel={t('byTheme')} fallback={colors.button} />
      <ColorField path={`${P}.textColor`} label={tf('cta.textColor')} nullable nullLabel={t('byTheme')} fallback={colors.buttonText} />
      <NumberField
        path={`${P}.fontSize`}
        label={tf('cta.fontSize')}
        hint={t('fontSizeHint')}
        min={KIOSK_LIMITS.ctaFontSize.min}
        max={KIOSK_LIMITS.ctaFontSize.max}
        suffix="sp"
        slider
      />
      <SegmentField<CtaWeight>
        path={`${P}.fontWeight`}
        label={tf('cta.fontWeight')}
        options={CTA_WEIGHTS.map((v) => ({ value: v, label: t(`weights.${v}`) }))}
      />
      <RadiusField />
      <ColorField path={`${P}.borderColor`} label={tf('cta.borderColor')} nullable nullLabel={t('byText')} fallback={textColor} />
      <NumberField path={`${P}.borderWidth`} label={tf('cta.borderWidth')} min={KIOSK_LIMITS.ctaBorderWidth.min} max={KIOSK_LIMITS.ctaBorderWidth.max} suffix="dp" />
      <SwitchField path={`${P}.shadow`} label={tf('cta.shadow')} />
      <SegmentField<CtaIcon>
        path={`${P}.icon`}
        label={tf('cta.icon')}
        options={CTA_ICONS.map((v) => ({ value: v, label: t(`icons.${v}`) }))}
      />
      {cta.icon !== 'none' ? (
        <SegmentField<CtaIconPosition>
          path={`${P}.iconPosition`}
          label={tf('cta.iconPosition')}
          options={(['start', 'end'] as const).map((v) => ({ value: v, label: t(`iconSides.${v}`) }))}
        />
      ) : null}
      <SegmentField<CtaAnimation>
        path={`${P}.animation`}
        label={tf('cta.animation')}
        hint={ed.draft.general.reduceMotion ? t('animationOff') : t('animationHint')}
        options={CTA_ANIMATIONS.map((v) => ({ value: v, label: t(`animations.${v}`) }))}
      />
      <TextField path={`${P}.subtitle`} label={tf('cta.subtitle')} hint={t('subtitleHint')} max={KIOSK_LIMITS.ctaSubtitleMax} />
      <TapAnywhereField />
    </SectionCard>
  );
}

/**
 * "הצג כפתור התחלה": hidden, the whole screen starts an order (tapAnywhere set on and locked), and
 * "טקסט במקום הכפתור" draws texts.attractTouchHint in its place.
 */
function VisibleFields() {
  const t = useTranslations('kiosks.cta');
  const tf = useTranslations('kiosks.fields');
  const visible = useKioskField<boolean>(`${P}.visible`);
  const tap = useKioskField<boolean>(`${P}.tapAnywhere`);
  const shown = visible.value !== false;
  return (
    <>
      <FieldShell path={`${P}.visible`} label={tf('cta.visible')} hint={t('visibleHint')} inline>
        <Switch
          checked={shown}
          disabled={visible.disabled}
          aria-label={tf('cta.visible')}
          onCheckedChange={(v) => {
            visible.set(!!v);
            if (!v && tap.value !== true) tap.set(true);
          }}
        />
      </FieldShell>
      {!shown ? <SwitchField path={`${P}.touchHint`} label={tf('cta.touchHint')} hint={t('touchHintHint')} /> : null}
    </>
  );
}

/** "כל המסך פותח הזמנה" — always on (greyed out) while the button is hidden. */
function TapAnywhereField() {
  const t = useTranslations('kiosks.cta');
  const tf = useTranslations('kiosks.fields');
  const tap = useKioskField<boolean>(`${P}.tapAnywhere`);
  const visible = useKioskField<boolean>(`${P}.visible`);
  const forced = visible.value === false;
  return (
    <FieldShell path={`${P}.tapAnywhere`} label={tf('cta.tapAnywhere')} hint={forced ? t('tapAnywhereForced') : t('tapAnywhereHint')} inline>
      <Switch checked={forced || !!tap.value} disabled={tap.disabled || forced} aria-label={tf('cta.tapAnywhere')} onCheckedChange={(v) => tap.set(!!v)} />
    </FieldShell>
  );
}
