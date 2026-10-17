/**
 * "מזומן במגירה כולל טיפים" (P:/specs/x-z-cash-with-tips.md §5): the shared golden, byte-equal with pos-server's
 * (server/tests/fixtures), the dashboard's reader of it and pos-android's (app/src/test/resources) — pinned here by
 * its SHA-256 and run against the dashboard's rule (`client/src/lib/cashWithTips.ts`), every case, every field. The
 * Windows till's own X/Z rendering reads the same rule.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { LABELS, drawerCase, tillTableCase, type DrawerInput } from '@dash-lib/cashWithTips';

const FIXTURE = path.join(__dirname, 'fixtures', 'x_z_cash_with_tips_golden.json');
const SERVER_COPY = path.join(__dirname, '..', '..', 'server', 'tests', 'fixtures', 'x_z_cash_with_tips_golden.json');
const GOLDEN_SHA256 = '9e7ccd52d809f17d5633e2dfbbf51107076c5afc708097aa0903e15cb379b13d';

const bytes = () => readFileSync(FIXTURE);
const golden = () => JSON.parse(bytes().toString('utf8'));

describe('x_z_cash_with_tips_golden.json', () => {
  it('is the pinned bytes, the same as the server copy', () => {
    expect(createHash('sha256').update(bytes()).digest('hex')).toBe(GOLDEN_SHA256);
    expect(readFileSync(SERVER_COPY).equals(bytes())).toBe(true);
  });

  it('has the shape the tills read', () => {
    const g = golden();
    expect(g.version).toBe(1);
    expect(Object.keys(g.labels)).toEqual(Object.keys(LABELS));
    expect(g.drawerCases.length).toBeGreaterThan(10);
    for (const c of g.drawerCases) {
      expect(Object.keys(c.expect)).toEqual(['available', 'paid', 'unpaid', 'frozenShortfall', 'needsChoice', 'total', 'short', 'lines']);
    }
    for (const c of g.tillTableCases) {
      expect(Object.keys(c.expect)).toEqual(['rows', 'totals', 'unpaidTotal', 'summary']);
    }
  });

  it('every drawer case', () => {
    for (const c of golden().drawerCases as { name: string; input: DrawerInput; expect: unknown }[]) {
      expect(drawerCase(c.input), c.name).toEqual(c.expect);
    }
  });

  it('every till table case', () => {
    for (const c of golden().tillTableCases) {
      expect(tillTableCase(c.tills, c.showDrawerCash), c.name).toEqual(c.expect);
    }
  });
});
