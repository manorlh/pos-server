/**
 * Run with `npm test` (compiled with tsc, then node's own test runner).
 *
 * "הרשאות דשבורד": the menu shows only what the user's sections grant, a page outside them says
 * "אין לך הרשאה", and the home page of a user without reports shows what they may open. The
 * server enforces the same grant on every API route; this is only what the dashboard shows.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  DASHBOARD_SECTIONS,
  ORG_MANAGER_SECTIONS,
  UNRESTRICTED,
  canAccess,
  canSeeSales,
  filterNavByAccess,
  grantedSections,
  navHrefAllowed,
  pageAccess,
  parseDashboardAccess,
  sectionForPath,
  sectionHome,
  toggleSection,
  type DashboardAccess,
} from './dashboardAccess';

const ORG_MANAGER: DashboardAccess = { restricted: true, sections: { ...ORG_MANAGER_SECTIONS } };
const NOTHING: DashboardAccess = { restricted: true, sections: {} };

/** A slice of the real menu's shape (lib/navigation.ts). */
const NAV = [
  { id: 'overview', items: [{ href: '/dashboard' }, { href: '/dashboard/live-items' }] },
  { id: 'catalog', items: [{ href: '/dashboard/products' }, { href: '/dashboard/stock' }, { href: '/dashboard/promotions' }] },
  { id: 'reports', items: [{ href: '/dashboard/transactions' }, { href: '/dashboard/z-reports/new' }, { href: '/dashboard/z-reports' }] },
  { id: 'organization', items: [{ href: '/dashboard/companies' }, { href: '/dashboard/machines' }] },
  { id: 'settings', items: [{ href: '/dashboard/users' }, { href: '/dashboard/profile' }] },
];

describe('sectionForPath — which section a page belongs to', () => {
  it('maps pages and their drill-downs', () => {
    assert.equal(sectionForPath('/dashboard'), 'reports');
    assert.equal(sectionForPath('/dashboard/transactions'), 'reports');
    assert.equal(sectionForPath('/dashboard/insights/kiosks'), 'reports');
    assert.equal(sectionForPath('/dashboard/shifts/abc'), 'z');
    assert.equal(sectionForPath('/dashboard/z-reports/new'), 'z');
    assert.equal(sectionForPath('/dashboard/products/import'), 'products');
    assert.equal(sectionForPath('/dashboard/shops/123'), 'organization');
    assert.equal(sectionForPath('/dashboard/machines/123'), 'devices');
    assert.equal(sectionForPath('/dashboard/kiosks/health'), 'kiosks');
    assert.equal(sectionForPath('/dashboard/workflow'), 'kds');
  });

  it('never lets `/dashboard` claim every route, nor a prefix that is not a parent', () => {
    assert.equal(sectionForPath('/dashboard/profile'), undefined);
    assert.equal(sectionForPath('/dashboard/access-settings'), undefined);
    // `/dashboard/promotions-report` is a report, not the promotions page.
    assert.equal(sectionForPath('/dashboard/promotions-report'), 'reports');
    assert.equal(sectionForPath('/dashboard/promotions'), 'promotions');
  });

  it('every menu entry belongs to a section, or is one of the few outside them', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'navigation.ts'), 'utf8');
    const hrefs = [...source.matchAll(/href: '(\/dashboard[^']*)'/g)].map((m) => m[1]);
    assert.ok(hrefs.length > 40, 'read the menu');
    const outside = new Set(['/dashboard/profile', '/dashboard/access-settings', '/dashboard/till-parameters', '/dashboard/app-updates', '/dashboard/device-logs']);
    const orphans = hrefs.filter((href) => sectionForPath(href) === undefined && !outside.has(href));
    assert.deepEqual(orphans, [], 'a new menu entry needs a section in DASHBOARD_SECTIONS (and the server)');
    for (const section of DASHBOARD_SECTIONS) {
      for (const page of section.pages) assert.ok(hrefs.includes(page), `${page} is in the menu`);
    }
  });
});

describe('filterNavByAccess — the menu', () => {
  it('shows a new "מנהל ארגון" reports, products and Z only', () => {
    const shown = filterNavByAccess(NAV, ORG_MANAGER);
    assert.deepEqual(
      shown.map((s) => [s.id, s.items.map((i) => i.href)]),
      [
        ['overview', ['/dashboard', '/dashboard/live-items']],
        ['catalog', ['/dashboard/products']],
        // Z at view: the Zs, not "produce a Z", which is an action.
        ['reports', ['/dashboard/transactions', '/dashboard/z-reports']],
        ['settings', ['/dashboard/profile']],
      ],
    );
    const zEditor: DashboardAccess = { restricted: true, sections: { ...ORG_MANAGER_SECTIONS, z: 'edit' } };
    assert.ok(navHrefAllowed(zEditor, '/dashboard/z-reports/new'));
  });

  it('drops a group left empty, keeps the home page and the profile always', () => {
    const shown = filterNavByAccess(NAV, NOTHING);
    assert.deepEqual(shown.map((s) => s.id), ['overview', 'settings']);
    assert.deepEqual(shown[0].items.map((i) => i.href), ['/dashboard']);
    assert.deepEqual(shown[1].items.map((i) => i.href), ['/dashboard/profile']);
  });

  it('changes nothing for an unrestricted user (super admin, full access, old server)', () => {
    assert.equal(filterNavByAccess(NAV, UNRESTRICTED), NAV);
    assert.ok(navHrefAllowed(UNRESTRICTED, '/dashboard/users'));
  });

  it('a section opened later appears', () => {
    const more: DashboardAccess = { restricted: true, sections: { ...ORG_MANAGER_SECTIONS, devices: 'view', users: 'edit' } };
    const hrefs = filterNavByAccess(NAV, more).flatMap((s) => s.items.map((i) => i.href));
    assert.ok(hrefs.includes('/dashboard/machines') && hrefs.includes('/dashboard/users'));
    assert.ok(!hrefs.includes('/dashboard/companies'));
  });
});

