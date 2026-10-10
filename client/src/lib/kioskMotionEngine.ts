/**
 * "מנוע הנפשות" — the kiosk's Motion Engine (spec §6–§17): one central, dynamic MotionConfig for
 * every renderer. The server's app/services/kiosk_motion.py (validation, limits, the migration) and
 * the Android kiosk's domain/KioskMotionEngine.kt resolve every event exactly as here; the shared
 * golden server/tests/fixtures/kiosk_motion_engine.json (byte-identical in pos-android) pins all three.
 *
 * The config lives in the kiosk config's `motion` beside the older per-transition choices:
 *   preset            standard | slow | fast | custom | legacy — every event's base timings
 *   globalSpeed       slow 1.30 | normal 1 | fast 0.75 | custom `speedMultiplier` — null: the older `speed`
 *   events.<event>    the event's own values, only what a level sets (an override)
 *
 * An event resolves in five steps: the preset's values; the older choice of its kind (the UI
 * style's transitions, a config saved before the engine); its own explicit values, which win; the
 * timings times the global speed unless set explicitly (resolveDuration: an override ignores the
 * multiplier; hold / auto-advance never scale); then the light profile (a weak device: plain kinds,
 * no slower than fast) and reduced motion (each event's fallback: fade, highlight, colour or none).
 *
 * Pure and self-contained (relative imports only): the dashboard's editor and preview, the web
 * kiosk and the Windows kiosk (through `@/kiosk-shared`) all read it.
 */

export const MOTION_EVENTS = [
  'productPress',
  'addToCart',
  'cartBadge',
  'toast',
  'modalOpen',
  'select',
  'quantityChange',
  'priceChange',
  'categorySwitch',
  'itemsEnter',
  'cartOpen',
  'remove',
  'continueReady',
  'error',
  'serviceChoice',
  'upsell',
  'pageTransition',
  'payment',
  'paymentProgress',
  'success',
  'idle',
  'timeout',
  'soldOut',
  'loading',
  'scrollHint',
  'homeReturn',
] as const;
export type MotionEventKey = (typeof MOTION_EVENTS)[number];

/** The animation library (spec §3): 35 kinds, and "none". */
export const MOTION_TYPES = [
  'scalePress', 'bounce', 'pulse', 'flyToCart', 'slideIn', 'slideOut', 'fadeIn', 'fadeOut',
  'fadeScale', 'expand', 'collapse', 'morph', 'flip', 'countUp', 'countDown', 'shake', 'wiggle',
  'drawCheck', 'progressFill', 'highlight', 'ripple', 'floating', 'swipeTransition', 'staggeredEntry',
  'parallaxLight', 'confetti', 'skeletonShimmer', 'attentionArrow', 'cartBadgePop', 'priceHighlight',
  'buttonFill', 'successZoom', 'cardLift', 'crossfade', 'reorderShift', 'none',
] as const;
export type MotionType = (typeof MOTION_TYPES)[number];

/** The kinds each event can play; "none" always. */
export const MOTION_EVENT_TYPES: Record<MotionEventKey, readonly MotionType[]> = {
  productPress: ['scalePress', 'ripple', 'highlight', 'bounce', 'none'],
  addToCart: ['flyToCart', 'bounce', 'fadeOut', 'none'],
  cartBadge: ['cartBadgePop', 'bounce', 'pulse', 'none'],
  toast: ['fadeIn', 'slideIn', 'fadeScale', 'none'],
  modalOpen: ['fadeScale', 'slideIn', 'fadeIn', 'expand', 'morph', 'none'],
  select: ['highlight', 'scalePress', 'bounce', 'cardLift', 'ripple', 'none'],
  quantityChange: ['flip', 'slideIn', 'countUp', 'bounce', 'fadeIn', 'none'],
  priceChange: ['priceHighlight', 'countUp', 'highlight', 'flip', 'none'],
  categorySwitch: ['slideIn', 'swipeTransition', 'fadeIn', 'fadeScale', 'crossfade', 'none'],
  itemsEnter: ['staggeredEntry', 'fadeScale', 'slideIn', 'flip', 'fadeIn', 'none'],
  cartOpen: ['slideIn', 'swipeTransition', 'fadeIn', 'fadeScale', 'none'],
  remove: ['slideOut', 'collapse', 'fadeOut', 'reorderShift', 'none'],
  continueReady: ['buttonFill', 'pulse', 'highlight', 'bounce', 'none'],
  error: ['shake', 'wiggle', 'highlight', 'none'],
  serviceChoice: ['cardLift', 'scalePress', 'highlight', 'bounce', 'none'],
  upsell: ['slideIn', 'fadeScale', 'fadeIn', 'expand', 'none'],
  pageTransition: ['slideIn', 'swipeTransition', 'fadeIn', 'fadeScale', 'crossfade', 'none'],
  payment: ['buttonFill', 'pulse', 'highlight', 'none'],
  paymentProgress: ['progressFill', 'pulse', 'skeletonShimmer', 'none'],
  success: ['drawCheck', 'successZoom', 'confetti', 'fadeIn', 'none'],
  idle: ['floating', 'pulse', 'parallaxLight', 'wiggle', 'none'],
  timeout: ['fadeIn', 'fadeScale', 'slideIn', 'countDown', 'none'],
  soldOut: ['fadeOut', 'highlight', 'none'],
  loading: ['skeletonShimmer', 'pulse', 'none'],
  scrollHint: ['attentionArrow', 'wiggle', 'pulse', 'none'],
  homeReturn: ['crossfade', 'fadeIn', 'fadeScale', 'slideIn', 'none'],
};

export const MOTION_DIRECTIONS = ['auto', 'left', 'right', 'up', 'down'] as const;
export type MotionDirection = (typeof MOTION_DIRECTIONS)[number];

