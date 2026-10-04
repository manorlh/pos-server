'use client';

/**
 * One till parameter value, edited as its type: a switch for a boolean, a number
 * field for an integer or decimal, a select for an enum, text for a string.
 *
 * The editor holds a draft (text and a flag) rather than the value itself, so a
 * half-typed number ("1.", "-") is not lost; `draftToValue` turns it into what the
 * server takes — or `null` while it is not a valid value of the type. The server
 * validates again (`app/services/till_parameters.py`) and is strict about JSON
 * types, which is why numbers go out as numbers and never as text.
 *
 * An image parameter (`widget: 'image'` — a string holding an image URL, such as
 * `receiptLogoUrl`) is edited with the branding image picker instead: upload through
 * `POST /images/branding` for its kind (same limits and processing), preview, clear.
 */

import { useState } from 'react';
import Image from 'next/image';
import { useTranslations } from 'next-intl';
import type { BrandingImageKind, TillParameterScalar, TillParameterValueType } from '@/lib/types';
import { BrandingImageField } from '@/components/branding-image-field';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { cn } from '@/lib/utils';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

export interface ValueDraft {
  text: string;
  flag: boolean;
}

export const EMPTY_DRAFT: ValueDraft = { text: '', flag: false };

const INTEGER = /^-?\d+$/;

export function valueToDraft(value: TillParameterScalar | null | undefined): ValueDraft {
  if (typeof value === 'boolean') return { text: '', flag: value };
  if (value === null || value === undefined) return EMPTY_DRAFT;
  return { text: String(value), flag: false };
}

/**
 * The draft as the server's value, or `null` when it is not a valid one yet. An image
 * parameter needs an uploaded image: an empty URL is not a value (remove the level's
 * row instead).
 */
export function draftToValue(
  type: TillParameterValueType,
  draft: ValueDraft,
  enumOptions?: string[] | null,
  imageKind?: BrandingImageKind | 'media' | null,
): TillParameterScalar | null {
  if (imageKind) return draft.text.trim() ? draft.text.trim() : null;
  switch (type) {
    case 'boolean':
      return draft.flag;
    case 'integer': {
      const text = draft.text.trim();
      if (!INTEGER.test(text)) return null;
      const n = Number(text);
      return Number.isSafeInteger(n) ? n : null;
    }
    case 'decimal': {
      const text = draft.text.trim();
      if (!text) return null;
      const n = Number(text);
      return Number.isFinite(n) ? n : null;
    }
    case 'enum':
      return enumOptions?.includes(draft.text) ? draft.text : null;
    case 'string':
    default:
      return draft.text;
  }
}

/** How a stored value reads in a table. */
export function useFormatParameterValue() {
  const tc = useTranslations('common');
  return (value: TillParameterScalar | null | undefined): string => {
    if (value === null || value === undefined) return '—';
    if (typeof value === 'boolean') return value ? tc('yes') : tc('no');
    return String(value);
  };
}

/** An image parameter's value in a table: a small preview, as printed (on white). */
export function ParameterImageThumb({ url, alt }: { url: string; alt: string }) {
  if (!url) return <span className="text-muted-foreground">—</span>;
  if (isVideoUrl(url)) {
    return (
      <video src={url} muted loop autoPlay playsInline title={url} className="h-10 w-20 rounded border bg-black object-contain" />
    );
  }
  return (
    <div className="relative h-10 w-20 overflow-hidden rounded border bg-white" title={url}>
      <Image src={url} alt={alt} fill className="object-contain p-1 grayscale" sizes="80px" />
    </div>
  );
}

