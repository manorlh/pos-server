'use client';

/**
 * The till design editor's field primitives: every field says whether this level sets the value
 * ("נקבע כאן", with a reset back to what it inherits) or inherits it ("עובר בירושה"), and shows
 * the validation errors at its path. The plain controls (segmented, select, move buttons, chip
 * toggles) are the kiosk editor's.
 */

import type { ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { asBaseValue, getPath, isSet } from '@/lib/tillDesign';
import { Segmented, type SegmentOption } from '@/components/dashboard/kiosks/fields';
import { sameSetting, useFieldErrors, useTillEditor, useTillField } from './editor-context';

export { ChipToggles, MoveButtons, OptionSelect, Segmented } from '@/components/dashboard/kiosks/fields';
export type { SegmentOption } from '@/components/dashboard/kiosks/fields';

/** "נקבע כאן" + reset, or "עובר בירושה", for the value at `path`. */
export function OverrideMark({ path }: { path: string }) {
  const t = useTranslations('tillDesign.settings');
  const { overridden, reset, disabled } = useTillField<unknown>(path);
  const { level } = useTillEditor();
  if (!overridden) {
    return (
      <span className="text-[11px] text-muted-foreground" title={t(`inheritFrom.${level}`)}>
        {t('inherited')}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1">
      <Badge variant="secondary" className="bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200">
        {t('overridden')}
      </Badge>
      {!disabled ? (
        <Button type="button" size="icon-xs" variant="ghost" title={t('reset')} aria-label={t('reset')} onClick={reset}>
          <RotateCcw />
        </Button>
      ) : null}
    </span>
  );
}

export function FieldErrors({ path }: { path: string }) {
  const errors = useFieldErrors(path);
  if (errors.length === 0) return null;
  return (
    <ul className="space-y-0.5">
      {errors.map((e) => (
        <li key={e} className="text-xs text-destructive">
          {e}
        </li>
      ))}
    </ul>
  );
}

export function FieldShell({
  path,
  label,
  hint,
  children,
  className,
  inline = false,
}: {
  path: string;
  label: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  className?: string;
  inline?: boolean;
}) {
  return (
    <div className={cn('space-y-2', className)}>
      <div className={cn('flex gap-3', inline ? 'items-center justify-between' : 'flex-col')}>
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium">{label}</span>
            <OverrideMark path={path} />
          </div>
          {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
        </div>
        <div className={cn(inline ? 'shrink-0' : 'w-full')}>{children}</div>
      </div>
      <FieldErrors path={path} />
    </div>
  );
}

/** A settings card; `paths` are the config parts it edits, reset together. */
export function SectionCard({
  title,
  description,
  paths = [],
  children,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  paths?: string[];
  children: ReactNode;
  action?: ReactNode;
}) {
  const t = useTranslations('tillDesign.settings');
  const ed = useTillEditor();
  const touched = paths.filter((p) => !sameSetting(getPath(ed.draft, p), getPath(ed.inherited, p)));
  return (
    <Card className="rounded-xl">
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div className="space-y-1">
          <CardTitle className="text-base">{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
        <div className="flex items-center gap-2">
          {action}
          {touched.length > 0 && ed.canEdit ? (
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => {
                if (window.confirm(t('resetSectionConfirm', { section: String(title) }))) touched.forEach(ed.reset);
              }}
            >
              <RotateCcw /> {t('resetSection')}
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="space-y-5">{children}</CardContent>
    </Card>
  );
}

export function SegmentField<V extends string>({
  path,
  label,
  hint,
  options,
  valueAsNumber = false,
}: {
  path: string;
  label: ReactNode;
  hint?: ReactNode;
  options: SegmentOption<V>[];
  /** The value is a number (`visual.descriptionLines`); the options carry it as text. */
  valueAsNumber?: boolean;
}) {
  const f = useTillField<V | number>(path);
  return (
    <FieldShell path={path} label={label} hint={hint}>
      <Segmented
        value={String(f.value) as V}
        options={options}
        onChange={(v) => f.set(valueAsNumber ? Number(v) : v)}
        disabled={f.disabled}
        ariaLabel={String(label)}
      />
    </FieldShell>
  );
}

/**
 * A profile's override: "כמו הבסיס" (the "" option) or one of the values. "כמו הבסיס" saves
 * null (inherit), or "base" when the level above set the value itself — "כמו הבסיס (גם אם
 * נקבע ברמה שמעל)" (phase 2 §3.10).
 */
export function NullableSegmentField<V extends string>({
  path,
  label,
  hint,
  nullLabel,
  nullOverLabel,
  options,
}: {
  path: string;
  label: ReactNode;
  hint?: ReactNode;
  nullLabel: string;
  /** The "" option's words when the level above set the value. */
  nullOverLabel?: string;
  options: SegmentOption<V>[];
}) {
  const f = useTillField<V | null>(path);
  const over = isSet(f.inheritedValue);
  const all: SegmentOption<string>[] = [{ value: '', label: over && nullOverLabel ? nullOverLabel : nullLabel }, ...options];
  return (
    <FieldShell path={path} label={label} hint={hint}>
      <Segmented
        value={isSet(f.value) ? (f.value as string) : ''}
        options={all}
        onChange={(v) => f.set(v === '' ? (asBaseValue(f.inheritedValue) as V | null) : (v as V))}
        disabled={f.disabled}
        ariaLabel={String(label)}
      />
    </FieldShell>
  );
}


export function SwitchField({ path, label, hint }: { path: string; label: ReactNode; hint?: ReactNode }) {
  const f = useTillField<boolean>(path);
  return (
    <FieldShell path={path} label={label} hint={hint} inline>
      <Switch checked={!!f.value} disabled={f.disabled} onCheckedChange={(v) => f.set(!!v)} aria-label={String(label)} />
    </FieldShell>
  );
}

/** "לפי פרמטרי הקופה: …" — what an "auto" value is on the tills now. */
export function AutoHint({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center rounded-md border bg-muted/50 px-2 py-0.5 text-xs text-muted-foreground">{children}</span>;
}
