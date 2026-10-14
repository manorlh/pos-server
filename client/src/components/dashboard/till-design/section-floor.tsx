'use client';

/**
 * "שולחנות ומפה" (P:/specs/till-design-tables.md §1, the contract §5) — the till design's tab for the
 * floor, the owner's main place to design it ("עדיף שהעיצוב יהיה במסך עיצוב קופה"):
 *
 * * the floor editor itself — the tables page's, shared (../tables/tables-editor.tsx, `embedded`): a
 *   shop and its zones, the zone settings (map or squares, the canvas, a floor image), the tables,
 *   the plan with every symbol, texts and logos, the switch from squares to a map;
 * * the tables' look — `tableTileStyle`, `tableTileInfo`, `tableStateColors`, `tableOverdueMinutes`,
 *   `tableNumberSize` — and the map's display (`mapDecor`, `mapLegend`, `mapSymbolLabels`,
 *   `mapSymbolScale`, #101): till parameters at the level being designed
 *   (`/till-design/table-display`), with what each inherits; the same people edit them as the design;
 * * the way to the table-opening animation ("הנפשות", `tableOpen`);
 * * who: the parameters are the till design's to edit; the floor itself needs "עריכת מפה ושולחנות"
 *   (`tables_layout`, as on the tables page — `canEditFloorLayout`); without it, the saved floor;
 * * beside it all, the till's floor as it will look — a landscape tablet, a portrait one, a handheld
 *   — with sample tables in every state: every change shows there at once, before any save.
 */

import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { Clapperboard, RotateCcw } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useScope } from '@/lib/scope';
import { SECTION_IDS, canAccess, type DashboardAccess, type SectionId } from '@/lib/dashboardAccess';
import { useDashboardAccess } from '@/lib/dashboardAccessApi';
import { fetchTablesLayout, type TablesLayout } from '@/lib/tablesApi';
import { backgroundOf, uniqueElements } from '@/lib/tableSketch';
import { sameId } from '@/lib/entityLookup';
import { MAP_SYMBOL_SCALE, PREVIEW_DEVICES, type MapDecorMode, type MapLabelsMode, type MapLegendMode, type PreviewDevice } from '@/lib/tableSketch';
import {
  DEFAULT_STATE_COLORS,
  INFO_NAMES,
  NUMBER_SIZES,
  OVERDUE_RANGE,
  STATE_NAMES,
  TABLE_STATES,
  TILE_INFO_FIELDS,
  TILE_STYLES,
  overdueError,
  parseStateColors,
  parseTileInfo,
  resolveTileLook,
  setsItself,
  toggleTileInfo,
  withStateColor,
  type TileStyle,
} from '@/lib/tableTileLook';
import type { TableDisplayView, TillDesignLevel } from '@/lib/tillDesignApi';
import { TablesEditor, type FloorLive } from '@/components/dashboard/tables/tables-editor';
import { DeviceButtons, DeviceFloor, MAP_DISPLAY_INITIAL, StateStrip, type MapDisplayValues } from '@/components/dashboard/tables/sketch-preview';
import { OptionSelect, Segmented } from './fields';

/** "עריכת מפה ושולחנות" — the floor's own permission (the tables page's too; #105). */
export const TABLES_LAYOUT_SECTION = 'tables_layout';

/**
 * May this user edit the floor itself here — the zones, the tables, the plan? As on the tables page:
 * `tables_layout` at edit. A build that does not know that section yet: yes (the server still guards).
 */
export function canEditFloorLayout(access: DashboardAccess): boolean {
  if (!(SECTION_IDS as string[]).includes(TABLES_LAYOUT_SECTION)) return true;
  return canAccess(access, TABLES_LAYOUT_SECTION as SectionId, 'edit');
}

