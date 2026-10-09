/**
 * The vector floor plan ("סקיצה") drawn under a map zone's tables: walls, the entrance,
 * the bar, the kitchen pass, windows, restrooms, plants, columns and labels — shapes in
 * the zone's canvas units, saved with the zone (`sketch`) and drawn by the till the same
 * way (ui/tables/TablesScreen.kt — keep the two in step: kinds, colours, default words).
 *
 * The templates are ready-made sketches to start from, laid out for any canvas size.
 */

export type SketchKind =
  | 'wall'
  | 'bar'
  | 'door'
  | 'kitchen'
  | 'window'
  | 'restroom'
  | 'plant'
  | 'column'
  | 'label'
  | 'counter'
  // Fixtures drawn with a symbol: stairs, the cash desk, the host's stand, the emergency
  // exit, a stage, a sofa.
  | 'stairs'
  | 'cashier'
  | 'host'
  | 'exit'
  | 'stage'
  | 'sofa'
  // Drawn with the drawing tools: free lines and shapes in a colour and a stroke width.
  | 'line'
  | 'polyline'
  | 'freehand'
  | 'rect'
  // The business's logo, placed on the floor: its own picture (`src`), else the business's.
  | 'logo';

export interface SketchElement {
  id: string;
  kind: SketchKind;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  text?: string | null;
  /** A bar counter ("counter"): straight or L-shaped. */
  variant?: 'straight' | 'L' | null;
  /** A bar counter's stools drawn in front of it (0 once they became tables). */
  stools?: number;
  /** A drawn line, polyline (a wall) or freehand stroke: its points, x, y, x, y… in canvas units. */
  points?: number[] | null;
  /** A drawn shape's colour ("#rrggbb"); a label's text colour. */
  color?: string | null;
  /** A drawn shape's stroke width, in canvas units. */
  stroke?: number | null;
  /** A drawn rectangle: filled, or its outline only. */
  filled?: boolean | null;
  /** A logo's own picture (an uploaded image's URL); none — the business's logo. */
  src?: string | null;
}

/**
 * The floor under the plan. Null: the clean floor (flat and neutral, a faint grid), or the
 * uploaded image when the zone has one. Wood, tiles, light and dark stay for whoever chose them.
 */
export type SketchBackground = 'clean' | 'wood' | 'tiles' | 'light' | 'dark' | 'image';
export const SKETCH_BACKGROUNDS: SketchBackground[] = ['clean', 'wood', 'tiles', 'light', 'dark', 'image'];

export interface Sketch {
  template?: string | null;
  background?: SketchBackground | null;
  elements: SketchElement[];
}

export const SKETCH_KINDS: SketchKind[] = [
  'wall', 'door', 'window', 'counter', 'bar', 'kitchen', 'restroom', 'plant', 'column',
  'stairs', 'cashier', 'host', 'exit', 'stage', 'sofa', 'label', 'logo',
];

/** The background a zone is drawn on: an explicit choice, else its image, else the clean floor. */
export function backgroundOf(sketch: Sketch | null | undefined, hasImage: boolean): SketchBackground {
  const chosen = sketch?.background;
  if (chosen === 'image') return hasImage ? 'image' : 'clean';
  if (chosen) return chosen;
  return hasImage ? 'image' : 'clean';
}

