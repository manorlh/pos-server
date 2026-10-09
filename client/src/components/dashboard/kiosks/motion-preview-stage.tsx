'use client';

/**
 * "הצג" of an event in "הנפשות" (spec §10): a small sample stage — a product card, the basket, a
 * button, a price, a screen, depending on the event — that plays the event as the kiosk resolves it
 * (lib/kioskMotionPreview.ts plans the tracks; the Web Animations API plays them). No order is made.
 * The stage draws an element per role of its scene (`data-role`); "before / after" puts two stages
 * side by side and plays them together.
 */

import { useEffect, useImperativeHandle, useRef, useState, type ReactNode, type RefObject } from 'react';
import { Check, ChevronsDown, CreditCard, Lock, Minus, Plus, ShoppingBag, ShoppingCart, Trash2, Undo2, Utensils } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ResolvedMotion } from '@/lib/kioskMotionEngine';
import {
  CONFETTI_PIECES,
  MOTION_SCENES,
  PREVIEW_ROW_GAP,
  PREVIEW_ROW_H,
  counterText,
  planMotionPreview,
  type MotionPlan,
  type MotionScene,
  type MotionStageGeometry,
} from '@/lib/kioskMotionPreview';
import { useMotionText } from './motion-labels';

export interface MotionStageHandle {
  play: () => void;
}

interface PlayHooks {
  onSwap: () => void;
  onCount: (role: string, text: string) => void;
  onDone: () => void;
}

/** The fly from the dish's picture to the basket, measured before playing. */
function measure(root: HTMLElement): MotionStageGeometry | undefined {
  const ghost = root.querySelector<HTMLElement>('[data-role="ghost"]');
  const cart = root.querySelector<HTMLElement>('[data-role="cart"]');
  if (!ghost || !cart) return undefined;
  const a = ghost.getBoundingClientRect();
  const b = cart.getBoundingClientRect();
  return { flyDx: b.left + b.width / 2 - (a.left + a.width / 2), flyDy: b.top + b.height / 2 - (a.top + a.height / 2) };
}

/** Plays a plan on the stage's elements; returns its stop. */
function playPlan(root: HTMLElement, plan: MotionPlan, hooks: PlayHooks): () => void {
  const anims: Animation[] = [];
  const timers: number[] = [];
  let raf = 0;
  let stopped = false;
  const canAnimate = typeof root.animate === 'function';
  if (canAnimate) {
    for (const track of plan.tracks) {
      for (const el of Array.from(root.querySelectorAll<HTMLElement>(`[data-role="${track.role}"]`))) {
        anims.push(el.animate(track.frames as Keyframe[], { duration: track.duration, delay: track.delay, easing: track.easing, fill: track.fill }));
      }
    }
  }
  // A counter follows its own (empty) animation's eased progress; of a role's repeats, the latest started.
  const counters = canAnimate
    ? plan.counters.map((c) => ({ c, a: root.animate(null, { duration: c.duration, delay: c.delay, easing: c.easing, fill: 'both' }) }))
    : [];
  anims.push(...counters.map((x) => x.a));
  if (counters.length > 0) {
    const tick = () => {
      if (stopped) return;
      const byRole = new Map<string, (typeof counters)[number]>();
      for (const x of counters) {
        const t = Number(x.a.currentTime ?? 0);
        if (!byRole.has(x.c.role) || t >= x.c.delay) byRole.set(x.c.role, x);
      }
      for (const [role, x] of byRole) hooks.onCount(role, counterText(x.c, x.a.effect?.getComputedTiming().progress ?? 0));
      if (counters.some((x) => x.a.playState !== 'finished')) raf = window.requestAnimationFrame(tick);
    };
    raf = window.requestAnimationFrame(tick);
  }
  const stop = () => {
    stopped = true;
    timers.forEach((id) => window.clearTimeout(id));
    window.cancelAnimationFrame(raf);
    anims.forEach((a) => a.cancel());
  };
  timers.push(window.setTimeout(hooks.onSwap, plan.swapAtMs));
  timers.push(
    window.setTimeout(() => {
      stop();
      hooks.onDone();
      // Back to rest softly.
      if (canAnimate) root.animate([{ opacity: 0.35 }, { opacity: 1 }], { duration: 220, easing: 'ease-out' });
    }, plan.endMs + plan.holdMs),
  );
  return stop;
}

