'use client';

/**
 * Drawing on a zone's floor plan ("ציור"): lines (Shift — or the angle lock — keeps them
 * at 0°/45°/90°), walls as polylines (click the corners, double-click — or Enter — to
 * finish, a click on the first corner closes the room), rectangles (outline or filled),
 * freehand strokes, text, and an eraser — in a colour and a stroke width, snapped to the
 * grid and to the ends of what is already drawn. Select moves what is picked (Shift adds
 * to the pick); a line's ends are dragged by their handles. Copy, paste, duplicate,
 * delete, undo and redo, by button and by key (Ctrl+Z, Ctrl+Y, Ctrl+C, Ctrl+V, Ctrl+D,
 * Delete). Everything is a sketch element saved with the zone; the till draws the same
 * shapes under its tables (ui/tables/TableVisuals.kt, drawSketch).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ClipboardPaste,
  Copy,
  CopyPlus,
  Eraser,
  Minus,
  MousePointer2,
  Pencil,
  Redo2,
  Ruler,
  Spline,
  Square,
  Trash2,
  Type,
  Undo2,
} from 'lucide-react';
import {
  DRAW_COLOR_KEYS,
  DRAW_COLORS,
  DRAW_STROKES,
  MAX_POINTS,
  SKETCH_DEFAULT_TEXT,
  endpoints,
  hasPoints,
  hitTest,
  nearest,
  newElementId,
  onCanvas,
  pairs,
  simplify,
  snapAngle,
  strokeWidth,
  translated,
  withPoints,
  type DrawColor,
  type DrawStroke,
  type Pt,
  type Sketch,
  type SketchElement,
} from '@/lib/tableSketch';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export type DrawTool = 'select' | 'line' | 'polyline' | 'rect' | 'freehand' | 'text' | 'eraser';
const TOOLS: DrawTool[] = ['select', 'line', 'polyline', 'rect', 'freehand', 'text', 'eraser'];
const TOOL_ICON: Record<DrawTool, typeof Minus> = {
  select: MousePointer2,
  line: Minus,
  polyline: Spline,
  rect: Square,
  freehand: Pencil,
  text: Type,
  eraser: Eraser,
};

const HISTORY_MAX = 100;
const GRID = 10;

// ── Undo / redo ───────────────────────────────────────────────────────────────

/**
 * The sketch's undo and redo: a snapshot before each change ([snapshot]), at most 100.
 * A drag takes one snapshot when it starts, so one drag is one step back.
 */
export function useSketchHistory(sketchRef: React.MutableRefObject<Sketch>, apply: (s: Sketch) => void) {
  const past = useRef<Sketch[]>([]);
  const future = useRef<Sketch[]>([]);
  // How deep each stack is, as state: what the buttons show.
  const [depth, setDepth] = useState({ past: 0, future: 0 });
  const sync = useCallback(() => setDepth({ past: past.current.length, future: future.current.length }), []);
  const snapshot = useCallback(() => {
    past.current.push(sketchRef.current);
    if (past.current.length > HISTORY_MAX) past.current.shift();
    future.current = [];
    sync();
  }, [sketchRef, sync]);
  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(sketchRef.current);
    apply(prev);
    sync();
  }, [apply, sketchRef, sync]);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(sketchRef.current);
    apply(next);
    sync();
  }, [apply, sketchRef, sync]);
  const reset = useCallback(() => {
    past.current = [];
    future.current = [];
    sync();
  }, [sync]);
  return { snapshot, undo, redo, reset, canUndo: depth.past > 0, canRedo: depth.future > 0 };
}

// ── The tools ─────────────────────────────────────────────────────────────────

type DrawDrag =
  | { type: 'line'; start: Pt }
  | { type: 'rect'; start: Pt }
  | { type: 'free'; pts: Pt[] }
  | { type: 'erase' }
  | { type: 'move'; start: Pt; from: SketchElement[]; moved: boolean }
  | { type: 'end'; id: string; index: number };

