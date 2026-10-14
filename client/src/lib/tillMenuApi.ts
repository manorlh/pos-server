/**
 * "תפריט הקופה" — the server's routes (pos-server app/routers/till_menu.py). One value
 * (`hiddenMenuItems`), two ways in with their own writers:
 *
 * * `device` — `/till-menu-hide`: the device page's card.
 * * `design` — `/till-design/menu-hide`: "עיצוב קופה"'s card (read with the design's access).
 *
 * Both written by the same people: the super admin, a distributor and a company manager within their
 * scope — never a shop manager (read-only there).
 *
 * The rules and the Hebrew: lib/tillMenu.ts.
 */
import { api } from '@/lib/api';
import { savePayload, type MenuHideView, type MenuLevel } from '@/lib/tillMenu';

export type MenuHideRoute = 'device' | 'design';

const PATHS: Record<MenuHideRoute, string> = {
  device: '/till-menu-hide',
  design: '/till-design/menu-hide',
};

export const tillMenuKeys = {
  all: ['till-menu-hide'] as const,
  level: (route: MenuHideRoute, level: MenuLevel, id: string) => ['till-menu-hide', route, level, id] as const,
};

export async function fetchMenuHide(route: MenuHideRoute, level: MenuLevel, id: string): Promise<MenuHideView> {
  return (await api.get<MenuHideView>(PATHS[route], { params: { level, id } })).data;
}

/** The level's own list ([] = nothing hidden here), or null to inherit again. */
export async function saveMenuHide(
  route: MenuHideRoute,
  level: MenuLevel,
  id: string,
  draft: readonly string[] | null,
): Promise<MenuHideView> {
  return (await api.put<MenuHideView>(PATHS[route], savePayload(draft), { params: { level, id } })).data;
}
