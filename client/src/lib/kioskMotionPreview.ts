/**
 * "הצג" of the Motion Engine's management screen (spec §10): one event, as the kiosk plays it
 * (a ResolvedMotion from lib/kioskMotionEngine.ts), turned into Web Animations tracks for a small
 * sample stage — a product card, a button, the basket's badge, a price, a screen — so the manager
 * sees the kind, the duration, the delay, the curve, the direction, the intensity, the scales, the
 * distance, the repeats (0 = a loop, shown for a few cycles), the gap between them and the hold,
 * without making an order. The stage (motion-preview-stage.tsx) renders an element per role of its
 * scene (`data-role`) and calls `element.animate(frames, timing)` for every track.
 *
 * Pure and self-contained (relative imports only).
 */

import {
  SOLD_OUT_ALPHA,
  motionCurve,
  type MotionDirection,
  type MotionEventKey,
  type MotionType,
  type ResolvedMotion,
} from './kioskMotionEngine';

/** The sample each event plays on. */
export type MotionScene =
  | 'card'
  | 'addCart'
  | 'badge'
  | 'toast'
  | 'sheet'
  | 'dialog'
  | 'options'
  | 'choice'
  | 'stepper'
  | 'price'
  | 'grid'
  | 'screen'
  | 'list'
  | 'button'
  | 'field'
  | 'progress'
  | 'check'
  | 'attract'
  | 'skeleton'
  | 'scroll';

export const MOTION_SCENES: Record<MotionEventKey, MotionScene> = {
  productPress: 'card',
  addToCart: 'addCart',
  cartBadge: 'badge',
  toast: 'toast',
  modalOpen: 'sheet',
  select: 'options',
  quantityChange: 'stepper',
  priceChange: 'price',
  categorySwitch: 'screen',
  itemsEnter: 'grid',
  cartOpen: 'sheet',
  remove: 'list',
  continueReady: 'button',
  error: 'field',
  serviceChoice: 'choice',
  upsell: 'sheet',
  pageTransition: 'screen',
  payment: 'button',
  paymentProgress: 'progress',
  success: 'check',
  idle: 'attract',
  timeout: 'dialog',
  soldOut: 'card',
  loading: 'skeleton',
  scrollHint: 'scroll',
  homeReturn: 'screen',
};

export const CONFETTI_PIECES = 14;
const CONFETTI_ROLES = Array.from({ length: CONFETTI_PIECES }, (_, i) => `confetti-${i}`);

/** The elements (`data-role`) each scene draws; a track only ever names one of its scene's. */
export const SCENE_ROLES: Record<MotionScene, readonly string[]> = {
  card: ['target', 'ripple', 'soldBadge'],
  addCart: ['target', 'ghost', 'cart', 'badge', 'added'],
  badge: ['target', 'cart'],
  toast: ['target'],
  sheet: ['base', 'source', 'backdrop', 'target'],
  dialog: ['backdrop', 'target', 'number', 'ring'],
  options: ['target', 'ripple'],
  choice: ['target', 'other', 'ripple', 'advance'],
  stepper: ['target', 'number'],
  price: ['target', 'number'],
  grid: ['card-0', 'card-1', 'card-2'],
  screen: ['screenA', 'screenB'],
  list: ['target', 'undo'],
  button: ['target', 'fill'],
  field: ['target', 'message'],
  progress: ['target', 'bar', 'shimmer'],
  check: ['target', 'checkPath', 'orderNo', ...CONFETTI_ROLES],
  attract: ['layerBack', 'layerMid', 'target'],
  skeleton: ['target', 'shimmer'],
  scroll: ['target'],
};

/** The numbers a scene counts between (countUp, countDown): its "before" and "after". */
export const SCENE_NUMBERS: Partial<Record<MotionScene, { from: number; to: number; decimals: number }>> = {
  price: { from: 42.9, to: 46.9, decimals: 2 },
  stepper: { from: 2, to: 3, decimals: 0 },
  dialog: { from: 5, to: 0, decimals: 0 },
};

/** A loop (repeat 0) plays this many cycles in the preview; a long repeat at most MAX. */
export const LOOP_PREVIEW_CYCLES = 3;
export const MAX_PREVIEW_CYCLES = 6;
/** The final state stays at most this long before the stage resets (Undo's 4 s is long). */
export const MAX_PREVIEW_HOLD_MS = 2500;
/** The stage is a small kiosk: a distance of the kiosk's is half as long here. */
export const STAGE_SCALE = 0.5;
/** The basket's lines in the "list" scene (remove): height and gap, px. */
export const PREVIEW_ROW_H = 26;
export const PREVIEW_ROW_GAP = 4;

export type MotionFill = 'none' | 'backwards' | 'forwards' | 'both';
/** A keyframe (CSS properties in camelCase, an optional offset / easing). */
export type MotionFrame = Record<string, string | number>;

export interface MotionTrack {
  role: string;
  frames: MotionFrame[];
  delay: number;
  duration: number;
  easing: string;
  fill: MotionFill;
}

