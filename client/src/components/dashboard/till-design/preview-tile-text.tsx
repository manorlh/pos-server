'use client';

/**
 * "שם פריט מלא על הכפתור, ותג i" in the live preview (P:/specs/product-tile-text.md): every tile of every
 * template writes its name and price through lib/productTileText.ts — the rules the tills run — with the
 * design's `productText` over the till parameters' (`m.productText`):
 *
 *  - `TileName` — the name in its box: fit (smaller, then up to the lines, "…" last), wrap (the tile
 *    grows; the grid's row takes its tallest), clip (as today); the "i" badge at the box's top-end
 *    corner (the tile's top-left in Hebrew), a 32 px touch target, its room taken from the name;
 *  - `TilePrice` — never cut: smaller to its floor, then without ".00";
 *  - `InfoSheet` — the item's sheet the badge opens (a bottom sheet on the handheld, a small window on
 *    a tablet): the full name and the category, the description, the price or its range with the
 *    sizes, the dietary tags and allergens, the picture, "אזל" / "חסום" with the reason, "הוסף לסל"
 *    (refused for a product that is not on sale, as a tap). A tap on the badge adds nothing.
 *
 * Each answer is worked out once per product and tile width (`TileTextCache`), measured with the
 * preview's own font through a canvas.
 */

import { useEffect, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type PointerEvent } from 'react';
import { useTranslations } from 'next-intl';
import { Info, X } from 'lucide-react';
import {
  INFO_BADGE_TOUCH,
  PRICE_MIN_SP,
  TileTextCache,
  canvasMeasure,
  estimateTextWidth,
  layoutTileText,
  priceRangeText,
  showInfoBadge,
  type TileTextLayout,
} from '@/lib/productTileText';
import { FONT, Num, R, R_SMALL, ellipsis, formatMoney, useBoxSize } from './preview-atoms';
import type { PProduct, PreviewEvent, PreviewModel } from './preview-model';

type D = (e: PreviewEvent) => void;

/** The dietary codes in words (the till's strings_dietary.xml, the dashboard's productDietary.tags). */
export const DIETARY_WORDS: Record<string, string> = {
  vegan: 'טבעוני',
  vegetarian: 'צמחוני',
  dairy: 'חלבי',
  meat: 'בשרי',
  gluten_free: 'ללא גלוטן',
  spicy: 'חריף',
};

/** The room the badge takes from the name's width (its 22 px square and a gap). */
export const BADGE_ROOM = 26;
const BADGE_ICON = 22;

/* ------------------------------------------------------------ measuring */

const caches = new Map<number, TileTextCache>();
let fontsSettled = false;

function fontFamily(): string {
  if (typeof window === 'undefined') return 'Heebo, sans-serif';
  const own = getComputedStyle(document.documentElement).getPropertyValue('--font-heebo').trim();
  return `${own ? `${own}, ` : ''}Heebo, "Segoe UI", system-ui, sans-serif`;
}

/** The answers at one weight, measured with the preview's font (the rough measure where there is no canvas). */
export function tileCache(weight: number): TileTextCache {
  let cache = caches.get(weight);
  if (!cache) {
    cache = new TileTextCache(canvasMeasure(fontFamily(), weight) ?? estimateTextWidth);
    caches.set(weight, cache);
  }
  return cache;
}

/** Measured again once the web font has loaded (a first paint may measure the fallback font). */
export function useTileFonts(): void {
  const [, setVersion] = useState(0);
  useEffect(() => {
    if (fontsSettled || typeof document === 'undefined' || !document.fonts) return;
    let alive = true;
    void document.fonts.ready.then(() => {
      if (!alive || fontsSettled) return;
      fontsSettled = true;
      caches.clear();
      setVersion((v) => v + 1);
    });
    return () => {
      alive = false;
    };
  }, []);
}

/* ------------------------------------------------------------ the badge */

