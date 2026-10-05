/**
 * Run with `npm test`. The chairs round a table (lib/tableSketch.ts) — the till draws the
 * same (domain/TableFloor.kt, ChairLayout; app TableFloorTest).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CHAIR, CHAIR_REACH, chairLayout, chairSides, uniqueElements, type SketchElement } from './tableSketch';

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
