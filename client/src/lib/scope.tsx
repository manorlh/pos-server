'use client';

/**
 * The dashboard's one shared scope: organization ▸ company ▸ shop ▸ device.
 *
 * Before this existed, fourteen of eighteen pages carried their own company /
 * shop / machine dropdowns. Setting a company on one page and navigating put you
 * back on "all", so nobody could hold a position in the hierarchy for longer than
 * a single page view. The scope now lives in exactly one place and every page
 * reads it.
 *
 * Three decisions worth knowing about:
 *
 * **The URL is the source of truth.** `?company=…&shop=…&machine=…` means refresh,
 * browser-back and a pasted link all land on the same view. A user-driven change
 * is a `router.push`, so Back genuinely undoes it; a correction the app makes on
 * the user's behalf (restoring the last visit, pruning an id that no longer
 * exists) is a `router.replace`, so it never becomes a history entry the user has
 * to press Back through twice.
 *
 * **Selecting a level clears the deeper ones.** A shop belonging to company A must
 * not survive a switch to company B. That is enforced twice: in the setters, and
 * again after the lists load, because a URL can be typed or shared with any
 * combination at all. Pruning is `replace`, and it only happens once the relevant
 * list has actually arrived — an id is never discarded merely because its list is
 * still in flight.
 *
 * **localStorage remembers, the URL decides.** The last scope is stored per tenant
 * (`dashboardScope:<tenantId>`), so a shop manager who lives in one branch does
 * not re-pick it every morning. It is only consulted when the URL carries no
 * scope at all, and switching tenants starts clean rather than carrying company
 * ids across a tenant boundary.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { fetchCompanies, fetchMachines, fetchShops } from './api';
import { useAuth } from './auth';
import { buildCompanyTree, companyPath, companySubtreeIds } from './companyTree';
import { findBySameId, sameId } from './entityLookup';
import {
  SCOPE_LEVEL_ORDER,
  resolvePageScope,
  scopeLevelOf,
  type PageScopeResolution,
  type PageScopeSpec,
} from './pageScope';
import type {
  Company,
  CompanyTree,
  PosMachine,
  ScopeLevel,
  ScopeSelection,
  Shop,
} from './types';

export const SCOPE_PARAM = {
  company: 'company',
  shop: 'shop',
  machine: 'machine',
} as const;

const STORAGE_PREFIX = 'dashboardScope:';

const EMPTY_SELECTION: ScopeSelection = { companyId: null, shopId: null, machineId: null };

const EMPTY_COMPANIES: Company[] = [];
const EMPTY_SHOPS: Shop[] = [];
const EMPTY_MACHINES: PosMachine[] = [];

function readStored(tenantId: string | null): ScopeSelection {
  if (!tenantId || typeof window === 'undefined') return EMPTY_SELECTION;
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${tenantId}`);
    if (!raw) return EMPTY_SELECTION;
    const parsed = JSON.parse(raw) as Partial<ScopeSelection>;
    return {
      companyId: parsed.companyId ?? null,
      shopId: parsed.shopId ?? null,
      machineId: parsed.machineId ?? null,
    };
  } catch {
    // A corrupt or unreadable entry must not stop the dashboard loading.
    return EMPTY_SELECTION;
  }
}

function writeStored(tenantId: string | null, selection: ScopeSelection): void {
  if (!tenantId || typeof window === 'undefined') return;
  try {
    const key = `${STORAGE_PREFIX}${tenantId}`;
    if (!selection.companyId && !selection.shopId && !selection.machineId) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, JSON.stringify(selection));
  } catch {
    // Private-browsing quota errors are not worth a toast.
  }
}

/**
 * The three drill-down routes address an entity by path, not by query. On one of
 * them the scope bar has to *navigate* — picking a different shop while sitting on
 * `/dashboard/shops/<id>` means "show me that shop", not "leave this page showing
 * shop A while the bar claims shop B". Without this the page's route-sync and the
 * bar would overwrite each other in a loop.
 */
const DRILL_PREFIXES = [
  '/dashboard/companies/',
  '/dashboard/shops/',
  '/dashboard/machines/',
] as const;

