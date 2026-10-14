/**
 * Run with `npm test`. "קיוסק: לחיצה על פריט מוסיפה לסל, ותג כמות על הפריט"
 * (P:/specs/kiosk-tap-add-count-badge.md): `layout.cartCountBadge` — on by default in every template,
 * per level, validated — the badge's count (every variant of a dish), and "הוספה מהירה" unchanged by
 * default. The shared layouts' sources (read as text: this runner does not compile React) draw the
 * badge on every dish card of every template and nowhere a count of their own.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveKioskConfig, validateKioskConfig, type KioskConfig } from './kioskConfig';
import {
  KIOSK_LAYOUT_DEFAULTS,
  KIOSK_LAYOUT_TEMPLATES,
  LAYOUT_TEMPLATES_READY,
  LAYOUT_TEMPLATE_KEYS,
  cartCountBadgeOn,
  catalogKindOf,
  dishBadgeCount,
  dishBadgeText,
  dishCartCounts,
  layoutOf,
  tapPathOf,
  validateLayout,
  type LayoutCatalog,
} from './kioskLayout';

const src = (p: string) => readFileSync(join(process.cwd(), 'src', p), 'utf8');

/** A basket line as the screens hold it (only what the count reads). */
const line = (id: string, qty: number, options: string[] = []) => ({ product: { id }, qty, options });

describe('the count of a dish in the basket', () => {
  it('counts every line of the dish, whatever its options (its variants)', () => {
    const counts = dishCartCounts([line('cola', 1), line('cola', 2, ['ice']), line('burger', 1), line('cola', 1, ['lemon'])]);
    assert.deepEqual(counts, { cola: 4, burger: 1 });
  });

  it('is empty for an empty basket and never counts a line with no quantity', () => {
    assert.deepEqual(dishCartCounts([]), {});
    assert.deepEqual(dishCartCounts([line('cola', 0), line('cola', -1), line('fries', 1)]), { fries: 1 });
  });

  it('shows the count when the badge is on, nothing when it is off or none is in the basket', () => {
    const on = resolveKioskConfig({});
    const off = resolveKioskConfig({ layout: { cartCountBadge: false } });
    assert.equal(dishBadgeCount(on, 2), 2);
    assert.equal(dishBadgeCount(on, 0), null);
    assert.equal(dishBadgeCount(off, 2), null);
    assert.equal(dishBadgeText(7), '7');
    assert.equal(dishBadgeText(99), '99');
    assert.equal(dishBadgeText(120), '99+');
  });

  it('the spec\'s check: quick add "when nothing is required" — a tap on a cola puts it in, twice shows 2, off hides it', () => {
    const cfg = resolveKioskConfig({ layout: { quickAdd: 'no_required' } });
    const cola = { addPath: 'direct' as const };
    // A tap on the card (not its "+") adds it.
    assert.equal(tapPathOf(cola, layoutOf(cfg).quickAdd, false, false), 'direct');
    const basket = [line('cola', 1), line('cola', 1)];
    assert.equal(dishBadgeCount(cfg, dishCartCounts(basket).cola ?? 0), 2);
    const off = resolveKioskConfig({ layout: { quickAdd: 'no_required', cartCountBadge: false } });
    assert.equal(dishBadgeCount(off, dishCartCounts(basket).cola ?? 0), null);
    // Default quick add (off): the tap opens the dish, as today; its "+" still adds.
    const today = resolveKioskConfig({});
    assert.equal(tapPathOf(cola, layoutOf(today).quickAdd, false, false), 'sheet');
    assert.equal(tapPathOf(cola, layoutOf(today).quickAdd, true, false), 'direct');
    // A dish with a choice to make opens its window either way.
    assert.equal(tapPathOf({ addPath: 'sheet' }, layoutOf(cfg).quickAdd, false, false), 'sheet');
  });
});