/** A bar counter's parts, in canvas units before its rotation (the till computes the same). */
export function counterGeometry(el: SketchElement): {
  bars: { x: number; y: number; w: number; h: number }[];
  stools: { cx: number; cy: number; r: number }[];
} {
  const n = Math.max(0, Math.min(40, el.stools ?? 0));
  if (el.variant === 'L') {
    const c = Math.min(el.w, el.h) * 0.28;
    const band = Math.min(c * 1.3, el.h - c);
    const length = el.w - c;
    const d = n ? Math.min(band * 0.75, (length / n) * 0.8) : 0;
    return {
      bars: [
        { x: el.x, y: el.y + el.h - c, w: el.w, h: c },
        { x: el.x + el.w - c, y: el.y, w: c, h: el.h - c },
      ],
      stools: Array.from({ length: n }, (_, i) => ({
        cx: el.x + (i + 0.5) * (length / n),
        cy: el.y + el.h - c - band / 2,
        r: d / 2,
      })),
    };
  }
  const c = el.h * 0.5;
  const d = n ? Math.min((el.h - c) * 0.75, (el.w / n) * 0.8) : 0;
  return {
    bars: [{ x: el.x, y: el.y, w: el.w, h: c }],
    stools: Array.from({ length: n }, (_, i) => ({
      cx: el.x + (i + 0.5) * (el.w / n),
      cy: el.y + c + (el.h - c) / 2,
      r: d / 2,
    })),
  };
}

/** A point of an element turned by its rotation about its centre (for stools made tables). */
export function rotatePoint(el: SketchElement, px: number, py: number): { x: number; y: number } {
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  const a = (el.rotation * Math.PI) / 180;
  const dx = px - cx;
  const dy = py - cy;
  return { x: cx + dx * Math.cos(a) - dy * Math.sin(a), y: cy + dx * Math.sin(a) + dy * Math.cos(a) };
}

/** The wood floor's plank tones, seams and grain — the till draws the same planks. */
export const WOOD = {
  plank: 64,
  length: 520,
  tones: ['#ead6b6', '#e4cca8', '#efdcbd', '#e2c8a2', '#ebd4b1', '#e7d0ad'],
  seam: '#c8a97e',
  grain: '#d9bd96',
};
export const TILE = { size: 90, fill: '#eceae6', grout: '#d4d0c8' };
export const PLAIN = { light: '#f8fafc', dark: '#334155' };
/** The clean floor: flat grey with a faint grid every 50 units (the till draws the same). */
export const CLEAN = { fill: '#eef1f4', grid: '#e2e6eb', step: 50 };

/** Table colours on the floor: crisp white shapes, a thin slate edge, gold when picked. */
export const TABLE_LOOK = {
  fill: '#ffffff',
  border: '#94a3b8',
  number: '#1e293b',
  gold: '#f59e0b',
};

/** Fill, stroke and whether the shape is round — the till uses the same colours. */
export const SKETCH_STYLE: Record<SketchKind, { fill: string; stroke: string; round?: boolean; dashed?: boolean; text: string }> = {
  wall: { fill: '#475569', stroke: '#334155', text: '#ffffff' },
  window: { fill: '#bfdbfe', stroke: '#3b82f6', text: '#1e3a8a' },
  door: { fill: '#bbf7d0', stroke: '#16a34a', text: '#14532d' },
  bar: { fill: '#e7c39b', stroke: '#92400e', text: '#451a03' },
  kitchen: { fill: '#e2e8f0', stroke: '#64748b', dashed: true, text: '#1e293b' },
  restroom: { fill: '#e0e7ff', stroke: '#6366f1', text: '#312e81' },
  plant: { fill: '#86efac', stroke: '#15803d', round: true, text: '#14532d' },
  column: { fill: '#94a3b8', stroke: '#475569', text: '#0f172a' },
  label: { fill: 'transparent', stroke: 'transparent', text: '#0f172a' },
  counter: { fill: '#fafaf9', stroke: '#a8a29e', text: '#57534e' },
  stairs: { fill: '#e5e7eb', stroke: '#6b7280', text: '#1f2937' },
  cashier: { fill: '#fde68a', stroke: '#b45309', text: '#78350f' },
  host: { fill: '#fbcfe8', stroke: '#be185d', text: '#831843' },
  exit: { fill: '#22c55e', stroke: '#15803d', text: '#ffffff' },
  stage: { fill: '#ddd6fe', stroke: '#6d28d9', text: '#3b0764' },
  sofa: { fill: '#d6c4a8', stroke: '#8b6f47', text: '#3f2e1c' },
  // Drawn shapes take their own colour; these are the defaults.
  line: { fill: 'transparent', stroke: '#6b4423', text: '#0f172a' },
  polyline: { fill: 'transparent', stroke: '#6b4423', text: '#0f172a' },
  freehand: { fill: 'transparent', stroke: '#6b4423', text: '#0f172a' },
  rect: { fill: 'transparent', stroke: '#6b4423', text: '#0f172a' },
  logo: { fill: 'transparent', stroke: '#94a3b8', text: '#64748b' },
};

