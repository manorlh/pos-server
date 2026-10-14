/**
 * "מסך לקוח" — the slideshow's motion (P:/specs/customer-display-transitions.md §1, §5.1): how one
 * slide gives way to the next, Ken Burns, a video played to its end, a shuffled order, and what a
 * device asking for less motion (or too slow to animate) plays instead. The rules the browser
 * display (`/display`), the dashboard's live preview and the Android screens all follow:
 *
 *  - `fade`: the next slide comes in over the one shown (opacity 0→1), which stays whole beneath —
 *    never through black; `dissolve`: the same, softened by a blur in and out; `zoom`: the next one
 *    settles in from 1.08, the one shown recedes to 0.96; `slide`: the next one pushes in from the
 *    end of the reading direction (in Hebrew from the left), the one shown leaves toward its start;
 *    `none`: a cut. ease-in-out over `transitionMs`; a slide's own `transition` wins.
 *  - less motion / a slow device: a fade of at most REDUCED_FADE_MS (`none` stays a cut), no Ken Burns.
 *  - Ken Burns (images only): scale 1→1.08 with a slight drift, its direction changing slide by slide,
 *    over the slide's time and the transition out.
 *  - `videoUntilEnd`: a video moves on at its end (a watchdog: its length + 5 s, 10 minutes when its
 *    length is unknown); off, it is cut at `durationSec`.
 *  - `shuffle`: a new random order every round, never starting with the slide that ended the last.
 *  - one slide: no transition; a video loops.
 *
 * Pure (no DOM, no React) and self-contained: `npm test` compiles it on its own.
 */

export const TRANSITIONS = ['fade', 'slide', 'zoom', 'dissolve', 'none'] as const;
export type CdTransition = (typeof TRANSITIONS)[number];

export const TRANSITION_MS_MIN = 200;
export const TRANSITION_MS_MAX = 2000;
export const TRANSITION_MS_DEFAULT = 600;
/** Less motion, or a slow device: a fade this short at most. */
export const REDUCED_FADE_MS = 300;
export const KEN_BURNS_SCALE = 1.08;
export const VIDEO_WATCHDOG_SLACK_MS = 5_000;
export const VIDEO_WATCHDOG_UNKNOWN_MS = 10 * 60_000;
/** How long a slide may take to load (its first frame ready) before it is skipped. */
export const LOAD_TIMEOUT_MS = 20_000;
export const EASING = 'ease-in-out';

export interface MotionConfig {
  transition: CdTransition;
  transitionMs: number;
  kenBurns: boolean;
  videoUntilEnd: boolean;
  shuffle: boolean;
}

export const MOTION_DEFAULTS: MotionConfig = {
  transition: 'fade',
  transitionMs: TRANSITION_MS_DEFAULT,
  kenBurns: true,
  videoUntilEnd: true,
  shuffle: false,
};

export interface PlayerSlide {
  url: string;
  kind: 'image' | 'video';
  durationSec: number;
  transition?: CdTransition;
  sha256?: string;
}

export type ReadingDir = 'rtl' | 'ltr';
export type Frame = Record<string, string | number>;
export type Rng = () => number;

export function isTransition(v: unknown): v is CdTransition {
  return typeof v === 'string' && (TRANSITIONS as readonly string[]).includes(v);
}

/** The motion from a configuration, safe to play: anything unknown (a newer cloud) is the default. */
export function motionOf(raw: unknown): MotionConfig {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const ms = typeof o.transitionMs === 'number' && Number.isFinite(o.transitionMs) ? Math.round(o.transitionMs) : TRANSITION_MS_DEFAULT;
  return {
    transition: isTransition(o.transition) ? o.transition : MOTION_DEFAULTS.transition,
    transitionMs: Math.min(TRANSITION_MS_MAX, Math.max(TRANSITION_MS_MIN, ms)),
    kenBurns: typeof o.kenBurns === 'boolean' ? o.kenBurns : MOTION_DEFAULTS.kenBurns,
    videoUntilEnd: typeof o.videoUntilEnd === 'boolean' ? o.videoUntilEnd : MOTION_DEFAULTS.videoUntilEnd,
    shuffle: typeof o.shuffle === 'boolean' ? o.shuffle : MOTION_DEFAULTS.shuffle,
  };
}