/* ---------------------------------------------------------------- scenes */

const FOOD = 'bg-gradient-to-br from-amber-300 via-orange-400 to-rose-500';
const GRID_TONES = ['from-amber-300 to-orange-500', 'from-lime-300 to-emerald-500', 'from-rose-300 to-pink-500'];
const COOL_TONES = ['from-sky-300 to-blue-500', 'from-cyan-300 to-teal-500', 'from-violet-300 to-indigo-500'];
const CONFETTI_COLORS = ['#f59e0b', '#10b981', '#3b82f6', '#ef4444', '#a855f7', '#ec4899'];

function MiniTiles({ tones = GRID_TONES, count = 3, className }: { tones?: string[]; count?: number; className?: string }) {
  return (
    <div className={cn('grid grid-cols-3 gap-1.5', className)}>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="rounded-md border bg-background p-1 shadow-xs">
          <div className={cn('h-7 rounded bg-gradient-to-br', tones[i % tones.length])} />
          <div className="mt-1 h-1 w-3/4 rounded bg-muted-foreground/25" />
        </div>
      ))}
    </div>
  );
}

function Ripple() {
  return <span data-role="ripple" className="pointer-events-none absolute inset-0 m-auto h-24 w-24 rounded-full bg-primary/40 opacity-0" />;
}

interface SceneProps {
  event: ResolvedMotion['event'];
  scene: MotionScene;
  after: boolean;
  counts: Record<string, string>;
}

