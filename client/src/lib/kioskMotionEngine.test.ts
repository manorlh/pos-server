/**
 * Run with `npm test`. "מנוע הנפשות" — the kiosk's Motion Engine (lib/kioskMotionEngine.ts) against
 * the shared golden server/tests/fixtures/kiosk_motion_engine.json (byte-identical in pos-android,
 * pinned there by KioskMotionEngineTest and on the server by tests/test_kiosk_motion.py).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_MOTION_PRESET,
  LEGACY_SPEED_FACTORS,
  LIGHT_MAX_MULTIPLIER,
  MOTION_DIRECTIONS,
  MOTION_EASINGS,
  MOTION_EASING_CURVES,
  MOTION_EVENTS,
  MOTION_EVENT_PARAM_RANGES,
  MOTION_EVENT_TYPES,
  MOTION_FALLBACKS,
  MOTION_GLOBAL_SPEEDS,
  MOTION_LEAVING_EVENTS,
  MOTION_LEGACY_DURATIONS,
  MOTION_LEGACY_KINDS,
  MOTION_LEGACY_ONLY_KINDS,
  MOTION_LIGHT,
  MOTION_PARAMS,
  MOTION_PRESETS,
  MOTION_PRESET_DELTAS,
  MOTION_SPEED_FACTORS,
  MOTION_STAGGER_FACTORS,
  MOTION_STANDARD,
  MOTION_TIMING_PARAMS,
  MOTION_TYPES,
  REDUCED_FACTOR,
  REMOVE_MIN_HOLD_MS,
  effectiveGlobalSpeed,
  explicitOf,
  globalMultiplier,
  legacyChoiceOf,
  motionActive,
  motionCssVars,
  motionCurve,
  motionParamOk,
  resolveDuration,
  resolveMotionEngine,
  resolveMotionEvent,
  speedOfGlobal,
  type MotionEngineSettings,
  type MotionEventKey,
} from './kioskMotionEngine';
import { KIOSK_DEFAULTS, resolveKioskConfig, validateKioskConfig } from './kioskConfig';

const fixture = (name: string) => JSON.parse(readFileSync(join(process.cwd(), '..', 'server', 'tests', 'fixtures', name), 'utf8'));
const gold = fixture('kiosk_motion_engine.json');
const oldGold = fixture('kiosk_motion_timings.json');

describe('the Motion Engine is the golden\'s, table for table', () => {
  it('the vocabulary: events, the library of kinds, directions, curves, fallbacks, presets, speeds', () => {
    assert.deepEqual([...MOTION_EVENTS], gold.events);
    assert.deepEqual([...MOTION_TYPES], gold.types);
    assert.ok(MOTION_TYPES.filter((t) => t !== 'none').length >= 30, 'the spec\'s library of 30+');
    assert.deepEqual(MOTION_EVENT_TYPES, gold.eventTypes);
    assert.deepEqual([...MOTION_DIRECTIONS], gold.directions);
    assert.deepEqual([...MOTION_EASINGS], gold.easings);
    assert.deepEqual(MOTION_EASING_CURVES, gold.easingCurves);
    assert.deepEqual([...MOTION_FALLBACKS], gold.fallbacks);
    assert.deepEqual([...MOTION_PRESETS], gold.presets);
    assert.equal(DEFAULT_MOTION_PRESET, gold.defaultPreset);
    assert.deepEqual([...MOTION_GLOBAL_SPEEDS], gold.globalSpeeds);
    assert.deepEqual(MOTION_SPEED_FACTORS, gold.speedFactors);
    assert.deepEqual(LEGACY_SPEED_FACTORS, gold.legacySpeedFactors);
    assert.equal(LIGHT_MAX_MULTIPLIER, gold.lightMaxMultiplier);
    assert.equal(REDUCED_FACTOR, gold.reducedFactor);
    assert.equal(REMOVE_MIN_HOLD_MS, gold.removeMinHoldMs);
    assert.deepEqual([...MOTION_TIMING_PARAMS], gold.timingParams);
  });

  it('the parameters and their ranges', () => {
    assert.deepEqual(Object.keys(MOTION_PARAMS), Object.keys(gold.params));
    for (const [name, spec] of Object.entries(gold.params as Record<string, { kind: string; min?: number; max?: number }>)) {
      const mine = MOTION_PARAMS[name as keyof typeof MOTION_PARAMS];
      assert.equal(mine.kind, spec.kind, name);
      assert.equal(mine.min, spec.min, name);
      assert.equal(mine.max, spec.max, name);
    }
    assert.deepEqual(MOTION_EVENT_PARAM_RANGES, gold.eventParamRanges);
  });

  it('the presets, the older choices, legacy\'s times, the light profile', () => {
    assert.deepEqual(MOTION_STANDARD, gold.standard);
    assert.deepEqual(MOTION_PRESET_DELTAS, gold.presetDeltas);
    assert.deepEqual(MOTION_LEGACY_KINDS, gold.legacyKinds);
    assert.deepEqual(MOTION_LEGACY_ONLY_KINDS, gold.legacyOnlyKinds);
    assert.deepEqual(MOTION_LEGACY_DURATIONS, gold.legacyDurations);
    assert.deepEqual(MOTION_STAGGER_FACTORS, gold.staggerFactors);
    assert.deepEqual({ ...MOTION_LIGHT, fadeEvents: [...MOTION_LIGHT.fadeEvents], noneEvents: [...MOTION_LIGHT.noneEvents] }, gold.light);
    assert.deepEqual([...MOTION_LEAVING_EVENTS], gold.leavingEvents);
  });

  it('every golden case resolves exactly (the hierarchy, legacy, light, reduced motion, invalid values)', () => {
    for (const c of gold.cases as Array<{ name: string; motion: MotionEngineSettings; reduceMotion: boolean; profile: 'full' | 'light'; multiplier: number; expect: unknown }>) {
      assert.deepEqual(resolveMotionEngine(c.motion, { reduceMotion: c.reduceMotion, profile: c.profile }), c.expect, c.name);
      assert.equal(globalMultiplier(c.motion, c.profile), c.multiplier, c.name);
    }
  });
});

describe('resolveDuration (spec §7, §13)', () => {
  it('the spec\'s example: AddToCart 700 on Slow is 910; with an override of 1050, 1050', () => {
    assert.equal(resolveDuration(1.3, 700), 910);
    assert.equal(resolveDuration(1.3, 700, 1050), 1050);
    for (const c of gold.resolveDuration as Array<{ multiplier: number; eventDefault: number; override: number | null; expect: number }>) {
      assert.equal(resolveDuration(c.multiplier, c.eventDefault, c.override), c.expect, JSON.stringify(c));
    }
  });

  it('an event\'s override ignores the global speed; its default follows it', () => {
    const motion = { preset: 'standard', globalSpeed: 'slow', events: { addToCart: { durationMs: 1050 } } };
    assert.equal(resolveMotionEvent(motion, 'addToCart').durationMs, 1050);
    assert.equal(resolveMotionEvent(motion, 'pageTransition').durationMs, 845); // 650 × 1.3
  });
});

describe('the presets (spec §8)', () => {
  const ms = (preset: string, e: MotionEventKey) => resolveMotionEvent({ preset }, e).durationMs;
  it('Runner Standard / Slow / Fast are the spec\'s examples; custom starts from Standard', () => {
    const want: Record<string, number[]> = { standard: [450, 750, 650, 1000], slow: [600, 950, 800, 1300], fast: [350, 550, 450, 800], custom: [450, 750, 650, 1000] };
    for (const [p, v] of Object.entries(want)) {
      assert.deepEqual([ms(p, 'productPress'), ms(p, 'addToCart'), ms(p, 'pageTransition'), ms(p, 'success')], v, p);
    }
  });

  it('a new kiosk is Runner Standard at normal speed, with no event of its own', () => {
    assert.equal(KIOSK_DEFAULTS.motion.preset, 'standard');
    assert.equal(KIOSK_DEFAULTS.motion.globalSpeed, null);
    assert.deepEqual(KIOSK_DEFAULTS.motion.events, {});
    assert.equal(globalMultiplier(KIOSK_DEFAULTS.motion), 1);
  });
});

describe('migration: the older choices map onto the engine', () => {
  it('"legacy" plays the old transition table exactly (kiosk_motion_timings.json)', () => {
    for (const ex of oldGold.examples as Array<{ motion: Record<string, string>; light?: boolean; transitions: Record<string, number> }>) {
      const r = resolveMotionEngine({ ...ex.motion, preset: 'legacy' }, { profile: ex.light ? 'light' : 'full' });
      const it2 = r.itemsEnter;
      const delay = (i: number) => (it2.animationType === 'none' || it2.staggerMs <= 0 || i <= 0 ? 0 : Math.min(Math.min(i, 11) * it2.staggerMs, it2.staggerCapMs));
      assert.deepEqual(
        {
          categoryMs: r.categorySwitch.durationMs,
          itemMs: it2.durationMs,
          staggerMs: it2.staggerMs,
          staggerCapMs: it2.staggerCapMs,
          screenMs: r.pageTransition.durationMs,
          sheetMs: r.modalOpen.durationMs,
          gridEnterMs: it2.animationType === 'none' ? 0 : delay(11) + it2.durationMs,
        },
        ex.transitions,
        JSON.stringify(ex.motion),
      );
    }
  });

  it('an older choice and its kind round-trip (the editor writes both, for an older kiosk app)', () => {
    for (const [event, { key, map }] of Object.entries(MOTION_LEGACY_KINDS) as Array<[MotionEventKey, { key: string; map: Record<string, { animationType?: string; scaleFrom?: number }> }]>) {
      for (const [old, values] of Object.entries(map)) {
        const r = resolveMotionEvent({ [key]: old }, event);
        assert.equal(r.animationType, values.animationType, `${event} ${old}`);
        const back = legacyChoiceOf(event, r.animationType, r.scaleFrom);
        assert.ok(back, `${event} ${old}`);
        assert.equal(back.key, key);
        // fade_scale (a category) and zoom (a screen) are the same kind; pop and fade both the pop.
        if (!(event === 'itemsEnter' && old === 'pop')) assert.equal(back.value, old, `${event} ${old}`);
      }
    }
  });

  it('the global speed: the new key wins; without it the older speed; the editor writes the older one too', () => {
    assert.equal(globalMultiplier({ speed: 'relaxed' }), 1.35);
    assert.equal(globalMultiplier({ speed: 'fast', globalSpeed: 'slow' }), 1.3);
    assert.equal(globalMultiplier({ globalSpeed: 'custom', speedMultiplier: 1.6 }), 1.6);
    assert.equal(globalMultiplier({ globalSpeed: 'custom', speedMultiplier: 9 }), 2);
    assert.equal(globalMultiplier({ globalSpeed: 'slow' }, 'light'), 0.75);
    assert.deepEqual(effectiveGlobalSpeed({ speed: 'relaxed' }), { speed: 'custom', multiplier: 1.35 });
    assert.deepEqual(effectiveGlobalSpeed({ speed: 'fast' }), { speed: 'fast', multiplier: 0.75 });
    assert.deepEqual(effectiveGlobalSpeed({ globalSpeed: 'slow' }), { speed: 'slow', multiplier: 1.3 });
    assert.deepEqual(['slow', 'normal', 'fast'].map((s) => speedOfGlobal(s)), ['relaxed', 'normal', 'fast']);
    assert.deepEqual([0.6, 1, 1.5].map((k) => speedOfGlobal('custom', k)), ['fast', 'normal', 'relaxed']);
  });
});

describe('reduced motion and the light profile (spec §14, §15)', () => {
  it('reduced motion keeps feedback — fade, highlight, colour — never a movement or a loop', () => {
    const r = resolveMotionEngine({ preset: 'standard' }, { reduceMotion: true });
    for (const e of MOTION_EVENTS) {
      const s = r[e];
      assert.ok(['fadeIn', 'fadeOut', 'highlight', 'none'].includes(s.animationType), `${e} ${s.animationType}`);
      assert.equal(s.distancePx, 0, e);
      assert.ok(s.repeat === 1, e);
    }
    assert.equal(r.addToCart.animationType, 'fadeIn');
    assert.equal(r.productPress.animationType, 'highlight');
    assert.equal(r.error.animationType, 'highlight');
    assert.equal(r.remove.animationType, 'fadeOut');
    assert.equal(r.idle.animationType, 'none');
  });

  it('the light profile: the screens fade, no cascade, the celebration plain, no slower than fast', () => {
    const r = resolveMotionEngine({ preset: 'slow', events: { success: { animationType: 'confetti' } } }, { profile: 'light' });
    assert.equal(r.pageTransition.animationType, 'fadeIn');
    assert.equal(r.itemsEnter.animationType, 'none');
    assert.equal(r.success.animationType, 'drawCheck');
    assert.equal(r.loading.animationType, 'none');
    assert.equal(r.pageTransition.durationMs, 600); // Slow's 800 at the fast pace
  });
});

describe('validation (the server\'s rules)', () => {
  it('an event\'s values: its own kinds, the ranges, remove\'s Undo of 3 s or more', () => {
    assert.ok(motionParamOk('addToCart', 'animationType', 'flyToCart'));
    assert.ok(!motionParamOk('addToCart', 'animationType', 'confetti'));
    assert.ok(!motionParamOk('remove', 'holdMs', 2000));
    assert.ok(motionParamOk('remove', 'holdMs', 3000));
    assert.ok(!motionParamOk('error', 'repeat', 1.5));
    assert.ok(motionParamOk('error', 'scaleFrom', 1.05));
    assert.deepEqual(explicitOf({ events: { toast: { holdMs: 2500, durationMs: -1, spin: true } } }, 'toast'), { holdMs: 2500 });
  });

  it('validateKioskConfig refuses what the server refuses, at the same paths', () => {
    const cfg = resolveKioskConfig({
      motion: {
        preset: 'turbo',
        globalSpeed: 'warp',
        speedMultiplier: 3,
        events: { addToCart: { animationType: 'confetti', durationMs: 9000 }, remove: { holdMs: 1000 }, teleport: {} },
      },
    } as never);
    const paths = validateKioskConfig(cfg).map((e) => e.path);
    for (const p of [
      'motion.preset',
      'motion.globalSpeed',
      'motion.speedMultiplier',
      'motion.events.addToCart.animationType',
      'motion.events.addToCart.durationMs',
      'motion.events.remove.holdMs',
      'motion.events.teleport',
    ]) {
      assert.ok(paths.includes(p), p);
    }
    const good = resolveKioskConfig({ motion: { preset: 'custom', globalSpeed: 'custom', speedMultiplier: 1.2, events: { addToCart: { durationMs: 1050 } } } } as never);
    assert.deepEqual(validateKioskConfig(good).filter((e) => e.path.startsWith('motion')), []);
  });
});

describe('the web kiosks\' CSS from the engine', () => {
  it('curves by name, and every event\'s time as a custom property (0 when it does not play)', () => {
    assert.equal(motionCurve('overshoot', 'x'), 'cubic-bezier(.34,1.56,.64,1)');
    assert.equal(motionCurve('auto', 'ease'), 'ease');
    const vars = motionCssVars(resolveMotionEngine({ preset: 'standard', events: { idle: { enabled: false } } }));
    assert.equal(vars['--m-addToCart-ms'], '750ms');
    assert.equal(vars['--m-idle-ms'], '0ms');
    assert.ok(motionActive(resolveMotionEvent({}, 'success')));
  });
});
