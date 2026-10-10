/**
 * Run with `npm test`. The chairs round a table (lib/tableSketch.ts) — the till draws the
 * same (domain/TableFloor.kt, ChairLayout; app TableFloorTest).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  CHAIR,
  CHAIR_REACH,
  SKETCH_BACKGROUNDS,
  SKETCH_KINDS,
  SKETCH_SCHEMA,
  SKETCH_STRUCTURE_KINDS,
  SKETCH_SYMBOL_KINDS,
  SKETCH_VARIANTS,
  backgroundOf,
  chairLayout,
  chairSides,
  counterGeometry,
  defaultText,
  newElement,
  styleOf,
  templateSketch,
  uniqueElements,
  variantOf,
  type Sketch,
  type SketchElement,
} from './tableSketch';

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
  it('offers the symbols first and the room itself after, every kind once', () => {
    assert.deepEqual(SKETCH_SYMBOL_KINDS, [
      'restroom', 'door', 'exit', 'counter', 'dj_booth', 'plant', 'kitchen', 'stairs', 'cashier', 'label',
    ]);
    assert.ok(SKETCH_STRUCTURE_KINDS.includes('wall'));
    assert.equal(new Set(SKETCH_KINDS).size, SKETCH_KINDS.length);
    assert.equal(SKETCH_KINDS.length, SKETCH_SYMBOL_KINDS.length + SKETCH_STRUCTURE_KINDS.length);
    assert.equal(SKETCH_SCHEMA, 2);
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
    assert.deepEqual(Object.keys(SKETCH_VARIANTS).sort(), ['counter', 'exit', 'restroom']);
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
    const elements = golden.zones[0].sketch.elements;
    assert.equal(elements.length, 19);
    for (const el of elements) {
      assert.ok(SKETCH_KINDS.includes(el.kind), el.kind);
      if (el.variant != null) assert.equal(variantOf(el.kind, el.variant), el.variant, `${el.id} ${el.variant}`);
    }
    const kinds = new Set(elements.map((e) => e.kind));
    for (const k of SKETCH_SYMBOL_KINDS) assert.ok(kinds.has(k), k);
  });
});
