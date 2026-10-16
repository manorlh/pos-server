/**
 * "גודל תצוגה" (P:/specs/display-scale.md): the parsing and the precedence (local > till > point of sale > shop >
 * company > auto) against the shared golden display_scale_golden.json — the same bytes in pos-server
 * server/tests/fixtures and the Android test resources — and the window's zoom it gives.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DISPLAY_SCALE_LEVELS,
  DISPLAY_SCALE_MAX,
  DISPLAY_SCALE_MIN,
  DISPLAY_SCALE_MIN_READ,
  DISPLAY_SCALE_STEP,
  deviceDisplayScale,
  displayScaleWire,
  effectiveDisplayScale,
  legacyZoomOf,
  parseDisplayScale,
  steppedDisplayScale,
  windowZoomPlan,
} from '../src/core/displayScale';

const GOLDEN_SHA256 = 'c9e7826aa22b595809b8814c37544d80394011e4bc52c7aa48c165a295ad6a38';
const text = readFileSync(path.join(__dirname, 'fixtures', 'display_scale_golden.json'), 'utf8').replace(/\r\n/g, '\n');
const golden = JSON.parse(text) as {
  options: string[];
  default: string;
  minPercent: number;
  maxPercent: number;
  step: number;
  minRead: number;
  levels: string[];
  parse: { in: unknown; out: 'auto' | number | null }[];
  effective: { name: string; levels: Record<string, unknown>; local: unknown; out: Record<string, unknown> }[];
};

describe('the shared golden fixture', () => {
  it('is pinned by its bytes', () => {
    expect(createHash('sha256').update(text, 'utf8').digest('hex')).toBe(GOLDEN_SHA256);
  });

  it('has this rule’s range, levels and options', () => {
    expect([golden.minPercent, golden.maxPercent, golden.step, golden.minRead]).toEqual([
      DISPLAY_SCALE_MIN,
      DISPLAY_SCALE_MAX,
      DISPLAY_SCALE_STEP,
      DISPLAY_SCALE_MIN_READ,
    ]);
    expect(golden.levels).toEqual([...DISPLAY_SCALE_LEVELS]);
    expect(golden.default).toBe('auto');
    for (const option of golden.options) expect(displayScaleWire(parseDisplayScale(option)!)).toBe(option);
  });

  it.each(golden.parse.map((c) => [JSON.stringify(c.in), c] as const))('parse %s', (_name, c) => {
    expect(parseDisplayScale(c.in)).toEqual(c.out);
  });

  it.each(golden.effective.map((c) => [c.name, c] as const))('effective: %s', (_name, c) => {
    expect(effectiveDisplayScale(c.levels, c.local)).toEqual(c.out);
  });
});

describe('on the device', () => {
  it('puts the cloud’s resolved value under the local choice', () => {
    expect(deviceDisplayScale(undefined, undefined)).toMatchObject({ percent: 100, source: 'auto' });
    expect(deviceDisplayScale('120', null)).toMatchObject({ percent: 120, source: 'cloud' });
    expect(deviceDisplayScale('120', 'auto')).toMatchObject({ percent: 100, source: 'local', setting: 'auto' });
    expect(deviceDisplayScale('120', '90')).toMatchObject({ percent: 90, source: 'local' });
  });

  it('steps by 5 within 70–150', () => {
    expect(steppedDisplayScale(100, true)).toBe(105);
    expect(steppedDisplayScale(100, false)).toBe(95);
    expect(steppedDisplayScale(150, true)).toBe(150);
    expect(steppedDisplayScale(70, false)).toBe(70);
  });
});

describe('the window’s zoom', () => {
  it('is the automatic zoom when nothing is set', () => {
    expect(windowZoomPlan(2, undefined, undefined)).toMatchObject({ zoom: 2, autoZoom: 2, legacyZoom: null });
  });

  it('multiplies the automatic zoom by the cloud’s percent, and by the local one over it', () => {
    expect(windowZoomPlan(2, '120', undefined).zoom).toBeCloseTo(2.4, 9);
    expect(windowZoomPlan(2, '120', '80').zoom).toBeCloseTo(1.6, 9);
    expect(windowZoomPlan(2, '120', 'auto').zoom).toBe(2);
  });

  it('keeps an old absolute "זום" until a new choice is saved over it', () => {
    const old = windowZoomPlan(2, '120', undefined, 1.5);
    expect(old.zoom).toBe(1.5);
    expect(old.legacyZoom).toBe(1.5);
    expect(old.effective).toMatchObject({ source: 'local', percent: 75 });
    // A new local choice wins over it.
    const fresh = windowZoomPlan(2, '120', '110', 1.5);
    expect(fresh.zoom).toBeCloseTo(2.2, 9);
    expect(fresh.legacyZoom).toBeNull();
    // An old zoom out of its range was never applied.
    expect(legacyZoomOf(5)).toBeNull();
    expect(legacyZoomOf(0.4)).toBeNull();
    expect(windowZoomPlan(2, undefined, undefined, 5).zoom).toBe(2);
  });
});
