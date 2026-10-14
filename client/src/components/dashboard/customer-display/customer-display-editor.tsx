'use client';

/**
 * "מסך לקוח" — one layer's editor (P:/specs/customer-display.md §3): every field shows what it
 * inherits and where from, and may be set at this level or left to inherit.
 *
 * The slideshow (P:/specs/customer-display-transitions.md §1–§3א): its files uploaded several at
 * once and compressed in the background (customer-display-playlist.tsx), dragged into order, each
 * with its duration and its own transition; the motion — the transition, its length, Ken Burns,
 * videos to their end, shuffle — the video quality of the uploads and how long the server keeps
 * the files; and a live preview playing it as the screen will (customer-display-preview.tsx).
 */

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ImagePlus } from 'lucide-react';
import { uploadBrandingImage } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  CD_TEXT,
  IDLE_MAX,
  IDLE_MIN,
  LANGUAGES,
  LANGUAGE_LABELS,
  LAYOUTS,
  LAYOUT_LABELS,
  LEVEL_LABELS,
  RETENTION_DAYS_MAX,
  RETENTION_DAYS_MIN,
  SHOW_KEYS,
  SHOW_LABELS,
  TEXT_MAX,
  THANKS_MAX,
  THANKS_MIN,
  THEMES,
  THEME_LABELS,
  TRANSITIONS,
  TRANSITION_MS_MAX,
  TRANSITION_MS_MIN,
  VIDEO_QUALITIES,
  effectiveOf,
  intInRange,
  isOwn,
  parseRetention,
  playlistError,
  retentionValue,
  withField,
  type CdConfig,
  type CdLayer,
  type CdLayerView,
  type PlaylistItem,
  type RetentionMode,
} from '@/lib/customerDisplay';
import { customerDisplayErrorMessage, putCustomerDisplayLayer } from '@/lib/customerDisplayApi';
import { PlaylistEditor } from '@/components/dashboard/customer-display/customer-display-playlist';
import { CustomerDisplayPreview } from '@/components/dashboard/customer-display/customer-display-preview';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