/** A number counting from → to over the track's time (countUp, countDown). */
export interface MotionCounter {
  role: string;
  from: number;
  to: number;
  decimals: number;
  delay: number;
  duration: number;
  easing: string;
}

export interface MotionPlan {
  tracks: MotionTrack[];
  counters: MotionCounter[];
  /** When the last track ends, ms from the press. */
  endMs: number;
  /** How long the final state stays before the stage resets. */
  holdMs: number;
  /** The iterations shown. */
  cycles: number;
  /** repeat 0: a loop for as long as its state lasts (the preview shows LOOP_PREVIEW_CYCLES). */
  loop: boolean;
  /** More repeats than the preview shows. */
  truncated: boolean;
  /** When the stage's content takes its "after" state (the badge's count, the new quantity…). */
  swapAtMs: number;
}

/** Measured on the stage before playing: the fly from the dish to the basket. */
export interface MotionStageGeometry {
  flyDx: number;
  flyDy: number;
}

const STANDARD = 'cubic-bezier(.3,0,.2,1)';
const DECEL = 'cubic-bezier(.2,.7,.2,1)';
const ACCEL = 'cubic-bezier(.4,0,1,1)';
const IN_OUT = 'cubic-bezier(.45,0,.55,1)';
const OVERSHOOT = 'cubic-bezier(.34,1.56,.64,1)';
const EASE_OUT = 'cubic-bezier(.2,.7,.3,1)';
const EASE_IN = 'cubic-bezier(.5,0,.8,.3)';

/** Each kind's own curve ("auto"). */
const KIND_CURVES: Partial<Record<MotionType, string>> = {
  slideIn: DECEL,
  fadeIn: DECEL,
  fadeScale: DECEL,
  expand: DECEL,
  morph: DECEL,
  staggeredEntry: DECEL,
  successZoom: DECEL,
  slideOut: ACCEL,
  fadeOut: ACCEL,
  collapse: ACCEL,
  pulse: IN_OUT,
  floating: IN_OUT,
  parallaxLight: IN_OUT,
  attentionArrow: IN_OUT,
  progressFill: IN_OUT,
  wiggle: IN_OUT,
  crossfade: IN_OUT,
  shake: 'linear',
  bounce: 'linear',
  skeletonShimmer: 'linear',
  countDown: 'linear',
  confetti: 'linear',
  cartBadgePop: OVERSHOOT,
};

/** The kinds that take something away: their end state stays a little before the stage resets. */
const LEAVING_KINDS: readonly MotionType[] = ['fadeOut', 'slideOut', 'collapse', 'reorderShift'];

/** "auto" direction by event: screens move forward in the reading direction (RTL); a line leaves to the end. */
const AUTO_DIRECTION: Partial<Record<MotionEventKey, Exclude<MotionDirection, 'auto'>>> = {
  categorySwitch: 'right',
  pageTransition: 'right',
  homeReturn: 'right',
  remove: 'left',
  error: 'left',
  scrollHint: 'down',
};

type Dir = Exclude<MotionDirection, 'auto'>;

