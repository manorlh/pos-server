/**
 * The layouts' shared parts on the web (docs/SPEC_KIOSK_LAYOUTS.md), as the Android kiosk's
 * layouts/KioskLayoutParts.kt: the order bar ("ההזמנה שלי · 3 פריטים · ₪142 · לתשלום"), the guided
 * step bar, a dish's card in the layout's shape (tile / row / plate) and the words of the layouts.
 * Sizes are drawn for the kiosk's 540 CSS px across (a 1080 screen at ×2) and scale with the frame.
 */

import { createContext, useContext, type CSSProperties, type ReactNode } from 'react';
import { Check, Plus, ShoppingBag } from 'lucide-react';
import { cn } from '@/lib/utils';
import { contrastText } from '@/lib/kioskConfig';
import { kioskTextOf } from '@/lib/kioskTexts';
import { cardKindOf, guidedBar, layoutOf, productColumns, tapPathOf, type GuidedBarItem, type GuidedStep } from '@/lib/kioskLayout';
import {
  CartTarget,
  CountUp,
  DietaryChips,
  ProductImage,
  cardStyle,
  cartCount,
  cartTotal,
  textSize,
  type PProduct,
  type PreviewModel,
} from '@/components/dashboard/kiosks/preview-screens';
import { badgePop } from '@/components/dashboard/kiosks/preview-feedback';

/** A layout's word: the registry's text (as the business set it, in the screen's language), placeholders filled. */
export function kt(m: PreviewModel, key: string, values?: Record<string, string | number>): string {
  return m.kt ? m.kt(key, values) : kioskTextOf(m.cfg, 'he', key, values);
}

/** Android dp per CSS px of these screens: the kiosk's 540 CSS px are its ~785 dp across. */
export const DP_PER_PX = 785 / 540;

/** The frame's width as the Android kiosk's dp (its layout rules: the side panel, the rail). */
export function widthDpOf(m: PreviewModel): number {
  return Math.round(m.screen.w * DP_PER_PX);
}

/**
 * The dishes' columns in `widthPx` of these screens, by the Android kiosk's rule (KioskStyle.columnsFor
 * on its dp): compact 3 / 4, comfortable 2 / 3, large 1–2 / 2 — phone / tablet — one more from 1100 dp.
 */
export function dishColumnsFor(m: PreviewModel, widthPx: number): number {
  const dp = widthPx * DP_PER_PX;
  const density = m.cfg.theme.gridDensity;
  const [phone, tablet] = density === 'compact' ? [3, 4] : density === 'large' ? [dp >= 400 ? 2 : 1, 2] : [2, 3];
  // "גודל מוצרים" (layout.productSize): a column more or fewer, as on the Android kiosk.
  return productColumns(dp < 600 ? phone : dp >= 1100 ? tablet + 1 : tablet, layoutOf(m.cfg).productSize, dp);
}

/** The frame's scale against the kiosk's 540 CSS px. */
export function unitOf(m: PreviewModel): number {
  return Math.min(1.6, Math.max(0.55, m.screen.w / 540));
}

/** What a layout's dish card asks of its catalog: "רוצים להפוך לארוחה?" for a dish. */
export interface LayoutActions {
  askMeal?: (p: PProduct, from: DOMRect | null) => void;
}

export const LayoutActionsContext = createContext<LayoutActions>({});

/**
 * A dish tapped in a layout (`plus`: its "+"): "רוצים להפוך לארוחה?" first when the layout asks it and
 * the dish has meals; straight in when nothing must be chosen and the layout adds on a tap (or the
 * "+") — with quickAdd "always" also a dish its defaults answer, on them (the host's quickAdd); else
 * its window — the Android kiosk's KioskLayoutModel.tapItem.
 */
export function useTapDish(m: PreviewModel): (p: PProduct, plus: boolean, from: DOMRect | null) => void {
  const actions = useContext(LayoutActionsContext);
  return (p, plus, from) => {
    if (p.soldOut) return;
    const l = layoutOf(m.cfg);
    if (l.mealUpsell === 'first' && actions.askMeal && (m.mealOptions?.(p).length ?? 0) > 0) return actions.askMeal(p, from);
    if (m.quickAdd && tapPathOf(p, l.quickAdd, plus, !!m.mealOf?.(p)) === 'direct') return m.quickAdd(p, from);
    m.openProduct(p);
  };
}

