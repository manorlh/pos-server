/**
 * "עיצובים שמורים לקיוסק" (P:/specs/kiosk-saved-designs.md) — pos-server app/routers/kiosk_designs.py and
 * `PUT /kiosks/settings/design`. A design is a partial kiosk layer of design groups only (look, layout,
 * attract, texts…); the nearest level that assigns one puts it right before its own overrides, and the
 * kiosks keep receiving one merged config (nothing changes on the devices).
 */
import { api } from './api';
import type { KioskConfig, KioskLayer } from './kioskConfig';
import type { KioskLevel, KioskSettings } from './kioskApi';

export {
  DEFAULT_DESIGN_GROUPS,
  DESIGN_SECTION_GROUPS,
  KIOSK_DESIGN_GROUPS,
  designSections,
  pickDesignLayer,
  type KioskDesignGroup,
  type KioskDesignGroupId,
} from './kioskDesignGroups';
import type { KioskDesignGroup, KioskDesignGroupId } from './kioskDesignGroups';

export interface KioskDesign {
  id: string;
  name: string;
  companyId: string;
  shopId: string | null;
  shopName: string | null;
  groups: KioskDesignGroupId[];
  overrides: KioskLayer;
  revision: number;
  archived: boolean;
  archivedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  assignmentCount: number;
}

export interface KioskDesignAuditRow {
  id: string;
  action: 'create' | 'update' | 'rename' | 'duplicate' | 'archive' | 'restore' | 'delete' | 'assign';
  designName: string | null;
  userName: string | null;
  detail: Record<string, unknown> | null;
  at: string | null;
}

export interface KioskDesignDetail extends KioskDesign {
  assignments: { level: string; id: string | null; name: string | null }[];
  kiosks: { machineId: string; name: string; via: string }[];
  /** The kiosk editor's settings shape: it inherits the defaults alone (`level: "design"`). */
  settings: Omit<KioskSettings, 'level'> & { level: 'design'; effective: KioskConfig };
  audit: KioskDesignAuditRow[];
  groupsCatalog: KioskDesignGroup[];
}

export interface KioskDesignList {
  companyId: string;
  groups: KioskDesignGroup[];
  designs: KioskDesign[];
}

export async function fetchKioskDesigns(scope: { companyId?: string | null; shopId?: string | null; archived?: boolean }): Promise<KioskDesignList> {
  const params: Record<string, string> = {};
  if (scope.shopId) params.shopId = scope.shopId;
  else if (scope.companyId) params.companyId = scope.companyId;
  if (scope.archived) params.archived = 'true';
  const { data } = await api.get<KioskDesignList>('/kiosk-designs', { params });
  return data;
}

export async function fetchKioskDesign(id: string): Promise<KioskDesignDetail> {
  const { data } = await api.get<KioskDesignDetail>(`/kiosk-designs/${id}`);
  return data;
}

export async function createKioskDesign(body: {
  name: string;
  groups: string[];
  companyId?: string | null;
  shopId?: string | null;
  config?: KioskConfig;
  overrides?: KioskLayer;
}): Promise<KioskDesignDetail> {
  const { data } = await api.post<KioskDesignDetail>('/kiosk-designs', body);
  return data;
}

export async function updateKioskDesign(
  id: string,
  body: { revision?: number; name?: string; groups?: string[]; overrides?: KioskLayer },
): Promise<KioskDesignDetail> {
  const { data } = await api.put<KioskDesignDetail>(`/kiosk-designs/${id}`, body);
  return data;
}

export async function duplicateKioskDesign(id: string, body: { name?: string; shopId?: string | null } = {}): Promise<KioskDesignDetail> {
  const { data } = await api.post<KioskDesignDetail>(`/kiosk-designs/${id}/duplicate`, body);
  return data;
}

export async function archiveKioskDesign(id: string, archived: boolean): Promise<KioskDesignDetail> {
  const { data } = await api.post<KioskDesignDetail>(`/kiosk-designs/${id}/${archived ? 'archive' : 'restore'}`);
  return data;
}

export async function deleteKioskDesign(id: string): Promise<void> {
  await api.delete(`/kiosk-designs/${id}`);
}

/** "עיצוב: <שם>" on a level: a design, "ללא עיצוב" (`off`), or inherit (neither). */
export async function assignKioskDesign(
  level: KioskLevel,
  id: string,
  body: { designId: string | null; off?: boolean; clearOverlapping?: boolean },
): Promise<KioskSettings> {
  const { data } = await api.put<KioskSettings>('/kiosks/settings/design', body, { params: { level, id } });
  return data;
}

/** The server's refusal code of a design call (409 / 422 `{detail: {code}}`), if any. */
export function designErrorCode(err: unknown): string | null {
  const detail = (err as { response?: { data?: { detail?: unknown } } } | null)?.response?.data?.detail;
  if (detail && typeof detail === 'object' && 'code' in detail) return String((detail as { code: unknown }).code);
  return typeof detail === 'string' ? detail : null;
}

const ERROR_TEXT: Record<string, string> = {
  kiosk_design_in_use: 'העיצוב משויך לקיוסקים — אפשר להעביר אותו לארכיון במקום למחוק.',
  kiosk_design_changed: 'העיצוב השתנה בינתיים — טענו אותו מחדש.',
  kiosk_design_name_taken: 'כבר יש עיצוב בשם הזה.',
  kiosk_design_out_of_scope: 'העיצוב שייך לסניף אחר.',
  kiosk_design_archived: 'העיצוב בארכיון — שחזרו אותו קודם.',
  kiosk_design_name_required: 'צריך שם לעיצוב.',
  kiosk_design_groups_required: 'בחרו לפחות קבוצה אחת.',
  kiosk_design_not_found: 'העיצוב לא נמצא.',
};

export function designErrorText(err: unknown, fallback: string): string {
  const code = designErrorCode(err);
  return (code && ERROR_TEXT[code]) || fallback;
}

export const LEVEL_LABEL: Record<string, string> = { company: 'חברה', shop: 'סניף', area: 'נקודת מכירה', machine: 'קיוסק' };