export function ParameterValueInput({
  type,
  enumOptions,
  imageKind,
  draft,
  onChange,
  id,
  disabled,
}: {
  type: TillParameterValueType;
  enumOptions?: string[] | null;
  /** Set for an image parameter: its branding upload kind. */
  imageKind?: BrandingImageKind | 'media' | null;
  draft: ValueDraft;
  onChange: (draft: ValueDraft) => void;
  id?: string;
  disabled?: boolean;
}) {
  const t = useTranslations('tillParameters');
  const tc = useTranslations('common');
  const tb = useTranslations('branding');

  if (imageKind === 'media') {
    return <MediaField value={draft.text} onChange={(url) => onChange({ ...draft, text: url })} disabled={disabled} />;
  }

  if (imageKind) {
    return (
      <BrandingImageField
        kind={imageKind}
        value={draft.text || undefined}
        onChange={(url) => onChange({ ...draft, text: url ?? '' })}
        title={tb(`${imageKind}Title`)}
        description={tb(`${imageKind}Where`)}
        hint={tb(`${imageKind}Hint`)}
        disabled={disabled}
      />
    );
  }

  if (type === 'boolean') {
    return (
      <div className="flex h-8 items-center gap-2">
        <Switch id={id} checked={draft.flag} onCheckedChange={(c) => onChange({ ...draft, flag: !!c })} />
        <span className="text-sm">{draft.flag ? tc('yes') : tc('no')}</span>
      </div>
    );
  }

  if (type === 'enum') {
    const items = (enumOptions ?? []).map((o) => ({ value: o, label: o }));
    return (
      <Select
        value={draft.text || null}
        onValueChange={(v) => onChange({ ...draft, text: v ? String(v) : '' })}
        items={items}
      >
        <SelectTrigger id={id}>
          <SelectValue placeholder={t('chooseValue')} />
        </SelectTrigger>
        <SelectContent>
          {items.map((i) => (
            <SelectItem key={i.value} value={i.value} label={i.label}>
              {i.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  const numeric = type === 'integer' || type === 'decimal';
  return (
    <Input
      id={id}
      type={numeric ? 'number' : 'text'}
      step={type === 'integer' ? 1 : type === 'decimal' ? 'any' : undefined}
      inputMode={type === 'integer' ? 'numeric' : type === 'decimal' ? 'decimal' : undefined}
      dir={numeric ? 'ltr' : undefined}
      value={draft.text}
      onChange={(e) => onChange({ ...draft, text: e.target.value })}
    />
  );
}

const isVideoUrl = (url: string) => /\.(mp4|webm)(\?|$)/i.test(url) || url.includes('/video/upload/');

/**
 * The screensaver's media: an image or a short video, uploaded through
 * `POST /images/media`, previewed as the till will show it (a video loops, muted).
 */
function MediaField({
  value,
  onChange,
  disabled,
}: {
  value: string;
  onChange: (url: string) => void;
  disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (file: File) => {
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const { data } = await api.post<{ url: string }>('/images/media', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: 300_000,
      });
      onChange(data.url);
    } catch (err) {
      setError(axiosErrorToToastMessage(err, 'ההעלאה נכשלה'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2">
      {value ? (
        <div className="overflow-hidden rounded-lg border bg-black">
          {isVideoUrl(value) ? (
            <video src={value} muted loop autoPlay playsInline className="max-h-48 w-full object-contain" />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={value} alt="" className="max-h-48 w-full object-contain" />
          )}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <label
          className={cn(
            'inline-flex h-9 cursor-pointer items-center rounded-md border px-3 text-sm hover:bg-muted',
            (disabled || busy) && 'pointer-events-none opacity-60',
          )}
        >
          {busy ? 'מעלה…' : value ? 'החלפה' : 'העלאת תמונה או סרטון'}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,video/mp4,video/webm"
            className="hidden"
            disabled={disabled || busy}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void upload(f);
              e.target.value = '';
            }}
          />
        </label>
        {value ? (
          <button type="button" className="text-sm text-destructive" disabled={disabled || busy} onClick={() => onChange('')}>
            הסרה
          </button>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">תמונה, או סרטון קצר (MP4/WebM, עד 25MB) שמתנגן בלולאה בלי קול.</p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
