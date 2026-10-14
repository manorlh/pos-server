'use client';

/**
 * How a zone's floor plan is drawn: every sketch shape — the walls and the room, the symbols
 * (restrooms, the entrance, the bar, the stations of sketch schema 3…), the greenery, the arrow, the
 * coloured areas, the drawn lines — in the zone's canvas units, as the till draws them under its
 * tables (ui/tables/TableVisuals.kt, drawSketch). Pure drawing: the map editor, the till preview and
 * the palette's icons all draw through here.
 */

import { useId } from 'react';
import {
  AREA_FILL_DEFAULT,
  AREA_OPACITY,
  CLEAN,
  SKETCH_STYLE,
  TABLE_LOOK,
  TILE,
  WOOD,
  areaCorners,
  clampOpacity,
  counterGeometry,
  defaultText,
  hasPoints,
  isPolygonArea,
  labelChip,
  labelLayout,
  logoOpacity,
  logoPicture,
  mix,
  polygonCentroid,
  styleOf,
  type SketchElement,
  type SketchKind,
  type SketchVariant,
} from '@/lib/tableSketch';
import { iconKey, ICON_STROKE, SYMBOL_ICONS } from '@/lib/sketchSymbols';

/**
 * How the shapes are shown — the till's display parameters (P:/specs/table-map-decor-v3.md §3):
 * the words under the symbols (`auto`: where they fit, none on a small screen), the symbols' size
 * (1 = as the shape allows), the least a symbol is drawn on a small screen, upright there.
 */
export interface SketchLook {
  words?: 'auto' | 'always' | 'never';
  symbolScale?: number;
  minSymbol?: number;
  compact?: boolean;
}

const SELECT_BLUE = '#2563eb';

/** The fixtures of sketch schema 2 drawn with a symbol in them (the till draws the same: TableVisuals.kt, drawSymbol). */
const SYMBOLS_V2: Partial<Record<SketchKind, true>> = {
  restroom: true, cashier: true, host: true, exit: true, door: true, kitchen: true, dj_booth: true, bar: true, stage: true,
};

/** Does a shape of this kind (and variant) carry a symbol? */
export function hasSymbol(kind: SketchKind, variant?: SketchVariant | null): boolean {
  return !!SYMBOLS_V2[kind] || iconKey(kind, variant) !== null;
}

/** The kinds drawn as what they are, with the dashed frame of a pick round them. */
const OWN_SHAPES: SketchKind[] = ['plant', 'sofa', 'stairs', 'tree', 'planter', 'green_wall', 'hedge', 'flowers', 'arrow'];

