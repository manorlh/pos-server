'use client';

/**
 * "מסך לקוח" — the slideshow, with its transitions (P:/specs/customer-display-transitions.md §1, §3):
 * the browser display (`/display`) and the dashboard's live preview play the same engine.
 *
 * Two layers at most, stacked: the slide shown, and the next one, loaded ahead and ready before its
 * transition starts — an image decoded, a video played and paused on its first frame — so going
 * from an image to a video and back never shows black. The transitions, Ken Burns, a video played
 * to its end, the shuffled order and the calm fallback are lib/customerDisplayPlayer.ts's rules,
 * played here with the Web Animations API (none: a cut). A slide that does not load is skipped.
 *
 * Imperative on purpose: React renders the stage once; the engine adds and removes the layers.
 */

import { useEffect, useRef } from 'react';
import {
  EASING,
  LOAD_TIMEOUT_MS,
  calmMotion,
  cursorIndex,
  kenBurnsFrames,
  nextCursor,
  slideTiming,
  startCursor,
  transitionFor,
  transitionFrames,
  videoWatchdogMs,
  type Cursor,
  type Frame,
  type MotionConfig,
  type PlayerSlide,
  type ReadingDir,
  type Rng,
} from '@/lib/customerDisplayPlayer';
import { cn } from '@/lib/utils';

/** Nothing loads at all (offline, every file gone): tried again after this. */
const RETRY_MS = 10_000;
/** How long a loaded slide may take to decode its first frame before it is shown anyway. */
const DECODE_WAIT_MS = 2_000;

export interface EngineOptions {
  slides: PlayerSlide[];
  motion: MotionConfig;
  /** Less motion asked, or a slow device: a short fade, no Ken Burns. */
  calm: boolean;
  dir: ReadingDir;
  fit: 'contain' | 'cover';
  /** The source to load (the browser display's kept copy); the URL itself by default. */
  resolveSrc?: (slide: PlayerSlide) => Promise<string> | string;
  releaseSrc?: (src: string) => void;
  rng?: Rng;
  /** The slide now coming in (its index in `slides`). */
  onSlide?: (index: number) => void;
}

interface Layer {
  index: number;
  slide: PlayerSlide;
  wrap: HTMLDivElement;
  media: HTMLImageElement | HTMLVideoElement;
  src: string;
}

function animate(el: Element, frames: Frame[], options: KeyframeAnimationOptions): Animation | null {
  if (typeof (el as HTMLElement).animate !== 'function') return null;
  try {
    return (el as HTMLElement).animate(frames as Keyframe[], options);
  } catch {
    return null;
  }
}

function waitFor(target: EventTarget, ok: string[], bad: string[], ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const done = (v: boolean) => {
      clearTimeout(timer);
      ok.forEach((e) => target.removeEventListener(e, yes));
      bad.forEach((e) => target.removeEventListener(e, no));
      resolve(v);
    };
    const yes = () => done(true);
    const no = () => done(false);
    const timer = setTimeout(() => done(false), ms);
    ok.forEach((e) => target.addEventListener(e, yes));
    bad.forEach((e) => target.addEventListener(e, no));
  });
}

export class SlideshowEngine {
  private readonly motion: MotionConfig;
  private readonly rng: Rng;
  private cursor: Cursor;
  private current: Layer | null = null;
  private next: { cursor: Cursor; layer: Promise<Layer | null> } | null = null;
  private slideTimers: ReturnType<typeof setTimeout>[] = [];
  private retry: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private advancing = false;
  private shown = 0;
  private readonly unbind: (() => void)[] = [];

  constructor(private readonly host: HTMLElement, private readonly o: EngineOptions) {
    this.motion = calmMotion(o.motion, o.calm);
    this.rng = o.rng ?? Math.random;
    this.cursor = startCursor(o.slides.length, this.motion.shuffle, this.rng);
  }

  start(): void {
    if (!this.o.slides.length) return;
    void this.showFirst();
  }

  stop(): void {
    this.stopped = true;
    this.clearSlideTimers();
    if (this.retry) clearTimeout(this.retry);
    this.unbind.splice(0).forEach((f) => f());
    if (this.current) this.drop(this.current);
    this.current = null;
    const pending = this.next;
    this.next = null;
    void pending?.layer.then((l) => l && this.drop(l));
  }

  private clearSlideTimers() {
    this.slideTimers.splice(0).forEach((t) => clearTimeout(t));
  }

  private drop(layer: Layer) {
    if (layer.media instanceof HTMLVideoElement) {
      layer.media.pause();
      layer.media.removeAttribute('src');
      try {
        layer.media.load();
      } catch {
        /* nothing to release */
      }
    }
    layer.wrap.remove();
    this.o.releaseSrc?.(layer.src);
  }

