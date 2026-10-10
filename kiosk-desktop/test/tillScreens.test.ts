/**
 * S0-2: the till's screens, rendered to markup (react-dom/server — no DOM needed): demo mode said
 * on the screen, the card greyed with its reason when there is no terminal, the role switch absent
 * when nothing is allowed (owner's rule), the Z greyed with the engine's reason.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { initialState } from '../src/shared/till/mockEngine';
import type { TillState } from '../src/shared/till/protocol';
import { browserEnv, capabilityTiles, NO_CAPS } from '../src/renderer/host/caps';
import { createBrowserHost } from '../src/renderer/host/browser/browserHost';
import { browserFacts, displayProfile } from '../src/renderer/roles/till/layout/displayProfileAdapter';
import { tillLayout } from '../src/renderer/roles/till/layout/tillLayout';
import { CheckoutScreen } from '../src/renderer/roles/till/screens/CheckoutScreen';
import { ShiftScreen } from '../src/renderer/roles/till/screens/ShiftScreen';
import { SellScreen, filterProducts } from '../src/renderer/roles/till/screens/SellScreen';
import { TillApp } from '../src/renderer/roles/till/TillApp';
import { demoCatalog } from '../src/shared/till/catalogDemo';

const profile = displayProfile(browserFacts(1280, 800, 1));
const layout = tillLayout(profile);
const state = (over: Partial<TillState> = {}): TillState => ({
  ...initialState({ role: 'till', rolesAllowed: [], terminal: false, printer: false, catalogVersion: 1, nowIso: '2026-10-09T12:00:00.000Z' }),
  ...over,
});
const noop = () => undefined;

describe('the till app', () => {
  it('opens on the sell screen in demo mode, says so, RTL, lite when asked', () => {
    const host = createBrowserHost({ engine: { kind: 'demo' }, env: browserEnv({}, {}), lite: true });
    const html = renderToStaticMarkup(createElement(TillApp, { host, initialProfile: profile }));
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('data-lite="1"');
    expect(html).toContain('data-layout="TABLET"');
    expect(html).toContain('מצב הדגמה');
    expect(html).toContain('הסל ריק');
    expect(html).toContain('קופאי הדגמה');
    host.dispose();
  });
});

describe('the sell screen', () => {
  it('lays products and cart side by side on a tablet, filters by department and search', () => {
    const catalog = demoCatalog();
    expect(filterProducts(catalog, 'hot', '').every((p) => p.departmentId === 'hot')).toBe(true);
    expect(filterProducts(catalog, null, 'קרואסון').map((p) => p.name)).toEqual(['קרואסון חמאה', 'קרואסון שקדים']);
    const html = renderToStaticMarkup(
      createElement(SellScreen, { state: state(), catalog, layout, onAdd: noop, onDepartment: noop, onSearch: noop, cart: { setQty: noop, discount: noop, remove: noop, clear: noop, pay: noop } }),
    );
    expect(html).toContain('t-sell-side');
    expect(html).toContain(`${layout.cartWidthDp}px`);
    expect(html).toContain('אספרסו');
    expect(html).toContain('שתייה חמה');
  });

  it('a phone: the cart behind the bar', () => {
    const phone = tillLayout(displayProfile(browserFacts(390, 844, 3)));
    const html = renderToStaticMarkup(
      createElement(SellScreen, { state: state(), catalog: demoCatalog(), layout: phone, onAdd: noop, onDepartment: noop, onSearch: noop, cart: { setQty: noop, discount: noop, remove: noop, clear: noop, pay: noop } }),
    );
    expect(html).toContain('t-cart-bar');
    expect(html).not.toContain('t-sell-side');
  });

  it('a long catalogue: only the rows on screen are in the DOM', () => {
    const big = demoCatalog(250);
    const html = renderToStaticMarkup(
      createElement(SellScreen, { state: state(), catalog: big, layout, onAdd: noop, onDepartment: noop, onSearch: noop, cart: { setQty: noop, discount: noop, remove: noop, clear: noop, pay: noop } }),
    );
    const tiles = html.match(/class="t-tile"/g) ?? [];
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.length).toBeLessThan(120);
  });
});

describe('the payment screen', () => {
  const tender = { phase: 'tender' as const, totalAgorot: 1290, paidAgorot: 0, dueAgorot: 1290, changeAgorot: 0, legs: [], documentRef: null };
  const actions = { cash: noop, card: noop, cancel: noop, finish: noop, print: noop, copy: noop, recheck: noop, markNotApproved: noop };

  it('greys the card with the reason when the host has no terminal', () => {
    const cardTile = capabilityTiles(NO_CAPS, 'browser').find((t) => t.id === 'card')!;
    const html = renderToStaticMarkup(createElement(CheckoutScreen, { checkout: tender, layout, cardTile, demo: false, actions }));
    expect(html).toContain('מזומן מהיר');
    expect(html).toContain('₪12.90');
    expect(html).toContain('t-tender-off');
    expect(html).toContain(cardTile.reason);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="[^"]*"[^>]*>/);
  });

  it('done: the change and the demo document said as such', () => {
    const cardTile = capabilityTiles(NO_CAPS, 'browser').find((t) => t.id === 'card')!;
    const html = renderToStaticMarkup(createElement(CheckoutScreen, { checkout: { ...tender, phase: 'done', paidAgorot: 2000, changeAgorot: 710, documentRef: 'הדגמה-1' }, layout, cardTile, demo: true, actions }));
    expect(html).toContain('₪7.10');
    expect(html).toContain('הדגמה-1');
    expect(html).toContain('לא מסמך אמיתי');
  });
});

describe('the shift screen', () => {
  const actions = { open: noop, close: noop, x: async () => undefined, z: noop, switchTo: noop, back: noop };

  it('no role switch when nothing is allowed; the Z greyed with the engine\'s reason', () => {
    const html = renderToStaticMarkup(createElement(ShiftScreen, { state: state(), layout, actions }));
    expect(html).not.toContain('מעבר ל');
    expect(html).toContain('Z לא מופק במצב הדגמה');
    expect(html).toContain('סגירת משמרת');
  });

  it('only the allowed roles, never the current one', () => {
    const s = state({ mode: { role: 'till', current: 'till', rolesAllowed: ['till', 'kiosk'] } });
    const html = renderToStaticMarkup(createElement(ShiftScreen, { state: s, layout, actions }));
    expect(html).toContain('מעבר לקיוסק');
    expect(html).not.toContain('מעבר לקופה');
  });
});