export const MOTION_EASINGS = ['auto', 'standard', 'decelerate', 'accelerate', 'emphasized', 'easeInOut', 'overshoot', 'linear'] as const;
export type MotionEasing = (typeof MOTION_EASINGS)[number];
/** The named curves (CSS cubic-bezier x1, y1, x2, y2); "auto" is each kind's own. */
export const MOTION_EASING_CURVES: Record<Exclude<MotionEasing, 'auto'>, readonly [number, number, number, number]> = {
  standard: [0.3, 0, 0.2, 1],
  decelerate: [0.2, 0.7, 0.2, 1],
  accelerate: [0.4, 0, 1, 1],
  emphasized: [0.05, 0.7, 0.1, 1],
  easeInOut: [0.45, 0, 0.55, 1],
  overshoot: [0.34, 1.56, 0.64, 1],
  linear: [0, 0, 1, 1],
};

export const MOTION_FALLBACKS = ['fade', 'highlight', 'color', 'none'] as const;
export type MotionFallback = (typeof MOTION_FALLBACKS)[number];

export const MOTION_PRESETS = ['standard', 'slow', 'fast', 'custom', 'legacy'] as const;
export type MotionPreset = (typeof MOTION_PRESETS)[number];
export const DEFAULT_MOTION_PRESET: MotionPreset = 'standard';

export const MOTION_GLOBAL_SPEEDS = ['slow', 'normal', 'fast', 'custom'] as const;
export type MotionGlobalSpeed = (typeof MOTION_GLOBAL_SPEEDS)[number];
export const MOTION_SPEED_FACTORS: Record<Exclude<MotionGlobalSpeed, 'custom'>, number> = { slow: 1.3, normal: 1, fast: 0.75 };
/** The older `motion.speed`, for a config with no global speed (exactly as before the engine). */
export const LEGACY_SPEED_FACTORS: Record<string, number> = { fast: 0.75, normal: 1, relaxed: 1.35 };
export const MOTION_MULTIPLIER_MIN = 0.5;
export const MOTION_MULTIPLIER_MAX = 2;
/** The light profile plays no slower than the fast pace. */
export const LIGHT_MAX_MULTIPLIER = 0.75;
/** A reduced-motion fade / highlight takes half the event's time. */
export const REDUCED_FACTOR = 0.5;
/** "Undo" stays at least this long after a remove. */
export const REMOVE_MIN_HOLD_MS = 3000;
/** The staggered entry: the last card starts no later than this many steps… */
export const STAGGER_CAP_STEPS = 8;
/** …or, for "legacy", by 200 ms at normal speed. */
export const LEGACY_STAGGER_CAP_MS = 200;
/** A sold-out dish fades to this opacity (never vanishes). */
export const SOLD_OUT_ALPHA = 0.45;

export type MotionParam =
  | 'enabled'
  | 'animationType'
  | 'durationMs'
  | 'delayMs'
  | 'direction'
  | 'intensity'
  | 'scaleFrom'
  | 'scaleTo'
  | 'distancePx'
  | 'easing'
  | 'repeat'
  | 'repeatDelayMs'
  | 'holdMs'
  | 'staggerMs'
  | 'autoAdvanceDelayMs'
  | 'reducedMotionFallback';

export interface MotionParamSpec {
  kind: 'bool' | 'type' | 'enum' | 'int' | 'num';
  min?: number;
  max?: number;
  values?: readonly string[];
}

/** The parameters of an event (spec §6), in the editor's order. */
export const MOTION_PARAMS: Record<MotionParam, MotionParamSpec> = {
  enabled: { kind: 'bool' },
  animationType: { kind: 'type' },
  durationMs: { kind: 'int', min: 0, max: 5000 },
  delayMs: { kind: 'int', min: 0, max: 3000 },
  direction: { kind: 'enum', values: MOTION_DIRECTIONS },
  intensity: { kind: 'int', min: 0, max: 200 },
  scaleFrom: { kind: 'num', min: 0.2, max: 2 },
  scaleTo: { kind: 'num', min: 0.2, max: 2 },
  distancePx: { kind: 'int', min: 0, max: 600 },
  easing: { kind: 'enum', values: MOTION_EASINGS },
  repeat: { kind: 'int', min: 0, max: 20 },
  repeatDelayMs: { kind: 'int', min: 0, max: 10000 },
  holdMs: { kind: 'int', min: 0, max: 15000 },
  staggerMs: { kind: 'int', min: 0, max: 500 },
  autoAdvanceDelayMs: { kind: 'int', min: 0, max: 5000 },
  reducedMotionFallback: { kind: 'enum', values: MOTION_FALLBACKS },
};
export const MOTION_PARAM_KEYS = Object.keys(MOTION_PARAMS) as MotionParam[];
/** A narrower range for one event's parameter. */
export const MOTION_EVENT_PARAM_RANGES: Partial<Record<MotionEventKey, Partial<Record<MotionParam, { min: number; max: number }>>>> = {
  remove: { holdMs: { min: REMOVE_MIN_HOLD_MS, max: 15000 } },
};
/** Motion timings: times the global speed unless set explicitly. */
export const MOTION_TIMING_PARAMS: readonly MotionParam[] = ['durationMs', 'delayMs', 'staggerMs', 'repeatDelayMs'];

export interface MotionEventValues {
  enabled: boolean;
  animationType: MotionType;
  durationMs: number;
  delayMs: number;
  direction: MotionDirection;
  intensity: number;
  scaleFrom: number;
  scaleTo: number;
  distancePx: number;
  easing: MotionEasing;
  /** How many times it plays; 0 loops while its state lasts. */
  repeat: number;
  repeatDelayMs: number;
  holdMs: number;
  staggerMs: number;
  autoAdvanceDelayMs: number;
  reducedMotionFallback: MotionFallback;
}
export type MotionEventOverrides = Partial<MotionEventValues>;
export type MotionEventsConfig = Partial<Record<MotionEventKey, MotionEventOverrides>>;

