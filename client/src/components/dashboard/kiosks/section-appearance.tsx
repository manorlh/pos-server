'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  KIOSK_LIMITS,
  fontStack,
  resolveThemeColors,
  type CardStyle,
  type CategoryStyle,
  type GridDensity,
  type ButtonShape,
  type ImageRatio,
  type KioskTextKey,
  type ScreenImageKey,
  type ThemeMode,
} from '@/lib/kioskConfig';
import { useKioskEditor, useKioskField, type PreviewScreen } from './editor-context';
import {
  ColorField,
  FieldShell,
  MediaField,
  NumberField,
  SectionCard,
  SegmentField,
  Segmented,
  SwitchField,
  TextField,
} from './fields';
import { useGoogleFonts } from './use-google-fonts';

type TextScreen = Exclude<PreviewScreen, 'product'>;

/** The texts each screen shows, and its header image (the attract screen has the playlist). */
export const TEXT_GROUPS: { screen: TextScreen; keys: KioskTextKey[]; image: ScreenImageKey | null }[] = [
  { screen: 'attract', keys: ['attractTitle', 'attractSubtitle', 'attractCta', 'helpText'], image: null },
  { screen: 'service', keys: ['serviceTitle', 'takeAwayLabel', 'eatInLabel'], image: 'service' },
  { screen: 'catalog', keys: ['catalogTitle', 'upsellTitle'], image: 'catalogHeader' },
  { screen: 'cart', keys: ['cartTitle', 'checkoutCta', 'customerTitle', 'customerExplain'], image: 'cart' },
  { screen: 'pay', keys: ['payTitle', 'payInstruction'], image: 'pay' },
  { screen: 'success', keys: ['successTitle', 'successBody', 'pickupLabel'], image: 'success' },
  { screen: 'paused', keys: ['pausedTitle', 'pausedBody', 'closedTitle', 'closedBody'], image: 'paused' },
];

const MULTILINE = new Set<KioskTextKey>([
  'attractSubtitle',
  'helpText',
  'customerExplain',
  'payInstruction',
  'successBody',
  'pausedBody',
  'closedBody',
]);

