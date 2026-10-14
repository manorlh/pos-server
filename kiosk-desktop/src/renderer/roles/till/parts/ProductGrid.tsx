/**
 * The product grid, virtualised (§13.3): only the rows on screen (and a few around them) are in
 * the DOM, so 200+ products scroll at 30 fps on a Celeron drawing in software. Rows have the
 * layout's height — taller, row by row, when the name wraps ("שם הפריט על הכפתור" = wrap); a tap
 * sends `sell.add` — the engine puts it in the cart.
 *
 * Each tile writes its name and price as the APK does (./tileText.ts, P:/specs/product-tile-text.md):
 * the whole name (fit / wrap / clip), the price never cut, and the "i" at its top-left — a button of
 * its own beside the tile's (never inside it), so a tap on it opens the item's details and adds nothing.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { ProductTextSettings } from '@dash-lib/productTileText';
import type { Department, Product } from '../../../../shared/till/protocol';
import { money, T } from '../text';
import { layoutTile, resetTileCaches, rowHeights, tileCache, TILE_NAME_LINE_HEIGHT } from './tileText';

const GAP = 6;
const OVERSCAN_ROWS = 3;
/** The grid's side padding (till.css `.t-grid`). */
const PAD_X = 8;

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

/** The same for rows of their own heights (wrap): the rows the viewport meets, and a few around them (pure; tested). */
export function gridWindowOf(heights: readonly number[], scrollTop: number, viewHeight: number, overscan = OVERSCAN_ROWS): GridWindow {
  const rows = heights.length;
  if (rows <= 0) return { first: 0, last: -1, padTop: 0, padBottom: 0 };
  const tops: number[] = [];
  let y = 0;
  for (const h of heights) {
    tops.push(y);
    y += h + GAP;
  }
  let firstSeen = rows - 1;
  for (let i = 0; i < rows; i++) {
    if (tops[i] + heights[i] + GAP > scrollTop) {
      firstSeen = i;
      break;
    }
  }
  let lastSeen = firstSeen;
  while (lastSeen + 1 < rows && tops[lastSeen + 1] < scrollTop + viewHeight) lastSeen += 1;
  const first = Math.max(0, firstSeen - overscan);
  const last = Math.min(rows - 1, lastSeen + overscan);
  return { first, last, padTop: tops[first], padBottom: y - (tops[last] + heights[last] + GAP) };
}

/** The tile's width in a grid this wide. */
export function tileWidthOf(gridWidth: number, columns: number): number {
  return Math.max(1, (gridWidth - 2 * PAD_X - (columns - 1) * GAP) / Math.max(1, columns));
}

export function ProductGrid({
  products,
  departments,
  columns,
  tileHeight,
  productText,
  onAdd,
  onInfo,
  initialWidth = 0,
}: {
  products: Product[];
  departments: Department[];
  columns: number;
  tileHeight: number;
  /** "שם פריט מלא ותג i": the engine's four (the design's `look` over the till parameters). */
  productText: ProductTextSettings;
  onAdd(productId: string): void;
  /** The "i": the item's details. */
  onInfo(productId: string): void;
  /** The grid's width before it is measured (a render without a screen: the tests). */
  initialWidth?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [view, setView] = useState({ width: initialWidth, height: 900 });
  const [, setFontsVersion] = useState(0);
  const frame = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setView((v) => (v.width === el.clientWidth && v.height === (el.clientHeight || 900) ? v : { width: el.clientWidth, height: el.clientHeight || 900 }));
    read();
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // The names were measured before the web font loaded: once it has, measured again (once).
  useEffect(() => {
    if (typeof document === 'undefined' || !document.fonts) return;
    let alive = true;
    void document.fonts.ready.then(() => {
      if (!alive) return;
      resetTileCaches();
      setFontsVersion((v) => v + 1);
    });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => () => cancelAnimationFrame(frame.current), []);

  const onScroll = () => {
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (ref.current) setScrollTop(ref.current.scrollTop);
    });
  };

  const colorOf = new Map(departments.map((d) => [d.id, d.color] as const));
  const rows = useMemo(() => {
    const out: Product[][] = [];
    for (let i = 0; i < products.length; i += columns) out.push(products.slice(i, i + columns));
    return out;
  }, [products, columns]);
  const tileW = view.width > 0 ? tileWidthOf(view.width, columns) : 0;
  const names = tileCache(700);
  const prices = tileCache(400);
  const heights = tileW > 0 ? rowHeights(rows, tileW, tileHeight, productText, names, prices) : rows.map(() => tileHeight);
  const w = productText.productNameFit === 'wrap' ? gridWindowOf(heights, scrollTop, view.height) : gridWindow(rows.length, tileHeight, scrollTop, view.height);

  return (
    <div className="t-grid" ref={ref} onScroll={onScroll} aria-label="מוצרים">
      <div style={{ height: w.padTop }} />
      {rows.slice(w.first, w.last + 1).map((row, i) => {
        const index = w.first + i;
        return (
          <div key={index} className="t-grid-row" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, height: heights[index] }}>
            {row.map((p) => {
              const tile = tileW > 0 ? layoutTile(p, tileW, tileHeight, productText, names, prices) : null;
              const blocked = !!p.blocked;
              return (
                <div key={p.id} className={`t-tile-wrap${blocked ? ' t-tile-blocked' : ''}`}>
                  <button type="button" className="t-tile" style={{ borderInlineStartColor: colorOf.get(p.departmentId) ?? '#9aa1ab' }} onClick={() => onAdd(p.id)} aria-label={p.name}>
                    {tile ? (
                      <span className="t-tile-name t-tile-name-fit" style={{ fontSize: tile.name.size, lineHeight: TILE_NAME_LINE_HEIGHT, paddingInlineEnd: tile.badge ? 26 : 0 }}>
                        {tile.name.lines.map((line, k) => (
                          <span key={k} className="t-tile-line">
                            {line}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="t-tile-name">{p.name}</span>
                    )}
                    <span className="t-tile-price" style={tile ? { fontSize: tile.price.size } : undefined}>
                      {tile ? tile.price.text : money(p.priceAgorot)}
                    </span>
                    {blocked ? <span className="t-tile-flag">{p.blocked?.kind === 'blocked' ? T.blocked : T.soldOut}</span> : null}
                  </button>
                  {tile?.badge ? (
                    <button type="button" className="t-tile-info" aria-label={`${T.itemDetails}: ${p.name}`} onClick={() => onInfo(p.id)}>
                      <span aria-hidden>i</span>
                    </button>
                  ) : null}
                </div>
              );
            })}
          </div>
        );
      })}
      <div style={{ height: w.padBottom }} />
      {products.length === 0 ? <p className="t-empty">לא נמצאו מוצרים</p> : null}
    </div>
  );
}
