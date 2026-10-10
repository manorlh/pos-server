'use client';

/**
 * "הנפשות ומעברים" on the web kiosk screens (the dashboard's live preview and the Windows kiosk):
 * the same choices the till plays (lib/kioskConfig.ts transitionSpec, the till's KioskTransitions).
 *
 * Only CSS animations of `transform` and `opacity` — the compositor's, never a layout per frame —
 * and nothing ever waits for them: the incoming screen or category takes taps at once, the
 * leaving one takes none (`.k-leave`) and is frozen (it never renders again while it leaves).
 * `general.reduceMotion` (transitionSpec gives "none"), the `.k-reduce` root and the device's
 * `prefers-reduced-motion` all turn them off.
 *
 * Shared through `@/kiosk-shared`: only React, `lib/utils` and `lib/kioskConfig`.
 */

import { memo, useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { cn } from '@/lib/utils';
import {
  EASE_ENTER,
  EASE_EXIT,
  EASE_POP_RISE,
  EASE_POP_SETTLE,
  EASE_STRIP,
  STAGGER_MAX_CARDS,
  engineEase,
  staggerDelayMs,
  swapSide,
  type CategorySwitchFx,
  type ScreenChangeFx,
  type SheetFx,
  type TransitionSpec,
} from '@/lib/kioskConfig';
import { motionActive, type ResolvedMotion, type ResolvedMotionEngine } from '@/lib/kioskMotionEngine';

/** The swaps' effects: the configured ones, and the basket's own — rising from below ("rise") or dropping from above ("drop"). */
export type SwapFx = CategorySwitchFx | ScreenChangeFx | 'rise' | 'drop';

/** How a screen change plays (KioskSwap's fx / ms, the event's own curve, a forced side). */
export interface ScreenSwapSpec {
  fx: SwapFx;
  ms: number;
  ease?: string;
  side?: 1 | -1;
}

/**
 * "מנוע הנפשות": the screen change towards `target` — back to the attract screen by the engine's
 * homeReturn (a fade back home, never a sharp reset), into the basket by its cartOpen (rising from
 * below / dropping / from a side, with a fade), anything else by pageTransition (TransitionSpec).
 * No engine: the transition spec's, exactly as before.
 */
export function screenSwap(t: TransitionSpec, engine: ResolvedMotionEngine | undefined, target: string): ScreenSwapSpec {
  const base: ScreenSwapSpec = { fx: t.screenChange, ms: t.screenMs, ...(t.screenEase ? { ease: t.screenEase } : {}) };
  const ev = !engine ? null : target === 'attract' ? engine.homeReturn : target === 'cart' ? engine.cartOpen : null;
  if (!ev) return base;
  if (!motionActive(ev)) return { fx: 'none', ms: 0 };
  const ease = engineEase(ev);
  const out = (fx: SwapFx, side?: 1 | -1): ScreenSwapSpec => ({ fx, ms: ev.durationMs, ...(ease ? { ease } : {}), ...(side ? { side } : {}) });
  switch (ev.animationType) {
    case 'fadeScale':
      return out(ev.scaleFrom <= 0.93 ? 'zoom' : 'fade_scale');
    case 'swipeTransition':
      return out('push', sideOf(ev));
    case 'slideIn':
      // The basket by its direction: up — rises from below; down — drops from above; a side — from it.
      if (ev.event === 'cartOpen' && (ev.direction === 'up' || ev.direction === 'down')) return out(ev.direction === 'up' ? 'rise' : 'drop');
      return out('slide', sideOf(ev));
    default:
      // crossfade, fadeIn, a reduced fallback: a fade.
      return out('fade');
  }
}

/** A forced side for an explicit left / right: moving left, the new content comes from the physical right (+1). */
function sideOf(ev: Pick<ResolvedMotion, 'direction'>): 1 | -1 | undefined {
  return ev.direction === 'left' ? 1 : ev.direction === 'right' ? -1 : undefined;
}

/** The kiosk's screens in the order of an order: a later one comes the way the customer reads. */
const SCREEN_ORDER = ['attract', 'service', 'catalog', 'product', 'confirm', 'cart', 'tip', 'details', 'pay', 'success'];

/** A screen's place in the order (the rest — paused, closed, setup — after it). */
export function screenOrder(screen: string): number {
  const i = SCREEN_ORDER.indexOf(screen);
  return i >= 0 ? i : SCREEN_ORDER.length;
}

/**
 * A slot that renders once more only while it is the current one: the leaving screen keeps what
 * it last drew (no flash of another state, no work while it slides away).
 */
const Frozen = memo(
  function Frozen({ node }: { node: ReactNode; frozen: boolean }) {
    return <>{node}</>;
  },
  (_prev, next) => next.frozen,
);

interface Leaving<K> {
  key: K;
  side: 1 | -1;
  n: number;
}

/**
 * The current `id`'s content, and while a change plays the previous one leaving over it.
 * `order` gives a key's place (the rail's order, the screens'): a later one comes from the end
 * side in reading order (`side` forces one: an event's explicit direction). `fx` "none" (or `ms`
 * 0) swaps at once. `ease`: the event's own curve ("מנוע הנפשות"), else each kind's own.
 */
export function KioskSwap<K extends string>({
  id,
  fx,
  ms,
  ease,
  side: forcedSide,
  order,
  render,
  rtl = true,
  className,
  slotClassName,
}: {
  id: K;
  fx: SwapFx;
  ms: number;
  ease?: string;
  side?: 1 | -1;
  order: (k: K) => number;
  render: (k: K) => ReactNode;
  rtl?: boolean;
  className?: string;
  slotClassName?: string;
}) {
  const [cur, setCur] = useState<K>(id);
  const [side, setSide] = useState<1 | -1>(1);
  const [n, setN] = useState(0);
  const [leaving, setLeaving] = useState<Leaving<K> | null>(null);
  const animated = fx !== 'none' && ms > 0;
  if (id !== cur) {
    // A new key: the slot swaps in this very render (no frame of the old one as current).
    const s = forcedSide ?? swapSide(order(id) >= order(cur), rtl);
    setCur(id);
    setSide(s);
    setN(n + 1);
    setLeaving(animated ? { key: cur, side: s, n: n + 1 } : null);
  }
  useEffect(() => {
    if (!leaving) return;
    const timer = window.setTimeout(() => setLeaving((l) => (l && l.n === leaving.n ? null : l)), ms + 40);
    return () => window.clearTimeout(timer);
  }, [leaving, ms]);
  const slots: K[] = leaving && leaving.key !== cur ? [leaving.key, cur] : [cur];
  return (
    <div className={cn('k-swap relative', className)}>
      {slots.map((k) => {
        const out = k !== cur;
        const slotSide = out && leaving ? leaving.side : side;
        return (
          <div
            key={k}
            aria-hidden={out || undefined}
            className={cn(slotClassName, out && 'k-leave', animated && n > 0 && `k-anim k-${fx}-${out ? 'out' : 'in'}`)}
            style={{ '--k-side': String(slotSide), '--k-ms': `${ms}ms`, ...(ease ? { '--k-ease': ease } : {}) } as CSSProperties}
          >
            <Frozen node={out ? null : render(k)} frozen={out} />
          </div>
        );
      })}
    </div>
  );
}

/** A card's entrance: its class and timing (`index` in reading order), or nothing. */
export function itemEnter(t: TransitionSpec, index: number, enabled = true): { className?: string; style?: CSSProperties } {
  // Only about two screenfuls get an animation at all; the rest are drawn as they are.
  if (!enabled || t.itemsEnter === 'none' || t.itemMs <= 0 || index >= STAGGER_MAX_CARDS * 2) return {};
  return {
    className: `k-item k-item-${t.itemsEnter}`,
    style: { '--k-delay': `${staggerDelayMs(t, index)}ms`, '--k-item-ms': `${t.itemMs}ms`, ...(t.itemEase ? { '--k-ease': t.itemEase } : {}) } as CSSProperties,
  };
}

/** A window's panel and its scrim, by "חלונות": their classes and timing (and the event's own curve). */
export function sheetEnter(t: TransitionSpec): { panel: string; scrim: string; style: CSSProperties } {
  const fx: SheetFx = t.sheetMs > 0 ? t.sheet : 'none';
  if (fx === 'none') return { panel: '', scrim: '', style: {} };
  return {
    panel: `k-anim k-sheet-${fx}`,
    scrim: 'k-anim k-fade-in',
    style: { '--k-ms': `${t.sheetMs}ms`, ...(t.sheetEase ? { '--k-ease': t.sheetEase } : {}) } as CSSProperties,
  };
}

/**
 * The CSS behind it (in PREVIEW_CSS). `--k-side`: +1 the new content comes from the physical
 * right, -1 from the left. Enter animations fill backwards only: once done nothing stays on the
 * element (no layer, no transform under the press feedback). The leaving slot sits under the
 * incoming one (`isolation` keeps its z-index inside the swap). The curves are the till's
 * KioskEase (lib/kioskConfig.ts EASE_*): arrivals decelerate, departures accelerate, a push moves
 * both screens on one curve as a strip; the durations come from transitionSpec (`--k-ms`).
 * "מנוע הנפשות": an event's own curve (`--k-ease`, set on the animated element itself) replaces
 * them; `--k-ease` never inherits, so a screen's curve never leaks into the category or window in it.
 * The basket rises from below (`rise`) or drops from above (`drop`) over the menu fading back.
 */
export const MOTION_CSS = `
@property --k-ease { syntax: '*'; inherits: false; }
.k-anim { animation-duration: var(--k-ms, 220ms); animation-timing-function: var(--k-ease, ${EASE_ENTER}); animation-fill-mode: backwards; }
.k-swap { isolation: isolate; }
.k-leave { position: absolute; top: 0; left: 0; right: 0; pointer-events: none; z-index: -1; }
.k-leave.k-anim { animation-fill-mode: forwards; animation-timing-function: var(--k-ease, ${EASE_EXIT}); }
@keyframes kSlideIn { from { opacity: 0; transform: translate3d(calc(var(--k-side) * 22%), 0, 0); } to { opacity: 1; transform: none; } }
@keyframes kSlideOut { from { opacity: 1; transform: none; } to { opacity: 0; transform: translate3d(calc(var(--k-side) * -10%), 0, 0); } }
@keyframes kPushIn { from { transform: translate3d(calc(var(--k-side) * 100%), 0, 0); } to { transform: none; } }
@keyframes kPushOut { from { transform: none; } to { transform: translate3d(calc(var(--k-side) * -100%), 0, 0); } }
@keyframes kFadeIn { from { opacity: 0; } to { opacity: 1; } }
@keyframes kFadeOut { from { opacity: 1; } to { opacity: 0; } }
@keyframes kFadeScaleIn { from { opacity: 0; transform: scale(.96); } to { opacity: 1; transform: none; } }
@keyframes kFadeScaleOut { from { opacity: 1; transform: none; } to { opacity: 0; transform: scale(1.02); } }
@keyframes kZoomIn { from { opacity: 0; transform: scale(.92); } to { opacity: 1; transform: none; } }
@keyframes kZoomOut { from { opacity: 1; transform: none; } to { opacity: 0; transform: scale(1.06); } }
@keyframes kRiseIn { from { opacity: 0; transform: translate3d(0, 22%, 0); } to { opacity: 1; transform: none; } }
@keyframes kDropIn { from { opacity: 0; transform: translate3d(0, -22%, 0); } to { opacity: 1; transform: none; } }
@keyframes kRecedeOut { from { opacity: 1; transform: none; } to { opacity: 0; transform: scale(.98); } }
.k-slide-in { animation-name: kSlideIn; } .k-slide-out { animation-name: kSlideOut; }
.k-push-in { animation-name: kPushIn; } .k-push-out { animation-name: kPushOut; }
.k-anim.k-push-in, .k-leave.k-anim.k-push-out { animation-timing-function: var(--k-ease, ${EASE_STRIP}); }
.k-fade-in { animation-name: kFadeIn; } .k-fade-out { animation-name: kFadeOut; }
.k-fade_scale-in { animation-name: kFadeScaleIn; } .k-fade_scale-out { animation-name: kFadeScaleOut; }
.k-zoom-in { animation-name: kZoomIn; } .k-zoom-out { animation-name: kZoomOut; }
.k-rise-in { animation-name: kRiseIn; } .k-drop-in { animation-name: kDropIn; } .k-rise-out, .k-drop-out { animation-name: kRecedeOut; }
@keyframes kItemPop { 0% { opacity: 0; transform: scale(.85); animation-timing-function: ${EASE_POP_RISE}; } 60% { opacity: 1; transform: scale(1.03); animation-timing-function: ${EASE_POP_SETTLE}; } 100% { opacity: 1; transform: none; } }
@keyframes kItemRise { from { opacity: 0; transform: translate3d(0, 24px, 0); } to { opacity: 1; transform: none; } }
@keyframes kItemFlip { from { opacity: 0; transform: perspective(700px) rotateX(-75deg); } to { opacity: 1; transform: none; } }
.k-item { animation-duration: var(--k-item-ms, 260ms); animation-delay: var(--k-delay, 0ms); animation-fill-mode: backwards; }
.k-item-pop, .k-item-cascade { animation-name: kItemPop; }
.k-item-rise { animation-name: kItemRise; animation-timing-function: var(--k-ease, ${EASE_ENTER}); }
.k-item-flip { animation-name: kItemFlip; animation-timing-function: var(--k-ease, ${EASE_ENTER}); transform-origin: 50% 0; }
@keyframes kSheetUp { from { opacity: 0; transform: translate3d(0, 45%, 0); } to { opacity: 1; transform: none; } }
@keyframes kSheetScale { from { opacity: 0; transform: scale(.94); } to { opacity: 1; transform: none; } }
.k-sheet-slide_up { animation-name: kSheetUp; }
.k-sheet-scale { animation-name: kSheetScale; }
.k-sheet-fade { animation-name: kFadeIn; }
@keyframes kBarBounceA { 0% { transform: scale(1); } 35% { transform: scale(1.05); } 70% { transform: scale(.985); } 100% { transform: scale(1); } }
@keyframes kBarBounceB { 0% { transform: scale(1); } 35% { transform: scale(1.05); } 70% { transform: scale(.985); } 100% { transform: scale(1); } }
.kiosk-bar-bounce-a { animation: kBarBounceA 480ms ${EASE_POP_RISE}; }
.kiosk-bar-bounce-b { animation: kBarBounceB 480ms ${EASE_POP_RISE}; }
.k-reduce .k-leave { display: none; }
@media (prefers-reduced-motion: reduce) {
  .k-anim, .k-item, .kiosk-bar-bounce-a, .kiosk-bar-bounce-b { animation: none !important; }
  .k-leave { display: none; }
}
`;
