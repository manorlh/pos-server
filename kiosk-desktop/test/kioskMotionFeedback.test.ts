/**
 * "מנוע הנפשות" on the Windows (and browser) kiosk: the feedback the engine's events play on the
 * shared screens (client components/dashboard/kiosks/preview-feedback.tsx, preview-motion.tsx) —
 * the press, "נוסף להזמנה", the basket badge, the success, the error, the screens' homeReturn /
 * cartOpen and every event's own curve — each from the resolved engine's times, and reduced
 * motion's fallbacks (fades and highlights, no movement).
 */
import { describe, expect, it } from 'vitest';
import { engineTransitionSpec, resolveKioskConfig, resolveThemeColors, transitionSpec } from '@dash-lib/kioskConfig';
import { motionCurve, resolveMotionEngine, type MotionEngineSettings, type MotionProfile } from '@dash-lib/kioskMotionEngine';
import {
  ERROR_MAX_REPEAT,
  FEEDBACK_CSS,
  MOTION_CSS,
  PREVIEW_CSS,
  TOAST_MIN_HOLD_MS,
  badgePop,
  chromeRoot,
  confettiPieces,
  engineRoot,
  errorFx,
  itemEnter,
  pressFx,
  screenSwap,
  sheetEnter,
  successFx,
  toastFx,
  toastVars,
  type PreviewModel,
} from '@kiosk-shared/index';

const engineOf = (motion: MotionEngineSettings = {}, reduceMotion = false, profile: MotionProfile = 'full') => resolveMotionEngine({ preset: 'standard', ...motion }, { reduceMotion, profile });
const colors = { button: '#0055FF', accent: '#FF8800' };
const vars = (engine = engineOf()) => engineRoot(engine, colors).style;

describe('the press (productPress) on the dishes and the main buttons', () => {
  it('an immediate press-in of 30% of the engine\'s time, the release over the rest', () => {
    const v = vars();
    // Runner Standard: Press 450 ms, to 0.96.
    expect([v['--m-press-ms'], v['--m-press-in'], v['--m-press-out']]).toEqual(['450ms', '135ms', '315ms']);
    expect(v['--m-press-scale']).toBe('0.96');
    expect(engineRoot(engineOf(), colors).className).toBe('k-meng k-mpress k-mpress-scalePress');
    // An event's own time (an override ignores the global speed) and the global speed.
    const own = vars(engineOf({ globalSpeed: 'slow', events: { productPress: { durationMs: 800 } } }));
    expect([own['--m-press-in'], own['--m-press-out']]).toEqual(['240ms', '560ms']);
    expect(vars(engineOf({ globalSpeed: 'slow' }))['--m-press-ms']).toBe('585ms');
  });

  it('kinds: scalePress and bounce move by intensity; ripple and highlight only light up; bounce springs back', () => {
    expect(vars(engineOf({ events: { productPress: { intensity: 50 } } }))['--m-press-scale']).toBe('0.98');
    const bounce = engineOf({ events: { productPress: { animationType: 'bounce' } } });
    expect(engineRoot(bounce, colors).className).toContain('k-mpress-bounce');
    expect(vars(bounce)['--m-press-ease-out']).toBe(motionCurve('overshoot', ''));
    for (const kind of ['ripple', 'highlight'] as const) {
      const e = engineOf({ events: { productPress: { animationType: kind } } });
      expect(engineRoot(e, colors).className).toContain(`k-mpress-${kind}`);
      expect(vars(e)['--m-press-scale']).toBe('1');
    }
    // An own curve on both halves.
    expect(vars(engineOf({ events: { productPress: { easing: 'linear' } } }))['--m-press-ease-in']).toBe('cubic-bezier(0,0,1,1)');
    // Off: no press at all (not even today's).
    const off = engineOf({ events: { productPress: { enabled: false } } });
    expect(engineRoot(off, colors).className).toContain('k-mpress-none');
    expect(vars(off)['--m-press-scale']).toBe('1');
  });

  it('reduced motion: the highlight alone, half the time, nothing moves', () => {
    const p = pressFx(engineOf({}, true).productPress);
    expect([p.kind, p.scale, p.ms, p.inMs, p.outMs]).toEqual(['highlight', 1, 225, 68, 157]);
    expect(engineRoot(engineOf({}, true), colors).className).toContain('k-mpress-highlight');
  });

  it('chromeRoot carries it only with an engine (none: exactly as before)', () => {
    const cfg = resolveKioskConfig({ theme: { uiStyle: 'wolt' } });
    const m = { cfg, c: resolveThemeColors(cfg.theme), light: false } as unknown as PreviewModel;
    expect(chromeRoot(m)).toEqual({ className: '', style: {} });
    const withEngine = chromeRoot({ ...m, engine: engineOf() });
    expect(withEngine.className).toBe('k-meng k-mpress k-mpress-scalePress');
    expect((withEngine.style as Record<string, string>)['--m-press-in']).toBe('135ms');
    expect((withEngine.style as Record<string, string>)['--k-bounce-ms']).toBe('550ms');
  });
});