/** "8 מנות" / "מנה אחת". */
export function itemsCount(m: PreviewModel, n: number): string {
  return n === 1 ? kt(m, 'categoryCountOne') : kt(m, 'categoryCount', { count: n });
}

export function SectionTitle({ m, title, count }: { m: PreviewModel; title: string; count?: number }) {
  return (
    <h3 className="flex items-baseline gap-2 pt-1 text-base font-extrabold">
      <span className="truncate">{title}</span>
      {count !== undefined ? (
        <span className="kt-11 font-medium" style={{ color: m.c.mutedText }}>
          {itemsCount(m, count)}
        </span>
      ) : null}
    </h3>
  );
}

/**
 * A dish in the layout's card ([kind]): tile (today's look), row (a line with its picture — the guided
 * flow), plate (a big picture on its plate — fast food). A tap opens it (or adds it), its "+" adds what
 * needs no choice, with the pop-and-fly.
 */
export function LayoutDishCard({ m, p, kind, inCart = 0 }: { m: PreviewModel; p: PProduct; kind?: 'tile' | 'row' | 'plate'; inCart?: number }) {
  const tap = useTapDish(m);
  const card = kind ?? cardKindOf(m.cfg);
  const u = unitOf(m);
  const added = m.justAddedId === p.id;
  const plus = (size: number, className?: string) =>
    p.soldOut ? null : (
      <span
        role="button"
        data-add={p.addPath === 'direct' ? 'direct' : 'sheet'}
        aria-label={kt(m, 'quickAdd')}
        className={cn('flex shrink-0 items-center justify-center shadow-md transition-transform duration-150 active:scale-90', className)}
        style={{ width: size, height: size, borderRadius: 999, background: added ? m.c.accent : m.c.button, color: m.c.buttonText }}
        onClick={(e) => {
          e.stopPropagation();
          tap(p, true, e.currentTarget.closest('[data-dish]')?.querySelector('[data-pic]')?.getBoundingClientRect() ?? e.currentTarget.getBoundingClientRect());
        }}
      >
        {added ? <Check className="kiosk-pop" style={{ width: size * 0.5, height: size * 0.5 }} /> : <Plus style={{ width: size * 0.5, height: size * 0.5 }} />}
      </span>
    );
  const price = (
    <span className="kt-15 font-extrabold tabular-nums" style={{ color: p.soldOut ? m.c.mutedText : card === 'plate' ? m.c.primary : m.c.text, textDecoration: p.soldOut ? 'line-through' : undefined, ...textSize(m, 'productPrice', 15) }}>
      {m.money(p.price)}
    </span>
  );
  const soldTag = p.soldOut ? <span className="absolute start-2 top-2 rounded-full bg-black/70 px-2 py-0.5 kt-10 font-bold text-white">{m.t('soldOut')}</span> : null;
  const open = (e: React.MouseEvent<HTMLElement>) => tap(p, false, e.currentTarget.querySelector('[data-pic]')?.getBoundingClientRect() ?? null);

  if (card === 'row') {
    return (
      <button
        type="button"
        data-dish={p.id}
        disabled={p.soldOut}
        onClick={open}
        className="k-tap relative flex w-full items-center gap-3 p-2.5 text-start transition-transform duration-150 active:scale-[0.99] disabled:opacity-50"
        style={{ ...cardStyle(m), background: inCart > 0 ? `${m.c.primary}0F` : cardStyle(m).background, minHeight: 84 * u }}
      >
        <div data-pic className="relative shrink-0 overflow-hidden" style={{ width: 68 * u, height: 68 * u, borderRadius: Math.min(m.radius, 14) }}>
          <ProductImage m={m} p={p} className="h-full w-full" />
          {soldTag}
        </div>
        <div className="min-w-0 flex-1 space-y-0.5">
          <div className="line-clamp-2 kt-15 font-bold leading-snug" style={textSize(m, 'productName', 15)}>
            {p.name}
          </div>
          {m.cfg.theme.showDescriptions && p.description ? (
            <div className="line-clamp-2 kt-11 leading-snug" style={{ color: m.c.mutedText, ...textSize(m, 'productDescription', 11) }}>
              {p.description}
            </div>
          ) : null}
          {price}
        </div>
        {inCart > 0 && !added ? (
          <span
            className="flex shrink-0 items-center justify-center kt-15 font-bold"
            style={{ width: 40 * u, height: 40 * u, borderRadius: 999, background: m.c.primary, color: contrastText(m.c.primary) }}
            onClick={(e) => {
              e.stopPropagation();
              tap(p, true, null);
            }}
          >
            {inCart}
          </span>
        ) : (
          plus(40 * u)
        )}
      </button>
    );
  }
  if (card === 'plate') {
    return (
      <button
        type="button"
        data-dish={p.id}
        disabled={p.soldOut}
        onClick={open}
        className="k-tap relative flex w-full flex-col items-center p-2.5 text-center transition-transform duration-150 active:scale-[0.98] disabled:opacity-50"
        style={cardStyle(m)}
      >
        <div className="relative w-full" style={{ aspectRatio: '1 / 1' }}>
          <div className="absolute inset-[6%] rounded-full" style={{ background: `${m.c.primary}12` }} />
          <div data-pic className="absolute inset-[9%] overflow-hidden rounded-full">
            <ProductImage m={m} p={p} className="h-full w-full" />
          </div>
          {soldTag}
          {plus(42 * u, 'absolute bottom-0 end-0')}
        </div>
        <div className="mt-1 line-clamp-2 kt-15 font-bold leading-snug" style={textSize(m, 'productName', 15)}>
          {p.name}
        </div>
        <div className="mt-0.5">{price}</div>
      </button>
    );
  }
  return (
    <button
      type="button"
      data-dish={p.id}
      disabled={p.soldOut}
      onClick={open}
      className="k-tap group relative flex w-full flex-col overflow-hidden text-start transition-transform duration-150 active:scale-[0.98] disabled:opacity-60"
      style={cardStyle(m)}
    >
      <div data-pic className="relative w-full overflow-hidden" style={{ aspectRatio: m.ratio }}>
        <ProductImage m={m} p={p} className="h-full w-full" style={p.soldOut ? { filter: 'grayscale(1)', opacity: 0.55 } : undefined} />
        {soldTag}
        {plus(34 * u, 'absolute bottom-2 end-2')}
      </div>
      <div className="space-y-0.5 p-2.5">
        <div className="line-clamp-2 kt-13 font-bold leading-snug" style={textSize(m, 'productName', 13)}>
          {p.name}
        </div>
        {m.cfg.theme.showDescriptions && p.description ? (
          <div className="line-clamp-2 kt-11 leading-snug" style={{ color: m.c.mutedText, ...textSize(m, 'productDescription', 11) }}>
            {p.description}
          </div>
        ) : null}
        <DietaryChips m={m} tags={p.dietaryTags} />
        {price}
      </div>
    </button>
  );
}