/** The "i": a 22 px square inside a 32 px touch target; opens the item's sheet and adds nothing. */
export function InfoBadge({ m, p, d, style }: { m: PreviewModel; p: PProduct; d: D; style?: CSSProperties }) {
  const open = (e: MouseEvent | KeyboardEvent) => {
    e.stopPropagation();
    e.preventDefault();
    d({ type: 'info', productId: p.id });
  };
  const pad = (INFO_BADGE_TOUCH - BADGE_ICON) / 2;
  return (
    <span
      role="button"
      tabIndex={0}
      aria-label={`פרטי הפריט: ${p.name}`}
      title="פרטי הפריט"
      onClick={open}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') open(e);
      }}
      onPointerDown={(e: PointerEvent) => e.stopPropagation()}
      style={{
        position: 'absolute',
        top: -pad,
        insetInlineEnd: -pad,
        width: INFO_BADGE_TOUCH,
        height: INFO_BADGE_TOUCH,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        cursor: 'pointer',
        zIndex: 2,
        ...style,
      }}
    >
      <span
        aria-hidden
        style={{
          width: BADGE_ICON,
          height: BADGE_ICON,
          borderRadius: 6,
          background: m.t.surface,
          border: `1px solid ${m.t.border}`,
          color: m.t.accent,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Info size={15} strokeWidth={2.4} />
      </span>
    </span>
  );
}

/* ------------------------------------------------------------ the name */

export interface TileNameProps {
  m: PreviewModel;
  p: PProduct;
  d: D;
  /** The tile's own type size (`m.fs` applied). */
  size: number;
  weight?: number;
  lineHeight?: number;
  color?: string;
  align?: 'start' | 'center';
  /** The box (a flex item with a definite height for fit / clip; its width is the name's). */
  style?: CSSProperties;
  /** The room the badge takes from the name's box (0: the badge stands clear of the name). */
  badgeRoom?: number;
  /** Off the box's width (the badge beside the name) or its height (above a name centred on a face). */
  badgeAxis?: 'width' | 'height';
  /** Where the badge stands (absolute, against the box — or a positioned tile when the box is `static`). */
  badgeStyle?: CSSProperties;
}

/** The name and badge of one tile, from its box (null until the box is measured). */
function useTileText(m: PreviewModel, p: PProduct, size: number, weight: number, lineHeight: number, room: number, axis: 'width' | 'height') {
  const [ref, box] = useBoxSize<HTMLDivElement>();
  const wrap = m.productText.productNameFit === 'wrap';
  const layout: TileTextLayout | null =
    box.w > 0
      ? layoutTileText(
          (req) => tileCache(weight).name(req),
          { name: p.name, width: box.w, height: wrap ? 0 : box.h, size, settings: m.productText, lineHeight },
          { mode: m.productText.productInfoBadge, description: p.description },
          room,
          axis,
        )
      : null;
  return { ref, layout };
}

/**
 * A tile's name in its box, as the till writes it (see the module's head), with the "i" badge at the
 * box's top-end corner. Before the box is measured: the name in up to its lines, as CSS cuts it.
 */