/** One sketch shape — drawn the same way by the till (ui/tables/TableVisuals.kt, drawSketch). */
export function SketchShape({
  el,
  perPx,
  selected = false,
  onDown,
  onResize,
  logoUrl = null,
  logoLabel = 'לוגו',
  look,
}: {
  el: SketchElement;
  perPx: number;
  /** The business's logo, for a "logo" shape with no picture of its own. */
  logoUrl?: string | null;
  /** What a logo with no picture says. */
  logoLabel?: string;
  selected?: boolean;
  onDown?: (e: React.PointerEvent) => void;
  onResize?: (e: React.PointerEvent) => void;
  look?: SketchLook;
}) {
  const words = look?.words ?? 'auto';
  const compact = look?.compact ?? false;
  const st = styleOf(el);
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  const long = Math.max(el.w, el.h);
  const short = Math.min(el.w, el.h);
  const handle = 12 * perPx;
  const dashedPick = (
    <rect x={el.x} y={el.y} width={el.w} height={el.h} fill="none" stroke={SELECT_BLUE} strokeWidth={1.5 * perPx} strokeDasharray={`${6 * perPx} ${4 * perPx}`} />
  );
  if (hasPoints(el.kind)) {
    // A drawn line, wall or stroke: its points, its colour and width — with a wider,
    // invisible line over it so a finger can pick it.
    const points = pointsAttr(el.points);
    return (
      <g onPointerDown={onDown} style={{ cursor: onDown ? 'move' : undefined }}>
        <polyline
          points={points}
          fill="none"
          stroke={el.color ?? st.stroke}
          strokeWidth={el.stroke ?? 3}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {onDown ? (
          <polyline points={points} fill="none" stroke="transparent" strokeWidth={(el.stroke ?? 3) + 16 * perPx} pointerEvents="stroke" />
        ) : null}
        {selected ? (
          <polyline points={points} fill="none" stroke={SELECT_BLUE} strokeWidth={1.5 * perPx} strokeDasharray={`${6 * perPx} ${4 * perPx}`} />
        ) : null}
      </g>
    );
  }
  if (el.kind === 'rect') {
    const color = el.color ?? st.stroke;
    return (
      <g transform={`rotate(${el.rotation} ${cx} ${cy})`} onPointerDown={onDown} style={{ cursor: onDown ? 'move' : undefined }}>
        <rect
          x={el.x} y={el.y} width={el.w} height={el.h}
          fill={el.filled ? color : 'none'}
          stroke={color}
          strokeWidth={el.stroke ?? 3}
          pointerEvents={onDown ? 'all' : undefined}
        />
        {selected ? dashedPick : null}
      </g>
    );
  }
  if (el.kind === 'area') {
    return <AreaShape el={el} perPx={perPx} selected={selected} onDown={onDown} onResize={onResize} />;
  }
  if (el.kind === 'label') {
    return <LabelShape el={el} perPx={perPx} selected={selected} onDown={onDown} onResize={onResize} compact={compact} words={words} />;
  }

  // The words: a symbol's name where it fits (`auto`; none on a small screen), always, or never.
  // A free text (an arrow's; a label's is LabelShape's) is the user's own: hidden only on a small screen in `auto`.
  const ownWords = el.kind === 'arrow';
  const showWords = ownWords ? !compact || words === 'always' : words === 'always' || (words === 'auto' && !compact);
  const text = showWords ? (el.text ?? defaultText(el)) : null;
  const symbol = hasSymbol(el.kind, el.variant);
  // A fixture with a symbol: the symbol, and the word under it, when both fit.
  let iconSize = symbol ? Math.min(short * 0.55, long * 0.4) * (look?.symbolScale ?? 1) : 0;
  if (symbol && compact) iconSize = Math.max(iconSize, look?.minSymbol ?? 0);
  const fs = text ? Math.max(9 * perPx, Math.min(short * 0.55, (long * 1.6) / Math.max(2, text.length))) : 0;
  const vertical = el.h > el.w * 1.6;
  // Stacked, the word is drawn smaller (at most a quarter of the short side): it is that size
  // that has to fit under the symbol — so a short word ("נשים", "כניסה") keeps its symbol too.
  const stackedFs = Math.min(fs, short * 0.24);
  let stacked = !!text && symbol && iconSize >= 14 * perPx && short >= iconSize + stackedFs * 0.9 * 1.3;
  let textFs = stacked ? stackedFs : fs;
  if (!stacked && !!text && symbol && words === 'always') {
    // "תמיד": the word under the symbol even where it does not quite fit.
    stacked = true;
    textFs = Math.max(stackedFs, 10 * perPx);
  }
  // No word (hidden, or none at all): the symbol alone, in the middle.
  const alone = symbol && !text;
  const iconCy = stacked ? cy - (iconSize + textFs * 1.25) / 2 + iconSize / 2 : cy;
  // On a small screen every symbol stands upright; on a large one a tall shape's turns with it.
  const iconTransform = compact
    ? el.rotation ? `rotate(${-el.rotation} ${cx} ${iconCy})` : undefined
    : vertical ? `rotate(-90 ${cx} ${cy})` : undefined;
  // A symbol grown past its shape (a small screen's least size) sits on a disc of the shape's colours.
  const disc = (stacked || alone) && compact && iconSize > short * 0.9;
  // An arrow's words sit on its shaft (ArrowShape's head is the rest), upright, white on it.
  const arrowHead = Math.min(el.w * 0.45, el.h * 1.1);
  const textX = el.kind === 'arrow' ? el.x + (el.w - arrowHead) / 2 : cx;
  const arrowFs = el.kind === 'arrow' && text ? Math.max(8 * perPx, Math.min(el.h * 0.36, ((el.w - arrowHead) * 1.5) / Math.max(2, text.length))) : 0;

  return (
    <g>
      <g transform={`rotate(${el.rotation} ${cx} ${cy})`} onPointerDown={onDown} style={{ cursor: onDown ? 'move' : undefined }}>
        {el.kind === 'logo' ? (
          <LogoShape el={el} perPx={perPx} selected={selected} src={logoPicture(el, logoUrl)} label={logoLabel} />
        ) : el.kind === 'counter' ? (
          <CounterShape el={el} perPx={perPx} selected={selected} />
        ) : el.kind === 'plant' ? (
          <PlantShape el={el} />
        ) : el.kind === 'tree' ? (
          <TreeShape el={el} />
        ) : el.kind === 'planter' ? (
          <PlanterShape el={el} perPx={perPx} />
        ) : el.kind === 'green_wall' ? (
          <GreenWallShape el={el} perPx={perPx} />
        ) : el.kind === 'hedge' ? (
          <HedgeShape el={el} perPx={perPx} />
        ) : el.kind === 'flowers' ? (
          <FlowersShape el={el} />
        ) : el.kind === 'arrow' ? (
          <ArrowShape el={el} perPx={perPx} />
        ) : el.kind === 'sofa' ? (
          <SofaShape el={el} perPx={perPx} />
        ) : el.kind === 'stairs' ? (
          <StairsShape el={el} perPx={perPx} />
        ) : st.round ? (
          <ellipse cx={cx} cy={cy} rx={el.w / 2} ry={el.h / 2} fill={st.fill} stroke={st.stroke} strokeWidth={2 * perPx} />
        ) : (
          <rect
            x={el.x} y={el.y} width={el.w} height={el.h}
            rx={el.kind === 'bar' || el.kind === 'dj_booth' ? Math.min(12, short / 3) : iconKey(el.kind) ? Math.min(10, short / 4) : 2}
            fill={st.fill}
            stroke={selected ? SELECT_BLUE : st.stroke}
            strokeWidth={(selected ? 3 : 1.5) * perPx}
            strokeDasharray={st.dashed ? `${8 * perPx} ${6 * perPx}` : undefined}
          />
        )}
        {selected && OWN_SHAPES.includes(el.kind) ? dashedPick : null}
        {disc ? (
          <circle cx={cx} cy={iconCy} r={iconSize * 0.62} fill={st.fill} stroke={st.stroke} strokeWidth={1.5 * perPx} />
        ) : null}
        {stacked || alone ? (
          // The symbol: above the word when there is room for both; alone when there is no word.
          <FixtureSymbol
            kind={el.kind}
            variant={el.variant ?? null}
            cx={cx}
            cy={iconCy}
            size={iconSize}
            color={st.stroke}
            bg={st.fill}
            transform={iconTransform}
          />
        ) : null}
        {text && (stacked || fs >= 6 * perPx) && el.kind !== 'counter' && el.kind !== 'sofa' ? (
          <text
            x={textX}
            y={stacked ? cy + (iconSize + textFs * 1.25) / 2 - textFs * 0.6 : cy}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={el.kind === 'arrow' ? arrowFs : textFs}
            fill={el.kind === 'arrow' ? '#ffffff' : st.text}
            stroke={el.kind === 'arrow' ? st.stroke : undefined}
            strokeWidth={el.kind === 'arrow' ? Math.max(perPx, arrowFs * 0.14) : undefined}
            paintOrder={el.kind === 'arrow' ? 'stroke' : undefined}
            fontWeight={el.kind === 'arrow' ? 700 : undefined}
            // An arrow points any way; its words stay upright.
            transform={
              el.kind === 'arrow'
                ? el.rotation ? `rotate(${-el.rotation} ${textX} ${cy})` : undefined
                : compact && el.rotation
                  ? `rotate(${-el.rotation} ${cx} ${cy})`
                  : vertical ? `rotate(-90 ${cx} ${cy})` : undefined
            }
          >
            {text}
          </text>
        ) : null}
      </g>
      {selected && onResize ? (
        <rect
          x={el.x + el.w - handle / 2}
          y={el.y + el.h - handle / 2}
          width={handle}
          height={handle}
          fill={SELECT_BLUE}
          style={{ cursor: 'nwse-resize' }}
          onPointerDown={onResize}
        />
      ) : null}
    </g>
  );
}