/** The slides that can be played: a URL, a kind, a duration (a file still being processed has no URL). */
export function playableSlides(list: unknown): PlayerSlide[] {
  if (!Array.isArray(list)) return [];
  const out: PlayerSlide[] = [];
  for (const raw of list) {
    if (!raw || typeof raw !== 'object') continue;
    const o = raw as Record<string, unknown>;
    if (typeof o.url !== 'string' || !o.url || (o.kind !== 'image' && o.kind !== 'video')) continue;
    const d = typeof o.durationSec === 'number' && Number.isFinite(o.durationSec) && o.durationSec > 0 ? o.durationSec : 8;
    out.push({
      url: o.url,
      kind: o.kind,
      durationSec: d,
      ...(isTransition(o.transition) ? { transition: o.transition } : {}),
      ...(typeof o.sha256 === 'string' ? { sha256: o.sha256 } : {}),
    });
  }
  return out;
}

/** "Calm": the device asks for less motion, or is too slow to animate. */
export function calmMotion(motion: MotionConfig, calm: boolean): MotionConfig {
  if (!calm) return motion;
  return {
    ...motion,
    transition: motion.transition === 'none' ? 'none' : 'fade',
    transitionMs: Math.min(motion.transitionMs, REDUCED_FADE_MS),
    kenBurns: false,
  };
}

/** How [slide] comes in: its own transition or the global one; calm, a short fade; a cut takes no time. */
export function transitionFor(slide: Pick<PlayerSlide, 'transition'>, motion: MotionConfig, calm = false): { kind: CdTransition; ms: number } {
  let kind: CdTransition = slide.transition && isTransition(slide.transition) ? slide.transition : motion.transition;
  let ms = motion.transitionMs;
  if (calm && kind !== 'none') {
    kind = 'fade';
    ms = Math.min(ms, REDUCED_FADE_MS);
  }
  return { kind, ms: kind === 'none' ? 0 : ms };
}

/** The keyframes of the slide coming in and of the one going out (the one coming in is on top). */
export function transitionFrames(kind: CdTransition, dir: ReadingDir): { enter: Frame[]; leave: Frame[] } {
  switch (kind) {
    case 'fade':
      return { enter: [{ opacity: 0 }, { opacity: 1 }], leave: [{ opacity: 1 }, { opacity: 1 }] };
    case 'dissolve':
      return {
        enter: [{ opacity: 0, filter: 'blur(12px)' }, { opacity: 1, filter: 'blur(0px)' }],
        leave: [{ opacity: 1, filter: 'blur(0px)' }, { opacity: 1, filter: 'blur(12px)' }],
      };
    case 'zoom':
      return {
        enter: [{ opacity: 0, transform: `scale(${KEN_BURNS_SCALE})` }, { opacity: 1, transform: 'scale(1)' }],
        leave: [{ opacity: 1, transform: 'scale(1)' }, { opacity: 1, transform: 'scale(0.96)' }],
      };
    case 'slide': {
      // The next slide is at the end of the reading direction: on the left in Hebrew.
      const from = dir === 'rtl' ? '-100%' : '100%';
      const to = dir === 'rtl' ? '100%' : '-100%';
      return {
        enter: [{ transform: `translateX(${from})` }, { transform: 'translateX(0%)' }],
        leave: [{ transform: 'translateX(0%)' }, { transform: `translateX(${to})` }],
      };
    }
    default:
      return { enter: [{ opacity: 1 }, { opacity: 1 }], leave: [{ opacity: 1 }, { opacity: 1 }] };
  }
}

