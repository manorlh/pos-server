/**
 * "טכנולוגי" on the Windows and browser kiosks: the shared screens' chrome (client
 * components/dashboard/kiosks/preview-screens.tsx) — the grid backdrop, the status line, the
 * scan line, the add-to-cart glow and the press — drawn from the style's tokens (kioskChrome),
 * and nothing at all for the other styles.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UI_STYLES, resolveKioskConfig, resolveThemeColors, type UiStyle } from '@dash-lib/kioskConfig';
import {
  AddGlow,
  KioskBackdrop,
  KioskScanLine,
  KioskStatusBar,
  PREVIEW_CSS,
  chromeRoot,
  statusLinePx,
  type PreviewModel,
} from '@kiosk-shared/index';

const WORDS: Record<string, string> = {
  'status.ready': 'מוכן לקבל הזמנה',
  'status.ordering': 'הזמנה בתהליך',
  'status.done': 'ההזמנה התקבלה',
  'status.paused': 'מושהה זמנית',
  'status.order': 'הזמנה',
};

/** The bits of the model the chrome reads. */
function model(style: UiStyle, extra: Record<string, unknown> = {}, general: Record<string, unknown> = {}): PreviewModel {
  const cfg = resolveKioskConfig({ theme: { uiStyle: style, ...(extra.theme as object) }, general });
  return {
    cfg,
    c: resolveThemeColors(cfg.theme),
    t: (key: string) => WORDS[key] ?? key,
    nowMs: new Date(2026, 9, 7, 14, 7).getTime(),
    cartBump: 3,
    screen: { w: 1080, h: 1920 },
    ...extra,
  } as unknown as PreviewModel;
}

const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);

describe('the tech style\'s chrome on the Windows / browser kiosk', () => {
  it('a 1 px grid behind the screens, a status line with the state, the order and the time', () => {
    const m = model('tech');
    const grid = html(createElement(KioskBackdrop, { m }));
    expect(grid).toContain('linear-gradient(to right, #E6EDF30F 1px, transparent 1px)');
    expect(grid).toContain('background-size:32px 32px');
    const bar = html(createElement(KioskStatusBar, { m, screen: 'attract' }));
    expect(bar).toContain('מוכן לקבל הזמנה');
    expect(bar).toContain('14:07');
    expect(bar).toContain('data-status="ready"');
    expect(bar).toContain('height:28px');
    const done = html(createElement(KioskStatusBar, { m, screen: 'success', pickup: 'A-42' }));
    expect(done).toContain('ההזמנה התקבלה');
    expect(done).toContain('A-42');
    expect(done).toContain('monospace');
    // Paused: the amber dot.
    expect(html(createElement(KioskStatusBar, { m, screen: 'paused' }))).toContain('#F5A524');
  });

  it('the type scale makes the status line taller; tabular figures and the press on the root', () => {
    expect(statusLinePx(model('tech'))).toBe(28);
    expect(statusLinePx(model('tech', { theme: { typeScale: 'xlarge' } }))).toBe(35);
    const root = chromeRoot(model('tech'));
    expect(root.className).toBe('k-press');
    expect(root.style).toEqual({ fontVariantNumeric: 'tabular-nums', '--k-press': '0.98' });
  });

  it('the scan line and the glow move on the compositor, and never with reduce motion', () => {
    const m = model('tech');
    expect(html(createElement(KioskScanLine, { m }))).toContain('class="k-scan"');
    expect(html(createElement(AddGlow, { m, radius: 6 }))).toContain('class="k-add-glow"');
    const still = model('tech', {}, { reduceMotion: true });
    expect(html(createElement(KioskScanLine, { m: still }))).toBe('');
    expect(html(createElement(AddGlow, { m: still, radius: 6 }))).toBe('');
    expect(PREVIEW_CSS).toContain('@keyframes kScan');
    expect(PREVIEW_CSS).toMatch(/\.k-reduce \.k-scan, \.k-reduce \.k-add-glow \{ display: none; \}/);
    expect(PREVIEW_CSS).toMatch(/prefers-reduced-motion: reduce\) \{ \.k-scan, \.k-add-glow/);
  });

  it('every other style: no chrome drawn, the root as before', () => {
    for (const style of UI_STYLES.filter((s) => s !== 'tech')) {
      const m = model(style);
      expect(html(createElement(KioskBackdrop, { m })), style).toBe('');
      expect(html(createElement(KioskStatusBar, { m, screen: 'attract' })), style).toBe('');
      expect(html(createElement(KioskScanLine, { m })), style).toBe('');
      expect(html(createElement(AddGlow, { m, radius: 6 })), style).toBe('');
      expect(statusLinePx(m), style).toBe(0);
      expect(chromeRoot(m), style).toEqual({ className: '', style: {} });
    }
  });
});