/** The `motion` section as the engine reads it (the older keys included). */
export interface MotionEngineSettings {
  categorySwitch?: string;
  itemsEnter?: string;
  screenChange?: string;
  sheet?: string;
  addToCart?: string;
  speed?: string;
  effects?: string;
  preset?: string | null;
  globalSpeed?: string | null;
  speedMultiplier?: number | null;
  events?: Record<string, unknown> | null;
}

/** "Runner Standard" (spec §2, §8): Press 450 | Add 750 | Page 650 | Success 1000. */
export const MOTION_STANDARD: Record<MotionEventKey, MotionEventValues> = {
  productPress: { enabled: true, animationType: 'scalePress', durationMs: 450, delayMs: 0, direction: 'auto', intensity: 100, scaleFrom: 1, scaleTo: 0.96, distancePx: 0, easing: 'auto', repeat: 1, repeatDelayMs: 0, holdMs: 0, staggerMs: 0, autoAdvanceDelayMs: 0, reducedMotionFallback: 'highlight' },
  addToCart: { enabled: true, animationType: 'flyToCart', durationMs: 750, delayMs: 0, direction: 'auto', intensity: 100, scaleFrom: 1, scaleTo: 0.25, distancePx: 0, easing: 'auto', repeat: 1, repeatDelayMs: 0, holdMs: 900, staggerMs: 0, autoAdvanceDelayMs: 0, reducedMotionFallback: 'fade' },
  cartBadge: { enabled: true, animationType: 'cartBadgePop', durationMs: 550, delayMs: 0, direction: 'auto', intensity: 100, scaleFrom: 1, scaleTo: 1.25, distancePx: 0, easing: 'overshoot', repeat: 1, repeatDelayMs: 0, holdMs: 0, staggerMs: 0, autoAdvanceDelayMs: 0, reducedMotionFallback: 'color' },
  toast: { enabled: true, animationType: 'fadeIn', durationMs: 450, delayMs: 0, direction: 'up', intensity: 100, scaleFrom: 1, scaleTo: 1, distancePx: 16, easing: 'auto', repeat: 1, repeatDelayMs: 0, holdMs: 2000, staggerMs: 0, autoAdvanceDelayMs: 0, reducedMotionFallback: 'fade' },
  modalOpen: { enabled: true, animationType: 'fadeScale', durationMs: 650, delayMs: 0, direction: 'auto', intensity: 100, scaleFrom: 0.94, scaleTo: 1, distancePx: 0, easing: 'auto', repeat: 1, repeatDelayMs: 0, holdMs: 0, staggerMs: 0, autoAdvanceDelayMs: 0, reducedMotionFallback: 'fade' },
  select: { enabled: true, animationType: 'highlight', durationMs: 550, delayMs: 0, direction: 'auto', intensity: 100, scaleFrom: 1, scaleTo: 1.04, distancePx: 0, easing: 'auto', repeat: 1, repeatDelayMs: 0, holdMs: 0, staggerMs: 0, autoAdvanceDelayMs: 0, reducedMotionFallback: 'highlight' },
  quantityChange: { enabled: true, animationType: 'flip', durationMs: 500, delayMs: 0, direction: 'up', intensity: 100, scaleFrom: 1, scaleTo: 1, distancePx: 0, easing: 'auto', repeat: 1, repeatDelayMs: 0, holdMs: 0, staggerMs: 0, autoAdvanceDelayMs: 0, reducedMotionFallback: 'fade' },
  priceChange: { enabled: true, animationType: 'priceHighlight', durationMs: 700, delayMs: 0, direction: 'auto', intensity: 100, scaleFrom: 1, scaleTo: 1, distancePx: 0, easing: 'auto', repeat: 1, repeatDelayMs: 0, holdMs: 0, staggerMs: 0, autoAdvanceDelayMs: 0, reducedMotionFallback: 'color' },
  categorySwitch: { enabled: true, animationType: 'slideIn', durationMs: 600, delayMs: 0, direction: 'auto', intensity: 100, scaleFrom: 1, scaleTo: 1, distancePx: 0, easing: 'auto', repeat: 1, repeatDelayMs: 0, holdMs: 0, staggerMs: 0, autoAdvanceDelayMs: 0, reducedMotionFallback: 'fade' },
  itemsEnter: { enabled: true, animationType: 'staggeredEntry', durationMs: 450, delayMs: 0, direction: 'up', intensity: 100, scaleFrom: 0.85, scaleTo: 1, distancePx: 24, easing: 'auto', repeat: 1, repeatDelayMs: 0, holdMs: 0, staggerMs: 60, autoAdvanceDelayMs: 0, reducedMotionFallback: 'none' },
  cartOpen: { enabled: true, animationType: 'slideIn', durationMs: 650, delayMs: 0, direction: 'up', intensity: 100, scaleFrom: 1, scaleTo: 1, distancePx: 0, easing: 'auto', repeat: 1, repeatDelayMs: 0, holdMs: 0, staggerMs: 0, autoAdvanceDelayMs: 0, reducedMotionFallback: 'fade' },
  remove: { enabled: true, animationType: 'slideOut', durationMs: 650, delayMs: 0, direction: 'auto', intensity: 100, scaleFrom: 1, scaleTo: 1, distancePx: 0, easing: 'auto', repeat: 1, repeatDelayMs: 0, holdMs: 4000, staggerMs: 0, autoAdvanceDelayMs: 0, reducedMotionFallback: 'fade' },
  continueReady: { enabled: true, animationType: 'buttonFill', durationMs: 650, delayMs: 0, direction: 'auto', intensity: 100, scaleFrom: 1, scaleTo: 1.04, distancePx: 0, easing: 'auto', repeat: 1, repeatDelayMs: 0, holdMs: 0, staggerMs: 0, autoAdvanceDelayMs: 0, reducedMotionFallback: 'color' },
  error: { enabled: true, animationType: 'shake', durationMs: 550, delayMs: 0, direction: 'left', intensity: 100, scaleFrom: 1, scaleTo: 1, distancePx: 10, easing: 'auto', repeat: 1, repeatDelayMs: 0, holdMs: 0, staggerMs: 0, autoAdvanceDelayMs: 0, reducedMotionFallback: 'color' },
  serviceChoice: { enabled: true, animationType: 'cardLift', durationMs: 550, delayMs: 0, direction: 'up', intensity: 100, scaleFrom: 1, scaleTo: 1.04, distancePx: 8, easing: 'auto', repeat: 1, repeatDelayMs: 0, holdMs: 0, staggerMs: 0, autoAdvanceDelayMs: 600, reducedMotionFallback: 'highlight' },
  upsell: { enabled: true, animationType: 'slideIn', durationMs: 650, delayMs: 0, direction: 'up', intensity: 100, scaleFrom: 1, scaleTo: 1, distancePx: 0, easing: 'auto', repeat: 1, repeatDelayMs: 0, holdMs: 0, staggerMs: 0, autoAdvanceDelayMs: 0, reducedMotionFallback: 'fade' },
  pageTransition: { enabled: true, animationType: 'slideIn', durationMs: 650, delayMs: 0, direction: 'auto', intensity: 100, scaleFrom: 1, scaleTo: 1, distancePx: 0, easing: 'auto', repeat: 1, repeatDelayMs: 0, holdMs: 0, staggerMs: 0, autoAdvanceDelayMs: 0, reducedMotionFallback: 'fade' },
  payment: { enabled: true, animationType: 'buttonFill', durationMs: 550, delayMs: 0, direction: 'auto', intensity: 100, scaleFrom: 1, scaleTo: 1, distancePx: 0, easing: 'auto', repeat: 1, repeatDelayMs: 0, holdMs: 0, staggerMs: 0, autoAdvanceDelayMs: 0, reducedMotionFallback: 'color' },
  paymentProgress: { enabled: true, animationType: 'progressFill', durationMs: 1200, delayMs: 0, direction: 'auto', intensity: 100, scaleFrom: 1, scaleTo: 1, distancePx: 0, easing: 'easeInOut', repeat: 0, repeatDelayMs: 0, holdMs: 0, staggerMs: 0, autoAdvanceDelayMs: 0, reducedMotionFallback: 'fade' },
  success: { enabled: true, animationType: 'drawCheck', durationMs: 1000, delayMs: 0, direction: 'auto', intensity: 100, scaleFrom: 0.6, scaleTo: 1, distancePx: 0, easing: 'auto', repeat: 1, repeatDelayMs: 0, holdMs: 0, staggerMs: 0, autoAdvanceDelayMs: 0, reducedMotionFallback: 'fade' },
  idle: { enabled: true, animationType: 'floating', durationMs: 2800, delayMs: 0, direction: 'up', intensity: 100, scaleFrom: 1, scaleTo: 1.05, distancePx: 10, easing: 'easeInOut', repeat: 0, repeatDelayMs: 0, holdMs: 0, staggerMs: 0, autoAdvanceDelayMs: 0, reducedMotionFallback: 'none' },
  timeout: { enabled: true, animationType: 'fadeIn', durationMs: 600, delayMs: 0, direction: 'auto', intensity: 100, scaleFrom: 0.96, scaleTo: 1, distancePx: 0, easing: 'auto', repeat: 1, repeatDelayMs: 0, holdMs: 0, staggerMs: 0, autoAdvanceDelayMs: 0, reducedMotionFallback: 'fade' },
  soldOut: { enabled: true, animationType: 'fadeOut', durationMs: 600, delayMs: 0, direction: 'auto', intensity: 100, scaleFrom: 1, scaleTo: 1, distancePx: 0, easing: 'auto', repeat: 1, repeatDelayMs: 0, holdMs: 0, staggerMs: 0, autoAdvanceDelayMs: 0, reducedMotionFallback: 'fade' },
  loading: { enabled: true, animationType: 'skeletonShimmer', durationMs: 1600, delayMs: 0, direction: 'auto', intensity: 100, scaleFrom: 1, scaleTo: 1, distancePx: 0, easing: 'linear', repeat: 0, repeatDelayMs: 0, holdMs: 0, staggerMs: 0, autoAdvanceDelayMs: 0, reducedMotionFallback: 'none' },
  scrollHint: { enabled: true, animationType: 'attentionArrow', durationMs: 1500, delayMs: 800, direction: 'down', intensity: 100, scaleFrom: 1, scaleTo: 1, distancePx: 12, easing: 'easeInOut', repeat: 3, repeatDelayMs: 400, holdMs: 0, staggerMs: 0, autoAdvanceDelayMs: 0, reducedMotionFallback: 'fade' },
  homeReturn: { enabled: true, animationType: 'crossfade', durationMs: 700, delayMs: 0, direction: 'auto', intensity: 100, scaleFrom: 1, scaleTo: 1, distancePx: 0, easing: 'auto', repeat: 1, repeatDelayMs: 0, holdMs: 0, staggerMs: 0, autoAdvanceDelayMs: 0, reducedMotionFallback: 'fade' },
};

