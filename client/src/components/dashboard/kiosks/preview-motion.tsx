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
  STAGGER_MAX_CARDS,
  staggerDelayMs,
  swapSide,
  type CategorySwitchFx,
  type ScreenChangeFx,
  type SheetFx,
  type TransitionSpec,
} from '@/lib/kioskConfig';

export type SwapFx = CategorySwitchFx | ScreenChangeFx;

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
 * side in reading order. `fx` "none" (or `ms` 0) swaps at once.
 */
export function KioskSwap<K extends string>({
  id,
  fx,
  ms,
  order,
  render,
  rtl = true,
  className,
  slotClassName,
}: {
  id: K;
  fx: SwapFx;
  ms: number;
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
    const s = swapSide(order(id) >= order(cur), rtl);
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
            style={{ '--k-side': String(slotSide), '--k-ms': `${ms}ms` } as CSSProperties}
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
    style: { '--k-delay': `${staggerDelayMs(t, index)}ms`, '--k-item-ms': `${t.itemMs}ms` } as CSSProperties,
  };
}

/** A window's panel and its scrim, by "חלונות": their classes and timing. */
export function sheetEnter(t: TransitionSpec): { panel: string; scrim: string; style: CSSProperties } {
  const fx: SheetFx = t.sheetMs > 0 ? t.sheet : 'none';
  if (fx === 'none') return { panel: '', scrim: '', style: {} };
  return {
    panel: `k-anim k-sheet-${fx}`,
    scrim: 'k-anim k-fade-in',
    style: { '--k-ms': `${t.sheetMs}ms` } as CSSProperties,
  };
}

/**
 * The CSS behind it (in PREVIEW_CSS). `--k-side`: +1 the new content comes from the physical
 * right, -1 from the left. Enter animations fill backwards only: once done nothing stays on the
 * element (no layer, no transform under the press feedback). The leaving slot sits under the
 * incoming one (`isolation` keeps its z-index inside the swap).
 */
export const MOTION_CSS = `
.k-anim { animation-duration: var(--k-ms, 450ms); animation-timing-function: cubic-bezier(.05,.7,.1,1); animation-fill-mode: backwards; }
.k-swap { isolation: isolate; }
.k-leave { position: absolute; top: 0; left: 0; right: 0; pointer-events: none; z-index: -1; }
.k-leave.k-anim { animation-fill-mode: forwards; animation-timing-function: cubic-bezier(.3,0,.8,.15); }
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
.k-slide-in { animation-name: kSlideIn; } .k-slide-out { animation-name: kSlideOut; }
.k-push-in { animation-name: kPushIn; } .k-push-out { animation-name: kPushOut; }
.k-fade-in { animation-name: kFadeIn; } .k-fade-out { animation-name: kFadeOut; }
.k-fade_scale-in { animation-name: kFadeScaleIn; } .k-fade_scale-out { animation-name: kFadeScaleOut; }
.k-zoom-in { animation-name: kZoomIn; } .k-zoom-out { animation-name: kZoomOut; }
@keyframes kItemPop { 0% { opacity: 0; transform: scale(.85); animation-timing-function: cubic-bezier(.22,1,.36,1); } 60% { opacity: 1; transform: scale(1.03); animation-timing-function: cubic-bezier(.45,0,.55,1); } 100% { opacity: 1; transform: none; } }
@keyframes kItemRise { from { opacity: 0; transform: translate3d(0, 24px, 0); } to { opacity: 1; transform: none; } }
@keyframes kItemFlip { from { opacity: 0; transform: perspective(700px) rotateX(-75deg); } to { opacity: 1; transform: none; } }
.k-item { animation-duration: var(--k-item-ms, 380ms); animation-delay: var(--k-delay, 0ms); animation-fill-mode: backwards; }
.k-item-pop, .k-item-cascade { animation-name: kItemPop; }
.k-item-rise { animation-name: kItemRise; animation-timing-function: cubic-bezier(.05,.7,.1,1); }
.k-item-flip { animation-name: kItemFlip; animation-timing-function: cubic-bezier(.05,.7,.1,1); transform-origin: 50% 0; }
@keyframes kSheetUp { from { opacity: 0; transform: translate3d(0, 45%, 0); } to { opacity: 1; transform: none; } }
@keyframes kSheetScale { from { opacity: 0; transform: scale(.94); } to { opacity: 1; transform: none; } }
.k-sheet-slide_up { animation-name: kSheetUp; }
.k-sheet-scale { animation-name: kSheetScale; }
.k-sheet-fade { animation-name: kFadeIn; }
@keyframes kBarBounceA { 0% { transform: scale(1); } 35% { transform: scale(1.05); } 70% { transform: scale(.985); } 100% { transform: scale(1); } }
@keyframes kBarBounceB { 0% { transform: scale(1); } 35% { transform: scale(1.05); } 70% { transform: scale(.985); } 100% { transform: scale(1); } }
.kiosk-bar-bounce-a { animation: kBarBounceA 480ms cubic-bezier(.22,1,.36,1); }
.kiosk-bar-bounce-b { animation: kBarBounceB 480ms cubic-bezier(.22,1,.36,1); }
.k-reduce .k-leave { display: none; }
@media (prefers-reduced-motion: reduce) {
  .k-anim, .k-item, .kiosk-bar-bounce-a, .kiosk-bar-bounce-b { animation: none !important; }
  .k-leave { display: none; }
}
`;
