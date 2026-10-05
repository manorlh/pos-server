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
 * * **Sketch** — start from a ready-made template, add shapes from the palette, drag
 *   them, resize them from the corner, set their text and rotation.
 * * **Draw** — lines, walls, rectangles, freehand, text and an eraser, in a colour and a
 *   width (./sketch-draw.tsx). Drawings lie under the tables, like the sketch.
 *
 * Undo and redo (Ctrl+Z / Ctrl+Y, and the buttons) step through the sketch's changes.
 * Nothing is written until "שמור" (positions in one write, the sketch with the zone).
 * Snap to grid rounds every move and size to 10 canvas units.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Brush, Copy, Grid3x3, Maximize2, MousePointer2, PenTool, Redo2, RotateCcw, RotateCw, Save, Trash2, Undo2 } from 'lucide-react';
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
  backgroundOf,
  clampSize,
  counterGeometry,
  hasPoints,
  isDrawn,
  newElement,
  newElementId,
  PLAIN,
  rotatePoint,
  SKETCH_BACKGROUNDS,
  SKETCH_DEFAULT_TEXT,
  SKETCH_KINDS,
  SKETCH_STYLE,
  SKETCH_TEMPLATES,
  CHAIR_LOOK,
  chairLayout,
  TABLE_LOOK,
  templateSketch,
  TILE,
  WOOD,
  type Sketch,
  type SketchBackground,
  type SketchElement,
  type SketchKind,
  type SketchTemplate,
  uniqueElements,
} from '@/lib/tableSketch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DrawOverlay, DrawPanel, useDrawTools, useSketchHistory } from './sketch-draw';

type Pos = { x: number; y: number; width: number; height: number; rotation: number };
type Pt = { x: number; y: number };
type Drag =
  | { type: 'tables'; ids: string[]; start: Pt; from: Record<string, Pos>; travelled: number }
  | { type: 'table-size'; ids: string[]; start: Pt; from: Pos; round: boolean }
  | { type: 'element'; id: string; start: Pt; from: SketchElement }
  | { type: 'element-size'; id: string; start: Pt; from: SketchElement };

const GRID = 10;
const SHAPES: TableShape[] = ['round', 'square', 'rect'];

