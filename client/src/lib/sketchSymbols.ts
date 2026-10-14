/**
 * The line icons of the sketch schema 3 symbols (P:/specs/table-map-decor-v3.md §1, §7): what the
 * dashboard draws inside a symbol's shape, and what the till may draw too, byte for byte.
 *
 * Each icon is a list of SVG paths on a 100 × 100 grid centred on (0, 0) — every coordinate within
 * ±46 — drawn in the symbol's colour with round caps and joins:
 *  - a stroked part (the default) is `width` units wide (8, the grid's line);
 *  - a `fill` part is filled with the colour, no stroke;
 *  - a `bg` part is stroked and filled with the shape's own fill, so it hides what is under it.
 * Scaled to a symbol of `size` units: `translate(cx cy) scale(size / 100)`. The till parses the same
 * strings (Compose `PathParser`). Only M, L, H, V, Q, C, A and Z are used.
 *
 * Self-contained on purpose (no imports): the node test build compiles it alone.
 */

export interface IconPart {
  d: string;
  fill?: boolean;
  bg?: boolean;
  /** The stroke's width on the 100-unit grid (8 when absent). */
  width?: number;
}

export const ICON_GRID = 100;
export const ICON_STROKE = 8;
/** How far from the centre any point of an icon may lie (the grid's margin kept clear). */
export const ICON_REACH = 46;

const r1 = (v: number) => Math.round(v * 10) / 10;

/** A circle as a path: two half arcs. */
function circle(cx: number, cy: number, r: number): string {
  return `M ${r1(cx - r)} ${r1(cy)} A ${r1(r)} ${r1(r)} 0 1 0 ${r1(cx + r)} ${r1(cy)} A ${r1(r)} ${r1(r)} 0 1 0 ${r1(cx - r)} ${r1(cy)} Z`;
}

/** A rectangle with round corners as a path. */
function rounded(x: number, y: number, w: number, h: number, r: number): string {
  return (
    `M ${x + r} ${y} H ${x + w - r} Q ${x + w} ${y} ${x + w} ${y + r} V ${y + h - r} ` +
    `Q ${x + w} ${y + h} ${x + w - r} ${y + h} H ${x + r} Q ${x} ${y + h} ${x} ${y + h - r} V ${y + r} Q ${x} ${y} ${x + r} ${y} Z`
  );
}

/** The sun's eight rays, from `inner` to `outer`. */
function rays(inner: number, outer: number): string {
  const out: string[] = [];
  for (let k = 0; k < 8; k++) {
    const a = (k * Math.PI) / 4;
    out.push(`M ${r1(inner * Math.cos(a))} ${r1(inner * Math.sin(a))} L ${r1(outer * Math.cos(a))} ${r1(outer * Math.sin(a))}`);
  }
  return out.join(' ');
}

/** A snowflake: three axes and a chevron near each end. */
function snowflake(reach: number): string {
  const out: string[] = [];
  for (let k = 0; k < 6; k++) {
    const a = ((k * 60 - 90) * Math.PI) / 180;
    const u = { x: Math.cos(a), y: Math.sin(a) };
    const v = { x: -u.y, y: u.x };
    out.push(`M 0 0 L ${r1(reach * u.x)} ${r1(reach * u.y)}`);
    const at = reach * 0.58;
    const tip = reach * 0.84;
    out.push(
      `M ${r1(at * u.x + 11 * v.x)} ${r1(at * u.y + 11 * v.y)} L ${r1(tip * u.x)} ${r1(tip * u.y)} L ${r1(at * u.x - 11 * v.x)} ${r1(at * u.y - 11 * v.y)}`,
    );
  }
  return out.join(' ');
}

/** The entrance's door frame (right of centre), as the v2 door symbol draws it. */
const DOOR_FRAME = rounded(20, -38, 20, 76, 3);

