'use client';

/**
 * "סגנון מסכים" (P:/specs/flow-design.md §5.1): "רגיל (כמו היום)" or "זרימה" — for every device at the
 * level (`flow.shell`), or per device class (`flow.profiles.<p>`, "כמו הבסיס" = as the choice for every
 * device: null, or "base" over a value the level above set) — and "זרימה"'s options: the home's view, the
 * wizard's first step, the guests, "הוסף הערה", the pickup's name, the background (our palette by default).
 * Every key inherits ("עובר בירושה") until this level sets it. The preview beside it: preview-flow.tsx.
 */

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import {
  ANDROID_PROFILES,
  AS_BASE,
  FLOW_ASK_GUESTS,
  FLOW_DEFAULTS,
  FLOW_FIRST_STEPS,
  FLOW_HOMES,
  FLOW_PICKUP_NAMES,
  FLOW_SHELLS,
  asBaseValue,
  flowView,
} from '@/lib/tillDesign';
import { useTillEditor, useTillField } from './editor-context';
import { AutoHint, FieldShell, NullableSegmentField, SectionCard, Segmented } from './fields';

/** Calm backgrounds to start from (ours light and dark among them); any colour may be picked. */
const BACKGROUNDS = ['#F3F5F8', '#FFFFFF', '#F7F4EE', '#EEF4F1', '#0E1014', '#1F2329'];
const HEX = /^#[0-9A-Fa-f]{6}$/;

/**
 * One of `flow`'s words: what the level has (its own or inherited), else the default — shown selected.
 * Picking the value already shown sets nothing; picking what the level inherits inherits it again (a choice
 * set and set back is no change).
 */
function FlowChoice<V extends string>({
  path,
  label,
  hint,
  values,
  fallback,
  words,
}: {
  path: string;
  label: string;
  hint?: ReactNode;
  values: readonly V[];
  fallback: V;
  words: (v: V) => string;
}) {
  const f = useTillField<V | null | undefined>(path);
  const shown = (f.value ?? fallback) as V;
  return (
    <FieldShell path={path} label={label} hint={hint}>
      <Segmented
        value={shown}
        options={values.map((v) => ({ value: v, label: words(v) }))}
        onChange={(v) => {
          if (v === shown) return;
          f.set(v === (f.inheritedValue ?? fallback) ? (f.inheritedValue ?? undefined) : v);
        }}
        disabled={f.disabled}
        ariaLabel={label}
      />
    </FieldShell>
  );
}

function NotesField() {
  const t = useTranslations('tillDesign.flow');
  const f = useTillField<boolean | null | undefined>('flow.notes');
  const checked = typeof f.value === 'boolean' ? f.value : FLOW_DEFAULTS.notes;
  const inherited = typeof f.inheritedValue === 'boolean' ? f.inheritedValue : null;
  // Back to what the level inherits: inherit it again.
  const toggle = (v: boolean) => f.set(v === (inherited ?? FLOW_DEFAULTS.notes) ? (inherited ?? undefined) : v);
  return (
    <FieldShell path="flow.notes" label={t('notes')} hint={t('notesHint')} inline>
      <Switch checked={checked} disabled={f.disabled} onCheckedChange={(v) => toggle(!!v)} aria-label={t('notes')} />
    </FieldShell>
  );
}

function BackgroundField() {
  const t = useTranslations('tillDesign.flow');
  const f = useTillField<string | null | undefined>('flow.background');
  const own = typeof f.value === 'string' && HEX.test(f.value) ? f.value.toUpperCase() : null;
  /** "ברירת המחדל שלנו": "base" over a colour the level above set (so it is undone), else inherit (null). */
  const toOurs = () => f.set(asBaseValue(f.inheritedValue));
  return (
    <FieldShell path="flow.background" label={t('background')} hint={t('backgroundHint')}>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="xs" variant={own ? 'outline' : 'secondary'} disabled={f.disabled} aria-pressed={!own} onClick={toOurs}>
          {t('backgroundDefault')}
        </Button>
        {BACKGROUNDS.map((hex) => (
          <button
            key={hex}
            type="button"
            disabled={f.disabled}
            aria-label={hex}
            aria-pressed={own === hex}
            onClick={() => f.set(hex)}
            className={cn('h-8 w-8 rounded-md border disabled:opacity-50', own === hex ? 'ring-2 ring-foreground ring-offset-2 ring-offset-background' : '')}
            style={{ backgroundColor: hex }}
          />
        ))}
        <input
          type="color"
          disabled={f.disabled}
          value={own ?? '#F3F5F8'}
          aria-label={t('backgroundPick')}
          onChange={(e) => f.set(e.target.value.toUpperCase())}
          className="h-8 w-8 cursor-pointer rounded-md border bg-transparent"
        />
        <Input
          dir="ltr"
          className="w-28 font-mono"
          disabled={f.disabled}
          value={typeof f.value === 'string' && f.value !== AS_BASE ? f.value : ''}
          placeholder={t('backgroundDefault')}
          aria-label={t('background')}
          onChange={(e) => {
            const v = e.target.value.trim();
            if (v === '') toOurs();
            else f.set(v.startsWith('#') ? v : `#${v}`);
          }}
        />
      </div>
    </FieldShell>
  );
}

