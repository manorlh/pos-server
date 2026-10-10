/**
 * The baskets of the layouts on the web (layout.basket, docs/SPEC_KIOSK_LAYOUTS.md), as the Android
 * kiosk's layouts/KioskLayoutBaskets.kt: where each sits — floating over the dishes' bottom (the bar
 * of today, "fab" — a round button at the end corner, "drawer" — the bar that opens the order from the
 * side) or docked under the menu ("summary" — the order bar, "receipt" — the order's lines as a till's
 * slip) — and the phase-2 ones themselves. The add's flight lands on each one's badge.
 */

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Minus, Plus, ShoppingBag, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { EASE_ENTER, contrastText } from '@/lib/kioskConfig';
import { motionActive, motionCurve } from '@/lib/kioskMotionEngine';
import { RECEIPT_LINES, basketDocked, type BasketKind } from '@/lib/kioskLayout';
import { sheetEnter } from '@/components/dashboard/kiosks/preview-motion';
import { PREVIEW_FOOTER_PX } from '@/components/dashboard/kiosks/preview-ticker';
import {
  BigButton,
  CartBar,
  CartTarget,
  CountUp,
  Stepper,
  basketTotal,
  cartCount,
  textSize,
  type PLine,
  type PreviewModel,
} from '@/components/dashboard/kiosks/preview-screens';
import { OrderSummaryBar, kt, unitOf } from './parts';

/** The basket that floats over the dishes' bottom, inside their column: the bar, the round button, the drawer's bar. */
export function FloatingBasket({ m, kind }: { m: PreviewModel; kind: BasketKind | 'guided' }) {
  if (kind === 'bar') {
    if (m.panel) return null;
    return (
      <div className="shrink-0 p-2" style={{ background: `linear-gradient(to top, ${m.c.background}, ${m.c.background}00)` }}>
        <CartBar m={m} />
      </div>
    );
  }
  if (kind === 'fab') return <FabBasket m={m} />;
  if (kind === 'drawer') return <DrawerBasket m={m} />;
  return null;
}

/** The basket docked under the menu (the order bar, the receipt), and the strip "POWERED BY" keeps under it in the preview. */
export function DockedBasket({ m, kind }: { m: PreviewModel; kind: BasketKind | 'guided' }) {
  if (!basketDocked(kind)) return null;
  const strip = kind === 'summary' ? (m.c.dark ? m.c.surface : '#14161A') : m.c.surface;
  return (
    <>
      {kind === 'summary' ? <OrderSummaryBar m={m} /> : <ReceiptBasket m={m} />}
      {!m.live ? <div className="shrink-0" style={{ height: PREVIEW_FOOTER_PX, background: strip }} /> : null}
    </>
  );
}

/** Where the basket's flight lands, with its bounce. */
function Target({ m, className, style, children }: { m: PreviewModel; className?: string; style?: CSSProperties; children?: ReactNode }) {
  const bounce = m.motion.bounce > 0;
  return (
    <CartTarget
      register={m.setCartTarget}
      key={m.cartBump}
      className={cn(className, bounce && cartCount(m.cart) > 0 && 'kiosk-bounce')}
      style={{ ...style, ['--k-bounce' as string]: String(m.motion.bounce || 1) } as CSSProperties}
    >
      {children}
    </CartTarget>
  );
}

const toBasket = (m: PreviewModel) => m.go(m.cfg.general.skipCart === 'off' ? 'cart' : 'pay');

/** "fab": the round button at the end corner — the bag with the count, and the total. Shown once something is in. */
export function FabBasket({ m }: { m: PreviewModel }) {
  const count = cartCount(m.cart);
  if (count === 0) return null;
  const u = unitOf(m);
  return (
    <div className="relative h-0 shrink-0">
      <button
        type="button"
        onClick={() => toBasket(m)}
        className="k-tap k-tap-solid absolute bottom-3 end-3 z-10 flex items-center gap-2.5 py-1.5 pe-4 ps-1.5 shadow-lg transition-transform duration-150 animate-in slide-in-from-bottom-4 active:scale-95"
        style={{ minHeight: 56 * u, borderRadius: 999, background: m.c.button, color: m.c.buttonText }}
      >
        <span className="relative flex shrink-0 items-center justify-center rounded-full" style={{ width: 44 * u, height: 44 * u, background: 'rgba(255,255,255,0.18)' }}>
          <ShoppingBag className="h-1/2 w-1/2" />
          <Target
            m={m}
            className="absolute -end-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full px-1 kt-11 font-bold tabular-nums"
            style={{ background: m.c.accent, color: contrastText(m.c.accent) }}
          >
            {count}
          </Target>
        </span>
        <span className="text-lg font-extrabold tabular-nums">
          <CountUp value={basketTotal(m)} ms={m.motion.countUpMs} format={m.money} />
        </span>
      </button>
    </div>
  );
}