  /** A slide's layer, hidden, its first frame ready; null when it does not load. */
  private async load(index: number): Promise<Layer | null> {
    const slide = this.o.slides[index];
    if (!slide) return null;
    let src = slide.url;
    try {
      src = (await this.o.resolveSrc?.(slide)) ?? slide.url;
    } catch {
      src = slide.url;
    }
    if (this.stopped) {
      this.o.releaseSrc?.(src);
      return null;
    }
    const wrap = document.createElement('div');
    Object.assign(wrap.style, {
      position: 'absolute',
      inset: '0',
      overflow: 'hidden',
      opacity: '0',
      zIndex: '0',
      pointerEvents: 'none',
      willChange: 'opacity, transform',
    });
    const fill = { width: '100%', height: '100%', objectFit: this.o.fit, display: 'block' };
    let media: HTMLImageElement | HTMLVideoElement;
    let ready: Promise<boolean>;
    if (slide.kind === 'image') {
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      img.draggable = false;
      Object.assign(img.style, fill, { transformOrigin: 'center center' });
      img.src = src;
      media = img;
      wrap.appendChild(img);
      this.host.appendChild(wrap);
      // Loaded, then decoded ahead when the browser can (a page not being painted may never
      // finish `decode()`: loaded is enough then).
      ready = (img.complete && img.naturalWidth > 0 ? Promise.resolve(true) : waitFor(img, ['load'], ['error'], LOAD_TIMEOUT_MS)).then(async (ok) => {
        if (!ok) return false;
        if (typeof img.decode === 'function') {
          await Promise.race([img.decode().catch(() => undefined), new Promise((r) => setTimeout(r, DECODE_WAIT_MS))]);
        }
        return img.naturalWidth > 0;
      });
    } else {
      const video = document.createElement('video');
      video.muted = true;
      video.defaultMuted = true;
      video.playsInline = true;
      video.setAttribute('muted', '');
      video.setAttribute('playsinline', '');
      video.preload = 'auto';
      video.loop = this.o.slides.length === 1;
      Object.assign(video.style, fill);
      video.src = src;
      media = video;
      wrap.appendChild(video);
      this.host.appendChild(wrap);
      ready = (video.readyState >= 2 ? Promise.resolve(true) : waitFor(video, ['loadeddata'], ['error'], LOAD_TIMEOUT_MS)).then(async (ok) => {
        if (!ok) return false;
        // Played and paused on the first frame: decoded and painted before its transition starts.
        try {
          await video.play();
        } catch {
          /* autoplay refused: the frame loaded is still shown */
        }
        video.pause();
        if (video.currentTime > 0.05) {
          // Back to its start, and wait for that frame (seeking drops it until done).
          const seeked = waitFor(video, ['seeked'], ['error'], DECODE_WAIT_MS);
          try {
            video.currentTime = 0;
            await seeked;
          } catch {
            /* not seekable: it starts a few frames in */
          }
        }
        return video.readyState >= 2;
      });
    }
    const layer: Layer = { index, slide, wrap, media, src };
    if (!(await ready) || this.stopped) {
      this.drop(layer);
      return null;
    }
    return layer;
  }

  private async showFirst() {
    const n = this.o.slides.length;
    let layer: Layer | null = null;
    for (let tries = 0; tries < n && !layer && !this.stopped; tries++) {
      layer = await this.load(cursorIndex(this.cursor));
      if (!layer) this.cursor = nextCursor(this.cursor, n, this.motion.shuffle, this.rng);
    }
    if (this.stopped) {
      if (layer) this.drop(layer);
      return;
    }
    if (!layer) {
      this.retry = setTimeout(() => void this.showFirst(), RETRY_MS);
      return;
    }
    layer.wrap.style.opacity = '1';
    layer.wrap.style.zIndex = '1';
    this.current = layer;
    this.play(layer);
  }

