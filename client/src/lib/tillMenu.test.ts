/**
 * Run with `npm test`. "תפריט הקופה" as the dashboard reads, writes, warns about and previews it
 * (lib/tillMenu.ts; P:/specs/till-menu-hide.md).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  MENU_GROUPS,
  TILL_MENU_ITEMS,
  WARNING_TEXTS,
  effectiveOf,
  hiddenCountText,
  hiddenSummary,
  ignoredText,
  inheritanceText,
  inheritedFromText,
  isDirty,
  menuPreview,
  menuWarnings,
  parseHidden,
  sameHidden,
  savePayload,
  serializeHidden,
  toggleHidden,
  unknownKeys,
  type PreviewGroup,
} from './tillMenu';

const golden = JSON.parse(
  readFileSync(join(process.cwd(), '..', 'server', 'tests', 'fixtures', 'till_menu_items_golden.json'), 'utf8'),
) as { key: string; label: string; also: string | null; critical: boolean; warning: string | null; report: boolean }[];

const REPORTS = ['recent', 'shift_history', 'till_z_history', 'product_sales', 'workers', 'tips', 'tables_reports', 'z_reports'];

/** The keys of the preview's rows, a folder as `folder:<its keys>`. */
function shown(groups: PreviewGroup[]): string[] {
  return groups.flatMap((g) =>
    g.rows.map((r) => (r.kind === 'folder' ? `folder:${r.items.map((i) => i.key).join('+')}` : r.item.key)),
  );
}