function Scene({ event, scene, after, counts }: SceneProps) {
  const { t } = useMotionText();
  const s = (key: string) => t(`stage.${key}`);
  switch (scene) {
    case 'card':
      return (
        <div className="flex h-full items-center justify-center">
          <div className="relative">
            <div data-role="target" className="relative w-24 overflow-hidden rounded-xl border bg-background p-1.5 shadow-sm">
              <div className={cn('h-12 rounded-lg', FOOD)} />
              <div className="mt-1 text-[10px] font-medium">{s('dish')}</div>
              <div className="text-[10px] text-muted-foreground" dir="ltr">
                {s('price')}
              </div>
              <Ripple />
            </div>
            {event === 'soldOut' ? (
              <span data-role="soldBadge" className="absolute inset-x-0 top-5 mx-auto w-fit rounded-full bg-foreground/85 px-2 py-0.5 text-[10px] font-semibold text-background opacity-0">
                {s('soldOut')}
              </span>
            ) : null}
          </div>
        </div>
      );

    case 'addCart':
      return (
        <div className="flex h-full items-center justify-between px-8">
          <div data-role="target" className="relative w-24 rounded-xl border bg-background p-1.5 shadow-sm">
            <div className="relative h-12">
              <div className={cn('h-12 rounded-lg', FOOD)} />
              <div data-role="ghost" className={cn('pointer-events-none absolute inset-0 z-10 rounded-lg opacity-0 shadow-lg', FOOD)} />
            </div>
            <div className="mt-1 text-[10px] font-medium">{s('dish')}</div>
            <div className="text-[10px] text-muted-foreground" dir="ltr">
              {s('price')}
            </div>
            <span data-role="added" className="absolute -top-2 start-1 rounded-full bg-emerald-500 px-1.5 py-0.5 text-[9px] font-semibold text-white opacity-0 shadow">
              {s('added')}
            </span>
          </div>
          <div data-role="cart" className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-md">
            <ShoppingCart className="h-5 w-5" />
            <span data-role="badge" className="absolute -top-1.5 -end-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[9px] font-bold text-white">
              {after ? 3 : 2}
            </span>
          </div>
        </div>
      );

    case 'badge':
      return (
        <div className="flex h-full items-center justify-center">
          <div data-role="cart" className="relative flex h-11 items-center gap-2 rounded-2xl bg-primary px-4 text-primary-foreground shadow-md">
            <ShoppingCart className="h-5 w-5" />
            <span className="text-xs font-medium">{s('cart')}</span>
            <span data-role="target" className="absolute -top-2 -end-2 flex h-6 min-w-6 items-center justify-center rounded-full bg-rose-500 px-1.5 text-xs font-bold text-white shadow">
              {after ? 3 : 2}
            </span>
          </div>
        </div>
      );

    case 'toast':
      return (
        <div className="relative h-full p-3">
          <MiniTiles count={6} className="opacity-50" />
          <div className="absolute inset-x-0 bottom-3 flex justify-center">
            <div data-role="target" className="flex items-center gap-1.5 rounded-full bg-foreground px-3 py-1.5 text-xs font-medium text-background shadow-lg">
              <Check className="h-3.5 w-3.5 text-emerald-400" /> {s('toast')}
            </div>
          </div>
        </div>
      );

    case 'sheet': {
      const modal = event === 'modalOpen';
      const title = event === 'upsell' ? s('upsellTitle') : event === 'cartOpen' ? s('cartTitle') : s('sheetTitle');
      return (
        <div className="relative h-full">
          <div data-role="base" className="absolute inset-0 p-3">
            <MiniTiles count={6} />
            <div data-role="source" className="absolute bottom-3 end-3 h-9 w-12 rounded-md border-2 border-primary/60" />
          </div>
          <div data-role="backdrop" className="absolute inset-0 bg-black/30" />
          <div
            data-role="target"
            className={cn(
              'absolute flex flex-col gap-1.5 bg-background p-2.5 shadow-2xl',
              modal ? 'inset-x-0 inset-y-3 mx-auto w-60 max-w-[85%] rounded-2xl' : 'inset-x-0 top-7 bottom-0 mx-auto w-80 max-w-[94%] rounded-t-2xl',
            )}
          >
            <div className="mx-auto h-1 w-8 rounded-full bg-muted-foreground/30" />
            <span className="text-[11px] font-semibold">{title}</span>
            {event === 'cartOpen' ? (
              <div className="space-y-1">
                {['line1', 'line2'].map((k) => (
                  <div key={k} className="flex items-center justify-between rounded-md bg-muted/60 px-2 py-1 text-[10px]">
                    <span>{s(k)}</span>
                    <span dir="ltr">₪19.90</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="flex flex-wrap gap-1">
                {['option1', 'option2', 'option3'].map((k, i) => (
                  <span key={k} className={cn('rounded-full border px-2 py-0.5 text-[10px]', i === 0 && 'border-primary bg-primary/10')}>
                    {s(k)}
                  </span>
                ))}
              </div>
            )}
            <div className="mt-auto h-5 rounded-md bg-primary" />
          </div>
        </div>
      );
    }

    case 'dialog':
      return (
        <div className="relative h-full p-3">
          <MiniTiles count={6} />
          <div data-role="backdrop" className="absolute inset-0 bg-black/35" />
          <div className="absolute inset-0 flex items-center justify-center">
            <div data-role="target" className="flex w-36 flex-col items-center gap-1.5 rounded-2xl bg-background p-3 shadow-xl">
              <div className="relative h-11 w-11">
                <svg viewBox="0 0 44 44" className="h-11 w-11 -rotate-90" aria-hidden>
                  <circle cx="22" cy="22" r="19" fill="none" strokeWidth="3" className="stroke-muted" />
                  <circle data-role="ring" cx="22" cy="22" r="19" fill="none" strokeWidth="3" strokeLinecap="round" pathLength={1} strokeDasharray="1" strokeDashoffset={0} className="stroke-primary" />
                </svg>
                <span data-role="number" className="absolute inset-0 flex items-center justify-center text-sm font-bold tabular-nums">
                  {counts.number ?? '5'}
                </span>
              </div>
              <span className="text-xs font-semibold">{s('stillHere')}</span>
            </div>
          </div>
        </div>
      );

    case 'options':
      return (
        <div className="flex h-full flex-col justify-center gap-1.5 px-10">
          {['option1', 'option2', 'option3'].map((k, i) => {
            const chosen = i === 1;
            const on = chosen && after;
            return (
              <div
                key={k}
                data-role={chosen ? 'target' : undefined}
                className={cn(
                  'relative flex items-center justify-between overflow-hidden rounded-lg border bg-background px-2.5 py-1.5 text-xs transition-colors',
                  on && 'border-primary bg-primary/5',
                )}
              >
                <span>{s(k)}</span>
                <span className={cn('flex h-4 w-4 items-center justify-center rounded-full border', on && 'border-primary bg-primary text-primary-foreground')}>
                  {on ? <Check className="h-3 w-3" /> : null}
                </span>
                {chosen ? <Ripple /> : null}
              </div>
            );
          })}
        </div>
      );

    case 'choice':
      return (
        <div className="relative flex h-full items-center justify-center gap-3">
          <div
            data-role="target"
            className={cn(
              'relative flex h-20 w-24 flex-col items-center justify-center gap-1 overflow-hidden rounded-2xl border bg-background text-xs font-semibold shadow-sm',
              after && 'border-primary',
            )}
          >
            <Utensils className="h-5 w-5 text-primary" />
            {s('eatIn')}
            <Ripple />
          </div>
          <div data-role="other" className="flex h-20 w-24 flex-col items-center justify-center gap-1 rounded-2xl border bg-background text-xs font-semibold shadow-sm">
            <ShoppingBag className="h-5 w-5 text-primary" />
            {s('takeAway')}
          </div>
          <div data-role="advance" className="absolute inset-0 flex items-center justify-center bg-primary text-sm font-semibold text-primary-foreground opacity-0">
            {s('toMenu')}
          </div>
        </div>
      );

    case 'stepper':
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2">
          <span className="text-[11px] text-muted-foreground">{s('qty')}</span>
          <div className="flex items-center gap-3 rounded-full border bg-background px-2 py-1.5 shadow-sm">
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-muted">
              <Minus className="h-3.5 w-3.5" />
            </span>
            <span data-role="target" className="inline-block min-w-8 rounded-md px-1.5 text-center text-lg font-bold tabular-nums">
              <span data-role="number">{counts.number ?? (after ? '3' : '2')}</span>
            </span>
            <span className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground">
              <Plus className="h-3.5 w-3.5" />
            </span>
          </div>
        </div>
      );

    case 'price':
      return (
        <div className="flex h-full items-center justify-center">
          <div className="w-48 space-y-1 rounded-xl border bg-background p-2.5 text-xs shadow-sm">
            <div className="flex justify-between text-muted-foreground">
              <span>{s('dish')}</span>
              <span dir="ltr">₪42.90</span>
            </div>
            <div className={cn('flex justify-between text-muted-foreground transition-opacity', !after && 'opacity-0')}>
              <span>+ {s('option1')}</span>
              <span dir="ltr">₪4.00</span>
            </div>
            <div className="flex items-center justify-between border-t pt-1.5 font-semibold">
              <span>{s('total')}</span>
              <span data-role="target" dir="ltr" className="inline-block rounded-md px-1.5 py-0.5 tabular-nums">
                ₪<span data-role="number">{counts.number ?? (after ? '46.90' : '42.90')}</span>
              </span>
            </div>
          </div>
        </div>
      );

    case 'grid':
      return (
        <div className="flex h-full flex-col gap-2 p-3">
          <div className="flex gap-1.5">
            {['mains', 'drinks'].map((k, i) => (
              <span key={k} className={cn('rounded-full px-2 py-0.5 text-[10px]', i === 1 ? 'bg-primary text-primary-foreground' : 'bg-muted')}>
                {s(k)}
              </span>
            ))}
          </div>
          <div className="grid flex-1 grid-cols-3 gap-2">
            {[0, 1, 2].map((i) => (
              <div key={i} data-role={`card-${i}`} className="rounded-lg border bg-background p-1 shadow-sm">
                <div className={cn('h-12 rounded-md bg-gradient-to-br', COOL_TONES[i])} />
                <div className="mt-1 h-1.5 w-3/4 rounded bg-muted-foreground/25" />
                <div className="mt-1 h-1.5 w-1/3 rounded bg-muted-foreground/20" />
              </div>
            ))}
          </div>
        </div>
      );

    case 'screen': {
      const header = (title: string) => (
        <div className="mb-2 flex items-center justify-between">
          <span className="text-[11px] font-semibold">{title}</span>
          <span className="h-2 w-8 rounded-full bg-muted-foreground/20" />
        </div>
      );
      const menu = (title: string, tones: string[]) => (
        <div className="h-full p-3">
          {header(title)}
          <MiniTiles tones={tones} count={6} />
        </div>
      );
      let a: ReactNode;
      let b: ReactNode;
      if (event === 'categorySwitch') {
        a = menu(s('mains'), GRID_TONES);
        b = menu(s('drinks'), COOL_TONES);
      } else if (event === 'homeReturn') {
        a = (
          <div className="flex h-full flex-col items-center justify-center gap-1.5">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-emerald-500 text-white">
              <Check className="h-5 w-5" />
            </span>
            <span className="text-xs font-semibold">{s('thanks')}</span>
            <span className="text-[10px] text-muted-foreground">{s('order')}</span>
          </div>
        );
        b = (
          <div className="flex h-full flex-col items-center justify-center gap-2 bg-gradient-to-br from-primary/15 via-background to-background">
            <span className="text-xs font-semibold">{s('home')}</span>
            <span className="rounded-full bg-primary px-3 py-1 text-[10px] font-semibold text-primary-foreground">{s('touch')}</span>
          </div>
        );
      } else {
        a = menu(s('menu'), GRID_TONES);
        b = (
          <div className="flex h-full flex-col p-3">
            {header(s('cartTitle'))}
            <div className="space-y-1">
              {['line1', 'line2', 'line3'].map((k) => (
                <div key={k} className="flex items-center justify-between rounded-md bg-muted/60 px-2 py-1 text-[10px]">
                  <span>{s(k)}</span>
                  <span dir="ltr">₪14.90</span>
                </div>
              ))}
            </div>
            <div className="mt-auto flex h-6 items-center justify-center rounded-md bg-primary text-[10px] font-semibold text-primary-foreground">{s('pay')}</div>
          </div>
        );
      }
      return (
        <div className="relative h-full">
          <div data-role="screenA" className="absolute inset-0 bg-muted/40">
            {a}
          </div>
          <div data-role="screenB" className="absolute inset-0 bg-background">
            {b}
          </div>
        </div>
      );
    }

    case 'list':
      return (
        <div className="flex h-full flex-col justify-center px-10">
          {['line1', 'line2', 'line3'].map((k, i) => (
            <div
              key={k}
              data-role={i === 1 ? 'target' : undefined}
              style={{ height: PREVIEW_ROW_H, marginBottom: PREVIEW_ROW_GAP }}
              className="flex shrink-0 items-center justify-between overflow-hidden rounded-lg border bg-background px-2.5 text-xs"
            >
              <span>{s(k)}</span>
              {i === 1 ? <Trash2 className="h-3.5 w-3.5 text-destructive" /> : <span dir="ltr">₪14.90</span>}
            </div>
          ))}
          <div className="mt-1 flex justify-center">
            <span data-role="undo" className="flex items-center gap-1 rounded-full bg-foreground px-2.5 py-1 text-[10px] font-medium text-background opacity-0">
              <Undo2 className="h-3 w-3" /> {s('undo')}
            </span>
          </div>
        </div>
      );

    case 'button': {
      const label = event === 'payment' ? s('pay') : s('continue');
      return (
        <div className="flex h-full items-center justify-center">
          <div data-role="target" className="relative h-10 w-44 overflow-hidden rounded-xl bg-muted text-sm font-semibold">
            <span className="absolute inset-0 flex items-center justify-center text-muted-foreground">{label}</span>
            <span data-role="fill" className="absolute inset-0 flex items-center justify-center gap-1.5 bg-primary text-primary-foreground">
              {label}
              {event === 'payment' && after ? <Lock className="h-3.5 w-3.5" /> : null}
            </span>
          </div>
        </div>
      );
    }

    case 'field':
      return (
        <div className="flex h-full flex-col items-center justify-center gap-1.5">
          <div data-role="target" className={cn('w-48 rounded-xl border bg-background p-2 text-xs transition-colors', after && 'border-destructive')}>
            <div className="mb-1.5 font-medium">{s('size')}</div>
            <div className="flex gap-1">
              {['S', 'M', 'L'].map((x) => (
                <span key={x} className="flex h-6 flex-1 items-center justify-center rounded-md border text-[10px]">
                  {x}
                </span>
              ))}
            </div>
          </div>
          <span data-role="message" className={cn('text-[11px] font-medium text-destructive transition-opacity', !after && 'opacity-0')}>
            {s('missing')}
          </span>
        </div>
      );

    case 'progress':
      return (
        <div className="flex h-full flex-col items-center justify-center gap-2">
          <CreditCard className="h-7 w-7 text-primary" />
          <span className="text-xs font-medium">{s('paying')}</span>
          <div data-role="target" className="relative h-2 w-44 overflow-hidden rounded-full bg-muted">
            <div data-role="bar" className="absolute inset-0 origin-right rounded-full bg-primary" />
            <div data-role="shimmer" className="absolute inset-0 bg-gradient-to-l from-transparent via-white/70 to-transparent opacity-0 dark:via-white/30" />
          </div>
        </div>
      );

    case 'check':
      return (
        <div className="relative flex h-full flex-col items-center justify-center gap-1.5">
          <div data-role="target" className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500 text-white shadow-lg">
            <svg viewBox="0 0 24 24" className="h-8 w-8" fill="none" stroke="currentColor" strokeWidth={3} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path data-role="checkPath" d="M5 12.5l4.5 4.5L19 7.5" pathLength={1} strokeDasharray="1" strokeDashoffset={0} />
            </svg>
          </div>
          <span data-role="orderNo" className="text-sm font-bold">
            {s('order')}
          </span>
          {Array.from({ length: CONFETTI_PIECES }, (_, i) => (
            <span
              key={i}
              data-role={`confetti-${i}`}
              className="pointer-events-none absolute start-1/2 top-[38%] h-2 w-1.5 rounded-[2px] opacity-0"
              style={{ background: CONFETTI_COLORS[i % CONFETTI_COLORS.length] }}
            />
          ))}
        </div>
      );

    case 'attract':
      return (
        <div className="relative h-full overflow-hidden bg-gradient-to-br from-primary/15 via-background to-background">
          <div data-role="layerBack" className="absolute -start-6 -top-10 h-28 w-28 rounded-full bg-primary/25 blur-2xl" />
          <div data-role="layerMid" className="absolute -bottom-12 end-6 h-24 w-24 rounded-full bg-amber-400/30 blur-2xl" />
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2">
            <span className="text-[11px] text-muted-foreground">{s('home')}</span>
            <span data-role="target" className="rounded-full bg-primary px-4 py-2 text-xs font-semibold text-primary-foreground shadow-lg">
              {s('touch')}
            </span>
          </div>
        </div>
      );

    case 'skeleton':
      return (
        <div data-role="target" className="relative grid h-full grid-cols-3 gap-2 overflow-hidden p-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="space-y-1.5 rounded-lg bg-muted p-1.5">
              <div className="h-12 rounded-md bg-muted-foreground/15" />
              <div className="h-1.5 w-3/4 rounded bg-muted-foreground/15" />
              <div className="h-1.5 w-1/2 rounded bg-muted-foreground/15" />
            </div>
          ))}
          <div data-role="shimmer" className="pointer-events-none absolute inset-0 bg-gradient-to-l from-transparent via-white/60 to-transparent opacity-0 dark:via-white/15" />
        </div>
      );

    case 'scroll':
      return (
        <div className="relative h-full overflow-hidden">
          <MiniTiles count={6} className="p-3" />
          <div className="absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-background via-background/80 to-transparent" />
          <div className="absolute inset-x-0 bottom-2 flex flex-col items-center gap-0.5">
            <span className="text-[10px] text-muted-foreground">{s('more')}</span>
            <span data-role="target" className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg">
              <ChevronsDown className="h-4 w-4" />
            </span>
          </div>
        </div>
      );

    default:
      return null;
  }
}

