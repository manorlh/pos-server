/**
 * Run with `npm test`. The chairs round a table (lib/tableSketch.ts) — the till draws the
 * same (domain/TableFloor.kt, ChairLayout; app TableFloorTest).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  AREA_FILLS,
  AREA_FILL_DEFAULT,
  AREA_OPACITY,
  CHAIR,
  CHAIR_REACH,
  DUPLICATE_MAX,
  GREENERY_KINDS,
  MAP_DISPLAY_DEFAULTS,
  PALETTE,
  PALETTE_TABS,
  PALETTE_TAB_NAMES,
  PREVIEW_DEVICES,
  SKETCH_BACKGROUNDS,
  SKETCH_KINDS,
  SKETCH_KINDS_3,
  SKETCH_NAMES,
  SKETCH_SCHEMA,
  SKETCH_STYLE,
  SKETCH_VARIANTS,
  STRUCTURE_KINDS,
  VARIANT_CHOICES,
  areaCorners,
  areaFromCorners,
  arrangeTables,
  backgroundOf,
  chairLayout,
  chairSides,
  clampOpacity,
  counterGeometry,
  decorExtent,
  defaultText,
  drawOrder,
  duplicateMany,
  entryName,
  fitMapView,
  hitTest,
  isCompactScreen,
  isPolygonArea,
  legendEntries,
  mix,
  newElement,
  onView,
  planSwitchToMap,
  pointInPolygon,
  polygonCentroid,
  quarterTurned,
  resized,
  searchPalette,
  snapToWalls,
  styleOf,
  tablesNeedPlacing,
  templateSketch,
  translated,
  turnedBox,
  uniqueElements,
  variantOf,
  visibleElements,
  wallBoxes,
  type PlaceableTable,
  type Sketch,
  type SketchElement,
  type SketchKind,
  type TablePlacement,
} from './tableSketch';
import { ICON_REACH, SYMBOL_ICONS, iconKey, iconNumbers } from './sketchSymbols';

describe('the logo and the clean floor', () => {
  it('offers a logo, sized from the canvas, with no picture of its own', () => {
    assert.ok(SKETCH_KINDS.includes('logo'));
    const logo = newElement('logo', 1000, 700);
    assert.equal(logo.kind, 'logo');
    assert.deepEqual([logo.w, logo.h], [140, 84]);
    assert.equal(logo.src ?? null, null);
    assert.equal(logo.text, null);
  });

  it('draws the clean floor when nothing was chosen, and keeps what was', () => {
    assert.equal(SKETCH_BACKGROUNDS[0], 'clean');
    assert.equal(backgroundOf(null, false), 'clean');
    assert.equal(backgroundOf({ elements: [] }, true), 'image');
    assert.equal(backgroundOf({ background: 'wood', elements: [] }, false), 'wood');
    assert.equal(backgroundOf({ background: 'image', elements: [] }, false), 'clean');
    // A template draws no floor of its own.
    assert.equal(templateSketch('cafeBar', 1000, 700).background, null);
  });
});

describe('chairSides', () => {
  it('shares a square table round its four sides', () => {
    assert.deepEqual(chairSides(4, 80, 80), [1, 1, 1, 1]);
    assert.deepEqual(chairSides(2, 80, 80), [1, 0, 1, 0]);
    assert.deepEqual(chairSides(6, 80, 80), [2, 1, 2, 1]);
  });

  it('seats a long table on its long sides, and its ends from five', () => {
    assert.deepEqual(chairSides(4, 160, 80), [2, 0, 2, 0]);
    assert.deepEqual(chairSides(5, 160, 80), [2, 0, 2, 1]);
    assert.deepEqual(chairSides(8, 160, 80), [3, 1, 3, 1]);
    assert.deepEqual(chairSides(4, 80, 160), [0, 2, 0, 2]);
  });
});

describe('chairLayout', () => {
  it('draws as many chairs as seats, outside the table and within its reach', () => {
    for (const [round, w, h] of [[true, 100, 100], [false, 100, 100], [false, 200, 90]] as const) {
      for (const seats of [1, 3, 4, 6, 8, 12]) {
        const chairs = chairLayout(round, w, h, seats);
        assert.equal(chairs.length, seats);
        const m = Math.min(w, h) * CHAIR_REACH;
        for (const c of chairs) {
          const outside = round
            ? Math.hypot((c.cx - w / 2) / (w / 2), (c.cy - h / 2) / (h / 2)) > 1
            : c.cx < 0 || c.cx > w || c.cy < 0 || c.cy > h;
          assert.ok(outside);
          assert.ok(c.cx >= -m - 0.01 && c.cx <= w + m + 0.01 && c.cy >= -m - 0.01 && c.cy <= h + m + 0.01);
        }
      }
    }
  });

  it('puts a round table first chair at the top, and draws at most 24', () => {
    const c = chairLayout(true, 100, 100, 4);
    assert.ok(Math.abs(c[0].cx - 50) < 0.01 && c[0].cy < 0);
    assert.deepEqual(c.map((x) => x.angle), [0, 90, 180, 270]);
    assert.equal(chairLayout(false, 400, 80, 60).length, CHAIR.maxDrawn);
    assert.equal(chairLayout(false, 80, 80, 0).length, 0);
  });
});

describe('uniqueElements', () => {
  const line = (id: string, x: number): SketchElement => ({
    id, kind: 'line', x, y: 0, w: 10, h: 0, rotation: 0, text: null, color: '#111827', stroke: 6, filled: null,
  });

  it('keeps each id once, the first one, in order', () => {
    const kept = uniqueElements([line('a', 1), line('b', 2), line('a', 3), line('c', 4), line('b', 5)]);
    assert.deepEqual(kept.map((e) => [e.id, e.x]), [['a', 1], ['b', 2], ['c', 4]]);
  });

  it('leaves a sketch without repeats as it is', () => {
    const els = [line('a', 1), line('b', 2)];
    assert.deepEqual(uniqueElements(els), els);
    assert.deepEqual(uniqueElements([]), []);
  });
});

// ── The decor symbols ("סמלים", specs/table-map-decor.md) ─────────────────────

describe('the decor symbols', () => {
  it('offers every kind once, in the palette of schema 3', () => {
    assert.equal(new Set(SKETCH_KINDS).size, SKETCH_KINDS.length);
    for (const k of ['restroom', 'door', 'exit', 'counter', 'dj_booth', 'plant', 'kitchen', 'stairs', 'cashier', 'label', 'wall', 'logo'] as SketchKind[]) {
      assert.ok(SKETCH_KINDS.includes(k), k);
    }
    for (const k of SKETCH_KINDS_3) assert.ok(SKETCH_KINDS.includes(k), k);
    // The drawing tools' kinds are not in the palette.
    for (const k of ['line', 'polyline', 'freehand', 'rect'] as SketchKind[]) assert.ok(!SKETCH_KINDS.includes(k), k);
    assert.equal(SKETCH_SCHEMA, 3);
  });

  it('keeps a variant only on its own kind, as the server and the till do', () => {
    assert.equal(variantOf('counter', 'U'), 'U');
    assert.equal(variantOf('counter', 'men'), 'straight');
    assert.equal(variantOf('counter', null), 'straight');
    assert.equal(variantOf('restroom', 'accessible'), 'accessible');
    assert.equal(variantOf('restroom', 'U'), null);
    assert.equal(variantOf('exit', 'plain'), 'plain');
    assert.equal(variantOf('exit', 'L'), null);
    assert.equal(variantOf('wall', 'L'), null);
    assert.equal(variantOf('bar', 'beer'), 'beer');
    assert.equal(variantOf('bar', 'main'), null);
    assert.equal(variantOf('door', 'staff'), 'staff');
    assert.equal(variantOf('door', 'cocktail'), null);
    assert.equal(variantOf('plant', 'large'), 'large');
    assert.equal(variantOf('plant', 'side'), null);
    assert.equal(variantOf('tree', 'large'), null);
    assert.deepEqual(Object.keys(SKETCH_VARIANTS).sort(), ['bar', 'counter', 'door', 'exit', 'plant', 'restroom']);
    // Every chip is a variant of its kind (or the kind's own sign).
    for (const [kind, chips] of Object.entries(VARIANT_CHOICES)) {
      for (const v of chips ?? []) if (v) assert.equal(variantOf(kind as SketchKind, v), v, `${kind} ${v}`);
    }
  });

  it('says whose restrooms and which exit, and draws a plain exit in slate', () => {
    assert.equal(defaultText({ kind: 'restroom' }), 'שירותים');
    assert.equal(defaultText({ kind: 'restroom', variant: 'men' }), 'גברים');
    assert.equal(defaultText({ kind: 'restroom', variant: 'women' }), 'נשים');
    assert.equal(defaultText({ kind: 'restroom', variant: 'accessible' }), 'נגיש');
    assert.equal(defaultText({ kind: 'exit', variant: 'plain' }), 'יציאה');
    assert.equal(defaultText({ kind: 'exit' }), 'יציאת חירום');
    assert.equal(defaultText({ kind: 'door' }), 'כניסה');
    assert.equal(defaultText({ kind: 'dj_booth' }), "עמדת די־ג'יי");
    assert.equal(defaultText({ kind: 'plant' }), null);
    assert.notEqual(styleOf({ kind: 'exit', variant: 'plain' }).fill, styleOf({ kind: 'exit' }).fill);
    assert.ok(styleOf({ kind: 'dj_booth' }).fill);
  });

  it('adds a DJ booth sized from the canvas, and a plain exit', () => {
    const dj = newElement('dj_booth', 1000, 700);
    assert.deepEqual([dj.w, dj.h], [112, 70]);
    assert.equal(newElement('exit', 1000, 700).variant, 'plain');
    assert.equal(newElement('restroom', 1000, 700).variant ?? null, null);
  });

  it('runs a U bar along the bottom and up both sides, its stools inside', () => {
    const el: SketchElement = {
      id: 'u', kind: 'counter', x: 620, y: 30, w: 320, h: 200, rotation: 0, text: null, variant: 'U', stools: 5,
    };
    const { bars, stools } = counterGeometry(el);
    assert.equal(bars.length, 3);
    assert.equal(stools.length, 5);
    const [bottom, left, right] = bars;
    assert.equal(bottom.y + bottom.h, el.y + el.h);
    assert.equal(left.x, el.x);
    assert.equal(right.x + right.w, el.x + el.w);
    for (const s of stools) {
      assert.ok(s.cx - s.r >= left.x + left.w - 0.01 && s.cx + s.r <= right.x + 0.01);
      assert.ok(s.cy + s.r <= bottom.y + 0.01);
    }
  });

  it('knows every kind and variant of the golden layout the till reads too', () => {
    // pos-server's tests/fixtures/table_map_decor_golden.json (the same bytes in pos-android).
    const file = path.join(__dirname, '..', '..', 'server', 'tests', 'fixtures', 'table_map_decor_golden.json');
    if (!fs.existsSync(file)) return;
    const golden = JSON.parse(fs.readFileSync(file, 'utf8')) as { zones: { sketch: Sketch }[] };
    // Zone 0: schema 2, as it was; zone 1: schema 3.
    assert.equal(golden.zones[0].sketch.elements.length, 19);
    assert.equal(golden.zones[1].sketch.elements.length, 39);
    const elements = golden.zones.flatMap((z) => z.sketch.elements);
    for (const el of elements) {
      assert.ok(SKETCH_KINDS.includes(el.kind), el.kind);
      if (el.variant != null) assert.equal(variantOf(el.kind, el.variant), el.variant, `${el.id} ${el.variant}`);
      if (el.kind === 'area') {
        assert.ok(AREA_FILLS.includes(el.fill as (typeof AREA_FILLS)[number]), `${el.id} ${el.fill}`);
        assert.equal(clampOpacity(el.opacity ?? 0), el.opacity);
      }
    }
    const kinds = new Set(elements.map((e) => e.kind));
    for (const k of SKETCH_KINDS_3) assert.ok(kinds.has(k), k);
    for (const [kind, variants] of Object.entries(SKETCH_VARIANTS)) {
      for (const v of variants ?? []) {
        if (kind === 'counter' && v === 'straight') continue;
        assert.ok(elements.some((el) => el.kind === kind && el.variant === v), `${kind} ${v}`);
      }
    }
    // The legend of the schema 3 zone: its symbols and its two named areas, never a wall.
    const legend = legendEntries(golden.zones[1].sketch.elements);
    assert.ok(legend.some((l) => l.kind === 'area' && l.name === 'VIP'));
    assert.ok(legend.some((l) => l.kind === 'bar' && l.variant === 'beer' && l.name === 'בר בירה'));
    assert.ok(!legend.some((l) => STRUCTURE_KINDS.includes(l.kind)));
  });
});

// ── From squares to a map ("עבור לתצוגת מפה") ────────────────────────────────

describe('switching a zone of squares to a map', () => {
  const table = (number: number, x: number, y: number, size = 84): PlaceableTable => ({
    id: `t${number}`, number, x, y, width: size, height: size, rotation: 0,
  });
  // Where the cloud puts a new table (app/services/tables.py `_next_slot`): rows from the top-left.
  const slotted = (n: number, size = 84) =>
    Array.from({ length: n }, (_, i) => {
      const perRow = Math.max(1, Math.floor((1000 - 20) / (size + 20)));
      return table(i + 1, 20 + (i % perRow) * (size + 20), 20 + Math.floor(i / perRow) * (size + 20), size);
    });
  const inside = (p: { x: number; y: number; width: number; height: number }, cw: number, ch: number) =>
    p.x >= 0 && p.y >= 0 && p.x + p.width <= cw && p.y + p.height <= ch;
  const overlap = (a: TablePlacement, b: TablePlacement) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  it('keeps the places the cloud gave the tables', () => {
    assert.equal(tablesNeedPlacing(slotted(12), 1000, 700), false);
    assert.deepEqual(planSwitchToMap(slotted(12), 1000, 700), []);
    assert.deepEqual(planSwitchToMap([], 1000, 700), []);
  });

  it('places them anew when they have no place: on one spot, or off the canvas', () => {
    const stacked = [table(1, 0, 0), table(2, 0, 0), table(3, 0, 0)];
    assert.equal(tablesNeedPlacing(stacked, 1000, 700), true);
    assert.equal(tablesNeedPlacing([table(1, 950, 20)], 1000, 700), true);
    assert.equal(tablesNeedPlacing([table(1, 20, -5)], 1000, 700), true);
    const plan = planSwitchToMap(stacked, 1000, 700);
    assert.deepEqual(plan.map((p) => p.id), ['t1', 't2', 't3']);
    assert.ok(plan.every((p) => inside(p, 1000, 700)));
  });

  it('arranges them in a tidy grid: by number, row by row, centred, room for chairs, apart', () => {
    const shuffled = [7, 3, 10, 1, 5, 2, 9, 4, 8, 6].map((n) => table(n, 0, 0));
    const plan = arrangeTables(shuffled, 1000, 700);
    assert.deepEqual(plan.map((p) => p.id), ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 't10']);
    // Four across, three rows, the grid in the middle of the canvas.
    assert.deepEqual(plan.slice(0, 5).map((p) => [p.x, p.y]), [[250, 169], [389, 169], [528, 169], [667, 169], [250, 308]]);
    const xs = plan.map((p) => p.x);
    const ys = plan.map((p) => p.y);
    assert.ok(Math.abs(Math.min(...xs) - (1000 - (Math.max(...xs) + 84))) <= 1);
    assert.ok(Math.abs(Math.min(...ys) - (700 - (Math.max(...ys) + 84))) <= 1);
    for (let i = 0; i < plan.length; i++) {
      assert.ok(inside(plan[i], 1000, 700), plan[i].id);
      for (let j = i + 1; j < plan.length; j++) assert.ok(!overlap(plan[i], plan[j]), `${plan[i].id} ${plan[j].id}`);
    }
    // Each keeps its size and turn.
    const mixed = arrangeTables([{ ...table(1, 0, 0), width: 126, height: 67, rotation: 90 }, table(2, 0, 0)], 1000, 700);
    assert.deepEqual([mixed[0].width, mixed[0].height, mixed[0].rotation], [126, 67, 90]);
  });

  it('squeezes many onto the canvas, never off it; one table in the middle', () => {
    const many = Array.from({ length: 100 }, (_, i) => table(i + 1, 0, 0));
    const plan = arrangeTables(many, 1000, 700);
    assert.equal(plan.length, 100);
    assert.ok(plan.every((p) => inside(p, 1000, 700)));
    assert.equal(new Set(plan.map((p) => `${p.x},${p.y}`)).size, 100);
    assert.deepEqual(arrangeTables([table(1, 0, 0)], 1000, 700).map((p) => [p.x, p.y]), [[458, 308]]);
    assert.deepEqual(arrangeTables([], 1000, 700), []);
  });
});

// ── Schema 3 (P:/specs/table-map-decor-v3.md) ─────────────────────────────────

describe('the palette in tabs', () => {
  it('has the five tabs, with what the spec lists in each, in its order', () => {
    assert.deepEqual(PALETTE_TABS, ['service', 'guests', 'atmosphere', 'safety', 'structure']);
    assert.deepEqual(PALETTE_TABS.map((t) => PALETTE_TAB_NAMES[t]), ['שירות', 'אורחים', 'אווירה', 'בטיחות', 'מבנה']);
    const kinds = (tab: (typeof PALETTE_TABS)[number]) => PALETTE[tab].map((p) => p.kind);
    const startsWith = (got: SketchKind[], want: SketchKind[]) => assert.deepEqual(got.slice(0, want.length), want);
    startsWith(kinds('service'), ['service_station', 'coffee_station', 'buffet', 'dessert_station', 'display_fridge', 'pickup', 'delivery_exit']);
    startsWith(kinds('guests'), ['restroom', 'door', 'exit', 'waiting_area', 'coat_check', 'kids_corner', 'elevator', 'parking']);
    startsWith(kinds('atmosphere'), ['stage', 'dj_booth', 'tv', 'speaker', 'plant', 'outdoor', 'heater', 'fan_ac']);
    startsWith(kinds('safety'), ['exit', 'first_aid', 'fire_extinguisher', 'smoking', 'no_smoking']);
    startsWith(kinds('structure'), ['wall', 'window', 'column', 'stairs', 'bar', 'counter', 'kitchen', 'area', 'arrow', 'label', 'logo']);
    // The greenery is atmosphere's; the guests' exit is the plain one, safety's the emergency exit.
    for (const k of GREENERY_KINDS) assert.ok(kinds('atmosphere').includes(k), k);
    assert.equal(PALETTE.guests.find((p) => p.kind === 'exit')?.variant, 'plain');
    assert.equal(PALETTE.safety.find((p) => p.kind === 'exit')?.variant, null);
    // Every kind has a Hebrew name, a style and a place in a tab.
    for (const k of SKETCH_KINDS) {
      assert.ok(SKETCH_NAMES[k], k);
      assert.ok(SKETCH_STYLE[k], k);
    }
  });

  it('finds a symbol by its name, its variant or another word', () => {
    assert.deepEqual(searchPalette('קפה')[0], { kind: 'coffee_station', variant: null });
    assert.deepEqual(searchPalette('בירה')[0], { kind: 'bar', variant: 'beer' });
    assert.deepEqual(searchPalette('עובדים')[0], { kind: 'door', variant: 'staff' });
    assert.ok(searchPalette('WC').some((p) => p.kind === 'restroom'));
    assert.ok(searchPalette('  מטף ').some((p) => p.kind === 'fire_extinguisher'));
    assert.ok(searchPalette("די-ג'יי").some((p) => p.kind === 'dj_booth'));
    assert.ok(searchPalette('גדר').some((p) => p.kind === 'hedge'));
    assert.ok(searchPalette('מרפסת').some((p) => p.kind === 'area'));
    // Names that start with the query come first: "עציץ" before what merely mentions it.
    assert.equal(searchPalette('עציץ')[0].kind, 'plant');
    assert.deepEqual(searchPalette(''), []);
    assert.deepEqual(searchPalette('zzz-nothing'), []);
    // Each result once.
    const all = searchPalette('ה');
    assert.equal(new Set(all.map((p) => `${p.kind}.${p.variant}`)).size, all.length);
  });

  it('names a kind with its variant', () => {
    assert.equal(entryName('exit', 'plain'), 'יציאה');
    assert.equal(entryName('exit', null), 'יציאת חירום');
    assert.equal(entryName('door', 'main'), 'כניסה ראשית');
    assert.equal(entryName('bar', 'wine'), 'בר יין');
    assert.equal(entryName('plant', 'large'), 'עציץ — גדול');
    assert.equal(entryName('coffee_station', null), 'עמדת קפה');
  });
});

describe('the new symbols', () => {
  it('say what they are, by variant too', () => {
    assert.equal(defaultText({ kind: 'bar' }), 'בר');
    assert.equal(defaultText({ kind: 'bar', variant: 'cocktail' }), 'בר קוקטיילים');
    assert.equal(defaultText({ kind: 'door', variant: 'side' }), 'כניסה צדדית');
    assert.equal(defaultText({ kind: 'door', variant: 'staff' }), 'כניסת עובדים');
    assert.equal(defaultText({ kind: 'coffee_station' }), 'קפה');
    assert.equal(defaultText({ kind: 'tree' }), null);
    assert.equal(defaultText({ kind: 'arrow' }), null);
    assert.equal(defaultText({ kind: 'area' }), null);
  });

  it('are added sized from the canvas, a plant by its size, an area with its fill', () => {
    const usual = newElement('plant', 1000, 700);
    const large = newElement('plant', 1000, 700, 'large');
    const small = newElement('plant', 1000, 700, 'small');
    assert.ok(large.w > usual.w && usual.w > small.w);
    assert.equal(large.variant, 'large');
    assert.equal(newElement('exit', 1000, 700).variant, 'plain');
    assert.equal(newElement('exit', 1000, 700, null).variant ?? null, null);
    assert.equal(newElement('bar', 1000, 700, 'beer').variant, 'beer');
    assert.equal(newElement('bar', 1000, 700, 'U').variant ?? null, null);
    const area = newElement('area', 1000, 700);
    assert.deepEqual([area.fill, area.opacity, area.text], [AREA_FILL_DEFAULT, AREA_OPACITY.default, 'אזור']);
    for (const k of SKETCH_KINDS) {
      const el = newElement(k, 1000, 700);
      assert.ok(el.w > 0 && el.h > 0 && el.x >= 0 && el.y >= 0 && el.x + el.w <= 1000 && el.y + el.h <= 700, k);
    }
  });

  it('take a colour of their own: their lines in it, their fill a tint of it', () => {
    const own = styleOf({ kind: 'coffee_station', color: '#2563eb' });
    assert.equal(own.stroke, '#2563eb');
    assert.equal(own.fill, mix('#2563eb', '#ffffff', 0.84));
    assert.deepEqual(styleOf({ kind: 'coffee_station' }), SKETCH_STYLE.coffee_station);
    // A label's colour is its words' (drawn apart); a bad colour is no colour.
    assert.deepEqual(styleOf({ kind: 'label', color: '#2563eb' }), SKETCH_STYLE.label);
    assert.deepEqual(styleOf({ kind: 'tv', color: 'blue' }), SKETCH_STYLE.tv);
    // Greenery: the leaves themselves in it.
    assert.equal(styleOf({ kind: 'hedge', color: '#166534' }).fill, '#166534');
    assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
    assert.equal(mix('#123456', '#ffffff', 0), '#123456');
  });

  it('have a line icon each, on the 100-unit grid', () => {
    const own = SKETCH_KINDS_3.filter((k) => k !== 'arrow' && k !== 'area' && !GREENERY_KINDS.includes(k));
    assert.equal(own.length, 23);
    for (const k of own) assert.equal(iconKey(k), k, k);
    for (const v of ['cocktail', 'beer', 'wine']) assert.equal(iconKey('bar', v), `bar.${v}`);
    for (const v of ['main', 'side', 'staff']) assert.equal(iconKey('door', v), `door.${v}`);
    // A variant with no drawing of its own: the kind's; a kind with none: null (drawn by the v2 code).
    assert.equal(iconKey('tv', 'large'), 'tv');
    assert.equal(iconKey('restroom', 'men'), null);
    for (const [key, parts] of Object.entries(SYMBOL_ICONS)) {
      assert.ok(parts.length > 0, key);
      for (const n of iconNumbers(parts)) assert.ok(Math.abs(n) <= ICON_REACH, `${key}: ${n}`);
      for (const p of parts) assert.match(p.d, /^[MLHVQCAZ0-9 .-]+$/, key);
    }
  });
});

describe('areas', () => {
  const square: SketchElement = {
    id: 'a', kind: 'area', x: 0, y: 0, w: 100, h: 100, rotation: 0, text: 'VIP',
    points: [0, 0, 100, 0, 100, 100, 0, 100], fill: '#8b5cf6', opacity: 30,
  };

  it('are made of the corners clicked, three at least', () => {
    const a = areaFromCorners([{ x: 10, y: 10 }, { x: 110, y: 10 }, { x: 110, y: 10 }, { x: 60, y: 90 }, { x: 10, y: 10 }])!;
    assert.deepEqual(a.points, [10, 10, 110, 10, 60, 90]);
    assert.deepEqual([a.x, a.y, a.w, a.h], [10, 10, 100, 80]);
    assert.deepEqual([a.kind, a.fill, a.opacity], ['area', AREA_FILL_DEFAULT, 30]);
    assert.ok(isPolygonArea(a));
    assert.equal(areaFromCorners([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 0 }]), null);
    assert.ok(!isPolygonArea(newElement('area', 1000, 700)));
  });

  it('write their name at the centroid, and are picked inside', () => {
    assert.deepEqual(polygonCentroid([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }]), { x: 50, y: 50 });
    const c = polygonCentroid([{ x: 0, y: 0 }, { x: 90, y: 0 }, { x: 0, y: 90 }]);
    assert.ok(Math.abs(c.x - 30) < 1e-9 && Math.abs(c.y - 30) < 1e-9);
    assert.ok(pointInPolygon({ x: 50, y: 50 }, areaCorners(square)));
    assert.ok(!pointInPolygon({ x: 150, y: 50 }, areaCorners(square)));
    assert.ok(hitTest(square, { x: 50, y: 50 }, 2));
    assert.ok(hitTest(square, { x: 101, y: 50 }, 2));
    assert.ok(!hitTest(square, { x: 120, y: 50 }, 2));
  });

  it('move and resize with their polygon; keep their opacity 10–60', () => {
    const moved = translated(square, 20, 10);
    assert.deepEqual(moved.points, [20, 10, 120, 10, 120, 110, 20, 110]);
    assert.deepEqual([moved.x, moved.y], [20, 10]);
    const big = resized(square, 200, 50);
    assert.deepEqual(big.points, [0, 0, 200, 0, 200, 50, 0, 50]);
    assert.deepEqual([big.w, big.h], [200, 50]);
    assert.deepEqual(resized(newElement('tv', 1000, 700), 50, 1).h, 2);
    assert.deepEqual([clampOpacity(5), clampOpacity(33.4), clampOpacity(99), clampOpacity(NaN)], [10, 33, 60, 30]);
  });

  it('are drawn under everything else', () => {
    const wall = newElement('wall', 1000, 700);
    const order = drawOrder([wall, square, newElement('tree', 1000, 700)]);
    assert.equal(order[0].kind, 'area');
    assert.equal(order[1], wall);
  });
});

describe('snapping and duplicating', () => {
  const top: SketchElement = { id: 'w', kind: 'wall', x: 0, y: 0, w: 1000, h: 12, rotation: 0 };
  const left: SketchElement = { id: 'l', kind: 'wall', x: 0, y: 0, w: 12, h: 700, rotation: 0 };

  it('lays a shape flush against a wall it is near', () => {
    const walls = wallBoxes([top, left]);
    // 6 below the top wall and 8 from the left one: pulled to both faces.
    assert.deepEqual(snapToWalls({ x: 20, y: 18, w: 100, h: 60 }, walls, 10), { dx: -8, dy: -6 });
    // Pushed into the wall: out to its face.
    assert.deepEqual(snapToWalls({ x: 300, y: 5, w: 100, h: 60 }, walls, 10), { dx: 0, dy: 7 });
    // Too far: left where it is.
    assert.deepEqual(snapToWalls({ x: 300, y: 40, w: 100, h: 60 }, walls, 10), { dx: 0, dy: 0 });
    // A wall drawn as a polyline: its straight segments, as thick as its stroke.
    const drawn: SketchElement = {
      id: 'p', kind: 'polyline', x: 100, y: 300, w: 200, h: 100, rotation: 0, points: [100, 300, 300, 300, 300, 400], stroke: 8,
    };
    const segs = wallBoxes([drawn]);
    assert.deepEqual(segs, [{ x: 100, y: 296, w: 200, h: 8 }, { x: 296, y: 300, w: 8, h: 100 }]);
    assert.deepEqual(snapToWalls({ x: 150, y: 250, w: 40, h: 40 }, segs, 10), { dx: 0, dy: 6 });
    // A shape is not its own wall.
    assert.deepEqual(wallBoxes([top], 'w'), []);
  });

  it('duplicates in a row or a column, as many as fit', () => {
    const el = { ...newElement('service_station', 1000, 700), x: 100, y: 100, w: 100, h: 50 };
    const row = duplicateMany(el, 3, 'right', 10, 1000, 700);
    assert.deepEqual(row.map((c) => c.x), [210, 320, 430]);
    assert.equal(new Set([el.id, ...row.map((c) => c.id)]).size, 4);
    assert.deepEqual(duplicateMany(el, 3, 'down', 0, 1000, 700).map((c) => c.y), [150, 200, 250]);
    // Off the canvas: stops there.
    assert.equal(duplicateMany(el, 20, 'left', 10, 1000, 700).length, 0);
    assert.equal(duplicateMany(el, 100, 'right', 0, 100000, 700).length, DUPLICATE_MAX);
    // A shape turned a quarter steps by its turned box.
    const turned = { ...el, rotation: 90 };
    assert.deepEqual(turnedBox(turned), { x: 125, y: 75, w: 50, h: 100 });
    assert.deepEqual(duplicateMany(turned, 2, 'right', 0, 1000, 700).map((c) => c.x), [150, 200]);
  });
});

describe('the till: what it draws, its legend, its fit', () => {
  const plan = (kinds: SketchKind[]) => kinds.map((k, i) => ({ ...newElement(k, 1000, 700), id: `e${i}` }));

  it('draws all, the symbols only, or none (mapDecor)', () => {
    const els = plan(['wall', 'window', 'coffee_station', 'tree', 'area', 'label', 'logo', 'sofa', 'counter']);
    assert.equal(visibleElements(els, 'full').length, 9);
    assert.deepEqual(visibleElements(els, 'symbols').map((e) => e.kind), ['coffee_station', 'tree', 'area', 'label', 'counter']);
    assert.deepEqual(visibleElements(els, 'off'), []);
    assert.deepEqual(MAP_DISPLAY_DEFAULTS, { mapDecor: 'full', mapLegend: 'button', mapSymbolLabels: 'auto', mapSymbolScale: 100 });
  });

  it('lists in its legend only what the plan has, once each, in the palette order', () => {
    const els = plan(['coffee_station', 'wall', 'restroom', 'coffee_station', 'label', 'service_station']);
    els.push({ ...newElement('bar', 1000, 700, 'wine'), id: 'b' });
    els.push({ ...newElement('area', 1000, 700), id: 'a1', text: 'מרפסת' });
    els.push({ ...newElement('area', 1000, 700), id: 'a2', text: '' });
    const legend = legendEntries(els);
    assert.deepEqual(legend.map((l) => l.name), ['עמדת מלצרים', 'עמדת קפה', 'שירותים', 'בר יין', 'מרפסת']);
    // A kind's variants in their chips' order.
    const doors = [newElement('door', 1000, 700, 'staff'), newElement('door', 1000, 700, 'main'), newElement('door', 1000, 700)];
    assert.deepEqual(legendEntries(doors).map((l) => l.name), ['כניסה', 'כניסה ראשית', 'כניסת עובדים']);
  });

  it('fits the tables and the landmarks, never stretched past 2.5', () => {
    const tables = [{ x: 100, y: 100, width: 80, height: 80 }, { x: 800, y: 500, width: 80, height: 80 }];
    const d = PREVIEW_DEVICES.find((x) => x.key === 'handheld')!;
    const v = fitMapView(tables, 1000, 700, d.width, d.height, d.insetTop, d.insetBottom);
    assert.ok(v.sy <= v.sx * 2.5 + 1e-9 && v.sx <= v.sy * 2.5 + 1e-9);
    // Every table's centre on the screen, between the bars.
    for (const t of tables) {
      const cx = v.ox + (t.x + t.width / 2) * v.sx;
      const cy = v.oy + (t.y + t.height / 2) * v.sy;
      assert.ok(cx >= 0 && cx <= d.width && cy >= d.insetTop && cy <= d.height - d.insetBottom, `${cx},${cy}`);
    }
    // No tables: the whole canvas.
    const whole = fitMapView([], 1000, 700, 1280, 800);
    assert.ok(Math.abs(whole.ox) < 1e-9 && Math.abs(whole.sx - 1.28) < 1e-9);
    // The landmarks' box: restrooms in a corner widen the fit.
    const wc = { ...newElement('restroom', 1000, 700), x: 900, y: 20, w: 80, h: 60 };
    const ext = decorExtent([wc, { ...newElement('wall', 1000, 700) }], 1000, 700)!;
    assert.deepEqual([ext.x, ext.y], [886, 6]);
    assert.ok(Math.abs(ext.x + ext.w - 994) < 1e-9 && Math.abs(ext.y + ext.h - 94) < 1e-9);
    assert.equal(decorExtent([newElement('wall', 1000, 700)], 1000, 700), null);
  });

  it('turns a quarter-turned shape the other axis s stretch, and knows a small screen', () => {
    const view = { sx: 1, sy: 3, ox: 0, oy: 0, tableScale: 1 };
    const wall = { ...newElement('wall', 1000, 700), x: 0, y: 0, w: 100, h: 10, rotation: 90 };
    const drawn = onView(wall, view);
    assert.deepEqual([drawn.w, drawn.h], [300, 10]);
    assert.ok(quarterTurned(90) && quarterTurned(270) && !quarterTurned(0) && !quarterTurned(30) && quarterTurned(45));
    assert.ok(isCompactScreen(360, 640) && isCompactScreen(1080 / 2.625, 2400 / 2.625) && !isCompactScreen(1280, 800));
  });
});
