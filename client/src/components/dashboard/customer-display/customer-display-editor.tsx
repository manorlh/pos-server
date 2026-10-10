'use client';

/**
 * "מסך לקוח" — one layer's editor (P:/specs/customer-display.md §3): every field shows what it
 * inherits and where from, and may be set at this level or left to inherit. The playlist is
 * uploaded through the existing media upload (`POST /images/media`: images and MP4 / WebM up
 * to 25 MB), ordered, each slide with its duration.
 */

import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, ImagePlus, Loader2, Trash2, Video } from 'lucide-react';
import { uploadBrandingImage, uploadBrandingMedia } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  CD_TEXT,
  DURATION_MAX,
  DURATION_MIN,
  IDLE_MAX,
  IDLE_MIN,
  LANGUAGES,
  LANGUAGE_LABELS,
  LAYOUTS,
  LAYOUT_LABELS,
  LEVEL_LABELS,
  PLAYLIST_MAX,
  SHOW_KEYS,
  SHOW_LABELS,
  TEXT_MAX,
  THANKS_MAX,
  THANKS_MIN,
  THEMES,
  THEME_LABELS,
  clampDuration,
  effectiveOf,
  intInRange,
  isOwn,
  moveItem,
  playlistError,
  playlistItemOf,
  playlistSeconds,
  withField,
  type CdConfig,
  type CdLayer,
  type CdLayerView,
} from '@/lib/customerDisplay';
import { customerDisplayErrorMessage, putCustomerDisplayLayer } from '@/lib/customerDisplayApi';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const VIDEO_TYPES = ['video/mp4', 'video/webm'];
const MAX_BYTES = 25 * 1024 * 1024;

function SourceNote({ view, own, field }: { view: CdLayerView; own: CdLayer; field: keyof CdConfig }) {
  if (isOwn(own, field)) return <span className="text-[11px] font-medium text-primary">{CD_TEXT.own}</span>;
  const from = view.inheritedSources[field];
  return <span className="text-[11px] text-muted-foreground">{from ? CD_TEXT.from(from) : CD_TEXT.fromDefault}</span>;
}

/** A field's row: its label, where its value comes from, and "ירושה" once it is set here. */
function FieldRow({
  label,
  hint,
  view,
  own,
  field,
  onInherit,
  children,
}: {
  label: string;
  hint?: string;
  view: CdLayerView;
  own: CdLayer;
  field: keyof CdConfig;
  onInherit: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5 border-b pb-3 last:border-b-0">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium">{label}</span>
        <span className="flex items-center gap-2">
          <SourceNote view={view} own={own} field={field} />
          {isOwn(own, field) ? (
            <button type="button" className="text-[11px] text-muted-foreground underline" onClick={onInherit}>
              {CD_TEXT.inherit}
            </button>
          ) : null}
        </span>
      </div>
      {children}
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

function Choice<T extends string>({ options, labels, value, onChange }: { options: readonly T[]; labels: Record<T, string>; value: T; onChange: (v: T) => void }) {
  return (
    <div role="radiogroup" className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button
          key={o}
          type="button"
          role="radio"
          aria-checked={value === o}
          onClick={() => onChange(o)}
          className={cn(
            'min-h-9 rounded-lg border px-3 text-sm transition-colors',
            value === o ? 'border-primary bg-primary/5 font-medium ring-1 ring-primary' : 'hover:bg-muted/60',
          )}
        >
          {labels[o]}
        </button>
      ))}
    </div>
  );
}