function r(n: number, digits = 2): number {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function directionOf(spec: ResolvedMotion): Dir {
  return spec.direction === 'auto' ? (AUTO_DIRECTION[spec.event] ?? 'up') : spec.direction;
}

/** The unit vector of a movement in that direction (screen coordinates: y grows downwards). */
function vectorOf(d: Dir): [number, number] {
  return d === 'left' ? [-1, 0] : d === 'right' ? [1, 0] : d === 'up' ? [0, -1] : [0, 1];
}

function tr(x: number, y: number, unit = 'px'): string {
  return `translate(${r(x) || 0}${unit}, ${r(y) || 0}${unit})`;
}

function sc(s: number): string {
  return `scale(${r(s, 3)})`;
}

/** A part of one iteration: a role's frames over a share of the duration (or once, after the last). */
interface Part {
  role: string;
  frames: MotionFrame[];
  /** The share of the duration it plays in; may run past 1 (a follow-up). Default [0, 1]. */
  span?: [number, number];
  easing?: string;
  /** The staggered cards: the card's index. */
  index?: number;
  /** Once, after the last iteration: `at` ms after it ends ('hold': after the preview's hold), for `ms`. */
  after?: { at: number | 'hold'; ms: number };
}

interface Built {
  parts: Part[];
  counters: { role: string; from: number; to: number; decimals: number; span?: [number, number]; easing?: string }[];
  /** When the content swaps, as a share of the duration (default 0: at the start). */
  swapAt?: number;
}

const GRID = [0, 1, 2];

function forCards(frames: MotionFrame[]): Part[] {
  return GRID.map((i) => ({ role: `card-${i}`, frames, index: i }));
}

/** A pseudo-random in [0, 1) by index: the confetti look the same at every press. */
function rand(i: number): number {
  const x = Math.sin(i * 12.9898 + 78.233) * 43758.5453;
  return x - Math.floor(x);
}

function build(spec: ResolvedMotion, scene: MotionScene, geo: MotionStageGeometry): Built {
  const kind = spec.animationType;
  const k = Math.max(0, spec.intensity) / 100;
  const dir = directionOf(spec);
  const [vx, vy] = vectorOf(dir);
  /** A scale's distance from 1 grows with the intensity. */
  const amp = (s: number) => 1 + (s - 1) * k;
  /** The event's distance on the stage, or the kind's own when it sets none. */
  const dist = (fallback: number) => (spec.distancePx > 0 ? spec.distancePx * STAGE_SCALE : fallback) * k;
  const D = Math.max(1, spec.durationMs);
  const overlay = scene === 'sheet' || scene === 'dialog' ? [{ role: 'backdrop', frames: [{ opacity: 0 }, { opacity: 1 }] }] : [];
  const toastLeave = (): Part[] =>
    scene === 'toast' ? [{ role: 'target', frames: [{ opacity: 1 }, { opacity: 0 }], easing: ACCEL, after: { at: 'hold', ms: Math.max(200, D * 0.6) } }] : [];
  const leaveLine = (exit: MotionFrame[], until = 0.6): Part[] => [
    { role: 'target', frames: exit, span: [0, until] },
    {
      role: 'target',
      frames: [
        { height: `${PREVIEW_ROW_H}px`, marginBottom: `${PREVIEW_ROW_GAP}px` },
        { height: '0px', marginBottom: '0px' },
      ],
      span: [until - 0.05, 1],
      easing: STANDARD,
    },
    { role: 'undo', frames: [{ opacity: 0, transform: tr(0, 6) }, { opacity: 1, transform: tr(0, 0) }], span: [until, 1] },
  ];
  const fade = (from: number, to: number): MotionFrame[] => [{ opacity: from }, { opacity: to }];
  /** An element appearing: a fade, and a move in when the event sets a distance. */
  const appear = (fallbackMove: number): MotionFrame[] => {
    const d = dist(fallbackMove);
    return [
      { opacity: 0, transform: tr(-vx * d, -vy * d) },
      { opacity: 1, transform: tr(0, 0) },
    ];
  };

  switch (kind) {
    case 'none':
      return { parts: [], counters: [] };

    case 'scalePress':
      return {
        parts: [{ role: 'target', frames: [{ transform: sc(amp(spec.scaleFrom)) }, { transform: sc(amp(spec.scaleTo)), offset: 0.4 }, { transform: sc(1) }] }],
        counters: [],
      };

    case 'ripple':
      return {
        parts: [{ role: 'ripple', frames: [{ transform: sc(0), opacity: r(Math.min(0.6, 0.35 * Math.max(k, 0.3))) }, { transform: sc(2.6), opacity: 0 }] }],
        counters: [],
      };

    case 'highlight': {
      const rgb = scene === 'field' ? '239,68,68' : scene === 'price' ? '245,158,11' : '14,165,233';
      const glow = r(2 + 4 * k, 1);
      const alpha = r(Math.min(0.65, 0.15 + 0.3 * k));
      return {
        parts: [
          {
            role: 'target',
            frames: [
              { boxShadow: `0 0 0 0px rgba(${rgb},0)`, backgroundColor: `rgba(${rgb},0)`, transform: sc(1) },
              { boxShadow: `0 0 0 ${glow}px rgba(${rgb},${alpha})`, backgroundColor: `rgba(${rgb},${r(alpha / 3)})`, transform: sc(amp(spec.scaleTo)), offset: 0.35 },
              { boxShadow: `0 0 0 0px rgba(${rgb},0)`, backgroundColor: `rgba(${rgb},0)`, transform: sc(1) },
            ],
          },
        ],
        counters: [],
      };
    }

    case 'bounce': {
      const h = dist(10);
      const peak = amp(Math.max(spec.scaleTo, 1));
      return {
        parts: [
          {
            role: scene === 'addCart' ? 'cart' : 'target',
            frames: [
              { transform: `${tr(0, 0)} ${sc(1)}`, easing: EASE_OUT },
              { transform: `${tr(0, -h)} ${sc(peak)}`, offset: 0.32, easing: EASE_IN },
              { transform: `${tr(0, 0)} ${sc(1)}`, offset: 0.6, easing: EASE_OUT },
              { transform: `${tr(0, -h * 0.35)} ${sc(1)}`, offset: 0.8, easing: EASE_IN },
              { transform: `${tr(0, 0)} ${sc(1)}` },
            ],
          },
        ],
        counters: [],
        swapAt: scene === 'addCart' ? 0.3 : 0,
      };
    }

    case 'pulse': {
      // A bar or a skeleton pulses its light, not its size.
      if (scene === 'progress' || scene === 'skeleton') {
        const dim = r(Math.max(0.15, 1 - 0.55 * k));
        return { parts: [{ role: scene === 'progress' ? 'bar' : 'target', frames: [{ opacity: 1 }, { opacity: dim, offset: 0.5 }, { opacity: 1 }] }], counters: [] };
      }
      const peak = amp(spec.scaleTo !== 1 ? spec.scaleTo : 1.06);
      return { parts: [{ role: 'target', frames: [{ transform: sc(1) }, { transform: sc(peak), offset: 0.5 }, { transform: sc(1) }] }], counters: [] };
    }

    case 'flyToCart': {
      const { flyDx: dx, flyDy: dy } = geo;
      const lift = dist(28);
      const cx = dx * 0.5;
      const cy = Math.min(0, dy) - lift;
      const pop = amp(1.12);
      const end = amp(spec.scaleTo);
      const frames: MotionFrame[] = [0, 0.15, 0.35, 0.55, 0.75, 1].map((t) => {
        const x = 2 * (1 - t) * t * cx + t * t * dx;
        const y = 2 * (1 - t) * t * cy + t * t * dy;
        const s = t <= 0.15 ? 1 + (pop - 1) * (t / 0.15) : pop + (end - pop) * ((t - 0.15) / 0.85);
        return { offset: t, opacity: t < 0.8 ? 1 : 0.35, transform: `${tr(x, y)} ${sc(s)}` };
      });
      return {
        parts: [
          { role: 'ghost', frames },
          { role: 'cart', frames: [{ transform: sc(1) }, { transform: sc(amp(1.18)), offset: 0.4 }, { transform: sc(1) }], span: [0.85, 1.3], easing: STANDARD },
          { role: 'badge', frames: [{ transform: sc(1) }, { transform: sc(1.35), offset: 0.45 }, { transform: sc(1) }], span: [0.85, 1.3], easing: OVERSHOOT },
          { role: 'added', frames: [{ opacity: 0, transform: tr(0, 4) }, { opacity: 1, transform: tr(0, 0) }], after: { at: -D * 0.1, ms: 220 } },
        ],
        counters: [],
        swapAt: 0.85,
      };
    }

    case 'fadeOut':
      if (scene === 'addCart') {
        return {
          parts: [
            { role: 'ghost', frames: [{ opacity: 0.95, transform: sc(1) }, { opacity: 0, transform: sc(amp(1.15)) }] },
            { role: 'badge', frames: [{ transform: sc(1) }, { transform: sc(1.3), offset: 0.45 }, { transform: sc(1) }], span: [0.6, 1.1], easing: OVERSHOOT },
            { role: 'added', frames: [{ opacity: 0 }, { opacity: 1 }], after: { at: 0, ms: 200 } },
          ],
          counters: [],
          swapAt: 0.6,
        };
      }
      if (scene === 'card') {
        return {
          parts: [
            { role: 'target', frames: [{ opacity: 1, filter: 'grayscale(0)' }, { opacity: SOLD_OUT_ALPHA, filter: 'grayscale(0.8)' }] },
            { role: 'soldBadge', frames: [{ opacity: 0, transform: sc(0.8) }, { opacity: 1, transform: sc(1) }], span: [0.4, 1] },
          ],
          counters: [],
        };
      }
      if (scene === 'list') return { parts: leaveLine(fade(1, 0)), counters: [], swapAt: 0.6 };
      return { parts: [{ role: 'target', frames: fade(1, 0) }], counters: [] };

    case 'fadeIn':
      if (scene === 'screen') return { parts: [{ role: 'screenB', frames: fade(0, 1) }], counters: [] };
      if (scene === 'grid') return { parts: forCards(fade(0, 1)), counters: [] };
      if (scene === 'addCart') {
        return {
          parts: [
            { role: 'added', frames: fade(0, 1) },
            { role: 'badge', frames: fade(0.3, 1) },
          ],
          counters: [],
        };
      }
      if (scene === 'check') {
        return {
          parts: [
            { role: 'target', frames: fade(0, 1) },
            { role: 'orderNo', frames: fade(0, 1), span: [0.3, 1] },
          ],
          counters: [],
        };
      }
      return { parts: [...overlay, { role: 'target', frames: spec.distancePx > 0 ? appear(0) : fade(0, 1) }, ...toastLeave()], counters: [] };

    case 'slideIn': {
      if (scene === 'screen') {
        const full = spec.distancePx <= 0;
        const d = dist(0);
        return {
          parts: [
            {
              role: 'screenB',
              frames: full
                ? [{ transform: tr(-vx * 100, -vy * 100, '%') }, { transform: tr(0, 0, '%') }]
                : [
                    { transform: tr(-vx * d, -vy * d), opacity: 0 },
                    { transform: tr(0, 0), opacity: 1 },
                  ],
            },
            { role: 'screenA', frames: [{ transform: tr(0, 0, '%'), opacity: 1 }, { transform: tr(vx * 18, vy * 18, '%'), opacity: 0.6 }] },
          ],
          counters: [],
        };
      }
      if (scene === 'sheet') {
        const full = spec.distancePx <= 0;
        const d = dist(0);
        return {
          parts: [
            ...overlay,
            {
              role: 'target',
              frames: full
                ? [{ transform: tr(-vx * 100, -vy * 100, '%'), opacity: 0.6 }, { transform: tr(0, 0, '%'), opacity: 1 }]
                : [
                    { transform: tr(-vx * d, -vy * d), opacity: 0 },
                    { transform: tr(0, 0), opacity: 1 },
                  ],
            },
          ],
          counters: [],
        };
      }
      if (scene === 'grid') return { parts: forCards(appear(12)), counters: [] };
      return { parts: [...overlay, { role: 'target', frames: appear(16) }, ...toastLeave()], counters: [] };
    }

    case 'slideOut': {
      if (scene === 'list') {
        const exit: MotionFrame[] = [
          { transform: tr(0, 0, '%'), opacity: 1 },
          { transform: tr(vx * 100, vy * 100, '%'), opacity: 0 },
        ];
        return { parts: leaveLine(exit), counters: [], swapAt: 0.6 };
      }
      const d = dist(24);
      return {
        parts: [
          {
            role: 'target',
            frames: [
              { transform: tr(0, 0), opacity: 1 },
              { transform: tr(vx * d, vy * d), opacity: 0 },
            ],
          },
        ],
        counters: [],
      };
    }

    case 'fadeScale': {
      const from = spec.scaleFrom !== spec.scaleTo ? spec.scaleFrom : 0.96;
      const frames: MotionFrame[] = [
        { opacity: 0, transform: sc(amp(from)) },
        { opacity: 1, transform: sc(amp(spec.scaleTo)) },
      ];
      if (scene === 'screen') return { parts: [{ role: 'screenB', frames }], counters: [] };
      if (scene === 'grid') return { parts: forCards(frames), counters: [] };
      return { parts: [...overlay, { role: 'target', frames }, ...toastLeave()], counters: [] };
    }

    case 'expand': {
      const v = r(Math.min(45, 34 * k), 1);
      const h = r(Math.min(40, 10 * k), 1);
      return {
        parts: [
          ...overlay,
          {
            role: 'target',
            frames: [
              { clipPath: `inset(${v}% ${h}% ${v}% ${h}% round 14px)`, opacity: 0.5 },
              { clipPath: 'inset(0% 0% 0% 0% round 14px)', opacity: 1 },
            ],
          },
        ],
        counters: [],
      };
    }

    case 'collapse':
      if (scene === 'list') {
        return {
          parts: [
            {
              role: 'target',
              frames: [
                { height: `${PREVIEW_ROW_H}px`, marginBottom: `${PREVIEW_ROW_GAP}px`, opacity: 1, transform: 'scaleY(1)' },
                { height: '0px', marginBottom: '0px', opacity: 0, transform: 'scaleY(0.4)' },
              ],
            },
            { role: 'undo', frames: [{ opacity: 0, transform: tr(0, 6) }, { opacity: 1, transform: tr(0, 0) }], span: [0.5, 1] },
          ],
          counters: [],
          swapAt: 0.5,
        };
      }
      return { parts: [{ role: 'target', frames: [{ transform: 'scaleY(1)', opacity: 1 }, { transform: 'scaleY(0)', opacity: 0 }] }], counters: [] };

    case 'morph': {
      const s = r(Math.max(0.15, 1 - 0.7 * Math.min(k, 1.2)), 3);
      return {
        parts: [
          ...overlay,
          { role: 'source', frames: fade(1, 0), span: [0, 0.35] },
          {
            role: 'target',
            frames: [
              { transform: `${tr(26 * k, 30 * k, '%')} ${sc(s)}`, borderRadius: '24px', opacity: 0.55 },
              { transform: `${tr(0, 0, '%')} ${sc(1)}`, borderRadius: '14px', opacity: 1 },
            ],
          },
        ],
        counters: [],
      };
    }

    case 'flip': {
      const axis = dir === 'left' || dir === 'right' ? 'rotateY' : 'rotateX';
      const sign = dir === 'up' || dir === 'left' ? 1 : -1;
      const a = r(90 * Math.min(1, k), 1);
      const frames: MotionFrame[] = [
        { transform: `perspective(360px) ${axis}(${sign * a}deg)`, opacity: 0 },
        { transform: `perspective(360px) ${axis}(${r(-sign * a * 0.12, 1)}deg)`, opacity: 1, offset: 0.7 },
        { transform: `perspective(360px) ${axis}(0deg)`, opacity: 1 },
      ];
      if (scene === 'grid') return { parts: forCards(frames), counters: [] };
      return { parts: [{ role: 'target', frames }], counters: [] };
    }

    case 'countUp': {
      const n = SCENE_NUMBERS[scene];
      return {
        parts: [{ role: 'target', frames: [{ transform: sc(1) }, { transform: sc(amp(1.08)), offset: 0.5 }, { transform: sc(1) }] }],
        counters: n ? [{ role: 'number', ...n }] : [],
      };
    }

    case 'countDown': {
      const n = SCENE_NUMBERS[scene] ?? { from: 5, to: 0, decimals: 0 };
      return {
        parts: [
          ...(scene === 'dialog' ? [{ role: 'ring', frames: [{ strokeDashoffset: 0 }, { strokeDashoffset: 1 }], easing: 'linear' }] : []),
          { role: 'target', frames: [{ transform: sc(amp(0.96)), opacity: 0.8 }, { transform: sc(1), opacity: 1 }], span: [0, 0.25] },
        ],
        counters: [{ role: 'number', from: n.from, to: n.to, decimals: n.decimals, easing: 'linear' }],
      };
    }

    case 'shake': {
      const a = dist(8);
      const horizontal = dir === 'left' || dir === 'right';
      const s = dir === 'left' || dir === 'up' ? -1 : 1;
      const steps = [0, 1, -1, 0.66, -0.66, 0.3, 0];
      const offsets = [0, 0.14, 0.3, 0.46, 0.62, 0.78, 1];
      const frames = steps.map((m, i) => ({ offset: offsets[i], transform: horizontal ? tr(s * m * a, 0) : tr(0, s * m * a) }));
      return {
        parts: [
          { role: 'target', frames },
          ...(scene === 'field' ? [{ role: 'message', frames: [{ opacity: 0, transform: tr(0, -4) }, { opacity: 1, transform: tr(0, 0) }], span: [0, 0.35] as [number, number], easing: DECEL }] : []),
        ],
        counters: [],
      };
    }

    case 'wiggle': {
      const deg = r(4 * k, 1);
      const steps = [0, -1, 1, -0.5, 0.5, 0];
      return { parts: [{ role: 'target', frames: steps.map((m, i) => ({ offset: r(i / 5), transform: `rotate(${r(m * deg, 1)}deg)` })) }], counters: [] };
    }

    case 'drawCheck':
      return {
        parts: [
          { role: 'target', frames: [{ opacity: 0, transform: sc(amp(spec.scaleFrom)) }, { opacity: 1, transform: sc(1) }], span: [0, 0.45] },
          { role: 'checkPath', frames: [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }], span: [0.3, 1] },
          { role: 'orderNo', frames: [{ opacity: 0, transform: tr(0, 4) }, { opacity: 1, transform: tr(0, 0) }], span: [0.65, 1] },
        ],
        counters: [],
      };

    case 'successZoom':
      return {
        parts: [
          {
            role: 'target',
            frames: [
              { opacity: 0, transform: sc(amp(spec.scaleFrom)) },
              { opacity: 1, transform: sc(amp(1.08)), offset: 0.6 },
              { opacity: 1, transform: sc(amp(spec.scaleTo)) },
            ],
          },
          { role: 'orderNo', frames: [{ opacity: 0, transform: sc(0.9) }, { opacity: 1, transform: sc(1) }], span: [0.5, 1] },
        ],
        counters: [],
      };

    case 'confetti': {
      const reach = 64 * Math.max(0.2, k);
      const pieces = CONFETTI_ROLES.map((role, i): Part => {
        const angle = (i / CONFETTI_PIECES) * Math.PI * 2 + rand(i) * 0.5;
        const len = reach * (0.55 + 0.45 * rand(i + 31));
        const x = Math.cos(angle) * len;
        const y = Math.sin(angle) * len * 0.7;
        const spin = Math.round((rand(i + 7) - 0.5) * 540);
        return {
          role,
          frames: [
            { opacity: 1, transform: `${tr(0, 0)} rotate(0deg) ${sc(0.6)}` },
            { opacity: 1, transform: `${tr(x * 0.75, y * 0.75 - 10 * k)} rotate(${r(spin * 0.6, 0)}deg) ${sc(1)}`, offset: 0.45, easing: EASE_IN },
            { opacity: 0, transform: `${tr(x, y + 30 * k)} rotate(${spin}deg) ${sc(0.9)}` },
          ],
          span: [r(rand(i + 13) * 0.08, 3), 1],
          easing: 'linear',
        };
      });
      return {
        parts: [{ role: 'target', frames: [{ opacity: 0, transform: sc(0.7) }, { opacity: 1, transform: sc(1) }], span: [0, 0.3], easing: DECEL }, ...pieces],
        counters: [],
      };
    }

    case 'progressFill': {
      const origin = dir === 'right' ? 'left center' : 'right center';
      return {
        parts: [
          {
            role: 'bar',
            frames: [
              { transform: 'scaleX(0)', transformOrigin: origin },
              { transform: 'scaleX(1)', transformOrigin: origin },
            ],
          },
        ],
        counters: [],
      };
    }

    case 'skeletonShimmer': {
      const s = dir === 'right' ? -1 : 1;
      // The band is hidden at rest: it shows only while it sweeps.
      const a = r(Math.min(1, 0.4 + 0.6 * k));
      return {
        parts: [{ role: 'shimmer', frames: [{ transform: `translateX(${120 * s}%)`, opacity: a }, { transform: `translateX(${-120 * s}%)`, opacity: a }] }],
        counters: [],
      };
    }

    case 'floating': {
      const d = dist(8);
      return { parts: [{ role: 'target', frames: [{ transform: tr(0, 0) }, { transform: tr(vx * d, vy * d), offset: 0.5 }, { transform: tr(0, 0) }] }], counters: [] };
    }

    case 'swipeTransition':
      if (scene === 'screen') {
        return {
          parts: [
            { role: 'screenA', frames: [{ transform: tr(0, 0, '%') }, { transform: tr(vx * 100, vy * 100, '%') }] },
            { role: 'screenB', frames: [{ transform: tr(-vx * 100, -vy * 100, '%') }, { transform: tr(0, 0, '%') }] },
          ],
          counters: [],
        };
      }
      return {
        parts: [
          ...overlay,
          { role: 'base', frames: [{ transform: tr(0, 0, '%'), opacity: 1 }, { transform: tr(vx * 30, vy * 30, '%'), opacity: 0.5 }] },
          { role: 'target', frames: [{ transform: tr(-vx * 100, -vy * 100, '%') }, { transform: tr(0, 0, '%') }] },
        ],
        counters: [],
      };

    case 'staggeredEntry': {
      const d = dist(12);
      return {
        parts: forCards([
          { opacity: 0, transform: `${tr(-vx * d, -vy * d)} ${sc(amp(spec.scaleFrom))}` },
          { opacity: 1, transform: `${tr(0, 0)} ${sc(amp(spec.scaleTo))}` },
        ]),
        counters: [],
      };
    }

    case 'parallaxLight': {
      const d = dist(10);
      const layer = (role: string, m: number): Part => ({
        role,
        frames: [{ transform: tr(0, 0) }, { transform: tr(vx * d * m, vy * d * m), offset: 0.5 }, { transform: tr(0, 0) }],
      });
      return { parts: [layer('layerBack', 0.5), layer('layerMid', -0.9), layer('target', 0.25)], counters: [] };
    }

    case 'attentionArrow': {
      const d = dist(8);
      return {
        parts: [
          {
            role: 'target',
            frames: [
              { transform: tr(0, 0), opacity: 0.55 },
              { transform: tr(vx * d, vy * d), opacity: 1, offset: 0.5 },
              { transform: tr(0, 0), opacity: 0.55 },
            ],
          },
        ],
        counters: [],
      };
    }

    case 'cartBadgePop': {
      const peak = spec.scaleTo !== spec.scaleFrom ? amp(spec.scaleTo) : amp(1.25);
      return {
        parts: [{ role: scene === 'addCart' ? 'badge' : 'target', frames: [{ transform: sc(amp(spec.scaleFrom)) }, { transform: sc(peak), offset: 0.45 }, { transform: sc(1) }] }],
        counters: [],
      };
    }

    case 'priceHighlight': {
      const a = r(Math.min(0.6, 0.38 * k));
      return {
        parts: [
          {
            role: 'target',
            frames: [
              { backgroundColor: 'rgba(245,158,11,0)', boxShadow: '0 0 0 0px rgba(245,158,11,0)', transform: sc(1) },
              { backgroundColor: `rgba(245,158,11,${a})`, boxShadow: `0 0 0 ${r(2 + 3 * k, 1)}px rgba(245,158,11,${r(a / 2)})`, transform: sc(amp(1.06)), offset: 0.3 },
              { backgroundColor: 'rgba(245,158,11,0)', boxShadow: '0 0 0 0px rgba(245,158,11,0)', transform: sc(1) },
            ],
          },
        ],
        counters: [],
      };
    }

    case 'buttonFill': {
      const start =
        dir === 'right' ? 'inset(0% 100% 0% 0%)' : dir === 'up' ? 'inset(100% 0% 0% 0%)' : dir === 'down' ? 'inset(0% 0% 100% 0%)' : 'inset(0% 0% 0% 100%)';
      const parts: Part[] = [{ role: 'fill', frames: [{ clipPath: start }, { clipPath: 'inset(0% 0% 0% 0%)' }], span: [0, 0.8] }];
      if (spec.scaleTo !== 1) {
        parts.push({ role: 'target', frames: [{ transform: sc(1) }, { transform: sc(amp(spec.scaleTo)), offset: 0.5 }, { transform: sc(1) }], span: [0.7, 1] });
      }
      return { parts, counters: [] };
    }

    case 'cardLift': {
      const d = dist(6);
      const parts: Part[] = [
        {
          role: 'target',
          frames: [
            { transform: `${tr(0, 0)} ${sc(1)}`, boxShadow: '0 1px 2px rgba(15,23,42,0.08)' },
            { transform: `${tr(vx * d, vy * d)} ${sc(amp(spec.scaleTo))}`, boxShadow: `0 ${r(6 + 8 * k, 0)}px ${r(14 + 14 * k, 0)}px rgba(15,23,42,0.22)` },
          ],
        },
      ];
      if (scene === 'choice') {
        parts.push({ role: 'other', frames: [{ opacity: 1, transform: sc(1) }, { opacity: 0.45, transform: sc(0.97) }] });
        if (spec.autoAdvanceDelayMs > 0) {
          parts.push({ role: 'advance', frames: [{ opacity: 0, transform: tr(-100, 0, '%') }, { opacity: 1, transform: tr(0, 0, '%') }], easing: DECEL, after: { at: spec.autoAdvanceDelayMs, ms: 360 } });
        }
      }
      return { parts, counters: [] };
    }

    case 'crossfade':
      if (scene === 'screen') {
        return {
          parts: [
            { role: 'screenA', frames: fade(1, 0) },
            { role: 'screenB', frames: fade(0, 1) },
          ],
          counters: [],
        };
      }
      return { parts: [{ role: 'target', frames: fade(0, 1) }], counters: [] };

    case 'reorderShift':
      if (scene === 'list') return { parts: leaveLine(fade(1, 0), 0.35), counters: [], swapAt: 0.35 };
      return { parts: [{ role: 'target', frames: [{ transform: tr(0, 12) }, { transform: tr(0, 0) }] }], counters: [] };

    default:
      return { parts: [{ role: 'target', frames: fade(0, 1) }], counters: [] };
  }
}

