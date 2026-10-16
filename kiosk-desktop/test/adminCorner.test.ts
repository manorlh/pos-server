/**
 * "ניהול הקיוסק" — the manager's corner on every screen of the Windows app (core/adminCorner.ts, the Android app's
 * KioskAdminCorner + KioskHoldTracker; renderer/staff/adminHold.tsx is its React door). The owner (16.10.2026): "תוסיף
 * אופציה בלחיצה למעלה בצד ימין להיכנס להגדרות כמו באנדרואיד ולעבוד" — on the kiosk's screens, "התשלום אינו זמין" (no
 * terminal / no internet), the screens around the kiosk and the till; never during a payment. The pad then asks for a
 * MANAGER's code, checked on the device against the cached roster — offline too (test/adminCornerService.test.ts).
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BOUNCE_MS, CLAIM_MS, CornerHold, HOLD_MS, HoldTracker, SIDE_DP, TICK_MS, adminCornerArmed, inAdminCorner, kioskCornerArmed } from '../src/core/adminCorner';
import { AdminHoldBar } from '../src/renderer/staff/adminHold';

const W = 1080;

describe('the corner — the Android KioskAdminCorner, square for square', () => {
  it('the same constants: 96 dp, the claim at 1.2 s, two seconds, a 250 ms flicker forgiven', () => {
    expect(SIDE_DP).toBe(96);
    expect(CLAIM_MS).toBe(1_200);
    expect(HOLD_MS).toBe(2_000);
    expect(BOUNCE_MS).toBe(250);
  });

  it('top-start: the top right in Hebrew, the top left left-to-right (KioskServiceMenuTest)', () => {
    expect(inAdminCorner(true, W - 10, 10, W)).toBe(true);
    expect(inAdminCorner(true, W - 90, 90, W)).toBe(true);
    expect(inAdminCorner(true, 10, 10, W)).toBe(false);
    expect(inAdminCorner(false, 10, 10, W)).toBe(true);
    expect(inAdminCorner(false, 10, 120, W)).toBe(false);
    // Just outside the square, either way.
    expect(inAdminCorner(true, W - 97, 10, W)).toBe(false);
    expect(inAdminCorner(true, W - 10, 97, W)).toBe(false);
  });
});

describe('the hold, step by step (KioskFooterHoldTest’s rules with the corner’s claim)', () => {
  it('a quick tap — and a slow one, under the claim — is the screen’s: nothing taken, nothing fired', () => {
    const t = new HoldTracker();
    expect(t.step(0, true, true, true)).toEqual({ fire: false, consume: false, progress: null });
    expect(t.step(300, false, false, false)).toEqual({ fire: false, consume: false, progress: null });
    expect(t.active).toBe(false);
    expect(t.step(1_000, true, true, true).consume).toBe(false);
    expect(t.step(2_100, true, false, true).consume).toBe(false);
    expect(t.step(2_150, false, false, false)).toEqual({ fire: false, consume: false, progress: null });
  });

  it('held: claimed at 1.2 s (the bar fills from there), fired once at 2 s, the rest of the touch drained', () => {
    const t = new HoldTracker();
    t.step(0, true, true, true);
    expect(t.step(1_100, true, false, true).consume).toBe(false);
    const claim = t.step(1_200, true, false, true);
    expect(claim).toEqual({ fire: false, consume: true, progress: 0.6 });
    expect(t.phase).toBe('claimed');
    expect(t.step(2_000, true, false, true)).toEqual({ fire: true, consume: true, progress: null });
    expect(t.step(2_500, true, false, true)).toEqual({ fire: false, consume: true, progress: null });
    expect(t.step(2_600, false, false, false).consume).toBe(true);
    expect(t.active).toBe(false);
  });

  it('a touch frame’s flicker after the claim is the same hold; a longer lift ends it', () => {
    const t = new HoldTracker();
    t.step(0, true, true, true);
    t.step(1_300, true, false, true);
    // Lifted for 200 ms, back in the corner: the same hold.
    expect(t.step(1_400, false, false, false).consume).toBe(true);
    expect(t.step(1_600, true, false, true).consume).toBe(true);
    expect(t.step(2_000, true, false, true).fire).toBe(true);
    const u = new HoldTracker();
    u.step(0, true, true, true);
    u.step(1_300, true, false, true);
    u.step(1_400, false, false, false);
    expect(u.step(1_400 + BOUNCE_MS + 1, false, false, false)).toEqual({ fire: false, consume: true, progress: null });
    expect(u.active).toBe(false);
  });

  it('moved out before the claim: the screen’s drag; after it: no pad, and still nothing for the screen', () => {
    const t = new HoldTracker();
    t.step(0, true, true, true);
    expect(t.step(500, false, false, true)).toEqual({ fire: false, consume: false, progress: null });
    expect(t.active).toBe(false);
    const u = new HoldTracker();
    u.step(0, true, true, true);
    u.step(1_300, true, false, true);
    expect(u.step(1_500, false, false, true)).toEqual({ fire: false, consume: true, progress: null });
    expect(u.step(2_100, false, false, true).fire).toBe(false);
    expect(u.step(2_200, false, false, false).consume).toBe(true);
    expect(u.active).toBe(false);
  });
});

/** A screen with the corner: its clock, its width, whether it is armed, what it opened. */
function screen(armed: () => boolean, rtl = true) {
  let now = 0;
  const opened: number[] = [];
  const bar: Array<number | null> = [];
  const hold = new CornerHold({ armed, rtl: () => rtl, width: () => W, now: () => now, onOpen: () => opened.push(now), onProgress: (p) => bar.push(p) });
  return {
    hold,
    opened,
    bar,
    at: (ms: number) => {
      now = ms;
    },
    /** A finger held at (x, y) for `ms`, ticked as the React door ticks it, then lifted; then the click the release makes. */
    press(x: number, y: number, ms: number): { consumed: boolean[]; clickSwallowed: boolean } {
      const start = now;
      const consumed = [hold.down(1, x, y)];
      for (let t = start + TICK_MS; t <= start + ms; t += TICK_MS) {
        now = t;
        hold.tick();
      }
      now = start + ms;
      consumed.push(hold.up(1));
      return { consumed, clickSwallowed: hold.click() };
    },
  };
}

