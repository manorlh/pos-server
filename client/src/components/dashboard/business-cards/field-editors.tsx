'use client';

/**
 * One editor row per card field: where its value comes from (inherit / local / hidden, and the
 * source of an inherited value), whether it is public or private, and the value itself in each of
 * the card's languages. Typing into an inherited field makes it local; "חזרה לירושה" drops the
 * local value (a blank local value stays blank — it is never read as "hidden").
 */
import { Eye, EyeOff, ImageUp, Loader2, Lock, Plus, Trash2, Undo2, Upload } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useId, useState, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  CARD_LANGS,
  SOCIAL_PLATFORMS,
  defaultField,
  displayPhone,
  isPlatformUrl,
  isSafeMediaUrl,
  usableValue,
  type AnnouncementValue,
  type CardDoc,
  type CardField,
  type CardImage,
  type CardLang,
  type CardType,
  type EffectiveFields,
  type EventValue,
  type FieldKey,
  type HoursRow,
  type HoursValue,
  type LocalText,
  type OfferValue,
  type PublicFile,
  type ServiceItem,
  type SocialLink,
  type SocialPlatform,
  type SupportValue,
  FIELD_SPECS,
} from '@/lib/businessCards';
import { uploadCardMedia } from '@/lib/businessCardsApi';
import { cn } from '@/lib/utils';

import { Hint, NativeSelect, Segmented, TextArea, inputCls } from './bc-ui';

export const NS = 'businessCards';

export interface FieldCtx {
  doc: CardDoc;
  type: CardType;
  eff: EffectiveFields;
  canEdit: boolean;
  update: (fn: (d: CardDoc) => CardDoc) => void;
  /** card id → name, for "inherited from …". */
  cardNames: Record<string, string>;
}

export function getField(doc: CardDoc, key: FieldKey, type: CardType): CardField {
  return (doc.fields?.[key] as CardField | undefined) ?? defaultField(key, type);
}

export function withField(doc: CardDoc, key: FieldKey, type: CardType, patch: Partial<CardField>): CardDoc {
  return { ...doc, fields: { ...doc.fields, [key]: { ...getField(doc, key, type), ...patch } } };
}

export function useSourceLabel(cardNames: Record<string, string>) {
  const t = useTranslations(`${NS}.field`);
  return (source: string): string => {
    if (source === 'local') return t('sourceLocal');
    if (source === 'hidden') return t('sourceHidden');
    if (source === 'none') return t('sourceNone');
    if (source.startsWith('card:')) return t('sourceCard', { name: cardNames[source.slice(5)] ?? '…' });
    const map: Record<string, string> = {
      'org:company': t('sourceCompany'),
      'org:shop': t('sourceShop'),
      'org:area': t('sourceArea'),
      'org:brand': t('sourceBrand'),
      'org:club': t('sourceClub'),
    };
    return map[source] ?? t('sourceOrg');
  };
}

function langsOf(doc: CardDoc): CardLang[] {
  const l = (doc.languages ?? []).filter((x) => (CARD_LANGS as readonly string[]).includes(x));
  return l.length ? l : ['he'];
}

// ── Text in each language ─────────────────────────────────────────────────────

export function LocalTextInput({
  label,
  value,
  onChange,
  languages,
  multiline,
  max,
  placeholder,
  disabled,
  hideLabel,
}: {
  label: string;
  value: LocalText | null | undefined;
  onChange: (v: LocalText | null) => void;
  languages: CardLang[];
  multiline?: boolean;
  max?: number;
  placeholder?: LocalText | null;
  disabled?: boolean;
  hideLabel?: boolean;
}) {
  const t = useTranslations(`${NS}.field`);
  const id = useId();
  const set = (lang: CardLang, text: string) => {
    const next: LocalText = { ...(value ?? {}) };
    if (text) next[lang] = text;
    else delete next[lang];
    onChange(Object.keys(next).length ? next : null);
  };
  return (
    <fieldset className="min-w-0 space-y-1.5" disabled={disabled}>
      <legend className={cn('text-xs font-medium', hideLabel && 'sr-only')}>{label}</legend>
      {languages.map((lang) => {
        const common = {
          id: `${id}-${lang}`,
          dir: lang === 'he' ? 'rtl' : 'ltr',
          lang,
          value: value?.[lang] ?? '',
          maxLength: max,
          placeholder: placeholder?.[lang] ?? (lang !== languages[0] ? placeholder?.[languages[0]] : undefined) ?? '',
          onChange: (e: { target: { value: string } }) => set(lang, e.target.value),
          'aria-label': languages.length > 1 ? `${label} — ${t(lang)}` : label,
        } as const;
        return (
          <div key={lang} className="flex items-start gap-2">
            {languages.length > 1 ? <span className="mt-1.5 w-12 shrink-0 text-[0.7rem] text-muted-foreground">{t(lang)}</span> : null}
            {multiline ? <TextArea rows={3} {...common} /> : <Input {...common} />}
          </div>
        );
      })}
    </fieldset>
  );
}

