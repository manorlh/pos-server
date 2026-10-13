'use client';

/**
 * The settings of the templates in use (the base's or a profile's own), each card shown only
 * while its template is (P:\specs\till-design-phase2.md §2–§3):
 *
 *  - "לוח מנות": "זמן להוציא" (`courses.fireGapMinutes`, a reminder only) and whether the first
 *    course goes with the first send (`courses.autoFireFirst`); a warning where "מנות בשולחן" is
 *    off ("יוצג 'נקי'");
 *  - "עגינת תשלום": "חסכתם" on the dock (`payDock.savings`);
 *  - "לילה": the hand (`night.hand`) and the quick add-ons (`night.quickAddons`);
 *  - "תפריט ויזואלי": the description lines, the dietary words, and the photos' coverage
 *    ("תמונות: 41 מתוך 56 מוצרים (73%)", the categories shown without photos, the products
 *    without one);
 *  - "בר ואירועים" / "לילה": open tabs (`bar.openTabs`);
 *  - "קופה מקצועית": the in-screen keyboard and the F keys.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, ChevronDown, ChevronUp, ImageOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  DESCRIPTION_LINES,
  DIETARY_MODES,
  FIRE_GAP_MAX,
  FIRE_GAP_MIN,
  NIGHT_HANDS,
  imageCoverage,
  templatesInUse,
  type ImageCoverage,
} from '@/lib/tillDesign';
import { useTillEditor, useTillField } from './editor-context';
import { AutoHint, FieldShell, OptionSelect, SectionCard, SegmentField, SwitchField } from './fields';

const GAP_CHOICES = [0, ...Array.from({ length: (FIRE_GAP_MAX - FIRE_GAP_MIN) / 5 + 1 }, (_, i) => FIRE_GAP_MIN + i * 5)];

function FireGapField() {
  const t = useTranslations('tillDesign.courses');
  const f = useTillField<number>('courses.fireGapMinutes');
  const value = typeof f.value === 'number' ? f.value : 0;
  const choices = GAP_CHOICES.includes(value) ? GAP_CHOICES : [...GAP_CHOICES, value].sort((a, b) => a - b);
  return (
    <FieldShell path="courses.fireGapMinutes" label={t('fireGap')} hint={t('fireGapHint')}>
      <OptionSelect
        value={String(value)}
        disabled={f.disabled}
        ariaLabel={t('fireGap')}
        options={choices.map((n) => ({ value: String(n), label: n === 0 ? t('fireGapOff') : t('minutes', { n }) }))}
        onChange={(v) => f.set(Number(v) || 0)}
        className="w-48"
      />
    </FieldShell>
  );
}

/** "מנות בשולחן" off at this level: the courses board shows clean on these tills. */
export function CoursesOffNote() {
  const t = useTranslations('tillDesign.courses');
  const ed = useTillEditor();
  if (!ed.legacy || ed.legacy.coursesEnabled !== false) return null;
  if (!templatesInUse(ed.draft).includes('courses')) return null;
  return (
    <p className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {t('coursesOff')}
    </p>
  );
}

function CoursesCard() {
  const t = useTranslations('tillDesign.courses');
  return (
    <SectionCard title={t('title')} description={t('description')} paths={['courses']}>
      <CoursesOffNote />
      <FireGapField />
      <SwitchField path="courses.autoFireFirst" label={t('autoFireFirst')} hint={t('autoFireFirstHint')} />
      <p className="text-xs text-muted-foreground">{t('quickIsClean')}</p>
    </SectionCard>
  );
}

function PayDockCard() {
  const t = useTranslations('tillDesign.payDock');
  return (
    <SectionCard title={t('title')} description={t('description')} paths={['payDock']}>
      <SwitchField path="payDock.savings" label={t('savings')} hint={t('savingsHint')} />
      <p className="text-xs text-muted-foreground">{t('buttonsHint')}</p>
    </SectionCard>
  );
}

function NightCard() {
  const t = useTranslations('tillDesign.night');
  return (
    <SectionCard title={t('title')} description={t('description')} paths={['night']}>
      <SegmentField path="night.hand" label={t('hand')} hint={t('handHint')} options={NIGHT_HANDS.map((h) => ({ value: h, label: t(`hands.${h}`) }))} />
      <SwitchField path="night.quickAddons" label={t('quickAddons')} hint={t('quickAddonsHint')} />
      <p className="text-xs text-muted-foreground">{t('fixed')}</p>
    </SectionCard>
  );
}