describe('layout.cartCountBadge: on by default, per level, validated', () => {
  it('is on in the defaults; quick add keeps its default (off)', () => {
    assert.equal(KIOSK_LAYOUT_DEFAULTS.cartCountBadge, true);
    assert.equal(KIOSK_LAYOUT_DEFAULTS.quickAdd, 'off');
    assert.ok(LAYOUT_TEMPLATE_KEYS.includes('cartCountBadge'));
  });

  for (const template of LAYOUT_TEMPLATES_READY) {
    it(`${template}: the badge is on and quick add is the template's`, () => {
      assert.equal((KIOSK_LAYOUT_TEMPLATES[template].layout as Record<string, unknown> | undefined)?.cartCountBadge, undefined);
      for (const style of ['ios', 'wolt', 'classic', 'minimal_dark', 'tech']) {
        const cfg = resolveKioskConfig({ theme: { uiStyle: style }, layout: { template } } as never);
        assert.equal(cfg.layout.cartCountBadge, true, style);
        assert.equal(cartCountBadgeOn(cfg), true, style);
        assert.equal(cfg.layout.quickAdd, template === 'wall' ? 'always' : 'off', style);
        assert.deepEqual(validateLayout(cfg), [], style);
      }
    });
  }

  it('a level turns it off, a lower one back on, null inherits; another template keeps the choice', () => {
    assert.equal(resolveKioskConfig({ layout: { template: 'magazine' } }, { layout: { cartCountBadge: false } }).layout.cartCountBadge, false);
    assert.equal(resolveKioskConfig({ layout: { cartCountBadge: false } }, {}, { layout: { cartCountBadge: true } }).layout.cartCountBadge, true);
    assert.equal(resolveKioskConfig({ layout: { cartCountBadge: false } }, { layout: { cartCountBadge: null } } as never).layout.cartCountBadge, false);
    const kept = resolveKioskConfig({ layout: { template: 'tabs', cartCountBadge: false } }, {}, { layout: { template: 'wall' } });
    assert.equal(kept.layout.cartCountBadge, false);
    assert.equal(kept.layout.quickAdd, 'always');
  });

  it('a config from before the key (an older server) draws the badge', () => {
    const older = { layout: { template: 'list' } } as unknown as KioskConfig;
    assert.equal(cartCountBadgeOn(older), true);
    assert.equal(cartCountBadgeOn(null), true);
    assert.equal(dishBadgeCount(older, 3), 3);
  });

  it('anything but true or false is refused', () => {
    for (const bad of ['yes', 1, 0, null, {}]) {
      const cfg = resolveKioskConfig({});
      (cfg.layout as unknown as Record<string, unknown>).cartCountBadge = bad;
      assert.deepEqual(
        validateLayout(cfg).map((i) => i.path),
        ['layout.cartCountBadge'],
        String(bad),
      );
      assert.ok(validateKioskConfig(cfg).some((e) => e.path === 'layout.cartCountBadge'), String(bad));
    }
    // Absent (a draft from before it) is on, not an error.
    const draft = resolveKioskConfig({});
    delete (draft.layout as unknown as Record<string, unknown>).cartCountBadge;
    assert.deepEqual(validateLayout(draft), []);
  });
});

