'use client';

/**
 * "תצוגה בקופה" (P:/specs/table-map-decor-v3.md §3, §4): how a zone's map will look on the till — a
 * landscape tablet, a portrait one or a handheld — drawn with the dashboard's own shapes
 * (./sketch-shapes.tsx), fitted and stretched as the till fits its map (lib/tableSketch.ts
 * `fitMapView`, `onView`: the till's DecorFit.kt), and shown as the till's parameters would show it:
 * `mapDecor`, `mapSymbolLabels`, `mapSymbolScale`, `mapLegend`. On a small screen (a handheld, a
 * phone) no words are drawn by default, every symbol is at least 18 dp and upright, and the legend
 * opens as a sheet.
 *
 * Two ways in: `TillPreview` (the map editor's "תצוגה בקופה": the display chosen here, to try it
 * out) and `DeviceFloor` (the till design's "שולחנות ומפה", P:/specs/till-design-tables.md: the display
 * and the tables' look as the level sets them, the tables in every state — lib/tableTileLook.ts — and
 * a zone of squares drawn as the till's grid). Both draw what is on the editor now, saved or not.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { BookOpen, X } from 'lucide-react';
import {
  CHAIR_LOOK,
  CHAIR_REACH,
  CLEAN,
  DECOR_MIN_ICON_DP,
  MAP_DISPLAY_DEFAULTS,
  MAP_SYMBOL_SCALE,
  PLAIN,
  PREVIEW_DEVICES,
  TABLE_LOOK,
  chairLayout,
  decorExtent,
  drawOrder,
  fitMapView,
  isCompactScreen,
  legendEntries,
  onView,
  visibleElements,
  type MapDecorMode,
  type MapLabelsMode,
  type MapLegendMode,
  type PreviewDevice,
  type SketchBackground,
  type SketchElement,
} from '@/lib/tableSketch';
import {
  TABLE_STATES,
  sampleState,
  sampleTable,
  stateWord,
  tileColors,
  tileInfoLines,
  type TableState,
  type TileLook,
} from '@/lib/tableTileLook';
import { Button } from '@/components/ui/button';
import { FloorDefs, KindIcon, SketchShape, type SketchLook } from './sketch-shapes';

const SELECT =
  'border-input bg-background h-8 rounded-md border px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export interface PreviewTable {
  id: string;
  number: number;
  shape: 'round' | 'square' | 'rect';
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  /** Its chairs (none: four). */
  seats?: number;
}

/** The till's map display parameters (table_map_display.py). */
export interface MapDisplayValues {
  decor: MapDecorMode;
  labels: MapLabelsMode;
  scale: number;
  legend: MapLegendMode;
}

export const MAP_DISPLAY_INITIAL: MapDisplayValues = {
  decor: MAP_DISPLAY_DEFAULTS.mapDecor,
  labels: MAP_DISPLAY_DEFAULTS.mapSymbolLabels,
  scale: MAP_DISPLAY_DEFAULTS.mapSymbolScale,
  legend: MAP_DISPLAY_DEFAULTS.mapLegend,
};

/** The device switch: a landscape tablet, a portrait one, a handheld. */
export function DeviceButtons({ value, onChange }: { value: PreviewDevice['key']; onChange: (key: PreviewDevice['key']) => void }) {
  const t = useTranslations('tables.sketch.preview');
  return (
    <div className="flex flex-wrap gap-1" role="group" aria-label={t('device')}>
      {PREVIEW_DEVICES.map((d) => (
        <Button key={d.key} size="sm" variant={d.key === value ? 'default' : 'outline'} onClick={() => onChange(d.key)}>
          {t(`devices.${d.key}`)}
        </Button>
      ))}
    </div>
  );
}

