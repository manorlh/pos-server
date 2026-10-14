'use client';

/**
 * "שדות והתנהגות": the order's questions (the customer's name, take away / eat in, the guests:
 * "auto" is the till parameters' "שם לקוח" / "לקחת/לשבת" / "מספר סועדים", shown as they are
 * now), the tables' floor map (its style, the chairs), the behaviour (the summary open or
 * closed, the lines' status chips), and "מספר הזמנה בפתיחה" (phase 2 §3.9: "הזמנה 47" from the
 * first item, a daily count per till — never the document number — with the till's prefix).
 */

import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import {
  FIELD_KEYS,
  FIELD_MODES,
  FIRE_HINTS,
  LEGACY_FALLBACK,
  MAP_STYLES,
  ORDER_PREFIX_MAX,
  SHOW_HIDE,
  SUMMARY_STATES,
  type FireHints,
} from '@/lib/tillDesign';
import { useTillEditor, useTillField } from './editor-context';
import { AutoHint, FieldShell, SectionCard, SegmentField, SwitchField } from './fields';

/**
 * The till's "איך זה עובד" card of the courses (P:/specs/fire-restaurant-flow.md §5), as the choice of
 * `behavior.fireHints` shows it: the three steps, "הבנתי" and "אל תציג שוב"; off — a line saying so.
 */
export function FireHintsPreview() {
  const tb = useTranslations('tillDesign.behavior');
  const f = useTillField<FireHints>('behavior.fireHints');
  if (f.value === 'off') {
    return <p className="text-xs text-muted-foreground" data-testid="fire-hints-preview-off">{tb('fireHintsOff')}</p>;
  }
  const steps = ['step1', 'step2', 'step3'] as const;
  return (
    <div className="space-y-1.5" data-testid="fire-hints-preview">
      <p className="text-xs text-muted-foreground">{tb('fireHintsPreview')}</p>
      <div className="max-w-sm rounded-xl border bg-card p-3 shadow-sm">
        <p className="mb-2 text-sm font-semibold">{tb('fireHintsCard.title')}</p>
        <ol className="space-y-1.5">
          {steps.map((s, i) => (
            <li key={s} className="flex items-start gap-2 text-xs">
              <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground">
                {i + 1}
              </span>
              <span>{tb(`fireHintsCard.${s}`)}</span>
            </li>
          ))}
        </ol>
        <div className="mt-3 flex justify-end gap-2 text-xs">
          <span className="rounded-md border px-2.5 py-1 text-muted-foreground">{tb('fireHintsCard.dontShow')}</span>
          <span className="rounded-md bg-primary px-2.5 py-1 text-primary-foreground">{tb('fireHintsCard.gotIt')}</span>
        </div>
      </div>
    </div>
  );
}

function OrderNumberCard() {
  const t = useTranslations('tillDesign.orderNumber');
  const prefix = useTillField<string>('orderNumber.prefix');
  const atOpen = useTillField<boolean>('orderNumber.atOpen');
  const value = typeof prefix.value === 'string' ? prefix.value : '';
  const example = value ? `${value}-047` : t('exampleAuto');
  return (
    <SectionCard title={t('title')} description={t('description')} paths={['orderNumber']}>
      <SwitchField path="orderNumber.atOpen" label={t('atOpen')} hint={t('atOpenHint')} />
      {atOpen.value ? (
        <FieldShell path="orderNumber.prefix" label={t('prefix')} hint={t('prefixHint', { max: ORDER_PREFIX_MAX })}>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              value={value}
              disabled={prefix.disabled}
              placeholder={t('prefixAuto')}
              aria-label={t('prefix')}
              className="w-40"
              onChange={(e) => prefix.set(e.target.value.trim())}
            />
            <AutoHint>{t('example', { example })}</AutoHint>
          </div>
        </FieldShell>
      ) : null}
    </SectionCard>
  );
}

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
        <SegmentField
          path="behavior.fireHints"
          label={tb('fireHints')}
          hint={tb('fireHintsHint')}
          options={FIRE_HINTS.map((v) => ({ value: v, label: tv(`fireHints.${v}`) }))}
        />
        <FireHintsPreview />
      </SectionCard>
      <OrderNumberCard />
    </div>
  );
}