export function useDrawTools({
  active,
  sketchRef,
  setSketch,
  snapshot,
  undo,
  redo,
  cw,
  ch,
  perPx,
  gridSnap,
  toCanvas,
  capture,
}: {
  active: boolean;
  sketchRef: React.MutableRefObject<Sketch>;
  /** The sketch changed (no snapshot: [snapshot] is taken before each change). */
  setSketch: (s: Sketch) => void;
  snapshot: () => void;
  undo: () => void;
  redo: () => void;
  cw: number;
  ch: number;
  perPx: number;
  gridSnap: boolean;
  toCanvas: (e: { clientX: number; clientY: number }) => Pt;
  capture: (e: React.PointerEvent) => void;
}) {
  const [tool, setTool] = useState<DrawTool>('line');
  const [color, setColor] = useState<DrawColor>('#6b4423');
  const [stroke, setStroke] = useState<DrawStroke>('medium');
  const [filled, setFilled] = useState(false);
  const [angleLock, setAngleLock] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  /** The shape being drawn (not in the sketch until it is finished). */
  const [draft, setDraft] = useState<SketchElement | null>(null);
  /**
   * The draft as of the last change, for finishing it. A finished shape used to be added
   * from inside a `setDraft` updater — and React may run an updater twice (StrictMode
   * always does), so the line went into the sketch twice, under one id. It is read here
   * instead, and the updater stays pure.
   */
  const draftRef = useRef<SketchElement | null>(null);
  const changeDraft = (next: SketchElement | null | ((cur: SketchElement | null) => SketchElement | null)) => {
    const value = typeof next === 'function' ? next(draftRef.current) : next;
    draftRef.current = value;
    setDraft(value);
  };
  /** A wall in the making: its corners so far, and where the pointer is. */
  const [corners, setCorners] = useState<Pt[]>([]);
  const [hover, setHover] = useState<Pt | null>(null);
  const drag = useRef<DrawDrag | null>(null);
  const clipboard = useRef<SketchElement[]>([]);
  const [clipped, setClipped] = useState(0);

  const tolerance = 12 * perPx;
  const width = strokeWidth(stroke, cw, ch);
  const elements = () => sketchRef.current.elements;
  const put = (els: SketchElement[]) => setSketch({ ...sketchRef.current, elements: els });

  /** Where a point lands: on an end of what is drawn, else turned to 45° steps (Shift), else on the grid. */
  const place = (p: Pt, from: Pt | null, shift: boolean, exceptId?: string): Pt => {
    const q = onCanvas(p, cw, ch);
    const end = nearest(endpoints(elements(), exceptId), q, tolerance);
    if (end) return end;
    if (from && (shift || angleLock)) return onCanvas(snapAngle(from, q), cw, ch);
    if (gridSnap) return onCanvas({ x: Math.round(q.x / GRID) * GRID, y: Math.round(q.y / GRID) * GRID }, cw, ch);
    return q;
  };

  const base = (kind: SketchElement['kind']): SketchElement => ({
    id: newElementId(), kind, x: 0, y: 0, w: 0, h: 0, rotation: 0, text: null,
    color, stroke: width, filled: kind === 'rect' ? filled : null,
  });

  const add = (el: SketchElement) => {
    snapshot();
    put([...elements(), el]);
  };

  // ── A wall: corners, then finished ──────────────────────────────────────────
  const finishWall = useCallback(
    (pts: Pt[]) => {
      setCorners([]);
      setHover(null);
      if (pts.length < 2) return;
      add(withPoints(base('polyline'), pts));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [color, width],
  );

  // ── Pointer ─────────────────────────────────────────────────────────────────
  const onDown = (e: React.PointerEvent) => {
    if (!active) return;
    const p = toCanvas(e);
    capture(e);
    switch (tool) {
      case 'line': {
        const start = place(p, null, false);
        drag.current = { type: 'line', start };
        changeDraft(withPoints(base('line'), [start, start]));
        break;
      }
      case 'rect': {
        const start = place(p, null, false);
        drag.current = { type: 'rect', start };
        changeDraft({ ...base('rect'), x: start.x, y: start.y });
        break;
      }
      case 'freehand': {
        const start = onCanvas(p, cw, ch);
        drag.current = { type: 'free', pts: [start] };
        changeDraft(withPoints(base('freehand'), [start, start]));
        break;
      }
      case 'polyline': {
        const last = corners[corners.length - 1] ?? null;
        const q = place(p, last, e.shiftKey);
        // A click on the first corner closes the room.
        if (corners.length >= 2 && Math.hypot(q.x - corners[0].x, q.y - corners[0].y) <= tolerance) {
          finishWall([...corners, corners[0]]);
          break;
        }
        if (last && Math.hypot(q.x - last.x, q.y - last.y) < 0.5) break; // the double-click's second click
        setCorners([...corners, q]);
        break;
      }
      case 'text': {
        const s = Math.min(cw, ch);
        const w = Math.round(s * 0.2);
        const h = Math.round(s * 0.05);
        const q = onCanvas(p, cw, ch);
        const el: SketchElement = {
          ...base('label'),
          kind: 'label',
          x: Math.round(q.x - w / 2), y: Math.round(q.y - h / 2), w, h,
          text: SKETCH_DEFAULT_TEXT.label ?? null,
          stroke: null, filled: null,
        };
        add(el);
        setSelected([el.id]);
        setTool('select');
        break;
      }
      case 'eraser': {
        snapshot();
        drag.current = { type: 'erase' };
        erase(p);
        break;
      }
      case 'select': {
        // Down on the floor: nothing picked.
        setSelected([]);
        break;
      }
    }
  };

  /** Down on a shape: picked (Shift adds), and what is picked moves with the pointer. */
  const onElementDown = (e: React.PointerEvent, el: SketchElement) => {
    if (!active) return;
    if (tool === 'eraser') {
      e.stopPropagation();
      capture(e);
      snapshot();
      drag.current = { type: 'erase' };
      erase(toCanvas(e));
      return;
    }
    if (tool !== 'select') return; // drawing over a shape draws
    e.stopPropagation();
    capture(e);
    let ids = selected;
    if (e.shiftKey || e.ctrlKey || e.metaKey) {
      ids = selected.includes(el.id) ? selected.filter((i) => i !== el.id) : [...selected, el.id];
    } else if (!selected.includes(el.id)) {
      ids = [el.id];
    }
    setSelected(ids);
    if (!ids.includes(el.id)) return;
    drag.current = { type: 'move', start: toCanvas(e), from: elements().filter((x) => ids.includes(x.id)), moved: false };
  };

  /** Down on a line's end (its handle): that end follows the pointer. */
  const onHandleDown = (e: React.PointerEvent, el: SketchElement, index: number) => {
    if (!active || tool !== 'select') return;
    e.stopPropagation();
    capture(e);
    snapshot();
    drag.current = { type: 'end', id: el.id, index };
  };

  const erase = (p: Pt) => {
    const hit = elements().filter((el) => hitTest(el, p, tolerance));
    if (hit.length) {
      const gone = new Set(hit.map((h) => h.id));
      put(elements().filter((el) => !gone.has(el.id)));
      setSelected((s) => s.filter((id) => !gone.has(id)));
    }
  };

  const onMove = (e: React.PointerEvent) => {
    if (!active) return;
    const p = toCanvas(e);
    if (tool === 'polyline' && corners.length) {
      setHover(place(p, corners[corners.length - 1], e.shiftKey));
    }
    const d = drag.current;
    if (!d) return;
    switch (d.type) {
      case 'line':
        changeDraft((cur) => (cur ? withPoints(cur, [d.start, place(p, d.start, e.shiftKey)]) : cur));
        break;
      case 'rect': {
        const q = place(p, null, false);
        changeDraft((cur) =>
          cur
            ? {
                ...cur,
                x: Math.min(d.start.x, q.x),
                y: Math.min(d.start.y, q.y),
                w: Math.abs(q.x - d.start.x),
                h: Math.abs(q.y - d.start.y),
              }
            : cur,
        );
        break;
      }
      case 'free': {
        const q = onCanvas(p, cw, ch);
        const last = d.pts[d.pts.length - 1];
        if (Math.hypot(q.x - last.x, q.y - last.y) >= 2 * perPx && d.pts.length < MAX_POINTS * 4) {
          d.pts.push(q);
          changeDraft((cur) => (cur ? withPoints(cur, d.pts) : cur));
        }
        break;
      }
      case 'erase':
        erase(p);
        break;
      case 'move': {
        let dx = p.x - d.start.x;
        let dy = p.y - d.start.y;
        if (gridSnap) {
          dx = Math.round(dx / GRID) * GRID;
          dy = Math.round(dy / GRID) * GRID;
        }
        if (!d.moved && (dx !== 0 || dy !== 0)) {
          d.moved = true;
          snapshot();
        }
        const moved = new Map(d.from.map((f) => [f.id, translated(f, dx, dy)]));
        put(elements().map((el) => moved.get(el.id) ?? el));
        break;
      }
      case 'end': {
        const el = elements().find((x) => x.id === d.id);
        if (!el) break;
        const pts = pairs(el.points);
        const anchor = pts[d.index === 0 ? 1 : d.index - 1] ?? null;
        pts[d.index] = place(p, anchor, e.shiftKey, el.id);
        put(elements().map((x) => (x.id === el.id ? withPoints(x, pts) : x)));
        break;
      }
    }
  };

  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.type === 'line') {
      const cur = draftRef.current;
      changeDraft(null);
      const pts = pairs(cur?.points);
      if (cur && pts.length === 2 && Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y) >= 2) add(cur);
    } else if (d.type === 'rect') {
      const cur = draftRef.current;
      changeDraft(null);
      if (cur && cur.w >= 2 && cur.h >= 2) add(cur);
    } else if (d.type === 'free') {
      const pts = simplify(d.pts, 0.75 * perPx).slice(0, MAX_POINTS);
      changeDraft(null);
      if (pts.length >= 2) add(withPoints(base('freehand'), pts));
    }
  };

  const onDoubleClick = () => {
    if (active && tool === 'polyline') finishWall(corners);
  };

  // ── The pick: copy, paste, duplicate, delete, its colour and width ──────────
  const picked = () => elements().filter((el) => selected.includes(el.id));

  const copy = () => {
    clipboard.current = picked();
    setClipped(clipboard.current.length);
  };

  const paste = (from: SketchElement[] = clipboard.current) => {
    if (!from.length) return;
    snapshot();
    const clones = from.map((el) => ({ ...translated(el, 20, 20), id: newElementId() }));
    put([...elements(), ...clones]);
    setSelected(clones.map((c) => c.id));
    clipboard.current = clones;
    setClipped(clones.length);
  };

  const duplicate = () => paste(picked());

  const remove = () => {
    if (!selected.length) return;
    snapshot();
    const gone = new Set(selected);
    put(elements().filter((el) => !gone.has(el.id)));
    setSelected([]);
  };

  /** The colour, width or fill chosen: for the next shape, and for what is picked. */
  const restyle = (patch: Partial<SketchElement>) => {
    const ids = new Set(selected);
    if (!ids.size) return;
    snapshot();
    put(
      elements().map((el) => {
        if (!ids.has(el.id)) return el;
        if (el.kind === 'label') return patch.color ? { ...el, color: patch.color } : el;
        if (!hasPoints(el.kind) && el.kind !== 'rect') return el;
        return { ...el, ...patch, filled: el.kind === 'rect' ? (patch.filled ?? el.filled) : null };
      }),
    );
  };

  const pickColor = (c: DrawColor) => {
    setColor(c);
    restyle({ color: c });
  };
  const pickStroke = (s: DrawStroke) => {
    setStroke(s);
    restyle({ stroke: strokeWidth(s, cw, ch) });
  };
  const pickFilled = (f: boolean) => {
    setFilled(f);
    restyle({ filled: f });
  };

  const chooseTool = (t: DrawTool) => {
    if (corners.length >= 2) finishWall(corners);
    else setCorners([]);
    changeDraft(null);
    setHover(null);
    setTool(t);
    if (t !== 'select') setSelected([]);
  };

  // ── Keys ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();
      if (mod && key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) {
        e.preventDefault();
        redo();
      } else if (mod && key === 'c') {
        copy();
      } else if (mod && key === 'v') {
        e.preventDefault();
        paste();
      } else if (mod && key === 'd') {
        e.preventDefault();
        duplicate();
      } else if (key === 'delete' || key === 'backspace') {
        if (selected.length) {
          e.preventDefault();
          remove();
        }
      } else if (key === 'enter' && corners.length) {
        finishWall(corners);
      } else if (key === 'escape') {
        if (corners.length >= 2) finishWall(corners);
        else setCorners([]);
        changeDraft(null);
        setHover(null);
        setSelected([]);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  // A tool left mid-wall (the mode changed): the wall is finished.
  useEffect(() => {
    if (!active && corners.length) finishWall(corners);
  }, [active, corners, finishWall]);

  return {
    tool, chooseTool, color, pickColor, stroke, pickStroke, filled, pickFilled, angleLock, setAngleLock,
    selected, setSelected, draft, corners, hover,
    onDown, onMove, onUp, onDoubleClick, onElementDown, onHandleDown,
    copy, paste, duplicate, remove, canPaste: clipped > 0,
  };
}