describe('the corner on the screens of the Windows app', () => {
  /** The kiosk's screens as the kiosk arms it (KioskApp: kioskCornerArmed over its flow). */
  const kioskScreen = (name: string, busy = false, staffOpen = false) => screen(() => kioskCornerArmed({ screen: name, busy, staffOpen }));

  it('"התשלום אינו זמין" — no terminal, and offline: two seconds in the top right open the manager’s pad, once', () => {
    // One screen, two reasons (KioskApp's PausedScreen variant by view.state.noPaymentReason): the corner is the same.
    for (const [, blocked] of [['no terminal', 'no_payment'], ['offline', 'no_payment']]) {
      const s = kioskScreen(blocked);
      const r = s.press(W - 30, 30, 2_300);
      expect(s.opened).toHaveLength(1);
      // The release and its click are the corner's: nothing on the blocked screen is tapped.
      expect(r.consumed.at(-1)).toBe(true);
      expect(r.clickSwallowed).toBe(true);
      // The bar filled on the way.
      expect(s.bar.some((p) => p !== null && p > 0.5)).toBe(true);
      expect(s.bar.at(-1)).toBeNull();
    }
  });

  it('every resting and ordering screen: attract, the menu, the basket, closed, paused, the setup note, the shop’s lock', () => {
    for (const name of ['attract', 'catalog', 'cart', 'confirm', 'details', 'closed', 'paused', 'setup', 'service', 'shop_locked']) {
      const s = kioskScreen(name);
      s.press(W - 5, 5, 2_000);
      expect(s.opened, name).toHaveLength(1);
    }
  });

  it('never during a payment: the pay screen, a customer’s payment held, or with the staff’s own pad already up', () => {
    for (const s of [kioskScreen('pay'), kioskScreen('success', true), kioskScreen('attract', false, true)]) {
      const r = s.press(W - 30, 30, 3_000);
      expect(s.opened).toHaveLength(0);
      expect(r.consumed.every((c) => c === false)).toBe(true);
      expect(r.clickSwallowed).toBe(false);
    }
  });

  it('a tap on what is drawn in the corner (the header’s back arrow) is still the screen’s — quick or slow', () => {
    const s = kioskScreen('catalog');
    expect(s.press(W - 30, 30, 150)).toEqual({ consumed: [false, false], clickSwallowed: false });
    s.at(10_000);
    expect(s.press(W - 30, 30, 1_000)).toEqual({ consumed: [false, false], clickSwallowed: false });
    expect(s.opened).toHaveLength(0);
  });

  it('the top LEFT in Hebrew is the technician’s corner (six taps), never the manager’s; elsewhere nothing', () => {
    const s = kioskScreen('no_payment');
    s.press(30, 30, 2_500);
    s.at(20_000);
    s.press(W / 2, 900, 2_500);
    expect(s.opened).toHaveLength(0);
  });

  it('the screens around the kiosk and the till arm it the same way (adminCornerArmed): not while paying, not over a menu', () => {
    expect(adminCornerArmed({ paying: false, staffUp: false })).toBe(true);
    expect(adminCornerArmed({ paying: true, staffUp: false })).toBe(false);
    expect(adminCornerArmed({ paying: false, staffUp: true })).toBe(false);
    // "waiting" (no config yet — offline at the first start), pairing, the KDS, the till between sales: armed.
    const waiting = screen(() => adminCornerArmed({ paying: false, staffUp: false }));
    waiting.press(W - 40, 40, 2_100);
    expect(waiting.opened).toHaveLength(1);
    // The till taking a card: not.
    const paying = screen(() => adminCornerArmed({ paying: true, staffUp: false }));
    paying.press(W - 40, 40, 2_100);
    expect(paying.opened).toHaveLength(0);
  });

  it('a payment that starts under the finger disarms it: the hold ends without the pad', () => {
    let paying = false;
    const s = screen(() => kioskCornerArmed({ screen: paying ? 'pay' : 'cart', busy: false, staffOpen: false }));
    s.hold.down(1, W - 20, 20);
    s.at(1_300);
    s.hold.tick();
    paying = true;
    for (let t = 1_400; t <= 2_500; t += TICK_MS) {
      s.at(t);
      s.hold.tick();
    }
    s.hold.up(1);
    expect(s.opened).toHaveLength(0);
  });

  it('the bar: drawn only while a hold fills it, at the top right in Hebrew', () => {
    expect(renderToStaticMarkup(createElement(AdminHoldBar, { progress: null, rtl: true }))).toBe('');
    const html = renderToStaticMarkup(createElement(AdminHoldBar, { progress: 0.6, rtl: true }));
    expect(html).toContain('data-admin-hold');
    expect(html).toContain('right:8px');
    expect(html).toContain('width:60%');
  });
});