/** The saved floor of a shop's first zone, for the preview (no editor to hand it over). */
export function savedFloor(layout: TablesLayout | undefined): FloorLive | null {
  const zone = layout?.zones?.[0];
  if (!layout || !zone) return null;
  return {
    shopId: layout.shopId,
    zoneId: zone.id,
    zoneName: zone.name,
    layout: zone.layout,
    cw: zone.canvasWidth,
    ch: zone.canvasHeight,
    backgroundUrl: zone.backgroundUrl,
    background: backgroundOf(zone.sketch, !!zone.backgroundUrl),
    elements: uniqueElements(zone.sketch?.elements ?? []),
    tables: layout.tables
      .filter((tb) => tb.zoneId === zone.id)
      .map((tb) => ({ id: tb.id, number: tb.number, shape: tb.shape, seats: tb.seats, x: tb.x, y: tb.y, width: tb.width, height: tb.height, rotation: tb.rotation })),
    logoUrl: layout.logoUrl ?? null,
    dirty: false,
  };
}

/** The map's display from the resolved parameters (anything the till cannot read: its default). */
export function mapDisplayOf(params: Record<string, unknown>): MapDisplayValues {
  const pick = <T extends string>(v: unknown, options: readonly T[], fallback: T): T => (options.includes(v as T) ? (v as T) : fallback);
  const scale = typeof params.mapSymbolScale === 'number' ? params.mapSymbolScale : MAP_DISPLAY_INITIAL.scale;
  return {
    decor: pick<MapDecorMode>(params.mapDecor, ['full', 'symbols', 'off'], MAP_DISPLAY_INITIAL.decor),
    labels: pick<MapLabelsMode>(params.mapSymbolLabels, ['auto', 'always', 'never'], MAP_DISPLAY_INITIAL.labels),
    legend: pick<MapLegendMode>(params.mapLegend, ['off', 'button', 'always'], MAP_DISPLAY_INITIAL.legend),
    scale: Math.max(MAP_SYMBOL_SCALE.min, Math.min(MAP_SYMBOL_SCALE.max, scale)),
  };
}

/** "נקבע כאן" + back to what it inherits, or "עובר בירושה". */
function Mark({ own, onReset, disabled }: { own: boolean; onReset: () => void; disabled: boolean }) {
  const t = useTranslations('tillDesign.settings');
  if (!own) return <span className="text-[11px] text-muted-foreground">{t('inherited')}</span>;
  return (
    <span className="inline-flex items-center gap-1">
      <Badge variant="secondary" className="bg-sky-100 text-sky-800 dark:bg-sky-950 dark:text-sky-200">
        {t('overridden')}
      </Badge>
      {!disabled ? (
        <Button type="button" size="icon-xs" variant="ghost" title={t('reset')} aria-label={t('reset')} onClick={onReset}>
          <RotateCcw />
        </Button>
      ) : null}
    </span>
  );
}

