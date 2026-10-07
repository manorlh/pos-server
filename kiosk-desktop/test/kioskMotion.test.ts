/**
 * "הנפשות ומעברים" on the Windows kiosk: the shared screens' transitions (client
 * components/dashboard/kiosks/preview-motion.tsx) — compositor-only, the cards' stagger capped,
 * the config's choices reaching the kiosk even from an older cloud that never sent them.
 */
import { describe, expect, it } from 'vitest';
import { KIOSK_UI_PRESET_MOTION, STAGGER_CAP_MS, resolveKioskConfig, transitionSpec } from '@dash-lib/kioskConfig';
import { MOTION_CSS, itemEnter, screenOrder, sheetEnter } from '@kiosk-shared/index';

const on = { reduceMotion: false };

describe('the transitions on the Windows kiosk', () => {
  it('a config with no motion (an older cloud) still animates as its style says', () => {
    for (const style of ['ios', 'wolt', 'classic', 'minimal_dark', 'tech'] as const) {
      const cfg = resolveKioskConfig({ theme: { uiStyle: style } });
      expect(cfg.motion).toEqual({ ...KIOSK_UI_PRESET_MOTION[style], effects: 'auto' });
      const t = transitionSpec(cfg.motion, cfg.general);
      expect(t.categoryMs).toBeGreaterThan(0);
      expect(['pop', 'cascade']).toContain(t.itemsEnter);
    }
  });

  it('cards come in staggered within the cap, only about two screenfuls of them', () => {
    const t = transitionSpec({ itemsEnter: 'cascade' }, on);
    expect(itemEnter(t, 0).className).toBe('k-item k-item-cascade');
    const delay = (i: number) => parseInt(String((itemEnter(t, i).style as Record<string, string>)['--k-delay']), 10);
    expect(delay(0)).toBe(0);
    expect(delay(1)).toBeGreaterThan(0);
    for (let i = 0; i < 24; i++) expect(delay(i)).toBeLessThanOrEqual(STAGGER_CAP_MS);
    expect(itemEnter(t, 40)).toEqual({});
    expect(itemEnter(t, 0, false)).toEqual({});
    expect(itemEnter(transitionSpec({ itemsEnter: 'none' }, on), 0)).toEqual({});
    expect(itemEnter(transitionSpec({ itemsEnter: 'pop' }, { reduceMotion: true }), 0)).toEqual({});
  });

  it('windows: their class and time, nothing with "none" or reduce motion', () => {
    expect(sheetEnter(transitionSpec({ sheet: 'scale' }, on)).panel).toBe('k-anim k-sheet-scale');
    expect(sheetEnter(transitionSpec({ sheet: 'slide_up', speed: 'fast' }, on)).style).toEqual({ '--k-ms': '195ms' });
    expect(sheetEnter(transitionSpec({ sheet: 'none' }, on))).toEqual({ panel: '', scrim: '', style: {} });
    expect(sheetEnter(transitionSpec({ sheet: 'fade' }, { reduceMotion: true })).panel).toBe('');
  });

  it('the screens in the order of an order (a later one comes the way the customer reads)', () => {
    const order = ['attract', 'service', 'catalog', 'cart', 'details', 'pay', 'success'].map(screenOrder);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(screenOrder('paused')).toBeGreaterThan(screenOrder('success'));
    expect(screenOrder('closed')).toBe(screenOrder('setup'));
  });

  it('every keyframe moves only transform and opacity (the compositor, never a layout)', () => {
    const frames = [...MOTION_CSS.matchAll(/@keyframes\s+(\w+)\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)];
    expect(frames.length).toBeGreaterThan(10);
    for (const [, name, body] of frames) {
      const props = [...body.matchAll(/([a-z-]+)\s*:/g)].map((x) => x[1]);
      expect(props.length, name).toBeGreaterThan(0);
      for (const p of props) expect(['opacity', 'transform', 'animation-timing-function'], `${name}: ${p}`).toContain(p);
    }
    // Reduce motion (the root's class, the device's setting) hides the leaving copy and stops them all.
    expect(MOTION_CSS).toContain('.k-reduce .k-leave { display: none; }');
    expect(MOTION_CSS).toMatch(/prefers-reduced-motion: reduce\)[\s\S]*\.k-item[\s\S]*animation: none !important/);
  });
});
