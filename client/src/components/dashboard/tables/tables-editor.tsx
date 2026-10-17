'use client';

/**
 * The floor editor: a shop's zones as tabs; each zone a map (see MapEditor: the floor,
 * a sketch from a template or drawn, tables dragged, resized, duplicated) or a grid
 * (squares by number). Tables are added one by one or as a range ("1–100", "3A–3L"); their number
 * is unique in the shop. "מספר שולחן (אפשר עם אותיות, למשל 3B)" (P:/specs/table-scope.md §6.1, §14.8): one field —
 * "12" is the number 12, "3B" a label (unique in the shop by its normalised form, with an internal number never
 * shown), checked here as the server does (lib/tableLabels.ts); a table is shown everywhere by its label instead of
 * its number, and listed in the natural order (3, 3A, 3B, 10). The shop's first label warns of the tills on an
 * older build, which show it but cannot type it (§6.5). Each table has a name (shown on the till's map, or its number),
 * seats (its chairs there) and a policy — "סוג שולחן": regular / staff / managers and a
 * discount %, or one of the shop's types ("סוגי שולחנות", table-types.tsx).
 *
 * A zone of squares says so above its squares, with "עבור לתצוגת מפה": the zone becomes a map (its
 * tables kept where the cloud placed them, or laid out in a tidy grid when they have no place —
 * lib/tableSketch.ts `planSwitchToMap`) and the map editor opens on "סקיצה", to design it. The way
 * back is the zone settings' "תצוגה" (the sketch and the places are kept).
 *
 * The same editor is the till design's "שולחנות ומפה" tab (P:/specs/till-design-tables.md §1:
 * `embedded`) — the owner's main place to design the floor; the tables page points there. It hands
 * the floor as it is now (`onLive`: the zone, its layout and canvas — the zone settings' too while
 * they are open — the plan, the tables where they stand) to the preview beside it, before any save.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ImagePlus, LayoutGrid, LayoutTemplate, Map as MapIcon, Plus, Trash2 } from 'lucide-react';
import { uploadProductImage } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  archiveTable,
  archiveZone,
  bulkAddTables,
  createTable,
  createZone,
  fetchTablesLayout,
  saveTablePositions,
  tablesErrorCode,
  tablesErrorDetail,
  updateTable,
  updateZone,
  type DiningTable,
  type TableShape,
  type ZoneLayout,
} from '@/lib/tablesApi';
import {
  backgroundOf,
  defaultTableSize,
  planSwitchToMap,
  uniqueElements,
  type SketchBackground,
  type SketchElement,
} from '@/lib/tableSketch';
import { tableDisplay } from '@/lib/tableRestore';
import {
  checkRange,
  checkTableNumber,
  fieldValue,
  nextNumber,
  rangeEndValue,
  shownOf,
  sortTables,
} from '@/lib/tableLabels';
import { draftOf, policyBadge, policyBody, validatePolicyDraft, type PolicyDraft } from '@/lib/tablePolicy';
import { PolicyFields, TableTypesDialog } from '@/components/dashboard/tables/table-types';
import { useShopAreas } from '@/components/dashboard/areas/use-shop-areas';
import { canAccess } from '@/lib/dashboardAccess';
import { useDashboardAccess } from '@/lib/dashboardAccessApi';
import { MapEditor, type MapLive } from '@/components/dashboard/tables/map-editor';
import type { PreviewTable } from '@/components/dashboard/tables/sketch-preview';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const SHAPES: TableShape[] = ['round', 'square', 'rect'];
const ALL_SHOP = '__shop__';
const NO_TYPE = '__none__';

/** "עובדים" / "מנהלים" / "-10%" on a table of the grid, as the till's map shows it. */
function GridBadge({
  badge,
  kindLabel,
}: {
  badge: ReturnType<typeof policyBadge>;
  kindLabel: (kind: 'staff' | 'managers') => string;
}) {
  if (!badge) return null;
  return (
    <span className="mt-0.5 rounded-full bg-primary/10 px-1.5 text-[10px] font-semibold text-primary">
      {[badge.kind ? kindLabel(badge.kind) : null, badge.discount].filter(Boolean).join(' ')}
    </span>
  );
}

