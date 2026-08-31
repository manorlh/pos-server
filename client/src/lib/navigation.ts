/**
 * The dashboard's navigation map — one description of it, read by both the
 * sidebar and the breadcrumbs.
 *
 * Eighteen flat links used to sit in the sidebar in the order they were written,
 * which meant the reports were interleaved with the org tree and nothing told you
 * which of the five things you were doing. They are grouped into five sections
 * here, and because the breadcrumbs read the same table, the section name in the
 * trail can never drift from the section the link sits under.
 *
 * Role gating stays exactly where it was: an entry names a capability flag and
 * the sidebar hides it unless the flag is true. Nothing here widens access — the
 * flags are the server's own answer from `GET /users/me`, and `branding` is still
 * the super-admin / distributor / company-manager set the settings router
 * enforces.
 */
import type { ElementType } from 'react';
import {
  Boxes,
  Building2,
  Coins,
  FileBarChart,
  FileText,
  IdCard,
  LayoutDashboard,
  ListFilter,
  Monitor,
  Package,
  Package2,
  Palette,
  Receipt,
  Store,
  Tag,
  Ticket,
  User,
  UserRoundCheck,
  Users,
} from 'lucide-react';

/** Which gate an entry hangs on. `undefined` = visible to anyone signed in. */
export type NavGate = 'canReadUsers' | 'canManagePosUsers' | 'branding';

export interface NavItem {
  href: string;
  /** Key under the `nav` message namespace. */
  labelKey: string;
  icon: ElementType;
  gate?: NavGate;
  /**
   * Extra path prefixes that should light this entry up — the drill-down routes,
   * so `/dashboard/shops/<id>` still shows "Shops" as the active section.
   */
  matchPrefixes?: string[];
}

export interface NavSection {
  id: string;
  labelKey: string;
  items: NavItem[];
}

export const NAV_SECTIONS: NavSection[] = [
  {
    id: 'overview',
    labelKey: 'sections.overview',
    items: [{ href: '/dashboard', labelKey: 'overview', icon: LayoutDashboard }],
  },
  {
    id: 'catalog',
    labelKey: 'sections.catalog',
    items: [
      { href: '/dashboard/products', labelKey: 'products', icon: Package },
      { href: '/dashboard/categories', labelKey: 'categories', icon: Tag },
      { href: '/dashboard/vouchers', labelKey: 'vouchers', icon: Ticket },
      // Both of these used to live at /dashboard/shops/… while being shown as
      // top-level items, and would now collide with the /dashboard/shops/[id]
      // drill-down. They are top-level routes to match where they appear.
      { href: '/dashboard/assortment', labelKey: 'assortment', icon: ListFilter },
      { href: '/dashboard/stock', labelKey: 'stock', icon: Boxes },
    ],
  },
  {
    id: 'reports',
    labelKey: 'sections.reports',
    items: [
      { href: '/dashboard/transactions', labelKey: 'transactions', icon: Receipt },
      { href: '/dashboard/z-reports', labelKey: 'zReports', icon: FileBarChart },
      { href: '/dashboard/product-sales', labelKey: 'productSales', icon: Package2 },
      { href: '/dashboard/cashier-sales', labelKey: 'cashierSales', icon: UserRoundCheck },
      { href: '/dashboard/tips', labelKey: 'tips', icon: Coins },
      { href: '/dashboard/tax-reports', labelKey: 'taxReports', icon: FileText },
    ],
  },
  {
    id: 'organization',
    labelKey: 'sections.organization',
    items: [
      {
        href: '/dashboard/companies',
        labelKey: 'companies',
        icon: Building2,
        matchPrefixes: ['/dashboard/companies/'],
      },
      {
        href: '/dashboard/shops',
        labelKey: 'shops',
        icon: Store,
        matchPrefixes: ['/dashboard/shops/'],
      },
      {
        href: '/dashboard/machines',
        labelKey: 'machines',
        icon: Monitor,
        matchPrefixes: ['/dashboard/machines/'],
      },
    ],
  },
  {
    id: 'settings',
    labelKey: 'sections.settings',
    items: [
      { href: '/dashboard/users', labelKey: 'users', icon: Users, gate: 'canReadUsers' },
      {
        href: '/dashboard/pos-users',
        labelKey: 'posUsers',
        icon: IdCard,
        gate: 'canManagePosUsers',
      },
      { href: '/dashboard/branding', labelKey: 'branding', icon: Palette, gate: 'branding' },
      { href: '/dashboard/profile', labelKey: 'profile', icon: User },
    ],
  },
];

/**
 * The entry a path belongs to. Exact match wins; otherwise the longest declared
 * prefix. `/dashboard` never prefix-matches, or it would claim every route.
 */
export function findNavEntry(pathname: string | null | undefined): NavItem | undefined {
  if (!pathname) return undefined;
  const all = NAV_SECTIONS.flatMap((section) => section.items);

  const exact = all.find((item) => item.href === pathname);
  if (exact) return exact;

  let best: NavItem | undefined;
  let bestLength = -1;
  for (const item of all) {
    for (const prefix of item.matchPrefixes ?? []) {
      if (pathname.startsWith(prefix) && prefix.length > bestLength) {
        best = item;
        bestLength = prefix.length;
      }
    }
  }
  return best;
}

/** The section id a path sits in, for keeping that sidebar group open. */
export function findNavSectionId(pathname: string | null | undefined): string | undefined {
  const entry = findNavEntry(pathname);
  if (!entry) return undefined;
  return NAV_SECTIONS.find((section) => section.items.some((item) => item.href === entry.href))?.id;
}