/** How many of each dish the basket holds (the row card's badge). */
export function cartCounts(m: PreviewModel): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of m.cart) out[l.product.id] = (out[l.product.id] ?? 0) + l.qty;
  return out;
}

/**
 * "ההזמנה שלי · 3 פריטים · ₪142 · לתשלום" — the order bar fixed at the bottom (layout.basket = summary,
 * McDonald's): the count and the total (a tap opens the basket), the payment's button. Always there.
 */
export function OrderSummaryBar({ m }: { m: PreviewModel }) {
  const u = unitOf(m);
  const count = cartCount(m.cart);
  const empty = count === 0;
  const bar = m.c.dark ? m.c.surface : '#14161A';
  const toBasket = () => !empty && m.go(m.cfg.general.skipCart === 'off' ? 'cart' : 'pay');
  // The count's pop: the engine's cartBadge, else the add's bounce.
  const pop = badgePop(m, !empty);
  return (
    <div className="flex shrink-0 items-center gap-2 px-3" style={{ background: bar, minHeight: 64 * u, color: '#fff' }}>
      <button type="button" className="flex min-w-0 flex-1 items-center gap-2.5 py-2 text-start" onClick={toBasket} disabled={empty}>
        <CartTarget
          register={m.setCartTarget}
          key={m.cartBump}
          className={cn('flex shrink-0 items-center justify-center rounded-full font-bold tabular-nums', pop.className)}
          style={{ width: 38 * u, height: 38 * u, background: 'rgba(255,255,255,0.14)', ...pop.style } as CSSProperties}
        >
          {empty ? <ShoppingBag className="h-1/2 w-1/2" /> : count}
        </CartTarget>
        <span className="min-w-0 flex-1">
          <span className="block truncate kt-11" style={{ opacity: 0.72 }}>
            {kt(m, 'basketMyOrder')}
          </span>
          <span className="block truncate kt-15 font-bold">{empty ? kt(m, 'basketEmpty') : count === 1 ? kt(m, 'basketItemsOne') : kt(m, 'basketItems', { count })}</span>
        </span>
        {!empty ? (
          <span className="shrink-0 text-lg font-extrabold tabular-nums">
            <CountUp value={cartTotal(m.cart)} ms={m.motion.countUpMs} format={m.money} />
          </span>
        ) : null}
      </button>
      <button
        type="button"
        disabled={empty}
        onClick={() => m.go('pay')}
        className="k-tap k-tap-solid relative shrink-0 px-5 kt-15 font-extrabold transition-transform duration-150 active:scale-95"
        style={{
          minHeight: 46 * u,
          minWidth: 120 * u,
          borderRadius: m.btnRadius,
          background: empty ? 'rgba(255,255,255,0.16)' : m.c.accent,
          color: empty ? 'rgba(255,255,255,0.5)' : contrastText(m.c.accent),
          ...textSize(m, 'buttons', 15),
        }}
      >
        {kt(m, 'basketPay')}
      </button>
    </div>
  );
}