/** The word drawn on a shape with no text of its own (the till draws the same). */
export const SKETCH_DEFAULT_TEXT: Partial<Record<SketchKind, string>> = {
  door: 'כניסה',
  bar: 'בר',
  kitchen: 'מטבח',
  restroom: 'שירותים',
  label: 'טקסט',
  stairs: 'מדרגות',
  cashier: 'קופה',
  host: 'מארחת',
  exit: 'יציאת חירום',
  stage: 'במה',
};

/**
 * The elements with each id once (the first kept). A sketch saved while the line tool
 * added a finished line twice holds two elements under one id; loading it through here
 * shows it once, and the next save stores it once.
 */
export function uniqueElements(elements: SketchElement[]): SketchElement[] {
  const seen = new Set<string>();
  return elements.filter((el) => (seen.has(el.id) ? false : (seen.add(el.id), true)));
}

export function newElementId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

/** A new shape of `kind` in the middle of the canvas, sized to it. */
export function newElement(kind: SketchKind, cw: number, ch: number): SketchElement {
  const s = Math.min(cw, ch);
  const size: Record<SketchKind, [number, number]> = {
    wall: [s * 0.4, Math.max(8, s * 0.015)],
    window: [s * 0.2, Math.max(6, s * 0.012)],
    door: [s * 0.14, Math.max(10, s * 0.03)],
    bar: [s * 0.35, s * 0.08],
    kitchen: [s * 0.3, s * 0.2],
    restroom: [s * 0.16, s * 0.14],
    plant: [s * 0.06, s * 0.06],
    column: [s * 0.04, s * 0.04],
    label: [s * 0.2, s * 0.05],
    counter: [s * 0.6, s * 0.18],
    stairs: [s * 0.12, s * 0.2],
    cashier: [s * 0.14, s * 0.1],
    host: [s * 0.1, s * 0.08],
    exit: [s * 0.16, s * 0.05],
    stage: [s * 0.35, s * 0.14],
    sofa: [s * 0.24, s * 0.09],
    line: [s * 0.3, 0],
    polyline: [s * 0.3, 0],
    freehand: [s * 0.1, s * 0.1],
    rect: [s * 0.2, s * 0.12],
    logo: [s * 0.2, s * 0.12],
  };
  const [w, h] = size[kind];
  return {
    id: newElementId(),
    kind,
    x: Math.round(cw / 2 - w / 2),
    y: Math.round(ch / 2 - h / 2),
    w: Math.round(w),
    h: Math.round(h),
    rotation: 0,
    text: kind === 'label' ? SKETCH_DEFAULT_TEXT.label : null,
    ...(kind === 'counter' ? { variant: 'straight' as const, stools: 6 } : {}),
  };
}

// ── Templates ────────────────────────────────────────────────────────────────

export type SketchTemplate = 'smallRestaurant' | 'cafeBar' | 'eventHall' | 'terrace' | 'counter';
export const SKETCH_TEMPLATES: SketchTemplate[] = ['smallRestaurant', 'cafeBar', 'eventHall', 'terrace', 'counter'];

type Box = [SketchKind, number, number, number, number, string?, { variant?: 'straight' | 'L'; stools?: number }?];