function isDrillRoute(pathname: string): boolean {
  return DRILL_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

function drillHrefFor(level: Exclude<ScopeLevel, 'tenant'>, id: string): string {
  if (level === 'company') return `/dashboard/companies/${id}`;
  if (level === 'shop') return `/dashboard/shops/${id}`;
  return `/dashboard/machines/${id}`;
}

function isEmpty(selection: ScopeSelection): boolean {
  return !selection.companyId && !selection.shopId && !selection.machineId;
}

function sameSelection(a: ScopeSelection, b: ScopeSelection): boolean {
  return (
    (a.companyId ?? '') === (b.companyId ?? '') &&
    (a.shopId ?? '') === (b.shopId ?? '') &&
    (a.machineId ?? '') === (b.machineId ?? '')
  );
}

export interface ScopeContextValue extends ScopeSelection {
  level: ScopeLevel;
  selection: ScopeSelection;

  /** Resolved entities for the current selection, when their list has loaded. */
  company?: Company;
  shop?: Shop;
  machine?: PosMachine;
  /** Root-first company chain for the breadcrumbs and the selector label. */
  companyPath: Company[];

  companies: Company[];
  shops: Shop[];
  machines: PosMachine[];
  tree: CompanyTree;

  /** Options the selector offers at each level, already narrowed by the level above. */
  shopOptions: Shop[];
  machineOptions: PosMachine[];

  companiesLoading: boolean;
  shopsLoading: boolean;
  machinesLoading: boolean;

  setCompany: (companyId: string | null) => void;
  setShop: (shopId: string | null) => void;
  setMachine: (machineId: string | null) => void;
  /** Back to the whole organization. */
  clear: () => void;
  /** Set every level at once — used when a drill-down page syncs from its route. */
  setScope: (next: Partial<ScopeSelection>, mode?: 'push' | 'replace') => void;

  /** The current page's declaration, and what it resolves to. Null before a page registers. */
  spec: PageScopeSpec | null;
  /**
   * Register (or, with `null`, release) the calling page's spec. `id` is the
   * caller's own `useId`: a release only clears the bar when the spec on it is
   * still the caller's, so an outgoing page's cleanup cannot wipe the spec the
   * incoming page just installed.
   */
  registerSpec: (id: string, spec: PageScopeSpec | null) => void;
  resolution: PageScopeResolution | null;

  /** A query string carrying the current scope, for links that should preserve it. */
  scopeQuery: string;
}

const ScopeContext = createContext<ScopeContextValue | null>(null);

export function ScopeProvider({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeTenantId = useAuth((s) => s.activeTenantId);

  const urlSelection = useMemo<ScopeSelection>(
    () => ({
      companyId: searchParams.get(SCOPE_PARAM.company) || null,
      shopId: searchParams.get(SCOPE_PARAM.shop) || null,
      machineId: searchParams.get(SCOPE_PARAM.machine) || null,
    }),
    [searchParams],
  );

  const [specEntry, setSpecEntry] = useState<{ id: string; spec: PageScopeSpec } | null>(null);
  const spec = specEntry?.spec ?? null;

  const companiesQuery = useQuery<Company[]>({
    queryKey: ['companies'],
    queryFn: fetchCompanies,
    enabled: !!activeTenantId,
  });
  const shopsQuery = useQuery<Shop[]>({
    queryKey: ['shops'],
    queryFn: () => fetchShops(),
    enabled: !!activeTenantId,
  });
  const machinesQuery = useQuery<PosMachine[]>({
    queryKey: ['machines'],
    queryFn: fetchMachines,
    enabled: !!activeTenantId,
  });

  // Stable empties: `x.data ?? []` would hand out a fresh array on every render
  // while a query is pending, which would rebuild the company tree and re-run
  // every downstream memo each time the shell re-renders.
  const companies = companiesQuery.data ?? EMPTY_COMPANIES;
  const shops = shopsQuery.data ?? EMPTY_SHOPS;
  const machines = machinesQuery.data ?? EMPTY_MACHINES;

  const tree = useMemo(() => buildCompanyTree(companies), [companies]);

  /** Write a selection into the URL, keeping every other query param intact. */
  const commit = useCallback(
    (next: ScopeSelection, mode: 'push' | 'replace') => {
      const params = new URLSearchParams(searchParams.toString());
      const apply = (key: string, value: string | null) => {
        if (value) params.set(key, value);
        else params.delete(key);
      };
      apply(SCOPE_PARAM.company, next.companyId);
      apply(SCOPE_PARAM.shop, next.shopId);
      apply(SCOPE_PARAM.machine, next.machineId);
      const query = params.toString();
      const href = query ? `${pathname}?${query}` : pathname;
      writeStored(activeTenantId, next);
      if (mode === 'push') router.push(href, { scroll: false });
      else router.replace(href, { scroll: false });
    },
    [activeTenantId, pathname, router, searchParams],
  );

  // ── Restore the last visit ───────────────────────────────────────────────────
  // Only when the URL says nothing, and only once per tenant: after that an empty
  // URL means the user deliberately went back to the whole organization.
  const restoredForTenant = useRef<string | null>(null);
  useEffect(() => {
    if (!activeTenantId) return;
    if (restoredForTenant.current === activeTenantId) return;
    restoredForTenant.current = activeTenantId;
    if (!isEmpty(urlSelection)) return;
    // A drill-down route already says what it is about; restoring a remembered
    // scope over it would flash the wrong entity's name in the breadcrumbs before
    // the page's own route-sync corrected it.
    if (isDrillRoute(pathname)) return;
    const stored = readStored(activeTenantId);
    if (isEmpty(stored)) return;
    commit(stored, 'replace');
    // `urlSelection` is deliberately not a dependency: this must fire once per
    // tenant, not every time the user clears the scope by hand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTenantId, commit, pathname]);

  // ── Prune ids that cannot be true ────────────────────────────────────────────
  // A URL is user input: it can name a shop from another company, or a machine
  // that was decommissioned. Each check waits for its own list to arrive, so a
  // slow request never looks like a missing entity.
  useEffect(() => {
    if (!activeTenantId) return;
    const next: ScopeSelection = { ...urlSelection };

    if (next.companyId && companiesQuery.isSuccess && !findBySameId(companies, next.companyId)) {
      next.companyId = null;
      next.shopId = null;
      next.machineId = null;
    }
    if (next.machineId && machinesQuery.isSuccess) {
      const machine = findBySameId(machines, next.machineId);
      if (!machine) {
        next.machineId = null;
      } else if (next.shopId && !sameId(machine.shopId, next.shopId)) {
        next.machineId = null;
      } else if (!next.shopId && machine.shopId) {
        // A shared link can name a device and nothing else. Filling in the levels
        // above it is not "remembering something the user did not choose" — it is
        // where that device *is*, and without it the breadcrumbs would show a
        // terminal floating directly under the organization.
        next.shopId = machine.shopId;
      }
    }
    if (next.shopId && shopsQuery.isSuccess) {
      const shop = findBySameId(shops, next.shopId);
      if (!shop) {
        next.shopId = null;
        next.machineId = null;
      } else if (next.companyId && !sameId(shop.companyId, next.companyId)) {
        // The shop is real but belongs to a different company than the one in
        // scope. The company the user named wins; the stale shop goes — unless the
        // shop sits somewhere under that company, which is the nested case.
        const subtree = companySubtreeIds(tree, next.companyId);
        if (!subtree.some((id) => sameId(id, shop.companyId))) {
          next.shopId = null;
          next.machineId = null;
        }
      } else if (!next.companyId && shop.companyId) {
        next.companyId = shop.companyId;
      }
    }

    if (!sameSelection(next, urlSelection)) commit(next, 'replace');
  }, [
    activeTenantId,
    commit,
    companies,
    companiesQuery.isSuccess,
    machines,
    machinesQuery.isSuccess,
    shops,
    shopsQuery.isSuccess,
    tree,
    urlSelection,
  ]);

  const company = useMemo(
    () => findBySameId(companies, urlSelection.companyId),
    [companies, urlSelection.companyId],
  );
  const shop = useMemo(
    () => findBySameId(shops, urlSelection.shopId),
    [shops, urlSelection.shopId],
  );
  const machine = useMemo(
    () => findBySameId(machines, urlSelection.machineId),
    [machines, urlSelection.machineId],
  );

  const path = useMemo(() => companyPath(tree, urlSelection.companyId), [tree, urlSelection.companyId]);

  /**
   * Shops offered at company level cover the company **and everything under it**,
   * so selecting a parent does not hide a grandchild's branches from navigation.
   * Only client-side narrowing works this way; ids sent to the API stay single.
   */
  const shopOptions = useMemo(() => {
    if (!urlSelection.companyId) return shops;
    const subtree = companySubtreeIds(tree, urlSelection.companyId);
    return shops.filter((s) => subtree.some((id) => sameId(id, s.companyId)));
  }, [shops, tree, urlSelection.companyId]);

  const machineOptions = useMemo(() => {
    if (urlSelection.shopId) {
      return machines.filter((m) => sameId(m.shopId, urlSelection.shopId));
    }
    if (urlSelection.companyId) {
      const shopIds = shopOptions.map((s) => s.id);
      return machines.filter((m) => m.shopId && shopIds.some((id) => sameId(id, m.shopId)));
    }
    return machines;
  }, [machines, shopOptions, urlSelection.companyId, urlSelection.shopId]);

  const setCompany = useCallback(
    (companyId: string | null) => {
      if (isDrillRoute(pathname)) {
        router.push(companyId ? drillHrefFor('company', companyId) : '/dashboard');
        return;
      }
      // Deeper levels always go: a shop under company A is not a shop under B.
      commit({ companyId: companyId || null, shopId: null, machineId: null }, 'push');
    },
    [commit, pathname, router],
  );

  const setShop = useCallback(
    (shopId: string | null) => {
      if (isDrillRoute(pathname)) {
        router.push(
          shopId
            ? drillHrefFor('shop', shopId)
            : urlSelection.companyId
              ? drillHrefFor('company', urlSelection.companyId)
              : '/dashboard',
        );
        return;
      }
      if (!shopId) {
        commit({ ...urlSelection, shopId: null, machineId: null }, 'push');
        return;
      }
      const target = findBySameId(shops, shopId);
      // Naming a shop names its company too, so the breadcrumb reads the whole
      // path even when the shop was picked without a company in scope.
      commit(
        {
          companyId: target?.companyId ?? urlSelection.companyId ?? null,
          shopId,
          machineId: null,
        },
        'push',
      );
    },
    [commit, pathname, router, shops, urlSelection],
  );

  const setMachine = useCallback(
    (machineId: string | null) => {
      if (isDrillRoute(pathname)) {
        router.push(
          machineId
            ? drillHrefFor('machine', machineId)
            : urlSelection.shopId
              ? drillHrefFor('shop', urlSelection.shopId)
              : '/dashboard',
        );
        return;
      }
      if (!machineId) {
        commit({ ...urlSelection, machineId: null }, 'push');
        return;
      }
      const target = findBySameId(machines, machineId);
      const targetShop = target?.shopId ? findBySameId(shops, target.shopId) : undefined;
      commit(
        {
          companyId: targetShop?.companyId ?? urlSelection.companyId ?? null,
          shopId: target?.shopId ?? urlSelection.shopId ?? null,
          machineId,
        },
        'push',
      );
    },
    [commit, machines, pathname, router, shops, urlSelection],
  );

  const clear = useCallback(() => {
    // On a drill-down page "whole organization" means leaving the page, not
    // stripping the query the page is addressed by.
    if (isDrillRoute(pathname)) {
      router.push('/dashboard');
      return;
    }
    commit(EMPTY_SELECTION, 'push');
  }, [commit, pathname, router]);

  const setScope = useCallback(
    (next: Partial<ScopeSelection>, mode: 'push' | 'replace' = 'push') => {
      commit(
        {
          companyId: next.companyId ?? null,
          shopId: next.shopId ?? null,
          machineId: next.machineId ?? null,
        },
        mode,
      );
    },
    [commit],
  );

  const registerSpec = useCallback((id: string, next: PageScopeSpec | null) => {
    setSpecEntry((prev) => {
      if (next === null) return prev && prev.id === id ? null : prev;
      if (prev && prev.id === id && prev.spec === next) return prev;
      return { id, spec: next };
    });
  }, []);

  const resolution = useMemo(
    () => (spec ? resolvePageScope(spec, urlSelection) : null),
    [spec, urlSelection],
  );

  const scopeQuery = useMemo(() => {
    const params = new URLSearchParams();
    if (urlSelection.companyId) params.set(SCOPE_PARAM.company, urlSelection.companyId);
    if (urlSelection.shopId) params.set(SCOPE_PARAM.shop, urlSelection.shopId);
    if (urlSelection.machineId) params.set(SCOPE_PARAM.machine, urlSelection.machineId);
    const query = params.toString();
    return query ? `?${query}` : '';
  }, [urlSelection]);

  const value = useMemo<ScopeContextValue>(
    () => ({
      ...urlSelection,
      selection: urlSelection,
      level: scopeLevelOf(urlSelection),
      company,
      shop,
      machine,
      companyPath: path,
      companies,
      shops,
      machines,
      tree,
      shopOptions,
      machineOptions,
      companiesLoading: companiesQuery.isLoading,
      shopsLoading: shopsQuery.isLoading,
      machinesLoading: machinesQuery.isLoading,
      setCompany,
      setShop,
      setMachine,
      clear,
      setScope,
      spec,
      registerSpec,
      resolution,
      scopeQuery,
    }),
    [
      clear,
      companies,
      companiesQuery.isLoading,
      company,
      machine,
      machineOptions,
      machines,
      machinesQuery.isLoading,
      path,
      registerSpec,
      resolution,
      scopeQuery,
      setCompany,
      setMachine,
      setScope,
      setShop,
      shop,
      shopOptions,
      shops,
      shopsQuery.isLoading,
      spec,
      tree,
      urlSelection,
    ],
  );

  return <ScopeContext.Provider value={value}>{children}</ScopeContext.Provider>;
}

export function useScope(): ScopeContextValue {
  const ctx = useContext(ScopeContext);
  if (!ctx) {
    throw new Error('useScope must be used inside the dashboard ScopeProvider');
  }
  return ctx;
}

/**
 * Declare what the shared scope means to this page, and get back the selection
 * clamped to what the page can use.
 *
 * ```ts
 * const { effective, resolution } = usePageScope({ maxLevel: 'shop', minLevel: 'shop' });
 * ```
 *
 * The spec is registered with the provider so the scope bar can disable the
 * levels this page ignores, and `resolution` tells the page whether to render its
 * data, prompt for a deeper selection, or say the current level does not apply.
 */
export function usePageScope(spec: PageScopeSpec): {
  scope: ScopeContextValue;
  resolution: PageScopeResolution;
  effective: ScopeSelection;
  effectiveLevel: ScopeLevel;
  /** `resolution.status === 'ok'` — safe to run the page's queries. */
  ready: boolean;
} {
  const scope = useScope();
  const { registerSpec } = scope;
  const id = useId();

  // The spec is a literal at the call site, so compare by value rather than
  // identity or every render would re-register it.
  const key = JSON.stringify({
    maxLevel: spec.maxLevel,
    minLevel: spec.minLevel ?? null,
    unsupported: spec.unsupported ?? null,
    silent: spec.silent ?? false,
  });
  const stable = useMemo<PageScopeSpec>(() => JSON.parse(key) as PageScopeSpec, [key]);

  useEffect(() => {
    registerSpec(id, stable);
    return () => registerSpec(id, null);
  }, [id, registerSpec, stable]);

  const resolution = useMemo(() => resolvePageScope(stable, scope.selection), [stable, scope.selection]);

  return {
    scope,
    resolution,
    effective: resolution.effective,
    effectiveLevel: resolution.effectiveLevel,
    ready: resolution.status === 'ok',
  };
}

/**
 * Point the shared scope at the entity a drill-down route is about.
 *
 * `/dashboard/shops/<id>` is addressed by its path, not by the bar, so the bar
 * has to follow the route rather than the other way round — otherwise the
 * breadcrumbs above the page would name a different shop than the page shows.
 * The write is a `replace`, so drilling in does not leave a duplicate history
 * entry for the same view, and it only fires when the scope actually differs.
 */
export function useSyncScopeFromRoute(target: Partial<ScopeSelection>): void {
  const { selection, setScope } = useScope();
  const companyId = target.companyId ?? null;
  const shopId = target.shopId ?? null;
  const machineId = target.machineId ?? null;

  useEffect(() => {
    const next: ScopeSelection = { companyId, shopId, machineId };
    if (sameSelection(next, selection)) return;
    setScope(next, 'replace');
  }, [companyId, machineId, selection, setScope, shopId]);
}

/** Deepest level at or below `max` that the selection actually fills. */
export function narrowestLevel(selection: ScopeSelection, max: ScopeLevel): ScopeLevel {
  const level = scopeLevelOf(selection);
  return SCOPE_LEVEL_ORDER[level] <= SCOPE_LEVEL_ORDER[max] ? level : max;
}
