'use client';

/**
 * The map editor of one zone: the floor drawn as an SVG in the zone's canvas units —
 * the uploaded floor plan, then the sketch (walls, entrance, bar, kitchen…), then the
 * tables. Two modes:
 *
 * * **Tables** — click selects (Shift / Ctrl adds to the selection), drag moves every
 *   selected table, the corner handle resizes (all selected tables take the same size),
 *   double-click opens a table's details. The bar below sets size, shape and rotation for
 *   the selection and duplicates it.
 * * **Sketch** — start from a ready-made template, add shapes from the palette (its tabs —
 *   service, guests, atmosphere, safety, structure — and its search; sketch schema 3,
 *   P:/specs/table-map-decor-v3.md §4), drag them, resize them from the corner, set their
 *   text, rotation, variant and colour, duplicate them in a row; an area's fill and opacity.
 * * **Draw** — lines, walls, rectangles, an area's polygon, freehand, text and an eraser, in
 *   a colour and a width (./sketch-draw.tsx). Drawings lie under the tables, like the sketch.
 *
 * Undo and redo (Ctrl+Z / Ctrl+Y, and the buttons) step through the sketch's changes.
 * Nothing is written until "שמור" (positions in one write, the sketch with the zone).
 * Snap to grid rounds every move and size to 10 canvas units; snap to the walls lays a
 * moved shape flush against a wall it comes near. "תצוגה בקופה" shows the map as the till
 * will (./sketch-preview.tsx). The shapes are drawn by ./sketch-shapes.tsx.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Brush,
  Copy,
  CopyPlus,
  Grid3x3,
  Magnet,
  Maximize2,
  MonitorSmartphone,
  MousePointer2,
  PenTool,
  Redo2,
  RotateCcw,
  RotateCw,
  Save,
  Search,
  Trash2,
  Undo2,
} from 'lucide-react';
import {
  createTable,
  saveTablePositions,
  updateTable,
  updateZone,
  type DiningTable,
  type TableShape,
  type TableZone,
} from '@/lib/tablesApi';
import {
  AREA_FILL_NAMES,
  AREA_FILLS,
  AREA_OPACITY,
  DUPLICATE_DIRECTIONS,
  DUPLICATE_MAX,
  GREENERY_KINDS,
  PALETTE,
  PALETTE_TAB_NAMES,
  PALETTE_TABS,
  VARIANT_CHOICES,
  VARIANT_NAMES,
  WALL_KINDS,
  backgroundOf,
  clampOpacity,
  clampSize,
  counterGeometry,
  defaultText,
  drawOrder,
  duplicateMany,
  entryName,
  hasPoints,
  isDrawn,
  isPolygonArea,
  newElement,
  newElementId,
  PLAIN,
  resized,
  rotatePoint,
  searchPalette,
  SKETCH_BACKGROUNDS,
  SKETCH_TEMPLATES,
  snapToWalls,
  translated,
  turnedBox,
  variantOf,
  wallBoxes,
  CHAIR_LOOK,
  CLEAN,
  LABEL_TEXT_MAX,
  SKETCH_TEXT_MAX,
  cleanText,
  chairLayout,
  TABLE_LOOK,
  templateSketch,
  TILE,
  WOOD,
  type DuplicateDirection,
  type PaletteEntry,
  type PaletteTab,
  type Sketch,
  type SketchBackground,
  type SketchElement,
  type SketchKind,
  type SketchTemplate,
  uniqueElements,
} from '@/lib/tableSketch';
import { policyBadge } from '@/lib/tablePolicy';
import { tableDisplay } from '@/lib/tableRestore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DrawOverlay, DrawPanel, useDrawTools, useSketchHistory } from './sketch-draw';
import { FloorDefs, KindIcon, SketchShape, hasSymbol } from './sketch-shapes';
import { TillPreview, type PreviewTable } from './sketch-preview';
import { LabelStyle, LogoPanel } from './sketch-text-logo';

type Pos = { x: number; y: number; width: number; height: number; rotation: number };

/** The map as the editor holds it now (saved or not): its plan, its floor, its tables where they stand. */
export interface MapLive {
  zoneId: string;
  elements: SketchElement[];
  background: SketchBackground;
  tables: PreviewTable[];
}
type Pt = { x: number; y: number };
type Drag =
  | { type: 'tables'; ids: string[]; start: Pt; from: Record<string, Pos>; travelled: number }
  | { type: 'table-size'; ids: string[]; start: Pt; from: Pos; round: boolean }
  | { type: 'element'; id: string; start: Pt; from: SketchElement }
  | { type: 'element-size'; id: string; start: Pt; from: SketchElement };

const GRID = 10;
const SHAPES: TableShape[] = ['round', 'square', 'rect'];
/** A symbol's own colours (v3 §4): none is the theme's. */
const SYMBOL_COLORS = ['#0f172a', '#2563eb', '#0d9488', '#16a34a', '#d97706', '#dc2626', '#db2777', '#7c3aed', '#6b4423'] as const;
const SELECT =
  'border-input bg-background h-8 rounded-md border px-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
/** The kinds with no words of their own: the room's frame, a bar with stools, the logo, the greenery. */
const NO_TEXT = new Set<SketchKind>(['wall', 'window', 'column', 'counter', 'logo', ...GREENERY_KINDS]);

/** Who takes a colour of their own: the symbols, the greenery, the arrow, a text. */
function takesColour(el: SketchElement): boolean {
  return hasSymbol(el.kind, el.variant) || GREENERY_KINDS.includes(el.kind) || el.kind === 'arrow' || el.kind === 'label';
}

