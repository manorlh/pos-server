/**
 * "הנפשות" in the dashboard's kiosk editor (section-motion.tsx): the pure helpers behind the Motion
 * Engine's management screen (spec §9–§11) — the events in groups, where each value comes from (this
 * level, a level above, the preset), every edit as the minimal `motion.events` layer plus the older
 * key an older kiosk app follows, copying an event's values to another, the global speed as the keys
 * both app generations read, and the duration's arithmetic (resolveDuration) shown beside it.
 *
 * Pure and self-contained (relative imports only), like the engine it reads (lib/kioskMotionEngine.ts).
 */

import {
  MOTION_LEGACY_KINDS,
  MOTION_MULTIPLIER_MAX,
  MOTION_MULTIPLIER_MIN,
  MOTION_PARAMS,
  effectiveGlobalSpeed,
  explicitOf,
  globalMultiplier,
  isMotionEvent,
  legacyChoiceOf,
  motionParamOk,
  motionPresetOf,
  presetValues,
  resolveDuration,
  resolveMotionEvent,
  speedOfGlobal,
  type MotionEngineSettings,
  type MotionEventKey,
  type MotionEventValues,
  type MotionGlobalSpeed,
  type MotionParam,
  type MotionPreset,
  type MotionProfile,
  type MotionType,
} from './kioskMotionEngine';

type Dict = Record<string, unknown>;

