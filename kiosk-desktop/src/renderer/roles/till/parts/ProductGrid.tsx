/**
 * The product grid, virtualised (§13.3): only the rows on screen (and a few around them) are in
 * the DOM, so 200+ products scroll at 30 fps on a Celeron drawing in software. Rows have a fixed
 * height from the layout; a tap sends `sell.add` — the engine puts it in the cart.
 *
 * "שם פריט מלא על הכפתור, ותג i" (core/tile text, P:/specs/product-tile-text.md): the name laid out by `productNameFit`
 * (shrunk, then broken over lines, "…" last), the price never cut, and the "i" at the tile's top left — a tap on it opens
 * the item's window (`onInfo`), never the cart. Worked out once per name per tile width.
 */

import { useEffect, useRef, useState } from 'react';
import type { Department, Product, TileTextState } from '../../../../shared/till/protocol';
import { nameLayout, priceLayout, showsInfo, TILE_TEXT_DEFAULTS, type NameLayout } from '../../../../core/till/tileText';
import { money, T } from '../text';

/** The tile's padding and its price line (CSS px): what is left for the name. */
const TILE_PAD_X = 22;
// theme/look.css's tile (Android ProductTile): 5 around, the picture's 24 over the name and 2 under it, the price pill 30.
const TILE_PAD_Y = 36;
const PRICE_LINE = 30;

const GAP = 6;
const OVERSCAN_ROWS = 3;

export interface GridWindow {
  first: number;
  last: number;
  padTop: number;
  padBottom: number;
}

/** Which rows to draw for a viewport (pure; tested). */
export function gridWindow(rows: number, rowHeight: number, scrollTop: number, viewHeight: number, overscan = OVERSCAN_ROWS): GridWindow {
  if (rows <= 0) return { first: 0, last: -1, padTop: 0, padBottom: 0 };
  const step = rowHeight + GAP;
  const first = Math.max(0, Math.floor(scrollTop / step) - overscan);
  const last = Math.min(rows - 1, Math.ceil((scrollTop + viewHeight) / step) + overscan);
  return { first, last, padTop: first * step, padBottom: (rows - 1 - last) * step };
}

/** A tile held this long opens "חסום / אזל" (Android SellViewModel LOCK_PRESS_MS). */
export const HOLD_MS = 7_000;

