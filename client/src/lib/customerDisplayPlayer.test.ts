import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MOTION_DEFAULTS,
  REDUCED_FADE_MS,
  VIDEO_WATCHDOG_UNKNOWN_MS,
  calmMotion,
  cursorIndex,
  kenBurnsFrames,
  motionOf,
  nextCursor,
  playableSlides,
  roundOrder,
  shuffled,
  slideSeconds,
  slideTiming,
  startCursor,
  transitionFor,
  transitionFrames,
  videoWatchdogMs,
  type Cursor,
  type Rng,
} from './customerDisplayPlayer';

/** A repeatable "random": a small LCG. */
function seeded(seed: number): Rng {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

test('the motion from the wire: anything unknown is the default, the duration kept in range', () => {
  assert.deepEqual(motionOf(undefined), MOTION_DEFAULTS);
  assert.deepEqual(MOTION_DEFAULTS, { transition: 'fade', transitionMs: 600, kenBurns: true, videoUntilEnd: true, shuffle: false });
  assert.deepEqual(motionOf({ transition: 'zoom', transitionMs: 1200, kenBurns: false, videoUntilEnd: false, shuffle: true }), {
    transition: 'zoom', transitionMs: 1200, kenBurns: false, videoUntilEnd: false, shuffle: true,
  });
  const odd = motionOf({ transition: 'spin', transitionMs: 99999, kenBurns: 'yes', shuffle: 1 });
  assert.equal(odd.transition, 'fade');
  assert.equal(odd.transitionMs, 2000);
  assert.equal(odd.kenBurns, true);
  assert.equal(odd.shuffle, false);
  assert.equal(motionOf({ transitionMs: 10 }).transitionMs, 200);
});

test('only slides with a file to play: a file still being processed (no URL) is left out', () => {
  const slides = playableSlides([
    { mediaId: 'm1', kind: 'video', durationSec: 9 },
    { url: 'https://x/a.webp', kind: 'image', durationSec: 5, transition: 'slide', sha256: 'ab' },
    { url: 'https://x/b.mp4', kind: 'video', durationSec: 0, transition: 'spin' },
    { url: 'https://x/c.gif', kind: 'gif', durationSec: 5 },
    null,
  ]);
  assert.deepEqual(slides, [
    { url: 'https://x/a.webp', kind: 'image', durationSec: 5, transition: 'slide', sha256: 'ab' },
    { url: 'https://x/b.mp4', kind: 'video', durationSec: 8 },
  ]);
  assert.deepEqual(playableSlides('nope'), []);
});

test("a slide's own transition wins; a cut takes no time", () => {
  const motion = { ...MOTION_DEFAULTS, transition: 'zoom' as const, transitionMs: 900 };
  assert.deepEqual(transitionFor({}, motion), { kind: 'zoom', ms: 900 });
  assert.deepEqual(transitionFor({ transition: 'slide' }, motion), { kind: 'slide', ms: 900 });
  assert.deepEqual(transitionFor({ transition: 'none' }, motion), { kind: 'none', ms: 0 });
});

test('less motion, or a slow device: a short fade whatever is set, no Ken Burns; a cut stays a cut', () => {
  const motion = { ...MOTION_DEFAULTS, transition: 'slide' as const, transitionMs: 1500, kenBurns: true };
  assert.deepEqual(transitionFor({ transition: 'zoom' }, motion, true), { kind: 'fade', ms: REDUCED_FADE_MS });
  assert.deepEqual(transitionFor({}, { ...motion, transitionMs: 200 }, true), { kind: 'fade', ms: 200 });
  assert.deepEqual(transitionFor({ transition: 'none' }, motion, true), { kind: 'none', ms: 0 });
  const calm = calmMotion(motion, true);
  assert.deepEqual(calm, { ...motion, transition: 'fade', transitionMs: REDUCED_FADE_MS, kenBurns: false });
  assert.equal(calmMotion({ ...motion, transition: 'none' }, true).transition, 'none');
  assert.equal(calmMotion(motion, false), motion);
});

test('fade comes in over the slide shown, which stays whole beneath (never through black)', () => {
  const fade = transitionFrames('fade', 'rtl');
  assert.deepEqual(fade.enter, [{ opacity: 0 }, { opacity: 1 }]);
  assert.deepEqual(fade.leave, [{ opacity: 1 }, { opacity: 1 }]);
  const dissolve = transitionFrames('dissolve', 'ltr');
  assert.equal(dissolve.enter[0].filter, 'blur(12px)');
  assert.equal(dissolve.leave[1].filter, 'blur(12px)');
  assert.ok(dissolve.leave.every((f) => f.opacity === 1));
  const zoom = transitionFrames('zoom', 'ltr');
  assert.deepEqual(zoom.enter[0], { opacity: 0, transform: 'scale(1.08)' });
  assert.deepEqual(zoom.leave[1], { opacity: 1, transform: 'scale(0.96)' });
});

test('slide follows the reading direction: in Hebrew the next slide comes from the left', () => {
  const rtl = transitionFrames('slide', 'rtl');
  assert.deepEqual(rtl.enter, [{ transform: 'translateX(-100%)' }, { transform: 'translateX(0%)' }]);
  assert.deepEqual(rtl.leave, [{ transform: 'translateX(0%)' }, { transform: 'translateX(100%)' }]);
  const ltr = transitionFrames('slide', 'ltr');
  assert.deepEqual(ltr.enter[0], { transform: 'translateX(100%)' });
  assert.deepEqual(ltr.leave[1], { transform: 'translateX(-100%)' });
  assert.deepEqual(transitionFrames('none', 'rtl').enter, [{ opacity: 1 }, { opacity: 1 }]);
});

test('Ken Burns closes in and drifts a different way slide by slide', () => {
  const first = kenBurnsFrames(0);
  assert.deepEqual(first[0], { transform: 'scale(1) translate(0%, 0%)' });
  assert.match(String(first[1].transform), /^scale\(1\.08\) translate\(/);
  const ends = [0, 1, 2, 3].map((i) => kenBurnsFrames(i)[1].transform);
  assert.equal(new Set(ends).size, 4);
  assert.deepEqual(kenBurnsFrames(4), first);
  assert.deepEqual(kenBurnsFrames(-1), kenBurnsFrames(3));
});

test('a video plays to its end (with a watchdog), or is cut at its duration when videoUntilEnd is off', () => {
  assert.deepEqual(slideTiming({ kind: 'image', durationSec: 8 }, { videoUntilEnd: true }), { advance: 'timer', ms: 8000 });
  assert.deepEqual(slideTiming({ kind: 'video', durationSec: 8 }, { videoUntilEnd: true }), { advance: 'ended', ms: null });
  assert.deepEqual(slideTiming({ kind: 'video', durationSec: 8 }, { videoUntilEnd: false }), { advance: 'timer', ms: 8000 });
  assert.equal(videoWatchdogMs(20.2), 20_200 + 5_000);
  assert.equal(videoWatchdogMs(NaN), VIDEO_WATCHDOG_UNKNOWN_MS);
  assert.equal(videoWatchdogMs(Infinity), VIDEO_WATCHDOG_UNKNOWN_MS);
  assert.equal(videoWatchdogMs(null), VIDEO_WATCHDOG_UNKNOWN_MS);
  // A round's time: a 20 s video played to its end counts 20, whatever its duration says.
  assert.equal(slideSeconds({ kind: 'video', durationSec: 8 }, true, 20.4), 20);
  assert.equal(slideSeconds({ kind: 'video', durationSec: 8 }, false, 20.4), 8);
  assert.equal(slideSeconds({ kind: 'video', durationSec: 8 }, true, undefined), 8);
  assert.equal(slideSeconds({ kind: 'image', durationSec: 5 }, true, 20), 5);
});

test('in order: round after round, as listed', () => {
  const rng = seeded(1);
  let c: Cursor = startCursor(3, false, rng);
  const seen: number[] = [];
  for (let i = 0; i < 7; i++) {
    seen.push(cursorIndex(c));
    c = nextCursor(c, 3, false, rng);
  }
  assert.deepEqual(seen, [0, 1, 2, 0, 1, 2, 0]);
  assert.equal(cursorIndex(startCursor(0, true, rng)), -1);
  assert.deepEqual(nextCursor(c, 0, false, rng), { order: [], pos: 0 });
});

test('shuffled: every slide once a round, a new order each round, never the same slide twice in a row', () => {
  const rng = seeded(42);
  const n = 5;
  let c = startCursor(n, true, rng);
  const rounds: number[][] = [];
  let round: number[] = [];
  let last = -1;
  for (let i = 0; i < n * 40; i++) {
    const idx = cursorIndex(c);
    assert.notEqual(idx, last, 'the same slide twice in a row');
    last = idx;
    round.push(idx);
    if (round.length === n) {
      assert.deepEqual([...round].sort(), [0, 1, 2, 3, 4]);
      rounds.push(round);
      round = [];
    }
    c = nextCursor(c, n, true, rng);
  }
  assert.ok(new Set(rounds.map((r) => r.join())).size > 5, 'the order changes from round to round');
  // Two slides: they alternate.
  let two = startCursor(2, true, seeded(7));
  const alt: number[] = [];
  for (let i = 0; i < 8; i++) {
    alt.push(cursorIndex(two));
    two = nextCursor(two, 2, true, seeded(i));
  }
  for (let i = 1; i < alt.length; i++) assert.notEqual(alt[i], alt[i - 1]);
});

test('a shuffle never starts with the slide asked to avoid, and the playlist changing size restarts the round', () => {
  for (let seed = 0; seed < 50; seed++) assert.notEqual(shuffled(4, seeded(seed), 2)[0], 2);
  assert.deepEqual(shuffled(1, seeded(3), 0), [0]);
  assert.deepEqual(roundOrder(3, false, seeded(1)), [0, 1, 2]);
  // An rng that answers 1 (out of its range) still gives a permutation.
  assert.deepEqual([...shuffled(4, () => 1)].sort(), [0, 1, 2, 3]);
  const c = nextCursor({ order: [0, 1, 2], pos: 0 }, 5, false, seeded(1));
  assert.deepEqual(c, { order: [0, 1, 2, 3, 4], pos: 0 });
});