const DRIFTS: readonly [number, number][] = [
  [-1.5, -1],
  [1.5, -1],
  [-1.5, 1],
  [1.5, 1],
];

/** Ken Burns on the [index]th slide shown: closing in, drifting a little, a different way each time. */
export function kenBurnsFrames(index: number): Frame[] {
  const [dx, dy] = DRIFTS[((index % DRIFTS.length) + DRIFTS.length) % DRIFTS.length];
  return [
    { transform: 'scale(1) translate(0%, 0%)' },
    { transform: `scale(${KEN_BURNS_SCALE}) translate(${dx}%, ${dy}%)` },
  ];
}

/**
 * When a slide moves on: an image (and a video with `videoUntilEnd` off) after its `durationSec`;
 * a video with `videoUntilEnd` on at its end (`ended`), with a watchdog (`videoWatchdogMs`).
 */
export function slideTiming(slide: Pick<PlayerSlide, 'kind' | 'durationSec'>, motion: Pick<MotionConfig, 'videoUntilEnd'>): { advance: 'timer' | 'ended'; ms: number | null } {
  if (slide.kind === 'video' && motion.videoUntilEnd) return { advance: 'ended', ms: null };
  return { advance: 'timer', ms: Math.max(1, slide.durationSec) * 1000 };
}

/** A video played to its end that never says so (a stalled stream): moved on after this. */
export function videoWatchdogMs(mediaDurationSec: number | null | undefined): number {
  return typeof mediaDurationSec === 'number' && Number.isFinite(mediaDurationSec) && mediaDurationSec > 0
    ? Math.ceil(mediaDurationSec * 1000) + VIDEO_WATCHDOG_SLACK_MS
    : VIDEO_WATCHDOG_UNKNOWN_MS;
}

/** How long one slide is on screen in a round, in seconds (a video to its end: its length when known). */
export function slideSeconds(slide: Pick<PlayerSlide, 'kind' | 'durationSec'>, videoUntilEnd: boolean, videoLengthSec?: number | null): number {
  if (slide.kind === 'video' && videoUntilEnd && typeof videoLengthSec === 'number' && Number.isFinite(videoLengthSec) && videoLengthSec > 0) {
    return Math.round(videoLengthSec);
  }
  return slide.durationSec;
}

/* ------------------------------------------------------------------ the order */

/** 0…n-1 shuffled (Fisher–Yates); never starting with [avoidFirst] when there is another choice. */
export function shuffled(n: number, rng: Rng, avoidFirst?: number): number[] {
  const out = Array.from({ length: Math.max(0, n) }, (_, i) => i);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)));
    [out[i], out[j]] = [out[j], out[i]];
  }
  if (avoidFirst !== undefined && out.length > 1 && out[0] === avoidFirst) [out[0], out[1]] = [out[1], out[0]];
  return out;
}

/** One round's order: as listed, or shuffled. */
export function roundOrder(n: number, shuffle: boolean, rng: Rng, last?: number): number[] {
  return shuffle ? shuffled(n, rng, last) : Array.from({ length: Math.max(0, n) }, (_, i) => i);
}

export interface Cursor {
  order: number[];
  pos: number;
}

export function startCursor(n: number, shuffle: boolean, rng: Rng): Cursor {
  return { order: roundOrder(n, shuffle, rng), pos: 0 };
}

/** The slide shown: its index in the playlist (-1 when there is none). */
export function cursorIndex(c: Cursor): number {
  return c.order.length ? c.order[Math.min(c.pos, c.order.length - 1)] : -1;
}

/** The next slide: on in this round, else a new round (a new order when shuffled). */
export function nextCursor(c: Cursor, n: number, shuffle: boolean, rng: Rng): Cursor {
  if (n <= 0) return { order: [], pos: 0 };
  if (c.order.length === n && c.pos + 1 < n) return { order: c.order, pos: c.pos + 1 };
  return { order: roundOrder(n, shuffle, rng, cursorIndex(c)), pos: 0 };
}
