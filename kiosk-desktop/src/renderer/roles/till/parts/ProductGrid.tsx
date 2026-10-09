/**
 * The product grid, virtualised (§13.3): only the rows on screen (and a few around them) are in
 * the DOM, so 200+ products scroll at 30 fps on a Celeron drawing in software. Rows have a fixed
 * height from the layout; a tap sends `sell.add` — the engine puts it in the cart.
 */

import { useEffect, useRef, useState } from 'react';
import type { Department, Product } from '../../../../shared/till/protocol';
import { money } from '../text';

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

export function ProductGrid({
  products,
  departments,
  columns,
  tileHeight,
  onAdd,
}: {
  products: Product[];
  departments: Department[];
  columns: number;
  tileHeight: number;
  onAdd(productId: string): void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewHeight, setViewHeight] = useState(900);
  const frame = useRef(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setViewHeight(el.clientHeight || 900);
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(() => setViewHeight(el.clientHeight || 900));
    ro.observe(el);
    return () => ro.disconnect();
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
  const rows = Math.ceil(products.length / columns);
  const w = gridWindow(rows, tileHeight, scrollTop, viewHeight);
  const visible: Product[][] = [];
  for (let r = w.first; r <= w.last; r++) visible.push(products.slice(r * columns, (r + 1) * columns));

  return (
    <div className="t-grid" ref={ref} onScroll={onScroll} aria-label="מוצרים">
      <div style={{ height: w.padTop }} />
      {visible.map((row, i) => (
        <div key={w.first + i} className="t-grid-row" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, height: tileHeight }}>
          {row.map((p) => (
            <button key={p.id} type="button" className="t-tile" style={{ borderInlineStartColor: colorOf.get(p.departmentId) ?? '#9aa1ab' }} onClick={() => onAdd(p.id)}>
              <span className="t-tile-name">{p.name}</span>
              <span className="t-tile-price">{money(p.priceAgorot)}</span>
            </button>
          ))}
        </div>
      ))}
      <div style={{ height: w.padBottom }} />
      {products.length === 0 ? <p className="t-empty">לא נמצאו מוצרים</p> : null}
    </div>
  );
}
