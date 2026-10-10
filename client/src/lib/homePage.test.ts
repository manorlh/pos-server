import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { UNRESTRICTED, type DashboardAccess } from './dashboardAccess';
import { DEFAULT_HOME_PAGE, HOME_PAGES, homePageAllowed, landingTarget, parseHomePage } from './homePage';

const PRODUCTS_ONLY: DashboardAccess = { restricted: true, sections: { products: 'edit' } };
const REPORTS: DashboardAccess = { restricted: true, sections: { reports: 'view', z: 'view' } };

describe('the opening page ("דף פתיחה")', () => {
  it('is the control board unless chosen otherwise', () => {
    assert.equal(DEFAULT_HOME_PAGE, 'board');
    assert.equal(landingTarget(undefined, UNRESTRICTED), '/dashboard');
    assert.equal(landingTarget(null, UNRESTRICTED), '/dashboard');
    assert.equal(landingTarget('board', PRODUCTS_ONLY), '/dashboard');
  });

  it('a value it does not know is the board', () => {
    assert.equal(parseHomePage('/etc/passwd'), 'board');
    assert.equal(parseHomePage(42), 'board');
    assert.equal(landingTarget('https://evil.example', UNRESTRICTED), '/dashboard');
  });

  it('goes to the page chosen when the user may open it', () => {
    assert.equal(landingTarget('compare', UNRESTRICTED), '/dashboard?view=compare');
    assert.equal(landingTarget('z_reports', REPORTS), '/dashboard/z-reports');
    assert.equal(landingTarget('products', PRODUCTS_ONLY), '/dashboard/products');
  });

  it('falls back to the board for a page the user may not open', () => {
    assert.equal(landingTarget('compare', PRODUCTS_ONLY), '/dashboard');
    assert.equal(landingTarget('machines', REPORTS), '/dashboard');
    // Hidden from the role by the super admin ("הרשאות").
    assert.equal(landingTarget('transactions', UNRESTRICTED, new Set(['/dashboard/transactions'])), '/dashboard');
    assert.equal(landingTarget('compare', UNRESTRICTED, new Set(['/dashboard/compare'])), '/dashboard');
  });

  it('the board is always allowed, and every page is an internal one', () => {
    assert.equal(homePageAllowed('board', PRODUCTS_ONLY, new Set(['/dashboard'])), true);
    for (const page of HOME_PAGES) assert.ok(page.href.startsWith('/dashboard'));
    assert.deepEqual(
      HOME_PAGES.map((p) => p.id),
      ['board', 'compare', 'live_items', 'transactions', 'shifts', 'z_reports', 'machines', 'products'],
    );
  });
});