/**
 * Each preset as its difference from Standard: Slow — extra clear (×≈1.3), Fast — quick but readable
 * (×≈0.75), custom — Standard set event by event, legacy — the kiosks' pace before the engine.
 */
export const MOTION_PRESET_DELTAS: Record<MotionPreset, Partial<Record<MotionEventKey, Partial<MotionEventValues>>>> = {
  standard: {},
  custom: {},
  slow: {
    productPress: { durationMs: 600 },
    addToCart: { durationMs: 950, holdMs: 1100 },
    cartBadge: { durationMs: 700 },
    toast: { durationMs: 600, holdMs: 2600 },
    modalOpen: { durationMs: 800 },
    select: { durationMs: 650 },
    quantityChange: { durationMs: 650 },
    priceChange: { durationMs: 900 },
    categorySwitch: { durationMs: 750 },
    itemsEnter: { durationMs: 600, staggerMs: 80 },
    cartOpen: { durationMs: 800 },
    remove: { durationMs: 800, holdMs: 5000 },
    continueReady: { durationMs: 800 },
    error: { durationMs: 700 },
    serviceChoice: { durationMs: 700, autoAdvanceDelayMs: 700 },
    upsell: { durationMs: 800 },
    pageTransition: { durationMs: 800 },
    payment: { durationMs: 700 },
    paymentProgress: { durationMs: 1500 },
    success: { durationMs: 1300 },
    idle: { durationMs: 3400 },
    timeout: { durationMs: 750 },
    soldOut: { durationMs: 750 },
    loading: { durationMs: 2000 },
    scrollHint: { durationMs: 1800 },
    homeReturn: { durationMs: 900 },
  },
  fast: {
    productPress: { durationMs: 350 },
    addToCart: { durationMs: 550, holdMs: 800 },
    cartBadge: { durationMs: 450 },
    toast: { durationMs: 350, holdMs: 1600 },
    modalOpen: { durationMs: 500 },
    select: { durationMs: 450 },
    quantityChange: { durationMs: 400 },
    priceChange: { durationMs: 550 },
    categorySwitch: { durationMs: 450 },
    itemsEnter: { durationMs: 350, staggerMs: 45 },
    cartOpen: { durationMs: 500 },
    remove: { durationMs: 500, holdMs: 3500 },
    continueReady: { durationMs: 500 },
    error: { durationMs: 450 },
    serviceChoice: { durationMs: 450, autoAdvanceDelayMs: 500 },
    upsell: { durationMs: 500 },
    pageTransition: { durationMs: 450 },
    payment: { durationMs: 450 },
    paymentProgress: { durationMs: 1000 },
    success: { durationMs: 800 },
    idle: { durationMs: 2400 },
    timeout: { durationMs: 450 },
    soldOut: { durationMs: 450 },
    loading: { durationMs: 1400 },
    scrollHint: { durationMs: 1200 },
    homeReturn: { durationMs: 550 },
  },
  legacy: {
    productPress: { durationMs: 250, scaleTo: 0.97 },
    addToCart: { durationMs: 560, holdMs: 600 },
    cartBadge: { durationMs: 480, reducedMotionFallback: 'none' },
    priceChange: { durationMs: 360, animationType: 'countUp', reducedMotionFallback: 'none' },
    toast: { durationMs: 350, holdMs: 1600 },
    modalOpen: { reducedMotionFallback: 'none' },
    categorySwitch: { reducedMotionFallback: 'none' },
    itemsEnter: { staggerMs: 32 },
    cartOpen: { reducedMotionFallback: 'none' },
    upsell: { reducedMotionFallback: 'none' },
    pageTransition: { reducedMotionFallback: 'none' },
    homeReturn: { reducedMotionFallback: 'none' },
    select: { durationMs: 450 },
    quantityChange: { durationMs: 400 },
    remove: { durationMs: 500, holdMs: 3500 },
    continueReady: { durationMs: 500 },
    error: { durationMs: 450 },
    serviceChoice: { durationMs: 450, autoAdvanceDelayMs: 500 },
    payment: { durationMs: 450 },
    paymentProgress: { durationMs: 1300 },
    success: { durationMs: 800 },
    idle: { durationMs: 2200, animationType: 'pulse', scaleTo: 1.06 },
    timeout: { durationMs: 450 },
    soldOut: { durationMs: 450 },
    loading: { durationMs: 1400 },
    scrollHint: { durationMs: 1200 },
  },
};

