'use client';

/**
 * "מנוע הנפשות" — the feedback the engine's events play on the web kiosks' screens (the dashboard's
 * live preview, the browser kiosk and the Windows kiosk), each from its resolved event
 * (lib/kioskMotionEngine.ts — the preset, the speed, the event's own values, the light profile and
 * reduced motion already in it), never a time of its own (spec §13):
 *
 *   productPress  the dishes' cards and the main buttons (`.k-tap`): an immediate press-in (30% of
 *                 the time), the release over the rest, with a highlight; scalePress / ripple /
 *                 highlight / bounce — CSS custom properties on the kiosk's root (engineRoot)
 *   toast         "נוסף להזמנה" after an add (AddedToast): in, held at least the configured hold, out
 *   cartBadge     the basket's count pops by its time and curve (badgePop); reduced — a colour ring
 *   success       the ✓ drawn (SVG stroke-dashoffset), the order's number zooming in, confetti by kind
 *   error         a gentle shake (distancePx × intensity) / wiggle / highlight (errorFx)
 *
 * Only `transform` and `opacity` move, on the compositor; the highlights are a ring or a tint
 * (paint, never a layout). Nothing ever waits for them: a tap acts at once, an add is in the basket
 * before its flight starts, the payment's double-tap guard is the flow's own.
 *
 * Reduced motion: the engine's fallbacks (`reduced`) are fades and highlights with no movement —
 * they play even under the root's `.k-reduce` (which stops every other animation), so the feedback
 * stays (spec §14). The device's `prefers-reduced-motion` turns the movements here into the same
 * fades and highlights (FEEDBACK_CSS).
 *
 * Shared through `@/kiosk-shared`: only React, lucide-react, `lib/utils`, `lib/kioskConfig` and
 * `lib/kioskMotionEngine`.
 */

import { useEffect, useState, type CSSProperties } from 'react';
import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { EASE_ENTER, EASE_EXIT, EASE_POP_RISE, EASE_POP_SETTLE, type MotionSpec, type ResolvedThemeColors } from '@/lib/kioskConfig';
import { motionActive, motionCurve, type ResolvedMotion, type ResolvedMotionEngine } from '@/lib/kioskMotionEngine';

/** The press-in's share of the press's time; the release takes the rest. */
export const PRESS_IN_SHARE = 0.3;
/** A meaningful confirmation never shows for less than this (spec §16). */
export const TOAST_MIN_HOLD_MS = 800;
/** The basket badge's pops: at most this many in a row (0 — "loop" — is one: the add is a moment). */
export const BADGE_MAX_REPEAT = 5;
/** An error shakes at most this many times (never a loop: no distracting motion, spec §14). */
export const ERROR_MAX_REPEAT = 3;
/** The error's colour (the screens' own red). */
export const ERROR_COLOR = '#DC2626';

const OVERSHOOT = motionCurve('overshoot', EASE_POP_RISE);

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const round3 = (v: number) => Math.round(v * 1000) / 1000;
const kOf = (s: Pick<ResolvedMotion, 'intensity'>) => clamp(s.intensity / 100, 0, 2);

/** An event's own curve, or `fallback` for "auto" (and for a reduced fallback: a plain fade / highlight). */
function curveOf(s: Pick<ResolvedMotion, 'easing' | 'reduced'>, fallback: string): string {
  return s.reduced ? fallback : motionCurve(s.easing, fallback);
}

/* ------------------------------------------------------------------ press */

export type PressKind = 'scalePress' | 'ripple' | 'highlight' | 'bounce' | 'none';

export interface PressFx {
  kind: PressKind;
  ms: number;
  /** The press-in (PRESS_IN_SHARE of the time) and the release (the rest). */
  inMs: number;
  outMs: number;
  delayMs: number;
  /** The pressed size (1: no movement — highlight, ripple, reduced). */
  scale: number;
  easeIn: string;
  easeOut: string;
  /** The highlight's strength, 0–1. */
  strength: number;
}

