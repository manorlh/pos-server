/**
 * What switching organization (tenant) does to the URL, and when a refused tenant
 * means "fall back to another one".
 *
 * Switching used to be undone within a second. The sidebar changed the active
 * tenant but left the URL alone, so `?company=…&shop=…` — or a drill-down path
 * such as `/dashboard/shops/<id>` — still named the *previous* organization's
 * entities. The page ran its queries with those ids under the new `X-Tenant-Id`,
 * the server answered `403 tenant_forbidden` (the shop is not in this tenant), and
 * the response interceptor read that as "this tenant is not yours": it reset the
 * active tenant to the first one in the list and reloaded. The switch was reverted
 * and, when the stale ids belonged to neither tenant, the page reloaded forever.
 *
 * Kept free of React and Next so the two rules can be tested on their own.
 */

export const SCOPE_PARAM = {
  company: 'company',
  shop: 'shop',
  machine: 'machine',
} as const;

/**
 * The three drill-down routes address an entity by path, not by query, so the
 * path itself names something that belongs to one tenant.
 */
export const DRILL_PREFIXES = [
  '/dashboard/companies/',
  '/dashboard/shops/',
  '/dashboard/machines/',
] as const;

export function isDrillRoute(pathname: string): boolean {
  return DRILL_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Where to stand once the active tenant has changed, or `null` when the current
 * URL names nothing tenant-specific and can stay as it is.
 *
 * A drill-down page is about one entity of the old organization, so it becomes
 * the overview. Any other page stays, minus the company / shop / machine params;
 * the rest of the query (a date range, a tab) is not tenant data and is kept.
 */
export function tenantSwitchTarget(pathname: string, search: string): string | null {
  if (isDrillRoute(pathname)) return '/dashboard';
  const params = new URLSearchParams(search);
  const scoped = Object.values(SCOPE_PARAM).filter((key) => params.has(key));
  if (scoped.length === 0) return null;
  for (const key of scoped) params.delete(key);
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

/**
 * After a `403 tenant_forbidden`, which tenant to fall back to — or `null` to leave
 * the active tenant alone.
 *
 * The server sends the same `tenant_forbidden` for two different refusals: "you
 * hold no membership in the tenant you sent" (`get_active_tenant_id`) and "the
 * entity you named is in another tenant" (`ensure_same_tenant`). Only the first is
 * a reason to change tenant. So the answer depends on the caller's tenants as the
 * server lists them *now* (`GET /tenants/mine`), not on the 403 alone:
 *
 * * a response to a request sent under a tenant that is no longer active says
 *   nothing about the active one — ignore it;
 * * if the active tenant is still listed, the tenant is fine and the id was not —
 *   ignore it, and let the page show its error;
 * * otherwise fall back to the first tenant still listed (none: `null`).
 */
export function tenantFallbackAfterForbidden(args: {
  requestTenantId: string | null;
  activeTenantId: string | null;
  tenantIds: readonly string[];
}): string | null {
  const { requestTenantId, activeTenantId, tenantIds } = args;
  if (requestTenantId && activeTenantId && requestTenantId !== activeTenantId) return null;
  if (activeTenantId && tenantIds.includes(activeTenantId)) return null;
  return tenantIds[0] ?? null;
}
