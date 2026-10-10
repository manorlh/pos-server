/**
 * Run with `npm test`. "הנפשות" — the Motion Engine's management screen's helpers
 * (lib/kioskMotionEditor.ts): the groups, where a value comes from, the edits (with the older keys an
 * older kiosk app follows), "העתק הגדרה", the global speed and the duration's arithmetic.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MOTION_DIRECTIONS,
  MOTION_EASINGS,
  MOTION_EVENTS,
  MOTION_FALLBACKS,
  MOTION_GLOBAL_SPEEDS,
  MOTION_PARAM_KEYS,
  MOTION_PRESETS,
  MOTION_TYPES,
  resolveMotionEvent,
  type MotionEngineSettings,
} from './kioskMotionEngine';
import {
  GLOBAL_SPEED_RESET,
  MOTION_ADVANCED_PARAMS,
  MOTION_BASIC_PARAMS,
  MOTION_EVENT_GROUPS,
  PRESET_EXAMPLE_EVENTS,
  clampMultiplier,
  globalSpeedEdits,
  globalSpeedView,
  motionCopyEdits,
  motionDurationView,
  motionEventCounts,
  motionEventResetEdits,
  motionEventSource,
  motionEventView,
  motionParamEdits,
  motionParamSource,
  presetExample,
  withEventParam,
} from './kioskMotionEditor';

describe('the events in groups', () => {
  it('every event exactly once', () => {
    const listed = MOTION_EVENT_GROUPS.flatMap((g) => g.events);
    assert.equal(listed.length, MOTION_EVENTS.length);
    assert.deepEqual([...listed].sort(), [...MOTION_EVENTS].sort());
  });

  it('the basic and the advanced controls are every parameter but the switch, once', () => {
    const all = [...MOTION_BASIC_PARAMS, ...MOTION_ADVANCED_PARAMS];
    assert.equal(new Set(all).size, all.length);
    assert.deepEqual([...all, 'enabled'].sort(), [...MOTION_PARAM_KEYS].sort());
  });
});

describe('the preset cards (spec §8)', () => {
  it('Standard / Slow / Fast are the spec\'s examples; Custom starts from Standard; Classic is the pace before the engine', () => {
    assert.deepEqual(PRESET_EXAMPLE_EVENTS, ['productPress', 'addToCart', 'pageTransition', 'success']);
    assert.deepEqual(presetExample('standard'), { productPress: 450, addToCart: 750, pageTransition: 650, success: 1000 });
    assert.deepEqual(presetExample('slow'), { productPress: 600, addToCart: 950, pageTransition: 800, success: 1300 });
    assert.deepEqual(presetExample('fast'), { productPress: 350, addToCart: 550, pageTransition: 450, success: 800 });
    assert.deepEqual(presetExample('custom'), presetExample('standard'));
    assert.deepEqual(presetExample('legacy'), { productPress: 250, addToCart: 560, pageTransition: 220, success: 800 });
  });
});

describe('where a value comes from (spec §11)', () => {
  const parent: MotionEngineSettings = { events: { addToCart: { durationMs: 1050 }, toast: { holdMs: 2500 } } };
  const draft: MotionEngineSettings = { events: { addToCart: { durationMs: 1050, easing: 'linear' }, toast: { holdMs: 2500 } } };

  it('per parameter: set here, by a level above, or the preset\'s', () => {
    assert.equal(motionParamSource(draft, parent, 'addToCart', 'durationMs'), 'parent');
    assert.equal(motionParamSource(draft, parent, 'addToCart', 'easing'), 'here');
    assert.equal(motionParamSource(draft, parent, 'addToCart', 'delayMs'), 'preset');
    const changed: MotionEngineSettings = { events: { addToCart: { durationMs: 900 } } };
    assert.equal(motionParamSource(changed, parent, 'addToCart', 'durationMs'), 'here');
  });

  it('per event: any value of its own here, else above, else the preset — the older kind key counts as its own', () => {
    assert.equal(motionEventSource(draft, parent, 'addToCart'), 'here');
    assert.equal(motionEventSource(draft, parent, 'toast'), 'parent');
    assert.equal(motionEventSource(draft, parent, 'success'), 'preset');
    assert.equal(motionEventSource({ categorySwitch: 'fade' }, { categorySwitch: 'slide' }, 'categorySwitch'), 'here');
    assert.equal(motionEventSource({ categorySwitch: 'slide' }, { categorySwitch: 'slide' }, 'categorySwitch'), 'preset');
  });

  it('counts the events with values of their own and the ones switched off', () => {
    const m: MotionEngineSettings = { events: { toast: { enabled: false }, addToCart: { durationMs: 900 }, error: { durationMs: 99999 } } };
    assert.deepEqual(motionEventCounts(m), { custom: 2, off: 1 });
    assert.deepEqual(motionEventCounts({}), { custom: 0, off: 0 });
  });
});

describe('the edits', () => {
  it('a value goes into the event\'s layer; a reset goes back to the inherited one; an empty event leaves `events`', () => {
    assert.deepEqual(withEventParam({}, {}, 'toast', 'holdMs', 2500), { holdMs: 2500 });
    assert.equal(withEventParam({ events: { toast: { holdMs: 2500 } } }, {}, 'toast', 'holdMs', undefined), undefined);
    const parent: MotionEngineSettings = { events: { toast: { holdMs: 3000 } } };
    assert.deepEqual(withEventParam({ events: { toast: { holdMs: 2500 } } }, parent, 'toast', 'holdMs', undefined), { holdMs: 3000 });
    assert.deepEqual(motionParamEdits({}, {}, 'toast', 'durationMs', 600), [{ path: 'motion.events.toast', value: { durationMs: 600 } }]);
  });

  it('the kind of one of the five older transitions writes the older key too (an older kiosk app follows)', () => {
    assert.deepEqual(motionParamEdits({}, {}, 'categorySwitch', 'animationType', 'fadeIn'), [
      { path: 'motion.events.categorySwitch', value: { animationType: 'fadeIn' } },
      { path: 'motion.categorySwitch', value: 'fade' },
    ]);
    assert.deepEqual(motionParamEdits({}, {}, 'itemsEnter', 'animationType', 'flip')[1], { path: 'motion.itemsEnter', value: 'flip' });
    assert.deepEqual(motionParamEdits({}, {}, 'modalOpen', 'animationType', 'slideIn')[1], { path: 'motion.sheet', value: 'slide_up' });
    assert.deepEqual(motionParamEdits({}, {}, 'addToCart', 'animationType', 'bounce')[1], { path: 'motion.addToCart', value: 'bounce' });
    assert.deepEqual(motionParamEdits({}, {}, 'pageTransition', 'animationType', 'fadeScale')[1], { path: 'motion.screenChange', value: 'fade' });
    // pageTransition's scale tells "zoom" from "fade".
    const zoom = motionParamEdits({ events: { pageTransition: { animationType: 'fadeScale' } } }, {}, 'pageTransition', 'scaleFrom', 0.9);
    assert.deepEqual(zoom[1], { path: 'motion.screenChange', value: 'zoom' });
    // Any other event: only its layer.
    assert.equal(motionParamEdits({}, {}, 'toast', 'animationType', 'slideIn').length, 1);
    assert.equal(motionParamEdits({}, {}, 'modalOpen', 'scaleFrom', 0.9).length, 1);
  });

  it('the kind back to the inherited one resets the older key too', () => {
    const draft: MotionEngineSettings = { categorySwitch: 'fade', events: { categorySwitch: { animationType: 'fadeIn' } } };
    assert.deepEqual(motionParamEdits(draft, {}, 'categorySwitch', 'animationType', undefined), [
      { path: 'motion.events.categorySwitch', value: undefined },
      { path: 'motion.categorySwitch', reset: true },
    ]);
    assert.deepEqual(motionEventResetEdits('modalOpen'), [
      { path: 'motion.events.modalOpen', reset: true },
      { path: 'motion.sheet', reset: true },
    ]);
    assert.deepEqual(motionEventResetEdits('toast'), [{ path: 'motion.events.toast', reset: true }]);
  });

  it('switching an event back on leaves nothing behind, unless a level above switched it off', () => {
    assert.deepEqual(motionParamEdits({ events: { toast: { enabled: false } } }, {}, 'toast', 'enabled', true), [{ path: 'motion.events.toast', value: undefined }]);
    const above: MotionEngineSettings = { events: { toast: { enabled: false } } };
    assert.deepEqual(motionParamEdits(above, above, 'toast', 'enabled', true), [{ path: 'motion.events.toast', value: { enabled: true } }]);
    assert.deepEqual(motionParamEdits({}, {}, 'toast', 'enabled', false), [{ path: 'motion.events.toast', value: { enabled: false } }]);
  });
});

describe('"העתק הגדרה"', () => {
  const draft: MotionEngineSettings = {
    events: { addToCart: { animationType: 'flyToCart', durationMs: 950, holdMs: 900, easing: 'overshoot' }, remove: { delayMs: 100 } },
  };

  it('copies only what the target can take: its kinds, its ranges (remove\'s Undo of 3 s or more)', () => {
    const c = motionCopyEdits(draft, 'addToCart', 'remove');
    assert.deepEqual([...c.copied].sort(), ['durationMs', 'easing']);
    assert.deepEqual([...c.skipped].sort(), ['animationType', 'holdMs']);
    assert.deepEqual(c.edits, [{ path: 'motion.events.remove', value: { delayMs: 100, durationMs: 950, easing: 'overshoot' } }]);
  });

  it('a copied kind of an older transition writes its older key; nothing to copy, no edit', () => {
    const c = motionCopyEdits({ events: { cartBadge: { animationType: 'bounce' } } }, 'cartBadge', 'addToCart');
    assert.deepEqual(c.edits, [
      { path: 'motion.events.addToCart', value: { animationType: 'bounce' } },
      { path: 'motion.addToCart', value: 'bounce' },
    ]);
    assert.deepEqual(motionCopyEdits(draft, 'success', 'toast'), { edits: [], copied: [], skipped: [] });
  });
});

describe('the global speed (spec §7)', () => {
  it('writes the new keys and the older speed beside them', () => {
    assert.deepEqual(globalSpeedEdits('slow'), [
      { path: 'motion.globalSpeed', value: 'slow' },
      { path: 'motion.speed', value: 'relaxed' },
    ]);
    assert.deepEqual(globalSpeedEdits('fast')[1], { path: 'motion.speed', value: 'fast' });
    assert.deepEqual(globalSpeedEdits('normal')[1], { path: 'motion.speed', value: 'normal' });
    assert.deepEqual(globalSpeedEdits('custom', 1.42), [
      { path: 'motion.globalSpeed', value: 'custom' },
      { path: 'motion.speedMultiplier', value: 1.4 },
      { path: 'motion.speed', value: 'relaxed' },
    ]);
    assert.deepEqual(globalSpeedEdits('custom', 0.8)[2], { path: 'motion.speed', value: 'fast' });
    assert.deepEqual(GLOBAL_SPEED_RESET.map((e) => e.path), ['motion.globalSpeed', 'motion.speedMultiplier', 'motion.speed']);
  });

  it('the custom multiplier: 0.50–2.00 in steps of 0.05', () => {
    assert.equal(clampMultiplier(3), 2);
    assert.equal(clampMultiplier(0.1), 0.5);
    assert.equal(clampMultiplier(1.33), 1.35);
    assert.equal(clampMultiplier(Number.NaN), 1);
  });

  it('none chosen: the older speed\'s pace, marked as such', () => {
    assert.deepEqual(globalSpeedView({ speed: 'relaxed', globalSpeed: null }), { speed: 'custom', multiplier: 1.35, fromOlder: true });
    assert.deepEqual(globalSpeedView({ speed: 'fast' }), { speed: 'fast', multiplier: 0.75, fromOlder: true });
    assert.deepEqual(globalSpeedView({ globalSpeed: 'slow' }), { speed: 'slow', multiplier: 1.3, fromOlder: false });
  });
});

describe('the duration\'s arithmetic (resolveDuration)', () => {
  it('the spec\'s example: the default times the speed; an override as is', () => {
    const slow: MotionEngineSettings = { globalSpeed: 'slow', events: { addToCart: {} } };
    assert.deepEqual(motionDurationView(slow, 'addToCart'), { baseMs: 750, multiplier: 1.3, ms: 975, explicit: false });
    const own: MotionEngineSettings = { globalSpeed: 'slow', events: { addToCart: { durationMs: 1050 } } };
    assert.deepEqual(motionDurationView(own, 'addToCart'), { baseMs: 1050, multiplier: 1.3, ms: 1050, explicit: true });
  });

  it('is what the engine plays, for every event, preset and speed', () => {
    for (const preset of MOTION_PRESETS) {
      for (const globalSpeed of ['slow', 'normal', 'fast', null] as const) {
        const m: MotionEngineSettings = { preset, globalSpeed, speed: 'relaxed', screenChange: 'fade' };
        for (const e of MOTION_EVENTS) {
          const view = motionDurationView(m, e);
          assert.equal(view.ms, resolveMotionEvent(m, e).durationMs, `${preset} ${globalSpeed} ${e}`);
          assert.equal(motionEventView(m, e).durationMs, view.ms);
        }
      }
    }
  });

  it('a kind of "ללא" or an event switched off still shows its kind and its time', () => {
    const m: MotionEngineSettings = { events: { toast: { enabled: false }, success: { animationType: 'none' } } };
    assert.equal(motionEventView(m, 'toast').enabled, false);
    assert.equal(motionEventView(m, 'toast').animationType, 'fadeIn');
    assert.equal(motionEventView(m, 'toast').durationMs, 450);
    assert.equal(motionEventView(m, 'success').animationType, 'none');
    assert.equal(motionEventView(m, 'success').durationMs, 1000);
  });
});

describe('the screen\'s Hebrew texts exist in he.json', () => {
  const he = JSON.parse(readFileSync(join(process.cwd(), 'src', 'messages', 'he.json'), 'utf8'));
  const m = he.kiosks.motion;

  it('every event, kind, parameter, direction, curve, fallback, preset, speed and group', () => {
    for (const e of MOTION_EVENTS) {
      assert.equal(typeof m.events[e]?.name, 'string', e);
      assert.equal(typeof m.events[e]?.desc, 'string', e);
    }
    for (const k of MOTION_TYPES) assert.equal(typeof m.kinds[k], 'string', k);
    for (const p of MOTION_PARAM_KEYS) assert.equal(typeof m.params[p], 'string', p);
    for (const d of MOTION_DIRECTIONS) assert.equal(typeof m.directions[d], 'string', d);
    for (const c of MOTION_EASINGS) assert.equal(typeof m.easings[c], 'string', c);
    for (const f of MOTION_FALLBACKS) assert.equal(typeof m.fallbacks[f], 'string', f);
    for (const p of MOTION_PRESETS) {
      assert.equal(typeof m.presets[p]?.name, 'string', p);
      assert.equal(typeof m.presets[p]?.desc, 'string', p);
    }
    for (const s of MOTION_GLOBAL_SPEEDS) assert.equal(typeof m.globalSpeeds[s], 'string', s);
    for (const g of MOTION_EVENT_GROUPS) assert.equal(typeof m.groups[g.key], 'string', g.key);
    for (const e of PRESET_EXAMPLE_EVENTS) assert.equal(typeof m.example[e], 'string', e);
    assert.equal(he.kiosks.settings.sections.motion, 'הנפשות');
  });
});