describe('add to cart: the badge and "נוסף להזמנה"', () => {
  const model = (engine?: ReturnType<typeof engineOf>, bounce = 1.12) => ({ motion: { bounce }, engine });

  it('the badge pops by cartBadge\'s time and curve; its kinds; reduced — a colour ring', () => {
    expect(vars()['--k-bounce-ms']).toBe('550ms');
    expect(vars()['--k-bounce-ease']).toBe(motionCurve('overshoot', ''));
    expect(badgePop(model(engineOf())).className).toBe('kiosk-bounce');
    expect(badgePop(model(engineOf({ events: { cartBadge: { animationType: 'bounce' } } }))).className).toBe('kiosk-bounce k-badge-bounce');
    expect(badgePop(model(engineOf({ events: { cartBadge: { animationType: 'pulse' } } }))).className).toBe('kiosk-bounce k-badge-pulse');
    expect(badgePop(model(engineOf({}, true), 0)).className).toBe('k-badge-flash');
    expect(badgePop(model(engineOf({ events: { cartBadge: { enabled: false } } }))).className).toBeUndefined();
    // Its own size when the add gives none (each event its own).
    expect((badgePop(model(engineOf(), 0)).style as Record<string, string>)['--k-bounce']).toBe('1.25');
    // An empty basket: no pop.
    expect(badgePop(model(engineOf()), false).className).toBeUndefined();
    // No engine: today's.
    expect(badgePop(model(undefined)).className).toBe('kiosk-bounce');
    expect(badgePop(model(undefined, 0)).className).toBeUndefined();
  });

  it('the toast: in by its kind and time, held at least its hold, then out', () => {
    const t = toastFx(engineOf());
    expect(t).toMatchObject({ animated: true, inMs: 450, holdMs: 2000, outMs: 450, delayMs: 0, totalMs: 2900, from: 'none' });
    expect(toastVars(t!)).toMatchObject({ '--m-toast-in': '450ms', '--m-toast-out-at': '2450ms' });
    expect(toastFx(engineOf({ events: { toast: { animationType: 'slideIn' } } }))?.from).toBe('translate3d(0, 16px, 0)');
    expect(toastFx(engineOf({ events: { toast: { animationType: 'slideIn', direction: 'down', distancePx: 30, intensity: 50 } } }))?.from).toBe('translate3d(0, -15px, 0)');
    expect(toastFx(engineOf({ events: { toast: { animationType: 'fadeScale' } } }))?.from).toBe('scale(0.9)');
    // A meaningful confirmation never shows for less than TOAST_MIN_HOLD_MS (spec §16).
    expect(toastFx(engineOf({ events: { toast: { holdMs: 100 } } }))?.holdMs).toBe(TOAST_MIN_HOLD_MS);
    expect(toastFx(engineOf({ events: { toast: { holdMs: 3000 } } }))?.holdMs).toBe(3000);
    // Reduced: a fade at half the time; still said.
    expect(toastFx(engineOf({ events: { toast: { animationType: 'slideIn' } } }, true))).toMatchObject({ from: 'none', inMs: 225 });
    // Off: nothing; no engine: nothing (as before).
    expect(toastFx(engineOf({ events: { toast: { enabled: false } } }))).toBeNull();
    expect(toastFx(undefined)).toBeNull();
  });

  it('the flight plays the engine\'s add (engineTransitionSpec keeps it logically immediate: the kind only)', () => {
    expect(engineTransitionSpec(engineOf()).addToCart).toBe('fly');
    expect(engineTransitionSpec(engineOf({}, true)).addToCart).toBe('none');
  });
});