/**
 * The icons, by kind — and by `kind.variant` where a variant draws its own (a bar's drink, which
 * entrance). The schema 2 symbols (restrooms, the entrance, the kitchen…) keep their own drawing.
 */
export const SYMBOL_ICONS: Record<string, IconPart[]> = {
  // ── Service ("שירות") ──
  // A waiter's tray, carried on the hand: a glass and a bottle on it.
  service_station: [
    { d: 'M -42 2 H 42' },
    { d: 'M -30 -34 H -12 Q -12 -16 -21 -14 Q -30 -16 -30 -34 Z M -21 -14 V 2', width: 6 },
    { d: 'M 10 2 V -18 Q 10 -24 15 -26 V -38 H 23 V -26 Q 28 -24 28 -18 V 2', width: 6 },
    { d: 'M -18 10 Q -4 30 18 24 L 34 40', width: 7 },
  ],
  // A cup on its saucer, steaming.
  coffee_station: [
    { d: 'M -30 -6 H 26 L 22 26 Q 21 32 14 32 H -18 Q -25 32 -26 26 Z' },
    { d: 'M 25 2 Q 40 0 39 13 Q 38 24 23 22', width: 7 },
    { d: 'M -12 -18 Q -18 -26 -12 -34 M 6 -18 Q 0 -26 6 -34', width: 6 },
    { d: 'M -40 40 H 36', width: 7 },
  ],
  // A cloche over its plate.
  buffet: [
    { d: 'M -34 20 A 34 34 0 0 1 34 20' },
    { d: 'M -44 22 H 44' },
    { d: circle(0, -19, 6), fill: true },
    { d: 'M -24 32 H 24', width: 6 },
  ],
  // A layered cake with a candle.
  dessert_station: [
    { d: 'M -32 34 V 2 H 32 V 34 Z' },
    { d: 'M -32 14 Q -24 22 -16 14 Q -8 6 0 14 Q 8 22 16 14 Q 24 6 32 14', width: 6 },
    { d: 'M 0 2 V -16', width: 6 },
    { d: 'M 0 -38 Q 9 -27 0 -21 Q -9 -27 0 -38 Z', fill: true },
    { d: 'M -42 42 H 42', width: 7 },
  ],
  // A display fridge: its shelves with goods, its handle.
  display_fridge: [
    { d: rounded(-28, -42, 56, 84, 7) },
    { d: 'M -28 -12 H 28 M -28 16 H 28', width: 6 },
    { d: `${circle(-12, -22, 5)} ${circle(6, -22, 5)} ${circle(-12, 6, 5)} ${circle(6, 6, 5)}`, fill: true },
    { d: 'M 18 -34 V -26 M 18 24 V 32', width: 6 },
  ],
  // ── Guests ("אורחים") ──
  // The lift's call buttons: up and down.
  elevator: [
    { d: rounded(-36, -40, 72, 80, 8), width: 7 },
    { d: 'M -15 -6 L 0 -27 L 15 -6 Z M -15 6 L 0 27 L 15 6 Z', fill: true },
  ],
  // A teddy bear's head.
  kids_corner: [
    { d: `${circle(-22, -22, 11)} ${circle(22, -22, 11)}`, width: 6 },
    { d: circle(0, 4, 27), bg: true, width: 7 },
    { d: `${circle(-10, -3, 4)} ${circle(10, -3, 4)} ${circle(0, 10, 4)}`, fill: true },
    { d: 'M -8 18 Q 0 24 8 18', width: 5 },
  ],
  // A cigarette and its smoke.
  smoking: [
    { d: 'M -42 6 H 28 V 20 H -42 Z', width: 6 },
    { d: 'M 14 6 H 28 V 20 H 14 Z', fill: true },
    { d: 'M 36 -2 Q 30 -12 36 -22 Q 42 -32 36 -42', width: 6 },
  ],
  // The cigarette, struck through, in its ring.
  no_smoking: [
    { d: circle(0, 0, 41), width: 7 },
    { d: 'M -28 -7 H 28 V 7 H -28 Z', width: 6 },
    { d: 'M 14 -7 H 28 V 7 H 14 Z', fill: true },
    { d: 'M -29 -29 L 29 29', width: 8 },
  ],
  // A coat hanger.
  coat_check: [
    { d: 'M -4 -24 Q -4 -32 4 -32 Q 12 -32 12 -24 Q 12 -18 0 -10 V -4', width: 6 },
    { d: 'M 0 -4 L -40 26 Q -44 30 -38 30 H 38 Q 44 30 40 26 Z', width: 7 },
  ],
  // A chair and a clock.
  waiting_area: [
    { d: 'M -38 -16 V 34 M -38 10 H -12 V 34', width: 7 },
    { d: circle(18, -12, 21), width: 6 },
    { d: 'M 18 -24 V -12 H 28', width: 5 },
  ],
  // A screen on its stand.
  tv: [
    { d: rounded(-42, -32, 84, 52, 6) },
    { d: 'M 0 20 V 32 M -18 34 H 18', width: 7 },
  ],
  // A loudspeaker and its sound.
  speaker: [
    { d: 'M -36 -12 H -20 L 0 -30 V 30 L -20 12 H -36 Z', width: 7 },
    { d: 'M 14 -14 Q 24 0 14 14 M 26 -27 Q 44 0 26 27', width: 6 },
  ],
  // A carrier bag.
  pickup: [
    { d: 'M -30 -8 H 30 L 34 40 H -34 Z' },
    { d: 'M -14 -8 V -18 Q -14 -32 0 -32 Q 14 -32 14 -18 V -8', width: 6 },
  ],
  // A delivery scooter with its box.
  delivery_exit: [
    { d: `${circle(-26, 26, 11)} ${circle(28, 26, 11)}`, width: 6 },
    { d: 'M -15 26 H 12 M 28 26 L 18 -12 M 12 -14 H 28', width: 7 },
    { d: rounded(-42, -14, 30, 22, 3), fill: true },
    { d: 'M -27 8 V 15', width: 6 },
  ],
  // A bin with its lid.
  trash: [
    { d: 'M -32 -24 H 32 M -10 -24 V -32 H 10 V -24' },
    { d: 'M -24 -16 L -20 38 H 20 L 24 -16', width: 7 },
    { d: 'M -8 -6 V 28 M 8 -6 V 28', width: 5 },
  ],
  // A basin under its tap, a drop falling.
  sink: [
    { d: 'M -40 4 H 40 Q 40 34 0 34 Q -40 34 -40 4 Z' },
    { d: 'M -6 4 V -22 Q -6 -32 6 -32 Q 18 -32 18 -22', width: 7 },
    { d: 'M 18 -14 Q 24 -6 18 -2 Q 12 -6 18 -14 Z', fill: true },
  ],
  // ── Safety ("בטיחות") ──
  first_aid: [{ d: 'M -11 -36 H 11 V -11 H 36 V 11 H 11 V 36 H -11 V 11 H -36 V -11 H -11 Z', fill: true }],
  // A fire extinguisher: its body, its valve and its hose.
  fire_extinguisher: [
    { d: 'M -14 -12 Q -14 -24 0 -24 Q 14 -24 14 -12 V 34 Q 14 40 8 40 H -8 Q -14 40 -14 34 Z', fill: true },
    { d: 'M 0 -24 V -32 M -10 -34 H 10 L 20 -40', width: 6 },
    { d: 'M 6 -32 Q 32 -32 30 4', width: 6 },
  ],
  // The parking sign: a P in its square.
  parking: [
    { d: rounded(-40, -40, 80, 80, 10), width: 6 },
    { d: 'M -12 26 V -24 H 4 Q 22 -24 22 -6 Q 22 12 4 12 H -12', width: 11 },
  ],
  // ── Atmosphere ("אווירה") ──
  // The sun: seating outside.
  outdoor: [
    { d: circle(0, 0, 15), width: 7 },
    { d: rays(25, 38), width: 7 },
  ],
  // A flame: a heater (a patio "mushroom").
  heater: [
    {
      d: 'M 0 -40 C 18 -22 30 -6 24 14 C 20 30 8 38 0 38 C -8 38 -20 30 -24 14 C -28 -2 -14 -12 -8 -26 C -4 -14 4 -10 6 -6 C 10 -20 6 -30 0 -40 Z',
      width: 6,
    },
    { d: 'M 0 32 C -9 32 -11 22 -6 13 C -2 18 3 18 5 11 C 11 20 9 32 0 32 Z', fill: true },
  ],
  // A snowflake: the air conditioning.
  fan_ac: [{ d: snowflake(40), width: 6 }],
  // ── A bar's drink ("דלפק": cocktail / beer / wine) ──
  'bar.cocktail': [
    { d: 'M -30 -30 H 30 L 0 4 Z', fill: true },
    { d: 'M 0 4 V 32 M -16 34 H 16', width: 7 },
    { d: circle(27, -34, 9), bg: true, width: 6 },
  ],
  'bar.beer': [
    { d: 'M -26 -22 H 14 V 34 Q 14 38 10 38 H -22 Q -26 38 -26 34 Z', width: 7 },
    { d: 'M 14 -10 H 26 Q 32 -10 32 -4 V 18 Q 32 24 26 24 H 14', width: 7 },
    { d: 'M -30 -22 Q -32 -36 -18 -36 Q -12 -44 -2 -38 Q 8 -44 14 -36 Q 22 -34 18 -22 Z', fill: true },
    { d: 'M -14 -10 V 26 M 2 -10 V 26', width: 5 },
  ],
  'bar.wine': [
    { d: 'M -20 -40 H 20 Q 24 -8 0 -4 Q -24 -8 -20 -40 Z', width: 6 },
    { d: 'M -21 -24 H 21 Q 18 -6 0 -4 Q -18 -6 -21 -24 Z', fill: true },
    { d: 'M 0 -4 V 32 M -16 34 H 16', width: 7 },
  ],
  // ── Which entrance ("כניסה": main / side / staff) ──
  // The main entrance: the door solid, the arrow bold.
  'door.main': [
    { d: DOOR_FRAME, fill: true },
    { d: 'M -42 0 H 10 M -10 -22 L 12 0 L -10 22', width: 10 },
  ],
  // A side entrance: the arrow comes round the corner.
  'door.side': [
    { d: DOOR_FRAME, width: 6 },
    { d: 'M -36 34 V 12 Q -36 0 -24 0 H 10 M -10 -20 L 12 0 L -10 20', width: 8 },
  ],
  // The staff's entrance: a person with a badge, at the door.
  'door.staff': [
    { d: DOOR_FRAME, width: 6 },
    { d: circle(-18, -20, 10), fill: true },
    { d: 'M -40 34 V 16 Q -40 -4 -18 -4 Q 4 -4 4 16 V 34', width: 7 },
    { d: rounded(-26, 6, 14, 12, 2), fill: true },
  ],
};

/** The icon key of a kind and variant: its own drawing when a variant has one, else the kind's; null for none. */
export function iconKey(kind: string, variant?: string | null): string | null {
  if (variant && SYMBOL_ICONS[`${kind}.${variant}`]) return `${kind}.${variant}`;
  return SYMBOL_ICONS[kind] ? kind : null;
}

/** Every number in an icon's paths (for the bounds check). */
export function iconNumbers(parts: IconPart[]): number[] {
  const out: number[] = [];
  for (const p of parts) {
    // Arc flags (A rx ry rot large sweep x y) are numbers too: all within the reach anyway.
    for (const m of p.d.matchAll(/-?\d+(?:\.\d+)?/g)) out.push(Number(m[0]));
  }
  return out;
}