function FontPicker() {
  const t = useTranslations('kiosks.appearance');
  const tf = useTranslations('kiosks.fields');
  const { fonts } = useKioskEditor();
  const f = useKioskField<string>('theme.font');
  useGoogleFonts(fonts);
  return (
    <FieldShell path="theme.font" label={tf('theme.font')}>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {fonts.map((font) => {
          const active = f.value === font.id;
          return (
            <button
              key={font.id}
              type="button"
              disabled={f.disabled}
              onClick={() => f.set(font.id)}
              aria-pressed={active}
              className={cn(
                'rounded-xl border p-3 text-start transition-all duration-200 disabled:opacity-60',
                active ? 'border-primary bg-primary/5 ring-1 ring-primary' : 'hover:bg-muted/50',
              )}
            >
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span>{font.label}</span>
                {active ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
              </div>
              <div className="mt-1 text-lg leading-tight" style={{ fontFamily: fontStack(font.id, fonts) }}>
                {t('fontSample')}
              </div>
              <div className="text-sm font-bold" style={{ fontFamily: fontStack(font.id, fonts) }}>
                {t('fontSampleSmall')}
              </div>
            </button>
          );
        })}
      </div>
    </FieldShell>
  );
}

function TextsByScreen() {
  const t = useTranslations('kiosks.appearance');
  const tf = useTranslations('kiosks.fields');
  const tb = useTranslations('kiosks.builtin');
  const ed = useKioskEditor();
  const [screen, setScreen] = useState<TextScreen>('attract');
  const group = TEXT_GROUPS.find((g) => g.screen === screen) ?? TEXT_GROUPS[0];
  return (
    <SectionCard
      title={t('textsTitle')}
      description={t('textsHint')}
      paths={['texts', 'screenImages']}
    >
      <Segmented<TextScreen>
        value={screen}
        ariaLabel={t('textsTitle')}
        options={TEXT_GROUPS.map((g) => ({ value: g.screen, label: t(`screens.${g.screen}`) }))}
        onChange={(s) => {
          setScreen(s);
          ed.showScreen(s);
        }}
      />
      <div key={screen} className="space-y-4 animate-in fade-in duration-300">
        {group.keys.map((key) => (
          <TextField
            key={key}
            path={`texts.${key}`}
            label={tf(`texts.${key}`)}
            max={KIOSK_LIMITS.textMax}
            placeholder={tb(key)}
            multiline={MULTILINE.has(key)}
          />
        ))}
        {group.image ? (
          <MediaField path={`screenImages.${group.image}`} label={tf(`screenImages.${group.image}`)} hint={t('screenImagesHint')} />
        ) : null}
      </div>
    </SectionCard>
  );
}

export function AppearanceSection() {
  const t = useTranslations('kiosks.appearance');
  const tf = useTranslations('kiosks.fields');
  const ed = useKioskEditor();
  const colors = resolveThemeColors(ed.draft.theme);
  const radius = useKioskField<number>('theme.cornerRadius');

  return (
    <div className="space-y-4">
      <SectionCard title={t('themeTitle')} paths={['theme.mode', 'theme.font']}>
        <SegmentField<ThemeMode>
          path="theme.mode"
          label={tf('theme.mode')}
          options={[
            { value: 'light', label: t('light') },
            { value: 'dark', label: t('dark') },
          ]}
        />
        <FontPicker />
      </SectionCard>

      <SectionCard
        title={t('colorsTitle')}
        paths={[
          'theme.primaryColor',
          'theme.accentColor',
          'theme.backgroundColor',
          'theme.surfaceColor',
          'theme.textColor',
          'theme.buttonColor',
          'theme.buttonTextColor',
        ]}
      >
        <ColorField path="theme.primaryColor" label={tf('theme.primaryColor')} fallback="#1F6FEB" />
        <ColorField path="theme.accentColor" label={tf('theme.accentColor')} fallback="#16A34A" />
        <ColorField
          path="theme.backgroundColor"
          label={tf('theme.backgroundColor')}
          hint={t('colorNullHint')}
          nullable
          nullLabel={t('colorDefault')}
          fallback={colors.background}
        />
        <ColorField
          path="theme.surfaceColor"
          label={tf('theme.surfaceColor')}
          hint={t('colorNullHint')}
          nullable
          nullLabel={t('colorDefault')}
          fallback={colors.surface}
        />
        <ColorField
          path="theme.textColor"
          label={tf('theme.textColor')}
          hint={t('colorNullHint')}
          nullable
          nullLabel={t('colorDefault')}
          fallback={colors.text}
        />
        <ColorField
          path="theme.buttonColor"
          label={tf('theme.buttonColor')}
          hint={t('buttonColorHint')}
          nullable
          nullLabel={t('colorDefault')}
          fallback={colors.button}
        />
        <ColorField
          path="theme.buttonTextColor"
          label={tf('theme.buttonTextColor')}
          hint={t('buttonTextHint')}
          nullable
          nullLabel={t('colorAuto')}
          fallback={colors.buttonText}
        />
      </SectionCard>

      <SectionCard title={t('imagesTitle')} paths={['theme.logo', 'theme.backgroundImage']}>
        <MediaField path="theme.logo" label={tf('theme.logo')} hint={t('logoHint')} />
        <MediaField path="theme.backgroundImage" label={tf('theme.backgroundImage')} hint={t('backgroundHint')} />
      </SectionCard>

      <SectionCard
        title={t('shapeTitle')}
        paths={[
          'theme.cornerRadius',
          'theme.cardStyle',
          'theme.buttonShape',
          'theme.gridDensity',
          'theme.imageRatio',
          'theme.categoryStyle',
          'theme.showDescriptions',
        ]}
      >
        <NumberField
          path="theme.cornerRadius"
          label={tf('theme.cornerRadius')}
          hint={t('radiusHint', { n: Number.isFinite(radius.value) ? radius.value : 0 })}
          min={KIOSK_LIMITS.cornerRadius.min}
          max={KIOSK_LIMITS.cornerRadius.max}
          slider
        />
        <SegmentField<CardStyle>
          path="theme.cardStyle"
          label={tf('theme.cardStyle')}
          options={(['elevated', 'outlined', 'flat'] as const).map((v) => ({ value: v, label: t(`card.${v}`) }))}
        />
        <SegmentField<ButtonShape>
          path="theme.buttonShape"
          label={tf('theme.buttonShape')}
          options={(['pill', 'rounded', 'square'] as const).map((v) => ({ value: v, label: t(`button.${v}`) }))}
        />
        <SegmentField<GridDensity>
          path="theme.gridDensity"
          label={tf('theme.gridDensity')}
          options={(['compact', 'comfortable', 'large'] as const).map((v) => ({ value: v, label: t(`density.${v}`) }))}
        />
        <SegmentField<ImageRatio>
          path="theme.imageRatio"
          label={tf('theme.imageRatio')}
          options={(['1:1', '4:3', '16:9'] as const).map((v) => ({ value: v, label: <span dir="ltr">{v}</span> }))}
        />
        <SegmentField<CategoryStyle>
          path="theme.categoryStyle"
          label={tf('theme.categoryStyle')}
          options={(['chips', 'tabs', 'images'] as const).map((v) => ({ value: v, label: t(`category.${v}`) }))}
        />
        <SwitchField path="theme.showDescriptions" label={tf('theme.showDescriptions')} />
      </SectionCard>

      <TextsByScreen />
    </div>
  );
}
