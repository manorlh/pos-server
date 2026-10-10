'use client';

/**
 * The kiosk editor's field primitives. Every field shows whether this level sets the
 * value or inherits it ("בירושה" / "דורס את הסניף"), with a reset back to the inherited
 * value, and the validation errors at its path.
 */

import { useRef, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, ImagePlus, Loader2, RotateCcw, Trash2, Upload } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { TimeInput } from '@/components/ui/date-picker';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { isHexColor, moveItem, type MediaRef } from '@/lib/kioskConfig';
import {
  KIOSK_IMAGE_TYPES,
  KIOSK_MEDIA_MAX_BYTES,
  KIOSK_VIDEO_TYPES,
  uploadKioskMedia,
} from '@/lib/kioskApi';
import { sameSetting, useFieldErrors, useKioskEditor, useKioskField } from './editor-context';

/* ------------------------------------------------------------ the shell */

/** "Set here" badge + reset, for any value at `path`. */
export function OverrideMark({ path }: { path: string }) {
  const t = useTranslations('kiosks.settings');
  const { overridden, reset, disabled } = useKioskField<unknown>(path);
  const { level } = useKioskEditor();
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
        {t(`overridden.${level}`)}
      </Badge>
      {!disabled ? (
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          title={t('reset')}
          aria-label={t('reset')}
          onClick={reset}
        >
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
  /** Label and control on one row (switches). */
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
  const t = useTranslations('kiosks.settings');
  const ed = useKioskEditor();
  const touched = paths.filter((p) => {
    const v = p.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), ed.draft);
    const i = p.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), ed.inherited);
    return !sameSetting(v, i);
  });
  return (
    <Card className="rounded-2xl">
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

/* ------------------------------------------------------------- controls */

export interface SegmentOption<V extends string> {
  value: V;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
}

/** An iOS-style segmented control. */
export function Segmented<V extends string>({
  value,
  options,
  onChange,
  disabled,
  ariaLabel,
}: {
  value: V;
  options: SegmentOption<V>[];
  onChange: (v: V) => void;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  return (
    <div role="radiogroup" aria-label={ariaLabel} className="inline-flex max-w-full flex-wrap gap-1 rounded-xl bg-muted p-1">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            title={o.title}
            disabled={disabled || o.disabled}
            onClick={() => onChange(o.value)}
            className={cn(
              'rounded-lg px-3 py-1.5 text-sm transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50',
              active ? 'bg-background font-medium text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function SegmentField<V extends string>({
  path,
  label,
  hint,
  options,
}: {
  path: string;
  label: ReactNode;
  hint?: ReactNode;
  options: SegmentOption<V>[];
}) {
  const f = useKioskField<V>(path);
  return (
    <FieldShell path={path} label={label} hint={hint}>
      <Segmented value={f.value} options={options} onChange={f.set} disabled={f.disabled} ariaLabel={String(label)} />
    </FieldShell>
  );
}

export function SwitchField({ path, label, hint }: { path: string; label: ReactNode; hint?: ReactNode }) {
  const f = useKioskField<boolean>(path);
  return (
    <FieldShell path={path} label={label} hint={hint} inline>
      <Switch checked={!!f.value} disabled={f.disabled} onCheckedChange={(v) => f.set(!!v)} aria-label={String(label)} />
    </FieldShell>
  );
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled,
  suffix,
  className,
  ariaLabel,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  suffix?: ReactNode;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <Input
        type="number"
        dir="ltr"
        inputMode="numeric"
        className={cn('w-24 text-center', className)}
        value={Number.isFinite(value) ? value : ''}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => {
          const n = e.target.value === '' ? NaN : Number(e.target.value);
          onChange(Number.isFinite(n) ? Math.round(n / step) * step : NaN);
        }}
      />
      {suffix ? <span className="text-sm text-muted-foreground">{suffix}</span> : null}
    </div>
  );
}

export function NumberField({
  path,
  label,
  hint,
  min,
  max,
  suffix,
  slider = false,
}: {
  path: string;
  label: ReactNode;
  hint?: ReactNode;
  min: number;
  max: number;
  suffix?: ReactNode;
  slider?: boolean;
}) {
  const f = useKioskField<number>(path);
  return (
    <FieldShell path={path} label={label} hint={hint}>
      <div className="flex flex-wrap items-center gap-3">
        {slider ? (
          <input
            type="range"
            className="h-2 min-w-40 flex-1 cursor-pointer accent-primary"
            min={min}
            max={max}
            value={Number.isFinite(f.value) ? f.value : min}
            disabled={f.disabled}
            aria-label={String(label)}
            onChange={(e) => f.set(Number(e.target.value))}
          />
        ) : null}
        <NumberInput
          value={f.value}
          onChange={f.set}
          min={min}
          max={max}
          disabled={f.disabled}
          suffix={suffix}
          ariaLabel={String(label)}
        />
      </div>
    </FieldShell>
  );
}

export function TextField({
  path,
  label,
  hint,
  max,
  placeholder,
  multiline = false,
  dir,
}: {
  path: string;
  label: ReactNode;
  hint?: ReactNode;
  max: number;
  placeholder?: string;
  multiline?: boolean;
  dir?: 'ltr' | 'rtl';
}) {
  const f = useKioskField<string | undefined>(path);
  const value = f.value ?? '';
  const counter = (
    <span className={cn('text-[11px] tabular-nums', value.length > max ? 'text-destructive' : 'text-muted-foreground')}>
      {value.length}/{max}
    </span>
  );
  return (
    <FieldShell path={path} label={label} hint={hint}>
      <div className="space-y-1">
        {multiline ? (
          <textarea
            dir={dir}
            className="min-h-20 w-full rounded-lg border border-input bg-transparent px-2.5 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
            value={value}
            placeholder={placeholder}
            disabled={f.disabled}
            onChange={(e) => f.set(e.target.value)}
          />
        ) : (
          <Input dir={dir} value={value} placeholder={placeholder} disabled={f.disabled} onChange={(e) => f.set(e.target.value)} />
        )}
        <div className="flex justify-end">{counter}</div>
      </div>
    </FieldShell>
  );
}

export function TimeField({ path, label, hint, clearable = false }: { path: string; label: ReactNode; hint?: ReactNode; clearable?: boolean }) {
  const t = useTranslations('kiosks.timers');
  const f = useKioskField<string>(path);
  return (
    <FieldShell path={path} label={label} hint={hint}>
      <div className="flex items-center gap-2">
        <TimeInput
          dir="ltr"
          className="w-32"
          value={f.value ?? ''}
          disabled={f.disabled}
          onChange={(e) => f.set(e.target.value)}
        />
        {clearable && f.value ? (
          <Button type="button" size="sm" variant="ghost" disabled={f.disabled} onClick={() => f.set('')}>
            {t('clear')}
          </Button>
        ) : null}
      </div>
    </FieldShell>
  );
}

/* --------------------------------------------------------------- select */

export interface SelectOption {
  value: string;
  label: string;
}

/** A labelled single select (Base UI); string values. */
export function OptionSelect({
  value,
  onChange,
  options,
  disabled,
  ariaLabel,
  placeholder,
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  disabled?: boolean;
  ariaLabel?: string;
  placeholder?: string;
  className?: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(String(v ?? ''))} items={options} disabled={disabled}>
      <SelectTrigger aria-label={ariaLabel} className={cn('min-w-48', className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} label={o.label}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/* --------------------------------------------------------------- colours */

const SWATCHES = ['#1F6FEB', '#0E7C66', '#16A34A', '#6D28D9', '#DB2777', '#EA580C', '#CA8A04', '#0F172A', '#FFFFFF'];

export function ColorField({
  path,
  label,
  hint,
  nullable = false,
  nullLabel,
  fallback,
}: {
  path: string;
  label: ReactNode;
  hint?: ReactNode;
  nullable?: boolean;
  /** What null reads as ("ברירת מחדל", "אוטומטי"). */
  nullLabel?: string;
  /** The colour shown while the value is null. */
  fallback: string;
}) {
  const t = useTranslations('kiosks.appearance');
  const f = useKioskField<string | null>(path);
  const shown = isHexColor(f.value) ? f.value.toUpperCase() : fallback;
  return (
    <FieldShell path={path} label={label} hint={hint}>
      <div className="flex flex-wrap items-center gap-2">
        {SWATCHES.map((hex) => (
          <button
            key={hex}
            type="button"
            disabled={f.disabled}
            aria-label={hex}
            aria-pressed={f.value?.toUpperCase() === hex}
            onClick={() => f.set(hex)}
            className={cn(
              'h-7 w-7 rounded-full border transition-transform duration-150 hover:scale-110 disabled:opacity-50',
              f.value?.toUpperCase() === hex ? 'ring-2 ring-foreground ring-offset-2 ring-offset-background' : '',
            )}
            style={{ backgroundColor: hex }}
          />
        ))}
        <input
          type="color"
          disabled={f.disabled}
          value={shown}
          aria-label={t('colorPick')}
          onChange={(e) => f.set(e.target.value.toUpperCase())}
          className="h-8 w-8 cursor-pointer rounded-full border bg-transparent"
        />
        <Input
          dir="ltr"
          className="w-28 font-mono"
          disabled={f.disabled}
          value={f.value ?? ''}
          placeholder={nullable ? nullLabel : fallback}
          onChange={(e) => {
            const v = e.target.value.trim();
            if (v === '') f.set(nullable ? null : f.value);
            else f.set(v.startsWith('#') ? v : `#${v}`);
          }}
        />
        {nullable && f.value !== null ? (
          <Button type="button" size="xs" variant="ghost" disabled={f.disabled} onClick={() => f.set(null)}>
            {nullLabel}
          </Button>
        ) : null}
        {nullable && f.value === null ? <Badge variant="outline">{nullLabel}</Badge> : null}
      </div>
    </FieldShell>
  );
}

/* ----------------------------------------------------------------- media */

export function MediaThumb({ media, className, alt = '' }: { media: MediaRef | null | undefined; className?: string; alt?: string }) {
  if (!media) {
    return (
      <div className={cn('flex items-center justify-center rounded-xl border border-dashed bg-muted/50', className)}>
        <ImagePlus className="h-5 w-5 text-muted-foreground" aria-hidden />
      </div>
    );
  }
  return media.kind === 'video' ? (
    <video src={media.url} muted autoPlay loop playsInline className={cn('rounded-xl bg-black object-cover', className)} />
  ) : (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={media.url} alt={alt} className={cn('rounded-xl bg-muted object-cover', className)} />
  );
}

/** Pick a file, check it, upload it; `video` also takes MP4/WebM. */
export function useMediaUpload(onUploaded: (ref: MediaRef) => void, allowVideo: boolean) {
  const t = useTranslations('kiosks.mediaField');
  const tc = useTranslations('common');
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handle = async (file: File | undefined) => {
    if (!file) return;
    const isVideo = KIOSK_VIDEO_TYPES.includes(file.type);
    if (!KIOSK_IMAGE_TYPES.includes(file.type) && !(allowVideo && isVideo)) {
      toast.error(allowVideo ? t('errorType') : t('errorImageOnly'));
      return;
    }
    if (file.size > KIOSK_MEDIA_MAX_BYTES) {
      toast.error(t('errorTooLarge', { mb: KIOSK_MEDIA_MAX_BYTES / (1024 * 1024) }));
      return;
    }
    setUploading(true);
    try {
      onUploaded(await uploadKioskMedia(file));
    } catch (err) {
      toast.error(axiosErrorToToastMessage(err, t('errorUpload') || tc('error')));
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const input = (
    <input
      ref={inputRef}
      type="file"
      className="hidden"
      accept={[...KIOSK_IMAGE_TYPES, ...(allowVideo ? KIOSK_VIDEO_TYPES : [])].join(',')}
      onChange={(e) => void handle(e.target.files?.[0])}
    />
  );
  return { uploading, input, open: () => inputRef.current?.click() };
}

export function MediaInput({
  value,
  onChange,
  allowVideo = false,
  disabled,
  thumbClassName = 'h-20 w-32',
}: {
  value: MediaRef | null | undefined;
  onChange: (next: MediaRef | null) => void;
  allowVideo?: boolean;
  disabled?: boolean;
  thumbClassName?: string;
}) {
  const t = useTranslations('kiosks.mediaField');
  const { canUpload } = useKioskEditor();
  const up = useMediaUpload(onChange, allowVideo);
  return (
    <div className="flex items-start gap-3">
      <div className="relative shrink-0">
        <MediaThumb media={value} className={thumbClassName} />
        {up.uploading ? (
          <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-background/70">
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
          </div>
        ) : null}
      </div>
      <div className="flex flex-col items-start gap-1.5">
        {up.input}
        <Button type="button" size="sm" variant="outline" disabled={disabled || !canUpload || up.uploading} onClick={up.open}>
          <Upload /> {up.uploading ? t('uploading') : value ? t('replace') : t('upload')}
        </Button>
        {value ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            className="text-destructive"
            disabled={disabled || up.uploading}
            onClick={() => onChange(null)}
          >
            <Trash2 /> {t('remove')}
          </Button>
        ) : null}
        {value && value.sha256 === null ? (
          <p className="max-w-56 text-[11px] text-amber-700 dark:text-amber-400">{t('noChecksum')}</p>
        ) : null}
      </div>
    </div>
  );
}

export function MediaField({
  path,
  label,
  hint,
  allowVideo = false,
}: {
  path: string;
  label: ReactNode;
  hint?: ReactNode;
  allowVideo?: boolean;
}) {
  const f = useKioskField<MediaRef | null | undefined>(path);
  return (
    <FieldShell path={path} label={label} hint={hint}>
      <MediaInput
        value={f.value ?? null}
        allowVideo={allowVideo}
        disabled={f.disabled}
        onChange={(ref) => f.set(ref ?? (f.inheritedValue === undefined ? undefined : null))}
      />
    </FieldShell>
  );
}

/* ------------------------------------------------------------- ordering */

export function MoveButtons({
  index,
  count,
  onMove,
  disabled,
}: {
  index: number;
  count: number;
  onMove: (delta: number) => void;
  disabled?: boolean;
}) {
  const t = useTranslations('kiosks.ui');
  return (
    <span className="inline-flex">
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={t('moveUp')}
        title={t('moveUp')}
        disabled={disabled || index === 0}
        onClick={() => onMove(-1)}
      >
        <ArrowUp />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        aria-label={t('moveDown')}
        title={t('moveDown')}
        disabled={disabled || index >= count - 1}
        onClick={() => onMove(1)}
      >
        <ArrowDown />
      </Button>
    </span>
  );
}

/**
 * An ordered pick from a fixed set: chips switch an item on/off, arrows order the chosen
 * ones. `firstBadge` marks the first ("ברירת מחדל" for languages).
 */
export function OrderedPick<V extends string>({
  path,
  all,
  label,
  firstBadge,
}: {
  path: string;
  all: readonly V[];
  label: (v: V) => string;
  firstBadge?: string;
}) {
  const f = useKioskField<V[]>(path);
  const value = Array.isArray(f.value) ? f.value : [];
  return (
    <div className="space-y-2">
      <ChipToggles options={all.map((v) => ({ value: v, label: label(v) }))} value={value} onChange={f.set} disabled={f.disabled} />
      {value.length > 1 ? (
        <ol className="divide-y rounded-xl border">
          {value.map((v, i) => (
            <li key={v} className="flex items-center justify-between gap-2 px-3 py-1.5 text-sm">
              <span className="flex items-center gap-2">
                <span className="w-4 text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                {label(v)}
                {i === 0 && firstBadge ? <Badge variant="outline">{firstBadge}</Badge> : null}
              </span>
              <MoveButtons
                index={i}
                count={value.length}
                disabled={f.disabled}
                onMove={(d) => f.set(moveItem(value, i, d))}
              />
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  );
}

/** Toggle chips that keep the order they were added in (service types, languages, screens). */
export function ChipToggles<V extends string>({
  options,
  value,
  onChange,
  disabled,
}: {
  options: { value: V; label: ReactNode; disabled?: boolean }[];
  value: V[];
  onChange: (next: V[]) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => {
        const on = value.includes(o.value);
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            disabled={disabled || o.disabled}
            onClick={() => onChange(on ? value.filter((v) => v !== o.value) : [...value, o.value])}
            className={cn(
              'rounded-full border px-3 py-1.5 text-sm transition-all duration-200 disabled:cursor-not-allowed disabled:opacity-50',
              on ? 'border-primary bg-primary text-primary-foreground shadow-sm' : 'bg-background hover:bg-muted',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