type KindMap = Record<string, Partial<MotionEventValues>>;
const PAGE_KINDS: KindMap = {
  slide: { animationType: 'slideIn' },
  fade: { animationType: 'fadeIn' },
  zoom: { animationType: 'fadeScale', scaleFrom: 0.92 },
  none: { animationType: 'none' },
};
const SHEET_KINDS: KindMap = {
  slide_up: { animationType: 'slideIn', direction: 'up' },
  scale: { animationType: 'fadeScale', scaleFrom: 0.94 },
  fade: { animationType: 'fadeIn' },
  none: { animationType: 'none' },
};
/** The older per-transition choices give their event's kind unless the event sets its own. */
export const MOTION_LEGACY_KINDS: Partial<Record<MotionEventKey, { key: string; map: KindMap }>> = {
  categorySwitch: {
    key: 'categorySwitch',
    map: {
      slide: { animationType: 'slideIn' },
      fade: { animationType: 'fadeIn' },
      fade_scale: { animationType: 'fadeScale', scaleFrom: 0.96 },
      push: { animationType: 'swipeTransition' },
      none: { animationType: 'none' },
    },
  },
  itemsEnter: {
    key: 'itemsEnter',
    map: {
      pop: { animationType: 'fadeScale' },
      cascade: { animationType: 'staggeredEntry' },
      rise: { animationType: 'slideIn', direction: 'up' },
      flip: { animationType: 'flip' },
      none: { animationType: 'none' },
    },
  },
  pageTransition: { key: 'screenChange', map: PAGE_KINDS },
  modalOpen: { key: 'sheet', map: SHEET_KINDS },
  addToCart: {
    key: 'addToCart',
    map: { fly: { animationType: 'flyToCart' }, bounce: { animationType: 'bounce' }, none: { animationType: 'none' } },
  },
};
/** Only with "legacy": the events that played the screens' / the windows' transition. */
export const MOTION_LEGACY_ONLY_KINDS: Partial<Record<MotionEventKey, { key: string; map: KindMap }>> = {
  cartOpen: { key: 'screenChange', map: PAGE_KINDS },
  homeReturn: { key: 'screenChange', map: PAGE_KINDS },
  upsell: { key: 'sheet', map: SHEET_KINDS },
};

