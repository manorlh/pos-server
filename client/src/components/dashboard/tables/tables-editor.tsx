'use client';

/**
 * The floor editor: a shop's zones as tabs; each zone a map (see MapEditor: the floor,
 * a sketch from a template or drawn, tables dragged, resized, duplicated) or a grid
 * (squares by number). Tables are added one by one or as a range ("1–100"); their number
 * is unique in the shop.
 */

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ImagePlus, Plus, Trash2 } from 'lucide-react';
import { uploadProductImage } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import {
  archiveTable,
  archiveZone,
  bulkAddTables,
  createTable,
  createZone,
  fetchTablesLayout,
  tablesErrorCode,
  updateTable,
  updateZone,
  type DiningTable,
  type TableShape,
  type ZoneLayout,
} from '@/lib/tablesApi';
import { defaultTableSize } from '@/lib/tableSketch';
import { useShopAreas } from '@/components/dashboard/areas/use-shop-areas';
import { MapEditor } from '@/components/dashboard/tables/map-editor';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

const SHAPES: TableShape[] = ['round', 'square', 'rect'];
const ALL_SHOP = '__shop__';

export function TablesEditor({ shopId }: { shopId: string }) {
  const t = useTranslations('tables');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const layoutKey = ['tables-layout', shopId];
  const { data, isLoading } = useQuery({ queryKey: layoutKey, queryFn: () => fetchTablesLayout(shopId) });
  const { data: areas = [] } = useShopAreas(shopId);

  const zones = useMemo(() => data?.zones ?? [], [data]);
  const [zoneId, setZoneId] = useState<string | null>(null);
  // The map editor has moves or sketch edits not saved yet: asked before leaving the zone.
  const [mapDirty, setMapDirty] = useState(false);
  const zone = zones.find((z) => z.id === zoneId) ?? zones[0] ?? null;
  const tables = useMemo(
    () => (data?.tables ?? []).filter((tb) => zone && tb.zoneId === zone.id).sort((a, b) => a.number - b.number),
    [data, zone],
  );

  const invalidate = () => qc.invalidateQueries({ queryKey: layoutKey });
  const fail = (err: unknown) => {
    const code = tablesErrorCode(err);
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
      const result = await uploadProductImage(file, 'products');
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

  const openTable = (mode: 'new' | 'edit' | 'bulk', table?: DiningTable) => {
    setTableDialog(mode);
    setSelected(table ?? null);
    const next = Math.max(0, ...(data?.tables ?? []).map((x) => x.number)) + 1;
    setTNumber(String(table?.number ?? next));
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
  };

  const tableMut = useMutation({
    mutationFn: async () => {
      if (!zone) throw new Error('no zone');
      const common = {
        number: Number(tNumber),
        name: tName.trim() || null,
        seats: Number(tSeats) || 0,
        shape: tShape,
        width: Math.max(20, Number(tWidth) || 80),
        height: Math.max(20, Number(tHeight) || 80),
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
      return bulkAddTables(zone.id, { from: Number(bFrom), to: Number(bTo), seats: Number(tSeats) || 4, shape: tShape });
    },
    onSuccess: (out) => {
      toast.success(t('bulkDone', { created: out.created.length, skipped: out.skipped.length }));
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

  if (isLoading) return <Skeleton className="h-96 w-full" />;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {zones.map((z) => (
          <Button
            key={z.id}
            size="sm"
            variant={zone?.id === z.id ? 'default' : 'outline'}
            onClick={() => {
              if (z.id !== zone?.id && mapDirty && !window.confirm(t('sketch.leaveUnsaved'))) return;
              setMapDirty(false);
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
            />
          ) : (
            <div className="grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-2">
              {tables.map((tb) => (
                <button
                  key={tb.id}
                  type="button"
                  onClick={() => openTable('edit', tb)}
                  className="aspect-square rounded-lg border bg-card hover:bg-accent flex flex-col items-center justify-center"
                >
                  <span className="text-xl font-bold">{tb.number}</span>
                  {tb.name ? <span className="text-xs text-muted-foreground truncate max-w-full px-1">{tb.name}</span> : null}
                  <span className="text-xs text-muted-foreground">{t('seatsShort', { seats: tb.seats })}</span>
                </button>
              ))}
              {tables.length === 0 ? (
                <div className="col-span-full text-center text-muted-foreground p-6">{t('noTables')}</div>
              ) : null}
            </div>
          )}
        </div>
      )}

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
                    <Label>{t('bulkFrom')}</Label>
                    <Input type="number" min={1} value={bFrom} onChange={(e) => setBFrom(e.target.value)} />
                  </div>
                  <div className="space-y-1">
                    <Label>{t('bulkTo')}</Label>
                    <Input type="number" min={1} value={bTo} onChange={(e) => setBTo(e.target.value)} />
                  </div>
                </div>
              </>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label>{t('tableNumber')}</Label>
                  <Input type="number" min={1} value={tNumber} onChange={(e) => setTNumber(e.target.value)} />
                </div>
                <div className="space-y-1">
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
          </div>
          <DialogFooter className="gap-2">
            {tableDialog === 'edit' && selected ? (
              <Button
                variant="destructive"
                className="me-auto"
                disabled={archiveTableMut.isPending}
                onClick={() => {
                  if (window.confirm(t('archiveTableConfirm', { number: selected.number }))) {
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
              <Button onClick={() => bulkMut.mutate()} disabled={bulkMut.isPending || !bFrom || !bTo}>
                {bulkMut.isPending ? tc('saving') : t('bulkAddAction')}
              </Button>
            ) : (
              <Button onClick={() => tableMut.mutate()} disabled={tableMut.isPending || !tNumber}>
                {tableMut.isPending ? tc('saving') : tc('save')}
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