/**
 * The preview of one event: its tracks over its iterations (repeat 0 → a few cycles of the loop,
 * the gap of repeatDelayMs between them), the staggered cards' offsets, the hold, the counters.
 * An event that does not play (switched off, "ללא", no time) has no tracks.
 */
export function planMotionPreview(
  spec: ResolvedMotion,
  scene: MotionScene = MOTION_SCENES[spec.event],
  geo: MotionStageGeometry = { flyDx: -120, flyDy: -48 },
): MotionPlan {
  const empty: MotionPlan = { tracks: [], counters: [], endMs: 0, holdMs: 0, cycles: 0, loop: false, truncated: false, swapAtMs: 0 };
  if (spec.animationType === 'none' || spec.durationMs <= 0 || !spec.enabled) return empty;
  const D = spec.durationMs;
  const loop = spec.repeat === 0;
  const cycles = loop ? LOOP_PREVIEW_CYCLES : Math.max(1, Math.min(spec.repeat, MAX_PREVIEW_CYCLES));
  const hold = Math.min(MAX_PREVIEW_HOLD_MS, Math.max(spec.holdMs, LEAVING_KINDS.includes(spec.animationType) ? 900 : 450));
  const built = build(spec, scene, geo);
  if (built.parts.length === 0 && built.counters.length === 0) return empty;
  const curve = motionCurve(spec.easing, KIND_CURVES[spec.animationType] ?? STANDARD);
  const cap = spec.staggerCapMs > 0 ? spec.staggerCapMs : Number.POSITIVE_INFINITY;
  const staggerOf = (index: number | undefined) => (index === undefined ? 0 : Math.min(index * Math.max(0, spec.staggerMs), cap));
  const period = D + Math.max(0, spec.repeatDelayMs);
  const tracks: MotionTrack[] = [];
  const counters: MotionCounter[] = [];
  let lastEnd = 0;
  for (let i = 0; i < cycles; i++) {
    const start = spec.delayMs + i * period;
    const fill: MotionFill = cycles === 1 ? 'both' : i === 0 ? 'backwards' : i === cycles - 1 ? 'forwards' : 'none';
    for (const p of built.parts) {
      if (p.after) continue;
      const [a, b] = p.span ?? [0, 1];
      const delay = Math.round(start + a * D + staggerOf(p.index));
      const duration = Math.max(1, Math.round((b - a) * D));
      tracks.push({ role: p.role, frames: p.frames, delay, duration, easing: p.easing ?? curve, fill });
      lastEnd = Math.max(lastEnd, delay + duration);
    }
    for (const c of built.counters) {
      const [a, b] = c.span ?? [0, 1];
      const delay = Math.round(start + a * D);
      const duration = Math.max(1, Math.round((b - a) * D));
      counters.push({ role: c.role, from: c.from, to: c.to, decimals: c.decimals, delay, duration, easing: c.easing ?? curve });
      lastEnd = Math.max(lastEnd, delay + duration);
    }
  }
  let endMs = lastEnd;
  let holdMs = hold;
  for (const p of built.parts) {
    if (!p.after) continue;
    const at = p.after.at === 'hold' ? hold : p.after.at;
    const delay = Math.max(0, Math.round(lastEnd + at));
    tracks.push({ role: p.role, frames: p.frames, delay, duration: Math.max(1, Math.round(p.after.ms)), easing: p.easing ?? curve, fill: 'both' });
    endMs = Math.max(endMs, delay + p.after.ms);
    // Leaving after the hold (the toast): only a short pause before the reset.
    if (p.after.at === 'hold') holdMs = 250;
  }
  return {
    tracks,
    counters,
    endMs: Math.round(endMs),
    holdMs,
    cycles,
    loop,
    truncated: !loop && spec.repeat > MAX_PREVIEW_CYCLES,
    swapAtMs: Math.round(spec.delayMs + (built.swapAt ?? 0) * D),
  };
}

/** A counter's text at a share of its time. */
export function counterText(c: Pick<MotionCounter, 'from' | 'to' | 'decimals'>, progress: number): string {
  const p = Math.min(1, Math.max(0, progress));
  const v = c.from + (c.to - c.from) * p;
  return c.decimals > 0 ? v.toFixed(c.decimals) : String(Math.round(v));
}
