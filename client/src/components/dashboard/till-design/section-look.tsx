'use client';

/**
 * "צבעים וטקסטים": one accent colour (null = the brand colour the till uses today) and light /
 * dark / as today; every screen text the business may reword, its default as the placeholder
 * (empty = the default).
 */

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { COLOR_MODES, TEXT_DEFAULTS, TEXT_KEYS, TEXT_MAX } from '@/lib/tillDesign';
import { useTillField } from './editor-context';
import { FieldShell, SectionCard, SegmentField } from './fields';
import { DEFAULT_ACCENT } from './preview-model';

/** A few calm accents (one is picked; the till draws everything else in neutrals). */
const SWATCHES = ['#007AFF', '#1663D6', '#0E7C66', '#15803D', '#6D28D9', '#B45309', '#BE123C', '#0F172A'];
const HEX = /^#[0-9A-Fa-f]{6}$/;

function AccentField() {
  const t = useTranslations('tillDesign.colors');
  const f = useTillField<string | null>('colors.accent');
  const value = typeof f.value === 'string' ? f.value.toUpperCase() : null;
  return (
    <FieldShell path="colors.accent" label={t('accent')} hint={t('accentHint')}>
      <div className="flex flex-wrap items-center gap-2">
        {SWATCHES.map((hex) => (
          <button
            key={hex}
            type="button"
            disabled={f.disabled}
            aria-label={hex}
            aria-pressed={value === hex}
            onClick={() => f.set(hex)}
            className={cn(
              'h-8 w-8 rounded-md border disabled:opacity-50',
              value === hex ? 'ring-2 ring-foreground ring-offset-2 ring-offset-background' : '',
            )}
            style={{ backgroundColor: hex }}
          />
        ))}
        <input
          type="color"
          disabled={f.disabled}
          value={value && HEX.test(value) ? value : DEFAULT_ACCENT}
          aria-label={t('pick')}
          onChange={(e) => f.set(e.target.value.toUpperCase())}
          className="h-8 w-8 cursor-pointer rounded-md border bg-transparent"
        />
        <Input
          dir="ltr"
          className="w-28 font-mono"
          disabled={f.disabled}
          value={f.value ?? ''}
          placeholder={t('brand')}
          onChange={(e) => {
            const v = e.target.value.trim();
            f.set(v === '' ? null : v.startsWith('#') ? v : `#${v}`);
          }}
        />
        {f.value === null || f.value === undefined ? (
          <Badge variant="outline">{t('brand')}</Badge>
        ) : (
          <Button type="button" size="xs" variant="ghost" disabled={f.disabled} onClick={() => f.set(null)}>
            {t('useBrand')}
          </Button>
        )}
      </div>
    </FieldShell>
  );
}

function TextRow({ k }: { k: (typeof TEXT_KEYS)[number] }) {
  const t = useTranslations('tillDesign.texts');
  const path = `texts.${k}`;
  const f = useTillField<string | undefined>(path);
  const value = f.value ?? '';
  const over = value.length > TEXT_MAX;
  return (
    <FieldShell path={path} label={t(k)}>
      <div className="flex items-center gap-2">
        <Input value={value} placeholder={TEXT_DEFAULTS[k]} disabled={f.disabled} aria-label={t(k)} onChange={(e) => f.set(e.target.value)} className={over ? 'border-destructive' : undefined} />
        <span className={cn('w-12 shrink-0 text-end text-[11px] tabular-nums', over ? 'text-destructive' : 'text-muted-foreground')}>
          {value.length}/{TEXT_MAX}
        </span>
      </div>
    </FieldShell>
  );
}

export function LookSection() {
  const t = useTranslations('tillDesign.colors');
  const tt = useTranslations('tillDesign.textsSection');
  const tv = useTranslations('tillDesign.values');
  return (
    <div className="space-y-4">
      <SectionCard title={t('title')} description={t('description')} paths={['colors']}>
        <AccentField />
        <SegmentField path="colors.mode" label={t('mode')} hint={t('modeHint')} options={COLOR_MODES.map((v) => ({ value: v, label: tv(`colorMode.${v}`) }))} />
      </SectionCard>
      <SectionCard title={tt('title')} description={tt('description')} paths={['texts']}>
        <div className="grid gap-4 md:grid-cols-2">
          {TEXT_KEYS.map((k) => (
            <TextRow key={k} k={k} />
          ))}
        </div>
      </SectionCard>
    </div>
  );
}