/** The floor as the editor holds it now (saved or not): what a preview beside it draws. */
export interface FloorLive {
  shopId: string;
  zoneId: string;
  zoneName: string;
  layout: ZoneLayout;
  cw: number;
  ch: number;
  backgroundUrl: string | null;
  background: SketchBackground;
  elements: SketchElement[];
  tables: PreviewTable[];
  logoUrl: string | null;
  /** Moves or plan edits on the map not saved yet. */
  dirty: boolean;
}

const canvasOf = (text: string, fallback: number) => Math.min(5000, Math.max(200, Number(text) || fallback));

export function TablesEditor({
  shopId,
  embedded = false,
  onLive,
}: {
  shopId: string;
  /** Inside the till design's "שולחנות ומפה" (its preview stands beside it). */
  embedded?: boolean;
  /** The floor as it is now, on every change (null: no zone) — a stable function (a state setter). */
  onLive?: (live: FloorLive | null) => void;
}) {
  const t = useTranslations('tables');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const layoutKey = ['tables-layout', shopId];
  const { data, isLoading } = useQuery({ queryKey: layoutKey, queryFn: () => fetchTablesLayout(shopId) });
  const { data: areas = [] } = useShopAreas(shopId);
  // "עיצוב קופה → שולחנות ומפה": pointed to from here for whoever may open it.
  const access = useDashboardAccess();
  const designLink = !embedded && canAccess(access, 'till_design', 'view');

  const zones = useMemo(() => data?.zones ?? [], [data]);
  const tableTypes = useMemo(() => data?.tableTypes ?? [], [data]);
  const [typesOpen, setTypesOpen] = useState(false);
  const [zoneId, setZoneId] = useState<string | null>(null);
  // The map editor has moves or sketch edits not saved yet: asked before leaving the zone.
  const [mapDirty, setMapDirty] = useState(false);
  // The zone just turned from squares into a map: its editor opens on "סקיצה".
  const [sketchZoneId, setSketchZoneId] = useState<string | null>(null);
  // The map editor's plan and tables as they are now (for `onLive`).
  const [mapLive, setMapLive] = useState<MapLive | null>(null);
  const zone = zones.find((z) => z.id === zoneId) ?? zones[0] ?? null;
  // In the natural order of labels and numbers: 3, 3A, 3B, 10 (P:/specs/table-scope.md §6.2).
  const tables = useMemo(
    () => sortTables((data?.tables ?? []).filter((tb) => zone && tb.zoneId === zone.id)),
    [data, zone],
  );

  const invalidate = () => qc.invalidateQueries({ queryKey: layoutKey });
  const fail = (err: unknown) => {
    const code = tablesErrorCode(err);
    const detail = tablesErrorDetail(err);
    // "3B" (§14.8): 409 `table_label_taken` {label}, 422 `table_label_invalid` {reason}.
    if (code === 'table_label_taken') {
      toast.error(t('errors.table_label_taken', { label: String(detail?.label ?? '') }));
      return;
    }
    if (code === 'table_label_invalid') {
      toast.error(t('labelError', { reason: String(detail?.reason ?? 'other') }));
      return;
    }
    toast.error(code && t.has(`errors.${code}`) ? t(`errors.${code}`) : axiosErrorToToastMessage(err, tc('error')));
  };

  // ── Zone dialogs ───────────────────────────────────────────────────────────
  const [zoneDialog, setZoneDialog] = useState<'new' | 'edit' | null>(null);
  const [zName, setZName] = useState('');
  const [zLayout, setZLayout] = useState<ZoneLayout>('map');
  const [zArea, setZArea] = useState<string>(ALL_SHOP);
  const [zWidth, setZWidth] = useState('1000');
  const [zHeight, setZHeight] = useState('700');
  const [zBackground, setZBackground] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  const openZone = (mode: 'new' | 'edit') => {
    setZoneDialog(mode);
    if (mode === 'edit' && zone) {
      setZName(zone.name);
      setZLayout(zone.layout);
      setZArea(zone.areaId ?? ALL_SHOP);
      setZWidth(String(zone.canvasWidth));
      setZHeight(String(zone.canvasHeight));
      setZBackground(zone.backgroundUrl);
    } else {
      setZName('');
      setZLayout('map');
      setZArea(ALL_SHOP);
      setZWidth('1000');
      setZHeight('700');
      setZBackground(null);
    }
  };

  const zoneMut = useMutation({
    mutationFn: async () => {
      const body = {
        name: zName.trim(),
        layout: zLayout,
        areaId: zArea === ALL_SHOP ? null : zArea,
        backgroundUrl: zBackground,
        canvasWidth: Math.min(5000, Math.max(200, Number(zWidth) || 1000)),
        canvasHeight: Math.min(5000, Math.max(200, Number(zHeight) || 700)),
      };
      if (zoneDialog === 'edit' && zone) return updateZone(zone.id, body);
      return createZone({ shopId, ...body });
    },
    onSuccess: (z) => {
      toast.success(t('saved'));
      setZoneDialog(null);
      setZoneId(z.id);
      invalidate();
    },
    onError: fail,
  });

  // "עבור לתצוגת מפה": places for the tables first (only when they have none), then the zone a map —
  // the same PATCH as the zone settings — and the editor opens on "סקיצה".
  const toMapMut = useMutation({
    mutationFn: async () => {
      if (!zone) throw new Error('no zone');
      const placements = planSwitchToMap(tables, zone.canvasWidth, zone.canvasHeight);
      if (placements.length) await saveTablePositions(zone.id, placements);
      await updateZone(zone.id, { layout: 'map' });
      return { zoneId: zone.id, arranged: placements.length };
    },
    onSuccess: ({ zoneId: id, arranged }) => {
      setSketchZoneId(id);
      toast.success(arranged ? t('toMap.doneArranged', { count: arranged }) : t('toMap.done'));
      invalidate();
    },
    onError: fail,
  });

  const archiveZoneMut = useMutation({
    mutationFn: (id: string) => archiveZone(id),
    onSuccess: () => {
      toast.success(t('zoneArchived'));
      setZoneDialog(null);
      setZoneId(null);
      invalidate();
    },
    onError: fail,
  });

  const uploadBackground = async (file: File) => {
    setUploading(true);
    try {
      const result = await uploadProductImage(file, 'products', { keepBackground: true });
      setZBackground(result.url);
    } catch (err) {
      fail(err);
    } finally {
      setUploading(false);
    }
  };

  // ── Table dialogs ──────────────────────────────────────────────────────────
  const [tableDialog, setTableDialog] = useState<'new' | 'edit' | 'bulk' | null>(null);
  const [selected, setSelected] = useState<DiningTable | null>(null);
  const [tNumber, setTNumber] = useState('');
  const [tName, setTName] = useState('');
  const [tSeats, setTSeats] = useState('4');
  const [tShape, setTShape] = useState<TableShape>('square');
  const [tWidth, setTWidth] = useState('80');
  const [tHeight, setTHeight] = useState('80');
  const [tRotation, setTRotation] = useState('0');
  const [bFrom, setBFrom] = useState('1');
  const [bTo, setBTo] = useState('10');
  // "סוג שולחן": a type, or the table's own kind and discount.
  const [tPolicy, setTPolicy] = useState<PolicyDraft>(draftOf(null));
  const policyErrors = validatePolicyDraft(tPolicy, tableTypes);
  // "מספר שולחן (אפשר עם אותיות)": a number or a label, checked as the server checks it; the range too.
  const numberCheck = checkTableNumber(tNumber);
  const rangeCheck = checkRange(bFrom, bTo);
  // The shop's first label (§6.5): the tills on a build that cannot type one.
  const shopHasLabel = (data?.tables ?? []).some((x) => !!(x.label ?? '').trim());
  const cannotType = (data?.oldDevices ?? []).filter((d) => d.labels === false);
  const addsLabel =
    tableDialog === 'bulk' ? !!rangeCheck.items?.[0]?.label : tableDialog !== null && !!numberCheck.parsed?.label;
  const firstLabelWarning = addsLabel && !shopHasLabel && cannotType.length > 0;

  const openTable = (mode: 'new' | 'edit' | 'bulk', table?: DiningTable) => {
    setTableDialog(mode);
    setSelected(table ?? null);
    // After the shop's highest plain number (a label's number is internal, 99,999 down).
    const next = nextNumber(data?.tables ?? []);
    setTNumber(table ? ((table.label ?? '').trim() || String(table.number)) : String(next));
    setTName(table?.name ?? '');
    setTSeats(String(table?.seats ?? 4));
    setTShape(table?.shape ?? 'square');
    // A new table: sized from the canvas (about 12% of its shorter side).
    const size = zone ? defaultTableSize(zone.canvasWidth, zone.canvasHeight, table?.shape ?? 'square') : { width: 80, height: 80 };
    setTWidth(String(Math.round(table?.width ?? size.width)));
    setTHeight(String(Math.round(table?.height ?? size.height)));
    setTRotation(String(table?.rotation ?? 0));
    setBFrom(String(next));
    setBTo(String(next + 9));
    setTPolicy(draftOf(table ?? null));
  };

  const tableMut = useMutation({
    mutationFn: async () => {
      if (!zone) throw new Error('no zone');
      const parsed = checkTableNumber(tNumber).parsed;
      if (!parsed) throw new Error('invalid table number');
      const common = {
        // "12" goes as the number 12, "3b" as the label ("3B").
        number: fieldValue(parsed),
        name: tName.trim() || null,
        seats: Number(tSeats) || 0,
        shape: tShape,
        width: Math.max(20, Number(tWidth) || 80),
        height: Math.max(20, Number(tHeight) || 80),
        ...policyBody(tPolicy),
      };
      if (tableDialog === 'edit' && selected) {
        return updateTable(selected.id, { ...common, rotation: (Number(tRotation) || 0) % 360 });
      }
      return createTable({ zoneId: zone.id, ...common });
    },
    onSuccess: () => {
      toast.success(t('saved'));
      setTableDialog(null);
      invalidate();
    },
    onError: fail,
  });

  const bulkMut = useMutation({
    mutationFn: () => {
      if (!zone) throw new Error('no zone');
      return bulkAddTables(zone.id, {
        // "1"–"20" as numbers, "3A"–"3L" as typed (the server expands it as lib/tableLabels.ts does).
        from: rangeEndValue(bFrom),
        to: rangeEndValue(bTo),
        seats: Number(tSeats) || 4,
        shape: tShape,
        typeId: tPolicy.typeId || null,
      });
    },
    onSuccess: (out) => {
      toast.success(t('bulkDone', { created: out.created.length, skipped: out.skipped.length }), {
        description: out.skipped.length
          ? t('bulkSkipped', { list: out.skipped.slice(0, 24).join(', ') + (out.skipped.length > 24 ? ', …' : '') })
          : undefined,
      });
      setTableDialog(null);
      invalidate();
    },
    onError: fail,
  });

  const archiveTableMut = useMutation({
    mutationFn: (id: string) => archiveTable(id),
    onSuccess: () => {
      toast.success(t('tableArchived'));
      setTableDialog(null);
      invalidate();
    },
    onError: fail,
  });

  // The floor as it is now, for a preview beside the editor: the zone settings while they are open
  // (a layout switched, a canvas resized, a floor image), the map editor's unsaved plan and moves.
  const live = useMemo<FloorLive | null>(() => {
    if (!zone) return null;
    const editing = zoneDialog === 'edit';
    const layout: ZoneLayout = editing ? zLayout : zone.layout;
    const cw = editing ? canvasOf(zWidth, zone.canvasWidth) : zone.canvasWidth;
    const ch = editing ? canvasOf(zHeight, zone.canvasHeight) : zone.canvasHeight;
    const backgroundUrl = editing ? zBackground : zone.backgroundUrl;
    const fromMap = zone.layout === 'map' && mapLive?.zoneId === zone.id ? mapLive : null;
    let liveTables: PreviewTable[] =
      fromMap?.tables ??
      tables.map((tb) => ({
        id: tb.id, number: tb.number, label: tb.label ?? null, name: tb.name, labelOnly: tb.labelOnly,
        shape: tb.shape, seats: tb.seats, x: tb.x, y: tb.y, width: tb.width, height: tb.height, rotation: tb.rotation,
      }));
    if (layout === 'map' && zone.layout === 'grid') {
      // Squares about to become a map: the tables where "עבור לתצוגת מפה" would put them.
      const placed = new Map(planSwitchToMap(liveTables, cw, ch).map((pl) => [pl.id, pl]));
      liveTables = liveTables.map((tb) => ({ ...tb, ...(placed.get(tb.id) ?? {}) }));
    }
    return {
      shopId,
      zoneId: zone.id,
      zoneName: editing && zName.trim() ? zName.trim() : zone.name,
      layout,
      cw,
      ch,
      backgroundUrl,
      background: fromMap?.background ?? backgroundOf(zone.sketch, !!backgroundUrl),
      elements: fromMap?.elements ?? uniqueElements(zone.sketch?.elements ?? []),
      tables: liveTables,
      logoUrl: data?.logoUrl ?? null,
      dirty: mapDirty,
    };
  }, [zone, zoneDialog, zLayout, zWidth, zHeight, zBackground, zName, mapLive, tables, shopId, data?.logoUrl, mapDirty]);
  useEffect(() => {
    onLive?.(live);
  }, [onLive, live]);

  if (isLoading) return <Skeleton className="h-96 w-full" />;

  return (
    <div className="space-y-3">
      {designLink ? (
        // The owner: the floor is designed first in "עיצוב קופה" — the same editor, with the till's preview.
        <Link
          href="/dashboard/till-design?section=floor"
          className="flex items-center gap-2 rounded-lg border border-sky-300/60 bg-sky-50 px-3 py-2 text-sm text-sky-900 hover:bg-sky-100 dark:border-sky-800 dark:bg-sky-950/40 dark:text-sky-100"
        >
          <LayoutTemplate className="h-4 w-4 shrink-0" />
          <span>{t('designInTill')}</span>
        </Link>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {zones.map((z) => (
          <Button
            key={z.id}
            size="sm"
            variant={zone?.id === z.id ? 'default' : 'outline'}
            onClick={() => {
              if (z.id !== zone?.id && mapDirty && !window.confirm(t('sketch.leaveUnsaved'))) return;
              setMapDirty(false);
              if (z.id !== zone?.id) setSketchZoneId(null);
              setZoneId(z.id);
            }}
          >
            {z.name}
            {z.areaName ? <span className="ms-1 text-xs opacity-70">({z.areaName})</span> : null}
          </Button>
        ))}
        <Button size="sm" variant="ghost" onClick={() => openZone('new')}>
          <Plus className="h-4 w-4 me-1" />
          {t('addZone')}
        </Button>
      </div>

      {!zone ? (
        <div className="rounded-lg border bg-card p-8 text-center text-muted-foreground">{t('noZones')}</div>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => openZone('edit')}>
              {t('zoneSettings')}
            </Button>
            <Button size="sm" onClick={() => openTable('new')}>
              <Plus className="h-4 w-4 me-1" />
              {t('addTable')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => openTable('bulk')}>
              {t('bulkAdd')}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setTypesOpen(true)}>
              {t('policy.typesButton')}
            </Button>
            <span className="text-sm text-muted-foreground">
              {t('zoneSummary', {
                count: tables.length,
                seats: tables.reduce((s, x) => s + (x.seats || 0), 0),
                layout: t(`layout.${zone.layout}`),
              })}
            </span>
          </div>
          {zone.layout === 'map' ? (
            <MapEditor
              key={`${zone.id}:${zone.updatedAt ?? ''}`}
              zone={zone}
              tables={tables}
              onEdit={(tb) => openTable('edit', tb)}
              onSaved={invalidate}
              onError={fail}
              onDirtyChange={setMapDirty}
              logoUrl={data?.logoUrl ?? null}
              initialMode={sketchZoneId === zone.id ? 'sketch' : 'tables'}
              onLive={onLive ? setMapLive : undefined}
              previewButton={!embedded}
            />
          ) : (
            <div className="space-y-3">
              {/* A zone of squares: where its map is designed, and the way there. */}
              <div className="flex flex-wrap items-center gap-3 rounded-lg border border-primary/30 bg-primary/5 p-3">
                <LayoutGrid className="h-5 w-5 shrink-0 text-primary" />
                <p className="min-w-[14rem] flex-1 text-sm">{t('toMap.banner')}</p>
                <Button size="sm" onClick={() => toMapMut.mutate()} disabled={toMapMut.isPending}>
                  <MapIcon className="h-4 w-4 me-1" />
                  {toMapMut.isPending ? tc('loading') : t('toMap.button')}
                </Button>
              </div>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-2">
                {tables.map((tb) => (
                  <button
                    key={tb.id}
                    type="button"
                    onClick={() => openTable('edit', tb)}
                    className="aspect-square rounded-lg border bg-card hover:bg-accent flex flex-col items-center justify-center"
                  >
                    <span className="text-xl font-bold">{tableDisplay(tb).main}</span>
                    {tableDisplay(tb).sub ? (
                      <span className="text-xs text-muted-foreground truncate max-w-full px-1">{tableDisplay(tb).sub}</span>
                    ) : null}
                    <span className="text-xs text-muted-foreground">{t('seatsShort', { seats: tb.seats })}</span>
                    <GridBadge badge={policyBadge(tb.policy)} kindLabel={(k) => t(`policy.badge.${k}`)} />
                  </button>
                ))}
                {tables.length === 0 ? (
                  <div className="col-span-full text-center text-muted-foreground p-6">{t('noTables')}</div>
                ) : null}
              </div>
            </div>
          )}
        </div>
      )}

      <TableTypesDialog
        open={typesOpen}
        shopId={shopId}
        types={tableTypes}
        onClose={() => setTypesOpen(false)}
        onSaved={invalidate}
      />

      <Dialog open={zoneDialog !== null} onOpenChange={(o) => !o && setZoneDialog(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{zoneDialog === 'edit' ? t('zoneSettings') : t('addZone')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label>{t('zoneName')}</Label>
              <Input value={zName} onChange={(e) => setZName(e.target.value)} placeholder={t('zoneNamePlaceholder')} />
            </div>
            <div className="space-y-1">
              <Label>{t('zoneLayout')}</Label>
              <Select value={zLayout} onValueChange={(v) => v && setZLayout(v as ZoneLayout)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="map" label={t('layout.map')}>{t('layout.map')}</SelectItem>
                  <SelectItem value="grid" label={t('layout.grid')}>{t('layout.grid')}</SelectItem>
                </SelectContent>
              </Select>
              {zoneDialog === 'edit' && zone?.layout === 'map' ? (
                // "חזרה לריבועים": this select — the sketch and the tables' places are kept for the way back.
                <p className="text-xs text-muted-foreground">{t('toMap.backHint')}</p>
              ) : null}
            </div>
            <div className="space-y-1">
              <Label>{t('zoneArea')}</Label>
              <Select value={zArea} onValueChange={(v) => v && setZArea(v)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_SHOP} label={t('wholeShop')}>{t('wholeShop')}</SelectItem>
                  {areas.map((a) => (
                    <SelectItem key={a.id} value={a.id} label={a.name}>{a.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">{t('zoneAreaHint')}</p>
            </div>
            {zLayout === 'map' ? (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label>{t('canvasWidth')}</Label>
                    <Input type="number" value={zWidth} onChange={(e) => setZWidth(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label>{t('canvasHeight')}</Label>
                    <Input type="number" value={zHeight} onChange={(e) => setZHeight(e.target.value)} />
                  </div>
                </div>
                <div className="space-y-1">
                  <Label>{t('background')}</Label>
                  <div className="flex items-center gap-2">
                    <label className="inline-flex cursor-pointer items-center gap-1 rounded-md border px-3 py-1.5 text-sm hover:bg-accent">
                      <ImagePlus className="h-4 w-4" />
                      {uploading ? tc('loading') : t('uploadBackground')}
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/webp"
                        className="hidden"
                        disabled={uploading}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) void uploadBackground(file);
                          e.target.value = '';
                        }}
                      />
                    </label>
                    {zBackground ? (
                      <Button size="sm" variant="ghost" onClick={() => setZBackground(null)}>
                        {t('removeBackground')}
                      </Button>
                    ) : null}
                  </div>
                  {zBackground ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={zBackground} alt="" className="mt-2 max-h-32 rounded border object-contain" />
                  ) : null}
                </div>
              </>
            ) : null}
          </div>
          <DialogFooter className="gap-2">
            {zoneDialog === 'edit' && zone ? (
              <Button
                variant="destructive"
                className="me-auto"
                disabled={archiveZoneMut.isPending}
                onClick={() => {
                  if (window.confirm(t('archiveZoneConfirm', { name: zone.name }))) archiveZoneMut.mutate(zone.id);
                }}
              >
                <Trash2 className="h-4 w-4 me-1" />
                {t('archiveZone')}
              </Button>
            ) : null}
            <Button variant="outline" onClick={() => setZoneDialog(null)}>
              {tc('cancel')}
            </Button>
            <Button onClick={() => zoneMut.mutate()} disabled={zoneMut.isPending || uploading || !zName.trim()}>
              {zoneMut.isPending ? tc('saving') : tc('save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={tableDialog !== null} onOpenChange={(o) => !o && setTableDialog(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {tableDialog === 'bulk' ? t('bulkAdd') : tableDialog === 'edit' ? t('editTable') : t('addTable')}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            {tableDialog === 'bulk' ? (
              <>
                <p className="text-sm text-muted-foreground">{t('bulkHint', { zone: zone?.name ?? '' })}</p>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <Label htmlFor="bulk-from">{t('bulkFrom')}</Label>
                    <Input id="bulk-from" dir="auto" maxLength={16} value={bFrom} onChange={(e) => setBFrom(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="bulk-to">{t('bulkTo')}</Label>
                    <Input id="bulk-to" dir="auto" maxLength={16} value={bTo} onChange={(e) => setBTo(e.target.value)} />
                  </div>
                </div>
                {bFrom.trim() && bTo.trim() ? (
                  rangeCheck.error ? (
                    <p role="alert" className="text-xs text-destructive">{t('labelError', { reason: rangeCheck.error })}</p>
                  ) : rangeCheck.items?.length ? (
                    <p className="text-xs text-muted-foreground">
                      {t('bulkPreview', {
                        count: rangeCheck.items.length,
                        first: shownOf(rangeCheck.items[0].number, rangeCheck.items[0].label),
                        last: shownOf(rangeCheck.items[rangeCheck.items.length - 1].number, rangeCheck.items[rangeCheck.items.length - 1].label),
                      })}
                    </p>
                  ) : null
                ) : null}
              </>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <div className="col-span-2 space-y-1">
                  <Label htmlFor="table-number">{t('tableNumber')}</Label>
                  <Input
                    id="table-number"
                    dir="auto"
                    maxLength={16}
                    value={tNumber}
                    aria-invalid={!!tNumber.trim() && !!numberCheck.error}
                    onChange={(e) => setTNumber(e.target.value)}
                  />
                  {tNumber.trim() && numberCheck.error ? (
                    <p role="alert" className="text-xs text-destructive">{t('labelError', { reason: numberCheck.error })}</p>
                  ) : (
                    <p className="text-xs text-muted-foreground">{t('tableNumberHint')}</p>
                  )}
                </div>
                <div className="col-span-2 space-y-1">
                  <Label>{t('tableName')}</Label>
                  <Input value={tName} onChange={(e) => setTName(e.target.value)} placeholder={t('tableNamePlaceholder')} />
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label>{t('seats')}</Label>
                <Input type="number" min={0} value={tSeats} onChange={(e) => setTSeats(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>{t('shape')}</Label>
                <Select value={tShape} onValueChange={(v) => v && setTShape(v as TableShape)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SHAPES.map((s) => (
                      <SelectItem key={s} value={s} label={t(`shapes.${s}`)}>{t(`shapes.${s}`)}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            {tableDialog !== 'bulk' && zone?.layout === 'map' ? (
              <div className="grid grid-cols-3 gap-2">
                <div className="space-y-1">
                  <Label>{t('width')}</Label>
                  <Input type="number" min={20} value={tWidth} onChange={(e) => setTWidth(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label>{t('height')}</Label>
                  <Input type="number" min={20} value={tHeight} onChange={(e) => setTHeight(e.target.value)} />
                </div>
                {tableDialog === 'edit' ? (
                  <div className="space-y-1">
                    <Label>{t('rotation')}</Label>
                    <Input type="number" min={0} max={359} value={tRotation} onChange={(e) => setTRotation(e.target.value)} />
                  </div>
                ) : null}
              </div>
            ) : null}
            {firstLabelWarning ? (
              // §6.5: the shop's first label — the tills that show it but cannot type it on the keypad.
              <div
                role="alert"
                className="space-y-1 rounded-md border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900 dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-200"
              >
                <p className="font-medium">{t('labelsOldDevices')}</p>
                <ul className="list-disc ps-4">
                  {cannotType.map((d) => (
                    <li key={d.machineId}>
                      {d.name}
                      {d.appVersion ? ` · ${t('oldDeviceVersion', { version: d.appVersion })}` : ''}
                    </li>
                  ))}
                </ul>
                <p>{t('labelsOldDevicesHint')}</p>
              </div>
            ) : null}
            {tableDialog === 'bulk' ? (
              tableTypes.length > 0 ? (
                <div className="space-y-1">
                  <Label>{t('policy.type')}</Label>
                  <Select
                    value={tPolicy.typeId || NO_TYPE}
                    onValueChange={(v) => v && setTPolicy({ ...tPolicy, typeId: v === NO_TYPE ? '' : v })}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_TYPE} label={t('policy.kinds.regular')}>{t('policy.kinds.regular')}</SelectItem>
                      {tableTypes.map((ty) => (
                        <SelectItem key={ty.id} value={ty.id} label={ty.name}>{ty.name}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ) : null
            ) : (
              <PolicyFields draft={tPolicy} types={tableTypes} onChange={setTPolicy} />
            )}
          </div>
          <DialogFooter className="gap-2">
            {tableDialog === 'edit' && selected ? (
              <Button
                variant="destructive"
                className="me-auto"
                disabled={archiveTableMut.isPending}
                onClick={() => {
                  if (window.confirm(t('archiveTableConfirm', { number: tableDisplay(selected).text }))) {
                    archiveTableMut.mutate(selected.id);
                  }
                }}
              >
                <Trash2 className="h-4 w-4 me-1" />
                {t('archiveTable')}
              </Button>
            ) : null}
            <Button variant="outline" onClick={() => setTableDialog(null)}>
              {tc('cancel')}
            </Button>
            {tableDialog === 'bulk' ? (
              <Button onClick={() => bulkMut.mutate()} disabled={bulkMut.isPending || !bFrom.trim() || !bTo.trim() || !!rangeCheck.error}>
                {bulkMut.isPending ? tc('saving') : t('bulkAddAction')}
              </Button>
            ) : (
              <Button
                onClick={() => tableMut.mutate()}
                disabled={tableMut.isPending || !tNumber.trim() || !!numberCheck.error || policyErrors.length > 0}
              >
                {tableMut.isPending ? tc('saving') : tc('save')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