const LEGACY_PAGE_MS: Partial<Record<MotionType, number>> = { slideIn: 220, fadeIn: 180, fadeScale: 200, swipeTransition: 260, crossfade: 180 };
const LEGACY_SHEET_MS: Partial<Record<MotionType, number>> = { slideIn: 260, fadeScale: 220, fadeIn: 180, expand: 220, morph: 220 };
/** "legacy": the transitions' times by their kind at normal speed (kiosk_motion_timings.json). */
export const MOTION_LEGACY_DURATIONS: Partial<Record<MotionEventKey, Partial<Record<MotionType, number>>>> = {
  categorySwitch: { slideIn: 240, fadeIn: 200, fadeScale: 220, swipeTransition: 280, crossfade: 200 },
  itemsEnter: { staggeredEntry: 260, fadeScale: 260, slideIn: 280, flip: 300, fadeIn: 260 },
  pageTransition: LEGACY_PAGE_MS,
  cartOpen: LEGACY_PAGE_MS,
  homeReturn: LEGACY_PAGE_MS,
  modalOpen: LEGACY_SHEET_MS,
  upsell: LEGACY_SHEET_MS,
};

/** The staggered entry's gap by the cards' kind, as a share of the event's staggerMs. */
export const MOTION_STAGGER_FACTORS: Partial<Record<MotionType, number>> = { staggeredEntry: 1, fadeScale: 0.5, slideIn: 0.75, flip: 0.875, fadeIn: 0.5 };

/**
 * The light profile: the screens and windows fade, no cascade, the moving extras give way — but a
 * change of screen stays clearly seen (the owner on a light-profile kiosk, 08.10.2026: "המעבר ממסך
 * ראשי לתפריט בקיוסק לא מונפש"): a sliding kind stays a short slide (screenShiftPx, fading in as it
 * comes), none shorter than screenMinMs unless its time is set — in every preset, "legacy" too.
 */
export const MOTION_LIGHT = {
  fadeEvents: ['categorySwitch', 'pageTransition', 'modalOpen', 'cartOpen', 'upsell', 'homeReturn'] as readonly MotionEventKey[],
  noneEvents: ['itemsEnter'] as readonly MotionEventKey[],
  replace: { confetti: 'drawCheck', parallaxLight: 'floating', skeletonShimmer: 'none' } as Partial<Record<MotionType, MotionType>>,
  screenEvents: ['pageTransition', 'cartOpen', 'homeReturn'] as readonly MotionEventKey[],
  slideKinds: ['slideIn', 'swipeTransition'] as readonly MotionType[],
  screenShiftPx: 40,
  screenMinMs: 400,
};
/** Reduced motion's fade for the events that take something away. */
export const MOTION_LEAVING_EVENTS: readonly MotionEventKey[] = ['remove', 'soldOut'];

/** One event as the kiosk plays it. */
export interface ResolvedMotion extends MotionEventValues {
  event: MotionEventKey;
  /** itemsEnter: the last staggered card starts no later than this; else 0. */
  staggerCapMs: number;
  /** Reduced motion's fallback was applied. */
  reduced: boolean;
}
export type ResolvedMotionEngine = Record<MotionEventKey, ResolvedMotion>;
export type MotionProfile = 'full' | 'light';

/** Rounding as every renderer does it: halves up. */
export function roundHalfUp(x: number): number {
  return Math.floor(x + 0.5);
}

/**
 * An event's duration (spec §7, §13): its explicit override as is — it ignores the global speed —
 * else its default times the global multiplier. resolveDuration(1.3, 700) = 910;
 * resolveDuration(1.3, 700, 1050) = 1050.
 */
export function resolveDuration(globalMultiplier: number, eventDefault: number, override?: number | null): number {
  if (override !== undefined && override !== null) return Math.trunc(override);
  return roundHalfUp(eventDefault * globalMultiplier);
}

function isDict(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function isMotionEvent(v: unknown): v is MotionEventKey {
  return typeof v === 'string' && (MOTION_EVENTS as readonly string[]).includes(v);
}

export function motionPresetOf(motion: MotionEngineSettings | null | undefined): MotionPreset {
  const p = motion?.preset;
  return typeof p === 'string' && (MOTION_PRESETS as readonly string[]).includes(p) ? (p as MotionPreset) : DEFAULT_MOTION_PRESET;
}

/** The global speed (slow 1.3 / normal 1 / fast 0.75 / custom), else the older `speed`; light caps it at fast. */
export function globalMultiplier(motion: MotionEngineSettings | null | undefined, profile: MotionProfile = 'full'): number {
  const gs = motion?.globalSpeed;
  let k: number;
  if (gs === 'slow' || gs === 'normal' || gs === 'fast') k = MOTION_SPEED_FACTORS[gs];
  else if (gs === 'custom') {
    const raw = motion?.speedMultiplier;
    k = typeof raw === 'number' && Number.isFinite(raw) ? raw : 1;
    k = Math.min(MOTION_MULTIPLIER_MAX, Math.max(MOTION_MULTIPLIER_MIN, k));
  } else {
    const speed = motion?.speed;
    k = typeof speed === 'string' && speed in LEGACY_SPEED_FACTORS ? LEGACY_SPEED_FACTORS[speed] : 1;
  }
  return profile === 'light' ? Math.min(k, LIGHT_MAX_MULTIPLIER) : k;
}

/** The preset's own values of an event (before the older choices and the overrides). */
export function presetValues(preset: MotionPreset, event: MotionEventKey): MotionEventValues {
  return { ...MOTION_STANDARD[event], ...(MOTION_PRESET_DELTAS[preset]?.[event] ?? {}) };
}

/** A parameter's range for an event (its own, narrower, when it has one). */
export function motionParamRange(event: MotionEventKey, param: MotionParam): { min: number; max: number } | null {
  const own = MOTION_EVENT_PARAM_RANGES[event]?.[param];
  if (own) return own;
  const spec = MOTION_PARAMS[param];
  return spec.min !== undefined && spec.max !== undefined ? { min: spec.min, max: spec.max } : null;
}

/** Whether `value` is a valid value of `param` for `event` (the server's validation, the same rule). */
export function motionParamOk(event: MotionEventKey, param: MotionParam, value: unknown): boolean {
  const spec = MOTION_PARAMS[param];
  if (!spec) return false;
  switch (spec.kind) {
    case 'bool':
      return typeof value === 'boolean';
    case 'type':
      return typeof value === 'string' && (MOTION_EVENT_TYPES[event] as readonly string[]).includes(value);
    case 'enum':
      return typeof value === 'string' && (spec.values ?? []).includes(value);
    default: {
      if (typeof value !== 'number' || !Number.isFinite(value)) return false;
      if (spec.kind === 'int' && !Number.isInteger(value)) return false;
      const r = motionParamRange(event, param);
      return !r || (value >= r.min && value <= r.max);
    }
  }
}

/** The event's own values (`motion.events.<event>`) that are valid; the rest is ignored. */
export function explicitOf(motion: MotionEngineSettings | null | undefined, event: MotionEventKey): MotionEventOverrides {
  const events = motion?.events;
  const raw = isDict(events) ? events[event] : undefined;
  if (!isDict(raw)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined || !(k in MOTION_PARAMS)) continue;
    if (motionParamOk(event, k as MotionParam, v)) out[k] = v;
  }
  return out as MotionEventOverrides;
}

