/**
 * The Windows (and browser) kiosk moves as the Android kiosk does: the shared screens' CSS and the
 * resolved transitions against the shared golden (server/tests/fixtures/kiosk_motion_timings.json,
 * the till's KioskTransitions / KioskMotion / KioskEase), and "אפקטים" (`motion.effects`) — the
 * light profile's cheaper variants on this renderer.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  lightenMotion,
  motionSpec,
  profileMotion,
  resolveKioskConfig,
  resolveThemeColors,
  transitionSpec,
  type KioskMotionSettings,
} from '@dash-lib/kioskConfig';
import {
  MOTION_CSS,
  PREVIEW_CSS,
  cardStyle,
  chromeOf,
  chromeRoot,
  itemEnter,
  probeFrames,
  sheetEnter,
  useKioskRenderProfile,
  type PreviewModel,
} from '@kiosk-shared/index';

const gold = JSON.parse(readFileSync(join(__dirname, '..', '..', 'server', 'tests', 'fixtures', 'kiosk_motion_timings.json'), 'utf8'));
const bezier = (c: number[]) => `cubic-bezier(${c.map((n) => String(n).replace(/^0\./, '.')).join(',')})`;
const on = { reduceMotion: false };

describe('the Windows kiosk plays the till\'s motion table', () => {
  it('the curves in the CSS: arrivals, departures, the push as one strip, the pop', () => {
    // Each the default of `--k-ease` (an event's own curve, "מנוע הנפשות"): with none set, exactly the golden one.
    expect(MOTION_CSS).toContain(`.k-anim { animation-duration: var(--k-ms, 220ms); animation-timing-function: var(--k-ease, ${bezier(gold.curves.arrive)});`);
    expect(MOTION_CSS).toContain(`.k-leave.k-anim { animation-fill-mode: forwards; animation-timing-function: var(--k-ease, ${bezier(gold.curves.leave)}); }`);
    expect(MOTION_CSS).toContain(`.k-anim.k-push-in, .k-leave.k-anim.k-push-out { animation-timing-function: var(--k-ease, ${bezier(gold.curves.strip)}); }`);
    expect(MOTION_CSS).toContain(`animation-timing-function: ${bezier(gold.curves.popRise)}; } 60%`);
    expect(MOTION_CSS).toContain(`animation-timing-function: ${bezier(gold.curves.popSettle)}; } 100%`);
    expect(MOTION_CSS).toContain(`.k-item-rise { animation-name: kItemRise; animation-timing-function: var(--k-ease, ${bezier(gold.curves.arrive)}); }`);
    // The event's curve never leaks into what is inside (a screen's into its category's swap or window).
    expect(MOTION_CSS).toContain("@property --k-ease { syntax: '*'; inherits: false; }");
    // Every curve in the transitions' CSS is one of the golden ones.
    const known = new Set(Object.values(gold.curves as Record<string, number[]>).map(bezier));
    for (const c of MOTION_CSS.match(/cubic-bezier\([^)]*\)/g) ?? []) expect(known, c).toContain(c);
  });

  it('every golden example: the windows\' and the cards\' times as the screens set them', () => {
    for (const ex of gold.examples as Array<{ motion: KioskMotionSettings; light?: boolean; animation: 'lively' | 'subtle'; transitions: Record<string, number>; add: Record<string, number> }>) {
      const t = transitionSpec(profileMotion(ex.motion, ex.light ? 'light' : 'full'), on);
      const sheet = sheetEnter(t);
      if (ex.transitions.sheetMs > 0) expect(sheet.style).toEqual({ '--k-ms': `${ex.transitions.sheetMs}ms` });
      else expect(sheet).toEqual({ panel: '', scrim: '', style: {} });
      const card = (i: number) => itemEnter(t, i).style as Record<string, string> | undefined;
      if (ex.transitions.itemMs > 0) {
        expect(card(0)?.['--k-item-ms']).toBe(`${ex.transitions.itemMs}ms`);
        for (let i = 0; i < 12; i++) {
          expect(card(i)?.['--k-delay']).toBe(`${Math.min(i * ex.transitions.staggerMs, ex.transitions.staggerCapMs)}ms`);
        }
      } else {
        expect(itemEnter(t, 0)).toEqual({});
      }
      expect([t.screenMs, t.categoryMs]).toEqual([ex.transitions.screenMs, ex.transitions.categoryMs]);
      const m = motionSpec({ animation: ex.animation }, on, profileMotion(ex.motion, ex.light ? 'light' : 'full'));
      expect({ popMs: m.popMs, flyMs: m.flyMs, countUpMs: m.countUpMs }).toEqual(ex.add);
    }
  });
});

describe('"אפקטים" on the Windows / browser kiosk', () => {
  const model = (style: string, light: boolean, cardStyleName?: string): PreviewModel => {
    const cfg = resolveKioskConfig({ theme: { uiStyle: style, ...(cardStyleName ? { cardStyle: cardStyleName } : {}) } });
    return { cfg, c: resolveThemeColors(cfg.theme), radius: cfg.theme.cornerRadius, light } as unknown as PreviewModel;
  };

  it('light: the root drops every shadow and blur, cards get a hairline edge, tech no glow or scan line', () => {
    expect(chromeRoot(model('wolt', true)).className).toBe('k-light');
    expect(chromeRoot(model('tech', true)).className).toBe('k-press k-light');
    expect(chromeRoot(model('wolt', false)).className).toBe('');
    expect(PREVIEW_CSS).toContain('.k-light [class*="shadow"], .k-light .k-fly { box-shadow: none !important; }');
    expect(PREVIEW_CSS).toContain('.k-light [class*="backdrop-blur"] { backdrop-filter: none !important;');
    const full = cardStyle(model('wolt', false));
    const light = cardStyle(model('wolt', true));
    expect(full.boxShadow).toBeTruthy();
    expect(light.boxShadow).toBeUndefined();
    expect(String(light.border)).toMatch(/^1px solid #/);
    expect(chromeOf(model('tech', true)).scanMs).toBe(0);
    expect(chromeOf(model('tech', true)).addGlowMs).toBe(0);
    expect(chromeOf(model('tech', false)).scanMs).toBeGreaterThan(0);
  });

  it('light transitions: fades at the fast pace, no cascade', () => {
    const t = transitionSpec(lightenMotion(resolveKioskConfig().motion), on);
    expect([t.categorySwitch, t.screenChange, t.sheet, t.itemsEnter]).toEqual(['fade', 'fade', 'fade', 'none']);
    expect([t.categoryMs, t.screenMs, t.sheetMs, t.itemMs]).toEqual([150, 135, 135, 0]);
  });

  it('the probe is cheap and safe: nothing without a window; the hook is a plain function of the config', () => {
    const cancel = probeFrames(() => {
      throw new Error('never called without requestAnimationFrame');
    });
    expect(typeof cancel).toBe('function');
    cancel();
    expect(typeof useKioskRenderProfile).toBe('function');
  });
});