describe('the badge on every dish card of every template (the shared layouts\' sources)', () => {
  const LAYOUTS = 'kiosk-shared/layouts';
  const badge = src(`${LAYOUTS}/count-badge.tsx`);
  /** Where each catalog draws its dishes, and the cards it draws them with. */
  const CATALOG_CARDS: Record<LayoutCatalog | 'standard', Array<{ file: string; card: string }>> = {
    standard: [{ file: 'components/dashboard/kiosks/preview-screens.tsx', card: 'export function ProductCard' }],
    rail: [{ file: `${LAYOUTS}/rail.tsx`, card: '<LayoutDishCard' }],
    top: [
      { file: `${LAYOUTS}/tabs.tsx`, card: '<LayoutDishCard' },
      { file: `${LAYOUTS}/hero.tsx`, card: 'function HeroCard' },
    ],
    landing: [{ file: `${LAYOUTS}/landing.tsx`, card: '<LayoutDishCard' }],
    shelves: [
      { file: `${LAYOUTS}/shelves.tsx`, card: '<LayoutDishCard' },
      { file: `${LAYOUTS}/hero.tsx`, card: 'function HeroCard' },
    ],
    list: [{ file: `${LAYOUTS}/list.tsx`, card: 'function ListLine' }],
    magazine: [{ file: `${LAYOUTS}/magazine.tsx`, card: 'function StoryPage' }],
    wall: [{ file: `${LAYOUTS}/wall.tsx`, card: 'function WallButton' }],
  };
  /** A card function's body: from its declaration to the next top-level function. */
  const bodyOf = (text: string, start: string) => {
    const at = text.indexOf(start);
    assert.ok(at >= 0, start);
    const next = text.indexOf('\nexport function ', at + start.length);
    const nextLocal = text.indexOf('\nfunction ', at + start.length);
    const ends = [next, nextLocal].filter((i) => i > 0);
    return text.slice(at, ends.length ? Math.min(...ends) : undefined);
  };

  it('the badge: the switch, the primary colour, the top end corner (right to left aware), the engine\'s cartBadge pop', () => {
    assert.match(badge, /dishBadgeCount\(m\.cfg, inCart\)/);
    assert.match(badge, /if \(n === null\) return null;/);
    assert.match(badge, /background: m\.c\.primary/);
    assert.match(badge, /contrastText\(m\.c\.primary\)/);
    assert.match(badge, /absolute end-1\.5 top-1\.5/);
    assert.doesNotMatch(badge, /\b(left|right)-\d/);
    assert.match(badge, /badgePop\(m\)/);
    // The pop replays as the number changes (its key), never as a card merely comes into view.
    assert.match(badge, /key=\{bumps\}/);
    assert.match(badge, /bumps > 0 \? badgePop\(m\) : null/);
  });

  it('every card kind of the shared dish card draws it: tile, row, plate', () => {
    const card = bodyOf(src(`${LAYOUTS}/parts.tsx`), 'export function LayoutDishCard');
    assert.equal(card.match(/<DishCountBadge m=\{m\} inCart=\{inCart\}/g)?.length, 3);
    // The row's "+" is the add again: the count is the badge's alone.
    assert.doesNotMatch(card, />\s*\{inCart\}\s*</);
  });

  for (const template of LAYOUT_TEMPLATES_READY) {
    it(`${template}: its catalog's every dish card draws the badge`, () => {
      const kind = catalogKindOf(resolveKioskConfig({ layout: { template } }));
      for (const { file, card } of CATALOG_CARDS[kind ?? 'standard']) {
        const text = src(file);
        if (card === '<LayoutDishCard') {
          // Each LayoutDishCard is handed the dish's count from the basket.
          const uses = text.match(/<LayoutDishCard [^>]*\/>/g) ?? [];
          assert.ok(uses.length > 0, file);
          for (const u of uses) assert.match(u, /inCart=\{counts\[p\.id\] \?\? 0\}/, `${file}: ${u}`);
        } else {
          assert.match(bodyOf(text, card), /<DishCountBadge m=\{m\} inCart=\{inCart\}/, `${file}: ${card}`);
        }
      }
    });
  }

  it('no layout draws a count of its own (off is no badge anywhere)', () => {
    for (const f of ['parts.tsx', 'hero.tsx', 'list.tsx', 'magazine.tsx', 'wall.tsx', 'landing.tsx', 'rail.tsx', 'shelves.tsx', 'tabs.tsx', 'item.tsx']) {
      const text = src(`${LAYOUTS}/${f}`);
      // The number as a child of its own element, or in place of the "+".
      assert.doesNotMatch(text, />\s*\{inCart\}\s*</, f);
      assert.doesNotMatch(text, /inCart > 0 \? inCart/, f);
      assert.doesNotMatch(text, /inCart > 0 && !added \?/, f);
    }
    assert.doesNotMatch(bodyOf(src('components/dashboard/kiosks/preview-screens.tsx'), 'export function ProductCard'), />\s*\{inCart\}\s*</);
  });

  it('the meal\'s "make it a meal?" cards draw it too, for the dish and each meal', () => {
    const chooser = bodyOf(src(`${LAYOUTS}/item.tsx`), 'export function MealChooser');
    assert.match(chooser, /<DishCountBadge m=\{m\} inCart=\{counts\[p\.id\] \?\? 0\}/);
  });

  it('today\'s card (standard) honours quick add on a tap, as every layout\'s card', () => {
    const card = bodyOf(src('components/dashboard/kiosks/preview-screens.tsx'), 'export function ProductCard');
    assert.match(card, /tapPathOf\(p, layoutOf\(m\.cfg\)\.quickAdd, plus, !!m\.mealOf\?\.\(p\)\) === 'direct'/);
    assert.match(card, /if \(direct\(false\)\) return m\.quickAdd/);
    assert.match(src(`${LAYOUTS}/parts.tsx`), /tapPathOf\(p, l\.quickAdd, plus, !!m\.mealOf\?\.\(p\)\) === 'direct'/);
  });

  it('the editor shows quick add and the badge under "התנהגות", with the hint and a preview of the look', () => {
    const editor = src('components/dashboard/kiosks/section-layout.tsx');
    const he = JSON.parse(src('messages/he.json')) as { kiosks: { layouts: Record<string, unknown> & { keys: Record<string, string> } } };
    const t = he.kiosks.layouts;
    assert.equal(t.behaviourTitle, 'התנהגות');
    assert.equal(t.quickAddHint, 'לחיצה על מנה בלי בחירות מכניסה אותה לסל');
    assert.equal(t.keys.cartCountBadge, 'תג כמות על המנה');
    for (const k of ['cartCountBadgeHint', 'cartCountBadgeOn', 'cartCountBadgeOff', 'behaviourPreviewHint']) assert.equal(typeof t[k], 'string', k);
    const box = editor.slice(editor.indexOf("{t('behaviourTitle')}"), editor.indexOf("{t('behaviourPreviewHint')}"));
    assert.match(box, /<LayoutChoice name="quickAdd" hint=\{t\('quickAddHint'\)\} \/>/);
    assert.match(box, /<CartCountBadgeField \/>/);
    // Out of "מתקדם" (collapsed): once in the editor.
    assert.equal(editor.match(/<LayoutChoice name="quickAdd"/g)?.length, 1);
    assert.match(editor, /const on = f\.value !== false;/);
    assert.match(editor, /<CountBadgeSample on=\{on\}/);
  });
});