/** Walls around the canvas with a gap for the entrance on the bottom wall at [gapFrom, gapTo] (fractions). */
function frame(gapFrom: number, gapTo: number, t: number): Box[] {
  return [
    ['wall', 0, 0, 1, t],
    ['wall', 0, 0, t, 1],
    ['wall', 1 - t, 0, t, 1],
    ['wall', 0, 1 - t, gapFrom, t],
    ['wall', gapTo, 1 - t, 1 - gapTo, t],
    ['door', gapFrom, 1 - t * 2.4, gapTo - gapFrom, t * 2.4],
  ];
}

const TEMPLATE_BOXES: Record<SketchTemplate, Box[]> = {
  // A small dining room: windows on the street side, kitchen and restrooms at the back.
  smallRestaurant: [
    ...frame(0.42, 0.58, 0.015),
    ['window', 0.1, 0.985, 0.22, 0.015],
    ['window', 0.68, 0.985, 0.22, 0.015],
    ['kitchen', 0.62, 0.015, 0.365, 0.24],
    ['wall', 0.6, 0.015, 0.012, 0.24],
    ['restroom', 0.015, 0.015, 0.16, 0.18],
    ['bar', 0.3, 0.27, 0.3, 0.06, 'פס הגשה'],
    ['plant', 0.03, 0.88, 0.05, 0.07],
    ['plant', 0.92, 0.88, 0.05, 0.07],
  ],
  // A café with a long bar on one side and windows on the street.
  cafeBar: [
    ...frame(0.08, 0.24, 0.015),
    ['window', 0.015, 0.2, 0.015, 0.25],
    ['window', 0.015, 0.55, 0.015, 0.25],
    ['counter', 0.3, 0.68, 0.53, 0.3, undefined, { variant: 'L', stools: 7 }],
    ['kitchen', 0.84, 0.015, 0.145, 0.3],
    ['restroom', 0.84, 0.75, 0.145, 0.235],
    ['plant', 0.4, 0.88, 0.05, 0.07],
    ['column', 0.45, 0.45, 0.03, 0.04],
  ],
  // A hall: a stage, a dance floor, the kitchen and restrooms along the back.
  eventHall: [
    ...frame(0.44, 0.56, 0.012),
    ['bar', 0.35, 0.015, 0.3, 0.1, 'במה'],
    ['label', 0.38, 0.2, 0.24, 0.06, 'רחבת ריקודים'],
    ['kitchen', 0.015, 0.015, 0.2, 0.22],
    ['restroom', 0.8, 0.015, 0.185, 0.16],
    ['bar', 0.8, 0.5, 0.06, 0.3, 'בר'],
    ['column', 0.3, 0.45, 0.025, 0.035],
    ['column', 0.675, 0.45, 0.025, 0.035],
  ],
  // An outdoor terrace or garden: a railing, plants, the door to the inside.
  terrace: [
    ['wall', 0, 0, 0.42, 0.012],
    ['door', 0.42, 0, 0.16, 0.03, 'כניסה פנימה'],
    ['wall', 0.58, 0, 0.42, 0.012],
    ['window', 0, 0, 0.008, 1],
    ['window', 0.992, 0, 0.008, 1],
    ['window', 0, 0.992, 1, 0.008],
    ['plant', 0.02, 0.04, 0.06, 0.08],
    ['plant', 0.92, 0.04, 0.06, 0.08],
    ['plant', 0.02, 0.88, 0.06, 0.08],
    ['plant', 0.92, 0.88, 0.06, 0.08],
    ['plant', 0.47, 0.88, 0.06, 0.08],
  ],
  // A counter with stools along it and a little seating.
  counter: [
    ...frame(0.4, 0.6, 0.015),
    ['kitchen', 0.015, 0.015, 0.97, 0.18],
    ['counter', 0.1, 0.2, 0.8, 0.16, undefined, { variant: 'straight', stools: 10 }],
    ['window', 0.015, 0.4, 0.015, 0.3],
    ['window', 0.97, 0.4, 0.015, 0.3],
    ['restroom', 0.84, 0.75, 0.145, 0.235],
  ],
};

