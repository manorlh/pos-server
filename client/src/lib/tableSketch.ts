/**
 * The vector floor plan ("סקיצה") drawn under a map zone's tables: walls, the entrance,
 * the bar, the kitchen pass, windows, restrooms, plants, columns and labels — shapes in
 * the zone's canvas units, saved with the zone (`sketch`) and drawn by the till the same
 * way (ui/tables/TablesScreen.kt — keep the two in step: kinds, colours, default words).
 *
 * The templates are ready-made sketches to start from, laid out for any canvas size.
 *
 * Sketch schema 3 (P:/specs/table-map-decor-v3.md): the symbols of service, guests,
 * atmosphere and safety, the greenery, the direction arrow and the coloured area; the
 * palette in tabs with a search; snapping to the walls; duplicating in a row; a symbol's own
 * colour; and how the till shows it all (`mapDecor`, `mapLegend`, `mapSymbolLabels`,
 * `mapSymbolScale` — the preview's fit and display, ported from the till's DecorFit.kt).
 */

import { sortTables } from './tableLabels';

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
  | 'logo'
  // Sketch schema 2 — the decor symbols ("סמלים", specs/table-map-decor.md): the DJ booth.
  | 'dj_booth'
  // Sketch schema 3 (P:/specs/table-map-decor-v3.md §1, §2): SKETCH_KINDS_3.
  | 'service_station'
  | 'coffee_station'
  | 'buffet'
  | 'dessert_station'
  | 'display_fridge'
  | 'elevator'
  | 'kids_corner'
  | 'smoking'
  | 'no_smoking'
  | 'coat_check'
  | 'waiting_area'
  | 'tv'
  | 'speaker'
  | 'pickup'
  | 'delivery_exit'
  | 'trash'
  | 'sink'
  | 'first_aid'
  | 'fire_extinguisher'
  | 'parking'
  | 'outdoor'
  | 'heater'
  | 'fan_ac'
  | 'arrow'
  | 'tree'
  | 'planter'
  | 'green_wall'
  | 'hedge'
  | 'flowers'
  | 'area';

/** The kinds sketch schema 3 adds (the server's SKETCH_KINDS_3, in its order). */
export const SKETCH_KINDS_3: SketchKind[] = [
  'service_station', 'coffee_station', 'buffet', 'dessert_station', 'display_fridge', 'elevator',
  'kids_corner', 'smoking', 'no_smoking', 'coat_check', 'waiting_area', 'tv', 'speaker', 'pickup',
  'delivery_exit', 'trash', 'sink', 'first_aid', 'fire_extinguisher', 'parking', 'outdoor', 'heater',
  'fan_ac', 'arrow', 'tree', 'planter', 'green_wall', 'hedge', 'flowers', 'area',
];

/** "צמחייה": drawn as what they are, in a colour of their own when chosen. */
export const GREENERY_KINDS: SketchKind[] = ['plant', 'tree', 'planter', 'green_wall', 'hedge', 'flowers'];

/**
 * What a variant means on the kinds that take one (the server's SKETCH_VARIANTS): a bar's
 * shape; whose restrooms (none: both); a plain exit ("יציאה"; none: the emergency exit); what
 * a bar ("דלפק") pours; which entrance; a plant's size.
 */
export type SketchVariant =
  | 'straight'
  | 'L'
  | 'U'
  | 'men'
  | 'women'
  | 'accessible'
  | 'plain'
  | 'cocktail'
  | 'beer'
  | 'wine'
  | 'main'
  | 'side'
  | 'staff'
  | 'large'
  | 'small';
export const SKETCH_VARIANTS: Partial<Record<SketchKind, SketchVariant[]>> = {
  counter: ['straight', 'L', 'U'],
  restroom: ['men', 'women', 'accessible'],
  exit: ['plain'],
  bar: ['cocktail', 'beer', 'wine'],
  door: ['main', 'side', 'staff'],
  plant: ['large', 'small'],
};
/** The sketch schema this editor writes (the server's SKETCH_SCHEMA; the till's too). */
export const SKETCH_SCHEMA = 4;

/** `variant` as `kind` keeps it: a counter is straight unless L or U; a restroom or an exit only its own; others none. */
export function variantOf(kind: SketchKind, variant: SketchVariant | null | undefined): SketchVariant | null {
  if (kind === 'counter') return variant === 'L' || variant === 'U' ? variant : 'straight';
  return variant && SKETCH_VARIANTS[kind]?.includes(variant) ? variant : null;
}

