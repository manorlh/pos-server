/**
 * The product grid of a designed screen (pos-android ui/sell/design/DesignProductGrid.kt, VisualMenu.kt): tiles by
 * style — card, photo, row, key, and תפריט ויזואלי's dish cards — each with the count already in the order and "אזל" /
 * "לא זמין" / "חסום" as a word when it cannot be sold (greyed; the engine decides what a tap does, as on today's grid).
 * The Windows catalogue has no pictures: a photo tile shows its name large in the photo's place, and every dish card is
 * a text card (Android's rule for a category mostly without photos).
 *
 * Virtualised as parts/ProductGrid.tsx: only the rows on screen (and three around) are in the DOM — fixed row heights
 * per style, so the J1900 lays out a few dozen tiles whatever the catalogue. A tile held 7 s opens "חסום / אזל"; the
 * "i" (core/till/tileText.ts showsInfo) opens the item's window, never the cart.
 */

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Product, TileTextState } from '../../../../shared/till/protocol';
import { nameLayout, priceLayout, showsInfo, TILE_TEXT_DEFAULTS } from '../../../../core/till/tileText';
import { money } from '../text';
import { Icon } from '../theme/icons';
import { HOLD_MS } from '../parts/ProductGrid';
import { DT } from './designText';
import {
  designColumns,
  designTileHeightDp,
  designWindow,
  dishCardHeightDp,
  dishColumns,
  dishNameLines,
  gridGaps,
  nightColumns,
  tileWidthDp,
  type TileSizeCode,
} from './designLayout';

export interface DesignGridProps {
  products: Product[];
  style: string;
  fixedColumns: number;
  tileSize: TileSizeCode;
  density: string;
  handheld: boolean;
  /** לילה: keys for the thumbs (96 dp, nightColumns). */
  night: boolean;
  /** A tablet held upright (לילה: three columns). */
  portrait: boolean;
  /** textSize "large": ×1.15 (לילה's own sizes are already its large). */
  scale: number;
  descriptionLines: number;
  dietaryShown: boolean;
  /** How many of each product are in the order now. */
  inCart: ReadonlyMap<string, number>;
  tileText?: TileTextState;
  emptyText: string;
  onTap(product: Product): void;
  /** The "i" — and a dish card's body: the item's window. */
  onInfo?(product: Product): void;
  /** A tile held 7 s: "חסום / אזל" (absent: a hold is a tap). */
  onHold?(productId: string): void;
}

/** The name's base size (px) per style, before `scale` (DesignType: name 16, touchName 18, large 20; night 20). */
function nameBase(style: string, night: boolean): number {
  if (night) return 20;
  if (style === 'dish') return 18;
  if (style === 'row') return 15;
  return 16;
}

/** The name laid out at `basePx` by the tile-text rules (nameLayout works at 16 px: the box scaled to it). */
function layoutAt(name: string, widthPx: number, heightPx: number, basePx: number, s: TileTextState) {
  const k = 16 / basePx;
  const l = nameLayout(name, widthPx * k, heightPx * k, s);
  return { px: Math.round(l.px * (basePx / 16) * 10) / 10, lines: l.lines, whole: l.whole };
}

function blockWord(p: Product): string | null {
  if (p.sale === 'sold_out') return DT.outOfStock;
  if (p.sale === 'unavailable') return DT.unavailable;
  if (p.sale === 'blocked') return DT.blocked;
  return null;
}

