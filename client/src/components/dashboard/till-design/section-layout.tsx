'use client';

/**
 * "פריסה": the tiles (size — "auto" is the till parameters' "גודל ריבוע מוצר", style, density,
 * columns, images, text size), the bill's position and the category bar — for every device, and
 * the chosen device profile's own overrides ("כמו הבסיס" = null).
 */

import { useTranslations } from 'next-intl';
import {
  BILL_POSITIONS,
  CATEGORY_BARS,
  COLUMNS_CHOICES,
  DENSITIES,
  IMAGES,
  MODES,
  TEMPLATE_DEFAULTS,
  TEXT_SIZES,
  TILE_SIZES,
  TILE_STYLES,
  canonicalTemplate,
  forProfile,
  legacyTileKey,
  LEGACY_FALLBACK,
  type ProfileOverrideKey,
} from '@/lib/tillDesign';
import { useTillEditor, useTillField } from './editor-context';
import { AutoHint, FieldShell, NullableSegmentField, OptionSelect, SectionCard, SegmentField } from './fields';

/** The select's "כמו הבסיס" (null) for the profile's columns. */
const BASE = '__base';

function ColumnsField({ path, nullable }: { path: string; nullable: boolean }) {
  const t = useTranslations('tillDesign.layout');
  const f = useTillField<number | null>(path);
  const options = [
    ...(nullable ? [{ value: BASE, label: t('asBase') }] : []),
    ...COLUMNS_CHOICES.map((n) => ({ value: String(n), label: n === 0 ? t('columnsAuto') : String(n) })),
  ];
  return (
    <FieldShell path={path} label={t('columns')} hint={t('columnsHint')}>
      <OptionSelect
        value={f.value === null || f.value === undefined ? (nullable ? BASE : '0') : String(f.value)}
        disabled={f.disabled}
        ariaLabel={t('columns')}
        options={options}
        onChange={(v) => f.set(v === BASE || v === '' ? null : Number(v))}
        className="w-48"
      />
    </FieldShell>
  );
}

export function LayoutSection() {
  const t = useTranslations('tillDesign.layout');
  const tv = useTranslations('tillDesign.values');
  const tp = useTranslations('tillDesign.profiles');
  const tm = useTranslations('tillDesign.mode');
  const ed = useTillEditor();
  const legacy = ed.legacy ?? LEGACY_FALLBACK;
  const view = forProfile(ed.draft, ed.profile);
  const profileName = tp(ed.profile);
  const handheld = ed.profile === 'handheld';
  const template = canonicalTemplate(view.template);

  const tileAuto = MODES.map((mode) => `${tm(mode)} ${tv(`tileSize.${legacy.tileSize[legacyTileKey(ed.profile, mode)]}`)}`).join(' · ');
  const billAuto = MODES.map((mode) => `${tm(mode)}: ${tv(`billPosition.${TEMPLATE_DEFAULTS[template].billPosition[mode][ed.profile]}`)}`).join(' · ');
  const styleAuto = tv(`tileStyle.${TEMPLATE_DEFAULTS[template].tileStyle}`);

  const opts = <V extends string>(values: readonly V[], key: string) => values.map((v) => ({ value: v, label: tv(`${key}.${String(v)}` as string) }));
  const p = (key: ProfileOverrideKey) => `profiles.${ed.profile}.${key}`;

  return (
    <div className="space-y-4">
      <SectionCard title={t('baseTitle')} description={t('baseDescription')} paths={['layout']}>
        <SegmentField
          path="layout.tileSize"
          label={t('tileSize')}
          hint={<AutoHint>{t('tileSizeAuto', { values: tileAuto, profile: profileName })}</AutoHint>}
          options={opts(TILE_SIZES, 'tileSize')}
        />
        <SegmentField
          path="layout.tileStyle"
          label={t('tileStyle')}
          hint={<AutoHint>{t('tileStyleAuto', { value: styleAuto })}</AutoHint>}
          options={opts(TILE_STYLES, 'tileStyle')}
        />
        <SegmentField path="layout.density" label={t('density')} options={opts(DENSITIES, 'density')} />
        <SegmentField
          path="layout.billPosition"
          label={t('billPosition')}
          hint={<AutoHint>{t('billPositionAuto', { values: billAuto, profile: profileName })}</AutoHint>}
          options={opts(BILL_POSITIONS, 'billPosition')}
        />
        <SegmentField path="layout.categoryBar" label={t('categoryBar')} hint={t('categoryBarHint')} options={opts(CATEGORY_BARS, 'categoryBar')} />
        <SegmentField path="layout.images" label={t('images')} hint={t('imagesHint')} options={opts(IMAGES, 'images')} />
        <ColumnsField path="layout.columns" nullable={false} />
        <SegmentField path="layout.textSize" label={t('textSize')} options={opts(TEXT_SIZES, 'textSize')} />
      </SectionCard>

      <SectionCard
        title={t('profileTitle', { profile: profileName })}
        description={handheld ? t('profileHandheld') : t('profileDescription')}
        paths={[`profiles.${ed.profile}`]}
      >
        <NullableSegmentField path={p('tileSize')} label={t('tileSize')} nullLabel={t('asBase')} options={opts(TILE_SIZES, 'tileSize')} />
        <NullableSegmentField path={p('tileStyle')} label={t('tileStyle')} nullLabel={t('asBase')} options={opts(TILE_STYLES, 'tileStyle')} />
        <NullableSegmentField path={p('density')} label={t('density')} nullLabel={t('asBase')} options={opts(DENSITIES, 'density')} />
        <NullableSegmentField
          path={p('billPosition')}
          label={t('billPosition')}
          nullLabel={t('asBase')}
          options={opts(BILL_POSITIONS, 'billPosition').map((o) => ({ ...o, disabled: handheld && (o.value === 'start' || o.value === 'end') }))}
        />
        {handheld ? null : (
          <NullableSegmentField path={p('categoryBar')} label={t('categoryBar')} nullLabel={t('asBase')} options={opts(CATEGORY_BARS, 'categoryBar')} />
        )}
        <ColumnsField path={p('columns')} nullable />
      </SectionCard>
    </div>
  );
}