describe('the items', () => {
  it('are the server\'s: keys, names, hints, warnings and reports (the shared golden file)', () => {
    assert.deepEqual(
      TILL_MENU_ITEMS.map((i) => ({
        key: i.key,
        label: i.label,
        also: i.also ?? null,
        critical: i.critical,
        warning: WARNING_TEXTS[i.key] ?? null,
        report: i.report,
      })),
      golden,
    );
  });

  it('three critical, 39 in all, each key once, every group in use', () => {
    assert.equal(TILL_MENU_ITEMS.length, 39);
    assert.equal(new Set(TILL_MENU_ITEMS.map((i) => i.key)).size, 39);
    assert.deepEqual(TILL_MENU_ITEMS.filter((i) => i.critical).map((i) => i.key), ['shift_close', 'till_z', 'settings']);
    assert.deepEqual(TILL_MENU_ITEMS.filter((i) => i.report).map((i) => i.key), REPORTS);
    for (const g of MENU_GROUPS) assert.ok(TILL_MENU_ITEMS.some((i) => i.group === g.id), g.id);
    for (const i of TILL_MENU_ITEMS) assert.match(i.tile, /^#[0-9A-F]{6}$/);
  });
});

describe('the value', () => {
  it('reads text or a list: known keys, once, lower-case, in the menu\'s order', () => {
    assert.deepEqual(parseHidden(' Settings , CATALOG_ADMIN,till_z,,catalog_admin '), ['catalog_admin', 'till_z', 'settings']);
    assert.deepEqual(parseHidden(['lock', 'shift_close', 'lock']), ['shift_close', 'lock']);
    assert.deepEqual(parseHidden('till_z,espresso'), ['till_z']);
    assert.deepEqual(unknownKeys('till_z, Espresso ,x'), ['espresso', 'x']);
    for (const empty of ['', '  ', null, undefined, 5, {}]) assert.deepEqual(parseHidden(empty), []);
  });

  it('writes the server\'s text, and toggles keep the order', () => {
    assert.equal(serializeHidden(['settings', 'catalog_admin']), 'catalog_admin,settings');
    assert.equal(serializeHidden([]), '');
    let keys = toggleHidden([], 'settings', true);
    keys = toggleHidden(keys, 'catalog_admin', true);
    keys = toggleHidden(keys, 'catalog_admin', true);
    assert.deepEqual(keys, ['catalog_admin', 'settings']);
    assert.deepEqual(toggleHidden(keys, 'catalog_admin', false), ['settings']);
  });

  it('compares choices, not their order', () => {
    assert.ok(sameHidden(['settings', 'till_z'], ['till_z', 'settings']));
    assert.ok(!sameHidden(['till_z'], []));
    assert.ok(sameHidden(null, null));
    assert.ok(!sameHidden([], null));
  });

  it('says what is hidden in words', () => {
    assert.equal(hiddenSummary([]), 'הכל מוצג');
    assert.equal(hiddenSummary(['till_z', 'catalog_admin']), 'ניהול קטלוג · הפק Z');
    assert.equal(hiddenCountText([]), 'הכל מוצג');
    assert.equal(hiddenCountText(['till_z']), 'פריט אחד מוסתר');
    assert.equal(hiddenCountText(['till_z', 'lock', 'espresso']), '2 פריטים מוסתרים');
    assert.equal(ignoredText([]), null);
    assert.equal(ignoredText(['espresso']), 'מפתחות שהמערכת לא מכירה לא נשמרו: espresso');
  });
});

describe('inheritance', () => {
  it('names where an inherited list comes from, or the default', () => {
    assert.equal(
      inheritanceText({ inheritedFrom: { level: 'shop', id: 's', name: 'מרכז' }, inherited: ['till_z', 'settings'] }),
      'עובר בירושה מהסניף "מרכז": 2 פריטים מוסתרים',
    );
    assert.equal(inheritanceText({ inheritedFrom: null, inherited: [] }), 'ברירת המחדל: הכל מוצג');
    assert.equal(inheritedFromText({ inheritedFrom: { level: 'company', id: 'c', name: null } }), 'מהחברה');
    assert.equal(inheritedFromText({ inheritedFrom: { level: 'area', id: 'a', name: 'בר' } }), 'מנקודת המכירה "בר"');
  });

  it('the till gets the level\'s own list when it has one — [] too — else the inherited', () => {
    assert.deepEqual(effectiveOf(null, ['settings']), ['settings']);
    assert.deepEqual(effectiveOf([], ['settings']), []);
    assert.deepEqual(effectiveOf(['till_z'], ['settings']), ['till_z']);
  });

  it('saves the own list or null, and is dirty only on a real change', () => {
    assert.deepEqual(savePayload(null), { hidden: null });
    assert.deepEqual(savePayload(['settings', 'catalog_admin']), { hidden: ['catalog_admin', 'settings'] });
    assert.deepEqual(savePayload([]), { hidden: [] });
    assert.ok(!isDirty(['settings', 'till_z'], ['till_z', 'settings']));
    assert.ok(isDirty([], null));
    assert.ok(isDirty(null, []));
    assert.ok(!isDirty(null, null));
  });
});

describe('warnings', () => {
  it('the critical items, in the menu\'s order, with the spec\'s words', () => {
    const w = menuWarnings(['settings', 'catalog_admin', 'till_z', 'shift_close']);
    assert.deepEqual(w.map((x) => [x.key, x.tone]), [['shift_close', 'critical'], ['till_z', 'critical'], ['settings', 'critical']]);
    assert.equal(w[1].text, 'בקופה הזו לא יהיה אפשר לבצע Z. ודאו ש-Z נעשה בקופה אחרת או בענן.');
    assert.match(w[2].text, /רק בקוד טכנאי/);
    assert.deepEqual(menuWarnings(['catalog_admin', 'lock']), []);
  });

  it('notes that "אבחון" stays with settings hidden, and the folder goes with every report', () => {
    assert.deepEqual(menuWarnings(['settings', 'diagnostics']).map((x) => [x.key, x.tone]), [['settings', 'critical'], ['diagnostics', 'note']]);
    assert.deepEqual(menuWarnings(['diagnostics']), []);
    assert.deepEqual(menuWarnings(REPORTS).map((x) => x.key), ['reports']);
    assert.deepEqual(menuWarnings(REPORTS.slice(1)), []);
  });
});

describe('the preview', () => {
  it('everything shown: every item in its group, the reports in their folder', () => {
    const groups = menuPreview([]);
    assert.deepEqual(groups.map((g) => g.id), MENU_GROUPS.map((g) => g.id));
    const keys = shown(groups);
    assert.ok(keys.includes(`folder:${REPORTS.join('+')}`));
    assert.equal(keys.filter((k) => !k.startsWith('folder:')).length, 39 - REPORTS.length);
    assert.equal(keys.indexOf('history') + 1, keys.indexOf(`folder:${REPORTS.join('+')}`));
  });

  it('a hidden item is gone, and so is a group left empty', () => {
    const keys = shown(menuPreview(['catalog_admin', 'till_z']));
    assert.ok(!keys.includes('catalog_admin') && !keys.includes('till_z'));
    assert.ok(keys.includes('shift_close'));
    assert.ok(!menuPreview(['catalog_admin']).some((g) => g.id === 'catalog'));
  });

  it('the folder keeps what is left of the reports, and goes with the last of them', () => {
    const some = shown(menuPreview(['recent', 'tips']));
    assert.ok(some.includes('folder:shift_history+till_z_history+product_sales+workers+tables_reports+z_reports'));
    const none = shown(menuPreview(REPORTS));
    assert.ok(!none.some((k) => k.startsWith('folder:')));
    assert.ok(none.includes('history'));
  });

  it('"אבחון" stays while "הגדרות" is hidden, marked why', () => {
    const groups = menuPreview(['settings', 'diagnostics']);
    const manage = groups.find((g) => g.id === 'manage')!;
    const diag = manage.rows.find((r) => r.kind === 'item' && r.item.key === 'diagnostics');
    assert.ok(diag && diag.kind === 'item' && diag.note);
    assert.ok(!shown(groups).includes('settings'));
    assert.ok(!shown(menuPreview(['diagnostics'])).includes('diagnostics'));
  });
});