export function TileName({ m, p, d, size, weight = 700, lineHeight = 1.2, color, align = 'start', style, badgeRoom = BADGE_ROOM, badgeAxis = 'width', badgeStyle }: TileNameProps) {
  const { ref, layout } = useTileText(m, p, size, weight, lineHeight, badgeRoom, badgeAxis);
  const badge = !!layout?.badge;
  const text: CSSProperties = { fontWeight: weight, lineHeight, color, textAlign: align, fontFamily: FONT };
  // "wrap": the box is as tall as its lines (the tile grows); otherwise the tile gives it its height.
  const wrap = m.productText.productNameFit === 'wrap';
  return (
    <div
      ref={ref}
      style={{
        position: 'relative',
        minWidth: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: align === 'center' ? 'center' : 'flex-start',
        ...style,
        ...(wrap ? { flex: '0 0 auto', height: 'auto', maxHeight: 'none' } : {}),
      }}
    >
      {layout ? (
        <span
          style={{
            ...text,
            display: 'block',
            fontSize: layout.name.size,
            ...(badge && badgeRoom > 0 ? (badgeAxis === 'height' ? { paddingTop: badgeRoom } : { paddingInlineEnd: badgeRoom }) : {}),
            overflow: 'hidden',
          }}
        >
          {layout.name.lines.map((line, i) => (
            <span key={i} style={{ display: 'block', whiteSpace: 'nowrap' }}>
              {line}
            </span>
          ))}
        </span>
      ) : (
        <span style={{ ...text, fontSize: size, ...ellipsis(m.productText.productNameMaxLines) }}>{p.name}</span>
      )}
      {badge ? <InfoBadge m={m} p={p} d={d} style={badgeStyle} /> : null}
    </div>
  );
}

/** The badge of a tile whose face is its photo (no name drawn): a description, or `always`. */
export function badgeWithoutName(m: PreviewModel, p: PProduct): boolean {
  return showInfoBadge(m.productText.productInfoBadge, { description: p.description, nameCut: false });
}

/** "wrap": a tile is at least its height and grows by its name (a grid row takes its tallest). */
export function wrapsName(m: PreviewModel): boolean {
  return m.productText.productNameFit === 'wrap';
}

/* ------------------------------------------------------------ the price */

/**
 * The price, never cut (§2): smaller to its floor, then without ".00"; written whole over the edge
 * if even that does not fit. Its box takes the room it is given (`flex: 1 1 0` unless `style` says).
 */
export function TilePrice({
  agorot,
  size,
  weight = 700,
  color,
  align = 'start',
  style,
}: {
  agorot: number;
  size: number;
  weight?: number;
  color?: string;
  align?: 'start' | 'center' | 'end';
  style?: CSSProperties;
}) {
  const [ref, box] = useBoxSize<HTMLSpanElement>();
  const text = formatMoney(agorot);
  const fit = box.w > 0 ? tileCache(weight).price(text, box.w, size, Math.min(size, PRICE_MIN_SP)) : null;
  return (
    <span ref={ref} style={{ display: 'block', flex: '1 1 0', minWidth: 0, textAlign: align, whiteSpace: 'nowrap', ...style }}>
      <Num style={{ fontSize: fit?.size ?? size, fontWeight: weight, color }}>{fit?.text ?? text}</Num>
    </span>
  );
}

/* ------------------------------------------------------------ the sheet */