/** "תמונות: 41 מתוך 56 מוצרים (73%)", the categories without photos, and the products without one. */
export function CoverageSummary({ compact = false }: { compact?: boolean }) {
  const t = useTranslations('tillDesign.visual');
  const ed = useTillEditor();
  const [open, setOpen] = useState(false);
  if (!ed.catalog || ed.catalog.products.length === 0) {
    return <p className="rounded-lg border border-dashed p-2.5 text-xs text-muted-foreground">{t('sampleNoPhotos')}</p>;
  }
  const cov: ImageCoverage = imageCoverage(ed.catalog.categories, ed.catalog.products);
  const names = new Map(ed.catalog.categories.map((c) => [c.id, c.name]));
  return (
    <div className="space-y-1.5 rounded-lg border bg-muted/30 p-2.5 text-xs">
      <p className="font-medium">{t('coverage', { with: cov.withImage, total: cov.total, percent: cov.percent })}</p>
      {cov.mostlyWithout ? (
        <p className="flex items-center gap-1.5 text-amber-700 dark:text-amber-300">
          <AlertTriangle className="h-3.5 w-3.5" /> {t('mostlyWithout')}
        </p>
      ) : null}
      {cov.textOnly.slice(0, compact ? 3 : 50).map((c) => (
        <p key={c.id} className="text-muted-foreground">
          {t('textOnly', { name: c.name, with: c.withImage, total: c.total })}
        </p>
      ))}
      {compact && cov.textOnly.length > 3 ? <p className="text-muted-foreground">{t('moreCategories', { n: cov.textOnly.length - 3 })}</p> : null}
      {!compact && cov.missing.length > 0 ? (
        <div>
          <Button type="button" size="xs" variant="link" className="h-auto p-0" onClick={() => setOpen((v) => !v)}>
            {open ? <ChevronUp /> : <ChevronDown />} {t('missingList', { n: cov.missing.length })}
          </Button>
          {open ? (
            <ul className="mt-1 max-h-48 space-y-0.5 overflow-y-auto">
              {cov.missing.map((p) => (
                <li key={p.id} className="flex items-center gap-1.5">
                  <ImageOff className="h-3 w-3 text-muted-foreground" />
                  <a href="/dashboard/products" className="hover:underline">
                    {p.name}
                  </a>
                  {p.categoryId && names.get(p.categoryId) ? <span className="text-muted-foreground">· {names.get(p.categoryId)}</span> : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function VisualCard() {
  const t = useTranslations('tillDesign.visual');
  const ed = useTillEditor();
  const auto = ed.legacy?.showDietaryMarks ? t('dietaryAutoOn') : t('dietaryAutoOff');
  return (
    <SectionCard title={t('title')} description={t('description')} paths={['visual']}>
      <SegmentField
        path="visual.descriptionLines"
        label={t('descriptionLines')}
        options={DESCRIPTION_LINES.map((n) => ({ value: String(n), label: n === 0 ? t('noDescription') : String(n) }))}
        valueAsNumber
      />
      <SegmentField
        path="visual.dietary"
        label={t('dietary')}
        hint={<AutoHint>{auto}</AutoHint>}
        options={DIETARY_MODES.map((v) => ({ value: v, label: t(`dietaryModes.${v}`) }))}
      />
      <CoverageSummary />
    </SectionCard>
  );
}

function OpenTabsCard() {
  const t = useTranslations('tillDesign.openTabs');
  return (
    <SectionCard title={t('title')} description={t('description')} paths={['bar.openTabs']}>
      <SwitchField path="bar.openTabs" label={t('label')} hint={t('hint')} />
    </SectionCard>
  );
}

function ProfessionalCard() {
  const t = useTranslations('tillDesign.professional');
  return (
    <SectionCard title={t('title')} description={t('description')} paths={['professional']}>
      <SwitchField path="professional.keyboard" label={t('keyboard')} hint={t('keyboardHint')} />
      <SwitchField path="professional.fKeys" label={t('fKeys')} hint={t('fKeysHint')} />
    </SectionCard>
  );
}

export function TemplateOptions() {
  const ed = useTillEditor();
  const used = templatesInUse(ed.draft);
  return (
    <>
      {used.includes('courses') ? <CoursesCard /> : null}
      {used.includes('payDock') ? <PayDockCard /> : null}
      {used.includes('night') ? <NightCard /> : null}
      {used.includes('fast') || used.includes('night') ? <OpenTabsCard /> : null}
      {used.includes('visual') ? <VisualCard /> : null}
      {used.includes('professional') ? <ProfessionalCard /> : null}
    </>
  );
}