export function FlowSection() {
  const t = useTranslations('tillDesign.flow');
  const tv = useTranslations('tillDesign.values');
  const ed = useTillEditor();
  const view = flowView(ed.draft);
  const legacy = ed.legacy;
  const shellWords = (v: string) => tv(`flowShell.${v}`);
  return (
    <div className="space-y-4">
      <SectionCard title={t('title')} description={t('description')} paths={['flow.shell', 'flow.profiles']}>
        <p className="flex items-start gap-2 rounded-lg border bg-background p-2.5 text-xs text-muted-foreground">
          <Info className="mt-0.5 h-4 w-4 shrink-0" /> {t('explain')}
        </p>
        <FlowChoice path="flow.shell" label={t('all')} hint={t('allHint')} values={FLOW_SHELLS} fallback="classic" words={shellWords} />
        <div className="space-y-3">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">{t('perDevice')}</p>
            <p className="text-xs text-muted-foreground">{t('perDeviceHint')}</p>
          </div>
          {ANDROID_PROFILES.map((p) => (
            <NullableSegmentField
              key={p}
              path={`flow.profiles.${p}`}
              label={t(`devices.${p}`)}
              nullLabel={t('asBase')}
              nullOverLabel={t('asBaseOver')}
              options={FLOW_SHELLS.map((v) => ({ value: v, label: shellWords(v) }))}
            />
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          {t('result')}{' '}
          {ANDROID_PROFILES.map((p) => t('resultItem', { device: t(`devices.${p}`), shell: shellWords(view.shell[p]) })).join(' · ')}
        </p>
        <p className="text-xs text-muted-foreground">{t('notApplies')}</p>
      </SectionCard>

      <SectionCard
        title={t('optionsTitle')}
        description={t('optionsDescription')}
        paths={['flow.home', 'flow.firstStep', 'flow.askGuests', 'flow.notes', 'flow.pickupName', 'flow.background']}
      >
        <FlowChoice path="flow.home" label={t('home')} values={FLOW_HOMES} fallback={FLOW_DEFAULTS.home} words={(v) => tv(`flowHome.${v}`)} />
        <FlowChoice path="flow.firstStep" label={t('firstStep')} values={FLOW_FIRST_STEPS} fallback={FLOW_DEFAULTS.firstStep} words={(v) => tv(`flowFirstStep.${v}`)} />
        <FlowChoice
          path="flow.askGuests"
          label={t('askGuests')}
          hint={legacy ? <AutoHint>{t('askGuestsNow', { value: t(legacy.fields.guests === 'required' ? 'asks' : 'doesNotAsk') })}</AutoHint> : undefined}
          values={FLOW_ASK_GUESTS}
          fallback={FLOW_DEFAULTS.askGuests}
          words={(v) => tv(`flowAskGuests.${v}`)}
        />
        <NotesField />
        <FlowChoice
          path="flow.pickupName"
          label={t('pickupName')}
          hint={legacy ? <AutoHint>{t('pickupNameNow', { value: t(legacy.fields.customerName === 'required' ? 'nameAtPayment' : 'noName') })}</AutoHint> : undefined}
          values={FLOW_PICKUP_NAMES}
          fallback={FLOW_DEFAULTS.pickupName}
          words={(v) => tv(`flowPickupName.${v}`)}
        />
        <BackgroundField />
        <p className="text-xs text-muted-foreground">{t('accentNote')}</p>
      </SectionCard>
    </div>
  );
}
