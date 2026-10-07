'use client';

/**
 * "שדות והתנהגות": the order's questions (the customer's name, take away / eat in, the guests:
 * "auto" is the till parameters' "שם לקוח" / "לקחת/לשבת" / "מספר סועדים", shown as they are
 * now), the tables' floor map (its style, the chairs), and the behaviour (the summary open or
 * closed, the lines' status chips).
 */

import { useTranslations } from 'next-intl';
import { FIELD_KEYS, FIELD_MODES, LEGACY_FALLBACK, MAP_STYLES, SHOW_HIDE, SUMMARY_STATES } from '@/lib/tillDesign';
import { useTillEditor } from './editor-context';
import { AutoHint, SectionCard, SegmentField, SwitchField } from './fields';

export function FieldsSection() {
  const t = useTranslations('tillDesign.fieldsSection');
  const tb = useTranslations('tillDesign.behavior');
  const tm = useTranslations('tillDesign.tables');
  const tv = useTranslations('tillDesign.values');
  const ed = useTillEditor();
  const legacy = ed.legacy ?? LEGACY_FALLBACK;
  return (
    <div className="space-y-4">
      <SectionCard title={t('title')} description={t('description')} paths={['fields']}>
        {FIELD_KEYS.map((k) => (
          <SegmentField
            key={k}
            path={`fields.${k}`}
            label={t(k)}
            hint={
              <span className="flex flex-wrap items-center gap-2">
                <span>{t(`${k}Hint`)}</span>
                <AutoHint>{t('auto', { value: tv(`fieldMode.${legacy.fields[k]}`) })}</AutoHint>
              </span>
            }
            options={FIELD_MODES.map((v) => ({ value: v, label: tv(`fieldMode.${v}`) }))}
          />
        ))}
      </SectionCard>
      <SectionCard title={tm('title')} description={tm('description')} paths={['tables']}>
        <SegmentField
          path="tables.mapStyle"
          label={tm('mapStyle')}
          hint={<AutoHint>{t('auto', { value: tv(`mapStyle.${legacy.tables.mapStyle}`) })}</AutoHint>}
          options={MAP_STYLES.map((v) => ({ value: v, label: tv(`mapStyle.${v}`) }))}
        />
        <SegmentField
          path="tables.showChairs"
          label={tm('showChairs')}
          hint={<AutoHint>{t('auto', { value: tv(`showChairs.${legacy.tables.showChairs}`) })}</AutoHint>}
          options={SHOW_HIDE.map((v) => ({ value: v, label: tv(`showChairs.${v}`) }))}
        />
      </SectionCard>
      <SectionCard title={tb('title')} description={tb('description')} paths={['behavior']}>
        <SegmentField
          path="behavior.summary"
          label={tb('summary')}
          hint={tb('summaryHint')}
          options={SUMMARY_STATES.map((v) => ({ value: v, label: tv(`summary.${v}`) }))}
        />
        <SwitchField path="behavior.lineStatus" label={tb('lineStatus')} hint={tb('lineStatusHint')} />
      </SectionCard>
    </div>
  );
}
