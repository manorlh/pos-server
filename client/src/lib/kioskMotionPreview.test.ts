/**
 * Run with `npm test`. "הצג" of the Motion Engine's management screen (lib/kioskMotionPreview.ts):
 * every event's every kind plays on its sample stage, as the resolved values say — the time, the
 * delay, the curve, the repeats, the stagger, the intensity — and nothing plays when it should not.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MOTION_EVENTS,
  MOTION_EVENT_TYPES,
  motionCurve,
  resolveMotionEvent,
  type MotionEngineSettings,
  type MotionEventKey,
  type MotionType,
} from './kioskMotionEngine';
import {
  LOOP_PREVIEW_CYCLES,
  MAX_PREVIEW_CYCLES,
  MAX_PREVIEW_HOLD_MS,
  MOTION_SCENES,
  SCENE_ROLES,
  counterText,
  motionSceneOf,
  planMotionPreview,
} from './kioskMotionPreview';

const specOf = (event: MotionEventKey, values: Record<string, unknown> = {}, opts: { reduceMotion?: boolean } = {}) =>
  resolveMotionEvent({ events: { [event]: values } } as MotionEngineSettings, event, opts);

describe('the preview of every event\'s every kind', () => {
  it('plays on the event\'s stage, on elements the stage draws, for the event\'s time', () => {
    for (const event of MOTION_EVENTS) {
      const scene = MOTION_SCENES[event];
      for (const kind of MOTION_EVENT_TYPES[event]) {
        if (kind === 'none') continue;
        const spec = specOf(event, { animationType: kind });
        const plan = planMotionPreview(spec);
        const label = `${event} ${kind}`;
        assert.ok(plan.tracks.length + plan.counters.length > 0, label);
        for (const t of [...plan.tracks, ...plan.counters]) {
          assert.ok(SCENE_ROLES[scene].includes(t.role), `${label}: ${t.role}`);
          assert.ok(t.duration > 0 && t.delay >= 0, label);
        }
        for (const t of plan.tracks) assert.ok(t.frames.length >= 2, label);
        assert.ok(plan.endMs >= spec.durationMs * 0.7, label);
        assert.ok(plan.holdMs > 0 && plan.holdMs <= MAX_PREVIEW_HOLD_MS, label);
      }
    }
  });

  it('nothing plays when the event is off, has no kind or no time', () => {
    assert.equal(planMotionPreview(specOf('toast', { enabled: false })).tracks.length, 0);
    assert.equal(planMotionPreview(specOf('toast', { animationType: 'none' })).tracks.length, 0);
    assert.equal(planMotionPreview(specOf('toast', { durationMs: 0 })).tracks.length, 0);
  });
});

describe('the timing as resolved', () => {
  it('the delay first, then each repeat a duration and its gap apart', () => {
    const spec = specOf('error', { durationMs: 400, delayMs: 100, repeat: 3, repeatDelayMs: 250 });
    const plan = planMotionPreview(spec);
    const starts = plan.tracks.filter((t) => t.role === 'target').map((t) => t.delay);
    assert.deepEqual(starts, [100, 750, 1400]);
    assert.equal(plan.cycles, 3);
    assert.equal(plan.loop, false);
    assert.deepEqual(
      plan.tracks.filter((t) => t.role === 'target').map((t) => t.fill),
      ['backwards', 'none', 'forwards'],
    );
    assert.equal(plan.endMs, 1800);
  });

  it('repeat 0 loops for a few cycles; a long repeat shows the first ones', () => {
    const loop = planMotionPreview(specOf('idle'));
    assert.equal(loop.loop, true);
    assert.equal(loop.cycles, LOOP_PREVIEW_CYCLES);
    const many = planMotionPreview(specOf('error', { repeat: 20 }));
    assert.equal(many.cycles, MAX_PREVIEW_CYCLES);
    assert.equal(many.truncated, true);
    assert.equal(planMotionPreview(specOf('error')).truncated, false);
  });

  it('the cards come in a stagger apart, the last no later than the cap', () => {
    const spec = specOf('itemsEnter', { staggerMs: 100 });
    const plan = planMotionPreview(spec);
    const delays = ['card-0', 'card-1', 'card-2'].map((role) => plan.tracks.find((t) => t.role === role)?.delay);
    assert.deepEqual(delays, [0, 100, 200]);
    const capped = planMotionPreview({ ...spec, staggerCapMs: 150 });
    assert.deepEqual(['card-0', 'card-1', 'card-2'].map((role) => capped.tracks.find((t) => t.role === role)?.delay), [0, 100, 150]);
  });

  it('the event\'s curve by name; "auto" is the kind\'s own', () => {
    const named = planMotionPreview(specOf('toast', { easing: 'overshoot' }));
    assert.equal(named.tracks[0].easing, motionCurve('overshoot', ''));
    const auto = planMotionPreview(specOf('toast'));
    assert.equal(auto.tracks[0].easing, 'cubic-bezier(.2,.7,.2,1)');
  });

  it('the hold keeps the end state (capped in the preview); a toast leaves after it', () => {
    assert.equal(planMotionPreview(specOf('remove')).holdMs, MAX_PREVIEW_HOLD_MS);
    const toast = planMotionPreview(specOf('toast', { holdMs: 1200 }));
    const leave = toast.tracks.find((t) => t.fill === 'both' && t.frames[0].opacity === 1 && t.frames[1].opacity === 0);
    assert.ok(leave);
    assert.equal(leave.delay, 450 + 1200);
  });

  it('the auto-advance of "לשבת / לקחת" follows the lift by its delay', () => {
    const plan = planMotionPreview(specOf('serviceChoice', { autoAdvanceDelayMs: 700 }));
    const advance = plan.tracks.find((t) => t.role === 'advance');
    assert.equal(advance?.delay, 550 + 700);
  });
});

describe('the look as resolved', () => {
  const amplitude = (kind: MotionType, intensity: number) => {
    const plan = planMotionPreview(specOf('error', { animationType: kind, intensity }));
    const xs = plan.tracks[0].frames.map((f) => Number(/translate\((-?[\d.]+)px/.exec(String(f.transform))?.[1] ?? 0));
    return Math.max(...xs.map(Math.abs));
  };

  it('the intensity scales the movement; 0 is still', () => {
    assert.equal(amplitude('shake', 200), amplitude('shake', 100) * 2);
    assert.equal(amplitude('shake', 0), 0);
    const still = planMotionPreview(specOf('productPress', { intensity: 0 }));
    assert.ok(still.tracks[0].frames.every((f) => f.transform === 'scale(1)'));
  });

  it('the direction: a shake starts to its side', () => {
    const left = planMotionPreview(specOf('error', { direction: 'left' })).tracks[0].frames[1].transform;
    const right = planMotionPreview(specOf('error', { direction: 'right' })).tracks[0].frames[1].transform;
    assert.match(String(left), /translate\(-/);
    assert.match(String(right), /translate\(\d/);
  });

  it('the fly lands on the basket, and the basket\'s count changes when it does', () => {
    const plan = planMotionPreview(specOf('addToCart'), 'addCart', { flyDx: -150, flyDy: -60 });
    const ghost = plan.tracks.find((t) => t.role === 'ghost');
    assert.match(String(ghost?.frames[ghost.frames.length - 1].transform), /^translate\(-150px, -60px\)/);
    assert.equal(plan.swapAtMs, Math.round(0.85 * 750));
  });

  it('reduced motion previews its fallback — a fade or a highlight, once, never a movement', () => {
    for (const event of MOTION_EVENTS) {
      const spec = specOf(event, {}, { reduceMotion: true });
      const plan = planMotionPreview(spec);
      if (spec.animationType === 'none') {
        assert.equal(plan.tracks.length, 0, event);
        continue;
      }
      assert.ok(['fadeIn', 'fadeOut', 'highlight'].includes(spec.animationType), event);
      assert.equal(plan.cycles, 1, event);
      for (const t of plan.tracks) {
        for (const f of t.frames) assert.ok(!/translate\((?!0px, 0px)/.test(String(f.transform ?? '')) || t.role === 'undo', `${event} ${t.role}`);
      }
    }
  });

  it('a counter\'s text', () => {
    assert.equal(counterText({ from: 42.9, to: 46.9, decimals: 2 }, 0.5), '44.90');
    assert.equal(counterText({ from: 5, to: 0, decimals: 0 }, 0.5), '3');
    assert.equal(counterText({ from: 2, to: 3, decimals: 0 }, 2), '3');
  });
});

describe('the till: opening a table on the tables stage, and back', () => {
  const tableSpec = (kind: string, values: Record<string, unknown> = {}) =>
    resolveMotionEvent({ preset: 'standard', events: { tableOpen: { animationType: kind, ...values } } } as MotionEngineSettings, 'tableOpen', { surface: 'till' });

  it('every kind plays on the map, the table and its order — and backwards, mirrored', () => {
    for (const kind of ['zoom', 'slide', 'rise', 'fade', 'flip', 'scale']) {
      const spec = tableSpec(kind);
      const plan = planMotionPreview(spec, 'tables');
      const back = planMotionPreview(spec, 'tables', undefined, { reverse: true });
      assert.ok(plan.tracks.some((t) => t.role === 'order'), kind);
      for (const t of [...plan.tracks, ...back.tracks]) assert.ok(SCENE_ROLES.tables.includes(t.role), `${kind}: ${t.role}`);
      assert.equal(back.tracks.length, plan.tracks.length, kind);
      plan.tracks.forEach((t, i) => {
        const b = back.tracks[i];
        assert.equal(b.role, t.role, kind);
        assert.deepEqual(stripOffset(b.frames[0]), stripOffset(t.frames[t.frames.length - 1]), `${kind} ${t.role}`);
        assert.deepEqual(stripOffset(b.frames[b.frames.length - 1]), stripOffset(t.frames[0]), `${kind} ${t.role}`);
        assert.equal(b.delay + b.duration <= plan.endMs + 1, true, kind);
      });
      // The order is on view at the end of the opening (every kind ends with it opaque).
      const orders = plan.tracks.filter((t) => t.role === 'order');
      const order = orders[orders.length - 1];
      assert.equal(order.frames[order.frames.length - 1].opacity, 1, kind);
      assert.equal(plan.endMs, spec.durationMs, kind);
    }
  });

  it('zoom grows from the table picked on the map; slide goes the reading way, rise from the bottom; direction steers them', () => {
    const zoom = planMotionPreview(tableSpec('zoom'), 'tables', { flyDx: 0, flyDy: 0, tile: { left: 0.1, top: 0.2, width: 0.25, height: 0.3 } });
    assert.equal(zoom.tracks.find((t) => t.role === 'order')?.frames[0].clipPath, 'inset(20% 65% 50% 10% round 12px)');
    const order = (spec: ReturnType<typeof tableSpec>) => planMotionPreview(spec, 'tables').tracks.find((t) => t.role === 'order')!.frames[0].transform;
    assert.equal(order(tableSpec('slide')), 'translate(-100%, 0%)'); // in from the left, moving right (RTL reading)
    assert.equal(order(tableSpec('rise')), 'translate(0%, 100%)'); // up from the bottom
    assert.equal(order(tableSpec('slide', { direction: 'left' })), 'translate(100%, 0%)');
    assert.match(String(order(tableSpec('flip'))), /rotateY\(90deg\)/);
    assert.match(String(order(tableSpec('flip', { direction: 'up' }))), /rotateX\(-90deg\)/);
  });

  it('the time, the delay and the curve are the event\'s; none plays nothing', () => {
    const plan = planMotionPreview(tableSpec('scale', { durationMs: 520, delayMs: 100, easing: 'ios' }), 'tables');
    for (const t of plan.tracks) {
      assert.equal(t.delay, 100);
      assert.equal(t.duration, 520);
      assert.equal(t.easing, motionCurve('ios', ''));
    }
    assert.equal(planMotionPreview(tableSpec('none'), 'tables').tracks.length, 0);
  });

  it('reduced motion: the order fades in (or the table lights), never a movement', () => {
    const fade = resolveMotionEvent({ preset: 'standard' }, 'tableOpen', { surface: 'till', reduceMotion: true });
    const plan = planMotionPreview(fade, 'tables');
    assert.deepEqual(plan.tracks.map((t) => t.role), ['order']);
    for (const t of plan.tracks) for (const f of t.frames) assert.equal(f.transform, undefined);
  });

  it('the till\'s payment is the payment screen rising over the order', () => {
    assert.equal(motionSceneOf('payment', 'till'), 'screen');
    assert.equal(motionSceneOf('payment'), 'button');
    assert.equal(motionSceneOf('tableOpen', 'till'), 'tables');
    const spec = resolveMotionEvent({ preset: 'standard' }, 'payment', { surface: 'till' });
    const plan = planMotionPreview(spec, motionSceneOf('payment', 'till'));
    assert.equal(plan.tracks.find((t) => t.role === 'screenB')?.frames[0].transform, 'translate(0%, 100%)');
  });
});

function stripOffset(f: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(f).filter(([k]) => k !== 'offset'));
}