/** A template laid out on a `cw` × `ch` canvas. */
export function templateSketch(template: SketchTemplate, cw: number, ch: number): Sketch {
  return {
    template,
    // The floor stays whatever was chosen (the editor keeps it); a template draws no floor.
    background: null,
    elements: TEMPLATE_BOXES[template].map(([kind, x, y, w, h, text, extra]) => ({
      id: newElementId(),
      kind,
      x: Math.round(x * cw),
      y: Math.round(y * ch),
      w: Math.max(2, Math.round(w * cw)),
      h: Math.max(2, Math.round(h * ch)),
      rotation: 0,
      text: text ?? (kind === 'label' ? SKETCH_DEFAULT_TEXT.label : null),
      ...(kind === 'counter' ? { variant: extra?.variant ?? 'straight', stools: extra?.stools ?? 6 } : {}),
    })),
  };
}

/** A new table's size: about 12% of the canvas's shorter side (as the server's bulk add). */
export function defaultTableSize(cw: number, ch: number, shape: 'round' | 'square' | 'rect'): { width: number; height: number } {
  const side = Math.max(40, Math.round(Math.min(cw, ch) * 0.12));
  return shape === 'rect' ? { width: Math.round(side * 1.5), height: Math.round(side * 0.8) } : { width: side, height: side };
}

// ── Chairs ("כסאות") ──────────────────────────────────────────────────────────

/**
 * The chairs round a table, from its seats — the till draws the same
 * (domain/TableFloor.kt, ChairLayout): a chair's depth and its gap from the table as a
 * fraction of the table's shorter side; at most 24 drawn.
 */
export const CHAIR = { depth: 0.22, gap: 0.05, maxDrawn: 24 };
export const CHAIR_REACH = CHAIR.depth + CHAIR.gap;

/** A chair: its centre from the table's top-left, its width along the edge, its depth, which way it faces out (0 = above). */
export interface Chair {
  cx: number;
  cy: number;
  width: number;
  depth: number;
  angle: number;
}

/** How many chairs on each side — top, right, bottom, left — the long sides first. */
export function chairSides(seats: number, w: number, h: number): [number, number, number, number] {
  const n = Math.max(0, Math.min(CHAIR.maxDrawn, Math.round(seats)));
  const out: [number, number, number, number] = [0, 0, 0, 0];
  if (!n) return out;
  const horizontal = w >= h;
  const long = Math.max(w, h);
  const short = Math.max(0.0001, Math.min(w, h));
  const [l1, l2] = horizontal ? [0, 2] : [1, 3];
  const [e1, e2] = horizontal ? [3, 1] : [0, 2];
  if (long / short < 1.3) {
    const order = [l1, l2, e1, e2];
    for (let i = 0; i < n; i++) out[order[i % 4]]++;
    return out;
  }
  const ends = n >= 6 ? 2 : n === 5 ? 1 : 0;
  const m = n - ends;
  out[l1] = Math.ceil(m / 2);
  out[l2] = Math.floor(m / 2);
  if (ends >= 1) out[e1] = 1;
  if (ends === 2) out[e2] = 1;
  return out;
}

