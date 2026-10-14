'use client';

/**
 * "תצוגה בקופה" (P:/specs/table-map-decor-v3.md §3, §4): how a zone's map will look on the till — a
 * landscape tablet, a portrait one or a handheld — drawn with the dashboard's own shapes
 * (./sketch-shapes.tsx), fitted and stretched as the till fits its map (lib/tableSketch.ts
 * `fitMapView`, `onView`: the till's DecorFit.kt), and shown as the till's parameters would show it:
 * `mapDecor`, `mapSymbolLabels`, `mapSymbolScale`, `mapLegend` — chosen here to try them out; the
 * till's own come from "הגדרות שולחנות" per level. On a small screen (a handheld, a phone) no words
 * are drawn by default, every symbol is at least 18 dp and upright, and the legend opens as a sheet.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { BookOpen, X } from 'lucide-react';
import {
  DECOR_MIN_ICON_DP,
  MAP_DISPLAY_DEFAULTS,
  MAP_SYMBOL_SCALE,
  PLAIN,
  PREVIEW_DEVICES,
  TABLE_LOOK,
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
  const [decor, setDecor] = useState<MapDecorMode>(MAP_DISPLAY_DEFAULTS.mapDecor);
  const [labels, setLabels] = useState<MapLabelsMode>(MAP_DISPLAY_DEFAULTS.mapSymbolLabels);
  const [scale, setScale] = useState<number>(MAP_DISPLAY_DEFAULTS.mapSymbolScale);
  const [legend, setLegend] = useState<MapLegendMode>(MAP_DISPLAY_DEFAULTS.mapLegend);
  const [legendOpen, setLegendOpen] = useState(false);
  const device = PREVIEW_DEVICES.find((d) => d.key === deviceKey) ?? PREVIEW_DEVICES[0];
  const compact = isCompactScreen(device.width, device.height);

  const visible = useMemo(() => visibleElements(elements, decor), [elements, decor]);
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
  const look: SketchLook = { words: labels, symbolScale: scale / 100, minSymbol: DECOR_MIN_ICON_DP, compact };
  // "תמיד": beside the map on a tablet; a phone or a handheld has room for a sheet only.
  const inline = legend === 'always' && !compact;
  const button = legend === 'button' || (legend === 'always' && compact);
  const showLegend = legend !== 'off' && (inline || legendOpen);
  // The device drawn at most 860 × 620 on the dashboard.
  const k = Math.min(860 / device.width, 620 / device.height, 1);
  const floorFill =
    background === 'tiles'
      ? 'url(#floor-tiles)'
      : background === 'light'
        ? PLAIN.light
        : background === 'dark'
          ? PLAIN.dark
          : background === 'wood'
            ? 'url(#floor-wood)'
            : 'url(#floor-clean)';
  const floor = { x: view.ox, y: view.oy, w: cw * view.sx, h: ch * view.sy };

  return (
    <div className="space-y-2 rounded-lg border bg-card p-3">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h3 className="text-sm font-semibold">{t('title')}</h3>
          <p className="max-w-xl text-xs text-muted-foreground">{t('hint')}</p>
        </div>
        <div className="flex gap-1" role="group" aria-label={t('device')}>
          {PREVIEW_DEVICES.map((d) => (
            <Button
              key={d.key}
              size="sm"
              variant={d.key === deviceKey ? 'default' : 'outline'}
              onClick={() => {
                setDeviceKey(d.key);
                setLegendOpen(false);
              }}
            >
              {t(`devices.${d.key}`)}
            </Button>
          ))}
        </div>
        <label className="space-y-0.5 text-xs">
          <span className="block text-muted-foreground">{t('decor')}</span>
          <select className={SELECT} value={decor} onChange={(e) => setDecor(e.target.value as MapDecorMode)}>
            {(['full', 'symbols', 'off'] as const).map((v) => (
              <option key={v} value={v}>
                {t(`decorOptions.${v}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-0.5 text-xs">
          <span className="block text-muted-foreground">{t('labels')}</span>
          <select className={SELECT} value={labels} onChange={(e) => setLabels(e.target.value as MapLabelsMode)}>
            {(['auto', 'always', 'never'] as const).map((v) => (
              <option key={v} value={v}>
                {t(`labelsOptions.${v}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-0.5 text-xs">
          <span className="block text-muted-foreground">{t('scale', { value: scale })}</span>
          <input
            type="range"
            className="h-8 w-32"
            min={MAP_SYMBOL_SCALE.min}
            max={MAP_SYMBOL_SCALE.max}
            step={5}
            value={scale}
            onChange={(e) => setScale(Number(e.target.value))}
          />
        </label>
        <label className="space-y-0.5 text-xs">
          <span className="block text-muted-foreground">{t('legend')}</span>
          <select
            className={SELECT}
            value={legend}
            onChange={(e) => {
              setLegend(e.target.value as MapLegendMode);
              setLegendOpen(false);
            }}
          >
            {(['off', 'button', 'always'] as const).map((v) => (
              <option key={v} value={v}>
                {t(`legendOptions.${v}`)}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="flex justify-center overflow-x-auto py-2">
        {/* The device: its frame, the till's map in dp, its bars, the legend. */}
        <div
          dir="ltr"
          className="relative overflow-hidden rounded-[22px] border-[6px] border-slate-800 bg-slate-800 shadow-lg"
          style={{ width: device.width * k + 12, height: device.height * k + 12 }}
        >
          <svg viewBox={`0 0 ${device.width} ${device.height}`} width={device.width * k} height={device.height * k} className="block">
            <FloorDefs />
            <rect x={0} y={0} width={device.width} height={device.height} fill="#e2e8f0" />
            {background === 'image' && backgroundUrl ? (
              <image href={backgroundUrl} x={floor.x} y={floor.y} width={floor.w} height={floor.h} preserveAspectRatio="none" />
            ) : (
              <rect x={floor.x} y={floor.y} width={floor.w} height={floor.h} fill={floorFill} />
            )}
            {shapes.map((el) => (
              <SketchShape key={el.id} el={el} perPx={1} look={look} logoUrl={logoUrl} logoLabel={logoLabel} />
            ))}
            {tables.map((tb) => {
              const cx = view.ox + (tb.x + tb.width / 2) * view.sx;
              const cy = view.oy + (tb.y + tb.height / 2) * view.sy;
              const w = tb.width * view.tableScale;
              const h = tb.height * view.tableScale;
              const fs = Math.max(10, Math.min(w, h) * 0.36);
              return (
                <g key={tb.id} transform={`rotate(${tb.rotation} ${cx} ${cy})`}>
                  {tb.shape === 'round' ? (
                    <ellipse cx={cx} cy={cy} rx={w / 2} ry={h / 2} fill={TABLE_LOOK.fill} stroke={TABLE_LOOK.border} strokeWidth={1.5} filter="url(#table-shadow)" />
                  ) : (
                    <rect x={cx - w / 2} y={cy - h / 2} width={w} height={h} rx={Math.min(w, h) * 0.18} fill={TABLE_LOOK.fill} stroke={TABLE_LOOK.border} strokeWidth={1.5} filter="url(#table-shadow)" />
                  )}
                  <text x={cx} y={cy} textAnchor="middle" dominantBaseline="central" fontSize={fs} fontWeight={700} fill={TABLE_LOOK.number}>
                    {tb.number}
                  </text>
                </g>
              );
            })}
            {/* The till's top bar and its bottom island, over the map. */}
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
    </div>
  );
}