const PRESS_KINDS: readonly PressKind[] = ['scalePress', 'ripple', 'highlight', 'bounce'];

/** The press as played: its kind, its times and its size (reduced motion: the highlight alone). */
export function pressFx(s: ResolvedMotion): PressFx {
  if (!motionActive(s)) return { kind: 'none', ms: 0, inMs: 0, outMs: 0, delayMs: 0, scale: 1, easeIn: EASE_ENTER, easeOut: EASE_ENTER, strength: 0 };
  const kind: PressKind = s.reduced ? 'highlight' : PRESS_KINDS.includes(s.animationType as PressKind) ? (s.animationType as PressKind) : 'scalePress';
  const k = kOf(s);
  const moves = kind === 'scalePress' || kind === 'bounce';
  const inMs = Math.round(s.durationMs * PRESS_IN_SHARE);
  return {
    kind,
    ms: s.durationMs,
    inMs,
    outMs: s.durationMs - inMs,
    delayMs: s.delayMs,
    scale: moves ? round3(clamp(1 - (1 - s.scaleTo) * k, 0.8, 1.2)) : 1,
    easeIn: curveOf(s, EASE_ENTER),
    // "קפיצה": the release springs past its size.
    easeOut: curveOf(s, kind === 'bounce' ? OVERSHOOT : EASE_ENTER),
    strength: clamp(k, 0, 1),
  };
}

/**
 * The kiosk's root from the engine ("מנוע הנפשות"): its classes (`k-meng`, the press's
 * `k-mpress k-mpress-<kind>`) and the CSS custom properties the feedback reads — the press
 * (`--m-press-*`), the basket badge (`--k-bounce-*`). chromeRoot adds them when the model has an engine.
 */
export function engineRoot(engine: ResolvedMotionEngine, c: Pick<ResolvedThemeColors, 'button' | 'accent'>): { className: string; style: Record<string, string> } {
  const p = pressFx(engine.productPress);
  const fill = Math.round(16 * p.strength);
  const ring = Math.round(70 * p.strength);
  const b = engine.cartBadge;
  const style: Record<string, string> = {
    '--m-press-ms': `${p.ms}ms`,
    '--m-press-in': `${p.inMs}ms`,
    '--m-press-out': `${p.outMs}ms`,
    '--m-press-delay': `${p.delayMs}ms`,
    '--m-press-scale': String(p.scale),
    '--m-press-ease-in': p.easeIn,
    '--m-press-ease-out': p.easeOut,
    '--m-press-fill': `color-mix(in srgb, ${c.button} ${fill}%, transparent)`,
    '--m-press-ring': `color-mix(in srgb, ${c.button} ${ring}%, transparent)`,
    '--m-press-solid': String(round3(0.24 * p.strength)),
    '--m-press-solid-ring': String(round3(0.5 * p.strength)),
    // The basket's badge (badgePop): its time, curve, delay and count; its reduced ring's colour.
    '--k-bounce-ms': `${motionActive(b) ? b.durationMs : 0}ms`,
    '--k-bounce-ease': b.animationType === 'pulse' ? curveOf(b, EASE_POP_SETTLE) : curveOf(b, OVERSHOOT),
    '--k-bounce-delay': `${b.delayMs}ms`,
    '--k-bounce-n': String(clamp(b.repeat || 1, 1, BADGE_MAX_REPEAT)),
    '--m-badge-hl': c.accent,
  };
  return { className: `k-meng k-mpress k-mpress-${p.kind}`, style };
}

/* ------------------------------------------------------------ cart badge */

/**
 * The basket count's pop (re-mounted by `cartBump`, so replayed on every landing): without an
 * engine today's `kiosk-bounce` by the add's motion; with one, cartBadge's kind (pop / bounce /
 * pulse) at its time and curve (the root's `--k-bounce-*`), its reduced fallback a colour ring.
 * `on`: the badge shows a count.
 */