export function ProductGrid({
  products,
  departments,
  columns,
  tileHeight,
  onAdd,
  onInfo,
  onHold,
  tileText = TILE_TEXT_DEFAULTS,
  inCart,
  namePx = 16,
}: {
  products: Product[];
  departments: Department[];
  columns: number;
  tileHeight: number;
  onAdd(productId: string): void;
  /** The "i": the item's window (absent: no badge). */
  onInfo?(product: Product): void;
  /** A tile held 7 s (Android LOCK_PRESS_MS): "חסום / אזל" for it (absent: a hold is a tap). */
  onHold?(productId: string): void;
  tileText?: TileTextState;
  /** How many of each product the order holds: its count in the tile's corner (Android ProductTile's badge). */
  inCart?: ReadonlyMap<string, number>;
  /** The name's own size before the fit steps it down: 16 on a handheld, 22 / 18 as a tablet's picture (Android). */
  namePx?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const hold = useRef<{ timer: number; fired: boolean } | null>(null);
  const holdStart = (id: string) => {
    if (!onHold) return;
    if (hold.current) window.clearTimeout(hold.current.timer);
    const h = { timer: 0, fired: false };
    h.timer = window.setTimeout(() => {
      h.fired = true;
      onHold(id);
    }, HOLD_MS);
    hold.current = h;
  };
  const holdEnd = () => {
    if (hold.current && !hold.current.fired) {
      window.clearTimeout(hold.current.timer);
      hold.current = null;
    }
  };
  const [scrollTop, setScrollTop] = useState(0);
  const [viewHeight, setViewHeight] = useState(900);
  const [viewWidth, setViewWidth] = useState(800);
  const frame = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setViewHeight(el.clientHeight || 900);
    setViewWidth(el.clientWidth || 800);
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(() => {
      setViewHeight(el.clientHeight || 900);
      setViewWidth(el.clientWidth || 800);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The text box of one tile (the grid's width over its columns, less the gaps and the padding).
  const textWidth = Math.max(40, Math.floor((viewWidth - (columns - 1) * GAP) / Math.max(1, columns)) - TILE_PAD_X);
  const nameHeight = Math.max(16, tileHeight - TILE_PAD_Y - PRICE_LINE);
  // Once per name per tile width (and per setting): the J1900 never lays out a name twice.
  const cache = useRef<{ key: string; map: Map<string, NameLayout> }>({ key: '', map: new Map() });
  const cacheKey = `${textWidth}|${nameHeight}|${namePx}|${tileText.fit}|${tileText.maxLines}|${tileText.minSize}`;
  if (cache.current.key !== cacheKey) cache.current = { key: cacheKey, map: new Map() };
  const layoutOf = (name: string) => {
    const layouts = cache.current.map;
    let l = layouts.get(name);
    if (!l) {
      l = nameLayout(name, textWidth, nameHeight, tileText, namePx);
      layouts.set(name, l);
    }
    return l;
  };

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const onScroll = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (ref.current) setScrollTop(ref.current.scrollTop);
    });
  };

  const colorOf = new Map(departments.map((d) => [d.id, d.color] as const));
  const rows = Math.ceil(products.length / columns);
  const w = gridWindow(rows, tileHeight, scrollTop, viewHeight);
  const visible: Product[][] = [];
  for (let r = w.first; r <= w.last; r++) visible.push(products.slice(r * columns, (r + 1) * columns));

  return (
    <div className="t-grid" ref={ref} onScroll={onScroll} aria-label="מוצרים">
      <div style={{ height: w.padTop }} />
      {visible.map((row, i) => (
        <div key={w.first + i} className="t-grid-row" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, height: tileHeight }}>
          {row.map((p) => {
            const name = layoutOf(p.name);
            const price = priceLayout(money(p.priceAgorot), textWidth);
            const info = !!onInfo && showsInfo(tileText.infoBadge, !!p.description, name.whole);
            return (
              <button
                key={p.id}
                type="button"
                className={`t-tile${p.sale ? ' t-tile-off' : ''}${info ? ' t-tile-has-info' : ''}`}
                style={{ borderInlineStartColor: colorOf.get(p.departmentId) ?? '#9aa1ab' }}
                onPointerDown={() => holdStart(p.id)}
                onPointerUp={holdEnd}
                onPointerLeave={holdEnd}
                onPointerCancel={holdEnd}
                onClick={() => {
                  // A hold that opened the sheet is not a tap as well.
                  if (hold.current?.fired) {
                    hold.current = null;
                    return;
                  }
                  onAdd(p.id);
                }}
              >
                <span className="t-tile-name" style={{ fontSize: name.px, WebkitLineClamp: name.lines }} title={name.whole ? undefined : p.name}>
                  {p.name}
                </span>
                <span className="t-tile-price" style={{ fontSize: price.px }}>
                  {price.text}
                </span>
                {inCart && (inCart.get(p.id) ?? 0) > 0 ? (
                  // The count in the order, in the brand colour at the tile's start corner (ProductTile, 22 dp).
                  <span className="t-tile-count" aria-hidden="true">
                    {Math.ceil(inCart.get(p.id) ?? 0)}
                  </span>
                ) : null}
                {p.sale ? <span className="t-tile-badge">{p.sale === 'blocked' ? T.blockedBadge : p.sale === 'unavailable' ? T.unavailableBadge : T.soldOutBadge}</span> : null}
                {info ? (
                  // The "i" (top left; never the cart): a span, so the tile stays one button — its tap stops here.
                  <span
                    role="button"
                    tabIndex={0}
                    aria-label={T.itemInfo}
                    className="t-tile-info"
                    onClick={(e) => {
                      e.stopPropagation();
                      e.preventDefault();
                      onInfo!(p);
                    }}
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' && e.key !== ' ') return;
                      e.stopPropagation();
                      e.preventDefault();
                      onInfo!(p);
                    }}
                  >
                    <span className="t-tile-info-dot">i</span>
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      ))}
      <div style={{ height: w.padBottom }} />
      {products.length === 0 ? <p className="t-empty">{T.noMatch}</p> : null}
    </div>
  );
}