/** One line's quantity: − (at one: out of the basket) and +. */
function setQty(m: PreviewModel, line: PLine, qty: number) {
  m.setCart(qty <= 0 ? m.cart.filter((l) => l.key !== line.key) : m.cart.map((l) => (l.key === line.key ? { ...l, qty: Math.min(20, qty) } : l)));
}

/**
 * "drawer": the bar of today, opening the order from the end side over the menu (left in Hebrew) —
 * its lines with − / +, the total and the payment — without leaving the menu; the scrim closes it.
 */
export function DrawerBasket({ m }: { m: PreviewModel }) {
  const [open, setOpen] = useState(false);
  const count = cartCount(m.cart);
  if (count === 0) return null;
  const u = unitOf(m);
  const enter = sheetEnter(m.transitions);
  const drawer = m.engine?.cartOpen;
  const drawerMs = drawer ? (motionActive(drawer) ? drawer.durationMs : 0) : m.cfg.general.reduceMotion ? 0 : 300;
  const drawerSlides = !drawer || (!drawer.reduced && (drawer.animationType === 'slideIn' || drawer.animationType === 'swipeTransition'));
  const drawerEase = drawer ? motionCurve(drawer.easing, EASE_ENTER) : undefined;
  return (
    <>
      <div className="shrink-0 p-2" style={{ background: `linear-gradient(to top, ${m.c.background}, ${m.c.background}00)` }}>
        <BigButton m={m} onClick={() => setOpen(true)} className="justify-between shadow-lg animate-in slide-in-from-bottom-4 duration-300">
          <Target m={m} className="flex h-6 min-w-6 items-center justify-center rounded-full bg-white/25 px-1.5 text-xs tabular-nums">
            {count}
          </Target>
          <span data-text-key="basketMyOrder">{kt(m, 'basketMyOrder')}</span>
          <span className="tabular-nums">
            <CountUp value={basketTotal(m)} ms={m.motion.countUpMs} format={m.money} />
          </span>
        </BigButton>
      </div>
      {open ? (
        <div className="absolute inset-0 z-30 flex justify-end">
          <button type="button" aria-label={m.t('close')} className={cn('absolute inset-0 bg-black/40', enter.scrim)} style={enter.style} onClick={() => setOpen(false)} />
          <div
            // "פתיחת סל" (the motion engine's cartOpen): its time and curve; a fade when it is reduced or a fading kind.
            className={cn(
              'relative flex h-full w-[84%] max-w-[320px] flex-col shadow-2xl',
              drawerMs > 0 && (drawerSlides ? 'animate-in slide-in-from-left' : 'animate-in fade-in'),
            )}
            style={{ background: m.c.surface, color: m.c.text, animationDuration: `${drawerMs}ms`, animationTimingFunction: drawerEase }}
          >
            <div className="flex items-center gap-2 border-b px-3 py-3" style={{ borderColor: m.c.border }}>
              <span className="min-w-0 flex-1 truncate text-lg font-extrabold">{m.txt('cartTitle')}</span>
              <button type="button" aria-label={m.t('close')} onClick={() => setOpen(false)} className="flex shrink-0 items-center justify-center rounded-full" style={{ width: 40 * u, height: 40 * u, background: `${m.c.text}10` }}>
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 [scrollbar-width:none]">
              {m.cart.map((l) => (
                <div key={l.key} className="space-y-1.5 rounded-xl p-2" style={{ background: m.c.dark ? '#FFFFFF0D' : '#0000000A', ...textSize(m, 'cartLines', 13) }}>
                  <div className="flex items-start gap-2">
                    <span className="line-clamp-2 min-w-0 flex-1 kt-13 font-semibold leading-tight">{l.product.name}</span>
                    <span className="shrink-0 kt-13 font-bold tabular-nums">{m.money(l.unit * l.qty)}</span>
                  </div>
                  <Stepper
                    m={m}
                    value={l.qty}
                    small
                    onChange={(n) => {
                      setQty(m, l, n);
                      // The last line out: the drawer closes with the basket.
                      if (n <= 0 && m.cart.length === 1) setOpen(false);
                    }}
                  />
                </div>
              ))}
            </div>
            <div className="space-y-2 border-t p-3" style={{ borderColor: m.c.border }}>
              <div className="flex items-center justify-between kt-15 font-bold">
                <span>{m.t('total')}</span>
                <span className="tabular-nums">
                  <CountUp value={basketTotal(m)} ms={m.motion.countUpMs} format={m.money} />
                </span>
              </div>
              <BigButton m={m} onClick={() => m.go('pay')}>
                {kt(m, 'basketPay')}
              </BigButton>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

/** "receipt": the order's lines under the menu as a slip — "2×", the name, the price, − / + — the total and "לתשלום". */
export function ReceiptBasket({ m }: { m: PreviewModel }) {
  const u = unitOf(m);
  const count = cartCount(m.cart);
  const empty = count === 0;
  const list = useRef<HTMLDivElement>(null);
  // A slip grows at its bottom: the newest line comes into view as it is added.
  useEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [m.cart.length]);
  const lineH = 40 * u;
  return (
    <div className="shrink-0 space-y-2 border-t px-3 py-2.5" style={{ background: m.c.surface, borderColor: m.c.border, color: m.c.text }}>
      <div className="flex items-center gap-2.5">
        <Target
          m={m}
          className="flex shrink-0 items-center justify-center rounded-full font-bold tabular-nums"
          style={{ width: 34 * u, height: 34 * u, background: empty ? `${m.c.text}10` : m.c.button, color: empty ? m.c.mutedText : m.c.buttonText }}
        >
          {empty ? <ShoppingBag className="h-1/2 w-1/2" /> : count}
        </Target>
        <span className="min-w-0 flex-1">
          <span className="block truncate kt-15 font-bold" data-text-key="basketMyOrder">
            {kt(m, 'basketMyOrder')}
          </span>
          {empty ? (
            <span className="block truncate kt-11" style={{ color: m.c.mutedText }} data-text-key="basketEmpty">
              {kt(m, 'basketEmpty')}
            </span>
          ) : null}
        </span>
        {!empty ? (
          <span className="shrink-0 text-lg font-extrabold tabular-nums">
            <CountUp value={basketTotal(m)} ms={m.motion.countUpMs} format={m.money} />
          </span>
        ) : null}
      </div>
      {!empty ? (
        <div ref={list} className="overflow-y-auto border-t border-dashed [scrollbar-width:none]" style={{ maxHeight: lineH * RECEIPT_LINES, borderColor: m.c.border }}>
          {m.cart.map((l) => (
            <div key={l.key} className="flex items-center gap-2 kt-13" style={{ minHeight: lineH, ...textSize(m, 'cartLines', 13) }}>
              <span className="w-7 shrink-0 font-bold tabular-nums" style={{ color: m.c.primary }}>
                {l.qty}×
              </span>
              <span className="min-w-0 flex-1 truncate">{l.product.name}</span>
              <span className="shrink-0 font-bold tabular-nums">{m.money(l.unit * l.qty)}</span>
              <button type="button" aria-label="-" onClick={() => setQty(m, l, l.qty - 1)} className="flex shrink-0 items-center justify-center rounded-full" style={{ width: 32 * u, height: 32 * u, background: `${m.c.button}1A`, color: m.c.button }}>
                <Minus className="h-4 w-4" />
              </button>
              <button type="button" aria-label="+" onClick={() => setQty(m, l, l.qty + 1)} className="flex shrink-0 items-center justify-center rounded-full" style={{ width: 32 * u, height: 32 * u, background: m.c.button, color: m.c.buttonText }}>
                <Plus className="h-4 w-4" />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="flex gap-2">
        {!empty && m.cfg.general.skipCart === 'off' ? (
          <button type="button" onClick={() => m.go('cart')} className="shrink-0 px-4 kt-13 font-bold" style={{ minHeight: 46 * u, borderRadius: m.btnRadius, background: `${m.c.text}10` }} data-text-key="basketView">
            {kt(m, 'basketView')}
          </button>
        ) : null}
        <button
          type="button"
          disabled={empty}
          onClick={() => m.go('pay')}
          className="k-tap k-tap-solid relative min-w-0 flex-1 px-4 kt-15 font-extrabold transition-transform duration-150 active:scale-[0.98] disabled:opacity-50"
          style={{ minHeight: 46 * u, borderRadius: m.btnRadius, background: m.c.button, color: m.c.buttonText, ...textSize(m, 'buttons', 15) }}
          data-text-key="basketPay"
        >
          {kt(m, 'basketPay')}
        </button>
      </div>
    </div>
  );
}