export function badgePop(m: { motion: Pick<MotionSpec, 'bounce'>; engine?: ResolvedMotionEngine }, on = true): { className?: string; style: CSSProperties } {
  const peak = m.motion.bounce;
  const style = { '--k-bounce': String(peak || 1) } as CSSProperties;
  const b = m.engine?.cartBadge;
  if (!b) return { className: on && peak > 0 ? 'kiosk-bounce' : undefined, style };
  if (!on || !motionActive(b)) return { style };
  if (b.reduced) return { className: 'k-badge-flash', style };
  // Its own size when the add's motion gives none (each event its own — spec §5).
  const size = peak > 0 ? peak : round3(1 + (b.scaleTo - 1) * kOf(b));
  const kind = b.animationType === 'bounce' ? ' k-badge-bounce' : b.animationType === 'pulse' ? ' k-badge-pulse' : '';
  return { className: `kiosk-bounce${kind}`, style: { '--k-bounce': String(size) } as CSSProperties };
}

/* ------------------------------------------------------------------ toast */

export interface ToastFx {
  /** Whether it moves at all (a kind; "none" — it just appears and goes). */
  animated: boolean;
  inMs: number;
  holdMs: number;
  outMs: number;
  delayMs: number;
  /** From the add to its end (it is unmounted then). */
  totalMs: number;
  /** Where it comes from (a CSS transform; "none" for a fade). */
  from: string;
  ease: string;
}

/**
 * "נוסף להזמנה" as the engine's toast plays it: fadeIn / slideIn (by its direction, distancePx ×
 * intensity) / fadeScale, held at least its configured hold (and never under TOAST_MIN_HOLD_MS),
 * then out. Null: no engine (the kiosk says nothing, as before), or the event is off.
 */
export function toastFx(engine: ResolvedMotionEngine | undefined): ToastFx | null {
  const t = engine?.toast;
  if (!t || !t.enabled) return null;
  const animated = motionActive(t);
  const inMs = animated ? t.durationMs : 0;
  const outMs = inMs;
  const holdMs = Math.max(t.holdMs, TOAST_MIN_HOLD_MS);
  const d = Math.round((t.distancePx > 0 ? t.distancePx : 16) * kOf(t));
  let from = 'none';
  if (animated && !t.reduced) {
    if (t.animationType === 'slideIn') {
      from =
        t.direction === 'down' ? `translate3d(0, ${-d}px, 0)` : t.direction === 'left' ? `translate3d(${d}px, 0, 0)` : t.direction === 'right' ? `translate3d(${-d}px, 0, 0)` : `translate3d(0, ${d}px, 0)`;
    } else if (t.animationType === 'fadeScale') {
      from = `scale(${round3(t.scaleFrom < 1 ? t.scaleFrom : 0.9)})`;
    }
  }
  return { animated, inMs, holdMs, outMs, delayMs: t.delayMs, totalMs: t.delayMs + inMs + holdMs + outMs, from, ease: curveOf(t, EASE_ENTER) };
}

/** The toast's CSS custom properties (FEEDBACK_CSS `.k-toast`). */
export function toastVars(fx: ToastFx): CSSProperties {
  return {
    '--m-toast-in': `${fx.inMs}ms`,
    '--m-toast-out': `${fx.outMs}ms`,
    '--m-toast-delay': `${fx.delayMs}ms`,
    '--m-toast-out-at': `${fx.delayMs + fx.inMs + fx.holdMs}ms`,
    '--m-toast-from': fx.from,
    '--m-toast-ease': fx.ease,
  } as CSSProperties;
}

/**
 * "נוסף להזמנה" (spec §4): shown when the basket's badge pops (`cartBump` grows — the flight landed,
 * or the add had none), at the bottom of the kiosk, over everything and taking no tap. The add
 * itself happened already; this only confirms it (spec §15). Mounting it shows nothing.
 */
