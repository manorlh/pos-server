/**
 * Run with `npm test`. "הערה בקיוסק" per dish (lib/kioskNotes.ts) and the kiosk's tap (lib/kioskLayout.ts tapPathOf /
 * kioskOpenFor) against the shared goldens server/tests/fixtures/kiosk_notes_golden.json and kiosk_tap_golden.json
 * (the same bytes in pos-android; SHA pinned here, in the cloud's tests and pos-android's KioskNotesTapTest).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { KIOSK_NOTES_DEFAULT, dishNoteFieldOn, dishNotesOpen, dishQuickNotesOn, kioskNotesAllowed } from './kioskNotes';
import { KIOSK_LAYOUT_DEFAULTS, LAYOUT_QUICK_ADDS, kioskOpenFor, tapPathOf, type LayoutQuickAdd } from './kioskLayout';

const NOTES_SHA256 = 'd4ccf2aec7faff55c9287a3f9f8e4d89e0be7b1cad09ca87433bbb1b0f6d3e20';
const TAP_SHA256 = 'cfa6a95b275ff6504b4a7ef46a7f4d1f521250648724c5e8cdaf365f5d73f961';

function fixture(name: string): string {
  const candidates = [join(process.cwd(), '..', 'server', 'tests', 'fixtures', name), join(__dirname, '..', '..', 'server', 'tests', 'fixtures', name)];
  const found = candidates.find((p) => existsSync(p));
  assert.ok(found, `fixture not found at ${candidates.join(' or ')}`);
  return readFileSync(found, 'utf8').replace(/\r\n/g, '\n');
}
const sha = (t: string) => createHash('sha256').update(t, 'utf8').digest('hex');

describe('"הערה בקיוסק" per dish: the shared golden', () => {
  const text = fixture('kiosk_notes_golden.json');
  const doc = JSON.parse(text) as {
    default: boolean;
    parents: Record<string, string | null>;
    cases: Array<{ name: string; kioskNotes: unknown; productIds: string[]; categoryId: string | null; allowed: boolean }>;
  };
  it('is the pinned bytes', () => {
    assert.equal(sha(text), NOTES_SHA256);
    assert.equal(doc.default, KIOSK_NOTES_DEFAULT);
  });
  for (const c of doc.cases) {
    it(c.name, () => assert.equal(kioskNotesAllowed(c.kioskNotes, c.productIds, c.categoryId, (id) => doc.parents[id] ?? null), c.allowed));
  }
  it('the kiosk switches stay the masters', () => {
    const cfg = (notes: boolean, quick: boolean) => ({ general: { notesEnabled: notes, quickNotesEnabled: quick } });
    assert.equal(dishNoteFieldOn(cfg(true, true), { notesAllowed: false }), false);
    assert.equal(dishNoteFieldOn(cfg(false, true), { notesAllowed: true }), false);
    assert.equal(dishNoteFieldOn(cfg(true, true), { notesAllowed: true }), true);
    assert.equal(dishQuickNotesOn(cfg(true, false), { notesAllowed: true }), false);
    // The preview's samples (no flag): as the switches say; they never force the window.
    assert.equal(dishNoteFieldOn(cfg(true, true), {}), true);
    assert.equal(dishNotesOpen(cfg(true, true), {}, 3), false);
    assert.equal(dishNotesOpen(cfg(false, true), { notesAllowed: true }, 0), false);
    assert.equal(dishNotesOpen(cfg(false, true), { notesAllowed: true }, 2), true);
  });
});

describe('the kiosk tap: the shared golden', () => {
  const text = fixture('kiosk_tap_golden.json');
  const doc = JSON.parse(text) as {
    quickAdds: string[];
    default: string;
    parents: Record<string, string | null>;
    openCases: Array<{ name: string; kioskOpen: unknown; productIds: string[]; categoryId: string | null; open: string | null }>;
    tapCases: Array<{
      quickAdd: string; plus: boolean; soldOut: boolean; addPath: 'direct' | 'sheet' | 'none'; meal: boolean; defaultsAnswer: boolean;
      hasChoices: boolean; kioskOpen: 'window' | 'direct' | null; notesOn: boolean; path: string;
    }>;
  };
  it('is the pinned bytes, with this build\'s vocabulary and default', () => {
    assert.equal(sha(text), TAP_SHA256);
    assert.deepEqual(doc.quickAdds, LAYOUT_QUICK_ADDS);
    assert.equal(doc.default, KIOSK_LAYOUT_DEFAULTS.quickAdd);
  });
  for (const c of doc.openCases) {
    it(`open: ${c.name}`, () => assert.equal(kioskOpenFor(c.kioskOpen, c.productIds, c.categoryId, (id) => doc.parents[id] ?? null), c.open));
  }
  it(`every one of the ${doc.tapCases.length} tap cases`, () => {
    for (const c of doc.tapCases) {
      const p = { addPath: c.addPath, defaultsAnswer: c.defaultsAnswer, soldOut: c.soldOut, hasChoices: c.hasChoices, kioskOpen: c.kioskOpen, notesOn: c.notesOn };
      assert.equal(tapPathOf(p, c.quickAdd as LayoutQuickAdd, c.plus, c.meal), c.path, JSON.stringify(c));
    }
  });
});