function qty(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

export function DesignGrid(props: DesignGridProps) {
  const { products, style, fixedColumns, tileSize, density, handheld, night, portrait, scale, descriptionLines, dietaryShown, inCart, emptyText, onTap, onInfo, onHold } = props;
  const tileText = props.tileText ?? TILE_TEXT_DEFAULTS;
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 700 });
  const [scrollTop, setScrollTop] = useState(0);
  const frame = useRef(0);
  const hold = useRef<{ timer: number; fired: boolean } | null>(null);
  const [justAdded, setJustAdded] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const read = () => setSize({ w: el.clientWidth || 800, h: el.clientHeight || 700 });
    read();
    if (typeof ResizeObserver !== 'function') return;
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  useEffect(() => () => cancelAnimationFrame(frame.current), []);
  // "נוסף" on the dish just added, for a moment — a word, no animation.
  useEffect(() => {
    if (!justAdded) return;
    const t = window.setTimeout(() => setJustAdded(null), 1200);
    return () => window.clearTimeout(t);
  }, [justAdded]);

  const dish = style === 'dish';
  const shownStyle = night ? 'key' : style;
  const columns = dish ? dishColumns(size.w, handheld, fixedColumns) : night ? nightColumns(size.w, handheld, portrait, fixedColumns) : designColumns(shownStyle, size.w, handheld, fixedColumns, null);
  const gaps = gridGaps(shownStyle, dish);
  const tileW = tileWidthDp(size.w, columns, gaps.side, gaps.column);
  const tileH = dish
    ? handheld
      ? 96
      : // A text card is as tall as what it holds: the description's lines only where the dishes have one, the dietary
        // line only where one has tags (a fixed height per grid — the rows are virtualised).
        dishCardHeightDp(
          products.some((p) => !!p.description) ? descriptionLines : 0,
          dietaryShown && products.some((p) => (p.dietary ?? []).length > 0),
          scale,
        )
    : night
      ? 96
      : designTileHeightDp(shownStyle, tileSize, density, tileW);
  const rows = Math.ceil(products.length / Math.max(1, columns));
  const win = designWindow(rows, tileH, gaps.row, Math.max(0, scrollTop - gaps.top), size.h);

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
  /** A hold that opened the sheet is not a tap as well. */
  const held = () => {
    if (hold.current?.fired) {
      hold.current = null;
      return true;
    }
    return false;
  };
  const touch = (p: Product, onClick: () => void) => ({
    onPointerDown: () => holdStart(p.id),
    onPointerUp: holdEnd,
    onPointerLeave: holdEnd,
    onPointerCancel: holdEnd,
    onClick: () => {
      if (!held()) onClick();
    },
  });
  const info = (p: Product, whole: boolean) =>
    onInfo && showsInfo(tileText.infoBadge, !!p.description, whole) ? (
      <span
        role="button"
        tabIndex={0}
        aria-label="מידע על הפריט"
        className="d-info"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          e.preventDefault();
          onInfo(p);
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.stopPropagation();
          e.preventDefault();
          onInfo(p);
        }}
      >
        i
      </span>
    ) : null;
  const badge = (n: number) => (n > 0 ? <span className="d-count">{qty(n)}</span> : null);
  const plus = (px: number) => (
    <span className="d-plus" style={{ width: px, height: px }} aria-hidden="true">
      <Icon name="add" size={Math.round(px * 0.6)} />
    </span>
  );

  const tile = (p: Product) => {
    const word = blockWord(p);
    const n = inCart.get(p.id) ?? 0;
    const base = nameBase(dish ? 'dish' : shownStyle, night) * (night ? 1 : scale);
    const price = money(p.priceAgorot);
    if (dish) {
      const lines = dishNameLines(p.description, descriptionLines);
      const name = layoutAt(p.name, tileW - 24 - 28, lines * base * 1.25, base, { ...tileText, maxLines: Math.max(lines, tileText.maxLines) });
      const add = () => {
        onTap(p);
        setJustAdded(p.id);
      };
      return (
        <div key={p.id} className={`d-dish${word ? ' d-off' : ''}${handheld ? ' d-dish-row' : ''}`} role="button" tabIndex={0} aria-label={p.name} {...touch(p, () => (onInfo ? onInfo(p) : add()))}>
          <div className="d-dish-head">
            <span className="d-dish-name" style={{ fontSize: name.px, WebkitLineClamp: name.lines }}>
              {p.name}
            </span>
          </div>
          {p.description && descriptionLines > 0 ? (
            <span className="d-dish-desc" style={{ WebkitLineClamp: handheld ? 1 : descriptionLines }}>
              {p.description}
            </span>
          ) : null}
          {dietaryShown && p.dietary && p.dietary.length > 0 ? <span className="d-dish-diet">{p.dietary.join(' · ')}</span> : null}
          <div className="d-dish-foot">
            <span className="d-dish-price">{price}</span>
            {justAdded === p.id ? <span className="d-added">{DT.dishAdded}</span> : null}
            {word ? (
              <span className="d-word">{word}</span>
            ) : (
              <>
                {n > 0 ? <span className="d-dish-n">{qty(n)}</span> : null}
                <button
                  type="button"
                  className="d-add"
                  aria-label={DT.add}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    add();
                  }}
                >
                  <Icon name="add" size={handheld ? 29 : 26} />
                </button>
              </>
            )}
          </div>
        </div>
      );
    }
    if (shownStyle === 'row') {
      const name = layoutAt(p.name, tileW - 24 - 44 - 120, tileH - 8, base, tileText);
      return (
        <button key={p.id} type="button" className={`d-row${word ? ' d-off' : ''}`} {...touch(p, () => onTap(p))}>
          <span className="d-row-name" style={{ fontSize: name.px, WebkitLineClamp: Math.min(2, name.lines) }}>
            {p.name}
          </span>
          {badge(n)}
          <span className="d-row-price">{price}</span>
          {info(p, name.whole)}
          {word ? <span className="d-word d-row-word">{word}</span> : plus(44)}
        </button>
      );
    }
    if (shownStyle === 'key') {
      const priceLine = (night ? 15 : 13 * scale) * 1.25;
      const name = layoutAt(p.name, tileW - 20 - 22, tileH - 12 - priceLine, base, tileText);
      const pr = priceLayout(price, tileW - 42, night ? 15 : 13 * scale);
      return (
        <button key={p.id} type="button" className={`d-key${word ? ' d-off' : ''}`} {...touch(p, () => onTap(p))}>
          <span className="d-key-text">
            <span className="d-key-name" style={{ fontSize: name.px, WebkitLineClamp: name.lines }}>
              {p.name}
            </span>
            <span className="d-key-price" style={{ fontSize: pr.px }}>
              {pr.text}
            </span>
          </span>
          <span className="d-key-corner">{word ? <span className="d-word">{word}</span> : badge(n)}</span>
          <span className="d-key-info">{info(p, name.whole)}</span>
        </button>
      );
    }
    if (shownStyle === 'photo') {
      const photoH = (tileW * 10) / 16;
      const big = layoutAt(p.name, tileW - 24, photoH - 24, 20 * scale, { ...tileText, maxLines: Math.max(3, tileText.maxLines) });
      const pr = priceLayout(price, tileW - 24 - 40, 15 * scale);
      return (
        <button key={p.id} type="button" className={`d-photo${word ? ' d-off' : ''}`} {...touch(p, () => onTap(p))}>
          <span className="d-photo-pic" style={{ height: photoH }}>
            <span className="d-photo-name" style={{ fontSize: big.px, WebkitLineClamp: Math.min(3, big.lines) }}>
              {p.name}
            </span>
            <span className="d-photo-count">{badge(n)}</span>
            <span className="d-photo-info">{info(p, big.whole)}</span>
          </span>
          <span className="d-photo-foot">
            <span className="d-price" style={{ fontSize: pr.px }}>
              {pr.text}
            </span>
            {word ? <span className="d-word">{word}</span> : plus(32)}
          </span>
        </button>
      );
    }
    // card: the name at the top-start (two lines), "+" at the top-end, the price at the bottom-start, the count at its end.
    const priceH = 15 * scale * 1.25;
    const name = layoutAt(p.name, tileW - 24 - 34, tileH - 24 - priceH - 4, base, tileText);
    const pr = priceLayout(price, tileW - 24 - 30, 15 * scale);
    return (
      <button key={p.id} type="button" className={`d-card${word ? ' d-off' : ''}`} {...touch(p, () => onTap(p))}>
        <span className="d-card-top">
          <span className="d-card-name" style={{ fontSize: name.px, WebkitLineClamp: name.lines }}>
            {p.name}
          </span>
          {info(p, name.whole)}
          {word ? null : plus(28)}
        </span>
        <span className="d-card-foot">
          <span className="d-price" style={{ fontSize: pr.px }}>
            {pr.text}
          </span>
          {word ? <span className="d-word">{word}</span> : badge(n)}
        </span>
      </button>
    );
  };

  const visible: Product[][] = [];
  for (let r = win.first; r <= win.last; r++) visible.push(products.slice(r * columns, (r + 1) * columns));
  const rowStyle = (): CSSProperties => ({ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, height: tileH, columnGap: gaps.column, marginBottom: gaps.row });
  return (
    <div
      className={`d-grid d-grid-${dish ? 'dish' : shownStyle}`}
      ref={ref}
      aria-label="מוצרים"
      style={{ padding: `${gaps.top}px ${gaps.side}px 12px` }}
      onScroll={() => {
        if (frame.current) return;
        frame.current = requestAnimationFrame(() => {
          frame.current = 0;
          if (ref.current) setScrollTop(ref.current.scrollTop);
        });
      }}
    >
      <div style={{ height: win.padTop }} />
      {visible.map((row, i) => (
        <div key={win.first + i} className="d-grid-row" style={rowStyle()}>
          {row.map(tile)}
        </div>
      ))}
      <div style={{ height: win.padBottom }} />
      {products.length === 0 ? <p className="d-empty">{emptyText}</p> : null}
    </div>
  );
}