export interface SketchElement {
  id: string;
  kind: SketchKind;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: number;
  text?: string | null;
  /**
   * A bar counter ("counter"): straight, L- or U-shaped. Restrooms: men / women / accessible
   * (none: both). An exit: plain (none: the emergency exit). See SKETCH_VARIANTS.
   */
  variant?: SketchVariant | null;
  /** A bar counter's stools drawn in front of it (0 once they became tables). */
  stools?: number;
  /**
   * A drawn line, polyline (a wall) or freehand stroke: its points, x, y, x, y… in canvas units.
   * An area: its polygon's corners (none: the rectangle).
   */
  points?: number[] | null;
  /**
   * A drawn shape's colour ("#rrggbb"); a label's text colour; a symbol's own colour (none: its
   * kind's, the theme's); an area's name.
   */
  color?: string | null;
  /** A drawn shape's stroke width, in canvas units. */
  stroke?: number | null;
  /** A drawn rectangle: filled, or its outline only. */
  filled?: boolean | null;
  /** A logo's own picture (an uploaded image's URL); none — the business's logo. */
  src?: string | null;
  /** An area ("אזור"): its fill, from AREA_FILLS. */
  fill?: string | null;
  /** An area: how opaque its fill is, in percent (10–60). A logo: how opaque it is (20–100; none: 100). */
  opacity?: number | null;
  /**
   * Schema 4 ("טקסט ולוגו", P:/specs/table-map-decor-v3.md §8). A text: its size — a name (s / m / l /
   * xl) or 10–72 canvas units; none: fitted to its box.
   */
  fontSize?: LabelFontSize | null;
  /** A text in bold. */
  bold?: boolean | null;
  /** A text's chip behind it ("#rrggbb", its box) and how opaque the chip is (10–100). */
  bg?: string | null;
  bgOpacity?: number | null;
  /** A text's alignment in its box (none: centred). */
  align?: LabelAlign | null;
  /** A logo: the business's, or the picture uploaded for it (`src`); none — `src` decides. */
  source?: LogoSource | null;
  /** A logo stretched to its box (false); none or true — fitted, its proportions kept. */
  keepAspect?: boolean | null;
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

// ── The palette ("הוסף"): tabs, names, search (v3 §4) ─────────────────────────

/** The palette's tabs: service, guests, atmosphere, safety, the room's structure. */
export type PaletteTab = 'service' | 'guests' | 'atmosphere' | 'safety' | 'structure';
export const PALETTE_TABS: PaletteTab[] = ['service', 'guests', 'atmosphere', 'safety', 'structure'];
export const PALETTE_TAB_NAMES: Record<PaletteTab, string> = {
  service: 'שירות',
  guests: 'אורחים',
  atmosphere: 'אווירה',
  safety: 'בטיחות',
  structure: 'מבנה',
};

/** One button of the palette: a kind, as a new one gets it (an exit is plain or the emergency one). */
export interface PaletteEntry {
  kind: SketchKind;
  variant: SketchVariant | null;
}
const pe = (kind: SketchKind, variant: SketchVariant | null = null): PaletteEntry => ({ kind, variant });

/**
 * The tabs' buttons, in the order the spec lists them (v3 §4); what it leaves unlisted goes where
 * it is used: the cash desk, the sink and the bin under service, the host's stand under guests,
 * the sofa under atmosphere. The plain exit is the guests' way out, the emergency exit safety's.
 */
export const PALETTE: Record<PaletteTab, PaletteEntry[]> = {
  service: [
    pe('service_station'), pe('coffee_station'), pe('buffet'), pe('dessert_station'), pe('display_fridge'), pe('pickup'),
    pe('delivery_exit'), pe('cashier'), pe('sink'), pe('trash'),
  ],
  guests: [
    pe('restroom'), pe('door'), pe('exit', 'plain'), pe('waiting_area'), pe('coat_check'), pe('kids_corner'), pe('elevator'),
    pe('parking'), pe('host'),
  ],
  atmosphere: [
    pe('stage'), pe('dj_booth'), pe('tv'), pe('speaker'), pe('plant'), pe('outdoor'), pe('heater'), pe('fan_ac'),
    pe('tree'), pe('planter'), pe('green_wall'), pe('hedge'), pe('flowers'), pe('sofa'),
  ],
  safety: [pe('exit'), pe('first_aid'), pe('fire_extinguisher'), pe('smoking'), pe('no_smoking')],
  structure: [
    pe('wall'), pe('window'), pe('column'), pe('stairs'), pe('bar'), pe('counter'), pe('kitchen'), pe('area'), pe('arrow'),
    pe('label'), pe('logo'),
  ],
};

/** Every kind the palette adds, once, in the palette's order (the drawn kinds are the drawing tools'). */
export const SKETCH_KINDS: SketchKind[] = [...new Set(PALETTE_TABS.flatMap((tab) => PALETTE[tab].map((p) => p.kind)))];

/** Each kind's name, in Hebrew: the palette's, the legend's, the selected shape's. */
export const SKETCH_NAMES: Record<SketchKind, string> = {
  wall: 'קיר',
  bar: 'דלפק',
  door: 'כניסה',
  kitchen: 'מטבח',
  window: 'חלון',
  restroom: 'שירותים',
  plant: 'עציץ',
  column: 'עמוד',
  label: 'טקסט',
  counter: 'בר + כיסאות',
  stairs: 'מדרגות',
  cashier: 'קופה',
  host: 'עמדת מארחת',
  exit: 'יציאה',
  stage: 'במה',
  sofa: 'ספה',
  line: 'קו',
  polyline: 'קיר / קו שבור',
  freehand: 'ציור חופשי',
  rect: 'מלבן',
  logo: 'לוגו',
  dj_booth: "עמדת די־ג'יי",
  service_station: 'עמדת מלצרים',
  coffee_station: 'עמדת קפה',
  buffet: 'מזנון / בופה',
  dessert_station: 'עמדת קינוחים',
  display_fridge: 'ויטרינה / מקרר',
  elevator: 'מעלית',
  kids_corner: 'פינת ילדים',
  smoking: 'אזור עישון',
  no_smoking: 'ללא עישון',
  coat_check: 'מלתחה',
  waiting_area: 'אזור המתנה',
  tv: 'מסך / טלוויזיה',
  speaker: 'רמקול',
  pickup: 'איסוף הזמנות',
  delivery_exit: 'יציאת שליחים',
  trash: 'פח',
  sink: 'כיור / שטיפת ידיים',
  first_aid: 'עזרה ראשונה',
  fire_extinguisher: 'מטף',
  parking: 'חניה',
  outdoor: 'ישיבה בחוץ',
  heater: 'תנור חימום / פטריה',
  fan_ac: 'מזגן',
  arrow: 'חץ כיוון',
  tree: 'עץ',
  planter: 'אדנית',
  green_wall: 'קיר ירוק',
  hedge: 'גדר חיה',
  flowers: 'פרחים',
  area: 'אזור',
};

/** A variant's name on its chip ('none': the kind's own sign). */
export const VARIANT_NAMES: Partial<Record<SketchKind, Partial<Record<SketchVariant | 'none', string>>>> = {
  counter: { straight: 'ישר', L: 'בצורת L', U: 'בצורת U' },
  restroom: { none: 'לכולם', men: 'גברים', women: 'נשים', accessible: 'נגיש' },
  exit: { plain: 'יציאה', none: 'יציאת חירום' },
  bar: { none: 'בר', cocktail: 'קוקטיילים', beer: 'בירה', wine: 'יין' },
  door: { none: 'כניסה', main: 'ראשית', side: 'צדדית', staff: 'עובדים' },
  plant: { none: 'רגיל', large: 'גדול', small: 'קטן' },
};

/** The variants offered as chips for a placed shape, in this order (null: the kind's own sign). */
export const VARIANT_CHOICES: Partial<Record<SketchKind, (SketchVariant | null)[]>> = {
  restroom: [null, 'men', 'women', 'accessible'],
  exit: ['plain', null],
  counter: ['straight', 'L', 'U'],
  bar: [null, 'cocktail', 'beer', 'wine'],
  door: [null, 'main', 'side', 'staff'],
  plant: ['small', null, 'large'],
};

/** A kind's name with its variant's ("שירותים — נשים", "כניסה ראשית", "יציאת חירום"). */
export function entryName(kind: SketchKind, variant: SketchVariant | null | undefined): string {
  if (kind === 'exit') return variant === 'plain' ? 'יציאה' : 'יציאת חירום';
  if (kind === 'counter') return SKETCH_NAMES.counter;
  const v = variant ? VARIANT_NAMES[kind]?.[variant] : null;
  if (!v) return SKETCH_NAMES[kind];
  if (kind === 'door') return defaultText({ kind, variant }) ?? SKETCH_NAMES.door;
  if (kind === 'bar') return defaultText({ kind, variant }) ?? SKETCH_NAMES.bar;
  return `${SKETCH_NAMES[kind]} — ${v}`;
}

/** Other words a symbol is searched by (English, and what people call it). */
const SEARCH_WORDS: Partial<Record<SketchKind, string[]>> = {
  restroom: ['wc', 'toilet', 'טואלט', 'נוחיות', 'גברים', 'נשים', 'נכים'],
  door: ['entrance', 'כניסה ראשית', 'דלת', 'עובדים'],
  exit: ['exit', 'חירום', 'יציאה'],
  counter: ['bar', 'בר', 'כיסאות', 'בר כיסאות'],
  bar: ['bar', 'בר', 'קוקטייל', 'בירה', 'יין', 'משקאות'],
  dj_booth: ['dj', 'די גיי', "דיג'יי", 'מוזיקה'],
  plant: ['plant', 'צמח', 'עציץ'],
  kitchen: ['kitchen', 'מטבח'],
  stairs: ['stairs', 'מדרגות'],
  cashier: ['cash', 'register', 'קופה', 'תשלום'],
  host: ['host', 'מארחת', 'מארח'],
  stage: ['stage', 'במה', 'הופעה'],
  service_station: ['waiter', 'מלצר', 'מגש', 'service'],
  coffee_station: ['coffee', 'קפה', 'אספרסו', 'ספל'],
  buffet: ['buffet', 'בופה', 'מזנון', 'אוכל'],
  dessert_station: ['dessert', 'cake', 'קינוח', 'עוגה', 'עוגות'],
  display_fridge: ['fridge', 'מקרר', 'ויטרינה', 'מקפיא'],
  elevator: ['lift', 'elevator', 'מעלית'],
  kids_corner: ['kids', 'ילדים', 'משחקים', 'צעצועים'],
  smoking: ['smoking', 'עישון', 'סיגריה', 'מעשנים'],
  no_smoking: ['no smoking', 'אסור לעשן', 'ללא עישון'],
  coat_check: ['coat', 'מלתחה', 'מעילים', 'קולב'],
  waiting_area: ['waiting', 'המתנה', 'תור'],
  tv: ['tv', 'screen', 'טלוויזיה', 'מסך'],
  speaker: ['speaker', 'רמקול', 'מוזיקה', 'סאונד'],
  pickup: ['pickup', 'takeaway', 'איסוף', 'טייק אוויי', 'משלוחים'],
  delivery_exit: ['delivery', 'שליחים', 'משלוחים', 'אופנוע'],
  trash: ['trash', 'bin', 'פח', 'אשפה', 'זבל'],
  sink: ['sink', 'כיור', 'ידיים', 'שטיפה'],
  first_aid: ['first aid', 'עזרה ראשונה', 'תרופות'],
  fire_extinguisher: ['fire', 'extinguisher', 'מטף', 'כיבוי אש'],
  parking: ['parking', 'חניה', 'חנייה', 'רכב'],
  outdoor: ['outdoor', 'בחוץ', 'שמש', 'חצר'],
  heater: ['heater', 'חימום', 'תנור', 'פטריה', 'פטרייה'],
  fan_ac: ['ac', 'מזגן', 'מיזוג', 'קירור'],
  arrow: ['arrow', 'חץ', 'כיוון'],
  tree: ['tree', 'עץ', 'עצים'],
  planter: ['planter', 'אדנית', 'עציצים'],
  green_wall: ['green wall', 'קיר ירוק', 'קיר צמחייה'],
  hedge: ['hedge', 'גדר חיה', 'שיחים', 'שיח'],
  flowers: ['flowers', 'פרחים', 'פרח'],
  area: ['area', 'zone', 'אזור', 'מרפסת', 'גינה', 'vip', 'חדר פרטי'],
  label: ['text', 'טקסט', 'כיתוב'],
  logo: ['logo', 'לוגו'],
  wall: ['wall', 'קיר'],
  window: ['window', 'חלון'],
  column: ['column', 'עמוד'],
  sofa: ['sofa', 'ספה'],
};

/**
 * Hebrew and Latin text as a search compares it: no case, no niqqud, no geresh or quotes ("ג'יי" is
 * "גיי"), a maqaf, a dash or a slash a space, one space between words.
 */
export function searchText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[־\-–—/()+]/g, ' ')
    .replace(/[֑-ֽֿ-ׇ]/g, '') // niqqud and cantillation
    .replace(/["'׳״`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The palette's search ("חיפוש סמל"): every entry of every tab and every variant of a kind, whose
 * name or other words hold the query — names that start with it first, then the palette's order.
 * An empty query finds nothing.
 */
export function searchPalette(query: string): PaletteEntry[] {
  const q = searchText(query);
  if (!q) return [];
  const all: PaletteEntry[] = [];
  const seen = new Set<string>();
  const add = (p: PaletteEntry) => {
    const key = `${p.kind}.${p.variant ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      all.push(p);
    }
  };
  for (const tab of PALETTE_TABS) {
    for (const p of PALETTE[tab]) {
      add(p);
      for (const v of VARIANT_CHOICES[p.kind] ?? []) if (v && p.kind !== 'counter' && p.kind !== 'exit') add({ kind: p.kind, variant: v });
    }
  }
  const scored = all
    .map((p, order) => {
      const name = searchText(entryName(p.kind, p.variant));
      const words = [name, ...(p.variant ? [] : (SEARCH_WORDS[p.kind] ?? []).map(searchText))];
      const rank = name.startsWith(q) || name.split(' ').some((w) => w.startsWith(q)) ? 0 : words.some((w) => w.includes(q)) ? 1 : -1;
      return { p, order, rank };
    })
    .filter((s) => s.rank >= 0);
  scored.sort((a, b) => a.rank - b.rank || a.order - b.order);
  return scored.map((s) => s.p);
}

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
  if (el.variant === 'U') {
    // The bar along the bottom and up both sides; the stools inside, along the bottom.
    const c = Math.min(el.w, el.h) * 0.28;
    const band = Math.min(c * 1.3, el.h - c);
    const length = Math.max(0, el.w - 2 * c);
    const d = n ? Math.min(band * 0.75, (length / n) * 0.8) : 0;
    return {
      bars: [
        { x: el.x, y: el.y + el.h - c, w: el.w, h: c },
        { x: el.x, y: el.y, w: c, h: el.h - c },
        { x: el.x + el.w - c, y: el.y, w: c, h: el.h - c },
      ],
      stools: Array.from({ length: n }, (_, i) => ({
        cx: el.x + c + (i + 0.5) * (length / n),
        cy: el.y + el.h - c - band / 2,
        r: d / 2,
      })),
    };
  }
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
  // The DJ booth: graphite, quiet on a light floor and on the dark one.
  dj_booth: { fill: '#d4d4d8', stroke: '#3f3f46', text: '#18181b' },
  // Schema 3, by family: service warm, guests indigo and sky, atmosphere neutral and violet,
  // safety red — every symbol on its own mid-tone fill, so it reads on light and dark floors.
  service_station: { fill: '#ffedd5', stroke: '#c2410c', text: '#7c2d12' },
  coffee_station: { fill: '#efe3d6', stroke: '#7c4a2d', text: '#3f2314' },
  buffet: { fill: '#fef3c7', stroke: '#b45309', text: '#78350f' },
  dessert_station: { fill: '#fce7f3', stroke: '#be185d', text: '#831843' },
  display_fridge: { fill: '#e0f2fe', stroke: '#0369a1', text: '#0c4a6e' },
  pickup: { fill: '#ffedd5', stroke: '#c2410c', text: '#7c2d12' },
  delivery_exit: { fill: '#fef9c3', stroke: '#a16207', text: '#713f12' },
  trash: { fill: '#e5e7eb', stroke: '#4b5563', text: '#1f2937' },
  sink: { fill: '#e0f2fe', stroke: '#0284c7', text: '#0c4a6e' },
  elevator: { fill: '#e0e7ff', stroke: '#4f46e5', text: '#312e81' },
  kids_corner: { fill: '#fef9c3', stroke: '#ca8a04', text: '#713f12' },
  coat_check: { fill: '#ede9fe', stroke: '#6d28d9', text: '#3b0764' },
  waiting_area: { fill: '#e0e7ff', stroke: '#4f46e5', text: '#312e81' },
  parking: { fill: '#dbeafe', stroke: '#1d4ed8', text: '#1e3a8a' },
  tv: { fill: '#e4e4e7', stroke: '#3f3f46', text: '#18181b' },
  speaker: { fill: '#e4e4e7', stroke: '#3f3f46', text: '#18181b' },
  outdoor: { fill: '#fef3c7', stroke: '#d97706', text: '#78350f' },
  heater: { fill: '#ffedd5', stroke: '#ea580c', text: '#7c2d12' },
  fan_ac: { fill: '#e0f2fe', stroke: '#0284c7', text: '#0c4a6e' },
  smoking: { fill: '#f5f5f4', stroke: '#57534e', text: '#292524' },
  no_smoking: { fill: '#fee2e2', stroke: '#dc2626', text: '#7f1d1d' },
  first_aid: { fill: '#fee2e2', stroke: '#dc2626', text: '#7f1d1d' },
  fire_extinguisher: { fill: '#fee2e2', stroke: '#b91c1c', text: '#7f1d1d' },
  // The arrow is its own shape: slate, its words in white on it.
  arrow: { fill: '#475569', stroke: '#334155', text: '#0f172a' },
  // Greenery: leaves in greens, a planter in terracotta, flowers pink.
  tree: { fill: '#2f9e44', stroke: '#1b5e20', round: true, text: '#14532d' },
  planter: { fill: '#c08457', stroke: '#8b5a2b', text: '#14532d' },
  green_wall: { fill: '#2f9e44', stroke: '#1b5e20', text: '#14532d' },
  hedge: { fill: '#2b8a3e', stroke: '#1b5e20', text: '#14532d' },
  flowers: { fill: '#ec4899', stroke: '#be185d', text: '#831843' },
  // An area takes its own fill (AREA_FILLS); its name is drawn darker.
  area: { fill: '#22c55e', stroke: '#15803d', text: '#14532d' },
};

/** A plain exit ("יציאה"): neutral slate — the green sign is the emergency exit's. */
const PLAIN_EXIT_STYLE = { fill: '#f1f5f9', stroke: '#475569', text: '#1e293b' };

/** `hex` ("#rrggbb") mixed with `toward` by `amount` (0: itself, 1: `toward`). */
export function mix(hex: string, toward: string, amount: number): string {
  const parse = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const a = parse(hex);
  const b = parse(toward);
  if (a.some(Number.isNaN) || b.some(Number.isNaN)) return hex;
  const t = Math.max(0, Math.min(1, amount));
  return `#${a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * An element's colours: its kind's, a plain exit's own (the till draws the same) — or, for a symbol
 * with a colour of its own, that colour for its lines, a pale tint of it for its fill and a dark one
 * for its word. A label's colour is its words' only; a drawn shape's is its stroke (drawn apart).
 */
export function styleOf(el: Pick<SketchElement, 'kind' | 'variant'> & { color?: string | null }): (typeof SKETCH_STYLE)[SketchKind] {
  const base = el.kind === 'exit' && el.variant === 'plain' ? PLAIN_EXIT_STYLE : SKETCH_STYLE[el.kind];
  const own = el.color && /^#[0-9a-fA-F]{6}$/.test(el.color) ? el.color.toLowerCase() : null;
  if (!own || el.kind === 'label' || el.kind === 'area' || isDrawn(el.kind)) return base;
  if (GREENERY_KINDS.includes(el.kind) || el.kind === 'arrow') {
    return { ...base, fill: own, stroke: mix(own, '#000000', 0.35), text: mix(own, '#000000', 0.55) };
  }
  return { ...base, fill: mix(own, '#ffffff', 0.84), stroke: own, text: mix(own, '#000000', 0.45) };
}

/** The word on a shape with no text of its own, by its variant too (the till's sketchDefaultText). */
export function defaultText(el: Pick<SketchElement, 'kind' | 'variant'>): string | null {
  if (el.kind === 'restroom') {
    if (el.variant === 'men') return 'גברים';
    if (el.variant === 'women') return 'נשים';
    if (el.variant === 'accessible') return 'נגיש';
  }
  if (el.kind === 'exit' && el.variant === 'plain') return 'יציאה';
  if (el.kind === 'bar') {
    if (el.variant === 'cocktail') return 'בר קוקטיילים';
    if (el.variant === 'beer') return 'בר בירה';
    if (el.variant === 'wine') return 'בר יין';
  }
  if (el.kind === 'door') {
    if (el.variant === 'main') return 'כניסה ראשית';
    if (el.variant === 'side') return 'כניסה צדדית';
    if (el.variant === 'staff') return 'כניסת עובדים';
  }
  return SKETCH_DEFAULT_TEXT[el.kind] ?? null;
}

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
  dj_booth: "עמדת די־ג'יי",
  // Schema 3: the short word under the symbol (the legend has the full name, SKETCH_NAMES).
  // The arrow, the greenery and an area have none: their own text only.
  service_station: 'מלצרים',
  coffee_station: 'קפה',
  buffet: 'בופה',
  dessert_station: 'קינוחים',
  display_fridge: 'ויטרינה',
  elevator: 'מעלית',
  kids_corner: 'ילדים',
  smoking: 'עישון',
  no_smoking: 'ללא עישון',
  coat_check: 'מלתחה',
  waiting_area: 'המתנה',
  tv: 'מסך',
  speaker: 'רמקול',
  pickup: 'איסוף',
  delivery_exit: 'שליחים',
  trash: 'פח',
  sink: 'כיור',
  first_aid: 'עזרה ראשונה',
  fire_extinguisher: 'מטף',
  parking: 'חניה',
  outdoor: 'בחוץ',
  heater: 'חימום',
  fan_ac: 'מזגן',
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

/**
 * A new shape of `kind` (and `variant`) in the middle of the canvas, sized to it. An exit with no
 * variant asked for is the plain one ("יציאה"); `null` asks for the emergency exit.
 */
export function newElement(kind: SketchKind, cw: number, ch: number, variant?: SketchVariant | null): SketchElement {
  const s = Math.min(cw, ch);
  const symbol: [number, number] = [s * 0.13, s * 0.1];
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
    dj_booth: [s * 0.16, s * 0.1],
    service_station: symbol,
    coffee_station: symbol,
    buffet: [s * 0.2, s * 0.1],
    dessert_station: symbol,
    display_fridge: [s * 0.09, s * 0.14],
    elevator: [s * 0.12, s * 0.12],
    kids_corner: [s * 0.16, s * 0.13],
    smoking: symbol,
    no_smoking: symbol,
    coat_check: symbol,
    waiting_area: [s * 0.16, s * 0.11],
    tv: [s * 0.16, s * 0.05],
    speaker: [s * 0.07, s * 0.07],
    pickup: symbol,
    delivery_exit: [s * 0.16, s * 0.06],
    trash: [s * 0.07, s * 0.07],
    sink: [s * 0.1, s * 0.08],
    first_aid: [s * 0.08, s * 0.08],
    fire_extinguisher: [s * 0.06, s * 0.09],
    parking: [s * 0.12, s * 0.12],
    outdoor: symbol,
    heater: [s * 0.08, s * 0.08],
    fan_ac: [s * 0.14, s * 0.06],
    arrow: [s * 0.16, s * 0.06],
    tree: [s * 0.16, s * 0.16],
    planter: [s * 0.4, s * 0.05],
    green_wall: [s * 0.45, s * 0.035],
    hedge: [s * 0.4, s * 0.05],
    flowers: [s * 0.08, s * 0.08],
    area: [s * 0.4, s * 0.3],
  };
  let [w, h] = size[kind];
  const kept = variantOf(kind, variant === undefined && kind === 'exit' ? 'plain' : variant);
  // A plant's size is its variant's: larger or smaller than the usual pot.
  if (kind === 'plant' && kept === 'large') [w, h] = [s * 0.1, s * 0.1];
  if (kind === 'plant' && kept === 'small') [w, h] = [s * 0.04, s * 0.04];
  return {
    id: newElementId(),
    kind,
    x: Math.round(cw / 2 - w / 2),
    y: Math.round(ch / 2 - h / 2),
    w: Math.round(w),
    h: Math.round(h),
    rotation: 0,
    text: kind === 'label' ? SKETCH_DEFAULT_TEXT.label : null,
    ...(kind === 'counter' ? { stools: 6 } : {}),
    ...(kept ? { variant: kept } : {}),
    ...(kind === 'area' ? { text: 'אזור', fill: AREA_FILL_DEFAULT, opacity: AREA_OPACITY.default } : {}),
  };
}

// ── Templates ────────────────────────────────────────────────────────────────

export type SketchTemplate = 'smallRestaurant' | 'cafeBar' | 'eventHall' | 'terrace' | 'counter';
export const SKETCH_TEMPLATES: SketchTemplate[] = ['smallRestaurant', 'cafeBar', 'eventHall', 'terrace', 'counter'];

type TemplateBox = [SketchKind, number, number, number, number, string?, { variant?: 'straight' | 'L'; stools?: number }?];

/** Walls around the canvas with a gap for the entrance on the bottom wall at [gapFrom, gapTo] (fractions). */
function frame(gapFrom: number, gapTo: number, t: number): TemplateBox[] {
  return [
    ['wall', 0, 0, 1, t],
    ['wall', 0, 0, t, 1],
    ['wall', 1 - t, 0, t, 1],
    ['wall', 0, 1 - t, gapFrom, t],
    ['wall', gapTo, 1 - t, 1 - gapTo, t],
    ['door', gapFrom, 1 - t * 2.4, gapTo - gapFrom, t * 2.4],
  ];
}

const TEMPLATE_BOXES: Record<SketchTemplate, TemplateBox[]> = {
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

// ── From squares to a map ("עבור לתצוגת מפה") ────────────────────────────────

/** A table as it is placed on a map: where, how large, turned how far. */
export interface TablePlacement {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
}

/** What placing tables needs to know of each. */
export interface PlaceableTable extends TablePlacement {
  number: number;
  /** "3B" (P:/specs/table-scope.md §6.2): placed in the natural order, as the grid shows it. */
  label?: string | null;
}

/**
 * Do these tables have no usable place on a `cw` × `ch` map? Every table the cloud makes gets a
 * place (rows across the canvas — the server's `_next_slot`), so a zone of squares usually opens
 * as a tidy map; but a table off the canvas (the canvas made smaller) or two on the very same spot
 * (tables a till opened by number, never placed) mean no map was ever laid out.
 */
export function tablesNeedPlacing(tables: PlaceableTable[], cw: number, ch: number): boolean {
  const off = (t: PlaceableTable) => t.x < -0.5 || t.y < -0.5 || t.x + t.width > cw + 0.5 || t.y + t.height > ch + 0.5;
  if (tables.some(off)) return true;
  for (let i = 0; i < tables.length; i++) {
    for (let j = i + 1; j < tables.length; j++) {
      if (Math.abs(tables[i].x - tables[j].x) < 1 && Math.abs(tables[i].y - tables[j].y) < 1) return true;
    }
  }
  return false;
}

/**
 * The tables in a tidy grid on a `cw` × `ch` canvas, in the natural order of their labels and numbers
 * (row by row, as the grid of squares shows them — 3, 3A, 3B, 10): each its own size, room for its chairs
 * between them, the grid centred; squeezed together when there are more than fit, never off the canvas.
 */
export function arrangeTables(tables: PlaceableTable[], cw: number, ch: number): TablePlacement[] {
  const list = sortTables(tables);
  const n = list.length;
  if (!n) return [];
  const cellW = Math.max(...list.map((t) => t.width));
  const cellH = Math.max(...list.map((t) => t.height));
  // Chairs on both sides of a gap, and a little air.
  const gap = Math.max(20, Math.round(Math.min(cellW, cellH) * 2 * CHAIR_REACH + 10));
  // k cells and the k − 1 gaps between them fit when k·cell + (k − 1)·gap ≤ the side.
  const fitAcross = Math.max(1, Math.floor((cw + gap) / (cellW + gap)));
  const fitDown = Math.max(1, Math.floor((ch + gap) / (cellH + gap)));
  // As square as the canvas is: columns by its proportions, at least enough rows' worth to fit.
  let cols = Math.max(1, Math.min(n, Math.ceil(Math.sqrt((n * cw * (cellH + gap)) / (ch * (cellW + gap))))));
  cols = Math.min(Math.max(cols, Math.ceil(n / fitDown)), Math.max(fitAcross, 1), n);
  const rows = Math.ceil(n / cols);
  const stepX = cols > 1 ? Math.min(cellW + gap, (cw - cellW) / (cols - 1)) : 0;
  const stepY = rows > 1 ? Math.min(cellH + gap, (ch - cellH) / (rows - 1)) : 0;
  const x0 = Math.max(0, (cw - (cellW + stepX * (cols - 1))) / 2);
  const y0 = Math.max(0, (ch - (cellH + stepY * (rows - 1))) / 2);
  return list.map((t, i) => {
    const r = Math.floor(i / cols);
    const c = i % cols;
    const x = x0 + c * stepX + (cellW - t.width) / 2;
    const y = y0 + r * stepY + (cellH - t.height) / 2;
    return {
      id: t.id,
      x: Math.round(Math.max(0, Math.min(cw - t.width, x))),
      y: Math.round(Math.max(0, Math.min(ch - t.height, y))),
      width: t.width,
      height: t.height,
      rotation: t.rotation,
    };
  });
}

/**
 * "עבור לתצוגת מפה": the places to save before a zone of squares opens as a map — none when its
 * tables already have usable ones (as the cloud gave them), else all of them in a tidy grid.
 */
export function planSwitchToMap(tables: PlaceableTable[], cw: number, ch: number): TablePlacement[] {
  return tablesNeedPlacing(tables, cw, ch) ? arrangeTables(tables, cw, ch) : [];
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
  if (isPolygonArea(el)) {
    const pts = pairs(el.points);
    if (pointInPolygon(p, pts)) return true;
    for (let i = 0; i < pts.length; i++) if (segmentDistance(p, pts[i], pts[(i + 1) % pts.length]) <= tolerance) return true;
    return false;
  }
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

/** Moved by (dx, dy): its box, and its points when it has them (a drawn line, an area's polygon). */
export function translated(el: SketchElement, dx: number, dy: number): SketchElement {
  if ((hasPoints(el.kind) || isPolygonArea(el)) && el.points) {
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

// ── Areas ("אזור", v3 §2) ─────────────────────────────────────────────────────

/** The areas' fills: green, teal, blue, violet, pink, red, amber, slate (the server stores any #rrggbb). */
export const AREA_FILLS = ['#22c55e', '#14b8a6', '#3b82f6', '#8b5cf6', '#ec4899', '#ef4444', '#f59e0b', '#64748b'] as const;
export const AREA_FILL_NAMES: Record<(typeof AREA_FILLS)[number], string> = {
  '#22c55e': 'ירוק',
  '#14b8a6': 'טורקיז',
  '#3b82f6': 'כחול',
  '#8b5cf6': 'סגול',
  '#ec4899': 'ורוד',
  '#ef4444': 'אדום',
  '#f59e0b': 'כתום',
  '#64748b': 'אפור',
};
/** What the server stores for an area sent without them (app/schemas/tables.py). */
export const AREA_FILL_DEFAULT = '#22c55e';
export const AREA_OPACITY = { min: 10, max: 60, default: 30 } as const;

/** An area's opacity, kept to 10–60 percent, whole. */
export function clampOpacity(v: number): number {
  if (!Number.isFinite(v)) return AREA_OPACITY.default;
  return Math.max(AREA_OPACITY.min, Math.min(AREA_OPACITY.max, Math.round(v)));
}

/** An area drawn as a polygon (its corners in `points`), not its rectangle. */
export function isPolygonArea(el: Pick<SketchElement, 'kind' | 'points'>): boolean {
  return el.kind === 'area' && !!el.points && el.points.length >= 6;
}

/** An area's corners: its polygon's, or its rectangle's (from the top-left, clockwise). */
export function areaCorners(el: SketchElement): Pt[] {
  if (isPolygonArea(el)) return pairs(el.points);
  return [
    { x: el.x, y: el.y },
    { x: el.x + el.w, y: el.y },
    { x: el.x + el.w, y: el.y + el.h },
    { x: el.x, y: el.y + el.h },
  ];
}

/**
 * An area of the corners clicked: a polygon (three corners at least — a corner clicked twice, or
 * the first clicked again to close it, counts once), its box round them. Null for fewer.
 */
export function areaFromCorners(corners: Pt[], fill: string = AREA_FILL_DEFAULT, text = 'אזור'): SketchElement | null {
  const pts: Pt[] = [];
  for (const p of corners) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) >= 0.5) pts.push(p);
  }
  if (pts.length > 1 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 0.5) pts.pop();
  if (pts.length < 3) return null;
  const base: SketchElement = {
    id: newElementId(), kind: 'area', x: 0, y: 0, w: 0, h: 0, rotation: 0, text, fill, opacity: AREA_OPACITY.default,
  };
  return withPoints(base, pts);
}

/** Where an area's name goes: its polygon's centroid (its box's centre when it has no area). */
export function polygonCentroid(pts: Pt[]): Pt {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const q = pts[(i + 1) % pts.length];
    const cross = p.x * q.y - q.x * p.y;
    a += cross;
    cx += (p.x + q.x) * cross;
    cy += (p.y + q.y) * cross;
  }
  if (Math.abs(a) < 1e-9) {
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

/** Is `p` inside the polygon `pts` (even–odd)? */
export function pointInPolygon(p: Pt, pts: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Resized to w × h from its top-left corner: an area's polygon, or a drawn shape's points, scaled with it. */
export function resized(el: SketchElement, w: number, h: number): SketchElement {
  const W = Math.max(2, w);
  const H = Math.max(2, h);
  if ((isPolygonArea(el) || hasPoints(el.kind)) && el.points) {
    const sx = el.w > 0 ? W / el.w : 1;
    const sy = el.h > 0 ? H / el.h : 1;
    return withPoints(el, pairs(el.points).map((p) => ({ x: el.x + (p.x - el.x) * sx, y: el.y + (p.y - el.y) * sy })));
  }
  return { ...el, w: W, h: H };
}

/** The order shapes are drawn in: the areas first, under everything (v3 §2); the rest as placed. */
export function drawOrder(elements: SketchElement[]): SketchElement[] {
  return [...elements.filter((el) => el.kind === 'area'), ...elements.filter((el) => el.kind !== 'area')];
}

// ── Placing: snapping to the walls, duplicating in a row (v3 §4) ─────────────

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A shape's box as drawn: turned with it (a quarter turn swaps its sides) — DecorFit.kt `turnedBox`. */
export function turnedBox(el: Pick<SketchElement, 'x' | 'y' | 'w' | 'h' | 'rotation'>): Box {
  if (!el.rotation) return { x: el.x, y: el.y, w: el.w, h: el.h };
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  const a = (el.rotation * Math.PI) / 180;
  const c = Math.abs(Math.cos(a));
  const s = Math.abs(Math.sin(a));
  const hw = (el.w * c + el.h * s) / 2;
  const hh = (el.w * s + el.h * c) / 2;
  // To a thousandth: a quarter turn's cosine is 6e-17, not 0.
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  return { x: r3(cx - hw), y: r3(cy - hh), w: r3(hw * 2), h: r3(hh * 2) };
}

/** The kinds a shape is pushed flush against: the walls, the windows in them, a green wall. */
export const WALL_KINDS: SketchKind[] = ['wall', 'window', 'green_wall'];

/** What a shape snaps to: every wall, window and green wall as drawn, and a drawn wall's straight segments. */
export function wallBoxes(elements: SketchElement[], exceptId?: string): Box[] {
  const out: Box[] = [];
  for (const el of elements) {
    if (el.id === exceptId) continue;
    if (WALL_KINDS.includes(el.kind)) out.push(turnedBox(el));
    else if (el.kind === 'polyline' || el.kind === 'line') {
      const pts = pairs(el.points);
      const t = Math.max(1, el.stroke ?? 3);
      for (let i = 0; i + 1 < pts.length; i++) {
        const [a, b] = [pts[i], pts[i + 1]];
        if (Math.abs(a.y - b.y) < 0.5) out.push({ x: Math.min(a.x, b.x), y: a.y - t / 2, w: Math.abs(b.x - a.x), h: t });
        else if (Math.abs(a.x - b.x) < 0.5) out.push({ x: a.x - t / 2, y: Math.min(a.y, b.y), w: t, h: Math.abs(b.y - a.y) });
      }
    }
  }
  return out;
}

/**
 * "הצמדה לקירות": the move (dx, dy) that lays a side of `box` within `tolerance` of a wall's face
 * flush against it — a wall beside it (overlapping it along the other axis), on whichever side;
 * the nearest on each axis. (0, 0) when no wall is that near.
 */
export function snapToWalls(box: Box, walls: Box[], tolerance: number): { dx: number; dy: number } {
  let dx = 0;
  let dy = 0;
  let bestX = tolerance + 1e-9;
  let bestY = tolerance + 1e-9;
  for (const wb of walls) {
    const alongY = box.y < wb.y + wb.h && box.y + box.h > wb.y;
    const alongX = box.x < wb.x + wb.w && box.x + box.w > wb.x;
    if (alongY) {
      for (const d of [wb.x + wb.w - box.x, wb.x - (box.x + box.w)]) {
        if (Math.abs(d) < bestX) {
          bestX = Math.abs(d);
          dx = d;
        }
      }
    }
    if (alongX) {
      for (const d of [wb.y + wb.h - box.y, wb.y - (box.y + box.h)]) {
        if (Math.abs(d) < bestY) {
          bestY = Math.abs(d);
          dy = d;
        }
      }
    }
  }
  return { dx, dy };
}

export type DuplicateDirection = 'left' | 'right' | 'up' | 'down';
export const DUPLICATE_DIRECTIONS: DuplicateDirection[] = ['left', 'right', 'down', 'up'];
export const DUPLICATE_MAX = 30;

/**
 * "שכפול מרובה": `count` copies of `el` in a row (or a column), each `gap` units after the one before
 * as drawn (a turned shape by its turned box) — as many as stay on the `cw` × `ch` canvas.
 */
export function duplicateMany(
  el: SketchElement,
  count: number,
  direction: DuplicateDirection,
  gap: number,
  cw: number,
  ch: number,
): SketchElement[] {
  const n = Math.max(0, Math.min(DUPLICATE_MAX, Math.floor(count)));
  const b = turnedBox(el);
  const g = Math.max(0, gap);
  const [ux, uy] = { right: [1, 0], left: [-1, 0], down: [0, 1], up: [0, -1] }[direction];
  const step = ux ? b.w + g : b.h + g;
  const out: SketchElement[] = [];
  for (let i = 1; i <= n; i++) {
    const dx = Math.round(ux * step * i * 10) / 10;
    const dy = Math.round(uy * step * i * 10) / 10;
    if (b.x + dx < -0.5 || b.y + dy < -0.5 || b.x + dx + b.w > cw + 0.5 || b.y + dy + b.h > ch + 0.5) break;
    out.push({ ...translated(el, dx, dy), id: newElementId() });
  }
  return out;
}

// ── On the till: what is drawn, the legend, the fit (v3 §3; the till's DecorFit.kt) ──

export type MapDecorMode = 'full' | 'symbols' | 'off';
export type MapLegendMode = 'off' | 'button' | 'always';
export type MapLabelsMode = 'auto' | 'always' | 'never';
/** The till parameters' defaults (pos-server app/services/table_map_display.py). */
export const MAP_DISPLAY_DEFAULTS = {
  mapDecor: 'full' as MapDecorMode,
  mapLegend: 'button' as MapLegendMode,
  mapSymbolLabels: 'auto' as MapLabelsMode,
  mapSymbolScale: 100,
};
export const MAP_SYMBOL_SCALE = { min: 70, max: 150 } as const;

/**
 * What `mapDecor=symbols` leaves out: the room's frame and ornament — the walls, windows, columns,
 * a sofa, the logo and free drawings (the server's table_map_display.STRUCTURE_KINDS).
 */
export const STRUCTURE_KINDS: SketchKind[] = ['wall', 'window', 'column', 'sofa', 'logo', 'line', 'polyline', 'freehand', 'rect'];

/** The shapes the till draws for `decor`: all of them, the symbols only, or none. */
export function visibleElements(elements: SketchElement[], decor: MapDecorMode): SketchElement[] {
  if (decor === 'off') return [];
  if (decor === 'symbols') return elements.filter((el) => !STRUCTURE_KINDS.includes(el.kind));
  return elements;
}

/** One line of the legend ("מקרא"): a kind (with its variant) or an area, and its Hebrew name. */
export interface LegendEntry {
  key: string;
  kind: SketchKind;
  variant: SketchVariant | null;
  name: string;
  /** An area's fill; a symbol's own colour, when it has one. */
  color?: string | null;
}

/**
 * The legend: only what the zone's plan has (v3 §3) — every symbol kind once by its variant, every
 * named area once — in the palette's order. Not the room's frame, the free texts or the drawings.
 */
export function legendEntries(elements: SketchElement[]): LegendEntry[] {
  const order = new Map<SketchKind, number>();
  PALETTE_TABS.flatMap((tab) => PALETTE[tab]).forEach((p, i) => {
    if (!order.has(p.kind)) order.set(p.kind, i);
  });
  const rank = (entry: LegendEntry) => order.get(entry.kind) ?? Number.MAX_SAFE_INTEGER;
  // A kind's variants in their chips' order (an entrance, then the main one, the side one…).
  const chip = (entry: LegendEntry) => (VARIANT_CHOICES[entry.kind] ?? []).indexOf(entry.variant);
  const out = new Map<string, LegendEntry>();
  for (const el of elements) {
    if (STRUCTURE_KINDS.includes(el.kind) || el.kind === 'label') continue;
    if (el.kind === 'area') {
      const name = (el.text ?? '').trim();
      const key = `area:${name}`;
      if (name && !out.has(key)) out.set(key, { key, kind: 'area', variant: null, name, color: el.fill ?? AREA_FILL_DEFAULT });
      continue;
    }
    const variant = el.kind === 'counter' ? null : variantOf(el.kind, el.variant ?? null);
    const key = `${el.kind}.${variant ?? ''}`;
    if (!out.has(key)) out.set(key, { key, kind: el.kind, variant, name: entryName(el.kind, variant), color: el.color ?? null });
  }
  return [...out.values()].sort((a, b) => rank(a) - rank(b) || chip(a) - chip(b) || a.name.localeCompare(b.name, 'he'));
}

/** The kinds kept in view when the map opens fitted: everything but the frame and the areas. */
export function isLandmark(kind: SketchKind): boolean {
  return !STRUCTURE_KINDS.includes(kind) && kind !== 'area';
}

/** The landmarks' box on a `cw` × `ch` canvas with a little room round it (2% of the shorter side); null when none. */
export function decorExtent(elements: SketchElement[], cw: number, ch: number): Box | null {
  const boxes = elements.filter((el) => isLandmark(el.kind)).map(turnedBox);
  if (!boxes.length) return null;
  const pad = Math.min(cw, ch) * 0.02;
  const left = Math.max(0, Math.min(cw, Math.min(...boxes.map((b) => b.x)) - pad));
  const top = Math.max(0, Math.min(ch, Math.min(...boxes.map((b) => b.y)) - pad));
  const right = Math.max(0, Math.min(cw, Math.max(...boxes.map((b) => b.x + b.w)) + pad));
  const bottom = Math.max(0, Math.min(ch, Math.max(...boxes.map((b) => b.y + b.h)) + pad));
  return right > left && bottom > top ? { x: left, y: top, w: right - left, h: bottom - top } : null;
}

/** Where the canvas lands on a screen: (x, y) at (ox + x·sx, oy + y·sy); a table w wide is tableScale·w. */
export interface MapView {
  sx: number;
  sy: number;
  ox: number;
  oy: number;
  tableScale: number;
}

export interface TableBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A table as drawn, its chairs round it (the till's ChairLayout.footprint). */
export function tableFootprint(width: number, height: number): number {
  return Math.max(width, height) + 2 * CHAIR_REACH * Math.min(width, height);
}

/**
 * The till's fitted view (pos-android domain/Tables.kt `fitMapView`): the tables and the landmarks
 * fill the screen between its top bar and its bottom island, each axis on its own but never
 * stretched more than `maxStretch` times one way than the other, at least 40% of the canvas in view;
 * a zone with no tables shows its whole canvas. Tables are sized from the screen and never so large
 * that two apart in the dashboard touch.
 */
export function fitMapView(
  tables: TableBox[],
  cw: number,
  ch: number,
  screenW: number,
  screenH: number,
  insetTop = 0,
  insetBottom = 0,
  extent: Box | null = null,
  maxStretch = 2.5,
): MapView {
  const W = Math.max(1, cw);
  const H = Math.max(1, ch);
  const usableW = Math.max(1, screenW);
  const usableH = Math.max(1, screenH - insetTop - insetBottom);
  let left = 0;
  let top = 0;
  let right = W;
  let bottom = H;
  if (tables.length) {
    left = Math.min(...tables.map((t) => t.x));
    top = Math.min(...tables.map((t) => t.y));
    right = Math.max(...tables.map((t) => t.x + t.width));
    bottom = Math.max(...tables.map((t) => t.y + t.height));
    const pad = Math.max(...tables.map((t) => tableFootprint(t.width, t.height))) * 0.5;
    left -= pad;
    top -= pad;
    right += pad;
    bottom += pad;
    if (extent) {
      left = Math.min(left, extent.x);
      top = Math.min(top, extent.y);
      right = Math.max(right, extent.x + extent.w);
      bottom = Math.max(bottom, extent.y + extent.h);
    }
    if (right - left < W * 0.4) {
      const c = (left + right) / 2;
      left = c - W * 0.2;
      right = c + W * 0.2;
    }
    if (bottom - top < H * 0.4) {
      const c = (top + bottom) / 2;
      top = c - H * 0.2;
      bottom = c + H * 0.2;
    }
  }
  const rw = right - left;
  const rh = bottom - top;
  let sx = usableW / rw;
  let sy = usableH / rh;
  if (sy > sx * maxStretch) sy = sx * maxStretch;
  if (sx > sy * maxStretch) sx = sy * maxStretch;
  const ox = (usableW - rw * sx) / 2 - left * sx;
  const oy = insetTop + (usableH - rh * sy) / 2 - top * sy;
  let scale = (Math.min(usableW, usableH) / Math.min(W, H)) * 1.25;
  for (let i = 0; i < tables.length; i++) {
    for (let j = i + 1; j < tables.length; j++) {
      const a = tables[i];
      const b = tables[j];
      const dx = a.x + a.width / 2 - (b.x + b.width / 2);
      const dy = a.y + a.height / 2 - (b.y + b.height / 2);
      const reach = (tableFootprint(a.width, a.height) + tableFootprint(b.width, b.height)) / 2;
      if (reach <= 0 || Math.hypot(dx, dy) <= reach + 0.5) continue;
      const k = (Math.hypot(dx * sx, dy * sy) / reach) * 0.95;
      if (k < scale) scale = k;
    }
  }
  const biggest = tables.length ? Math.max(...tables.map((t) => tableFootprint(t.width, t.height))) : 80;
  scale = Math.min(scale, (Math.min(usableW, usableH) * 0.34) / biggest);
  return { sx, sy, ox, oy, tableScale: Math.max(0.05, scale) };
}

/** A rotation that turns a shape more than an eighth: its sides take the other axis's stretch. */
export function quarterTurned(rotation: number): boolean {
  const r = (((Math.round(rotation) % 180) + 180) % 180);
  return r >= 45 && r <= 134;
}

/**
 * A shape as the till draws it on `view` (DecorFit.kt `sketchBoxOn`), in the screen's units: its
 * centre where the canvas puts it, its sides each axis's stretch (swapped when it is turned a
 * quarter); the points of a drawn line or a polygon area where the canvas puts them.
 */
export function onView(el: SketchElement, view: MapView): SketchElement {
  const { sx, sy, ox, oy } = view;
  if ((hasPoints(el.kind) || isPolygonArea(el)) && el.points) {
    const moved = withPoints(el, pairs(el.points).map((p) => ({ x: ox + p.x * sx, y: oy + p.y * sy })));
    return { ...moved, stroke: el.stroke != null ? el.stroke * Math.min(sx, sy) : el.stroke };
  }
  const q = quarterTurned(el.rotation);
  const w = el.w * (q ? sy : sx);
  const h = el.h * (q ? sx : sy);
  const cx = ox + (el.x + el.w / 2) * sx;
  const cy = oy + (el.y + el.h / 2) * sy;
  const fs = el.kind === 'label' ? labelFontSize(el) : null;
  return {
    ...el,
    x: cx - w / 2,
    y: cy - h / 2,
    w,
    h,
    stroke: el.stroke != null ? el.stroke * Math.min(sx, sy) : el.stroke,
    // A text's own size grows and shrinks with the map, like its box (§8).
    ...(fs != null ? { fontSize: fs * Math.min(sx, sy) } : {}),
  };
}

/** The screens the dashboard previews the till's map on, in dp, with the till's bars on them. */
export interface PreviewDevice {
  key: 'tabletLandscape' | 'tabletPortrait' | 'handheld';
  name: string;
  width: number;
  height: number;
  insetTop: number;
  insetBottom: number;
}
export const PREVIEW_DEVICES: PreviewDevice[] = [
  { key: 'tabletLandscape', name: 'טאבלט לרוחב', width: 1280, height: 800, insetTop: 64, insetBottom: 88 },
  { key: 'tabletPortrait', name: 'טאבלט לאורך', width: 800, height: 1280, insetTop: 64, insetBottom: 88 },
  { key: 'handheld', name: 'מסופון', width: 360, height: 640, insetTop: 56, insetBottom: 72 },
];
/** Below this shorter side (dp) a screen is a handheld or a phone: no words, symbols at least DECOR_MIN_ICON_DP. */
export const DECOR_COMPACT_BELOW_DP = 600;
export const DECOR_MIN_ICON_DP = 18;
export function isCompactScreen(width: number, height: number): boolean {
  return Math.min(width, height) < DECOR_COMPACT_BELOW_DP;
}

// ── "טקסט ולוגו" (schema 4, P:/specs/table-map-decor-v3.md §8) ────────────────

export type LabelSizeName = 's' | 'm' | 'l' | 'xl';
/** A text's size: a name, or a whole number of canvas units (10–72). */
export type LabelFontSize = LabelSizeName | number;
export type LabelAlign = 'left' | 'center' | 'right';
export type LogoSource = 'business' | 'image';

/** The named sizes, in canvas units (the server's SKETCH_FONT_SIZES). */
export const LABEL_SIZES: Record<LabelSizeName, number> = { s: 14, m: 20, l: 28, xl: 40 };
export const LABEL_SIZE_NAMES: LabelSizeName[] = ['s', 'm', 'l', 'xl'];
export const LABEL_SIZE_LABELS: Record<LabelSizeName, string> = { s: 'קטן', m: 'בינוני', l: 'גדול', xl: 'גדול מאוד' };
export const LABEL_FONT_RANGE = { min: 10, max: 72 } as const;
export const LABEL_ALIGNS: LabelAlign[] = ['right', 'center', 'left'];
/** A text's words: up to 200 characters on several lines; any other shape's: 60 on one. */
export const LABEL_TEXT_MAX = 200;
export const SKETCH_TEXT_MAX = 60;
export const LABEL_BG_OPACITY = { min: 10, max: 100, default: 100 } as const;
export const LOGO_OPACITY = { min: 20, max: 100, default: 100 } as const;
/** A text's line height, as a multiple of its size. */
export const LABEL_LINE_HEIGHT = 1.25;

const clampInt = (v: number, min: number, max: number) => Math.max(min, Math.min(max, Math.round(v)));

/** How many characters `kind`'s words may have. */
export function textMax(kind: SketchKind): number {
  return kind === 'label' ? LABEL_TEXT_MAX : SKETCH_TEXT_MAX;
}

/** Words as typed, as the server keeps them: one kind of line break, a text's several lines, at most its length. */
export function cleanText(kind: SketchKind, text: string): string | null {
  let out = text.replace(/\r\n?/g, '\n');
  if (kind !== 'label') out = out.replace(/\n/g, ' ');
  out = out.slice(0, textMax(kind));
  return out.trim() ? out : null;
}

/** A text's lines (none: no line). */
export function labelLines(text: string | null | undefined): string[] {
  if (!text) return [];
  return text.replace(/\r\n?/g, '\n').split('\n');
}

/** A typed or chosen size as stored: a name stays; a number is rounded into 10–72; nothing: fitted. */
export function cleanFontSize(value: string | number | null | undefined): LabelFontSize | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string') {
    if ((LABEL_SIZE_NAMES as string[]).includes(value)) return value as LabelSizeName;
    const n = Number(value.trim());
    return Number.isFinite(n) ? clampInt(n, LABEL_FONT_RANGE.min, LABEL_FONT_RANGE.max) : null;
  }
  return Number.isFinite(value) ? clampInt(value, LABEL_FONT_RANGE.min, LABEL_FONT_RANGE.max) : null;
}

/** A text's own size in its units (a name's, its number), or null — fitted to its box. */
export function labelFontSize(el: Pick<SketchElement, 'fontSize'>): number | null {
  const v = el.fontSize;
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return LABEL_SIZES[v as LabelSizeName] ?? null;
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** The size that fits `lines` in a w × h box (the size a text without one of its own is drawn at). */
export function fittedFontSize(lines: string[], w: number, h: number): number {
  const rows = Math.max(1, lines.length);
  const longest = Math.max(2, ...lines.map((l) => l.length));
  return Math.max(0, Math.min(Math.min(w, h) * 0.55, h / (rows * LABEL_LINE_HEIGHT), (w * 1.6) / longest));
}

export interface LabelLayout {
  fontSize: number;
  anchor: 'start' | 'middle' | 'end';
  x: number;
  /** Each line and the y of its middle. */
  lines: { text: string; y: number }[];
}

/**
 * Where a text's lines go in its box (a left-to-right picture: "left" anchors at the box's left
 * edge, "right" at its right one, a little in from it): its own size, else fitted; at least `minSize`.
 */
export function labelLayout(
  el: Pick<SketchElement, 'x' | 'y' | 'w' | 'h' | 'text' | 'fontSize' | 'align'>,
  text: string | null = el.text ?? null,
  minSize = 0,
): LabelLayout {
  const lines = labelLines(text);
  const own = labelFontSize(el);
  const fontSize = Math.max(minSize, own ?? fittedFontSize(lines, el.w, el.h));
  const pad = Math.min(el.w * 0.06, fontSize * 0.5);
  const align = el.align ?? 'center';
  const anchor = align === 'left' ? 'start' : align === 'right' ? 'end' : 'middle';
  const x = align === 'left' ? el.x + pad : align === 'right' ? el.x + el.w - pad : el.x + el.w / 2;
  const step = fontSize * LABEL_LINE_HEIGHT;
  const top = el.y + el.h / 2 - (step * (lines.length - 1)) / 2;
  return { fontSize, anchor, x, lines: lines.map((t, i) => ({ text: t, y: top + i * step })) };
}

export function clampBgOpacity(v: number): number {
  return clampInt(Number.isFinite(v) ? v : LABEL_BG_OPACITY.default, LABEL_BG_OPACITY.min, LABEL_BG_OPACITY.max);
}

export function clampLogoOpacity(v: number): number {
  return clampInt(Number.isFinite(v) ? v : LOGO_OPACITY.default, LOGO_OPACITY.min, LOGO_OPACITY.max);
}

/** A text's chip as drawn: its colour and opacity (0–1), or null — none. */
export function labelChip(el: Pick<SketchElement, 'bg' | 'bgOpacity'>): { fill: string; opacity: number } | null {
  if (!el.bg || !/^#[0-9a-fA-F]{6}$/.test(el.bg)) return null;
  return { fill: el.bg.toLowerCase(), opacity: clampBgOpacity(el.bgOpacity ?? LABEL_BG_OPACITY.default) / 100 };
}

/** Where a logo's picture comes from: as chosen, else its own picture when it has one, else the business's. */
export function logoSourceOf(el: Pick<SketchElement, 'source' | 'src'>): LogoSource {
  if (el.source === 'business' || el.source === 'image') return el.source;
  return el.src ? 'image' : 'business';
}

/** The picture a logo shows: the uploaded one, or the business's (null: none yet). */
export function logoPicture(el: Pick<SketchElement, 'source' | 'src'>, businessLogo: string | null): string | null {
  return logoSourceOf(el) === 'image' ? (el.src ?? null) : businessLogo;
}

/** How opaque a logo is drawn, 0.2–1. */
export function logoOpacity(el: Pick<SketchElement, 'opacity'>): number {
  return clampLogoOpacity(el.opacity ?? LOGO_OPACITY.default) / 100;
}

/** The change that makes a logo the business's (its picture forgotten) or the uploaded one's. */
export function withLogoSource(source: LogoSource, src?: string | null): Partial<SketchElement> {
  return source === 'business' ? { source: 'business', src: null } : { source: 'image', ...(src !== undefined ? { src } : {}) };
}

/**
 * A box of a picture's proportions (`ratio` = width / height) about the same centre, as large as
 * the box's longer side allows — when "keep the proportions" is on, or a picture is chosen.
 */
export function boxOfRatio(el: Pick<SketchElement, 'x' | 'y' | 'w' | 'h'>, ratio: number): Pick<SketchElement, 'x' | 'y' | 'w' | 'h'> {
  if (!(ratio > 0) || !Number.isFinite(ratio)) return { x: el.x, y: el.y, w: el.w, h: el.h };
  const long = Math.max(el.w, el.h);
  const w = ratio >= 1 ? long : long * ratio;
  const h = ratio >= 1 ? long / ratio : long;
  const cx = el.x + el.w / 2;
  const cy = el.y + el.h / 2;
  return { x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w: Math.round(w), h: Math.round(h) };
}