export function MapEditor({
  zone,
  tables,
  onEdit,
  onSaved,
  onError,
  onDirtyChange,
  logoUrl = null,
  initialMode = 'tables',
  onLive,
  previewButton = true,
}: {
  zone: TableZone;
  tables: DiningTable[];
  onEdit: (table: DiningTable) => void;
  onSaved: () => void;
  onError: (err: unknown) => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** The business's logo: what a "logo" shape shows when it has no picture of its own. */
  logoUrl?: string | null;
  /** The mode it opens in: "סקיצה" right after a zone of squares became a map. */
  initialMode?: 'tables' | 'sketch' | 'draw';
  /**
   * The map as it is now, saved or not, on every change — for a preview beside the editor (the till
   * design's "שולחנות ומפה", P:/specs/till-design-tables.md). A stable function (a state setter).
   */
  onLive?: (live: MapLive) => void;
  /** Its own "תצוגה בקופה" (none where a preview already stands beside it). */
  previewButton?: boolean;
}) {
  const t = useTranslations('tables');
  const cw = zone.canvasWidth;
  const ch = zone.canvasHeight;
  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [boxWidth, setBoxWidth] = useState(800);
  const [mode, setMode] = useState<'tables' | 'sketch' | 'draw'>(initialMode);
  const [snap, setSnap] = useState(true);
  /** "הצמדה לקירות": a shape moved near a wall lies flush against it. */
  const [wallSnap, setWallSnap] = useState(true);
  const [paletteTab, setPaletteTab] = useState<PaletteTab>('guests');
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState(false);
  /** "שכפול מרובה": how many copies, which way, how far apart (canvas units). */
  const [dup, setDup] = useState<{ count: number; dir: DuplicateDirection; gap: number }>({ count: 3, dir: 'left', gap: 10 });
  const [moved, setMoved] = useState<Record<string, Pos>>({});
  const [selected, setSelected] = useState<string[]>([]);
  const [sketch, setSketch] = useState<Sketch>(() => ({
    template: zone.sketch?.template ?? null,
    background: zone.sketch?.background ?? null,
    elements: uniqueElements(zone.sketch?.elements ?? []),
  }));
  const background = backgroundOf(sketch, !!zone.backgroundUrl);
  const [sketchDirty, setSketchDirty] = useState(false);
  const [selectedEl, setSelectedEl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const drag = useRef<Drag | null>(null);

  // The sketch as it is now, for the history and the drawing tools' handlers.
  const sketchRef = useRef(sketch);
  sketchRef.current = sketch;
  const applySketch = useCallback((s: Sketch) => {
    sketchRef.current = s;
    setSketch(s);
    setSketchDirty(true);
  }, []);
  const history = useSketchHistory(sketchRef, applySketch);
  /** One step back per edit: a patch typed letter by letter is one step. */
  const lastPatch = useRef<{ id: string; at: number } | null>(null);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setBoxWidth(el.clientWidth || 800));
    observer.observe(el);
    setBoxWidth(el.clientWidth || 800);
    return () => observer.disconnect();
  }, []);

  const dirty = sketchDirty || Object.keys(moved).length > 0;
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange]);
  // Every move, shape and floor at once to a preview beside it, before anything is saved.
  useEffect(() => {
    if (!onLive) return;
    onLive({
      zoneId: zone.id,
      elements: sketch.elements,
      background,
      tables: tables.map((tb) => {
        const p = moved[tb.id] ?? { x: tb.x, y: tb.y, width: tb.width, height: tb.height, rotation: tb.rotation };
        return { id: tb.id, number: tb.number, shape: tb.shape, seats: tb.seats, x: p.x, y: p.y, width: p.width, height: p.height, rotation: p.rotation };
      }),
    });
  }, [onLive, zone.id, sketch.elements, background, tables, moved]);

  const perPx = cw / Math.max(1, boxWidth);
  const snapV = (v: number) => (snap ? Math.round(v / GRID) * GRID : Math.round(v));
  const byId = useMemo(() => new Map(tables.map((tb) => [tb.id, tb])), [tables]);
  const posOf = (tb: DiningTable): Pos =>
    moved[tb.id] ?? { x: tb.x, y: tb.y, width: tb.width, height: tb.height, rotation: tb.rotation };
  const element = sketch.elements.find((e) => e.id === selectedEl) ?? null;

  const toCanvas = (e: { clientX: number; clientY: number }): Pt => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: ((e.clientX - rect.left) * cw) / rect.width, y: ((e.clientY - rect.top) * ch) / rect.height };
  };

  const draw = useDrawTools({
    active: mode === 'draw',
    sketchRef,
    setSketch: applySketch,
    snapshot: history.snapshot,
    undo: history.undo,
    redo: history.redo,
    cw,
    ch,
    perPx,
    gridSnap: snap,
    toCanvas,
    capture: (e) => svgRef.current?.setPointerCapture(e.pointerId),
  });

  // The sketch mode's keys (the drawing tools have their own, and these too).
  useEffect(() => {
    if (mode !== 'sketch') return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'z' && !e.shiftKey) {
        e.preventDefault();
        history.undo();
      } else if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) {
        e.preventDefault();
        history.redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, history]);

  const setPos = (updates: Record<string, Pos>) => setMoved((m) => ({ ...m, ...updates }));
  const editSketch = (fn: (elements: SketchElement[]) => SketchElement[]) => {
    applySketch({ ...sketchRef.current, elements: fn(sketchRef.current.elements) });
  };

  // ── Pointer ─────────────────────────────────────────────────────────────────
  const startTable = (e: React.PointerEvent, tb: DiningTable) => {
    if (mode !== 'tables') return;
    e.stopPropagation();
    svgRef.current?.setPointerCapture(e.pointerId);
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    let ids = selected;
    if (additive) {
      ids = selected.includes(tb.id) ? selected.filter((i) => i !== tb.id) : [...selected, tb.id];
      setSelected(ids);
      if (!ids.includes(tb.id)) return;
    } else if (!selected.includes(tb.id)) {
      ids = [tb.id];
      setSelected(ids);
    }
    const from: Record<string, Pos> = {};
    for (const id of ids) {
      const other = byId.get(id);
      if (other) from[id] = posOf(other);
    }
    drag.current = { type: 'tables', ids, start: toCanvas(e), from, travelled: 0 };
  };

  const startTableSize = (e: React.PointerEvent, tb: DiningTable) => {
    e.stopPropagation();
    svgRef.current?.setPointerCapture(e.pointerId);
    const ids = selected.includes(tb.id) ? selected : [tb.id];
    drag.current = { type: 'table-size', ids, start: toCanvas(e), from: posOf(tb), round: tb.shape !== 'rect' };
  };

  const startElement = (e: React.PointerEvent, el: SketchElement, resize = false) => {
    if (mode !== 'sketch') return;
    e.stopPropagation();
    svgRef.current?.setPointerCapture(e.pointerId);
    setSelectedEl(el.id);
    history.snapshot();
    drag.current = { type: resize ? 'element-size' : 'element', id: el.id, start: toCanvas(e), from: el };
  };

  const onMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = toCanvas(e);
    const dx = p.x - d.start.x;
    const dy = p.y - d.start.y;
    if (d.type === 'tables') {
      d.travelled = Math.max(d.travelled, Math.abs(dx) + Math.abs(dy));
      const updates: Record<string, Pos> = {};
      for (const id of d.ids) {
        const f = d.from[id];
        if (!f) continue;
        updates[id] = {
          ...f,
          x: Math.min(Math.max(0, snapV(f.x + dx)), cw - f.width),
          y: Math.min(Math.max(0, snapV(f.y + dy)), ch - f.height),
        };
      }
      setPos(updates);
    } else if (d.type === 'table-size') {
      let w = clampSize(snapV(d.from.width + dx));
      let h = clampSize(snapV(d.from.height + dy));
      if (d.round) w = h = Math.max(w, h);
      const updates: Record<string, Pos> = {};
      for (const id of d.ids) {
        const tb = byId.get(id);
        if (!tb) continue;
        const cur = posOf(tb);
        const keepSquare = tb.shape !== 'rect';
        const ww = keepSquare ? Math.max(w, h) : w;
        const hh = keepSquare ? Math.max(w, h) : h;
        updates[id] = { ...cur, width: ww, height: hh };
      }
      setPos(updates);
    } else if (d.type === 'element') {
      const f = d.from;
      // On the grid; then, near a wall, flush against it (not a wall itself, nor an area).
      let next = translated(f, snapV(f.x + dx) - f.x, snapV(f.y + dy) - f.y);
      if (wallSnap && !WALL_KINDS.includes(f.kind) && f.kind !== 'area' && !hasPoints(f.kind)) {
        const s = snapToWalls(turnedBox(next), wallBoxes(sketchRef.current.elements, f.id), Math.max(GRID, 14 * perPx));
        if (s.dx || s.dy) next = translated(next, s.dx, s.dy);
      }
      editSketch((els) => els.map((el) => (el.id !== d.id ? el : { ...el, x: next.x, y: next.y, ...(next.points ? { points: next.points } : {}) })));
    } else if (d.type === 'element-size') {
      const f = d.from;
      // A drawn line keeps its ends; an area's polygon is scaled with its box.
      if (!hasPoints(f.kind)) {
        const next = resized(f, snapV(f.w + dx), snapV(f.h + dy));
        editSketch((els) => els.map((el) => (el.id !== d.id ? el : { ...el, w: next.w, h: next.h, ...(next.points ? { points: next.points } : {}) })));
      }
    }
  };

  const onUp = () => {
    drag.current = null;
  };

  const onBackgroundDown = () => {
    if (mode === 'tables') setSelected([]);
    else setSelectedEl(null);
  };

  const svgDown = (e: React.PointerEvent) => (mode === 'draw' ? draw.onDown(e) : onBackgroundDown());
  const svgMove = (e: React.PointerEvent) => (mode === 'draw' ? draw.onMove(e) : onMove(e));
  const svgUp = () => (mode === 'draw' ? draw.onUp() : onUp());

  // ── Selection actions ───────────────────────────────────────────────────────
  const selectedTables = selected.map((id) => byId.get(id)).filter((x): x is DiningTable => !!x);
  const first = selectedTables[0];
  const firstPos = first ? posOf(first) : null;

  const setSelectedSize = (w: number | null, h: number | null) => {
    const updates: Record<string, Pos> = {};
    for (const tb of selectedTables) {
      const cur = posOf(tb);
      const width = w != null ? clampSize(w) : cur.width;
      const height = tb.shape === 'rect' ? (h != null ? clampSize(h) : cur.height) : width;
      updates[tb.id] = { ...cur, width, height };
    }
    setPos(updates);
  };

  const rotateSelected = () => {
    const updates: Record<string, Pos> = {};
    for (const tb of selectedTables) {
      const cur = posOf(tb);
      updates[tb.id] = { ...cur, rotation: (cur.rotation + 45) % 360 };
    }
    setPos(updates);
  };

  const setShape = async (shape: TableShape) => {
    try {
      for (const tb of selectedTables) {
        const cur = posOf(tb);
        const side = Math.max(cur.width, cur.height);
        const size = shape === 'rect' ? { width: clampSize(side * 1.5), height: clampSize(side * 0.8) } : { width: side, height: side };
        await updateTable(tb.id, { shape, ...size });
        setMoved((m) => {
          const rest = { ...m };
          delete rest[tb.id];
          return rest;
        });
      }
      onSaved();
    } catch (err) {
      onError(err);
    }
  };

  const duplicate = async () => {
    try {
      let next = Math.max(0, ...tables.map((x) => x.number)) + 1;
      for (const tb of selectedTables) {
        const cur = posOf(tb);
        await createTable({
          zoneId: zone.id,
          number: next++,
          seats: tb.seats,
          shape: tb.shape,
          width: cur.width,
          height: cur.height,
          x: Math.min(cw - cur.width, cur.x + 20),
          y: Math.min(ch - cur.height, cur.y + 20),
        });
      }
      onSaved();
    } catch (err) {
      onError(err);
    }
  };

  // ── Save / undo ─────────────────────────────────────────────────────────────
  const save = async () => {
    setSaving(true);
    try {
      const items = Object.entries(moved).map(([id, p]) => ({
        id, x: p.x, y: p.y, width: p.width, height: p.height, rotation: p.rotation,
      }));
      if (items.length) await saveTablePositions(zone.id, items);
      if (sketchDirty) await saveSketch(sketch);
      setMoved({});
      setSketchDirty(false);
      onSaved();
    } catch (err) {
      onError(err);
    } finally {
      setSaving(false);
    }
  };

  const saveSketch = (s: Sketch) =>
    updateZone(zone.id, {
      sketch:
        s.elements.length || s.background
          ? { template: s.template ?? null, background: s.background ?? null, elements: s.elements }
          : null,
    });

  const undo = () => {
    setMoved({});
    setSketch({
      template: zone.sketch?.template ?? null,
      background: zone.sketch?.background ?? null,
      elements: uniqueElements(zone.sketch?.elements ?? []),
    });
    setSketchDirty(false);
    setSelectedEl(null);
    draw.setSelected([]);
    history.reset();
  };

  const setBackground = (bg: SketchBackground) => {
    history.snapshot();
    applySketch({ ...sketchRef.current, background: bg });
  };

  /**
   * A counter's stools become tables of their own (bar service): small round tables
   * numbered after the shop's last, where the stools were; the counter keeps no stools.
   * Written at once — the sketch with it — so the two can never disagree.
   */
  const stoolsToTables = async (el: SketchElement) => {
    const { stools } = counterGeometry(el);
    if (!stools.length) return;
    try {
      let next = Math.max(0, ...tables.map((x) => x.number)) + 1;
      for (const s of stools) {
        const size = clampSize(s.r * 2);
        const c = rotatePoint(el, s.cx, s.cy);
        await createTable({
          zoneId: zone.id,
          number: next++,
          seats: 1,
          shape: 'round',
          width: size,
          height: size,
          x: Math.max(0, Math.min(cw - size, Math.round(c.x - size / 2))),
          y: Math.max(0, Math.min(ch - size, Math.round(c.y - size / 2))),
        });
      }
      const updated = { ...sketch, elements: sketch.elements.map((e) => (e.id === el.id ? { ...e, stools: 0 } : e)) };
      await saveSketch(updated);
      setSketch(updated);
      setSketchDirty(false);
      onSaved();
    } catch (err) {
      onError(err);
    }
  };

  const applyTemplate = (tpl: SketchTemplate) => {
    if (sketch.elements.length && !window.confirm(t('sketch.replaceConfirm'))) return;
    history.snapshot();
    applySketch({ ...templateSketch(tpl, cw, ch), background: sketchRef.current.background ?? null });
    setSelectedEl(null);
  };

  const addElement = ({ kind, variant }: PaletteEntry) => {
    const el = newElement(kind, cw, ch, variant);
    history.snapshot();
    editSketch((els) => [...els, el]);
    setSelectedEl(el.id);
  };

  /** An area drawn corner by corner: the drawing mode's area tool. */
  const drawArea = () => {
    setMode('draw');
    draw.chooseTool('area');
  };

  /** "שכפול מרובה": copies of the picked shape in a row, the last of them picked. */
  const duplicateRow = (el: SketchElement) => {
    const copies = duplicateMany(el, dup.count, dup.dir, dup.gap, cw, ch);
    if (!copies.length) return;
    history.snapshot();
    editSketch((els) => [...els, ...copies]);
    setSelectedEl(copies[copies.length - 1].id);
  };

  const paletteEntries = query.trim() ? searchPalette(query) : PALETTE[paletteTab];

  /** An element changed from its panel: one step back per element, however many keys. */
  const patchById = (id: string, patch: Partial<SketchElement>) => {
    const now = Date.now();
    if (!lastPatch.current || lastPatch.current.id !== id || now - lastPatch.current.at > 1500) history.snapshot();
    lastPatch.current = { id, at: now };
    editSketch((els) => els.map((el) => (el.id === id ? { ...el, ...patch } : el)));
  };

  const patchElement = (patch: Partial<SketchElement>) => {
    if (!element) return;
    patchById(element.id, patch);
  };

  // ── Render ──────────────────────────────────────────────────────────────────
  const handle = 14 * perPx;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant={mode === 'tables' ? 'default' : 'outline'} onClick={() => setMode('tables')}>
          <MousePointer2 className="h-4 w-4 me-1" />
          {t('sketch.modeTables')}
        </Button>
        <Button size="sm" variant={mode === 'sketch' ? 'default' : 'outline'} onClick={() => setMode('sketch')}>
          <PenTool className="h-4 w-4 me-1" />
          {t('sketch.modeSketch')}
        </Button>
        <Button size="sm" variant={mode === 'draw' ? 'default' : 'outline'} onClick={() => setMode('draw')}>
          <Brush className="h-4 w-4 me-1" />
          {t('sketch.modeDraw')}
        </Button>
        <Button size="sm" variant={snap ? 'secondary' : 'ghost'} onClick={() => setSnap((s) => !s)}>
          <Grid3x3 className="h-4 w-4 me-1" />
          {snap ? t('sketch.snapOn') : t('sketch.snapOff')}
        </Button>
        {mode !== 'tables' ? (
          <Button size="sm" variant={wallSnap ? 'secondary' : 'ghost'} onClick={() => setWallSnap((s) => !s)} title={t('sketch.snapWallsHint')}>
            <Magnet className="h-4 w-4 me-1" />
            {wallSnap ? t('sketch.snapWallsOn') : t('sketch.snapWallsOff')}
          </Button>
        ) : null}
        {previewButton ? (
          <Button size="sm" variant={preview ? 'default' : 'outline'} onClick={() => setPreview((p) => !p)}>
            <MonitorSmartphone className="h-4 w-4 me-1" />
            {t('sketch.preview.button')}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={saving || dirty || (cw >= 5000 && ch >= 5000)}
          title={dirty ? t('sketch.enlargeSaveFirst') : `${cw}×${ch}`}
          onClick={async () => {
            // More floor for more tables: a quarter wider and taller, to the right and down,
            // so nothing already on it moves.
            try {
              await updateZone(zone.id, {
                canvasWidth: Math.min(5000, Math.round(cw * 1.25)),
                canvasHeight: Math.min(5000, Math.round(ch * 1.25)),
              });
              onSaved();
            } catch (err) {
              onError(err);
            }
          }}
        >
          <Maximize2 className="h-4 w-4 me-1" />
          {t('sketch.enlarge')}
        </Button>
        <div className="flex items-center gap-1 rounded-lg border px-1 py-0.5">
          <span className="text-xs text-muted-foreground px-1">{t('sketch.floor')}</span>
          {SKETCH_BACKGROUNDS.filter((bg) => bg !== 'image' || zone.backgroundUrl).map((bg) => (
            <button
              key={bg}
              type="button"
              title={t(`sketch.floorKind.${bg}`)}
              onClick={() => setBackground(bg)}
              className={`h-6 w-6 rounded-md border-2 ${background === bg ? 'border-amber-500' : 'border-transparent'}`}
              style={floorSwatch(bg, zone.backgroundUrl)}
            />
          ))}
        </div>
        <div className="ms-auto flex items-center gap-2">
          {dirty ? <span className="text-xs text-orange-700">{t('sketch.unsaved')}</span> : null}
          {mode !== 'tables' ? (
            <>
              <Button size="sm" variant="ghost" onClick={history.undo} disabled={!history.canUndo} title={t('sketch.undo')}>
                <Undo2 className="h-4 w-4" />
              </Button>
              <Button size="sm" variant="ghost" onClick={history.redo} disabled={!history.canRedo} title={t('sketch.redo')}>
                <Redo2 className="h-4 w-4" />
              </Button>
            </>
          ) : null}
          <Button size="sm" variant="ghost" onClick={undo} disabled={!dirty || saving}>
            <RotateCcw className="h-4 w-4 me-1" />
            {t('undoPositions')}
          </Button>
          <Button size="sm" onClick={save} disabled={!dirty || saving}>
            <Save className="h-4 w-4 me-1" />
            {t('savePositions')}
          </Button>
        </div>
      </div>

      {mode === 'draw' ? (
        <DrawPanel
          tools={draw}
          canUndo={history.canUndo}
          canRedo={history.canRedo}
          undo={history.undo}
          redo={history.redo}
          label={
            draw.selected.length === 1
              ? (sketch.elements.find((x) => x.id === draw.selected[0] && x.kind === 'label') ?? null)
              : null
          }
          onLabelText={(text) => draw.selected[0] && patchById(draw.selected[0], { text })}
        />
      ) : mode === 'sketch' ? (
        <div className="space-y-2 rounded-lg border bg-card p-2">
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-xs text-muted-foreground me-1">{t('sketch.templates')}</span>
            {SKETCH_TEMPLATES.map((tpl) => (
              <Button key={tpl} size="sm" variant="outline" onClick={() => applyTemplate(tpl)}>
                {t(`sketch.template.${tpl}`)}
              </Button>
            ))}
            <Button
              size="sm"
              variant="ghost"
              disabled={!sketch.elements.length}
              onClick={() => {
                if (window.confirm(t('sketch.clearConfirm'))) {
                  history.snapshot();
                  applySketch({ template: null, background: sketchRef.current.background ?? null, elements: [] });
                  setSelectedEl(null);
                }
              }}
            >
              {t('sketch.clear')}
            </Button>
          </div>
          {/* The palette (v3 §4): its tabs, or what the search finds across them. */}
          <div className="flex flex-wrap items-center gap-1 border-t pt-2">
            <span className="text-xs text-muted-foreground me-1">{t('sketch.add')}</span>
            {PALETTE_TABS.map((tab) => (
              <Button
                key={tab}
                size="sm"
                variant={!query.trim() && paletteTab === tab ? 'default' : 'ghost'}
                className="h-8"
                onClick={() => {
                  setPaletteTab(tab);
                  setQuery('');
                }}
              >
                {PALETTE_TAB_NAMES[tab]}
              </Button>
            ))}
            <div className="relative ms-auto">
              <Search className="pointer-events-none absolute start-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="h-8 w-48 ps-7"
                value={query}
                placeholder={t('sketch.search')}
                aria-label={t('sketch.search')}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-1">
            {paletteEntries.length ? (
              paletteEntries.map((p) => (
                <Button key={`${p.kind}.${p.variant ?? ''}`} size="sm" variant="secondary" className="h-9" onClick={() => addElement(p)}>
                  <KindIcon kind={p.kind} variant={p.variant} size={20} />
                  <span className="ms-1">{entryName(p.kind, p.variant)}</span>
                </Button>
              ))
            ) : (
              <span className="text-xs text-muted-foreground">{t('sketch.searchNone')}</span>
            )}
            {!query.trim() && paletteTab === 'structure' ? (
              // An area of any shape: drawn corner by corner.
              <Button size="sm" variant="outline" className="h-9" onClick={drawArea} title={t('sketch.areaPolygonHint')}>
                <KindIcon kind="area" size={20} />
                <span className="ms-1">{t('sketch.areaPolygon')}</span>
              </Button>
            ) : null}
          </div>
          {element ? (
            <div className="flex flex-wrap items-end gap-2 border-t pt-2">
              <span className="inline-flex items-center gap-1 text-sm font-medium">
                <KindIcon kind={element.kind} variant={element.variant ?? null} size={22} fill={element.fill} />
                {entryName(element.kind, element.kind === 'counter' ? null : variantOf(element.kind, element.variant))}
              </span>
              {VARIANT_CHOICES[element.kind] ? (
                // Restrooms: whose; an exit: plain or the emergency one; a bar with stools: its shape;
                // a bar: what it pours; an entrance: which; a plant: its size.
                <div className="flex gap-1">
                  {VARIANT_CHOICES[element.kind]!.map((v) => (
                    <Button
                      key={v ?? 'none'}
                      size="sm"
                      variant={variantOf(element.kind, element.variant) === v ? 'default' : 'outline'}
                      onClick={() => patchElement({ variant: v })}
                    >
                      {VARIANT_NAMES[element.kind]?.[v ?? 'none'] ?? v}
                    </Button>
                  ))}
                </div>
              ) : null}
              {element.kind === 'counter' ? (
                <>
                  <NumberField
                    label={t('sketch.stools')}
                    value={element.stools ?? 0}
                    allowZero
                    onChange={(v) => patchElement({ stools: Math.max(0, Math.min(40, Math.round(v))) })}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!element.stools}
                    onClick={() => {
                      if (window.confirm(t('sketch.stoolsToTablesConfirm', { count: element.stools ?? 0 }))) {
                        void stoolsToTables(element);
                      }
                    }}
                  >
                    {t('sketch.stoolsToTables')}
                  </Button>
                </>
              ) : null}
              {element.kind === 'logo' ? (
                // §8: the business's logo or an uploaded picture, its opacity and proportions.
                <LogoPanel element={element} businessLogo={logoUrl} onPatch={patchElement} onError={onError} />
              ) : null}
              {!NO_TEXT.has(element.kind) && !isDrawn(element.kind) ? (
                <div className="space-y-1">
                  <Label className="text-xs">{element.kind === 'area' ? t('sketch.areaName') : t('sketch.text')}</Label>
                  {element.kind === 'label' ? (
                    // A text: several lines, up to 200 characters (§8).
                    <textarea
                      className="border-input bg-background block w-56 rounded-md border px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      rows={3}
                      value={element.text ?? ''}
                      placeholder={defaultText(element) ?? ''}
                      maxLength={LABEL_TEXT_MAX}
                      title={t('sketch.labelTextHint')}
                      onChange={(e) => patchElement({ text: cleanText('label', e.target.value) })}
                    />
                  ) : (
                    <Input
                      className="h-8 w-40"
                      value={element.text ?? ''}
                      placeholder={defaultText(element) ?? ''}
                      maxLength={SKETCH_TEXT_MAX}
                      onChange={(e) => patchElement({ text: cleanText(element.kind, e.target.value) })}
                    />
                  )}
                </div>
              ) : null}
              {element.kind === 'label' ? <LabelStyle element={element} onPatch={patchElement} /> : null}
              {element.kind === 'area' ? (
                // An area's fill (the palette) and how much of the floor shows through it.
                <>
                  <div className="space-y-1">
                    <Label className="text-xs">{t('sketch.areaFill')}</Label>
                    <div className="flex gap-1">
                      {AREA_FILLS.map((c) => (
                        <button
                          key={c}
                          type="button"
                          title={AREA_FILL_NAMES[c]}
                          aria-label={AREA_FILL_NAMES[c]}
                          onClick={() => patchElement({ fill: c })}
                          className={`h-7 w-7 rounded-full border-2 ${element.fill === c ? 'border-slate-900 ring-2 ring-amber-300' : 'border-white'}`}
                          style={{ background: c }}
                        />
                      ))}
                    </div>
                  </div>
                  <label className="space-y-1 text-xs">
                    <span className="block">{t('sketch.areaOpacity', { value: clampOpacity(element.opacity ?? AREA_OPACITY.default) })}</span>
                    <input
                      type="range"
                      className="h-8 w-32"
                      min={AREA_OPACITY.min}
                      max={AREA_OPACITY.max}
                      step={5}
                      value={clampOpacity(element.opacity ?? AREA_OPACITY.default)}
                      onChange={(e) => patchElement({ opacity: clampOpacity(Number(e.target.value)) })}
                    />
                  </label>
                </>
              ) : null}
              {takesColour(element) ? (
                // A symbol's own colour (none: the theme's).
                <div className="space-y-1">
                  <Label className="text-xs">{t('sketch.color')}</Label>
                  <div className="flex gap-1">
                    <button
                      type="button"
                      title={t('sketch.colorTheme')}
                      onClick={() => patchElement({ color: null })}
                      className={`h-7 rounded-full border-2 px-2 text-[11px] ${!element.color ? 'border-slate-900 ring-2 ring-amber-300' : 'border-slate-300'}`}
                    >
                      {t('sketch.colorTheme')}
                    </button>
                    {SYMBOL_COLORS.map((c) => (
                      <button
                        key={c}
                        type="button"
                        aria-label={c}
                        onClick={() => patchElement({ color: c })}
                        className={`h-7 w-7 rounded-full border-2 ${element.color === c ? 'border-slate-900 ring-2 ring-amber-300' : 'border-white'}`}
                        style={{ background: c }}
                      />
                    ))}
                  </div>
                </div>
              ) : null}
              {!hasPoints(element.kind) ? (
                <>
                  <NumberField label={t('width')} value={element.w} onChange={(v) => patchElement(resized(element, v, element.h))} />
                  <NumberField label={t('height')} value={element.h} onChange={(v) => patchElement(resized(element, element.w, v))} />
                </>
              ) : null}
              {!isDrawn(element.kind) && !isPolygonArea(element) ? (
                // A quarter turn each click (the symbols stand square to the walls); 45° for a slant;
                // any angle typed (an arrow points any way).
                <div className="flex items-end gap-1">
                  <Button
                    size="sm"
                    variant="outline"
                    title={t('sketch.rotate90')}
                    onClick={() => patchElement({ rotation: ((Math.floor(element.rotation / 90) + 1) * 90) % 360 })}
                  >
                    <RotateCw className="h-4 w-4 me-1" />
                    90°
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    title={t('sketch.rotate45')}
                    onClick={() => patchElement({ rotation: (element.rotation + 45) % 360 })}
                  >
                    45°
                  </Button>
                  <NumberField
                    label={t('sketch.rotation')}
                    value={element.rotation}
                    allowZero
                    onChange={(v) => patchElement({ rotation: ((Math.round(v) % 360) + 360) % 360 })}
                  />
                </div>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                title={t('sketch.duplicate')}
                onClick={() => {
                  const copy = { ...translated(element, 20, 20), id: newElementId() };
                  history.snapshot();
                  editSketch((els) => [...els, copy]);
                  setSelectedEl(copy.id);
                }}
              >
                <Copy className="h-4 w-4" />
              </Button>
              {/* "שכפול מרובה": copies side by side, in a row or a column. */}
              <div className="flex items-end gap-1 rounded-md border px-1.5 py-1">
                <NumberField
                  label={t('sketch.duplicateCount')}
                  value={dup.count}
                  onChange={(v) => setDup((d) => ({ ...d, count: Math.max(1, Math.min(DUPLICATE_MAX, Math.round(v))) }))}
                />
                <label className="space-y-1 text-xs">
                  <span className="block">{t('sketch.duplicateDirection')}</span>
                  <select className={SELECT} value={dup.dir} onChange={(e) => setDup((d) => ({ ...d, dir: e.target.value as DuplicateDirection }))}>
                    {DUPLICATE_DIRECTIONS.map((dir) => (
                      <option key={dir} value={dir}>
                        {t(`sketch.duplicateDir.${dir}`)}
                      </option>
                    ))}
                  </select>
                </label>
                <NumberField
                  label={t('sketch.duplicateGap')}
                  value={dup.gap}
                  allowZero
                  onChange={(v) => setDup((d) => ({ ...d, gap: Math.max(0, Math.min(500, Math.round(v))) }))}
                />
                <Button size="sm" variant="outline" onClick={() => duplicateRow(element)}>
                  <CopyPlus className="h-4 w-4 me-1" />
                  {t('sketch.duplicateMany', { count: dup.count })}
                </Button>
              </div>
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  history.snapshot();
                  editSketch((els) => els.filter((el) => el.id !== element.id));
                  setSelectedEl(null);
                }}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{t('sketch.hint')}</p>
          )}
        </div>
      ) : selectedTables.length ? (
        <div className="flex flex-wrap items-end gap-2 rounded-lg border bg-card p-2">
          <span className="text-sm font-medium">
            {selectedTables.length === 1
              ? t('tableTitle', { number: selectedTables[0].number })
              : t('sketch.selectedCount', { count: selectedTables.length })}
          </span>
          {firstPos ? (
            <>
              <NumberField label={t('width')} value={firstPos.width} onChange={(v) => setSelectedSize(v, null)} />
              {selectedTables.some((tb) => tb.shape === 'rect') ? (
                <NumberField label={t('height')} value={firstPos.height} onChange={(v) => setSelectedSize(null, v)} />
              ) : null}
            </>
          ) : null}
          <div className="flex gap-1">
            {SHAPES.map((s) => (
              <Button key={s} size="sm" variant="outline" onClick={() => void setShape(s)}>
                {t(`shapes.${s}`)}
              </Button>
            ))}
          </div>
          <Button size="sm" variant="outline" onClick={rotateSelected} title={t('rotation')}>
            <RotateCw className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="outline" onClick={() => void duplicate()}>
            <Copy className="h-4 w-4 me-1" />
            {t('sketch.duplicate')}
          </Button>
          {selectedTables.length === 1 ? (
            <Button size="sm" variant="outline" onClick={() => onEdit(selectedTables[0])}>
              {t('editTable')}
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t('mapHint')}</p>
      )}

      <div ref={boxRef} dir="ltr" className="w-full">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${cw} ${ch}`}
          className="block w-full touch-none select-none rounded-xl border shadow-sm"
          onPointerMove={svgMove}
          onPointerUp={svgUp}
          onPointerCancel={svgUp}
          onPointerDown={svgDown}
          onDoubleClick={draw.onDoubleClick}
          style={{ height: (boxWidth * ch) / cw, cursor: mode === 'draw' && draw.tool !== 'select' ? 'crosshair' : undefined }}
        >
          <FloorDefs />
          {background === 'image' && zone.backgroundUrl ? (
            <image href={zone.backgroundUrl} x={0} y={0} width={cw} height={ch} preserveAspectRatio="none" />
          ) : (
            <rect
              x={0}
              y={0}
              width={cw}
              height={ch}
              fill={
                background === 'tiles'
                  ? 'url(#floor-tiles)'
                  : background === 'light'
                    ? PLAIN.light
                    : background === 'dark'
                      ? PLAIN.dark
                      : background === 'wood'
                        ? 'url(#floor-wood)'
                        : 'url(#floor-clean)'
              }
            />
          )}
          {snap ? <GridLines cw={cw} ch={ch} /> : null}
          <g opacity={mode === 'tables' ? 0.95 : 1} pointerEvents={mode === 'tables' ? 'none' : 'auto'}>
            {/* The areas first, under everything (v3 §2); then the rest as placed. */}
            {drawOrder(sketch.elements).map((el) => (
              <SketchShape
                key={el.id}
                el={el}
                perPx={perPx}
                logoUrl={logoUrl}
                logoLabel={t('sketch.kind.logo')}
                selected={mode === 'sketch' && el.id === selectedEl}
                onDown={(e) => (mode === 'draw' ? draw.onElementDown(e, el) : startElement(e, el))}
                onResize={mode === 'sketch' ? (e) => startElement(e, el, true) : undefined}
              />
            ))}
            {mode === 'draw' ? (
              <DrawOverlay
                tools={draw}
                elements={sketch.elements}
                perPx={perPx}
                renderShape={(el) => <SketchShape el={el} perPx={perPx} logoUrl={logoUrl} logoLabel={t('sketch.kind.logo')} />}
              />
            ) : null}
          </g>
          <g opacity={mode === 'tables' ? 1 : 0.45} pointerEvents={mode === 'tables' ? 'auto' : 'none'}>
            {tables.map((tb) => {
              const p = posOf(tb);
              const isSel = selected.includes(tb.id);
              const cx = p.x + p.width / 2;
              const cy = p.y + p.height / 2;
              const fs = Math.max(10 * perPx, Math.min(p.width, p.height) * 0.34);
              const radius = Math.min(p.width, p.height) * 0.18;
              const ring = 3 * perPx;
              return (
                <g key={tb.id}>
                  <g
                    transform={`rotate(${p.rotation} ${cx} ${cy})`}
                    onPointerDown={(e) => startTable(e, tb)}
                    onDoubleClick={() => onEdit(tb)}
                    style={{ cursor: 'grab' }}
                  >
                    {isSel ? (
                      // The gold of a picked table: a soft halo under the object.
                      tb.shape === 'round' ? (
                        <ellipse
                          cx={cx} cy={cy} rx={p.width / 2 + 8 * perPx} ry={p.height / 2 + 8 * perPx}
                          fill={TABLE_LOOK.gold} opacity={0.45} filter="url(#gold-glow)"
                        />
                      ) : (
                        <rect
                          x={p.x - 8 * perPx} y={p.y - 8 * perPx}
                          width={p.width + 16 * perPx} height={p.height + 16 * perPx}
                          rx={radius + 8 * perPx}
                          fill={TABLE_LOOK.gold} opacity={0.45} filter="url(#gold-glow)"
                        />
                      )
                    ) : null}
                    {chairLayout(tb.shape === 'round', p.width, p.height, tb.seats).map((c, i) => (
                      // The chairs, from the table's seats — as the till draws them.
                      <g key={`c${i}`} transform={`translate(${p.x + c.cx} ${p.y + c.cy}) rotate(${c.angle})`}>
                        <rect
                          x={-c.width / 2} y={-c.depth / 2} width={c.width} height={c.depth} rx={c.depth * 0.28}
                          fill={CHAIR_LOOK.wood} stroke={CHAIR_LOOK.edge} strokeWidth={Math.max(perPx, c.depth * 0.06)}
                          filter="url(#table-shadow)"
                        />
                        <rect x={-c.width / 2} y={-c.depth / 2} width={c.width} height={c.depth * 0.34} rx={c.depth * 0.28} fill={CHAIR_LOOK.back} />
                      </g>
                    ))}
                    {tb.shape === 'round' ? (
                      <ellipse
                        cx={cx} cy={cy} rx={p.width / 2} ry={p.height / 2}
                        fill={TABLE_LOOK.fill}
                        stroke={isSel ? TABLE_LOOK.gold : TABLE_LOOK.border}
                        strokeWidth={isSel ? ring * 1.5 : ring * 0.6}
                        filter="url(#table-shadow)"
                      />
                    ) : (
                      <rect
                        x={p.x} y={p.y} width={p.width} height={p.height} rx={radius}
                        fill={TABLE_LOOK.fill}
                        stroke={isSel ? TABLE_LOOK.gold : TABLE_LOOK.border}
                        strokeWidth={isSel ? ring * 1.5 : ring * 0.6}
                        filter="url(#table-shadow)"
                      />
                    )}
                    {moved[tb.id] ? (
                      // Moved, not saved yet: a small blue dot in the corner.
                      <circle cx={p.x + p.width * 0.85} cy={p.y + p.height * 0.15} r={4 * perPx} fill="#3b82f6" />
                    ) : null}
                    <PolicyBadge
                      badge={policyBadge(tb.policy)}
                      kindLabel={(k) => t(`policy.badge.${k}`)}
                      cx={cx}
                      top={p.y}
                      fs={fs}
                    />
                    <text
                      x={cx}
                      y={tableDisplay(tb).sub && p.height > fs * 2.2 ? cy - fs * 0.25 : cy}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={tb.labelOnly ? fs * 0.7 : fs}
                      fontWeight={700}
                      fill={TABLE_LOOK.number}
                    >
                      {tableDisplay(tb).main}
                    </text>
                    {tableDisplay(tb).sub && p.height > fs * 2.2 ? (
                      <text x={cx} y={cy + fs * 0.75} textAnchor="middle" dominantBaseline="central" fontSize={fs * 0.42} fill="#78716c">
                        {tableDisplay(tb).sub}
                      </text>
                    ) : null}
                  </g>
                  {isSel && mode === 'tables' ? (
                    <rect
                      x={p.x + p.width - handle / 2}
                      y={p.y + p.height - handle / 2}
                      width={handle}
                      height={handle}
                      rx={3 * perPx}
                      fill={TABLE_LOOK.gold}
                      stroke="#fff"
                      strokeWidth={1.5 * perPx}
                      style={{ cursor: 'nwse-resize' }}
                      onPointerDown={(e) => startTableSize(e, tb)}
                    />
                  ) : null}
                </g>
              );
            })}
          </g>
        </svg>
      </div>
      {preview && previewButton ? (
        // "תצוגה בקופה": the plan as it stands (saved or not), on the till's screens.
        <TillPreview
          title={zone.name}
          elements={sketch.elements}
          background={background}
          backgroundUrl={zone.backgroundUrl}
          cw={cw}
          ch={ch}
          tables={tables.map((tb) => {
            const p = posOf(tb);
            return { id: tb.id, number: tb.number, shape: tb.shape, seats: tb.seats, x: p.x, y: p.y, width: p.width, height: p.height, rotation: p.rotation };
          })}
          logoUrl={logoUrl}
          logoLabel={t('sketch.kind.logo')}
        />
      ) : null}
    </div>
  );
}

/**
 * "סוג שולחן" on the table: עובדים / מנהלים / -10% — a small pill over its top edge, as
 * the till's map shows it (lib/tablePolicy.ts, policyBadge).
 */
function PolicyBadge({
  badge,
  kindLabel,
  cx,
  top,
  fs,
}: {
  badge: ReturnType<typeof policyBadge>;
  kindLabel: (kind: 'staff' | 'managers') => string;
  cx: number;
  top: number;
  fs: number;
}) {
  if (!badge) return null;
  const label = [badge.kind ? kindLabel(badge.kind) : null, badge.discount].filter(Boolean).join(' ');
  const size = fs * 0.36;
  const width = label.length * size * 0.6 + size * 1.2;
  const fill = badge.kind === 'managers' ? '#7c3aed' : badge.kind === 'staff' ? '#0d9488' : '#dc2626';
  return (
    <g pointerEvents="none">
      <rect x={cx - width / 2} y={top - size * 0.75} width={width} height={size * 1.5} rx={size * 0.75} fill={fill} />
      <text x={cx} y={top} textAnchor="middle" dominantBaseline="central" fontSize={size} fontWeight={700} fill="#fff">
        {label}
      </text>
    </g>
  );
}

function NumberField({
  label,
  value,
  onChange,
  allowZero = false,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  allowZero?: boolean;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      <Input
        type="number"
        className="h-8 w-24"
        value={Math.round(value)}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v) && (v > 0 || (allowZero && v === 0))) onChange(v);
        }}
      />
    </div>
  );
}

/** A small sample of a floor for the chooser. */
function floorSwatch(bg: SketchBackground, image: string | null): React.CSSProperties {
  switch (bg) {
    case 'clean':
      return {
        background: CLEAN.fill,
        backgroundImage: `linear-gradient(${CLEAN.grid} 1px, transparent 1px), linear-gradient(90deg, ${CLEAN.grid} 1px, transparent 1px)`,
        backgroundSize: '10px 10px',
      };
    case 'wood':
      return {
        background: `repeating-linear-gradient(90deg, ${WOOD.tones[0]} 0 6px, ${WOOD.tones[1]} 6px 7px, ${WOOD.tones[2]} 7px 13px, ${WOOD.seam} 13px 14px)`,
      };
    case 'tiles':
      return {
        background: `${TILE.fill}`,
        backgroundImage: `linear-gradient(${TILE.grout} 1px, transparent 1px), linear-gradient(90deg, ${TILE.grout} 1px, transparent 1px)`,
        backgroundSize: '8px 8px',
      };
    case 'light':
      return { background: PLAIN.light };
    case 'dark':
      return { background: PLAIN.dark };
    case 'image':
      return image ? { backgroundImage: `url(${image})`, backgroundSize: 'cover' } : {};
  }
}

function GridLines({ cw, ch }: { cw: number; ch: number }) {
  const step = GRID * 5;
  const lines = [];
  for (let x = step; x < cw; x += step) lines.push(<line key={`x${x}`} x1={x} y1={0} x2={x} y2={ch} />);
  for (let y = step; y < ch; y += step) lines.push(<line key={`y${y}`} x1={0} y1={y} x2={cw} y2={y} />);
  return (
    <g stroke="#e2e8f0" strokeWidth={1} pointerEvents="none">
      {lines}
    </g>
  );
}