export function AddedToast({ m, bottom = 96 }: { m: { engine?: ResolvedMotionEngine; cartBump: number; t: (key: string) => string; c: Pick<ResolvedThemeColors, 'accent'> }; bottom?: number }) {
  const fx = toastFx(m.engine);
  const [seen, setSeen] = useState({ bump: m.cartBump, show: 0 });
  if (m.cartBump !== seen.bump) setSeen({ bump: m.cartBump, show: m.cartBump > seen.bump && fx ? m.cartBump : 0 });
  const total = fx?.totalMs ?? 0;
  useEffect(() => {
    if (!seen.show) return;
    const shown = seen.show;
    const id = window.setTimeout(() => setSeen((s) => (s.show === shown ? { ...s, show: 0 } : s)), total + 60);
    return () => window.clearTimeout(id);
  }, [seen.show, total]);
  if (!fx || !seen.show) return null;
  return (
    <div role="status" aria-live="polite" className="pointer-events-none absolute inset-x-0 z-[55] flex justify-center px-6" style={{ bottom }}>
      <div
        key={seen.show}
        data-toast="added"
        className="k-toast flex max-w-full items-center gap-2 rounded-full px-4 py-2.5 kt-15 font-bold shadow-lg"
        style={{ ...toastVars(fx), background: 'rgba(17,24,39,0.92)', color: '#FFFFFF', border: '1px solid rgba(255,255,255,0.14)' }}
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full" style={{ background: m.c.accent, color: '#FFFFFF' }}>
          <Check className="h-4 w-4" strokeWidth={3} />
        </span>
        <span className="truncate">{m.t('addedToOrder')}</span>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- success */

export type SuccessKind = 'draw' | 'zoom' | 'fade' | 'none';

export interface SuccessFx {
  kind: SuccessKind;
  confetti: boolean;
  /** The ✓'s badge and the order's number: their classes and times. */
  mark: { className: string; style: CSSProperties };
  number: { className: string; style: CSSProperties };
}

/**
 * The success (spec §4 "Draw Check + Success Zoom + the order's number"): drawCheck — the badge pops,
 * the ✓ is drawn, the number zooms in; successZoom — the badge zooms in with an overshoot; confetti —
 * drawCheck and a burst; fadeIn and reduced motion — both fade in. Null: no engine (today's pop).
 */
export function successFx(engine: ResolvedMotionEngine | undefined): SuccessFx | null {
  const s = engine?.success;
  if (!s) return null;
  if (!motionActive(s)) return { kind: 'none', confetti: false, mark: { className: '', style: {} }, number: { className: '', style: {} } };
  const d = s.durationMs;
  const at = (share: number) => s.delayMs + Math.round(d * share);
  const ms = (share: number) => `${Math.round(d * share)}ms`;
  if (s.reduced || s.animationType === 'fadeIn') {
    return {
      kind: 'fade',
      confetti: false,
      mark: { className: 'k-mfade', style: { '--m-fade-ms': ms(0.6), '--m-fade-delay': `${s.delayMs}ms` } as CSSProperties },
      number: { className: 'k-mfade', style: { '--m-fade-ms': ms(0.6), '--m-fade-delay': `${at(0.3)}ms` } as CSSProperties },
    };
  }
  const zoom = s.animationType === 'successZoom';
  const from = String(round3(clamp(s.scaleFrom < 1 ? s.scaleFrom : 0.6, 0.2, 0.98)));
  const ease = curveOf(s, zoom ? OVERSHOOT : EASE_POP_RISE);
  return {
    kind: zoom ? 'zoom' : 'draw',
    confetti: s.animationType === 'confetti',
    mark: {
      className: zoom ? 'k-sx k-sx-zoom' : 'k-sx k-sx-draw',
      style: {
        '--m-sx-ms': ms(zoom ? 0.5 : 0.4),
        '--m-sx-delay': `${s.delayMs}ms`,
        '--m-sx-from': from,
        '--m-sx-ease': ease,
        '--m-sx-draw-ms': ms(zoom ? 0.3 : 0.45),
        '--m-sx-draw-delay': `${at(zoom ? 0.2 : 0.25)}ms`,
        '--m-sx-confetti-ms': `${Math.max(900, Math.round(d * 1.5))}ms`,
        '--m-sx-confetti-delay': `${at(0.3)}ms`,
        '--m-sx-k': String(round3(kOf(s))),
      } as CSSProperties,
    },
    number: {
      className: 'k-sx-num',
      style: { '--m-sx-num-ms': ms(0.55), '--m-sx-num-delay': `${at(0.45)}ms`, '--m-sx-from': from, '--m-sx-ease': curveOf(s, EASE_POP_RISE) } as CSSProperties,
    },
  };
}

const CONFETTI_PIECES = 14;

/** The burst's pieces: where each flies (deterministic — the same burst every time). */
export function confettiPieces(n = CONFETTI_PIECES): Array<{ dx: number; dy: number; rot: number; delay: number; tone: number }> {
  return Array.from({ length: n }, (_, i) => {
    const angle = ((i * 360) / n + ((i * 37) % 19)) * (Math.PI / 180);
    const dist = 64 + ((i * 23) % 48);
    return { dx: Math.round(Math.cos(angle) * dist), dy: Math.round(Math.sin(angle) * dist * 0.85 - 18), rot: ((i * 71) % 300) - 150, delay: (i * 29) % 120, tone: i % 4 };
  });
}

/** The success's ✓ in its badge (the engine's way): drawn, zoomed, faded or still; the burst by kind. */
export function SuccessMark({ fx, colors, outlined, tones }: { fx: SuccessFx; colors: CSSProperties; outlined: boolean; tones: readonly string[] }) {
  return (
    <span
      data-success-mark={fx.kind}
      className={cn('relative mt-2 flex h-16 w-16 items-center justify-center rounded-full', !outlined && 'shadow-lg', fx.mark.className)}
      style={{ ...colors, ...fx.mark.style }}
    >
      <svg viewBox="0 0 24 24" className="h-9 w-9" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path className="k-sx-check" d="M4 12.5l5 5L20 6.5" pathLength={1} />
      </svg>
      {fx.confetti
        ? confettiPieces().map((p, i) => (
            <span
              key={i}
              aria-hidden
              className="k-confetti"
              style={{ '--dx': `${p.dx}px`, '--dy': `${p.dy}px`, '--rot': `${p.rot}deg`, '--cd': `${p.delay}ms`, background: tones[p.tone % tones.length] } as CSSProperties}
            />
          ))
        : null}
    </span>
  );
}

/* ------------------------------------------------------------------ error */

export interface ErrorFx {
  className: string;
  style: CSSProperties;
}

/**
 * A gentle error (spec §4 "Shake עדין"): shake — side to side (up / down: vertically) by distancePx
 * × intensity, wiggle — a small turn, highlight — a red ring flashing; reduced motion — the ring
 * alone. Re-mount (a new `key`) to play it again. Null: no engine (the screens do as before).
 */
export function errorFx(engine: ResolvedMotionEngine | undefined): ErrorFx | null {
  const e = engine?.error;
  if (!e) return null;
  if (!motionActive(e)) return { className: '', style: {} };
  const kind = e.reduced || e.animationType === 'highlight' ? 'flash' : e.animationType === 'wiggle' ? 'wiggle' : 'shake';
  const k = kOf(e);
  const d = Math.round(e.distancePx * k);
  const vertical = e.direction === 'up' || e.direction === 'down';
  return {
    className: `k-err k-err-${kind}`,
    style: {
      '--m-err-ms': `${e.durationMs}ms`,
      '--m-err-delay': `${e.delayMs}ms`,
      '--m-err-x': `${vertical ? 0 : d}px`,
      '--m-err-y': `${vertical ? d : 0}px`,
      '--m-err-deg': `${round3(2 * k)}deg`,
      '--m-err-ease': curveOf(e, EASE_POP_SETTLE),
      '--m-err-n': String(kind === 'flash' ? 1 : clamp(e.repeat || 1, 1, ERROR_MAX_REPEAT)),
    } as CSSProperties,
  };
}

/**
 * Brings `el` into view inside its scrolling `box` (only that box — never the kiosk's own frame),
 * when it is not in view already; smoothly unless reduced (or the device asks for less motion).
 */
export function revealIn(box: HTMLElement, el: HTMLElement, smooth: boolean): void {
  const b = box.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  if (r.top >= b.top && r.bottom <= b.bottom) return;
  const top = Math.max(0, box.scrollTop + (r.top - b.top) - 12);
  let still = !smooth;
  try {
    still = still || (typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  } catch {
    // No media queries: as asked.
  }
  if (typeof box.scrollTo === 'function') box.scrollTo({ top, behavior: still ? 'auto' : 'smooth' });
  else box.scrollTop = top;
}

/* -------------------------------------------------------------------- CSS */

/**
 * The CSS behind it (in PREVIEW_CSS, after the rest). The `.k-reduce` lines let the engine's own
 * reduced fallbacks (opacity, a ring — no movement) play under the root that stops every other
 * animation; `prefers-reduced-motion` turns the movements into those fallbacks.
 */
export const FEEDBACK_CSS = `
@keyframes kMFade { from { opacity: 0; } to { opacity: 1; } }
.k-mfade { animation: kMFade var(--m-fade-ms, 300ms) ease-out var(--m-fade-delay, 0ms) both; }
.k-mpress .k-tap { transition: scale var(--m-press-out, 300ms) var(--m-press-ease-out, ${EASE_ENTER}), background-color 200ms ease, color 200ms ease, border-color 200ms ease; }
.k-mpress .k-tap:not(:disabled):active { scale: var(--m-press-scale, 1); transition-duration: var(--m-press-in, 120ms), 200ms, 200ms, 200ms; transition-timing-function: var(--m-press-ease-in, ${EASE_ENTER}), ease, ease, ease; transition-delay: var(--m-press-delay, 0ms), 0ms, 0ms, 0ms; }
.k-mpress .k-tap::after { content: ''; position: absolute; inset: 0; border-radius: inherit; pointer-events: none; opacity: 0; background: var(--m-press-fill, transparent); box-shadow: inset 0 0 0 2px var(--m-press-ring, transparent); transition: opacity var(--m-press-out, 300ms) ease-out, transform 0s linear var(--m-press-out, 300ms); }
.k-mpress .k-tap.k-tap-solid::after { background: rgba(255, 255, 255, var(--m-press-solid, .24)); box-shadow: inset 0 0 0 2px rgba(255, 255, 255, var(--m-press-solid-ring, .5)); }
.k-mpress .k-tap:not(:disabled):active::after { opacity: 1; transition: opacity var(--m-press-in, 120ms) ease-out var(--m-press-delay, 0ms), transform var(--m-press-ms, 400ms) ${EASE_ENTER} var(--m-press-delay, 0ms); }
.k-mpress-ripple .k-tap::after { background: radial-gradient(circle at 50% 50%, var(--m-press-ring, transparent) 0%, var(--m-press-fill, transparent) 42%, transparent 72%); box-shadow: none; transform: scale(.3); }
.k-mpress-ripple .k-tap.k-tap-solid::after { background: radial-gradient(circle at 50% 50%, rgba(255, 255, 255, .5) 0%, rgba(255, 255, 255, .2) 42%, transparent 72%); box-shadow: none; }
.k-mpress-ripple .k-tap:not(:disabled):active::after { transform: none; }
.k-mpress-none .k-tap::after { content: none; }
.k-root.k-reduce.k-mpress .k-tap::after { transition: opacity var(--m-press-out, 300ms) ease-out !important; }
.k-root.k-reduce.k-mpress .k-tap:not(:disabled):active::after { transition: opacity var(--m-press-in, 120ms) ease-out !important; }
@keyframes kBadgeBounce { 0% { transform: scale(1); } 30% { transform: scale(var(--k-bounce, 1.2)); } 55% { transform: scale(calc(1 - (var(--k-bounce, 1.2) - 1) * .4)); } 78% { transform: scale(calc(1 + (var(--k-bounce, 1.2) - 1) * .3)); } 100% { transform: scale(1); } }
@keyframes kBadgePulse { 0%, 100% { transform: scale(1); } 50% { transform: scale(var(--k-bounce, 1.2)); } }
@keyframes kBadgeFlash { 0% { box-shadow: 0 0 0 0 transparent; } 25%, 60% { box-shadow: 0 0 0 2px #FFFFFF, 0 0 0 4px var(--m-badge-hl, #F59E0B); } 100% { box-shadow: 0 0 0 0 transparent; } }
.kiosk-bounce.k-badge-bounce { animation-name: kBadgeBounce; }
.kiosk-bounce.k-badge-pulse { animation-name: kBadgePulse; }
.k-badge-flash { animation: kBadgeFlash var(--k-bounce-ms, 450ms) ease-out var(--k-bounce-delay, 0ms) 1 none; }
.k-root.k-reduce .k-badge-flash { animation: kBadgeFlash var(--k-bounce-ms, 450ms) ease-out var(--k-bounce-delay, 0ms) 1 none !important; }
@keyframes kToastIn { from { opacity: 0; transform: var(--m-toast-from, none); } to { opacity: 1; transform: none; } }
@keyframes kToastOut { from { opacity: 1; } to { opacity: 0; } }
.k-toast { animation: kToastIn var(--m-toast-in, 300ms) var(--m-toast-ease, ${EASE_ENTER}) var(--m-toast-delay, 0ms) both, kToastOut var(--m-toast-out, 300ms) ${EASE_EXIT} var(--m-toast-out-at, 2300ms) forwards; }
.k-root.k-reduce .k-toast { animation: kToastIn var(--m-toast-in, 300ms) linear var(--m-toast-delay, 0ms) both, kToastOut var(--m-toast-out, 300ms) linear var(--m-toast-out-at, 2300ms) forwards !important; }
@keyframes kSxPop { from { opacity: 0; transform: scale(var(--m-sx-from, .6)); } to { opacity: 1; transform: none; } }
@keyframes kSxZoom { 0% { opacity: 0; transform: scale(var(--m-sx-from, .6)); } 60% { opacity: 1; transform: scale(1.1); } 100% { opacity: 1; transform: none; } }
@keyframes kSxDraw { from { stroke-dashoffset: 1; } to { stroke-dashoffset: 0; } }
@keyframes kSxNum { 0% { opacity: 0; transform: scale(var(--m-sx-from, .6)); } 70% { opacity: 1; transform: scale(1.04); } 100% { opacity: 1; transform: none; } }
@keyframes kConfetti { 0% { opacity: 0; transform: translate3d(0, 0, 0) rotate(0deg) scale(.6); } 15% { opacity: 1; } 100% { opacity: 0; transform: translate3d(calc(var(--dx) * var(--m-sx-k, 1)), calc(var(--dy) * var(--m-sx-k, 1)), 0) rotate(var(--rot)) scale(1); } }
.k-sx-draw { animation: kSxPop var(--m-sx-ms, 400ms) var(--m-sx-ease, ${EASE_POP_RISE}) var(--m-sx-delay, 0ms) both; }
.k-sx-zoom { animation: kSxZoom var(--m-sx-ms, 500ms) var(--m-sx-ease, ${EASE_POP_RISE}) var(--m-sx-delay, 0ms) both; }
.k-sx .k-sx-check { stroke-dasharray: 1; animation: kSxDraw var(--m-sx-draw-ms, 450ms) ease-out var(--m-sx-draw-delay, 0ms) both; }
.k-sx-num { animation: kSxNum var(--m-sx-num-ms, 550ms) var(--m-sx-ease, ${EASE_POP_RISE}) var(--m-sx-num-delay, 0ms) both; }
.k-confetti { position: absolute; left: 50%; top: 50%; width: 7px; height: 11px; margin: -5px 0 0 -3px; border-radius: 2px; pointer-events: none; opacity: 0; animation: kConfetti var(--m-sx-confetti-ms, 1200ms) cubic-bezier(.2,.6,.35,1) calc(var(--m-sx-confetti-delay, 0ms) + var(--cd, 0ms)) both; }
.k-root.k-reduce .k-mfade { animation: kMFade var(--m-fade-ms, 300ms) ease-out var(--m-fade-delay, 0ms) both !important; }
@keyframes kErrShake { 0%, 100% { transform: none; } 15% { transform: translate3d(calc(var(--m-err-x, 10px) * -1), calc(var(--m-err-y, 0px) * -1), 0); } 35% { transform: translate3d(var(--m-err-x, 10px), var(--m-err-y, 0px), 0); } 55% { transform: translate3d(calc(var(--m-err-x, 10px) * -.6), calc(var(--m-err-y, 0px) * -.6), 0); } 75% { transform: translate3d(calc(var(--m-err-x, 10px) * .3), calc(var(--m-err-y, 0px) * .3), 0); } }
@keyframes kErrWiggle { 0%, 100% { transform: none; } 20% { transform: rotate(calc(var(--m-err-deg, 2deg) * -1)); } 45% { transform: rotate(var(--m-err-deg, 2deg)); } 70% { transform: rotate(calc(var(--m-err-deg, 2deg) * -.5)); } }
@keyframes kErrFlash { 0% { outline-color: transparent; } 25%, 60% { outline-color: var(--m-err-c, ${ERROR_COLOR}); } }
.k-err { outline: 3px solid transparent; outline-offset: 2px; }
.k-err-on { outline: 2px solid var(--m-err-c, ${ERROR_COLOR}); outline-offset: 2px; }
.k-err-shake { animation: kErrShake var(--m-err-ms, 450ms) var(--m-err-ease, ${EASE_POP_SETTLE}) var(--m-err-delay, 0ms) var(--m-err-n, 1) none; }
.k-err-wiggle { animation: kErrWiggle var(--m-err-ms, 450ms) var(--m-err-ease, ${EASE_POP_SETTLE}) var(--m-err-delay, 0ms) var(--m-err-n, 1) none; }
.k-err-flash { animation: kErrFlash var(--m-err-ms, 450ms) ease-out var(--m-err-delay, 0ms) 1 none; }
.k-root.k-reduce .k-err-flash { animation: kErrFlash var(--m-err-ms, 450ms) ease-out var(--m-err-delay, 0ms) 1 none !important; }
@media (prefers-reduced-motion: reduce) {
  .k-mpress .k-tap:not(:disabled):active { scale: none; }
  .k-mpress-ripple .k-tap::after, .k-mpress-ripple .k-tap:not(:disabled):active::after { transform: none; }
  .k-meng .kiosk-bounce { animation: kBadgeFlash var(--k-bounce-ms, 450ms) ease-out var(--k-bounce-delay, 0ms) 1 none !important; }
  .k-toast { --m-toast-from: none !important; }
  .k-sx-draw, .k-sx-zoom, .k-sx-num { animation-name: kMFade !important; }
  .k-sx .k-sx-check { animation: none !important; }
  .k-confetti { display: none; }
  .k-err-shake, .k-err-wiggle { animation-name: kErrFlash !important; animation-iteration-count: 1 !important; }
}
`;