export function CustomerDisplayEditor({ view, onSaved }: { view: CdLayerView; onSaved: (next: CdLayerView) => void }) {
  // The mirrored till is the displays card's (and the server keeps it on a write without it).
  const [own, setOwn] = useState<CdLayer>(() => {
    const rest: CdLayer = { ...(view.own ?? {}) };
    delete rest.mirrorTillId;
    return rest;
  });
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const logoRef = useRef<HTMLInputElement>(null);
  const eff = effectiveOf(view.inherited, own);
  const set = <K extends keyof CdConfig>(key: K, value: CdConfig[K] | undefined) => setOwn((o) => withField(o, key, value));
  const listError = playlistError(eff.playlist);

  const upload = async (file: File) => {
    if (file.size > MAX_BYTES) {
      toast.error('הקובץ גדול מ-25MB.');
      return;
    }
    if (!file.type.startsWith('image/') && !VIDEO_TYPES.includes(file.type)) {
      toast.error('רק תמונה, או סרטון MP4 / WebM.');
      return;
    }
    setUploading(true);
    try {
      const result = await uploadBrandingMedia(file);
      set('playlist', [...eff.playlist, playlistItemOf(result)].slice(0, PLAYLIST_MAX));
    } catch (err) {
      toast.error(axiosErrorToToastMessage(err, 'ההעלאה נכשלה'));
    } finally {
      setUploading(false);
    }
  };

  const uploadLogo = async (file: File) => {
    setUploading(true);
    try {
      const result = await uploadBrandingImage(file, 'logo');
      set('logoUrl', result.url);
    } catch (err) {
      toast.error(axiosErrorToToastMessage(err, 'ההעלאה נכשלה'));
    } finally {
      setUploading(false);
    }
  };

  const save = async () => {
    if (listError) {
      toast.error(listError);
      return;
    }
    setSaving(true);
    try {
      const next = await putCustomerDisplayLayer(view.level, view.entityId, own);
      toast.success(CD_TEXT.saved);
      onSaved(next);
    } catch (err) {
      toast.error(customerDisplayErrorMessage(err) ?? axiosErrorToToastMessage(err, CD_TEXT.loadError));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <CardTitle className="text-base">
          {CD_TEXT.title} — {LEVEL_LABELS[view.level]}
        </CardTitle>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setOwn({})} disabled={saving}>
            {CD_TEXT.reset}
          </Button>
          <Button size="sm" onClick={() => void save()} disabled={saving || uploading || !!listError}>
            {saving ? CD_TEXT.saving : CD_TEXT.save}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <FieldRow label={CD_TEXT.enabled} hint={CD_TEXT.enabledHint} view={view} own={own} field="enabled" onInherit={() => set('enabled', undefined)}>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4 accent-primary" checked={eff.enabled} onChange={(e) => set('enabled', e.target.checked)} />
            {eff.enabled ? 'פעיל' : 'כבוי'}
          </label>
        </FieldRow>

        <FieldRow label={CD_TEXT.layout} view={view} own={own} field="layout" onInherit={() => set('layout', undefined)}>
          <Choice options={LAYOUTS} labels={LAYOUT_LABELS} value={eff.layout} onChange={(v) => set('layout', v)} />
        </FieldRow>

        <FieldRow label={CD_TEXT.theme} view={view} own={own} field="theme" onInherit={() => set('theme', undefined)}>
          <Choice options={THEMES} labels={THEME_LABELS} value={eff.theme} onChange={(v) => set('theme', v)} />
        </FieldRow>

        <FieldRow label={CD_TEXT.language} view={view} own={own} field="language" onInherit={() => set('language', undefined)}>
          <Choice options={LANGUAGES} labels={LANGUAGE_LABELS} value={eff.language} onChange={(v) => set('language', v)} />
        </FieldRow>

        <FieldRow label={CD_TEXT.show} view={view} own={own} field="show" onInherit={() => set('show', undefined)}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {SHOW_KEYS.map((k) => (
              <label key={k} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-primary"
                  checked={eff.show[k]}
                  onChange={(e) => set('show', { ...eff.show, [k]: e.target.checked })}
                />
                {SHOW_LABELS[k]}
              </label>
            ))}
          </div>
        </FieldRow>

        <FieldRow label={CD_TEXT.playlist} hint={CD_TEXT.playlistHint} view={view} own={own} field="playlist" onInherit={() => set('playlist', undefined)}>
          <div className="space-y-2">
            {eff.playlist.map((item, i) => (
              <div key={`${item.url}-${i}`} className="flex flex-wrap items-center gap-2 rounded-lg border p-2">
                {item.kind === 'video' ? (
                  <Video className="h-10 w-10 shrink-0 text-muted-foreground" aria-hidden />
                ) : (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={item.url} alt="" className="h-10 w-16 shrink-0 rounded object-cover" />
                )}
                <span dir="ltr" className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                  {item.url.split('/').pop()}
                </span>
                <label className="flex items-center gap-1 text-xs">
                  <Input
                    type="number"
                    min={DURATION_MIN}
                    max={DURATION_MAX}
                    className="h-8 w-20"
                    value={item.durationSec}
                    onChange={(e) =>
                      set(
                        'playlist',
                        eff.playlist.map((p, j) => (j === i ? { ...p, durationSec: clampDuration(Number(e.target.value)) } : p)),
                      )
                    }
                  />
                  {CD_TEXT.seconds}
                </label>
                <Button type="button" variant="ghost" size="icon" aria-label={CD_TEXT.moveUp} disabled={i === 0} onClick={() => set('playlist', moveItem(eff.playlist, i, i - 1))}>
                  <ArrowUp className="h-4 w-4" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={CD_TEXT.moveDown}
                  disabled={i === eff.playlist.length - 1}
                  onClick={() => set('playlist', moveItem(eff.playlist, i, i + 1))}
                >
                  <ArrowDown className="h-4 w-4" />
                </Button>
                <Button type="button" variant="ghost" size="icon" aria-label={CD_TEXT.remove} onClick={() => set('playlist', eff.playlist.filter((_, j) => j !== i))}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-3">
              <input
                ref={fileRef}
                type="file"
                accept="image/png,image/jpeg,image/webp,video/mp4,video/webm"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) void upload(f);
                }}
              />
              <Button type="button" variant="outline" size="sm" disabled={uploading || eff.playlist.length >= PLAYLIST_MAX} onClick={() => fileRef.current?.click()}>
                {uploading ? <Loader2 className="me-1 h-4 w-4 animate-spin" /> : <ImagePlus className="me-1 h-4 w-4" />}
                {uploading ? CD_TEXT.uploading : CD_TEXT.addMedia}
              </Button>
              {eff.playlist.length ? <span className="text-xs text-muted-foreground">{CD_TEXT.roundTime(playlistSeconds(eff.playlist))}</span> : null}
            </div>
            {listError ? <p className="text-xs text-destructive">{listError}</p> : null}
          </div>
        </FieldRow>

        <FieldRow label={CD_TEXT.logo} hint={CD_TEXT.logoHint} view={view} own={own} field="logoUrl" onInherit={() => set('logoUrl', undefined)}>
          <div className="flex flex-wrap items-center gap-2">
            {eff.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={eff.logoUrl} alt="" className="h-10 max-w-32 rounded bg-muted object-contain" />
            ) : null}
            <input
              ref={logoRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void uploadLogo(f);
              }}
            />
            <Button type="button" variant="outline" size="sm" disabled={uploading} onClick={() => logoRef.current?.click()}>
              <ImagePlus className="me-1 h-4 w-4" />
              {CD_TEXT.logo}
            </Button>
            {eff.logoUrl ? (
              <Button type="button" variant="ghost" size="sm" onClick={() => set('logoUrl', '')}>
                {CD_TEXT.remove}
              </Button>
            ) : null}
          </div>
        </FieldRow>

        <div className="grid gap-3 sm:grid-cols-2">
          <FieldRow label={CD_TEXT.idleTimeout} hint={CD_TEXT.idleTimeoutHint} view={view} own={own} field="idleTimeoutSec" onInherit={() => set('idleTimeoutSec', undefined)}>
            <Input
              type="number"
              min={IDLE_MIN}
              max={IDLE_MAX}
              value={eff.idleTimeoutSec}
              onChange={(e) => {
                const v = intInRange(e.target.value, IDLE_MIN, IDLE_MAX);
                if (v !== null) set('idleTimeoutSec', v);
              }}
            />
          </FieldRow>
          <FieldRow label={CD_TEXT.thanksSec} view={view} own={own} field="thanksSec" onInherit={() => set('thanksSec', undefined)}>
            <Input
              type="number"
              min={THANKS_MIN}
              max={THANKS_MAX}
              value={eff.thanksSec}
              onChange={(e) => {
                const v = intInRange(e.target.value, THANKS_MIN, THANKS_MAX);
                if (v !== null) set('thanksSec', v);
              }}
            />
          </FieldRow>
          <FieldRow label={CD_TEXT.welcomeText} view={view} own={own} field="welcomeText" onInherit={() => set('welcomeText', undefined)}>
            <Input value={eff.welcomeText} maxLength={TEXT_MAX} placeholder={CD_TEXT.textPlaceholder} onChange={(e) => set('welcomeText', e.target.value)} />
          </FieldRow>
          <FieldRow label={CD_TEXT.thanksText} view={view} own={own} field="thanksText" onInherit={() => set('thanksText', undefined)}>
            <Input value={eff.thanksText} maxLength={TEXT_MAX} placeholder={CD_TEXT.textPlaceholder} onChange={(e) => set('thanksText', e.target.value)} />
          </FieldRow>
        </div>
      </CardContent>
    </Card>
  );
}