  /** The slide starts: its video plays, its Ken Burns runs, its end is set and the next one loaded. */
  private play(layer: Layer) {
    this.o.onSlide?.(layer.index);
    const single = this.o.slides.length === 1;
    const { media, slide } = layer;
    if (media instanceof HTMLVideoElement) {
      media.play().catch(() => undefined);
    } else if (this.motion.kenBurns) {
      const showMs = slide.durationSec * 1000 + this.motion.transitionMs;
      animate(media, kenBurnsFrames(this.shown), single
        ? { duration: Math.max(8000, showMs), easing: 'linear', iterations: Infinity, direction: 'alternate' }
        : { duration: showMs, easing: 'linear', fill: 'forwards' });
    }
    this.shown += 1;
    if (single) return;
    const timing = slideTiming(slide, this.motion);
    if (timing.advance === 'timer') {
      this.slideTimers.push(setTimeout(() => void this.advance(), timing.ms ?? 8000));
    } else if (media instanceof HTMLVideoElement) {
      const onEnd = () => void this.advance();
      media.addEventListener('ended', onEnd, { once: true });
      media.addEventListener('error', onEnd, { once: true });
      this.unbind.push(() => {
        media.removeEventListener('ended', onEnd);
        media.removeEventListener('error', onEnd);
      });
      this.slideTimers.push(setTimeout(() => void this.advance(), videoWatchdogMs(media.duration)));
    }
    const upcoming = nextCursor(this.cursor, this.o.slides.length, this.motion.shuffle, this.rng);
    this.next = { cursor: upcoming, layer: this.load(cursorIndex(upcoming)) };
  }

  private async advance() {
    if (this.advancing || this.stopped || !this.current) return;
    this.advancing = true;
    this.clearSlideTimers();
    this.unbind.splice(0).forEach((f) => f());
    const n = this.o.slides.length;
    let layer: Layer | null = null;
    let at = this.cursor;
    for (let tries = 0; tries < n && !layer && !this.stopped; tries++) {
      const pending = this.next ?? (() => {
        const c = nextCursor(at, n, this.motion.shuffle, this.rng);
        return { cursor: c, layer: this.load(cursorIndex(c)) };
      })();
      this.next = null;
      layer = await pending.layer;
      at = pending.cursor;
    }
    if (this.stopped) {
      if (layer) this.drop(layer);
      return;
    }
    if (!layer) {
      // Nothing else loads: the slide shown stays; tried again in a while.
      this.advancing = false;
      this.slideTimers.push(setTimeout(() => void this.advance(), RETRY_MS));
      return;
    }
    this.cursor = at;
    const old = this.current;
    const { kind, ms } = transitionFor(layer.slide, this.motion, this.o.calm);
    old.wrap.style.zIndex = '1';
    layer.wrap.style.zIndex = '2';
    layer.wrap.style.opacity = '1';
    this.current = layer;
    this.play(layer);
    if (ms > 0) {
      const frames = transitionFrames(kind, this.o.dir);
      const enter = animate(layer.wrap, frames.enter, { duration: ms, easing: EASING, fill: 'both' });
      animate(old.wrap, frames.leave, { duration: ms, easing: EASING, fill: 'both' });
      await Promise.race([
        enter?.finished.catch(() => undefined) ?? Promise.resolve(),
        new Promise((r) => setTimeout(r, ms + 250)),
      ]);
      try {
        enter?.commitStyles();
        enter?.cancel();
      } catch {
        /* an element already gone */
      }
    }
    this.drop(old);
    layer.wrap.style.zIndex = '1';
    this.advancing = false;
  }
}

/** The stage: the engine restarts whenever what it plays changes. */
export function SlideshowPlayer({
  slides,
  motion,
  calm = false,
  dir,
  fit = 'contain',
  resolveSrc,
  releaseSrc,
  onSlide,
  className,
  restartKey,
}: {
  slides: PlayerSlide[];
  motion: MotionConfig;
  calm?: boolean;
  dir: ReadingDir;
  fit?: 'contain' | 'cover';
  resolveSrc?: EngineOptions['resolveSrc'];
  releaseSrc?: EngineOptions['releaseSrc'];
  onSlide?: (index: number) => void;
  className?: string;
  /** Anything else that should restart the slideshow (the preview's "מההתחלה"). */
  restartKey?: number | string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ resolveSrc, releaseSrc, onSlide });
  useEffect(() => {
    callbacks.current = { resolveSrc, releaseSrc, onSlide };
  }, [resolveSrc, releaseSrc, onSlide]);
  const key = JSON.stringify({ slides, motion, calm, dir, fit, restartKey });
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const spec = JSON.parse(key) as { slides: PlayerSlide[]; motion: MotionConfig; calm: boolean; dir: ReadingDir; fit: 'contain' | 'cover' };
    const engine = new SlideshowEngine(el, {
      ...spec,
      resolveSrc: (s) => callbacks.current.resolveSrc?.(s) ?? s.url,
      releaseSrc: (src) => callbacks.current.releaseSrc?.(src),
      onSlide: (i) => callbacks.current.onSlide?.(i),
    });
    engine.start();
    return () => engine.stop();
  }, [key]);
  return <div ref={host} aria-hidden className={cn('relative h-full w-full overflow-hidden', className)} />;
}