export function chairLayout(round: boolean, w: number, h: number, seats: number): Chair[] {
  const n = Math.max(0, Math.min(CHAIR.maxDrawn, Math.round(seats)));
  if (!n || w <= 0 || h <= 0) return [];
  const short = Math.min(w, h);
  const depth = short * CHAIR.depth;
  const gap = short * CHAIR.gap;
  if (round) {
    const rx = w / 2;
    const ry = h / 2;
    const ring = 2 * Math.PI * ((rx + ry) / 2 + gap + depth / 2);
    const width = Math.min(short * 0.36, (ring / n) * 0.72);
    return Array.from({ length: n }, (_, i) => {
      const a = ((-90 + (360 * i) / n) * Math.PI) / 180;
      return {
        cx: rx + (rx + gap + depth / 2) * Math.cos(a),
        cy: ry + (ry + gap + depth / 2) * Math.sin(a),
        width,
        depth,
        angle: ((i * 360) / n) % 360,
      };
    });
  }
  const per = chairSides(n, w, h);
  const out: Chair[] = [];
  per.forEach((k, side) => {
    if (!k) return;
    const along = side === 0 || side === 2 ? w : h;
    const width = Math.min((along / k) * 0.7, short * 0.36);
    for (let i = 0; i < k; i++) {
      const t = (along * (i + 0.5)) / k;
      if (side === 0) out.push({ cx: t, cy: -gap - depth / 2, width, depth, angle: 0 });
      else if (side === 1) out.push({ cx: w + gap + depth / 2, cy: t, width, depth, angle: 90 });
      else if (side === 2) out.push({ cx: w - t, cy: h + gap + depth / 2, width, depth, angle: 180 });
      else out.push({ cx: -gap - depth / 2, cy: h - t, width, depth, angle: 270 });
    }
  });
  return out;
}

/** Chairs, quiet: a pale seat, a darker back, a thin edge (the till draws the same). */
export const CHAIR_LOOK = { wood: '#e5e7eb', back: '#cbd5e1', edge: '#94a3b8' };

export const TABLE_SIZE_MIN = 30;
export const TABLE_SIZE_MAX = 600;

export function clampSize(v: number): number {
  return Math.min(TABLE_SIZE_MAX, Math.max(TABLE_SIZE_MIN, Math.round(v)));
}

// ── Drawing ("ציור"): lines, walls, rectangles, freehand, text ────────────────

/** The kinds drawn point by point (and drawn the same way by the till). */
export const DRAWN_KINDS: SketchKind[] = ['line', 'polyline', 'freehand', 'rect'];
export const isDrawn = (kind: SketchKind) => DRAWN_KINDS.includes(kind);
export const hasPoints = (kind: SketchKind) => kind === 'line' || kind === 'polyline' || kind === 'freehand';

/** The drawing colours: dark wood, black, grey, white, the brand's blue, red. */
export const DRAW_COLORS = ['#6b4423', '#111827', '#6b7280', '#ffffff', '#2563eb', '#dc2626'] as const;
export type DrawColor = (typeof DRAW_COLORS)[number];
export const DRAW_COLOR_KEYS: Record<DrawColor, string> = {
  '#6b4423': 'wood',
  '#111827': 'black',
  '#6b7280': 'grey',
  '#ffffff': 'white',
  '#2563eb': 'blue',
  '#dc2626': 'red',
};

/** Thin, medium, thick — in canvas units of a 1000-wide canvas, scaled to the zone's. */
export const DRAW_STROKES = { thin: 3, medium: 6, thick: 12 } as const;
export type DrawStroke = keyof typeof DRAW_STROKES;
export function strokeWidth(s: DrawStroke, cw: number, ch: number): number {
  return Math.max(0.5, Math.min(60, Math.round(((DRAW_STROKES[s] * Math.max(cw, ch)) / 1000) * 10) / 10));
}

/** At most this many points in one stroke (the cloud keeps 2,000 pairs). */
export const MAX_POINTS = 1800;

export type Pt = { x: number; y: number };

export function pairs(points: number[] | null | undefined): Pt[] {
  const out: Pt[] = [];
  if (!points) return out;
  for (let i = 0; i + 1 < points.length; i += 2) out.push({ x: points[i], y: points[i + 1] });
  return out;
}

export function flat(pts: Pt[]): number[] {
  return pts.flatMap((p) => [Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]);
}