function Row({
  label,
  hint,
  own,
  onReset,
  disabled,
  children,
}: {
  label: string;
  hint?: string;
  own: boolean;
  onReset: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{label}</span>
          <Mark own={own} onReset={onReset} disabled={disabled} />
        </div>
        {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      {children}
    </div>
  );
}

export function FloorSection({
  level,
  companyId,
  pageShopId,
  shopId,
  onShop,
  onLive,
  view,
  loading,
  failed,
  canEdit,
  edits,
  effective,
  onEdit,
  onOpenMotion,
}: {
  level: TillDesignLevel;
  companyId: string | null;
  /** The page's shop (none at company level). */
  pageShopId: string | null;
  /** The shop whose floor is edited. */
  shopId: string | null;
  onShop: (id: string) => void;
  onLive: (live: FloorLive | null) => void;
  view: TableDisplayView | undefined;
  loading: boolean;
  failed: boolean;
  canEdit: boolean;
  edits: Record<string, unknown>;
  effective: Record<string, unknown>;
  /** A value at this level; null — inherit again. */
  onEdit: (key: string, value: unknown) => void;
  /** The "הנפשות" tab, when this build has it. */
  onOpenMotion?: () => void;
}) {
  const t = useTranslations('tillDesign.floor');
  const { shops } = useScope();
  const access = useDashboardAccess();
  const layoutEditable = canEditFloorLayout(access);
  const companyShops = useMemo(
    () => shops.filter((s) => !companyId || sameId(s.companyId, companyId)),
    [shops, companyId],
  );
  // At company level no shop is the page's: the company's first, until one is picked.
  const current = shopId ?? companyShops[0]?.id ?? null;
  // Not the floor's editor: the saved floor goes to the preview all the same.
  const saved = useQuery({
    queryKey: ['tables-layout', current],
    queryFn: () => fetchTablesLayout(current as string),
    enabled: !layoutEditable && !!current,
    retry: false,
  });
  const savedLive = useMemo(() => (layoutEditable ? null : savedFloor(saved.data)), [layoutEditable, saved.data]);
  useEffect(() => {
    if (!layoutEditable) onLive(savedLive);
  }, [layoutEditable, savedLive, onLive]);
  const own = view?.own ?? {};
  const disabled = !canEdit || !view?.canEdit;
  const sets = (key: string) => setsItself(own, edits, key);
  const reset = (key: string) => onEdit(key, null);
  const style = effective.tableTileStyle as TileStyle;
  const info = parseTileInfo(effective.tableTileInfo);
  const colors = parseStateColors(effective.tableStateColors);
  const overdueText = String(effective.tableOverdueMinutes ?? '');
  const display = mapDisplayOf(effective);

  return (
    <div className="space-y-4">
      <Card className="rounded-xl">
        <CardHeader className="space-y-1">
          <CardTitle className="text-base">{t('editorTitle')}</CardTitle>
          <CardDescription>{t('editorHint')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {companyShops.length > 1 || !pageShopId ? (
            <OptionSelect
              value={current ?? ''}
              placeholder={t('pickShop')}
              ariaLabel={t('pickShop')}
              options={companyShops.map((s) => ({ value: s.id, label: s.name }))}
              onChange={(id) => id && onShop(id)}
              className="w-full sm:w-80"
            />
          ) : null}
          {level !== 'shop' ? <p className="text-xs text-muted-foreground">{t('editorShared')}</p> : null}
          {current && !layoutEditable ? (
            <p className="rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">{t('layoutNoPermission')}</p>
          ) : current ? (
            <TablesEditor key={current} shopId={current} embedded onLive={onLive} />
          ) : (
            <p className="rounded-lg border bg-muted/40 p-4 text-sm text-muted-foreground">{t('noShop')}</p>
          )}
        </CardContent>
      </Card>

      <Card className="rounded-xl">
        <CardHeader className="space-y-1">
          <CardTitle className="text-base">{t('lookTitle')}</CardTitle>
          <CardDescription>{t('lookHint')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {loading ? (
            <Skeleton className="h-64 w-full" />
          ) : failed || !view ? (
            <p className="text-sm text-destructive">{t('loadFailed')}</p>
          ) : (
            <>
              {!view.canEdit || !canEdit ? <p className="text-xs text-muted-foreground">{t('readOnly')}</p> : null}
              <Row label={t('style')} hint={t('styleHint')} own={sets('tableTileStyle')} onReset={() => reset('tableTileStyle')} disabled={disabled}>
                <Segmented
                  value={style}
                  onChange={(v) => onEdit('tableTileStyle', v)}
                  disabled={disabled}
                  ariaLabel={t('style')}
                  options={TILE_STYLES.map((s) => ({ value: s, label: t(`styles.${s}`) }))}
                />
              </Row>
              <Row label={t('info')} hint={t('infoHint')} own={sets('tableTileInfo')} onReset={() => reset('tableTileInfo')} disabled={disabled}>
                <div className="flex flex-wrap gap-2">
                  {TILE_INFO_FIELDS.map((f) => {
                    const on = info.includes(f);
                    return (
                      <button
                        key={f}
                        type="button"
                        aria-pressed={on}
                        disabled={disabled}
                        onClick={() => onEdit('tableTileInfo', toggleTileInfo(effective.tableTileInfo, f))}
                        className={`rounded-full border px-3 py-1 text-sm transition-colors disabled:opacity-50 ${on ? 'border-primary bg-primary text-primary-foreground' : 'bg-background hover:bg-muted'}`}
                      >
                        {INFO_NAMES[f]}
                      </button>
                    );
                  })}
                </div>
              </Row>
              <Row label={t('colors')} hint={t('colorsHint')} own={sets('tableStateColors')} onReset={() => reset('tableStateColors')} disabled={disabled}>
                <div className="grid gap-2 sm:grid-cols-2">
                  {TABLE_STATES.map((state) => {
                    const c = colors[state];
                    const today = c === DEFAULT_STATE_COLORS[state];
                    return (
                      <label key={state} className="flex items-center gap-2 rounded-lg border bg-background px-2 py-1.5 text-sm">
                        <input
                          type="color"
                          className="h-8 w-10 shrink-0 cursor-pointer rounded border bg-transparent disabled:cursor-not-allowed"
                          value={c}
                          disabled={disabled}
                          aria-label={STATE_NAMES[state]}
                          onChange={(e) => onEdit('tableStateColors', withStateColor(effective.tableStateColors, state, e.target.value))}
                        />
                        <span className="min-w-0 flex-1">{STATE_NAMES[state]}</span>
                        <span dir="ltr" className="font-mono text-[11px] text-muted-foreground">
                          {c}
                        </span>
                        {today ? (
                          <span className="text-[11px] text-muted-foreground">{t('today')}</span>
                        ) : (
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost"
                            disabled={disabled}
                            title={t('colorToday')}
                            aria-label={t('colorToday')}
                            onClick={(e) => {
                              e.preventDefault();
                              onEdit('tableStateColors', withStateColor(effective.tableStateColors, state, DEFAULT_STATE_COLORS[state]));
                            }}
                          >
                            <RotateCcw />
                          </Button>
                        )}
                      </label>
                    );
                  })}
                </div>
              </Row>
              <Row label={t('overdue')} hint={t('overdueHint')} own={sets('tableOverdueMinutes')} onReset={() => reset('tableOverdueMinutes')} disabled={disabled}>
                <div className="flex items-center gap-2">
                  <Input
                    className="h-9 w-24"
                    dir="ltr"
                    inputMode="numeric"
                    disabled={disabled}
                    aria-label={t('overdue')}
                    value={overdueText}
                    onChange={(e) => {
                      const text = e.target.value.replace(/[^0-9]/g, '');
                      onEdit('tableOverdueMinutes', text === '' ? '' : Number(text));
                    }}
                  />
                  <span className="text-sm text-muted-foreground">{t('minutes')}</span>
                  {overdueError(overdueText) ? (
                    <span className="text-xs text-destructive">{t('overdueRange', OVERDUE_RANGE)}</span>
                  ) : null}
                </div>
              </Row>
              <Row label={t('numberSize')} own={sets('tableNumberSize')} onReset={() => reset('tableNumberSize')} disabled={disabled}>
                <Segmented
                  value={String(effective.tableNumberSize ?? 'm')}
                  onChange={(v) => onEdit('tableNumberSize', v)}
                  disabled={disabled}
                  ariaLabel={t('numberSize')}
                  options={NUMBER_SIZES.map((s) => ({ value: s, label: t(`numberSizes.${s}`) }))}
                />
              </Row>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="rounded-xl">
        <CardHeader className="space-y-1">
          <CardTitle className="text-base">{t('mapTitle')}</CardTitle>
          <CardDescription>{t('mapHint')}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {view ? (
            <>
              <Row label={t('decor')} own={sets('mapDecor')} onReset={() => reset('mapDecor')} disabled={disabled}>
                <Segmented
                  value={display.decor}
                  onChange={(v) => onEdit('mapDecor', v)}
                  disabled={disabled}
                  ariaLabel={t('decor')}
                  options={(['full', 'symbols', 'off'] as const).map((v) => ({ value: v, label: t(`decorOptions.${v}`) }))}
                />
              </Row>
              <Row label={t('legend')} own={sets('mapLegend')} onReset={() => reset('mapLegend')} disabled={disabled}>
                <Segmented
                  value={display.legend}
                  onChange={(v) => onEdit('mapLegend', v)}
                  disabled={disabled}
                  ariaLabel={t('legend')}
                  options={(['off', 'button', 'always'] as const).map((v) => ({ value: v, label: t(`legendOptions.${v}`) }))}
                />
              </Row>
              <Row label={t('labels')} own={sets('mapSymbolLabels')} onReset={() => reset('mapSymbolLabels')} disabled={disabled}>
                <Segmented
                  value={display.labels}
                  onChange={(v) => onEdit('mapSymbolLabels', v)}
                  disabled={disabled}
                  ariaLabel={t('labels')}
                  options={(['auto', 'always', 'never'] as const).map((v) => ({ value: v, label: t(`labelsOptions.${v}`) }))}
                />
              </Row>
              <Row label={t('scale', { value: display.scale })} own={sets('mapSymbolScale')} onReset={() => reset('mapSymbolScale')} disabled={disabled}>
                <input
                  type="range"
                  className="h-8 w-56"
                  min={MAP_SYMBOL_SCALE.min}
                  max={MAP_SYMBOL_SCALE.max}
                  step={5}
                  disabled={disabled}
                  aria-label={t('scale', { value: display.scale })}
                  value={display.scale}
                  onChange={(e) => onEdit('mapSymbolScale', Number(e.target.value))}
                />
              </Row>
            </>
          ) : (
            <Skeleton className="h-40 w-full" />
          )}
        </CardContent>
      </Card>

      <Card className="rounded-xl">
        <CardContent className="flex flex-wrap items-center gap-3 py-4">
          <Clapperboard className="h-5 w-5 shrink-0 text-primary" />
          <div className="min-w-[14rem] flex-1 space-y-0.5">
            <p className="text-sm font-medium">{t('motionTitle')}</p>
            <p className="text-xs text-muted-foreground">{t('motionHint')}</p>
          </div>
          <Button type="button" size="sm" variant="outline" disabled={!onOpenMotion} onClick={onOpenMotion} title={onOpenMotion ? undefined : t('motionSoon')}>
            {t('motionOpen')}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}

/** The aside: the till's floor on the chosen device, the tables in every state, before any save. */
export function FloorPreviewPanel({
  live,
  effective,
  device,
  onDevice,
}: {
  live: FloorLive | null;
  effective: Record<string, unknown>;
  device: PreviewDevice['key'];
  onDevice: (key: PreviewDevice['key']) => void;
}) {
  const t = useTranslations('tillDesign.floor');
  const tt = useTranslations('tables');
  const look = useMemo(() => resolveTileLook(effective), [effective]);
  const display = useMemo(() => mapDisplayOf(effective), [effective]);
  const d = PREVIEW_DEVICES.find((x) => x.key === device) ?? PREVIEW_DEVICES[0];
  const floor = live ?? SAMPLE_FLOOR;
  return (
    <div className="space-y-3 rounded-xl border bg-muted/30 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <DeviceButtons value={device} onChange={onDevice} />
        <span className="text-xs text-muted-foreground">{live ? t('previewZone', { zone: live.zoneName }) : t('previewSample')}</span>
      </div>
      <DeviceFloor
        key={`${device}:${display.legend}`}
        device={d}
        display={display}
        look={look}
        layout={floor.layout}
        title={floor.zoneName}
        elements={floor.elements}
        background={floor.background}
        backgroundUrl={floor.backgroundUrl}
        cw={floor.cw}
        ch={floor.ch}
        tables={floor.tables}
        logoUrl={floor.logoUrl}
        logoLabel={tt('sketch.kind.logo')}
        maxWidth={560}
        maxHeight={640}
      />
      <StateStrip look={look} />
      <p className="text-center text-xs text-muted-foreground">{live?.dirty ? t('previewUnsaved') : t('previewLive')}</p>
    </div>
  );
}

/** No shop or no zone yet: a small sample floor, every state on it. */
const SAMPLE_FLOOR: FloorLive = {
  shopId: '',
  zoneId: 'sample',
  zoneName: 'אולם',
  layout: 'map',
  cw: 1000,
  ch: 700,
  backgroundUrl: null,
  background: 'clean',
  elements: [],
  logoUrl: null,
  dirty: false,
  tables: Array.from({ length: 8 }, (_, i) => ({
    id: `s${i + 1}`,
    number: i + 1,
    shape: i % 3 === 1 ? ('round' as const) : ('square' as const),
    seats: i % 3 === 1 ? 2 : 4,
    x: 120 + (i % 4) * 220,
    y: 160 + Math.floor(i / 4) * 280,
    width: 110,
    height: 110,
    rotation: 0,
  })),
};
