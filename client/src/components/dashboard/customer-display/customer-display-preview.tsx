'use client';

/**
 * "מסך לקוח" — the live preview of the slideshow (P:/specs/customer-display-transitions.md §2): the
 * layer's playlist as edited (saved or not) played by the display's own engine
 * (components/customer-display-web/slideshow-player.tsx), with its transitions, Ken Burns, videos to
 * their end and shuffle, in the screen's reading direction. "כמו במכשיר חלש" shows the calm
 * fallback (a short fade, no Ken Burns); it starts as this computer's "reduce motion" setting.
 */

import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { RotateCcw } from 'lucide-react';
import { screenLang, type CdConfig } from '@/lib/customerDisplay';
import { motionOf, playableSlides } from '@/lib/customerDisplayPlayer';
import { SlideshowPlayer } from '@/components/customer-display-web/slideshow-player';
import { usePrefersReducedMotion } from '@/components/dashboard/kiosks/preview-ticker';
import { Button } from '@/components/ui/button';

export function CustomerDisplayPreview({ config, onSlide }: { config: CdConfig; onSlide?: (url: string | null) => void }) {
  const t = useTranslations('customerDisplayMotion');
  const systemCalm = usePrefersReducedMotion();
  const [calmChoice, setCalmChoice] = useState<boolean | null>(null);
  const calm = calmChoice ?? systemCalm;
  const [restart, setRestart] = useState(0);
  const [now, setNow] = useState(-1);
  const slides = useMemo(() => playableSlides(config.playlist), [config.playlist]);
  const motion = useMemo(
    () => motionOf({ transition: config.transition, transitionMs: config.transitionMs, kenBurns: config.kenBurns, videoUntilEnd: config.videoUntilEnd, shuffle: config.shuffle }),
    [config.transition, config.transitionMs, config.kenBurns, config.videoUntilEnd, config.shuffle],
  );
  const dir = screenLang(config.language, 'he') === 'en' ? 'ltr' : 'rtl';
  const background = config.theme === 'light' ? '#f7f7f8' : '#0d1016';
  const showing = useCallback(
    (i: number) => {
      setNow(i);
      onSlide?.(slides[i]?.url ?? null);
    },
    [onSlide, slides],
  );

  return (
    <div className="space-y-2">
      <div className="relative aspect-video w-full max-w-xl overflow-hidden rounded-lg border" style={{ background }}>
        {slides.length ? (
          <SlideshowPlayer slides={slides} motion={motion} calm={calm} dir={dir} restartKey={restart} onSlide={showing} />
        ) : (
          <div className="flex h-full items-center justify-center p-4 text-center text-sm text-white/70">{t('previewEmpty')}</div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-3 text-xs">
        <Button type="button" variant="outline" size="sm" disabled={!slides.length} onClick={() => setRestart((n) => n + 1)}>
          <RotateCcw className="me-1 h-4 w-4" />
          {t('previewRestart')}
        </Button>
        <label className="flex items-center gap-2">
          <input type="checkbox" className="h-4 w-4 accent-primary" checked={calm} onChange={(e) => setCalmChoice(e.target.checked)} />
          {t('previewCalm')}
        </label>
        {slides.length && now >= 0 ? <span className="text-muted-foreground">{t('previewNow', { n: now + 1, total: slides.length })}</span> : null}
      </div>
    </div>
  );
}