function isDict(v: unknown): v is Dict {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function present(v: unknown): boolean {
  return v !== undefined && v !== null;
}

/* ------------------------------------------------------------ the groups */

export type MotionEventGroup = 'products' | 'navigation' | 'payment' | 'waiting';

/** The events as the screen lists them (spec §4): every event exactly once. */
export const MOTION_EVENT_GROUPS: readonly { key: MotionEventGroup; events: readonly MotionEventKey[] }[] = [
  {
    key: 'products',
    events: ['productPress', 'select', 'addToCart', 'cartBadge', 'quantityChange', 'priceChange', 'cartOpen', 'remove', 'soldOut', 'upsell'],
  },
  { key: 'navigation', events: ['categorySwitch', 'itemsEnter', 'pageTransition', 'modalOpen', 'serviceChoice', 'scrollHint', 'homeReturn'] },
  { key: 'payment', events: ['continueReady', 'payment', 'paymentProgress', 'success', 'error', 'toast'] },
  { key: 'waiting', events: ['idle', 'timeout', 'loading'] },
];

/** The basic parameters every event row shows; the rest sit under "מתקדם". */
export const MOTION_BASIC_PARAMS: readonly MotionParam[] = ['animationType', 'durationMs', 'delayMs', 'direction', 'intensity', 'easing', 'repeat'];
export const MOTION_ADVANCED_PARAMS: readonly MotionParam[] = [
  'scaleFrom',
  'scaleTo',
  'distancePx',
  'repeatDelayMs',
  'holdMs',
  'staggerMs',
  'autoAdvanceDelayMs',
  'reducedMotionFallback',
];

/** The four durations each preset card shows (spec §8: Press | Add | Page | Success). */
export const PRESET_EXAMPLE_EVENTS = ['productPress', 'addToCart', 'pageTransition', 'success'] as const;
export type PresetExampleEvent = (typeof PRESET_EXAMPLE_EVENTS)[number];

/** A preset's own pace at normal speed: what its card shows. */
export function presetExample(preset: MotionPreset): Record<PresetExampleEvent, number> {
  const out = {} as Record<PresetExampleEvent, number>;
  for (const e of PRESET_EXAMPLE_EVENTS) out[e] = resolveMotionEvent({ preset, globalSpeed: 'normal' }, e).durationMs;
  return out;
}

/* ---------------------------------------------------------- the sources */

/** Where a value comes from: set at this level, set by a level above, or the preset's. */
export type MotionValueSource = 'here' | 'parent' | 'preset';

/** The event's own values as stored (`motion.events.<event>`), valid or not; {} when none. */
export function eventLayer(motion: MotionEngineSettings | null | undefined, event: MotionEventKey): Dict {
  const events = motion?.events;
  const raw = isDict(events) ? events[event] : undefined;
  return isDict(raw) ? raw : {};
}

/** The older per-transition key an event's kind follows (and writes too), or null. */
export function legacyKeyOf(event: MotionEventKey): string | null {
  return MOTION_LEGACY_KINDS[event]?.key ?? null;
}

/** One parameter of an event: this level's own value, a level above's, or the preset's. */
export function motionParamSource(
  draft: MotionEngineSettings | null | undefined,
  inherited: MotionEngineSettings | null | undefined,
  event: MotionEventKey,
  param: MotionParam,
): MotionValueSource {
  const mine = eventLayer(draft, event)[param];
  const theirs = eventLayer(inherited, event)[param];
  if (present(mine) && mine !== theirs) return 'here';
  if (present(theirs)) return 'parent';
  return 'preset';
}

/** An event as a whole: any value of its own here (or its older kind key), else a level above's, else the preset. */
export function motionEventSource(
  draft: MotionEngineSettings | null | undefined,
  inherited: MotionEngineSettings | null | undefined,
  event: MotionEventKey,
): MotionValueSource {
  const mine = eventLayer(draft, event);
  const theirs = eventLayer(inherited, event);
  let parent = false;
  for (const key of new Set([...Object.keys(mine), ...Object.keys(theirs)])) {
    if (present(mine[key]) && mine[key] !== theirs[key]) return 'here';
    if (present(theirs[key])) parent = true;
  }
  const lk = legacyKeyOf(event);
  if (lk) {
    const a = (draft as Dict | null | undefined)?.[lk];
    const b = (inherited as Dict | null | undefined)?.[lk];
    if (present(a) && a !== b) return 'here';
  }
  return parent ? 'parent' : 'preset';
}

/** How many events have values of their own (valid ones), and how many are switched off. */
export function motionEventCounts(motion: MotionEngineSettings | null | undefined): { custom: number; off: number } {
  let custom = 0;
  let off = 0;
  const events = isDict(motion?.events) ? (motion?.events as Dict) : {};
  for (const key of Object.keys(events)) {
    if (!isMotionEvent(key)) continue;
    if (Object.keys(explicitOf(motion, key)).length > 0) custom += 1;
    if (!resolveMotionEvent(motion, key).enabled) off += 1;
  }
  return { custom, off };
}

/* ------------------------------------------------------------ the view */

export interface MotionDurationView {
  /** The duration before the global speed (the preset's, or legacy's by kind), or the override. */
  baseMs: number;
  /** The global speed's multiplier. */
  multiplier: number;
  /** What the event plays (resolveDuration). */
  ms: number;
  /** An override of its own: it ignores the global speed. */
  explicit: boolean;
}

function withEventLayer(motion: MotionEngineSettings | null | undefined, event: MotionEventKey, layer: Dict): MotionEngineSettings {
  const events = isDict(motion?.events) ? (motion?.events as Dict) : {};
  return { ...(motion ?? {}), events: { ...events, [event]: layer } };
}

/** The duration's arithmetic (spec §7): "700ms × 1.30 = 910ms", or the override as is. */
export function motionDurationView(motion: MotionEngineSettings | null | undefined, event: MotionEventKey, profile: MotionProfile = 'full'): MotionDurationView {
  const k = globalMultiplier(motion, profile);
  const own = explicitOf(motion, event).durationMs;
  if (own !== undefined) return { baseMs: own, multiplier: k, ms: own, explicit: true };
  // The event switched on at the normal pace, its own duration left out: the base.
  const layer: Dict = { ...eventLayer(motion, event), enabled: true };
  delete layer.durationMs;
  const atNormal = resolveMotionEvent({ ...withEventLayer(motion, event, layer), globalSpeed: 'normal' }, event);
  const baseMs = atNormal.animationType !== 'none' ? atNormal.durationMs : presetValues(motionPresetOf(motion), event).durationMs;
  return { baseMs, multiplier: k, ms: resolveDuration(k, baseMs), explicit: false };
}

/**
 * An event as configured at a level, for its controls: every value as it resolves (the global
 * speed in the timings), the kind even while the event is switched off, no reduced motion, the
 * full profile — and a kind of "ללא" still shows the time it would take.
 */
export function motionEventView(motion: MotionEngineSettings | null | undefined, event: MotionEventKey): MotionEventValues {
  const on = resolveMotionEvent(withEventLayer(motion, event, { ...eventLayer(motion, event), enabled: true }), event);
  const k = globalMultiplier(motion);
  const own = explicitOf(motion, event);
  const base = presetValues(motionPresetOf(motion), event);
  const values: MotionEventValues = {
    enabled: resolveMotionEvent(motion, event).enabled,
    animationType: on.animationType,
    durationMs: motionDurationView(motion, event).ms,
    delayMs: on.delayMs,
    direction: on.direction,
    intensity: on.intensity,
    scaleFrom: on.scaleFrom,
    scaleTo: on.scaleTo,
    distancePx: on.distancePx,
    easing: on.easing,
    repeat: on.repeat,
    repeatDelayMs: on.repeatDelayMs,
    holdMs: on.holdMs,
    staggerMs: on.animationType === 'none' ? resolveDuration(k, base.staggerMs, own.staggerMs) : on.staggerMs,
    autoAdvanceDelayMs: on.autoAdvanceDelayMs,
    reducedMotionFallback: on.reducedMotionFallback,
  };
  return values;
}

/* ------------------------------------------------------------ the edits */

/** One write to the draft: a value at `path`, or (`reset`) back to what this level inherits there. */
export interface MotionEdit {
  path: string;
  value?: unknown;
  reset?: boolean;
}

/**
 * The event's layer after setting `param` to `value` — or, with `value` undefined, back to what this
 * level inherits. Undefined when nothing is left and nothing is inherited (the event leaves `events`).
 */
export function withEventParam(
  draft: MotionEngineSettings | null | undefined,
  inherited: MotionEngineSettings | null | undefined,
  event: MotionEventKey,
  param: MotionParam,
  value: unknown,
): Dict | undefined {
  const next: Dict = { ...eventLayer(draft, event) };
  if (value === undefined) {
    const inh = eventLayer(inherited, event)[param];
    if (present(inh)) next[param] = inh;
    else delete next[param];
  } else next[param] = value;
  const inheritedLayer = eventLayer(inherited, event);
  return Object.keys(next).length === 0 && Object.keys(inheritedLayer).length === 0 ? undefined : next;
}

/** The older key a layer's kind writes (an older kiosk app keeps the kind), or its reset. */
function legacyEdits(draft: MotionEngineSettings | null | undefined, event: MotionEventKey, layer: Dict | undefined): MotionEdit[] {
  const lk = legacyKeyOf(event);
  if (!lk) return [];
  const kind = layer?.animationType;
  if (typeof kind !== 'string' || !motionParamOk(event, 'animationType', kind)) return [{ path: `motion.${lk}`, reset: true }];
  const sf = typeof layer?.scaleFrom === 'number' ? layer.scaleFrom : presetValues(motionPresetOf(draft), event).scaleFrom;
  const choice = legacyChoiceOf(event, kind as MotionType, sf);
  return choice ? [{ path: `motion.${choice.key}`, value: choice.value }] : [];
}

/**
 * One control's change: `value` for `param` (undefined: back to what this level inherits). Switching
 * an event back on where nothing above switched it off leaves no value behind; the kind of one of the
 * five older transitions (and pageTransition's scale, fade or zoom) writes the older key too.
 */
export function motionParamEdits(
  draft: MotionEngineSettings | null | undefined,
  inherited: MotionEngineSettings | null | undefined,
  event: MotionEventKey,
  param: MotionParam,
  value: unknown,
): MotionEdit[] {
  let v = value;
  if (param === 'enabled' && v !== undefined) {
    const inh = eventLayer(inherited, event).enabled;
    const fallback = typeof inh === 'boolean' ? inh : presetValues(motionPresetOf(draft), event).enabled;
    if (v === fallback) v = undefined;
  }
  const layer = withEventParam(draft, inherited, event, param, v);
  const edits: MotionEdit[] = [{ path: `motion.events.${event}`, value: layer }];
  // pageTransition's scale tells the older "fade" from "zoom".
  if (param === 'animationType' || (param === 'scaleFrom' && event === 'pageTransition' && present(layer?.animationType))) {
    edits.push(...legacyEdits(draft, event, layer));
  }
  return edits;
}

/** "אפס לברירת מחדל" of one event: its layer, and its older kind key, back to what this level inherits. */
export function motionEventResetEdits(event: MotionEventKey): MotionEdit[] {
  const out: MotionEdit[] = [{ path: `motion.events.${event}`, reset: true }];
  const lk = legacyKeyOf(event);
  if (lk) out.push({ path: `motion.${lk}`, reset: true });
  return out;
}

export interface MotionCopy {
  edits: MotionEdit[];
  copied: MotionParam[];
  /** Values the target cannot take (a kind it does not play, a range of its own). */
  skipped: MotionParam[];
}

/**
 * "העתק הגדרה": the source event's own values onto the target — only those valid for the target
 * (motionParamOk: its kinds, its ranges), over the target's own.
 */
export function motionCopyEdits(draft: MotionEngineSettings | null | undefined, from: MotionEventKey, to: MotionEventKey): MotionCopy {
  const copied: MotionParam[] = [];
  const skipped: MotionParam[] = [];
  const next: Dict = { ...eventLayer(draft, to) };
  for (const [key, value] of Object.entries(eventLayer(draft, from))) {
    if (!(key in MOTION_PARAMS) || !present(value)) continue;
    const param = key as MotionParam;
    if (motionParamOk(to, param, value)) {
      next[param] = value;
      copied.push(param);
    } else skipped.push(param);
  }
  if (copied.length === 0) return { edits: [], copied, skipped };
  const edits: MotionEdit[] = [{ path: `motion.events.${to}`, value: next }];
  if (copied.includes('animationType')) edits.push(...legacyEdits(draft, to, next));
  return { edits, copied, skipped };
}

/** A custom multiplier as the editor keeps it: 0.50–2.00 in steps of 0.05. */
export function clampMultiplier(k: number): number {
  const n = Number.isFinite(k) ? k : 1;
  const stepped = Math.round(Math.min(MOTION_MULTIPLIER_MAX, Math.max(MOTION_MULTIPLIER_MIN, n)) * 20) / 20;
  return Number(stepped.toFixed(2));
}

/**
 * A global speed as the three keys: `globalSpeed`, the custom `speedMultiplier`, and the older
 * `speed` closest to it (speedOfGlobal), so a kiosk with an older app keeps the pace.
 */
export function globalSpeedEdits(speed: MotionGlobalSpeed, multiplier?: number): MotionEdit[] {
  if (speed === 'custom') {
    const k = clampMultiplier(multiplier ?? 1);
    return [
      { path: 'motion.globalSpeed', value: 'custom' },
      { path: 'motion.speedMultiplier', value: k },
      { path: 'motion.speed', value: speedOfGlobal('custom', k) },
    ];
  }
  return [
    { path: 'motion.globalSpeed', value: speed },
    { path: 'motion.speed', value: speedOfGlobal(speed) },
  ];
}

/** The global speed back to what this level inherits (with the older `speed` beside it). */
export const GLOBAL_SPEED_RESET: readonly MotionEdit[] = [
  { path: 'motion.globalSpeed', reset: true },
  { path: 'motion.speedMultiplier', reset: true },
  { path: 'motion.speed', reset: true },
];

/** The speed the editor shows: the chosen one, or (none chosen) the older `speed`'s, marked as such. */
export function globalSpeedView(motion: MotionEngineSettings | null | undefined): { speed: MotionGlobalSpeed; multiplier: number; fromOlder: boolean } {
  const eff = effectiveGlobalSpeed(motion);
  const gs = motion?.globalSpeed;
  return { ...eff, fromOlder: gs === null || gs === undefined };
}