describe('the success and the error', () => {
  it('success: the ✓ drawn, the number zooming in after it, confetti by kind; reduced — fades', () => {
    const s = successFx(engineOf())!;
    expect([s.kind, s.confetti, s.mark.className, s.number.className]).toEqual(['draw', false, 'k-sx k-sx-draw', 'k-sx-num']);
    expect(s.mark.style).toMatchObject({ '--m-sx-ms': '400ms', '--m-sx-draw-ms': '450ms', '--m-sx-draw-delay': '250ms', '--m-sx-from': '0.6' });
    expect(s.number.style).toMatchObject({ '--m-sx-num-ms': '550ms', '--m-sx-num-delay': '450ms' });
    expect(successFx(engineOf({ events: { success: { animationType: 'successZoom' } } }))?.mark.className).toBe('k-sx k-sx-zoom');
    expect(successFx(engineOf({ events: { success: { animationType: 'confetti' } } }))?.confetti).toBe(true);
    // The light profile plays a drawn ✓ instead of the burst (the engine's).
    expect(successFx(engineOf({ events: { success: { animationType: 'confetti' } } }, false, 'light'))?.confetti).toBe(false);
    const reduced = successFx(engineOf({}, true))!;
    expect([reduced.kind, reduced.mark.className, reduced.number.className]).toEqual(['fade', 'k-mfade', 'k-mfade']);
    expect(reduced.mark.style).toMatchObject({ '--m-fade-ms': '300ms' });
    expect(successFx(engineOf({ events: { success: { enabled: false } } }))?.kind).toBe('none');
    expect(successFx(undefined)).toBeNull();
    // The burst: the same every time, around the ✓.
    expect(confettiPieces()).toEqual(confettiPieces());
    expect(confettiPieces()).toHaveLength(14);
  });

  it('error: a gentle shake by distancePx × intensity; wiggle; highlight; reduced — the ring alone; never a loop', () => {
    const e = errorFx(engineOf())!;
    expect(e.className).toBe('k-err k-err-shake');
    expect(e.style).toMatchObject({ '--m-err-ms': '550ms', '--m-err-x': '10px', '--m-err-y': '0px', '--m-err-n': '1' });
    expect(errorFx(engineOf({ events: { error: { intensity: 150 } } }))?.style).toMatchObject({ '--m-err-x': '15px' });
    expect(errorFx(engineOf({ events: { error: { direction: 'up', distancePx: 8 } } }))?.style).toMatchObject({ '--m-err-x': '0px', '--m-err-y': '8px' });
    expect(errorFx(engineOf({ events: { error: { animationType: 'wiggle' } } }))?.className).toBe('k-err k-err-wiggle');
    expect(errorFx(engineOf({ events: { error: { animationType: 'highlight' } } }))?.className).toBe('k-err k-err-flash');
    expect(errorFx(engineOf({ events: { error: { repeat: 0 } } }))?.style).toMatchObject({ '--m-err-n': '1' });
    expect(errorFx(engineOf({ events: { error: { repeat: 9 } } }))?.style).toMatchObject({ '--m-err-n': String(ERROR_MAX_REPEAT) });
    const reduced = errorFx(engineOf({}, true))!;
    expect(reduced.className).toBe('k-err k-err-flash');
    expect(reduced.style).toMatchObject({ '--m-err-ms': '275ms' });
    expect(errorFx(engineOf({ events: { error: { enabled: false } } }))).toEqual({ className: '', style: {} });
    expect(errorFx(undefined)).toBeNull();
  });
});