/** The words of a guided step (the registry's keys; the checkout's own where they are the same). */
function guidedWord(m: PreviewModel, item: GuidedBarItem): string {
  if (item.key === 'details') return m.txt('stepDetails');
  if (item.key === 'payMethod') return m.txt('stepPayMethod');
  return kt(m, item.textKey);
}

/** "שירות ✓ · תפריט · סל · טיפ · תשלום" — the guided flow's step bar. */
export function GuidedBar({ m, current, serviceStep, checkout }: { m: PreviewModel; current: GuidedStep; serviceStep: boolean; checkout: ReadonlyArray<'tip' | 'details' | 'payMethod'> }) {
  const items = guidedBar(serviceStep, checkout, current);
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-center gap-x-1.5 gap-y-0.5 px-3 py-2 kt-11" role="list">
      {items.map((it, i) => (
        <span key={it.key} className="flex items-center gap-1.5" role="listitem">
          {i > 0 ? <span style={{ color: m.c.mutedText, opacity: 0.6 }}>·</span> : null}
          <span
            className={it.state === 'current' ? 'font-bold' : undefined}
            style={{ color: it.state === 'current' ? m.c.primary : m.c.mutedText }}
            data-text-key={it.textKey}
          >
            {it.state === 'done' ? '✓ ' : ''}
            {guidedWord(m, it)}
          </span>
        </span>
      ))}
    </div>
  );
}

/** The guided flow's main button at the bottom ("המשך לסל · 2 פריטים · ₪126"). */
export function GuidedBasketButton({ m }: { m: PreviewModel }) {
  const count = cartCount(m.cart);
  if (count === 0) return null;
  const u = unitOf(m);
  const pop = badgePop(m);
  return (
    <div className="shrink-0 p-2.5" style={{ background: `linear-gradient(to top, ${m.c.background}, ${m.c.background}00)` }}>
      <button
        type="button"
        onClick={() => m.go(m.cfg.general.skipCart === 'off' ? 'cart' : 'pay')}
        className="k-tap k-tap-solid relative flex w-full items-center justify-center gap-2 px-4 kt-15 font-bold shadow-lg transition-transform duration-150 active:scale-[0.98]"
        style={{ minHeight: 50 * u, borderRadius: m.btnRadius, background: m.c.button, color: m.c.buttonText, ...textSize(m, 'buttons', 15) }}
      >
        <CartTarget register={m.setCartTarget} key={m.cartBump} className={pop.className} style={m.engine ? pop.style : undefined}>
          {kt(m, 'guidedToBasket', { count, total: m.money(cartTotal(m.cart)) })}
        </CartTarget>
      </button>
    </div>
  );
}

export function Empty({ m, children }: { m: PreviewModel; children: ReactNode }) {
  return (
    <p className="py-10 text-center text-sm" style={{ color: m.c.mutedText }}>
      {children}
    </p>
  );
}