// ── The symbols ───────────────────────────────────────────────────────────────

/** A figure of the WC sign: a head and a body — a dress for `dress`. */
function Figure({ cx, cy, size, color, dress }: { cx: number; cy: number; size: number; color: string; dress: boolean }) {
  const top = cy - size * 0.12;
  const bottom = cy + size * 0.48;
  const body = dress
    ? `M ${cx - size * 0.12} ${top} L ${cx + size * 0.12} ${top} L ${cx + size * 0.28} ${bottom} L ${cx - size * 0.28} ${bottom} Z`
    : `M ${cx - size * 0.2} ${top} L ${cx + size * 0.2} ${top} L ${cx + size * 0.17} ${bottom} L ${cx - size * 0.17} ${bottom} Z`;
  return (
    <g fill={color}>
      <circle cx={cx} cy={cy - size * 0.32} r={size * 0.16} />
      <path d={body} />
    </g>
  );
}

/**
 * A shape's symbol, `size` across, centred on (cx, cy): the line icons of schema 3
 * (lib/sketchSymbols.ts, on their 100-unit grid), and the drawings of schema 2.
 */
export function FixtureSymbol({
  kind,
  variant = null,
  cx,
  cy,
  size,
  color,
  bg = '#ffffff',
  transform,
}: {
  kind: SketchKind;
  variant?: SketchVariant | null;
  cx: number;
  cy: number;
  size: number;
  color: string;
  /** The shape's own fill: what an icon's `bg` part is filled with. */
  bg?: string;
  transform?: string;
}) {
  const s = size;
  const line = { stroke: color, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' };
  const key = iconKey(kind, variant);
  if (key) {
    return (
      <g transform={transform} pointerEvents="none">
        <g transform={`translate(${cx} ${cy}) scale(${s / 100})`} strokeLinecap="round" strokeLinejoin="round">
          {SYMBOL_ICONS[key].map((p, i) => (
            <path
              key={i}
              d={p.d}
              fill={p.fill ? color : p.bg ? bg : 'none'}
              stroke={p.fill ? 'none' : color}
              strokeWidth={p.fill ? undefined : (p.width ?? ICON_STROKE)}
            />
          ))}
        </g>
      </g>
    );
  }
  return (
    <g transform={transform} pointerEvents="none">
      {kind === 'restroom' && variant === 'men' ? (
        <Figure cx={cx} cy={cy} size={s * 0.85} color={color} dress={false} />
      ) : kind === 'restroom' && variant === 'women' ? (
        <Figure cx={cx} cy={cy} size={s * 0.85} color={color} dress />
      ) : kind === 'restroom' && variant === 'accessible' ? (
        // The wheelchair sign: a head, the seated body, the wheel.
        <g>
          <circle cx={cx - s * 0.04} cy={cy - s * 0.36} r={s * 0.09} fill={color} />
          <path
            d={`M ${cx - s * 0.06} ${cy - s * 0.22} L ${cx - s * 0.06} ${cy + s * 0.02} L ${cx + s * 0.2} ${cy + s * 0.02} L ${cx + s * 0.3} ${cy + s * 0.3}`}
            {...line} strokeWidth={s * 0.08}
          />
          <circle cx={cx - s * 0.08} cy={cy + s * 0.16} r={s * 0.24} {...line} strokeWidth={s * 0.08} />
        </g>
      ) : kind === 'door' ? (
        // The entrance: an arrow in, through the door's frame.
        <g>
          <path
            d={`M ${cx - s * 0.4} ${cy} L ${cx + s * 0.12} ${cy} M ${cx - s * 0.08} ${cy - s * 0.2} L ${cx + s * 0.12} ${cy} L ${cx - s * 0.08} ${cy + s * 0.2}`}
            {...line} strokeWidth={s * 0.08}
          />
          <rect x={cx + s * 0.2} y={cy - s * 0.38} width={s * 0.2} height={s * 0.76} rx={s * 0.03} {...line} strokeWidth={s * 0.064} />
        </g>
      ) : kind === 'kitchen' ? (
        // A pot: its lid and knob, its body, its handles.
        <g>
          <circle cx={cx} cy={cy - s * 0.26} r={s * 0.06} fill={color} />
          <path
            d={`M ${cx - s * 0.36} ${cy - s * 0.15} L ${cx + s * 0.36} ${cy - s * 0.15} M ${cx - s * 0.42} ${cy + s * 0.02} L ${cx + s * 0.42} ${cy + s * 0.02}`}
            {...line} strokeWidth={s * 0.07}
          />
          <rect x={cx - s * 0.3} y={cy - s * 0.08} width={s * 0.6} height={s * 0.42} rx={s * 0.08} fill={color} />
        </g>
      ) : kind === 'dj_booth' ? (
        // A record on the deck, and the tone arm across it.
        <g>
          <circle cx={cx - s * 0.06} cy={cy + s * 0.04} r={s * 0.34} {...line} strokeWidth={s * 0.07} />
          <circle cx={cx - s * 0.06} cy={cy + s * 0.04} r={s * 0.2} {...line} strokeWidth={s * 0.035} />
          <circle cx={cx - s * 0.06} cy={cy + s * 0.04} r={s * 0.07} fill={color} />
          <path d={`M ${cx + s * 0.38} ${cy - s * 0.38} L ${cx + s * 0.38} ${cy - s * 0.02} L ${cx + s * 0.14} ${cy + s * 0.14}`} {...line} strokeWidth={s * 0.07} />
        </g>
      ) : kind === 'bar' ? (
        // A cocktail glass.
        <g>
          <path d={`M ${cx - s * 0.3} ${cy - s * 0.34} L ${cx + s * 0.3} ${cy - s * 0.34} L ${cx} ${cy + s * 0.02} Z`} fill={color} />
          <path d={`M ${cx} ${cy} L ${cx} ${cy + s * 0.32} M ${cx - s * 0.16} ${cy + s * 0.34} L ${cx + s * 0.16} ${cy + s * 0.34}`} {...line} strokeWidth={s * 0.07} />
        </g>
      ) : kind === 'stage' ? (
        // A microphone on its stand.
        <g>
          <rect x={cx - s * 0.11} y={cy - s * 0.4} width={s * 0.22} height={s * 0.34} rx={s * 0.11} fill={color} />
          <path
            d={`M ${cx - s * 0.2} ${cy - s * 0.16} A ${s * 0.2} ${s * 0.22} 0 0 0 ${cx + s * 0.2} ${cy - s * 0.16} M ${cx} ${cy + s * 0.06} L ${cx} ${cy + s * 0.34} M ${cx - s * 0.16} ${cy + s * 0.36} L ${cx + s * 0.16} ${cy + s * 0.36}`}
            {...line} strokeWidth={s * 0.07}
          />
        </g>
      ) : kind === 'restroom' ? (
        <>
          <Figure cx={cx - size * 0.28} cy={cy} size={size * 0.62} color={color} dress={false} />
          <line x1={cx} y1={cy - size * 0.32} x2={cx} y2={cy + size * 0.32} stroke={color} strokeOpacity={0.5} strokeWidth={size * 0.04} />
          <Figure cx={cx + size * 0.28} cy={cy} size={size * 0.62} color={color} dress />
        </>
      ) : kind === 'host' ? (
        <Figure cx={cx} cy={cy} size={size * 0.8} color={color} dress />
      ) : kind === 'cashier' ? (
        <g fill={color}>
          <rect x={cx - size * 0.22} y={cy - size * 0.4} width={size * 0.44} height={size * 0.26} rx={size * 0.05} />
          <rect x={cx - size * 0.04} y={cy - size * 0.14} width={size * 0.08} height={size * 0.12} />
          <rect x={cx - size * 0.4} y={cy - size * 0.02} width={size * 0.8} height={size * 0.38} rx={size * 0.06} />
        </g>
      ) : kind === 'exit' ? (
        <path
          d={`M ${cx - size * 0.36} ${cy} L ${cx + size * 0.3} ${cy} M ${cx + size * 0.08} ${cy - size * 0.22} L ${cx + size * 0.3} ${cy} L ${cx + size * 0.08} ${cy + size * 0.22}`}
          fill="none" stroke={color} strokeWidth={size * 0.08} strokeLinecap="round" strokeLinejoin="round"
        />
      ) : null}
    </g>
  );
}

// ── Shapes drawn as what they are ─────────────────────────────────────────────

/** A bar counter, straight, L or U, with its numbered stools in front (as the till draws it). */
function CounterShape({ el, perPx, selected }: { el: SketchElement; perPx: number; selected: boolean }) {
  const st = SKETCH_STYLE.counter;
  const { bars, stools } = counterGeometry(el);
  return (
    <g>
      {bars.map((b, i) => (
        <rect
          key={`b${i}`}
          x={b.x} y={b.y} width={b.w} height={b.h} rx={6 * perPx}
          fill={st.fill}
          stroke={selected ? SELECT_BLUE : st.stroke}
          strokeWidth={(selected ? 3 : 1.5) * perPx}
          filter="url(#table-shadow)"
        />
      ))}
      {stools.map((s, i) => (
        <g key={`s${i}`}>
          <circle cx={s.cx} cy={s.cy} r={s.r} fill={TABLE_LOOK.fill} stroke={TABLE_LOOK.border} strokeWidth={1.5 * perPx} filter="url(#table-shadow)" />
          {s.r > 7 * perPx ? (
            <text x={s.cx} y={s.cy} textAnchor="middle" dominantBaseline="central" fontSize={s.r} fill={st.text} fontWeight={600}>
              {i + 1}
            </text>
          ) : null}
        </g>
      ))}
    </g>
  );
}

/** The greens of a plant's leaves: its own colour's shades when it has one. */
function leafTones(own: string | null | undefined): { dark: string; mid: string; light: string; heart: string } {
  if (own && /^#[0-9a-fA-F]{6}$/.test(own)) {
    return { dark: mix(own, '#000000', 0.15), mid: mix(own, '#ffffff', 0.3), light: mix(own, '#ffffff', 0.55), heart: mix(own, '#000000', 0.5) };
  }
  return { dark: '#2f9e44', mid: '#51cf66', light: '#8ce99a', heart: '#1b5e20' };
}

/** A plant from above: a rosette of leaves round a dark heart — fuller when large, sparer when small. */
function PlantShape({ el }: { el: SketchElement }) {
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  const r = Math.min(el.w, el.h) / 2;
  const tone = leafTones(el.color);
  const ring = (count: number, reach: number, fill: string, turn: number) =>
    Array.from({ length: count }, (_, i) => (
      <ellipse
        key={`${count}-${reach}-${i}`}
        cx={cx} cy={cy - r * reach * 0.52} rx={r * 0.2 * reach} ry={r * 0.475 * reach}
        fill={fill} transform={`rotate(${(i * 360) / count + turn} ${cx} ${cy})`}
      />
    ));
  return (
    <g>
      <circle cx={cx} cy={cy + r * 0.08} r={r * 0.95} fill="#000" opacity={0.2} />
      {el.variant === 'large' ? (
        <>
          {ring(11, 1, tone.dark, 0)}
          {ring(8, 0.72, tone.mid, 22)}
          {ring(5, 0.44, tone.light, 0)}
        </>
      ) : el.variant === 'small' ? (
        <>
          {ring(6, 1, tone.dark, 0)}
          {ring(4, 0.6, tone.mid, 45)}
        </>
      ) : (
        <>
          {ring(8, 1, tone.dark, 0)}
          {ring(6, 0.68, tone.mid, 30)}
        </>
      )}
      <circle cx={cx} cy={cy} r={r * 0.16} fill={tone.heart} />
    </g>
  );
}

/** A tree from above: a round canopy of lobes, lit on one side. */
function TreeShape({ el }: { el: SketchElement }) {
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  const r = Math.min(el.w, el.h) / 2;
  const tone = leafTones(el.color);
  const at = (deg: number, d: number) => ({ x: cx + Math.cos((deg * Math.PI) / 180) * d, y: cy + Math.sin((deg * Math.PI) / 180) * d });
  return (
    <g>
      <circle cx={cx + r * 0.06} cy={cy + r * 0.1} r={r * 0.96} fill="#000" opacity={0.18} />
      {Array.from({ length: 8 }, (_, i) => {
        const p = at(i * 45, r * 0.56);
        return <circle key={`l${i}`} cx={p.x} cy={p.y} r={r * 0.42} fill={tone.dark} />;
      })}
      <circle cx={cx} cy={cy} r={r * 0.62} fill={tone.dark} />
      {Array.from({ length: 5 }, (_, i) => {
        const p = at(i * 72 - 110, r * 0.36);
        return <circle key={`h${i}`} cx={p.x} cy={p.y} r={r * 0.24} fill={tone.mid} />;
      })}
      <circle cx={cx - r * 0.18} cy={cy - r * 0.2} r={r * 0.16} fill={tone.light} />
    </g>
  );
}

/** Along a stretched shape: (t along its length, s across it) as a point, and whether it lies across. */
function along(el: SketchElement) {
  const flat = el.w >= el.h;
  const length = flat ? el.w : el.h;
  const width = flat ? el.h : el.w;
  const at = (t: number, s: number) => (flat ? { x: el.x + t, y: el.y + s } : { x: el.x + s, y: el.y + t });
  return { flat, length, width, at, turn: flat ? 0 : 90 };
}

/** A planter: a terracotta trough with leaves along it. */
function PlanterShape({ el, perPx }: { el: SketchElement; perPx: number }) {
  const { length, width, at, turn } = along(el);
  const tone = leafTones(el.color);
  const n = Math.max(1, Math.floor(length / (width * 0.9)));
  const inset = width * 0.16;
  return (
    <g>
      <rect x={el.x} y={el.y} width={el.w} height={el.h} rx={width * 0.25} fill="#c08457" stroke="#8b5a2b" strokeWidth={1.5 * perPx} />
      <rect x={el.x + inset} y={el.y + inset} width={el.w - 2 * inset} height={el.h - 2 * inset} rx={width * 0.15} fill="#6b4f3a" />
      {Array.from({ length: n }, (_, i) => {
        const c = at(((i + 0.5) * length) / n, width / 2);
        return (
          <g key={i}>
            {[-40, 40, 0].map((a, k) => (
              <ellipse
                key={a}
                cx={c.x} cy={c.y - width * 0.12} rx={width * 0.16} ry={width * 0.34}
                fill={k === 2 ? tone.mid : tone.dark}
                transform={`rotate(${a + turn} ${c.x} ${c.y})`}
              />
            ))}
          </g>
        );
      })}
    </g>
  );
}

/** A green wall: a wall covered in leaves. */
function GreenWallShape({ el, perPx }: { el: SketchElement; perPx: number }) {
  const { length, width, at, turn } = along(el);
  const tone = leafTones(el.color);
  const n = Math.max(2, Math.floor(length / (width * 0.6)));
  return (
    <g>
      <rect x={el.x} y={el.y} width={el.w} height={el.h} rx={Math.min(4, width / 4)} fill={tone.dark} stroke={tone.heart} strokeWidth={1.2 * perPx} />
      {Array.from({ length: n }, (_, i) =>
        [0.3, 0.7].map((row, k) => {
          const c = at(((i + 0.5 + (k ? 0.5 : 0)) * length) / (n + 0.5), width * row);
          return (
            <ellipse
              key={`${i}-${k}`}
              cx={c.x} cy={c.y} rx={width * 0.16} ry={width * 0.3}
              fill={(i + k) % 2 ? tone.mid : tone.light}
              transform={`rotate(${(i + k) % 2 ? 35 + turn : -35 + turn} ${c.x} ${c.y})`}
            />
          );
        }),
      )}
    </g>
  );
}

/** A hedge from above: a row of shrubs, lit on one side. */
function HedgeShape({ el, perPx }: { el: SketchElement; perPx: number }) {
  const { length, width, at } = along(el);
  const tone = leafTones(el.color);
  const n = Math.max(1, Math.ceil(length / (width * 0.8)));
  const r = Math.min(width * 0.56, length / (2 * n) + width * 0.12);
  const centres = Array.from({ length: n }, (_, i) => at(((i + 0.5) * length) / n, width / 2));
  return (
    <g>
      {centres.map((c, i) => (
        <circle key={`b${i}`} cx={c.x} cy={c.y} r={r} fill={tone.dark} stroke={tone.heart} strokeWidth={perPx} />
      ))}
      {centres.map((c, i) => (
        <circle key={`h${i}`} cx={c.x - r * 0.22} cy={c.y - r * 0.24} r={r * 0.5} fill={tone.mid} />
      ))}
    </g>
  );
}

/** Flowers: five petals round a yellow heart — a row of them on a long bed. */
function FlowersShape({ el }: { el: SketchElement }) {
  const { length, width, at } = along(el);
  const petal = el.color && /^#[0-9a-fA-F]{6}$/.test(el.color) ? el.color : SKETCH_STYLE.flowers.fill;
  const n = Math.max(1, Math.floor(length / width + 0.4));
  const r = Math.min(width, length / n) / 2;
  return (
    <g>
      {Array.from({ length: n }, (_, i) => {
        const c = at(((i + 0.5) * length) / n, width / 2);
        return (
          <g key={i}>
            <ellipse cx={c.x + r * 0.42} cy={c.y + r * 0.5} rx={r * 0.22} ry={r * 0.48} fill="#2f9e44" transform={`rotate(-45 ${c.x + r * 0.42} ${c.y + r * 0.5})`} />
            {Array.from({ length: 5 }, (_, k) => (
              <ellipse
                key={k}
                cx={c.x} cy={c.y - r * 0.46} rx={r * 0.3} ry={r * 0.46}
                fill={petal} stroke={mix(petal, '#000000', 0.25)} strokeWidth={r * 0.04}
                transform={`rotate(${k * 72} ${c.x} ${c.y})`}
              />
            ))}
            <circle cx={c.x} cy={c.y} r={r * 0.24} fill="#facc15" stroke="#ca8a04" strokeWidth={r * 0.04} />
          </g>
        );
      })}
    </g>
  );
}

/** A direction arrow across its box, pointing along its length (its rotation turns it any way). */
function ArrowShape({ el, perPx }: { el: SketchElement; perPx: number }) {
  const st = styleOf(el);
  const shaft = el.h * 0.42;
  const head = Math.min(el.w * 0.45, el.h * 1.1);
  const cy = el.y + el.h / 2;
  const x1 = el.x + el.w - head;
  const d =
    `M ${el.x} ${cy - shaft / 2} L ${x1} ${cy - shaft / 2} L ${x1} ${el.y} L ${el.x + el.w} ${cy} ` +
    `L ${x1} ${el.y + el.h} L ${x1} ${cy + shaft / 2} L ${el.x} ${cy + shaft / 2} Z`;
  return (
    <g>
      <path d={d} fill="#000" opacity={0.15} transform={`translate(${perPx * 1.5} ${perPx * 2.5})`} />
      <path d={d} fill={st.fill} stroke={st.stroke} strokeWidth={1.5 * perPx} strokeLinejoin="round" />
    </g>
  );
}

/**
 * A coloured area ("אזור"): a rectangle or a polygon in its fill, half seen through, its edge dashed
 * in the same colour, its name in the middle — under everything else (lib/tableSketch.ts drawOrder).
 */
function AreaShape({
  el,
  perPx,
  selected,
  onDown,
  onResize,
}: {
  el: SketchElement;
  perPx: number;
  selected: boolean;
  onDown?: (e: React.PointerEvent) => void;
  onResize?: (e: React.PointerEvent) => void;
}) {
  const fill = el.fill && /^#[0-9a-fA-F]{6}$/.test(el.fill) ? el.fill : AREA_FILL_DEFAULT;
  const opacity = clampOpacity(el.opacity ?? AREA_OPACITY.default) / 100;
  const polygon = isPolygonArea(el);
  const corners = areaCorners(el);
  const centre = polygon ? polygonCentroid(corners) : { x: el.x + el.w / 2, y: el.y + el.h / 2 };
  const name = (el.text ?? '').trim();
  // A name, not a poster: about a label's size, smaller in a small area, never past its width.
  const fs = name ? Math.max(11 * perPx, Math.min(Math.min(el.w, el.h) * 0.12, (el.w * 0.9) / Math.max(2, name.length), 34 * Math.max(1, perPx))) : 0;
  const ink = el.color && /^#[0-9a-fA-F]{6}$/.test(el.color) ? el.color : mix(fill, '#000000', 0.5);
  const handle = 12 * perPx;
  const outline = {
    fill,
    fillOpacity: opacity,
    stroke: selected ? SELECT_BLUE : fill,
    strokeOpacity: selected ? 1 : 0.85,
    strokeWidth: (selected ? 2.5 : 2) * perPx,
    strokeDasharray: `${10 * perPx} ${6 * perPx}`,
  };
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  return (
    <g>
      <g
        transform={polygon || !el.rotation ? undefined : `rotate(${el.rotation} ${cx} ${cy})`}
        onPointerDown={onDown}
        style={{ cursor: onDown ? 'move' : undefined }}
      >
        {polygon ? (
          <polygon points={corners.map((p) => `${p.x},${p.y}`).join(' ')} {...outline} strokeLinejoin="round" />
        ) : (
          <rect x={el.x} y={el.y} width={el.w} height={el.h} rx={Math.min(16, Math.min(el.w, el.h) * 0.08)} {...outline} />
        )}
        {name ? (
          <text
            x={centre.x} y={centre.y}
            textAnchor="middle" dominantBaseline="central"
            fontSize={fs} fontWeight={700} fill={ink}
            stroke="#ffffff" strokeOpacity={0.7} strokeWidth={fs * 0.14} paintOrder="stroke"
            pointerEvents="none"
          >
            {name}
          </text>
        ) : null}
      </g>
      {selected && onResize ? (
        <rect
          x={el.x + el.w - handle / 2} y={el.y + el.h - handle / 2} width={handle} height={handle}
          fill={SELECT_BLUE} style={{ cursor: 'nwse-resize' }} onPointerDown={onResize}
        />
      ) : null}
    </g>
  );
}

/**
 * The business's logo on the floor: its picture fitted whole in the box (the till draws
 * the same); with no picture, a dashed box saying where it goes.
 */
function LogoShape({ el, perPx, selected, src, label }: { el: SketchElement; perPx: number; selected: boolean; src: string | null; label: string }) {
  // §8: how opaque, and stretched to its box or fitted with its proportions kept.
  const opacity = logoOpacity(el);
  if (!src) {
    return (
      <g opacity={opacity}>
        <rect
          x={el.x} y={el.y} width={el.w} height={el.h} rx={6 * perPx}
          fill="#ffffff" fillOpacity={0.6}
          stroke={selected ? SELECT_BLUE : SKETCH_STYLE.logo.stroke}
          strokeWidth={(selected ? 3 : 1.5) * perPx}
          strokeDasharray={`${8 * perPx} ${6 * perPx}`}
        />
        <text
          x={el.x + el.w / 2} y={el.y + el.h / 2}
          textAnchor="middle" dominantBaseline="central"
          fontSize={Math.max(10 * perPx, Math.min(el.h * 0.3, el.w * 0.18))}
          fill={SKETCH_STYLE.logo.text}
        >
          {label}
        </text>
      </g>
    );
  }
  return (
    <g>
      <image
        href={src}
        x={el.x}
        y={el.y}
        width={el.w}
        height={el.h}
        opacity={opacity}
        preserveAspectRatio={el.keepAspect === false ? 'none' : 'xMidYMid meet'}
      />
      {selected ? (
        <rect x={el.x} y={el.y} width={el.w} height={el.h} fill="none" stroke={SELECT_BLUE} strokeWidth={1.5 * perPx} strokeDasharray={`${6 * perPx} ${4 * perPx}`} />
      ) : (
        // An invisible box over it, so the whole logo picks up the pointer.
        <rect x={el.x} y={el.y} width={el.w} height={el.h} fill="transparent" />
      )}
    </g>
  );
}

/**
 * A text ("טקסט", §8): its lines at its own size (else fitted to its box), bold or not, in its colour,
 * on a chip of its own when it has one, aligned in its box. It turns with its box at any angle — on a
 * small screen it stands upright, and in `auto` it is not drawn there at all (v3 §3).
 */
function LabelShape({
  el,
  perPx,
  selected,
  onDown,
  onResize,
  compact,
  words,
}: {
  el: SketchElement;
  perPx: number;
  selected: boolean;
  onDown?: (e: React.PointerEvent) => void;
  onResize?: (e: React.PointerEvent) => void;
  compact: boolean;
  words: 'auto' | 'always' | 'never';
}) {
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  const handle = 12 * perPx;
  const text = !compact || words === 'always' ? (el.text ?? defaultText(el)) : null;
  const layout = labelLayout(el, text, 9 * perPx);
  const chip = labelChip(el);
  // An RTL text: its start is the box's right edge.
  const anchor = layout.anchor === 'start' ? 'end' : layout.anchor === 'end' ? 'start' : 'middle';
  const turn = !compact && el.rotation ? `rotate(${el.rotation} ${cx} ${cy})` : undefined;
  return (
    <g>
      <g transform={turn} onPointerDown={onDown} style={{ cursor: onDown ? 'move' : undefined }}>
        {chip ? (
          <rect x={el.x} y={el.y} width={el.w} height={el.h} rx={Math.min(el.h * 0.3, 14 * perPx)} fill={chip.fill} fillOpacity={chip.opacity} />
        ) : null}
        <rect x={el.x} y={el.y} width={el.w} height={el.h} fill="transparent" stroke={selected ? SELECT_BLUE : 'none'} strokeDasharray="4 4" />
        {text ? (
          <text
            direction="rtl"
            textAnchor={anchor}
            fontSize={layout.fontSize}
            fontWeight={el.bold ? 700 : 400}
            fill={el.color ?? SKETCH_STYLE.label.text}
          >
            {layout.lines.map((line, i) => (
              <tspan key={i} x={layout.x} y={line.y} dominantBaseline="central">
                {line.text || '\u00a0'}
              </tspan>
            ))}
          </text>
        ) : null}
      </g>
      {selected && onResize ? (
        <rect
          x={el.x + el.w - handle / 2}
          y={el.y + el.h - handle / 2}
          width={handle}
          height={handle}
          fill={SELECT_BLUE}
          style={{ cursor: 'nwse-resize' }}
          onPointerDown={onResize}
        />
      ) : null}
    </g>
  );
}

/** A sofa from above: its back along the top, arms at the ends, the seat in cushions. */
function SofaShape({ el, perPx }: { el: SketchElement; perPx: number }) {
  const st = SKETCH_STYLE.sofa;
  const r = Math.min(el.w, el.h) * 0.18;
  const back = el.h * 0.3;
  const arm = Math.min(el.w * 0.12, el.h * 0.35);
  const seats = Math.max(1, Math.floor((el.w - 2 * arm) / (el.h * 0.9)));
  const each = (el.w - 2 * arm) / seats;
  return (
    <g>
      <rect x={el.x} y={el.y} width={el.w} height={el.h} rx={r} fill={st.fill} filter="url(#table-shadow)" />
      <rect x={el.x} y={el.y} width={el.w} height={back} rx={r} fill={st.stroke} opacity={0.55} />
      <rect x={el.x} y={el.y} width={arm} height={el.h} rx={r} fill={st.stroke} opacity={0.45} />
      <rect x={el.x + el.w - arm} y={el.y} width={arm} height={el.h} rx={r} fill={st.stroke} opacity={0.45} />
      {Array.from({ length: seats - 1 }, (_, i) => (
        <line
          key={i}
          x1={el.x + arm + each * (i + 1)} y1={el.y + back} x2={el.x + arm + each * (i + 1)} y2={el.y + el.h * 0.94}
          stroke={st.stroke} strokeOpacity={0.6} strokeWidth={1.5 * perPx}
        />
      ))}
      <rect x={el.x} y={el.y} width={el.w} height={el.h} rx={r} fill="none" stroke={st.stroke} strokeWidth={1.5 * perPx} />
    </g>
  );
}

/** Stairs from above: the treads across the run. */
function StairsShape({ el, perPx }: { el: SketchElement; perPx: number }) {
  const st = SKETCH_STYLE.stairs;
  const vertical = el.h >= el.w;
  const run = vertical ? el.h : el.w;
  const step = Math.max(6, Math.min(el.w, el.h) * 0.32);
  const treads: number[] = [];
  for (let t = step; t < run - 2; t += step) treads.push(t);
  return (
    <g>
      <rect x={el.x} y={el.y} width={el.w} height={el.h} fill={st.fill} stroke={st.stroke} strokeWidth={1.6 * perPx} />
      {treads.map((t) =>
        vertical ? (
          <line key={t} x1={el.x} y1={el.y + t} x2={el.x + el.w} y2={el.y + t} stroke={st.stroke} strokeWidth={1.4 * perPx} />
        ) : (
          <line key={t} x1={el.x + t} y1={el.y} x2={el.x + t} y2={el.y + el.h} stroke={st.stroke} strokeWidth={1.4 * perPx} />
        ),
      )}
    </g>
  );
}

/** A drawn shape's points as an SVG `points` attribute. */
function pointsAttr(points: number[] | null | undefined): string {
  const out: string[] = [];
  if (points) for (let i = 0; i + 1 < points.length; i += 2) out.push(`${points[i]},${points[i + 1]}`);
  return out.join(' ');
}

// ── The floor ─────────────────────────────────────────────────────────────────

/**
 * The floor patterns, in canvas units (the till draws the same planks and tiles): wood
 * planks with a seam at each plank, staggered end joints and a little grain; stone tiles.
 */
export function FloorDefs() {
  const { plank, length, tones, seam, grain } = WOOD;
  const columns = tones.length;
  const width = plank * columns;
  const height = length * 2;
  return (
    <defs>
      <pattern id="floor-wood" patternUnits="userSpaceOnUse" width={width} height={height}>
        {Array.from({ length: columns }, (_, i) => {
          const offset = (((i * 37) % 100) / 100) * length;
          const x = i * plank;
          return (
            <g key={i}>
              {[-1, 0, 1, 2].map((j) => {
                const y = j * length - offset;
                return (
                  <g key={j}>
                    <rect x={x} y={y} width={plank} height={length} fill={tones[(i * 3 + j + 4) % tones.length]} />
                    {[0, 1, 2].map((g) => (
                      <line
                        key={g}
                        x1={x + plank * (0.2 + 0.28 * g)}
                        y1={y + length * 0.06}
                        x2={x + plank * (0.25 + 0.28 * g)}
                        y2={y + length * 0.94}
                        stroke={grain}
                        strokeWidth={1.2}
                        opacity={0.55}
                      />
                    ))}
                    <line x1={x} y1={y} x2={x + plank} y2={y} stroke={seam} strokeWidth={1.4} />
                  </g>
                );
              })}
              <line x1={x} y1={0} x2={x} y2={height} stroke={seam} strokeWidth={1.4} />
            </g>
          );
        })}
      </pattern>
      <pattern id="floor-clean" patternUnits="userSpaceOnUse" width={CLEAN.step} height={CLEAN.step}>
        <rect width={CLEAN.step} height={CLEAN.step} fill={CLEAN.fill} />
        <path d={`M ${CLEAN.step} 0 L 0 0 0 ${CLEAN.step}`} fill="none" stroke={CLEAN.grid} strokeWidth={1} />
      </pattern>
      <pattern id="floor-tiles" patternUnits="userSpaceOnUse" width={TILE.size} height={TILE.size}>
        <rect width={TILE.size} height={TILE.size} fill={TILE.fill} />
        <path d={`M ${TILE.size} 0 L 0 0 0 ${TILE.size}`} fill="none" stroke={TILE.grout} strokeWidth={2} />
      </pattern>
      <filter id="table-shadow" x="-30%" y="-30%" width="160%" height="160%">
        <feDropShadow dx="0" dy="3" stdDeviation="4" floodColor="#000" floodOpacity="0.22" />
      </filter>
      <filter id="gold-glow" x="-50%" y="-50%" width="200%" height="200%">
        <feGaussianBlur stdDeviation="6" />
      </filter>
    </defs>
  );
}

// ── The palette's and the legend's icons ──────────────────────────────────────

/** The box a kind is drawn in on its 100-unit icon (long shapes long, the rest square). */
const ICON_BOX: Partial<Record<SketchKind, [number, number]>> = {
  wall: [96, 20],
  window: [96, 14],
  column: [52, 52],
  stairs: [60, 94],
  bar: [96, 64],
  counter: [96, 70],
  door: [96, 72],
  exit: [96, 72],
  sofa: [96, 50],
  arrow: [96, 50],
  planter: [96, 36],
  green_wall: [96, 30],
  hedge: [96, 40],
  logo: [96, 60],
  label: [96, 50],
  tv: [96, 64],
  delivery_exit: [96, 72],
};

/** A kind (with its variant) drawn small — the palette's buttons, the legend's lines. */
export function KindIcon({
  kind,
  variant = null,
  size = 22,
  fill,
}: {
  kind: SketchKind;
  variant?: SketchVariant | null;
  size?: number;
  /** An area's fill (the legend's area in its own colour). */
  fill?: string | null;
}) {
  const id = useId();
  const [w, h] = ICON_BOX[kind] ?? [92, 92];
  const el: SketchElement = {
    id,
    kind,
    variant,
    x: (100 - w) / 2,
    y: (100 - h) / 2,
    w,
    h,
    rotation: 0,
    text: kind === 'label' ? 'אב' : kind === 'area' ? '' : null,
    stools: kind === 'counter' ? 3 : 0,
    ...(kind === 'area' ? { fill: fill ?? AREA_FILL_DEFAULT, opacity: 45 } : {}),
  };
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} aria-hidden className="shrink-0">
      <SketchShape el={el} perPx={2.4} look={{ words: kind === 'label' ? 'auto' : 'never' }} logoLabel="LOGO" />
    </svg>
  );
}