/** A drawn shape's points set — and its box (x, y, w, h) kept around them, as the cloud wants it. */
export function withPoints(el: SketchElement, pts: Pt[]): SketchElement {
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { ...el, points: flat(pts), x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

/** Shift (or the angle lock): the segment from `from` turned to the nearest 0°/45°/90°, its length kept. */
export function snapAngle(from: Pt, to: Pt): Pt {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return to;
  const step = Math.PI / 4;
  const a = Math.round(Math.atan2(dy, dx) / step) * step;
  return { x: from.x + Math.cos(a) * len, y: from.y + Math.sin(a) * len };
}

/** The ends and corners of every drawn line and wall: what a new point snaps to. */
export function endpoints(elements: SketchElement[], exceptId?: string): Pt[] {
  const out: Pt[] = [];
  for (const el of elements) {
    if (el.id === exceptId || (el.kind !== 'line' && el.kind !== 'polyline')) continue;
    out.push(...pairs(el.points));
  }
  return out;
}

/** The nearest of `candidates` within `tolerance`, or null. */
export function nearest(candidates: Pt[], p: Pt, tolerance: number): Pt | null {
  let best: Pt | null = null;
  let bestD = tolerance;
  for (const c of candidates) {
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (d <= bestD) {
      best = c;
      bestD = d;
    }
  }
  return best;
}

function segmentDistance(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Is `p` on the shape (within `tolerance`)? The eraser's and the select tool's test. */
export function hitTest(el: SketchElement, p: Pt, tolerance: number): boolean {
  if (hasPoints(el.kind)) {
    const pts = pairs(el.points);
    const reach = tolerance + (el.stroke ?? 3) / 2;
    for (let i = 0; i + 1 < pts.length; i++) if (segmentDistance(p, pts[i], pts[i + 1]) <= reach) return true;
    return pts.length === 1 && Math.hypot(p.x - pts[0].x, p.y - pts[0].y) <= reach;
  }
  // Boxes (a turned shape is tested on its box: close enough for picking).
  const inside =
    p.x >= el.x - tolerance && p.x <= el.x + el.w + tolerance && p.y >= el.y - tolerance && p.y <= el.y + el.h + tolerance;
  if (!inside) return false;
  if (el.kind === 'rect' && el.filled !== true) {
    const reach = tolerance + (el.stroke ?? 3) / 2;
    return (
      Math.abs(p.x - el.x) <= reach ||
      Math.abs(p.x - (el.x + el.w)) <= reach ||
      Math.abs(p.y - el.y) <= reach ||
      Math.abs(p.y - (el.y + el.h)) <= reach
    );
  }
  return true;
}

/** Moved by (dx, dy): its box, and its points when it has them. */
export function translated(el: SketchElement, dx: number, dy: number): SketchElement {
  if (hasPoints(el.kind) && el.points) {
    return withPoints(el, pairs(el.points).map((p) => ({ x: p.x + dx, y: p.y + dy })));
  }
  return { ...el, x: el.x + dx, y: el.y + dy };
}

/** A freehand stroke with the points that add nothing dropped (Ramer–Douglas–Peucker). */
export function simplify(pts: Pt[], epsilon: number): Pt[] {
  if (pts.length <= 2) return pts;
  let index = 0;
  let max = 0;
  const first = pts[0];
  const last = pts[pts.length - 1];
  for (let i = 1; i < pts.length - 1; i++) {
    const d = segmentDistance(pts[i], first, last);
    if (d > max) {
      max = d;
      index = i;
    }
  }
  if (max <= epsilon) return [first, last];
  const left = simplify(pts.slice(0, index + 1), epsilon);
  const right = simplify(pts.slice(index), epsilon);
  return [...left.slice(0, -1), ...right];
}

/** A point kept on the canvas. */
export function onCanvas(p: Pt, cw: number, ch: number): Pt {
  return { x: Math.max(0, Math.min(cw, p.x)), y: Math.max(0, Math.min(ch, p.y)) };
}