/* ----------------------------------------------------------------- stage */

/**
 * One event's sample stage. `handle.play()` plays the spec as resolved; a note covers the stage
 * when the event does not play (switched off, "ללא", no time).
 */
export function MotionStage({
  spec,
  handle,
  className,
}: {
  spec: ResolvedMotion;
  handle?: RefObject<MotionStageHandle | null>;
  className?: string;
}) {
  const { t } = useMotionText();
  const rootRef = useRef<HTMLDivElement>(null);
  const stopRef = useRef<(() => void) | null>(null);
  const [after, setAfter] = useState(false);
  const [counts, setCounts] = useState<Record<string, string>>({});
  const scene = MOTION_SCENES[spec.event];

  const play = () => {
    const root = rootRef.current;
    if (!root) return;
    stopRef.current?.();
    stopRef.current = null;
    setAfter(false);
    setCounts({});
    const plan = planMotionPreview(spec, scene, measure(root));
    if (plan.tracks.length === 0 && plan.counters.length === 0) return;
    stopRef.current = playPlan(root, plan, {
      onSwap: () => setAfter(true),
      onCount: (role, text) => setCounts((c) => (c[role] === text ? c : { ...c, [role]: text })),
      onDone: () => {
        stopRef.current = null;
        setAfter(false);
        setCounts({});
      },
    });
  };
  useImperativeHandle(handle, () => ({ play }));
  useEffect(() => () => stopRef.current?.(), []);

  const silent = !spec.enabled ? t('stageOff') : spec.animationType === 'none' || spec.durationMs <= 0 ? t('stageNone') : null;
  return (
    <div
      ref={rootRef}
      dir="rtl"
      data-motion-event={spec.event}
      className={cn('relative h-40 select-none overflow-hidden rounded-xl border bg-muted/30', className)}
      style={{
        backgroundImage: 'radial-gradient(circle, color-mix(in oklab, var(--border) 85%, transparent) 1px, transparent 1px)',
        backgroundSize: '14px 14px',
      }}
      aria-hidden
    >
      <Scene event={spec.event} scene={scene} after={after} counts={counts} />
      {silent ? (
        <div className="absolute inset-0 flex items-center justify-center bg-background/60 backdrop-blur-[1px]">
          <span className="rounded-full border bg-background px-3 py-1 text-xs font-medium text-muted-foreground shadow-sm">{silent}</span>
        </div>
      ) : null}
    </div>
  );
}