function StringInput({
  label,
  value,
  onChange,
  placeholder,
  error,
  type = 'text',
  ltr,
  disabled,
  max = 500,
  hideLabel,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  error?: string | null;
  type?: string;
  ltr?: boolean;
  disabled?: boolean;
  max?: number;
  hideLabel?: boolean;
}) {
  const id = useId();
  return (
    <div className="min-w-0 space-y-1">
      <Label htmlFor={id} className={cn('text-xs', hideLabel && 'sr-only')}>
        {label}
      </Label>
      <Input
        id={id}
        type={type}
        dir={ltr ? 'ltr' : undefined}
        className={ltr ? 'text-start' : undefined}
        value={value}
        placeholder={placeholder}
        maxLength={max}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-err` : undefined}
        onChange={(e) => onChange(e.target.value)}
      />
      {error ? <Hint tone="error" id={`${id}-err`}>{error}</Hint> : null}
    </div>
  );
}

// ── Images and files (the existing upload: POST /business-cards/media) ───────

function ImageInput({ value, onChange, languages, disabled }: { value: CardImage | null; onChange: (v: CardImage | null) => void; languages: CardLang[]; disabled?: boolean }) {
  const t = useTranslations(`${NS}.field`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const pick = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const res = await uploadCardMedia(file);
      onChange({ ...(value ?? {}), url: res.url });
    } catch {
      setError(t('uploadFailed'));
    } finally {
      setBusy(false);
    }
  };
  const bad = value?.url && !isSafeMediaUrl(value.url);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3">
        <div className="flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border bg-muted">
          {value?.url && !bad ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={value.url} alt="" className="size-full object-cover" />
          ) : (
            <ImageUp aria-hidden className="size-6 text-muted-foreground" />
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <label htmlFor={id} className={cn('inline-flex h-7 cursor-pointer items-center gap-1 rounded-lg border px-2.5 text-[0.8rem] font-medium hover:bg-muted', (busy || disabled) && 'pointer-events-none opacity-50')}>
            {busy ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <Upload aria-hidden className="size-3.5" />}
            {busy ? t('uploading') : t('upload')}
          </label>
          <input id={id} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" disabled={busy || disabled} onChange={(e) => void pick(e.target.files?.[0])} />
          {value?.url ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => onChange(null)} disabled={disabled}>
              <Trash2 aria-hidden />
              {t('remove')}
            </Button>
          ) : null}
        </div>
      </div>
      {error ? <Hint tone="error">{error}</Hint> : null}
      <StringInput label={t('imageUrl')} value={value?.url ?? ''} ltr disabled={disabled} error={bad ? t('invalidImage') : null} onChange={(url) => onChange(url ? { ...(value ?? {}), url } : null)} />
      {value?.url ? (
        <LocalTextInput label={t('altText')} value={value.alt ?? null} languages={languages} max={200} disabled={disabled} onChange={(alt) => onChange({ ...value, alt: alt ?? undefined })} />
      ) : null}
    </div>
  );
}

// ── Structured values ────────────────────────────────────────────────────────

function HoursInput({ value, onChange, languages, disabled }: { value: HoursValue | null; onChange: (v: HoursValue | null) => void; languages: CardLang[]; disabled?: boolean }) {
  const t = useTranslations(`${NS}.field`);
  const days = t('dayNames').split(',');
  const rows = value?.rows ?? [];
  const setRows = (next: HoursRow[]) => onChange({ rows: next, note: value?.note });
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <div key={i} className="space-y-1.5 rounded-lg border p-2">
          <div role="group" aria-label={`${t('days')} ${i + 1}`} className="flex flex-wrap gap-1">
            {days.map((name, d) => {
              const on = r.days.includes(d);
              return (
                <button
                  key={d}
                  type="button"
                  aria-pressed={on}
                  disabled={disabled}
                  onClick={() => setRows(rows.map((x, j) => (j === i ? { ...x, days: on ? x.days.filter((y) => y !== d) : [...x.days, d].sort() } : x)))}
                  className={cn('h-7 min-w-8 rounded-md border px-1.5 text-xs font-medium', on ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted')}
                >
                  {name}
                </button>
              );
            })}
          </div>
          <div className="flex items-end gap-2">
            <StringInput label={t('open')} type="time" value={r.open} ltr disabled={disabled} onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, open: v } : x)))} />
            <StringInput label={t('close')} type="time" value={r.close} ltr disabled={disabled} onChange={(v) => setRows(rows.map((x, j) => (j === i ? { ...x, close: v } : x)))} />
            <Button type="button" size="icon-sm" variant="ghost" aria-label={t('removeRow')} disabled={disabled} onClick={() => setRows(rows.filter((_, j) => j !== i))}>
              <Trash2 aria-hidden />
            </Button>
          </div>
        </div>
      ))}
      <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => setRows([...rows, { days: [0, 1, 2, 3, 4], open: '09:00', close: '18:00' }])}>
        <Plus aria-hidden />
        {t('addRow')}
      </Button>
      <LocalTextInput label={t('note')} value={value?.note ?? null} languages={languages} max={200} disabled={disabled} onChange={(note) => onChange({ rows, note: note ?? undefined })} />
    </div>
  );
}

function ListEditor<T>({
  items,
  onChange,
  render,
  blank,
  addLabel,
  disabled,
  max,
}: {
  items: T[];
  onChange: (v: T[]) => void;
  render: (item: T, set: (v: T) => void, index: number) => ReactNode;
  blank: () => T;
  addLabel: string;
  disabled?: boolean;
  max: number;
}) {
  const t = useTranslations(`${NS}.field`);
  return (
    <div className="space-y-2">
      {items.map((it, i) => (
        <div key={i} className="relative space-y-1.5 rounded-lg border p-2 pe-9">
          {render(it, (v) => onChange(items.map((x, j) => (j === i ? v : x))), i)}
          <Button type="button" size="icon-xs" variant="ghost" className="absolute end-1 top-1" aria-label={t('remove')} disabled={disabled} onClick={() => onChange(items.filter((_, j) => j !== i))}>
            <Trash2 aria-hidden />
          </Button>
        </div>
      ))}
      {items.length < max ? (
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={() => onChange([...items, blank()])}>
          <Plus aria-hidden />
          {addLabel}
        </Button>
      ) : null}
    </div>
  );
}

function FileUploadButton({ onUploaded, disabled }: { onUploaded: (f: PublicFile) => void; disabled?: boolean }) {
  const t = useTranslations(`${NS}.field`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  return (
    <div className="space-y-1">
      <label htmlFor={id} className={cn('inline-flex h-7 cursor-pointer items-center gap-1 rounded-lg border px-2.5 text-[0.8rem] font-medium hover:bg-muted', (busy || disabled) && 'pointer-events-none opacity-50')}>
        {busy ? <Loader2 aria-hidden className="size-3.5 animate-spin" /> : <Upload aria-hidden className="size-3.5" />}
        {busy ? t('uploading') : t('addFile')}
      </label>
      <input
        id={id}
        type="file"
        accept="application/pdf"
        className="sr-only"
        disabled={busy || disabled}
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          setBusy(true);
          setError(null);
          try {
            const res = await uploadCardMedia(file);
            onUploaded({ title: { he: file.name.replace(/\.pdf$/i, '') }, url: res.url, bytes: res.bytes });
          } catch {
            setError(t('uploadFailed'));
          } finally {
            setBusy(false);
            e.target.value = '';
          }
        }}
      />
      {error ? <Hint tone="error">{error}</Hint> : null}
    </div>
  );
}

// ── The row ───────────────────────────────────────────────────────────────────

export function FieldRow({ k, ctx, label, hint }: { k: FieldKey; ctx: FieldCtx; label?: string; hint?: string }) {
  const t = useTranslations(`${NS}.field`);
  const tf = useTranslations(`${NS}.fields`);
  const th = useTranslations(`${NS}.fieldHints`);
  const sourceLabel = useSourceLabel(ctx.cardNames);
  const f = getField(ctx.doc, k, ctx.type);
  const e = ctx.eff[k];
  const spec = FIELD_SPECS[k];
  const languages = langsOf(ctx.doc);
  const disabled = !ctx.canEdit;
  const name = label ?? tf(k);
  const hintText = hint ?? (th.has(k) ? th(k) : undefined);
  const set = (patch: Partial<CardField>) => ctx.update((d) => withField(d, k, ctx.type, patch));
  const setLocal = (value: unknown) => set({ mode: 'local', value });
  const inheritable = spec.inherit.length > 0 && !(ctx.type === 'personal' && spec.personalLocalOnly);
  const inheritedValue = f.mode === 'inherit' ? e.value : null;
  const localValue = f.mode === 'local' ? f.value : null;
  const invalid =
    f.mode === 'local' && localValue !== null && localValue !== '' && ['phone', 'email', 'url', 'image'].includes(spec.kind) && usableValue(k, localValue) === null;

  const value = (() => {
    const v = (localValue ?? null) as never;
    const ph = inheritedValue as never;
    switch (spec.kind) {
      case 'text':
        return (
          <LocalTextInput
            label={name}
            hideLabel
            value={v as LocalText | null}
            placeholder={ph as LocalText | null}
            onChange={(x) => setLocal(x)}
            languages={languages}
            multiline={k === 'description'}
            max={spec.max}
            disabled={disabled}
          />
        );
      case 'phone':
      case 'email':
      case 'url':
      case 'navigation': {
        const placeholder = typeof ph === 'string' ? (spec.kind === 'phone' ? displayPhone(ph) : ph) : '';
        const err = invalid ? (spec.kind === 'phone' ? t('invalidPhone') : spec.kind === 'email' ? t('invalidEmail') : t('invalidUrl')) : null;
        return (
          <StringInput
            label={name}
            hideLabel
            value={(v as string | null) ?? ''}
            placeholder={placeholder}
            type={spec.kind === 'email' ? 'email' : spec.kind === 'phone' ? 'tel' : spec.kind === 'url' ? 'url' : 'text'}
            ltr={spec.kind !== 'navigation'}
            error={err}
            disabled={disabled}
            max={spec.kind === 'phone' ? 30 : spec.kind === 'email' ? 254 : 500}
            onChange={(x) => (x === '' && f.mode === 'local' ? setLocal(null) : setLocal(x))}
          />
        );
      }
      case 'image':
        return f.mode === 'local' ? (
          <ImageInput value={v as CardImage | null} onChange={(x) => setLocal(x)} languages={languages} disabled={disabled} />
        ) : (
          <InheritedPreview value={ph} onCopy={() => setLocal(ph ?? null)} disabled={disabled} kind="image" />
        );
      default:
        if (f.mode !== 'local') return <InheritedPreview value={ph} onCopy={() => setLocal(ph ?? null)} disabled={disabled} kind={spec.kind} />;
        return <StructuredValue k={k} value={v} onChange={(x) => setLocal(x)} languages={languages} disabled={disabled} />;
    }
  })();

  return (
    <div className={cn('space-y-2 rounded-xl border p-3', invalid && 'border-destructive/60')} data-field={k}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-semibold">{name}</div>
          <div className="text-[0.72rem] text-muted-foreground">
            {sourceLabel(e.source)}
            {f.visibility === 'private' ? (
              <span className="ms-1.5 inline-flex items-center gap-0.5 font-medium text-amber-800 dark:text-amber-300">
                <Lock aria-hidden className="size-3" />
                {t('private')}
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <Segmented
            label={t('mode')}
            size="xs"
            value={f.mode}
            disabled={disabled}
            onChange={(mode) => set({ mode })}
            options={[
              ...(inheritable ? [{ value: 'inherit' as const, label: t('inherit') }] : []),
              { value: 'local' as const, label: t('local') },
              { value: 'hidden' as const, label: t('hidden') },
            ]}
          />
          <Button
            type="button"
            size="sm"
            variant={f.visibility === 'private' ? 'secondary' : 'ghost'}
            disabled={disabled}
            aria-pressed={f.visibility === 'private'}
            aria-label={`${name} — ${t('visibility')}: ${f.visibility === 'private' ? t('private') : t('public')}`}
            title={t('privateHint')}
            onClick={() => set({ visibility: f.visibility === 'private' ? 'public' : 'private' })}
            className="self-end"
          >
            {f.visibility === 'private' ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
            {f.visibility === 'private' ? t('private') : t('public')}
          </Button>
        </div>
      </div>
      {f.mode === 'hidden' ? <Hint>{t('sourceHidden')}</Hint> : value}
      {f.mode === 'local' && inheritable ? (
        <Button type="button" size="xs" variant="ghost" disabled={disabled} onClick={() => set({ mode: 'inherit', value: null })}>
          <Undo2 aria-hidden />
          {t('restoreInherit')}
        </Button>
      ) : null}
      {f.visibility === 'private' ? <Hint tone="warn">{t('privateHint')}</Hint> : null}
      {hintText ? <Hint>{hintText}</Hint> : null}
    </div>
  );
}

function InheritedPreview({ value, onCopy, disabled, kind }: { value: unknown; onCopy: () => void; disabled?: boolean; kind: string }) {
  const t = useTranslations(`${NS}.field`);
  const summary = (() => {
    if (value === null || value === undefined) return t('nothingShown');
    if (kind === 'image') return (value as CardImage).url;
    if (Array.isArray(value)) return `${value.length} ×`;
    if (kind === 'hours') return `${(value as HoursValue).rows.length} ×`;
    const o = value as Record<string, unknown>;
    const title = o.title as LocalText | undefined;
    return title?.he ?? title?.en ?? '✓';
  })();
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/60 px-2.5 py-2 text-xs">
      <span className="min-w-0 truncate">
        {t('shown')} <span dir="auto" className="font-medium">{summary}</span>
      </span>
      <Button type="button" size="xs" variant="outline" disabled={disabled} onClick={onCopy}>
        {t('local')}
      </Button>
    </div>
  );
}

function StructuredValue({ k, value, onChange, languages, disabled }: { k: FieldKey; value: unknown; onChange: (v: unknown) => void; languages: CardLang[]; disabled?: boolean }) {
  const t = useTranslations(`${NS}.field`);
  const tp = useTranslations(`${NS}.platforms`);
  switch (FIELD_SPECS[k].kind) {
    case 'hours':
      return <HoursInput value={value as HoursValue | null} onChange={onChange} languages={languages} disabled={disabled} />;
    case 'services':
      return (
        <ListEditor<ServiceItem>
          items={(value as ServiceItem[] | null) ?? []}
          onChange={onChange}
          max={24}
          disabled={disabled}
          addLabel={t('addService')}
          blank={() => ({ title: {} })}
          render={(it, set) => (
            <>
              <LocalTextInput label={t('serviceTitle')} value={it.title} languages={languages} max={120} disabled={disabled} onChange={(x) => set({ ...it, title: x ?? {} })} />
              <LocalTextInput label={t('serviceDesc')} value={it.description ?? null} languages={languages} max={300} multiline disabled={disabled} onChange={(x) => set({ ...it, description: x ?? undefined })} />
            </>
          )}
        />
      );
    case 'social':
      return (
        <ListEditor<SocialLink>
          items={(value as SocialLink[] | null) ?? []}
          onChange={onChange}
          max={12}
          disabled={disabled}
          addLabel={t('addLink')}
          blank={() => ({ platform: 'instagram', url: '' })}
          render={(it, set) => (
            <div className="grid gap-2 sm:grid-cols-[9rem_1fr]">
              <NativeSelect
                label={t('platform')}
                value={it.platform}
                disabled={disabled}
                onChange={(p) => set({ ...it, platform: p as SocialPlatform })}
                options={SOCIAL_PLATFORMS.map((p) => ({ value: p, label: tp(p) }))}
              />
              <StringInput
                label={t('url')}
                value={it.url}
                ltr
                disabled={disabled}
                placeholder="https://"
                error={it.url && !isPlatformUrl(it.platform, it.url) ? t('invalidPlatform') : null}
                onChange={(url) => set({ ...it, url })}
              />
            </div>
          )}
        />
      );
    case 'files': {
      const files = (value as PublicFile[] | null) ?? [];
      return (
        <div className="space-y-2">
          <ListEditor<PublicFile>
            items={files}
            onChange={onChange}
            max={12}
            disabled={disabled}
            addLabel={t('url')}
            blank={() => ({ title: {}, url: '' })}
            render={(it, set) => (
              <>
                <LocalTextInput label={t('fileTitle')} value={it.title} languages={languages} max={120} disabled={disabled} onChange={(x) => set({ ...it, title: x ?? {} })} />
                <StringInput label={t('url')} value={it.url} ltr disabled={disabled} error={it.url && !isSafeMediaUrl(it.url) ? t('invalidUrl') : null} onChange={(url) => set({ ...it, url })} />
              </>
            )}
          />
          {files.length < 12 ? <FileUploadButton disabled={disabled} onUploaded={(f) => onChange([...files, f])} /> : null}
        </div>
      );
    }
    case 'announcement': {
      const a = (value as AnnouncementValue | null) ?? {};
      return (
        <div className="space-y-2">
          <LocalTextInput label={t('annTitle')} value={a.title ?? null} languages={languages} max={120} disabled={disabled} onChange={(x) => onChange({ ...a, title: x ?? undefined })} />
          <LocalTextInput label={t('annBody')} value={a.body ?? null} languages={languages} max={600} multiline disabled={disabled} onChange={(x) => onChange({ ...a, body: x ?? undefined })} />
          <StringInput label={t('until')} type="date" ltr value={a.until ?? ''} disabled={disabled} onChange={(x) => onChange({ ...a, until: x || null })} />
        </div>
      );
    }
    case 'event': {
      const ev = (value as EventValue | null) ?? {};
      return (
        <div className="space-y-2">
          <LocalTextInput label={t('evTitle')} value={ev.title ?? null} languages={languages} max={120} disabled={disabled} onChange={(x) => onChange({ ...ev, title: x ?? undefined })} />
          <LocalTextInput label={t('venue')} value={ev.venue ?? null} languages={languages} max={200} disabled={disabled} onChange={(x) => onChange({ ...ev, venue: x ?? undefined })} />
          <div className="grid gap-2 sm:grid-cols-2">
            <StringInput label={t('startsAt')} type="datetime-local" ltr value={ev.startsAt ?? ''} disabled={disabled} onChange={(x) => onChange({ ...ev, startsAt: x || null })} />
            <StringInput label={t('endsAt')} type="datetime-local" ltr value={ev.endsAt ?? ''} disabled={disabled} onChange={(x) => onChange({ ...ev, endsAt: x || null })} />
          </div>
          <StringInput label={t('expiresAt')} type="date" ltr value={ev.expiresAt ?? ''} disabled={disabled} onChange={(x) => onChange({ ...ev, expiresAt: x || null })} />
        </div>
      );
    }
    case 'offer': {
      const o = (value as OfferValue | null) ?? {};
      return (
        <div className="space-y-2">
          <LocalTextInput label={t('offerTitle')} value={o.title ?? null} languages={languages} max={120} disabled={disabled} onChange={(x) => onChange({ ...o, title: x ?? undefined })} />
          <LocalTextInput label={t('offerBody')} value={o.body ?? null} languages={languages} max={600} multiline disabled={disabled} onChange={(x) => onChange({ ...o, body: x ?? undefined })} />
          <StringInput label={t('validUntil')} type="date" ltr value={o.validUntil ?? ''} disabled={disabled} onChange={(x) => onChange({ ...o, validUntil: x || null })} />
        </div>
      );
    }
    case 'support': {
      const s = (value as SupportValue | null) ?? {};
      return (
        <div className="space-y-2">
          <StringInput label={t('supPhone')} type="tel" ltr value={s.phone ?? ''} disabled={disabled} onChange={(x) => onChange({ ...s, phone: x || null })} />
          <LocalTextInput label={t('supHours')} value={s.hours ?? null} languages={languages} max={200} disabled={disabled} onChange={(x) => onChange({ ...s, hours: x ?? undefined })} />
          <LocalTextInput label={t('supNote')} value={s.note ?? null} languages={languages} max={300} multiline disabled={disabled} onChange={(x) => onChange({ ...s, note: x ?? undefined })} />
          <StringInput label={t('supUrl')} type="url" ltr value={s.url ?? ''} disabled={disabled} onChange={(x) => onChange({ ...s, url: x || null })} />
        </div>
      );
    }
    default:
      return null;
  }
}

export { inputCls };
