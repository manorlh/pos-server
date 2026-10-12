/**
 * "תצורת עבודה של הסניף" — the server's calls (spec shop-work-config.md §7ב). The types, the
 * rules and the Hebrew are lib/shopWorkProfile.ts (pure, so `npm test` compiles it alone).
 */
import { api } from './api';
import {
  normalizeProfile,
  normalizeView,
  templatesOrFallback,
  type WorkProfile,
  type WorkProfileTemplate,
  type WorkProfileView,
} from './shopWorkProfile';

export const workProfileKeys = {
  templates: ['work-profile', 'templates'] as const,
  shop: (shopId: string) => ['work-profile', 'shop', shopId] as const,
};

/**
 * `GET /work-profile/templates`. When the server has no such route yet (or the call fails) the
 * local copy of the six templates — `local: true`, so the step can say so.
 */
export async function getTemplates(): Promise<{ templates: WorkProfileTemplate[]; local: boolean }> {
  try {
    const { data } = await api.get<unknown>('/work-profile/templates');
    return templatesOrFallback(data);
  } catch {
    return templatesOrFallback(null);
  }
}

/** `GET /shops/{id}/work-profile`: the profile, each field's status and what the user may change. */
export async function getWorkProfile(shopId: string): Promise<WorkProfileView> {
  const { data } = await api.get<unknown>(`/shops/${shopId}/work-profile`);
  return normalizeView(data);
}

/**
 * `PUT /shops/{id}/work-profile`: saves, applies what needs no till, and answers as `GET`.
 * A blocked field (an open till, a Z in progress) is a 409 with the reason — nothing changed.
 */
export async function putWorkProfile(shopId: string, profile: WorkProfile): Promise<WorkProfileView> {
  const { data } = await api.put<unknown>(`/shops/${shopId}/work-profile`, { profile: normalizeProfile(profile) });
  return normalizeView(data);
}
