'use client';

/**
 * "Where am I" for every dashboard page, in one line.
 *
 * The trail mirrors the shared scope rather than the URL path, because the scope
 * is what the page is actually showing: organization ▸ company (with its whole
 * ancestor chain, so a nested company is never shown floating) ▸ shop ▸ device,
 * then the sidebar section and the page itself.
 *
 * Every scope crumb is a link into that entity's drill-down page, so the trail
 * doubles as the way back up from a device to its shop to its company.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ChevronLeft } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { useScope } from '@/lib/scope';
import { NAV_SECTIONS, findNavEntry } from '@/lib/navigation';

interface Crumb {
  key: string;
  label: string;
  href?: string;
  /** Runs instead of the default navigation on a plain left click. */
  onNavigate?: () => void;
}

export function Breadcrumbs() {
  const t = useTranslations('scope');
  const tNav = useTranslations('nav');
  const pathname = usePathname();
  const scope = useScope();
  const tenants = useAuth((s) => s.tenants);
  const activeTenantId = useAuth((s) => s.activeTenantId);

  const tenantName =
    tenants.find((tenant) => tenant.id === activeTenantId)?.name ?? t('organization');

  /**
   * The root crumb means "the whole organization", so it has to *drop* the scope
   * rather than carry it: with the scope appended, clicking the organization's own
   * name left you still looking at a single shop. It stays a real anchor so
   * middle-click and open-in-new-tab keep working, but a plain click goes through
   * `clear()`, which also forgets the remembered scope — otherwise the next reload
   * would restore the branch the user just stepped out of.
   */
  const crumbs: Crumb[] = [
    { key: 'tenant', label: tenantName, href: '/dashboard', onNavigate: scope.clear },
  ];

  for (const company of scope.companyPath) {
    crumbs.push({
      key: `company:${company.id}`,
      label: company.name,
      href: `/dashboard/companies/${company.id}`,
    });
  }
  if (scope.shop) {
    crumbs.push({
      key: `shop:${scope.shop.id}`,
      label: scope.shop.name,
      href: `/dashboard/shops/${scope.shop.id}`,
    });
  }
  if (scope.machine) {
    crumbs.push({
      key: `machine:${scope.machine.id}`,
      label: scope.machine.name,
      href: `/dashboard/machines/${scope.machine.id}`,
    });
  }

  /**
   * Section + page at the tail. Two exclusions: `/dashboard` is already the first
   * crumb's target, and a drill-down route needs no tail at all — the entity crumb
   * above *is* the page, so appending "Organization › Companies" after the company's
   * own name would read backwards.
   */
  const entry = findNavEntry(pathname);
  const onDrillRoute =
    /^\/dashboard\/(companies|shops|machines)\/[^/]+$/.test(pathname ?? '');
  if (entry && entry.href !== '/dashboard' && !onDrillRoute) {
    const section = NAV_SECTIONS.find((s) => s.items.some((item) => item.href === entry.href));
    if (section) {
      crumbs.push({ key: `section:${section.id}`, label: tNav(section.labelKey) });
    }
    crumbs.push({ key: `page:${entry.href}`, label: tNav(entry.labelKey) });
  }

  return (
    <nav aria-label={t('breadcrumbsLabel')} className="min-w-0">
      <ol className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            <li key={crumb.key} className="flex min-w-0 items-center gap-1">
              {index > 0 ? (
                <ChevronLeft className="h-3 w-3 shrink-0 opacity-60" aria-hidden />
              ) : null}
              {crumb.href && !last ? (
                <Link
                  href={crumb.href}
                  onClick={(event) => {
                    if (!crumb.onNavigate) return;
                    // Modified clicks belong to the browser: they open a new tab,
                    // which must not change the scope in this one.
                    if (
                      event.metaKey ||
                      event.ctrlKey ||
                      event.shiftKey ||
                      event.altKey ||
                      event.button !== 0
                    ) {
                      return;
                    }
                    event.preventDefault();
                    crumb.onNavigate();
                  }}
                  className="max-w-[14rem] truncate rounded hover:text-foreground hover:underline"
                >
                  {crumb.label}
                </Link>
              ) : (
                <span
                  aria-current={last ? 'page' : undefined}
                  className={
                    last
                      ? 'max-w-[18rem] truncate font-medium text-foreground'
                      : 'max-w-[14rem] truncate'
                  }
                >
                  {crumb.label}
                </span>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