export function MapEditor({
  zone,
  tables,
  onEdit,
  onSaved,
  onError,
  onDirtyChange,
}: {
  zone: TableZone;
  tables: DiningTable[];
  onEdit: (table: DiningTable) => void;
  onSaved: () => void;
  onError: (err: unknown) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const t = useTranslations('tables');
  const cw = zone.canvasWidth;
  const ch = zone.canvasHeight;
  const boxRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [boxWidth, setBoxWidth] = useState(800);
  const [mode, setMode] = useState<'tables' | 'sketch' | 'draw'>('tables');
  const [snap, setSnap] = useState(true);
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
    } else if (d.type === 'element' || d.type === 'element-size') {
      const f = d.from;
      editSketch((els) =>
        els.map((el) =>
          el.id !== d.id
            ? el
            : d.type === 'element'
              ? hasPoints(f.kind)
                ? translatedTo(f, snapV(f.x + dx) - f.x, snapV(f.y + dy) - f.y)
                : { ...el, x: snapV(f.x + dx), y: snapV(f.y + dy) }
              : hasPoints(f.kind)
                ? el
                : { ...el, w: Math.max(2, snapV(f.w + dx)), h: Math.max(2, snapV(f.h + dy)) },
        ),
      );
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

  const addElement = (kind: SketchKind) => {
    const el = newElement(kind, cw, ch);
    history.snapshot();
    editSketch((els) => [...els, el]);
    setSelectedEl(el.id);
  };

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
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-xs text-muted-foreground me-1">{t('sketch.add')}</span>
            {SKETCH_KINDS.map((kind) => (
              <Button key={kind} size="sm" variant="secondary" onClick={() => addElement(kind)}>
                <span
                  className="me-1 inline-block h-3 w-3 rounded-sm border"
                  style={{ background: SKETCH_STYLE[kind].fill, borderColor: SKETCH_STYLE[kind].stroke }}
                />
                {t(`sketch.kind.${kind}`)}
              </Button>
            ))}
          </div>
          {element ? (
            <div className="flex flex-wrap items-end gap-2 border-t pt-2">
              <span className="text-sm font-medium">{t(`sketch.kind.${element.kind}`)}</span>
              {element.kind === 'counter' ? (
                <>
                  <div className="flex gap-1">
                    {(['straight', 'L'] as const).map((v) => (
                      <Button
                        key={v}
                        size="sm"
                        variant={(element.variant ?? 'straight') === v ? 'default' : 'outline'}
                        onClick={() => patchElement({ variant: v })}
                      >
                        {t(`sketch.counter.${v}`)}
                      </Button>
                    ))}
                  </div>
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
              {element.kind !== 'wall' && element.kind !== 'window' && element.kind !== 'plant' && element.kind !== 'column' && element.kind !== 'counter' && !isDrawn(element.kind) ? (
                <div className="space-y-1">
                  <Label className="text-xs">{t('sketch.text')}</Label>
                  <Input
                    className="h-8 w-40"
                    value={element.text ?? ''}
                    placeholder={SKETCH_DEFAULT_TEXT[element.kind] ?? ''}
                    maxLength={60}
                    onChange={(e) => patchElement({ text: e.target.value || null })}
                  />
                </div>
              ) : null}
              {!hasPoints(element.kind) ? (
                <>
                  <NumberField label={t('width')} value={element.w} onChange={(v) => patchElement({ w: Math.max(2, v) })} />
                  <NumberField label={t('height')} value={element.h} onChange={(v) => patchElement({ h: Math.max(2, v) })} />
                </>
              ) : null}
              {!isDrawn(element.kind) ? (
                <Button size="sm" variant="outline" onClick={() => patchElement({ rotation: (element.rotation + 45) % 360 })}>
                  <RotateCw className="h-4 w-4" />
                </Button>
              ) : null}
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const copy = { ...translatedTo(element, 20, 20), id: newElementId() };
                  history.snapshot();
                  editSketch((els) => [...els, copy]);
                  setSelectedEl(copy.id);
                }}
              >
                <Copy className="h-4 w-4" />
              </Button>
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
                      : 'url(#floor-wood)'
              }
            />
          )}
          {snap ? <GridLines cw={cw} ch={ch} /> : null}
          <g opacity={mode === 'tables' ? 0.95 : 1} pointerEvents={mode === 'tables' ? 'none' : 'auto'}>
            {sketch.elements.map((el) => (
              <SketchShape
                key={el.id}
                el={el}
                perPx={perPx}
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
                renderShape={(el) => <SketchShape el={el} perPx={perPx} />}
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
                    <text
                      x={cx}
                      y={tb.name && p.height > fs * 2.2 ? cy - fs * 0.25 : cy}
                      textAnchor="middle"
                      dominantBaseline="central"
                      fontSize={fs}
                      fontWeight={700}
                      fill={TABLE_LOOK.number}
                    >
                      {tb.number}
                    </text>
                    {tb.name && p.height > fs * 2.2 ? (
                      <text x={cx} y={cy + fs * 0.75} textAnchor="middle" dominantBaseline="central" fontSize={fs * 0.42} fill="#78716c">
                        {tb.name}
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
    </div>
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

/** A bar counter, straight or L, with its numbered stools in front (as the till draws it). */
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
          stroke={selected ? '#2563eb' : st.stroke}
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

/** One sketch shape — drawn the same way by the till (ui/tables/TableVisuals.kt, drawSketch). */
export function SketchShape({
  el,
  perPx,
  selected = false,
  onDown,
  onResize,
}: {
  el: SketchElement;
  perPx: number;
  selected?: boolean;
  onDown?: (e: React.PointerEvent) => void;
  onResize?: (e: React.PointerEvent) => void;
}) {
  const st = SKETCH_STYLE[el.kind];
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  const text = el.text ?? SKETCH_DEFAULT_TEXT[el.kind] ?? null;
  const long = Math.max(el.w, el.h);
  const short = Math.min(el.w, el.h);
  const fs = text ? Math.max(9 * perPx, Math.min(short * 0.55, (long * 1.6) / Math.max(2, text.length))) : 0;
  const vertical = el.h > el.w * 1.6;
  const handle = 12 * perPx;
  // A fixture with a symbol: the symbol, and the word under it, when both fit.
  const iconSize = SYMBOLS[el.kind] ? Math.min(short * 0.55, long * 0.4) : 0;
  const stacked = !!text && iconSize >= 14 * perPx && short >= iconSize + fs * 0.9 * 1.3;
  const textFs = stacked ? Math.min(fs, short * 0.24) : fs;
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
          <polyline points={points} fill="none" stroke="#2563eb" strokeWidth={1.5 * perPx} strokeDasharray={`${6 * perPx} ${4 * perPx}`} />
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
        {selected ? (
          <rect x={el.x} y={el.y} width={el.w} height={el.h} fill="none" stroke="#2563eb" strokeWidth={1.5 * perPx} strokeDasharray={`${6 * perPx} ${4 * perPx}`} />
        ) : null}
      </g>
    );
  }
  return (
    <g>
      <g transform={`rotate(${el.rotation} ${cx} ${cy})`} onPointerDown={onDown} style={{ cursor: onDown ? 'move' : undefined }}>
        {el.kind === 'counter' ? (
          <CounterShape el={el} perPx={perPx} selected={selected} />
        ) : el.kind === 'plant' ? (
          <PlantShape el={el} />
        ) : el.kind === 'sofa' ? (
          <SofaShape el={el} perPx={perPx} />
        ) : el.kind === 'stairs' ? (
          <StairsShape el={el} perPx={perPx} />
        ) : el.kind === 'label' ? (
          <rect x={el.x} y={el.y} width={el.w} height={el.h} fill="transparent" stroke={selected ? '#2563eb' : 'none'} strokeDasharray="4 4" />
        ) : st.round ? (
          <ellipse cx={cx} cy={cy} rx={el.w / 2} ry={el.h / 2} fill={st.fill} stroke={st.stroke} strokeWidth={2 * perPx} />
        ) : (
          <rect
            x={el.x} y={el.y} width={el.w} height={el.h}
            rx={el.kind === 'bar' ? Math.min(12, short / 3) : 2}
            fill={st.fill}
            stroke={selected ? '#2563eb' : st.stroke}
            strokeWidth={(selected ? 3 : 1.5) * perPx}
            strokeDasharray={st.dashed ? `${8 * perPx} ${6 * perPx}` : undefined}
          />
        )}
        {selected && (el.kind === 'plant' || el.kind === 'sofa' || el.kind === 'stairs') ? (
          <rect x={el.x} y={el.y} width={el.w} height={el.h} fill="none" stroke="#2563eb" strokeWidth={1.5 * perPx} strokeDasharray={`${6 * perPx} ${4 * perPx}`} />
        ) : null}
        {stacked ? (
          // The symbol above the word, when there is room for both.
          <FixtureSymbol
            kind={el.kind}
            cx={cx}
            cy={cy - (iconSize + textFs * 1.25) / 2 + iconSize / 2}
            size={iconSize}
            color={st.stroke}
            transform={vertical ? `rotate(-90 ${cx} ${cy})` : undefined}
          />
        ) : null}
        {text && (stacked || fs >= 6 * perPx) && el.kind !== 'counter' && el.kind !== 'sofa' ? (
          <text
            x={cx}
            y={stacked ? cy + (iconSize + textFs * 1.25) / 2 - textFs * 0.6 : cy}
            textAnchor="middle"
            dominantBaseline="central"
            fontSize={textFs}
            fill={el.kind === 'label' && el.color ? el.color : st.text}
            transform={vertical ? `rotate(-90 ${cx} ${cy})` : undefined}
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
          fill="#2563eb"
          style={{ cursor: 'nwse-resize' }}
          onPointerDown={onResize}
        />
      ) : null}
    </g>
  );
}

/** The fixtures drawn with a symbol in them (the till draws the same). */
const SYMBOLS: Partial<Record<SketchKind, true>> = { restroom: true, cashier: true, host: true, exit: true };

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

function FixtureSymbol({ kind, cx, cy, size, color, transform }: { kind: SketchKind; cx: number; cy: number; size: number; color: string; transform?: string }) {
  return (
    <g transform={transform} pointerEvents="none">
      {kind === 'restroom' ? (
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

/** A plant from above: a rosette of leaves round a dark heart. */
function PlantShape({ el }: { el: SketchElement }) {
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  const r = Math.min(el.w, el.h) / 2;
  const ring = (count: number, reach: number, tone: string, turn: number) =>
    Array.from({ length: count }, (_, i) => (
      <ellipse
        key={`${count}-${i}`}
        cx={cx} cy={cy - r * reach * 0.52} rx={r * 0.2 * reach} ry={r * 0.475 * reach}
        fill={tone} transform={`rotate(${(i * 360) / count + turn} ${cx} ${cy})`}
      />
    ));
  return (
    <g>
      <circle cx={cx} cy={cy + r * 0.08} r={r * 0.95} fill="#000" opacity={0.2} />
      {ring(8, 1, '#2f9e44', 0)}
      {ring(6, 0.68, '#51cf66', 30)}
      <circle cx={cx} cy={cy} r={r * 0.16} fill="#1b5e20" />
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

/** Moved by (dx, dy): the box, and the points of a drawn line. */
function translatedTo(el: SketchElement, dx: number, dy: number): SketchElement {
  if (hasPoints(el.kind) && el.points) {
    const pts: number[] = el.points.map((v, i) => (i % 2 === 0 ? v + dx : v + dy));
    return { ...el, points: pts, x: el.x + dx, y: el.y + dy };
  }
  return { ...el, x: el.x + dx, y: el.y + dy };
}