describe('the screens and the windows: homeReturn, cartOpen and each event\'s curve', () => {
  const t = (motion: MotionEngineSettings = {}, reduce = false) => engineTransitionSpec(engineOf(motion, reduce));

  it('back home by homeReturn (a fade, never a sharp reset); into the basket by cartOpen (rising, with a fade)', () => {
    const e = engineOf();
    expect(screenSwap(engineTransitionSpec(e), e, 'attract')).toEqual({ fx: 'fade', ms: 700 });
    expect(screenSwap(engineTransitionSpec(e), e, 'cart')).toEqual({ fx: 'rise', ms: 650 });
    expect(screenSwap(engineTransitionSpec(e), e, 'catalog')).toEqual({ fx: 'slide', ms: 650 });
    const down = engineOf({ events: { cartOpen: { direction: 'down' } } });
    expect(screenSwap(engineTransitionSpec(down), down, 'cart').fx).toBe('drop');
    const left = engineOf({ events: { cartOpen: { direction: 'left' } } });
    expect(screenSwap(engineTransitionSpec(left), left, 'cart')).toEqual({ fx: 'slide', ms: 650, side: 1 });
    const zoom = engineOf({ events: { homeReturn: { animationType: 'fadeScale', scaleFrom: 0.9, easing: 'emphasized' } } });
    expect(screenSwap(engineTransitionSpec(zoom), zoom, 'attract')).toEqual({ fx: 'zoom', ms: 700, ease: motionCurve('emphasized', '') });
    const off = engineOf({ events: { homeReturn: { enabled: false } } });
    expect(screenSwap(engineTransitionSpec(off), off, 'attract')).toEqual({ fx: 'none', ms: 0 });
    // Reduced: a fade at half the time.
    const reduced = engineOf({}, true);
    expect(screenSwap(engineTransitionSpec(reduced), reduced, 'cart')).toEqual({ fx: 'fade', ms: 325 });
    // No engine: the transition spec's, as before.
    const old = transitionSpec({ screenChange: 'slide' }, { reduceMotion: false });
    expect(screenSwap(old, undefined, 'attract')).toEqual({ fx: 'slide', ms: old.screenMs });
  });

  it('an event\'s own curve reaches its swap, its window and its cards; "auto" keeps the kinds\' own (no --k-ease)', () => {
    expect(t()).not.toHaveProperty('categoryEase');
    expect(t()).not.toHaveProperty('sheetEase');
    const own = t({ events: { categorySwitch: { easing: 'linear' }, modalOpen: { easing: 'overshoot' }, itemsEnter: { easing: 'decelerate', animationType: 'slideIn' }, pageTransition: { easing: 'accelerate' } } });
    expect(own.categoryEase).toBe('cubic-bezier(0,0,1,1)');
    expect(own.screenEase).toBe('cubic-bezier(.4,0,1,1)');
    expect(sheetEnter(own).style).toEqual({ '--k-ms': '650ms', '--k-ease': 'cubic-bezier(.34,1.56,.64,1)' });
    expect(sheetEnter(own).panel).toBe('k-anim k-sheet-scale');
    expect((itemEnter(own, 1).style as Record<string, string>)['--k-ease']).toBe('cubic-bezier(.2,.7,.2,1)');
    expect(sheetEnter(t()).style).toEqual({ '--k-ms': '650ms' });
    // Reduced: a plain fade, never a curve of its own.
    expect(t({ events: { modalOpen: { easing: 'overshoot' } } }, true).sheetEase).toBeUndefined();
  });
});