describe('pageAccess — a page reached by its address', () => {
  it('refuses a page of a section not granted, never crashes into it', () => {
    assert.equal(pageAccess(ORG_MANAGER, '/dashboard/users'), 'denied');
    assert.equal(pageAccess(ORG_MANAGER, '/dashboard/machines/123'), 'denied');
    assert.equal(pageAccess(ORG_MANAGER, '/dashboard/products/import'), 'ok');
    assert.equal(pageAccess(ORG_MANAGER, '/dashboard/profile'), 'ok');
    // An action page needs edit: Z at view reads the Zs but does not produce one.
    assert.equal(pageAccess(ORG_MANAGER, '/dashboard/z-reports'), 'ok');
    assert.equal(pageAccess(ORG_MANAGER, '/dashboard/z-reports/new'), 'denied');
  });

  it("the home page (the board) is everyone's: without reports it shows the tills, not the figures", () => {
    const productsOnly = { restricted: true, sections: { products: 'edit' as const } };
    assert.equal(pageAccess(productsOnly, '/dashboard'), 'ok');
    assert.equal(pageAccess(productsOnly, '/dashboard/'), 'ok');
    assert.equal(canSeeSales(productsOnly), false);
    assert.equal(navHrefAllowed(productsOnly, '/dashboard'), true);
    // Its comparisons are a reports page all the same.
    assert.equal(pageAccess(productsOnly, '/dashboard/compare'), 'denied');
    assert.equal(navHrefAllowed(productsOnly, '/dashboard/compare'), false);
    assert.equal(pageAccess(ORG_MANAGER, '/dashboard'), 'ok');
    assert.equal(canSeeSales(ORG_MANAGER), true);
    assert.equal(canSeeSales(UNRESTRICTED), true);
    // The cockpit reads the board's figures too (the server maps its routes to `cockpit`).
    assert.equal(canSeeSales({ restricted: true, sections: { cockpit: 'view' } }), true);
    assert.equal(pageAccess(UNRESTRICTED, '/dashboard/users'), 'ok');
  });
});

describe('levels and the dialog checklist', () => {
  it('edit includes view, view is not edit', () => {
    assert.ok(canAccess(ORG_MANAGER, 'products', 'edit'));
    assert.ok(canAccess(ORG_MANAGER, 'reports', 'view'));
    assert.ok(!canAccess(ORG_MANAGER, 'reports', 'edit'));
    assert.ok(!canAccess(ORG_MANAGER, 'users', 'view'));
  });

  it('edit brings view; dropping view drops edit; dropping edit keeps view', () => {
    let s = toggleSection({}, 'stock', 'edit', true);
    assert.deepEqual(s, { stock: 'edit' });
    s = toggleSection(s, 'stock', 'edit', false);
    assert.deepEqual(s, { stock: 'view' });
    s = toggleSection(s, 'stock', 'view', false);
    assert.deepEqual(s, {});
    assert.deepEqual(toggleSection({ z: 'edit' }, 'z', 'view', true), { z: 'edit' });
  });

  it('granted sections and where each leads', () => {
    assert.deepEqual(grantedSections(ORG_MANAGER), ['reports', 'z', 'products']);
    assert.equal(sectionHome('reports'), '/dashboard/live-items');
    assert.equal(sectionHome('z'), '/dashboard/shifts');
  });
});

describe('parseDashboardAccess — the server answer, read defensively', () => {
  it('drops unknown sections and levels', () => {
    const parsed = parseDashboardAccess({
      restricted: true,
      sections: { reports: 'view', flying: 'edit', z: 'admin' },
      orgWide: true,
      companyIds: ['c1'],
    });
    assert.deepEqual(parsed.sections, { reports: 'view' });
    assert.equal(parsed.orgWide, true);
    assert.deepEqual(parsed.companyIds, ['c1']);
  });

  it('anything but an explicit restriction is unrestricted', () => {
    assert.equal(parseDashboardAccess(undefined).restricted, false);
    assert.equal(parseDashboardAccess({ restricted: false, sections: {} }).restricted, false);
    assert.equal(parseDashboardAccess('x').restricted, false);
  });
});