const RETENTION_MODES: readonly RetentionMode[] = ['keep', 'until_downloaded', 'days'];

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
  const tm = useTranslations('customerDisplayMotion');
  // The mirrored till is the displays card's (and the server keeps it on a write without it).
  const [own, setOwn] = useState<CdLayer>(() => {
    const rest: CdLayer = { ...(view.own ?? {}) };
    delete rest.mirrorTillId;
    return rest;
  });
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [playlistBusy, setPlaylistBusy] = useState(false);
  const [playingUrl, setPlayingUrl] = useState<string | null>(null);
  const [logoInput, setLogoInput] = useState<HTMLInputElement | null>(null);
  const eff = effectiveOf(view.inherited, own);
  const set = <K extends keyof CdConfig>(key: K, value: CdConfig[K] | undefined) => setOwn((o) => withField(o, key, value));
  const listError = playlistError(eff.playlist);
  const retention = parseRetention(eff.mediaRetention);

  /** A change made in the playlist editor: the playlist becomes this layer's own. */
  const updatePlaylist = useCallback(
    (fn: (items: PlaylistItem[]) => PlaylistItem[]) =>
      setOwn((o) => {
        const current = effectiveOf(view.inherited, o).playlist;
        const next = fn(current);
        return next === current ? o : withField(o, 'playlist', next);
      }),
    [view.inherited],
  );
  /** A file got ready: written into this layer's own playlist only (an inherited one is filled by the server). */
  const refreshPlaylist = useCallback(
    (fn: (items: PlaylistItem[]) => PlaylistItem[]) =>
      setOwn((o) => {
        if (!o.playlist) return o;
        const next = fn(o.playlist);
        return next === o.playlist ? o : withField(o, 'playlist', next);
      }),
    [],
  );

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
          <Button size="sm" onClick={() => void save()} disabled={saving || uploading || playlistBusy || !!listError}>
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
          <PlaylistEditor
            items={eff.playlist}
            update={updatePlaylist}
            refresh={refreshPlaylist}
            level={view.level}
            entityId={view.entityId}
            globalTransition={eff.transition}
            videoUntilEnd={eff.videoUntilEnd}
            videoQuality={eff.videoQuality}
            playingUrl={playingUrl}
            onBusy={setPlaylistBusy}
          />
          {listError ? <p className="text-xs text-destructive">{listError}</p> : null}
        </FieldRow>

        <div className="space-y-3 rounded-lg border p-3">
          <div className="text-sm font-semibold">{tm('motionTitle')}</div>
          <FieldRow label={tm('transition')} hint={tm('transitionHint')} view={view} own={own} field="transition" onInherit={() => set('transition', undefined)}>
            <Choice
              options={TRANSITIONS}
              labels={Object.fromEntries(TRANSITIONS.map((k) => [k, tm(`transitions.${k}`)])) as Record<CdConfig['transition'], string>}
              value={eff.transition}
              onChange={(v) => set('transition', v)}
            />
          </FieldRow>
          <FieldRow label={tm('transitionMs')} view={view} own={own} field="transitionMs" onInherit={() => set('transitionMs', undefined)}>
            <div className="flex items-center gap-3">
              <input
                type="range"
                min={TRANSITION_MS_MIN}
                max={TRANSITION_MS_MAX}
                step={100}
                value={eff.transitionMs}
                disabled={eff.transition === 'none'}
                className="w-56 accent-primary"
                onChange={(e) => {
                  const v = intInRange(e.target.value, TRANSITION_MS_MIN, TRANSITION_MS_MAX);
                  if (v !== null) set('transitionMs', v);
                }}
              />
              <span className="text-xs text-muted-foreground">{tm('transitionMsValue', { ms: eff.transitionMs })}</span>
            </div>
          </FieldRow>
          <div className="grid gap-3 sm:grid-cols-3">
            {(['kenBurns', 'videoUntilEnd', 'shuffle'] as const).map((key) => (
              <FieldRow key={key} label={tm(key)} hint={tm(`${key}Hint`)} view={view} own={own} field={key} onInherit={() => set(key, undefined)}>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="h-4 w-4 accent-primary" checked={eff[key]} onChange={(e) => set(key, e.target.checked)} />
                  {eff[key] ? tm('on') : tm('off')}
                </label>
              </FieldRow>
            ))}
          </div>
          <div className="space-y-1.5 border-b pb-3">
            <span className="text-sm font-medium">{tm('previewTitle')}</span>
            <CustomerDisplayPreview config={eff} onSlide={setPlayingUrl} />
            <p className="text-xs text-muted-foreground">{tm('previewHint')}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <FieldRow label={tm('videoQuality')} hint={tm('videoQualityHint')} view={view} own={own} field="videoQuality" onInherit={() => set('videoQuality', undefined)}>
              <Choice
                options={VIDEO_QUALITIES}
                labels={{ '720p': tm('videoQualities.720p'), '1080p': tm('videoQualities.1080p') }}
                value={eff.videoQuality}
                onChange={(v) => set('videoQuality', v)}
              />
            </FieldRow>
            <FieldRow
              label={tm('retention')}
              hint={
                retention.mode === 'days'
                  ? tm('retentionDaysHint', { days: retention.days })
                  : retention.mode === 'until_downloaded'
                    ? tm('retentionDownloadedHint')
                    : tm('retentionHint')
              }
              view={view}
              own={own}
              field="mediaRetention"
              onInherit={() => set('mediaRetention', undefined)}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Choice
                  options={RETENTION_MODES}
                  labels={{ keep: tm('retentionModes.keep'), until_downloaded: tm('retentionModes.until_downloaded'), days: tm('retentionModes.days') }}
                  value={retention.mode}
                  onChange={(m) => set('mediaRetention', retentionValue(m, retention.days))}
                />
                {retention.mode === 'days' ? (
                  <label className="flex items-center gap-1 text-xs">
                    <Input
                      type="number"
                      min={RETENTION_DAYS_MIN}
                      max={RETENTION_DAYS_MAX}
                      className="h-8 w-20"
                      value={retention.days}
                      onChange={(e) => {
                        const v = intInRange(e.target.value, RETENTION_DAYS_MIN, RETENTION_DAYS_MAX);
                        if (v !== null) set('mediaRetention', retentionValue('days', v));
                      }}
                    />
                    {tm('retentionDays')}
                  </label>
                ) : null}
              </div>
            </FieldRow>
          </div>
        </div>

        <FieldRow label={CD_TEXT.logo} hint={CD_TEXT.logoHint} view={view} own={own} field="logoUrl" onInherit={() => set('logoUrl', undefined)}>
          <div className="flex flex-wrap items-center gap-2">
            {eff.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={eff.logoUrl} alt="" className="h-10 max-w-32 rounded bg-muted object-contain" />
            ) : null}
            <input
              ref={setLogoInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (f) void uploadLogo(f);
              }}
            />
            <Button type="button" variant="outline" size="sm" disabled={uploading} onClick={() => logoInput?.click()}>
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