/** The caption under a stage: the kind as played, its time, delay and repeats, the reduced fallback. */
export function MotionStageCaption({ spec, label, light }: { spec: ResolvedMotion; label?: ReactNode; light?: boolean }) {
  const tx = useMotionText();
  const plan = planMotionPreview(spec);
  const playing = spec.enabled && spec.animationType !== 'none' && spec.durationMs > 0;
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground">
      {label ? <span className="font-semibold text-foreground">{label}</span> : null}
      <span>{tx.kind(playing ? spec.animationType : 'none')}</span>
      {playing ? (
        <>
          <span dir="ltr" className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-foreground">
            {spec.durationMs}ms
          </span>
          {spec.delayMs > 0 ? <span dir="ltr">{tx.t('stageDelay', { ms: spec.delayMs })}</span> : null}
          {plan.loop ? <span>{tx.t('stageLoop')}</span> : spec.repeat > 1 ? <span dir="ltr">{tx.t('stageRepeats', { n: spec.repeat })}</span> : null}
          {plan.truncated ? <span>{tx.t('stageTruncated', { shown: plan.cycles, n: spec.repeat })}</span> : null}
        </>
      ) : null}
      {spec.reduced ? <span className="rounded bg-amber-100 px-1.5 py-0.5 text-amber-900 dark:bg-amber-950/60 dark:text-amber-200">{tx.t('stageReduced')}</span> : null}
      {light && !spec.reduced ? <span className="rounded bg-muted px-1.5 py-0.5">{tx.t('stageLight')}</span> : null}
    </div>
  );
}