export interface MotionResolveOptions {
  reduceMotion?: boolean;
  profile?: MotionProfile;
}

/** One event as the kiosk plays it (the module's five steps). */
export function resolveMotionEvent(
  motion: MotionEngineSettings | null | undefined,
  event: MotionEventKey,
  opts: MotionResolveOptions = {},
): ResolvedMotion {
  const m: MotionEngineSettings = motion ?? {};
  const profile = opts.profile ?? 'full';
  const reduce = !!opts.reduceMotion;
  const preset = motionPresetOf(m);
  const base: MotionEventValues = presetValues(preset, event);
  const kinds = MOTION_LEGACY_KINDS[event] ?? (preset === 'legacy' ? MOTION_LEGACY_ONLY_KINDS[event] : undefined);
  if (kinds) {
    const old = (m as Record<string, unknown>)[kinds.key];
    if (typeof old === 'string' && Object.prototype.hasOwnProperty.call(kinds.map, old)) Object.assign(base, kinds.map[old]);
  }
  const explicit = explicitOf(m, event);
  const p: MotionEventValues = { ...base, ...explicit };
  let kind: MotionType = (MOTION_EVENT_TYPES[event] as readonly string[]).includes(p.animationType)
    ? p.animationType
    : MOTION_STANDARD[event].animationType;
  if (!p.enabled) kind = 'none';
  const k = globalMultiplier(m, profile);
  let distance = Math.trunc(p.distancePx);
  const lightScreen = profile === 'light' && !reduce && kind !== 'none' && MOTION_LIGHT.screenEvents.includes(event);
  if (profile === 'light' && !reduce && kind !== 'none') {
    if (MOTION_LIGHT.noneEvents.includes(event)) kind = 'none';
    else if (lightScreen && MOTION_LIGHT.slideKinds.includes(kind)) {
      kind = 'slideIn';
      if (!(distance > 0 && distance <= MOTION_LIGHT.screenShiftPx)) distance = MOTION_LIGHT.screenShiftPx;
    } else if (MOTION_LIGHT.fadeEvents.includes(event)) kind = 'fadeIn';
    else {
      kind = MOTION_LIGHT.replace[kind] ?? kind;
      if (!(MOTION_EVENT_TYPES[event] as readonly string[]).includes(kind)) kind = 'none';
    }
  }
  let baseMs = base.durationMs;
  if (preset === 'legacy') baseMs = MOTION_LEGACY_DURATIONS[event]?.[kind] ?? baseMs;
  let duration = resolveDuration(k, baseMs, explicit.durationMs);
  if (lightScreen && explicit.durationMs === undefined) duration = Math.max(duration, MOTION_LIGHT.screenMinMs);
  let staggerBase = base.staggerMs;
  if (event === 'itemsEnter') staggerBase = roundHalfUp(staggerBase * (MOTION_STAGGER_FACTORS[kind] ?? 1));
  const stagger = resolveDuration(k, staggerBase, explicit.staggerMs);
  let out: ResolvedMotion = {
    event,
    enabled: !!p.enabled,
    animationType: kind,
    durationMs: duration,
    delayMs: resolveDuration(k, base.delayMs, explicit.delayMs),
    direction: p.direction,
    intensity: Math.trunc(p.intensity),
    scaleFrom: p.scaleFrom,
    scaleTo: p.scaleTo,
    distancePx: distance,
    easing: p.easing,
    repeat: Math.trunc(p.repeat),
    repeatDelayMs: resolveDuration(k, base.repeatDelayMs, explicit.repeatDelayMs),
    holdMs: Math.trunc(p.holdMs),
    staggerMs: kind !== 'none' ? stagger : 0,
    staggerCapMs: 0,
    autoAdvanceDelayMs: Math.trunc(p.autoAdvanceDelayMs),
    reducedMotionFallback: p.reducedMotionFallback,
    reduced: false,
  };
  if (event === 'remove') out.holdMs = Math.max(out.holdMs, REMOVE_MIN_HOLD_MS);
  if (event === 'itemsEnter' && kind !== 'none') {
    out.staggerCapMs = preset === 'legacy' ? roundHalfUp(LEGACY_STAGGER_CAP_MS * k) : out.staggerMs * STAGGER_CAP_STEPS;
  }
  if (kind === 'none') out.durationMs = 0;
  if (reduce && kind !== 'none') out = reducedOf(out);
  return out;
}

