'use client';

import { useTranslations } from 'next-intl';
import { Film, Image as ImageIcon, Plus, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ATTRACT_SECTIONS, KIOSK_LIMITS, moveItem, type AttractSection, type PlaylistItem } from '@/lib/kioskConfig';
import { useKioskEditor, useKioskField } from './editor-context';
import { FieldErrors, FieldShell, MediaThumb, MoveButtons, NumberInput, OrderedPick, SectionCard, SwitchField, useMediaUpload } from './fields';

function Playlist() {
  const t = useTranslations('kiosks.attract');
  const tf = useTranslations('kiosks.fields');
  const { canUpload, draft } = useKioskEditor();
  const f = useKioskField<PlaylistItem[]>('attract.playlist');
  const list = Array.isArray(f.value) ? f.value : [];
  const full = list.length >= KIOSK_LIMITS.playlistMax;
  const up = useMediaUpload(
    (media) => f.set([...list, { media, durationSec: draft.timers.attractSlideSec || 8 }]),
    true,
  );

  return (
    <FieldShell path="attract.playlist" label={tf('attract.playlist')} hint={t('playlistHint')}>
      <div className="space-y-2">
        {list.length === 0 ? (
          <p className="rounded-xl border border-dashed p-4 text-center text-sm text-muted-foreground">{t('playlistEmpty')}</p>
        ) : (
          <ol className="space-y-2">
            {list.map((item, i) => (
              <li
                key={`${item.media.url}-${i}`}
                className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-2 transition-shadow hover:shadow-sm"
              >
                <MediaThumb media={item.media} className="h-14 w-24" />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    {item.media.kind === 'video' ? <Film className="h-3.5 w-3.5" /> : <ImageIcon className="h-3.5 w-3.5" />}
                    <span className="tabular-nums">#{i + 1}</span>
                    {item.media.kind === 'video' ? <Badge variant="outline">{t('videoPlaysToEnd')}</Badge> : null}
                  </div>
                  <NumberInput
                    value={item.durationSec}
                    min={KIOSK_LIMITS.playlistDuration.min}
                    max={KIOSK_LIMITS.playlistDuration.max}
                    disabled={f.disabled}
                    suffix={t('duration')}
                    ariaLabel={t('duration')}
                    onChange={(n) => f.set(list.map((x, j) => (j === i ? { ...x, durationSec: n } : x)))}
                  />
                  <FieldErrors path={`attract.playlist.${i}`} />
                </div>
                <MoveButtons index={i} count={list.length} disabled={f.disabled} onMove={(d) => f.set(moveItem(list, i, d))} />
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  className="text-destructive"
                  aria-label={t('remove')}
                  disabled={f.disabled}
                  onClick={() => f.set(list.filter((_, j) => j !== i))}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ol>
        )}
        {up.input}
        <div className="flex items-center gap-2">
          <Button type="button" size="sm" variant="outline" disabled={f.disabled || !canUpload || full || up.uploading} onClick={up.open}>
            <Plus /> {up.uploading ? t('uploading') : t('addMedia')}
          </Button>
          {full ? <span className="text-xs text-muted-foreground">{t('playlistFull', { max: KIOSK_LIMITS.playlistMax })}</span> : null}
        </div>
      </div>
    </FieldShell>
  );
}

export function AttractSectionEditor() {
  const t = useTranslations('kiosks.attract');
  const tf = useTranslations('kiosks.fields');
  return (
    <div className="space-y-4">
      <SectionCard title={t('sectionsTitle')} description={t('sectionsHint')} paths={['attract.sections']}>
        <FieldShell path="attract.sections" label={tf('attract.sections')}>
          <OrderedPick<AttractSection> path="attract.sections" all={ATTRACT_SECTIONS} label={(v) => t(`section.${v}`)} />
        </FieldShell>
      </SectionCard>
      <SectionCard title={t('playlistTitle')} paths={['attract.playlist']}>
        <Playlist />
      </SectionCard>
      <SectionCard title={t('optionsTitle')} paths={['attract.videoMuted', 'attract.showHelp']}>
        <SwitchField path="attract.videoMuted" label={tf('attract.videoMuted')} />
        <SwitchField path="attract.showHelp" label={tf('attract.showHelp')} hint={t('showHelpHint')} />
      </SectionCard>
    </div>
  );
}