export function TillPreview({
  title,
  elements,
  background,
  backgroundUrl,
  cw,
  ch,
  tables,
  logoUrl = null,
  logoLabel,
}: {
  title: string;
  elements: SketchElement[];
  background: SketchBackground;
  backgroundUrl: string | null;
  cw: number;
  ch: number;
  tables: PreviewTable[];
  logoUrl?: string | null;
  logoLabel: string;
}) {
  const t = useTranslations('tables.sketch.preview');
  const [deviceKey, setDeviceKey] = useState<PreviewDevice['key']>('tabletLandscape');
  const [display, setDisplay] = useState<MapDisplayValues>(MAP_DISPLAY_INITIAL);
  const device = PREVIEW_DEVICES.find((d) => d.key === deviceKey) ?? PREVIEW_DEVICES[0];
  const set = (patch: Partial<MapDisplayValues>) => setDisplay((d) => ({ ...d, ...patch }));

  return (
    <div className="space-y-2 rounded-lg border bg-card p-3">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h3 className="text-sm font-semibold">{t('title')}</h3>
          <p className="max-w-xl text-xs text-muted-foreground">{t('hint')}</p>
        </div>
        <DeviceButtons value={deviceKey} onChange={setDeviceKey} />
        <label className="space-y-0.5 text-xs">
          <span className="block text-muted-foreground">{t('decor')}</span>
          <select className={SELECT} value={display.decor} onChange={(e) => set({ decor: e.target.value as MapDecorMode })}>
            {(['full', 'symbols', 'off'] as const).map((v) => (
              <option key={v} value={v}>
                {t(`decorOptions.${v}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-0.5 text-xs">
          <span className="block text-muted-foreground">{t('labels')}</span>
          <select className={SELECT} value={display.labels} onChange={(e) => set({ labels: e.target.value as MapLabelsMode })}>
            {(['auto', 'always', 'never'] as const).map((v) => (
              <option key={v} value={v}>
                {t(`labelsOptions.${v}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-0.5 text-xs">
          <span className="block text-muted-foreground">{t('scale', { value: display.scale })}</span>
          <input
            type="range"
            className="h-8 w-32"
            min={MAP_SYMBOL_SCALE.min}
            max={MAP_SYMBOL_SCALE.max}
            step={5}
            value={display.scale}
            onChange={(e) => set({ scale: Number(e.target.value) })}
          />
        </label>
        <label className="space-y-0.5 text-xs">
          <span className="block text-muted-foreground">{t('legend')}</span>
          <select className={SELECT} value={display.legend} onChange={(e) => set({ legend: e.target.value as MapLegendMode })}>
            {(['off', 'button', 'always'] as const).map((v) => (
              <option key={v} value={v}>
                {t(`legendOptions.${v}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <DeviceFloor
        key={`${deviceKey}:${display.legend}`}
        device={device}
        display={display}
        title={title}
        elements={elements}
        background={background}
        backgroundUrl={backgroundUrl}
        cw={cw}
        ch={ch}
        tables={tables}
        logoUrl={logoUrl}
        logoLabel={logoLabel}
      />
    </div>
  );
}

function floorFillOf(background: SketchBackground): string {
  return background === 'tiles'
    ? 'url(#floor-tiles)'
    : background === 'light'
      ? PLAIN.light
      : background === 'dark'
        ? PLAIN.dark
        : background === 'wood'
          ? 'url(#floor-wood)'
          : 'url(#floor-clean)';
}

/** The till's grid of squares (GridBody): cells of at least 150 dp, 14 dp apart, from under its bar. */
export function gridCells(count: number, device: PreviewDevice): { x: number; y: number; size: number }[] {
  const pad = 14;
  const gap = 14;
  const cols = Math.max(1, Math.floor((device.width - 2 * pad + gap) / (150 + gap)));
  const size = (device.width - 2 * pad - (cols - 1) * gap) / cols;
  return Array.from({ length: count }, (_, i) => ({
    x: pad + (i % cols) * (size + gap),
    y: device.insetTop + 4 + Math.floor(i / cols) * (size + gap),
    size,
  }));
}

/**
 * The device: its frame, the floor — the map fitted as the till fits it, or a zone of squares as its
 * grid — the plan's shapes, the tables (plain, or in a state each with `look`), the bars, the legend.
 */
export function DeviceFloor({
  device,
  display,
  look = null,
  layout = 'map',
  title,
  elements,
  background,
  backgroundUrl,
  cw,
  ch,
  tables,
  logoUrl = null,
  logoLabel,
  maxWidth = 860,
  maxHeight = 620,
}: {
  device: PreviewDevice;
  display: MapDisplayValues;
  /** The tables' look (the till design's): each table in a sample state. None: plain tables. */
  look?: TileLook | null;
  layout?: 'map' | 'grid';
  title: string;
  elements: SketchElement[];
  background: SketchBackground;
  backgroundUrl: string | null;
  cw: number;
  ch: number;
  tables: PreviewTable[];
  logoUrl?: string | null;
  logoLabel: string;
  maxWidth?: number;
  maxHeight?: number;
}) {
  const t = useTranslations('tables.sketch.preview');
  const [legendOpen, setLegendOpen] = useState(false);
  const compact = isCompactScreen(device.width, device.height);
  const grid = layout === 'grid';

  const visible = useMemo(() => (grid ? [] : visibleElements(elements, display.decor)), [grid, elements, display.decor]);
  const view = useMemo(
    () =>
      fitMapView(
        tables.map((tb) => ({ x: tb.x, y: tb.y, width: tb.width, height: tb.height })),
        cw,
        ch,
        device.width,
        device.height,
        device.insetTop,
        device.insetBottom,
        decorExtent(visible, cw, ch),
      ),
    [tables, cw, ch, device, visible],
  );
  const shapes = useMemo(() => drawOrder(visible).map((el) => onView(el, view)), [visible, view]);
  const entries = useMemo(() => legendEntries(visible), [visible]);
  const ordered = useMemo(() => [...tables].sort((a, b) => a.number - b.number), [tables]);
  const stateOf = useMemo(() => new Map(ordered.map((tb, i) => [tb.id, i])), [ordered]);
  const cells = useMemo(() => (grid ? gridCells(ordered.length, device) : []), [grid, ordered.length, device]);
  const sketchLook: SketchLook = { words: display.labels, symbolScale: display.scale / 100, minSymbol: DECOR_MIN_ICON_DP, compact };
  // "תמיד": beside the map on a tablet; a phone or a handheld has room for a sheet only.
  const inline = !grid && display.legend === 'always' && !compact;
  const button = !grid && (display.legend === 'button' || (display.legend === 'always' && compact));
  const showLegend = !grid && display.legend !== 'off' && (inline || legendOpen);
  const k = Math.min(maxWidth / device.width, maxHeight / device.height, 1);
  const floor = { x: view.ox, y: view.oy, w: cw * view.sx, h: ch * view.sy };

  return (
    <div className="flex justify-center overflow-x-auto py-2">
      {/* The device: its frame, the till's floor in dp, its bars, the legend. */}
      <div
        dir="ltr"
        className="relative overflow-hidden rounded-[22px] border-[6px] border-slate-800 bg-slate-800 shadow-lg"
        style={{ width: device.width * k + 12, height: device.height * k + 12 }}
      >
        <svg viewBox={`0 0 ${device.width} ${device.height}`} width={device.width * k} height={device.height * k} className="block">
          <FloorDefs />
          <rect x={0} y={0} width={device.width} height={device.height} fill={grid ? CLEAN.fill : '#e2e8f0'} />
          {grid ? null : background === 'image' && backgroundUrl ? (
            <image href={backgroundUrl} x={floor.x} y={floor.y} width={floor.w} height={floor.h} preserveAspectRatio="none" />
          ) : (
            <rect x={floor.x} y={floor.y} width={floor.w} height={floor.h} fill={floorFillOf(background)} />
          )}
          {shapes.map((el) => (
            <SketchShape key={el.id} el={el} perPx={1} look={sketchLook} logoUrl={logoUrl} logoLabel={logoLabel} />
          ))}
          {ordered.map((tb, i) => {
            if (grid) {
              const cell = cells[i];
              // A cell holds the table and its chairs.
              const body = cell.size / (1 + 2 * CHAIR_REACH);
              const round = tb.shape === 'round';
              return (
                <PreviewTableShape
                  key={tb.id}
                  cx={cell.x + cell.size / 2}
                  cy={cell.y + cell.size / 2}
                  w={body}
                  h={body}
                  round={round}
                  rotation={0}
                  number={tb.number}
                  seats={tb.seats ?? 4}
                  look={look}
                  index={stateOf.get(tb.id) ?? i}
                />
              );
            }
            const cx = view.ox + (tb.x + tb.width / 2) * view.sx;
            const cy = view.oy + (tb.y + tb.height / 2) * view.sy;
            return (
              <PreviewTableShape
                key={tb.id}
                cx={cx}
                cy={cy}
                w={tb.width * view.tableScale}
                h={tb.height * view.tableScale}
                round={tb.shape === 'round'}
                rotation={tb.rotation}
                number={tb.number}
                seats={tb.seats ?? 4}
                look={look}
                index={stateOf.get(tb.id) ?? i}
              />
            );
          })}
          {/* The till's top bar and its bottom island, over the floor. */}
          <rect x={0} y={0} width={device.width} height={device.insetTop} fill="#ffffff" opacity={0.94} />
          <text x={device.width - 16} y={device.insetTop / 2} textAnchor="end" dominantBaseline="central" fontSize={compact ? 16 : 20} fontWeight={700} fill="#0f172a">
            {title}
          </text>
          <rect
            x={device.width * 0.12}
            y={device.height - device.insetBottom + 12}
            width={device.width * 0.76}
            height={device.insetBottom - 24}
            rx={(device.insetBottom - 24) / 2}
            fill="#0f172a"
            opacity={0.88}
          />
        </svg>
        {button ? (
          <button
            type="button"
            dir="rtl"
            onClick={() => setLegendOpen((o) => !o)}
            className="absolute left-3 inline-flex items-center gap-1 rounded-full border bg-white px-3 py-1 text-xs font-medium text-slate-800 shadow"
            style={{ top: 6 + (device.insetTop * k) / 2 - 13 }}
          >
            <BookOpen className="h-3.5 w-3.5" />
            {t('legendButton')}
          </button>
        ) : null}
        {showLegend ? (
          <div
            dir="rtl"
            className={
              compact
                ? 'absolute inset-x-1.5 bottom-1.5 max-h-[60%] overflow-y-auto rounded-t-2xl bg-white p-3 shadow-2xl'
                : 'absolute right-3 max-h-[70%] w-56 overflow-y-auto rounded-xl bg-white/95 p-3 shadow-xl'
            }
            style={compact ? undefined : { top: 6 + device.insetTop * k + 8 }}
          >
            <div className="mb-1.5 flex items-center justify-between">
              <span className="text-sm font-semibold text-slate-900">{t('legendTitle')}</span>
              {!inline ? (
                <button type="button" onClick={() => setLegendOpen(false)} className="text-slate-500" aria-label={t('close')}>
                  <X className="h-4 w-4" />
                </button>
              ) : null}
            </div>
            {entries.length ? (
              <ul className="space-y-1">
                {entries.map((entry) => (
                  <li key={entry.key} className="flex items-center gap-2 text-xs text-slate-800">
                    <KindIcon kind={entry.kind} variant={entry.variant} size={22} fill={entry.kind === 'area' ? entry.color : null} />
                    {entry.name}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-slate-500">{t('legendEmpty')}</p>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * A table on the preview's floor (in dp): its chairs, the table — plain, or in its sample state's
 * colours as the look draws them (soft / filled / outline) — its number at the look's size, what is
 * written under it, and the state's word in a pill below (the till's classic look).
 */
export function PreviewTableShape({
  cx,
  cy,
  w,
  h,
  round,
  rotation,
  number,
  seats,
  look,
  index,
  state: fixedState,
}: {
  cx: number;
  cy: number;
  w: number;
  h: number;
  round: boolean;
  rotation: number;
  number: number;
  seats: number;
  look: TileLook | null;
  /** Its place in the sample floor: which state it shows. */
  index: number;
  /** A state of its own (the states' strip). */
  state?: TableState;
}) {
  const state = fixedState ?? sampleState(index);
  const colors = look ? tileColors(look.style, look.colors[state]) : null;
  const sample = look ? sampleTable(state, index, seats, look.overdueMinutes) : null;
  const lines = look && sample ? tileInfoLines(look.info, sample) : [];
  const short = Math.min(w, h);
  const numberFs = Math.max(9, short * (lines.length ? 0.3 : 0.36) * (look?.numberScale ?? 1));
  const infoFs = Math.max(7, short * 0.13);
  // As many lines as fit under the number.
  const room = Math.max(0, Math.floor((h * 0.86 - numberFs * 1.05) / (infoFs * 1.2)));
  const shown = lines.slice(0, room);
  const block = numberFs * 1.05 + shown.length * infoFs * 1.2;
  const top = cy - block / 2;
  const chairs = look ? chairLayout(round, w, h, seats) : [];
  const gradId = `tile-${state}-${look?.style ?? 'plain'}`;
  const fill = colors ? (colors.fill === colors.fill2 ? colors.fill : `url(#${gradId})`) : TABLE_LOOK.fill;
  const stroke = colors ? colors.stroke : TABLE_LOOK.border;
  const strokeW = colors ? 1.5 * colors.strokeScale : 1.5;
  const word = sample ? stateWord(sample) : null;
  const pillFs = Math.max(8, Math.min(13, short * 0.17));
  const pillW = word ? word.length * pillFs * 0.62 + pillFs * 1.4 : 0;
  const pillY = cy + h / 2 + short * CHAIR_REACH * 0.55;

  return (
    <g>
      {colors && colors.fill !== colors.fill2 ? (
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={colors.fill} />
            <stop offset="1" stopColor={colors.fill2} />
          </linearGradient>
        </defs>
      ) : null}
      <g transform={`rotate(${rotation} ${cx} ${cy})`}>
        {chairs.map((c, i) => (
          // The chairs, from the table's seats — as the map editor and the till draw them.
          <g key={i} transform={`translate(${cx - w / 2 + c.cx} ${cy - h / 2 + c.cy}) rotate(${c.angle})`}>
            <rect
              x={-c.width / 2} y={-c.depth / 2} width={c.width} height={c.depth} rx={c.depth * 0.28}
              fill={CHAIR_LOOK.wood} stroke={CHAIR_LOOK.edge} strokeWidth={Math.max(0.5, c.depth * 0.06)}
            />
            <rect x={-c.width / 2} y={-c.depth / 2} width={c.width} height={c.depth * 0.34} rx={c.depth * 0.28} fill={CHAIR_LOOK.back} />
          </g>
        ))}
        {round ? (
          <ellipse cx={cx} cy={cy} rx={w / 2} ry={h / 2} fill={fill} stroke={stroke} strokeWidth={strokeW} filter="url(#table-shadow)" />
        ) : (
          <rect x={cx - w / 2} y={cy - h / 2} width={w} height={h} rx={short * 0.18} fill={fill} stroke={stroke} strokeWidth={strokeW} filter="url(#table-shadow)" />
        )}
      </g>
      <text
        x={cx}
        y={shown.length ? top + numberFs * 0.52 : cy}
        textAnchor="middle"
        dominantBaseline="central"
        fontSize={numberFs}
        fontWeight={700}
        fill={colors ? colors.number : TABLE_LOOK.number}
      >
        {number}
      </text>
      {shown.map((line, i) => (
        <text
          key={i}
          x={cx}
          y={top + numberFs * 1.05 + infoFs * 1.2 * (i + 0.5)}
          textAnchor="middle"
          dominantBaseline="central"
          direction="rtl"
          fontSize={infoFs}
          fill={colors?.info ?? TABLE_LOOK.number}
        >
          {line}
        </text>
      ))}
      {word && colors ? (
        <g>
          <rect x={cx - pillW / 2} y={pillY - pillFs * 0.8} width={pillW} height={pillFs * 1.6} rx={pillFs * 0.8} fill={colors.pill} />
          <text x={cx} y={pillY} textAnchor="middle" dominantBaseline="central" direction="rtl" fontSize={pillFs} fontWeight={600} fill={colors.pillText}>
            {word}
          </text>
        </g>
      ) : null}
    </g>
  );
}

/** Every state once, side by side — whatever the zone has (the preview's key to the colours). */
export function StateStrip({ look }: { look: TileLook }) {
  const size = 64;
  const gap = 20;
  const width = TABLE_STATES.length * (size + gap) + gap;
  const height = size + 64;
  return (
    <div className="overflow-x-auto" dir="ltr">
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" style={{ maxWidth: width, minWidth: 420 }} className="mx-auto block">
        <FloorDefs />
        <rect x={0} y={0} width={width} height={height} rx={12} fill={CLEAN.fill} />
        {TABLE_STATES.map((state, i) => (
          <PreviewTableShape
            key={state}
            cx={gap + size / 2 + i * (size + gap)}
            cy={size / 2 + 22}
            w={size * 0.78}
            h={size * 0.78}
            round={false}
            rotation={0}
            number={i + 1}
            seats={4}
            look={look}
            index={i}
            state={state}
          />
        ))}
      </svg>
    </div>
  );
}