/** Reduced motion (spec §14): no movement; the event's fallback — a fade, a highlight, a colour change, or none. */
function reducedOf(spec: ResolvedMotion): ResolvedMotion {
  const fallback = spec.reducedMotionFallback;
  const out: ResolvedMotion = {
    ...spec,
    reduced: true,
    direction: 'auto',
    scaleFrom: 1,
    scaleTo: 1,
    distancePx: 0,
    staggerMs: 0,
    staggerCapMs: 0,
    delayMs: 0,
    repeatDelayMs: 0,
  };
  if (fallback === 'none') return { ...out, animationType: 'none', durationMs: 0, repeat: 1 };
  out.animationType = fallback === 'fade' ? (MOTION_LEAVING_EVENTS.includes(spec.event) ? 'fadeOut' : 'fadeIn') : 'highlight';
  out.durationMs = roundHalfUp(spec.durationMs * REDUCED_FACTOR);
  // Never a loop that keeps pulsing (no flashing): once.
  out.repeat = 1;
  return out;
}

/** Every event as the kiosk plays it. */
export function resolveMotionEngine(motion: MotionEngineSettings | null | undefined, opts: MotionResolveOptions = {}): ResolvedMotionEngine {
  const out = {} as ResolvedMotionEngine;
  for (const e of MOTION_EVENTS) out[e] = resolveMotionEvent(motion, e, opts);
  return out;
}

/** Whether an event plays at all (enabled, a kind, and time to play it). */
export function motionActive(spec: Pick<ResolvedMotion, 'animationType' | 'durationMs'>): boolean {
  return spec.animationType !== 'none' && spec.durationMs > 0;
}

/**
 * The older `speed` closest to a global speed (the editor writes both, so a kiosk with an older
 * app keeps the pace): slow → relaxed, fast → fast, custom by its multiplier.
 */
export function speedOfGlobal(globalSpeed: string | null | undefined, multiplier?: number | null): 'fast' | 'normal' | 'relaxed' {
  if (globalSpeed === 'slow') return 'relaxed';
  if (globalSpeed === 'fast') return 'fast';
  if (globalSpeed === 'custom' && typeof multiplier === 'number') return multiplier <= 0.85 ? 'fast' : multiplier >= 1.2 ? 'relaxed' : 'normal';
  return 'normal';
}

/** The global speed a config plays at, as the editor shows it (null global speed: the older `speed`'s). */
export function effectiveGlobalSpeed(motion: MotionEngineSettings | null | undefined): { speed: MotionGlobalSpeed; multiplier: number } {
  const gs = motion?.globalSpeed;
  if (gs === 'slow' || gs === 'normal' || gs === 'fast') return { speed: gs, multiplier: MOTION_SPEED_FACTORS[gs] };
  if (gs === 'custom') return { speed: 'custom', multiplier: globalMultiplier(motion) };
  const k = globalMultiplier(motion);
  if (k === 1) return { speed: 'normal', multiplier: 1 };
  if (k === 0.75) return { speed: 'fast', multiplier: 0.75 };
  return { speed: 'custom', multiplier: k };
}

/** The older per-transition choice an event's kind writes too (so an older kiosk app keeps the kind), or null. */
export function legacyChoiceOf(event: MotionEventKey, kind: MotionType, scaleFrom?: number): { key: string; value: string } | null {
  switch (event) {
    case 'categorySwitch': {
      const v = { slideIn: 'slide', fadeIn: 'fade', fadeScale: 'fade_scale', swipeTransition: 'push', crossfade: 'fade', none: 'none' }[kind as string];
      return v ? { key: 'categorySwitch', value: v } : null;
    }
    case 'itemsEnter': {
      const v = { staggeredEntry: 'cascade', fadeScale: 'pop', slideIn: 'rise', flip: 'flip', fadeIn: 'pop', none: 'none' }[kind as string];
      return v ? { key: 'itemsEnter', value: v } : null;
    }
    case 'pageTransition': {
      const v =
        kind === 'fadeScale' ? (scaleFrom !== undefined && scaleFrom > 0.94 ? 'fade' : 'zoom') : { slideIn: 'slide', fadeIn: 'fade', crossfade: 'fade', swipeTransition: 'slide', none: 'none' }[kind as string];
      return v ? { key: 'screenChange', value: v } : null;
    }
    case 'modalOpen': {
      const v = { slideIn: 'slide_up', fadeScale: 'scale', fadeIn: 'fade', expand: 'scale', morph: 'scale', none: 'none' }[kind as string];
      return v ? { key: 'sheet', value: v } : null;
    }
    case 'addToCart': {
      const v = { flyToCart: 'fly', bounce: 'bounce', fadeOut: 'bounce', none: 'none' }[kind as string];
      return v ? { key: 'addToCart', value: v } : null;
    }
    default:
      return null;
  }
}

/** A curve by name as CSS, or `fallback` for "auto". */
export function motionCurve(easing: MotionEasing | string, fallback: string): string {
  const c = MOTION_EASING_CURVES[easing as Exclude<MotionEasing, 'auto'>];
  if (!c) return fallback;
  return `cubic-bezier(${c.map((n) => String(n).replace(/^0\./, '.')).join(',')})`;
}

/** The CSS custom properties of an event, for the web kiosks' keyframes (`--m-<event>-ms` …). */
export function motionCssVars(engine: ResolvedMotionEngine): Record<string, string> {
  const out: Record<string, string> = {};
  for (const e of MOTION_EVENTS) {
    const s = engine[e];
    out[`--m-${e}-ms`] = `${motionActive(s) ? s.durationMs : 0}ms`;
    out[`--m-${e}-delay`] = `${s.delayMs}ms`;
    out[`--m-${e}-k`] = String(s.intensity / 100);
  }
  return out;
}
