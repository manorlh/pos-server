'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  KIOSK_LIMITS,
  fontStack,
  resolveThemeColors,
  type AnimationLevel,
  type CardStyle,
  type CartStyle,
  type CategoryLayout,
  type CategoryStyle,
  type GridDensity,
  type ButtonShape,
  type ImageRatio,
  type KioskTextKey,
  type ScreenImageKey,
  type ThemeMode,
  type TypeScale,
  type TypeWeight,
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
} from './fields';
import { useGoogleFonts } from './use-google-fonts';
import { StylePicker } from './style-picker';
import { LayoutSection } from './section-layout';

type TextScreen = Exclude<PreviewScreen, 'product'>;

/** The texts each screen shows, and its header image (the attract screen has the playlist). */
export const TEXT_GROUPS: { screen: TextScreen; keys: KioskTextKey[]; image: ScreenImageKey | null }[] = [
  { screen: 'attract', keys: ['attractTitle', 'attractSubtitle', 'attractCta', 'attractTouchHint', 'helpText'], image: null },
  {
    screen: 'service',
    keys: ['serviceCaption', 'serviceTitle', 'serviceSubtitle', 'takeAwayLabel', 'takeAwaySub', 'eatInLabel', 'eatInSub', 'serviceContinue', 'serviceHint'],
    image: 'service',
  },
  // "scan…": the short centred notes after a barcode scan (the kiosk's scanner, on every ordering screen).
  // The search and the dish's note are typed in the kiosk's window (its keyboard's words: "פרטים").
  {
    screen: 'catalog',
    keys: ['catalogTitle', 'upsellTitle', 'scanNotFound', 'scanVoucherAtTill', 'searchTitle', 'searchHint', 'noteTitle', 'noteHint', 'noteSave'],
    image: 'catalogHeader',
  },
  // "ההזמנה שלי": the review before the payment.
  { screen: 'cart', keys: ['cartTitle', 'reviewHint', 'reviewItems', 'reviewItemsOne', 'reviewSubtotal', 'reviewTotal', 'addMoreCta', 'checkoutCta'], image: 'cart' },
  // "רוצים להוסיף טיפ לצוות?" and the step bar of the steps before the payment.
  {
    screen: 'tip',
    keys: [
      'tipCaption',
      'stepReview',
      'stepTip',
      'stepDetails',
      'stepPay',
      'tipTitle',
      'tipSubtitle',
      'tipOtherLabel',
      'tipOtherHint',
      'tipOtherError',
      'tipOrderTotal',
      'tipLine',
      'tipTotal',
      'tipContinue',
      'tipSkip',
    ],
    image: null,
  },
  // The details page and its window ("איך לקרוא לכם?", the phone, the table), and the kiosk's keyboard.
  {
    screen: 'details',
    keys: [
      'customerTitle',
      'customerExplain',
      'detailsCaption',
      'nameTitle',
      'nameSubtitle',
      'nameLabel',
      'nameHint',
      'nameConfirm',
      'nameSkip',
      'phoneTitle',
      'phoneHint',
      'tableTitle',
      'entryContinue',
      'entrySkip',
      'fieldRequired',
      'phoneInvalid',
      'kbToEnglish',
      'kbToHebrew',
      'kbNumbers',
      'kbLettersHe',
      'kbLettersEn',
      'kbSpace',
    ],
    image: null,
  },
  { screen: 'pay', keys: ['payTitle', 'payInstruction'], image: 'pay' },
  { screen: 'success', keys: ['successTitle', 'successBody', 'pickupLabel'], image: 'success' },
  {
    screen: 'paused',
    keys: [
      'pausedTitle',
      'pausedBody',
      'closedTitle',
      'closedBody',
      'noPaymentTitle',
      'noPaymentBody',
      'offlineTitle',
      'offlineBody',
    ],
    image: 'paused',
  },
];

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

/**
 * The header image of each screen. The texts moved to their own section, "טקסטים" (section-texts.tsx:
 * every text, per screen and language); TEXT_GROUPS stays the flat `texts` keys by screen.
 */
function ScreenImages() {
  const t = useTranslations('kiosks.appearance');
  const tf = useTranslations('kiosks.fields');
  const ed = useKioskEditor();
  const withImage = TEXT_GROUPS.filter((g) => g.image !== null);
  const [screen, setScreen] = useState<TextScreen>(withImage[0]?.screen ?? 'service');
  const group = withImage.find((g) => g.screen === screen) ?? withImage[0];
  return (
    <SectionCard title={t('screenImagesTitle')} description={t('screenImagesHint')} paths={['screenImages']}>
      <Segmented<TextScreen>
        value={screen}
        ariaLabel={t('screenImagesTitle')}
        options={withImage.map((g) => ({ value: g.screen, label: t(`screens.${g.screen}`) }))}
        onChange={(s) => {
          setScreen(s);
          ed.showScreen(s);
        }}
      />
      <div key={screen} className="space-y-4 animate-in fade-in duration-300">
        {group?.image ? (
          <MediaField path={`screenImages.${group.image}`} label={tf(`screenImages.${group.image}`)} />
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
      <SectionCard title={t('uiStyleTitle')} description={t('uiStyleCardHint')} paths={['theme.uiStyle']}>
        <StylePicker />
      </SectionCard>

      {/* "מבנה הקיוסק" beside the style: the template, the accessibility mode, "מתקדם", the category icons. */}
      <LayoutSection />

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
          'theme.categoryLayout',
          'theme.typeScale',
          'theme.typeWeight',
          'theme.cartStyle',
          'theme.animation',
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
        <SegmentField<CategoryLayout>
          path="theme.categoryLayout"
          label={tf('theme.categoryLayout')}
          hint={t('layoutHint')}
          options={(['side', 'top'] as const).map((v) => ({ value: v, label: t(`layout.${v}`) }))}
        />
        <SegmentField<CategoryStyle>
          path="theme.categoryStyle"
          label={tf('theme.categoryStyle')}
          hint={t('categoryStyleHint')}
          options={(['chips', 'tabs', 'images'] as const).map((v) => ({ value: v, label: t(`category.${v}`) }))}
        />
        <SegmentField<TypeScale>
          path="theme.typeScale"
          label={tf('theme.typeScale')}
          options={(['normal', 'large', 'xlarge'] as const).map((v) => ({ value: v, label: t(`typeScale.${v}`) }))}
        />
        <SegmentField<TypeWeight>
          path="theme.typeWeight"
          label={tf('theme.typeWeight')}
          options={(['light', 'regular', 'bold'] as const).map((v) => ({ value: v, label: t(`typeWeight.${v}`) }))}
        />
        <SegmentField<CartStyle>
          path="theme.cartStyle"
          label={tf('theme.cartStyle')}
          hint={t('cartStyleHint')}
          options={(['bar', 'panel'] as const).map((v) => ({ value: v, label: t(`cartStyle.${v}`) }))}
        />
        <SegmentField<AnimationLevel>
          path="theme.animation"
          label={tf('theme.animation')}
          hint={t('animationHint')}
          options={(['subtle', 'lively'] as const).map((v) => ({ value: v, label: t(`animation.${v}`) }))}
        />
        <SwitchField path="theme.showDescriptions" label={tf('theme.showDescriptions')} />
      </SectionCard>

      <ScreenImages />
    </div>
  );
}