export type DrawTools = ReturnType<typeof useDrawTools>;

// ── The panel ─────────────────────────────────────────────────────────────────

export function DrawPanel({
  tools,
  canUndo,
  canRedo,
  undo,
  redo,
  label,
  onLabelText,
}: {
  tools: DrawTools;
  canUndo: boolean;
  canRedo: boolean;
  undo: () => void;
  redo: () => void;
  /** The one label picked, for its words. */
  label: SketchElement | null;
  onLabelText: (text: string | null) => void;
}) {
  const t = useTranslations('tables.sketch.draw');
  return (
    <div className="space-y-2 rounded-lg border bg-card p-2">
      <div className="flex flex-wrap items-center gap-1">
        {TOOLS.map((tool) => {
          const Icon = TOOL_ICON[tool];
          return (
            <Button
              key={tool}
              size="sm"
              variant={tools.tool === tool ? 'default' : 'outline'}
              className="h-10 min-w-10 px-3"
              title={t(`tool.${tool}`)}
              onClick={() => tools.chooseTool(tool)}
            >
              <Icon className="h-4 w-4 me-1" />
              <span className="hidden sm:inline">{t(`tool.${tool}`)}</span>
            </Button>
          );
        })}
        <div className="ms-auto flex items-center gap-1">
          <Button size="sm" variant="ghost" className="h-10" disabled={!canUndo} onClick={undo} title={t('undo')}>
            <Undo2 className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="ghost" className="h-10" disabled={!canRedo} onClick={redo} title={t('redo')}>
            <Redo2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1" role="group" aria-label={t('colors')}>
          {DRAW_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              title={t(`color.${DRAW_COLOR_KEYS[c]}`)}
              onClick={() => tools.pickColor(c)}
              className={`h-8 w-8 rounded-full border-2 ${tools.color === c ? 'border-amber-500 ring-2 ring-amber-200' : 'border-slate-300'}`}
              style={{ background: c }}
            />
          ))}
        </div>
        <div className="flex items-center gap-1" role="group" aria-label={t('stroke')}>
          {(Object.keys(DRAW_STROKES) as DrawStroke[]).map((s) => (
            <Button
              key={s}
              size="sm"
              variant={tools.stroke === s ? 'default' : 'outline'}
              className="h-9 w-12"
              title={t(`width.${s}`)}
              onClick={() => tools.pickStroke(s)}
            >
              <span className="block w-6 rounded-full bg-current" style={{ height: DRAW_STROKES[s] / 2 + 1 }} />
            </Button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <Button size="sm" variant={tools.filled ? 'outline' : 'default'} className="h-9" onClick={() => tools.pickFilled(false)}>
            {t('outline')}
          </Button>
          <Button size="sm" variant={tools.filled ? 'default' : 'outline'} className="h-9" onClick={() => tools.pickFilled(true)}>
            {t('filled')}
          </Button>
        </div>
        <Button
          size="sm"
          variant={tools.angleLock ? 'default' : 'outline'}
          className="h-9"
          title={t('angleHint')}
          onClick={() => tools.setAngleLock(!tools.angleLock)}
        >
          <Ruler className="h-4 w-4 me-1" />
          {t('angle')}
        </Button>
        <div className="ms-auto flex items-center gap-1">
          <Button size="sm" variant="outline" className="h-9" disabled={!tools.selected.length} onClick={tools.copy} title={t('copy')}>
            <Copy className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="outline" className="h-9" disabled={!tools.canPaste} onClick={() => tools.paste()} title={t('paste')}>
            <ClipboardPaste className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="outline" className="h-9" disabled={!tools.selected.length} onClick={tools.duplicate} title={t('duplicate')}>
            <CopyPlus className="h-4 w-4" />
          </Button>
          <Button size="sm" variant="destructive" className="h-9" disabled={!tools.selected.length} onClick={tools.remove} title={t('delete')}>
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
      </div>
      {label ? (
        <div className="flex items-center gap-2 border-t pt-2">
          <span className="text-xs text-muted-foreground">{t('text')}</span>
          <Input
            className="h-9 w-56"
            value={label.text ?? ''}
            maxLength={60}
            autoFocus
            onChange={(e) => onLabelText(e.target.value || null)}
          />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">{t(`hint.${tools.tool}`)}</p>
      )}
    </div>
  );
}

// ── On the canvas ─────────────────────────────────────────────────────────────

/** The shape being drawn, the wall in the making, and the pick's frames and handles. */
export function DrawOverlay({
  tools,
  elements,
  perPx,
  renderShape,
}: {
  tools: DrawTools;
  elements: SketchElement[];
  perPx: number;
  renderShape: (el: SketchElement) => React.ReactNode;
}) {
  const picked = elements.filter((el) => tools.selected.includes(el.id));
  const r = Math.max(7, 9 * perPx);
  return (
    <g>
      {tools.draft ? <g opacity={0.85}>{renderShape(tools.draft)}</g> : null}
      {tools.corners.length ? (
        <g pointerEvents="none">
          <polyline
            points={[...tools.corners, ...(tools.hover ? [tools.hover] : [])].map((p) => `${p.x},${p.y}`).join(' ')}
            fill="none"
            stroke={tools.color}
            strokeWidth={strokeWidthOf(tools)}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.8}
          />
          {tools.corners.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r={r * 0.6} fill="#ffffff" stroke="#2563eb" strokeWidth={2 * perPx} />
          ))}
        </g>
      ) : null}
      {picked.map((el) => (
        <g key={`pick-${el.id}`}>
          <rect
            x={el.x - 6 * perPx}
            y={el.y - 6 * perPx}
            width={el.w + 12 * perPx}
            height={el.h + 12 * perPx}
            fill="none"
            stroke="#2563eb"
            strokeWidth={1.5 * perPx}
            strokeDasharray={`${6 * perPx} ${4 * perPx}`}
            pointerEvents="none"
          />
          {tools.tool === 'select' && (el.kind === 'line' || el.kind === 'polyline') && tools.selected.length === 1
            ? pairs(el.points).map((p, i) => (
                <circle
                  key={i}
                  cx={p.x}
                  cy={p.y}
                  r={r}
                  fill="#ffffff"
                  stroke="#2563eb"
                  strokeWidth={2.5 * perPx}
                  style={{ cursor: 'grab' }}
                  onPointerDown={(e) => tools.onHandleDown(e, el, i)}
                />
              ))
            : null}
        </g>
      ))}
    </g>
  );
}

function strokeWidthOf(tools: DrawTools): number {
  return DRAW_STROKES[tools.stroke];
}
