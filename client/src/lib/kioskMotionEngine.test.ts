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
  KIOSK_MOTION_EVENTS,
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
  TILL_DEFAULT_MOTION_PRESET,
  TILL_MOTION_EVENTS,
  TILL_MOTION_EVENT_TYPES,
  TILL_MOTION_LEGACY,
  TILL_MOTION_LIGHT,
  TILL_MOTION_PRESETS,
  TILL_MOTION_STANDARD,
  TILL_ONLY_MOTION_EVENTS,
  effectiveGlobalSpeed,
  explicitOf,
  globalMultiplier,
  legacyChoiceOf,
  motionActive,
  motionCssVars,
  motionCurve,
  motionConfigIssues,
  motionParamOk,
  motionPresetOf,
  resolveDuration,
  resolveMotionEngine,
  resolveMotionEvent,
  resolveTillMotion,
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
  it('"legacy" plays the old transition table exactly (kiosk_motion_timings.json), a screen on a weak device now seen', () => {
    for (const ex of oldGold.examples as Array<{ motion: Record<string, string>; light?: boolean; transitions: Record<string, number> }>) {
      const r = resolveMotionEngine({ ...ex.motion, preset: 'legacy' }, { profile: ex.light ? 'light' : 'full' });
      // The one change on purpose (the owner on the HIT kiosk, 08.10.2026): the light profile's screen change is seen.
      const expect = { ...ex.transitions };
      if (ex.light && expect.screenMs > 0) expect.screenMs = Math.max(expect.screenMs, MOTION_LIGHT.screenMinMs);
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
        expect,
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
    for (const e of KIOSK_MOTION_EVENTS) {
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

  it('the light profile: the category and windows fade, no cascade, the celebration plain, no slower than fast', () => {
    const r = resolveMotionEngine({ preset: 'slow', events: { success: { animationType: 'confetti' } } }, { profile: 'light' });
    assert.equal(r.categorySwitch.animationType, 'fadeIn');
    assert.equal(r.modalOpen.animationType, 'fadeIn');
    assert.equal(r.itemsEnter.animationType, 'none');
    assert.equal(r.success.animationType, 'drawCheck');
    assert.equal(r.loading.animationType, 'none');
    assert.equal(r.pageTransition.durationMs, 600); // Slow's 800 at the fast pace
  });

  it('the light profile keeps a change of screen seen: attract → service → menu, the cart, home (the owner, 08.10.2026)', () => {
    for (const preset of ['standard', 'slow', 'fast', 'custom', 'legacy'] as const) {
      for (const screenChange of ['slide', 'fade', 'zoom']) {
        const r = resolveMotionEngine({ preset, screenChange, speed: 'fast' }, { profile: 'light' });
        for (const e of MOTION_LIGHT.screenEvents) {
          const s = r[e as keyof typeof r];
          assert.ok(s.animationType === 'slideIn' || s.animationType === 'fadeIn', `${preset} ${screenChange} ${e} ${s.animationType}`);
          assert.ok(s.durationMs >= MOTION_LIGHT.screenMinMs, `${preset} ${screenChange} ${e} ${s.durationMs}`);
          if (s.animationType === 'slideIn') assert.ok(s.distancePx > 0 && s.distancePx <= MOTION_LIGHT.screenShiftPx, `${preset} ${e}`);
        }
      }
    }
    const std = resolveMotionEngine({ preset: 'standard' }, { profile: 'light' }).pageTransition;
    assert.deepEqual([std.animationType, std.durationMs, std.distancePx], ['slideIn', 488, 40]);
    // A time set on purpose is kept; "none" stays none; the full profile is untouched.
    assert.equal(resolveMotionEngine({ events: { pageTransition: { durationMs: 250 } } }, { profile: 'light' }).pageTransition.durationMs, 250);
    assert.equal(resolveMotionEngine({ preset: 'legacy', screenChange: 'none' }, { profile: 'light' }).pageTransition.durationMs, 0);
    assert.equal(resolveMotionEngine({ preset: 'legacy', screenChange: 'slide' }).pageTransition.durationMs, 220);
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

describe('the till: the same engine, surface "till" (P:/specs/till-motion.md), the golden\'s `till` section', () => {
  const till = gold.till as {
    events: string[];
    onlyEvents: string[];
    presets: string[];
    defaultPreset: string;
    nonePreset: string;
    eventTypes: unknown;
    standard: unknown;
    legacy: unknown;
    light: { fadeEvents: string[]; screenEvents: string[]; fadeKinds: unknown };
    cases: Array<{ name: string; motion: MotionEngineSettings; reduceMotion: boolean; profile: 'full' | 'light'; multiplier: number; expect: unknown }>;
  };
  const TABLE_KINDS = ['zoom', 'slide', 'rise', 'fade', 'flip', 'scale', 'none'];

  it('its tables are the golden\'s; the kiosk resolves its own events only', () => {
    assert.deepEqual([...TILL_MOTION_EVENTS], till.events);
    assert.deepEqual([...TILL_ONLY_MOTION_EVENTS], till.onlyEvents);
    assert.deepEqual([...KIOSK_MOTION_EVENTS], gold.kioskEvents);
    assert.deepEqual([...TILL_MOTION_PRESETS], till.presets);
    assert.equal(TILL_DEFAULT_MOTION_PRESET, till.defaultPreset);
    assert.deepEqual(TILL_MOTION_EVENT_TYPES, till.eventTypes);
    assert.deepEqual(TILL_MOTION_STANDARD, till.standard);
    assert.deepEqual(TILL_MOTION_LEGACY, till.legacy);
    assert.deepEqual({ ...TILL_MOTION_LIGHT, fadeEvents: [...TILL_MOTION_LIGHT.fadeEvents], screenEvents: [...TILL_MOTION_LIGHT.screenEvents] }, till.light);
    assert.deepEqual([...MOTION_EVENT_TYPES.tableOpen], TABLE_KINDS);
    assert.deepEqual(Object.keys(resolveMotionEngine({})), [...KIOSK_MOTION_EVENTS]);
  });

  it('every golden till case resolves exactly', () => {
    for (const c of till.cases) {
      assert.deepEqual(resolveTillMotion(c.motion, { reduceMotion: c.reduceMotion, profile: c.profile }), c.expect, c.name);
      assert.equal(globalMultiplier(c.motion, c.profile), c.multiplier, c.name);
    }
  });

  it('no motion is today\'s till: a push 300, payment and windows 330, the tabs 140, on the iOS curve; nothing else moves', () => {
    const r = resolveTillMotion(undefined);
    assert.equal(motionPresetOf(undefined, 'till'), 'legacy');
    assert.deepEqual([r.pageTransition.animationType, r.pageTransition.durationMs, r.pageTransition.easing], ['slideIn', 300, 'ios']);
    assert.deepEqual([r.payment.animationType, r.payment.direction, r.payment.durationMs], ['slideIn', 'up', 330]);
    assert.deepEqual([r.modalOpen.animationType, r.modalOpen.durationMs], ['slideIn', 330]);
    assert.deepEqual([r.tabSwitch.animationType, r.tabSwitch.durationMs], ['crossfade', 140]);
    // A table opens in a zoom from its tile (the owner, 14.10: zoom by default, also with nothing set).
    assert.deepEqual([r.tableOpen.animationType, r.tableOpen.durationMs, r.tableOpen.easing], ['zoom', 300, 'ios']);
    const moving = TILL_MOTION_EVENTS.filter((e) => r[e].animationType !== 'none');
    assert.deepEqual(moving, ['pageTransition', 'modalOpen', 'tableOpen', 'tabSwitch', 'payment']);
    assert.equal(MOTION_EASING_CURVES.ios.join(','), '0.32,0.72,0,1');
    assert.equal(motionCurve('ios', 'x'), 'cubic-bezier(.32,.72,0,1)');
  });

  it('"none" switches every event off, whatever a level set', () => {
    const r = resolveTillMotion({ preset: 'none', events: { addToCart: { enabled: true, durationMs: 500 }, tableOpen: { animationType: 'zoom' } } });
    for (const e of TILL_MOTION_EVENTS) assert.deepEqual([r[e].enabled, r[e].animationType, r[e].durationMs], [false, 'none', 0], e);
    // A kiosk has no "none": its default.
    assert.equal(motionPresetOf({ preset: 'none' }), 'standard');
  });

  it('each way to open a table validates and resolves with its parameters (time, curve, intensity, direction)', () => {
    for (const kind of TABLE_KINDS) {
      const ev = { animationType: kind, durationMs: 520, easing: 'ios', intensity: 140, direction: 'left' };
      assert.deepEqual(motionConfigIssues({ preset: 'standard', events: { tableOpen: ev } }, 'till'), [], kind);
      const r = resolveMotionEvent({ preset: 'standard', globalSpeed: 'fast', events: { tableOpen: ev } }, 'tableOpen', { surface: 'till' });
      if (kind === 'none') {
        assert.deepEqual([r.animationType, r.durationMs], ['none', 0]);
        continue;
      }
      assert.deepEqual([r.animationType, r.durationMs, r.easing, r.intensity, r.direction], [kind, 520, 'ios', 140, 'left'], kind);
      const bare = resolveMotionEvent({ preset: 'standard', globalSpeed: 'fast', events: { tableOpen: { animationType: kind } } }, 'tableOpen', { surface: 'till' });
      assert.deepEqual([bare.animationType, bare.durationMs], [kind, 488], kind); // 650 × 0.75
      const light = resolveMotionEvent({ preset: 'standard', events: { tableOpen: { animationType: kind } } }, 'tableOpen', { surface: 'till', profile: 'light' });
      assert.deepEqual([light.animationType, light.durationMs], ['fade', 488], kind);
    }
  });

  it('the same rules refuse, on each surface, what that surface cannot take', () => {
    const paths = (mo: Record<string, unknown>, surface: 'kiosk' | 'till') => motionConfigIssues(mo, surface).map((e) => `${e.path}:${e.code}`);
    assert.deepEqual(paths({ preset: 'turbo', events: { tableOpen: { animationType: 'spin', durationMs: 9000 }, payment: { animationType: 'buttonFill' }, idle: {} } }, 'till'), [
      'motion.preset:enum',
      'motion.events.tableOpen.animationType:enum',
      'motion.events.tableOpen.durationMs:range',
      'motion.events.payment.animationType:enum',
      'motion.events.idle:unknownKey',
    ]);
    assert.deepEqual(paths({ preset: 'none', events: { tableOpen: {}, payment: { animationType: 'slideIn' } } }, 'kiosk'), [
      'motion.preset:enum',
      'motion.events.tableOpen:unknownKey',
      'motion.events.payment.animationType:enum',
    ]);
    assert.deepEqual(paths({ preset: 'legacy', globalSpeed: 'slow', speedMultiplier: 1.2, events: { payment: { animationType: 'fadeScale' } } }, 'till'), []);
  });
});