describe('the feedback\'s CSS', () => {
  const frames = (css: string) => [...css.matchAll(/@keyframes\s+(\w+)\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)];

  it('moves only transform and opacity; the highlights are a ring or a stroke (paint), never a layout', () => {
    const found = frames(FEEDBACK_CSS);
    expect(found.map((f) => f[1])).toEqual(expect.arrayContaining(['kMFade', 'kBadgeBounce', 'kBadgeFlash', 'kToastIn', 'kSxDraw', 'kSxNum', 'kConfetti', 'kErrShake', 'kErrWiggle', 'kErrFlash']));
    const highlights: Record<string, string> = { kBadgeFlash: 'box-shadow', kErrFlash: 'outline-color', kSxDraw: 'stroke-dashoffset' };
    for (const [, name, body] of found) {
      const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map((x) => x[1]);
      expect(props.length, name).toBeGreaterThan(0);
      for (const p of props) expect(['opacity', 'transform', highlights[name]], `${name}: ${p}`).toContain(p);
    }
    // The swaps' new keyframes (the basket's rise / drop) are the compositor's too — MOTION_CSS's own test covers them.
    expect(MOTION_CSS).toContain('.k-rise-in { animation-name: kRiseIn; }');
  });

  it('every engine class reads its times from the engine\'s custom properties (no time of its own)', () => {
    expect(FEEDBACK_CSS).toContain('.k-mpress .k-tap:not(:disabled):active { scale: var(--m-press-scale, 1); transition-duration: var(--m-press-in, 120ms)');
    expect(FEEDBACK_CSS).toContain('.k-mpress .k-tap { transition: scale var(--m-press-out, 300ms) var(--m-press-ease-out');
    expect(FEEDBACK_CSS).toMatch(/\.k-toast \{ animation: kToastIn var\(--m-toast-in, 300ms\)[^}]*kToastOut var\(--m-toast-out, 300ms\)[^}]*var\(--m-toast-out-at, 2300ms\)/);
    expect(FEEDBACK_CSS).toContain('.k-sx-num { animation: kSxNum var(--m-sx-num-ms, 550ms)');
    expect(FEEDBACK_CSS).toContain('.k-err-shake { animation: kErrShake var(--m-err-ms, 450ms)');
    // The badge: today's 0.45 s curve unless the engine sets its own.
    expect(PREVIEW_CSS).toContain('.kiosk-bounce { animation: kioskBounce var(--k-bounce-ms, 0.45s) var(--k-bounce-ease, cubic-bezier(.3,1.6,.5,1))');
    expect(PREVIEW_CSS).toContain(FEEDBACK_CSS);
  });

  it('reduced motion: the root\'s `.k-reduce` lets only the fallbacks play (opacity, a ring); the device\'s setting turns movement into them', () => {
    const reduceLines = FEEDBACK_CSS.split('\n').filter((l) => l.startsWith('.k-root.k-reduce'));
    expect(reduceLines.length).toBeGreaterThanOrEqual(5);
    for (const l of reduceLines) {
      for (const [, name] of l.matchAll(/(k[A-Z]\w+)/g)) expect(['kMFade', 'kToastIn', 'kToastOut', 'kBadgeFlash', 'kErrFlash'], l).toContain(name);
      expect(l).not.toMatch(/scale\(|translate|rotate/);
    }
    const media = FEEDBACK_CSS.slice(FEEDBACK_CSS.indexOf('@media (prefers-reduced-motion: reduce)'));
    expect(media).toContain('.k-mpress .k-tap:not(:disabled):active { scale: none; }');
    expect(media).toContain('.k-err-shake, .k-err-wiggle { animation-name: kErrFlash !important;');
    expect(media).toContain('.k-sx-draw, .k-sx-zoom, .k-sx-num { animation-name: kMFade !important; }');
    expect(media).toContain('.k-toast { --m-toast-from: none !important; }');
    expect(media).toContain('.k-confetti { display: none; }');
  });
});