/** The item's sheet the "i" opens (§4): a bottom sheet on the handheld, a small window on a tablet. */
export function InfoSheet({ m, d }: { m: PreviewModel; d: D }) {
  const t = useTranslations('tillDesign.productText.sheet');
  const tm = useTranslations('menu');
  const p = m.infoProduct;
  if (!p) return null;
  const k = m.t;
  const close = () => d({ type: 'info', productId: null });
  const handheld = m.handheld;
  const variants = p.variants ?? [];
  const price = priceRangeText(variants.length ? variants.map((v) => v.price) : [p.price], formatMoney);
  const status = p.available ? null : (p.status ?? { kind: 'sold_out' as const, reason: null });
  const dietary = p.dietary ?? [];
  const allergens = p.allergens ?? [];
  const allergen = (code: string) => (tm.has(`allergens.${code}`) ? tm(`allergens.${code}`) : code);
  const label: CSSProperties = { fontSize: m.fs(13), color: k.ink2, fontWeight: 600 };
  return (
    <div
      role="presentation"
      onClick={close}
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 40,
        background: 'rgba(15, 23, 42, 0.45)',
        display: 'flex',
        alignItems: handheld ? 'flex-end' : 'center',
        justifyContent: 'center',
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={p.name}
        onClick={(e) => e.stopPropagation()}
        style={{
          width: handheld ? '100%' : Math.min(460, m.W - 64),
          maxHeight: handheld ? '84%' : '86%',
          overflowY: 'auto',
          background: k.surface,
          color: k.ink,
          border: `1px solid ${k.border}`,
          borderRadius: handheld ? '16px 16px 0 0' : 14,
          fontFamily: FONT,
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        {handheld ? <span aria-hidden style={{ alignSelf: 'center', width: 40, height: 4, borderRadius: 2, background: k.border, margin: '8px 0 0' }} /> : null}
        {p.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={p.imageUrl} alt="" style={{ display: 'block', width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', marginTop: handheld ? 8 : 0, borderRadius: handheld ? 0 : '14px 14px 0 0' }} />
        ) : null}
        <div style={{ padding: handheld ? 16 : 20, display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
            <div style={{ flex: '1 1 auto', minWidth: 0 }}>
              <div style={{ fontSize: m.fs(20), fontWeight: 800, lineHeight: 1.25 }}>{p.name}</div>
              {m.infoCategory ? <div style={{ fontSize: m.fs(14), color: k.ink2, marginTop: 2 }}>{m.infoCategory}</div> : null}
            </div>
            <button
              type="button"
              aria-label={t('close')}
              onClick={close}
              style={{ width: 36, height: 36, flex: '0 0 auto', borderRadius: R_SMALL, border: `1px solid ${k.border}`, background: k.surface, color: k.ink, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer' }}
            >
              <X size={18} />
            </button>
          </div>

          {status ? (
            <div style={{ alignSelf: 'flex-start', fontSize: m.fs(14), fontWeight: 700, color: k.red, background: k.redBg, borderRadius: R_SMALL, padding: '4px 10px' }}>
              {status.kind === 'blocked' ? t('blocked') : t('soldOut')}
              {status.reason ? ` · ${status.reason}` : ''}
            </div>
          ) : null}

          <p style={{ margin: 0, fontSize: m.fs(15), lineHeight: 1.5, color: p.description?.trim() ? k.ink : k.ink2, whiteSpace: 'pre-line' }}>
            {p.description?.trim() ? p.description : t('noDescription')}
          </p>

          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
            <span style={label}>{variants.length > 1 ? t('priceRange') : t('price')}</span>
            <Num style={{ fontSize: m.fs(20), fontWeight: 800 }}>{price}</Num>
          </div>
          {variants.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={label}>{t('variants')}</span>
              {variants.map((v) => (
                <div key={v.name} style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: m.fs(15), borderBottom: `1px solid ${k.border}`, padding: '4px 0' }}>
                  <span>{v.name}</span>
                  <Num>{formatMoney(v.price)}</Num>
                </div>
              ))}
            </div>
          ) : null}

          {dietary.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={label}>{t('dietary')}</span>
              <span style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {dietary.map((tag) => (
                  <span key={tag} style={{ fontSize: m.fs(13), border: `1px solid ${k.border}`, borderRadius: 6, padding: '1px 8px' }}>
                    {DIETARY_WORDS[tag] ?? tag}
                  </span>
                ))}
              </span>
            </div>
          ) : null}
          {allergens.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <span style={label}>{t('allergens')}</span>
              <span style={{ fontSize: m.fs(14), color: k.amberInk }}>{allergens.map(allergen).join(', ')}</span>
            </div>
          ) : null}

          <button
            type="button"
            disabled={!p.available}
            onClick={() => {
              d({ type: 'add', product: p });
              close();
            }}
            style={{
              height: 48,
              borderRadius: R,
              border: 'none',
              background: p.available ? k.accent : k.border,
              color: p.available ? k.onAccent : k.ink2,
              fontSize: m.fs(16),
              fontWeight: 700,
              fontFamily: FONT,
              cursor: p.available ? 'pointer' : 'not-allowed',
            }}
          >
            {t('addToCart')}
          </button>
        </div>
      </div>
    </div>
  );
}
