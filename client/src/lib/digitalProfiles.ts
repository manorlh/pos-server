/**
 * "תפריט דיגיטלי" / "הזמנות אונליין" — the profiles lists (pos-server app/routers/presentation_profiles.py,
 * app/services/presentation_profiles.py). Self-contained, so `npm test` compiles it alone.
 *
 * A profile: kind (menu — view only / online — ordering), a target (company / shop / point of sale),
 * service types, languages, a status (draft → saved → published ⇄ paused → archived) and revisions;
 * a published revision never changes. A new profile starts as "התחל חדש", "תואם קיוסק" (the kiosk's
 * order linked, its selection derived live) or "העתק מ…" (another profile's content, its order copied once).
 */

export type ProfileKind = 'menu' | 'online';
export type ProfileStatus = 'draft' | 'saved' | 'published' | 'paused' | 'archived';
export type ProfileLevel = 'company' | 'shop' | 'area';
export type ServiceType = 'dine_in' | 'takeaway';
export type StartMode = 'new' | 'match_kiosk' | 'copy';

export const PROFILE_STATUSES: ProfileStatus[] = ['draft', 'saved', 'published', 'paused', 'archived'];
export const PROFILE_LEVELS: ProfileLevel[] = ['company', 'shop', 'area'];
export const SERVICE_TYPES: ServiceType[] = ['dine_in', 'takeaway'];
export const LANGUAGES = ['he', 'en', 'ar', 'ru'] as const;

/** The API prefix of each tab (each its own dashboard section). */
export const PROFILE_PREFIX: Record<ProfileKind, string> = {
  menu: '/digital-menu',
  online: '/online-ordering',
};

export interface ProfileRow {
  id: string;
  kind: ProfileKind;
  internalName: string;
  publicTitle: Record<string, string>;
  slug: string;
  targetLevel: ProfileLevel;
  targetId: string;
  targetName: string | null;
  companyId: string | null;
  shopId: string | null;
  areaId: string | null;
  serviceTypes: ServiceType[];
  languages: string[];
  defaultLanguage: string;
  priority: number;
  status: ProfileStatus;
  version: number;
  parentProfileId: string | null;
  createdFrom: { mode: StartMode; name?: string; revision?: number | null } | null;
  publishedRevision: number | null;
  publishedAt: string | null;
  hasDraftChanges: boolean;
  draftRevision: number | null;
  inheritedFields: number;
  localFields: number;
  updatedAt: string | null;
  updatedBy: string | null;
  counts?: { selected: number; visible: number };
}

/** The badge tone of a status: published green, paused amber, archived grey, the drafts neutral. */
export function statusTone(status: ProfileStatus): 'success' | 'warning' | 'muted' | 'neutral' {
  if (status === 'published') return 'success';
  if (status === 'paused') return 'warning';
  if (status === 'archived') return 'muted';
  return 'neutral';
}

/** What a row offers: pause a published one, resume a paused one, archive anything not archived. */
export function statusActions(status: ProfileStatus): ('pause' | 'resume' | 'archive' | 'unarchive')[] {
  switch (status) {
    case 'published':
      return ['pause', 'archive'];
    case 'paused':
      return ['resume', 'archive'];
    case 'archived':
      return ['unarchive'];
    default:
      return ['archive'];
  }
}

export interface CreateForm {
  internalName: string;
  title: string;
  targetLevel: ProfileLevel;
  targetId: string;
  serviceTypes: ServiceType[];
  languages: string[];
  defaultLanguage: string;
  priority: number;
  start: StartMode;
  kioskSource?: { level: 'company' | 'shop' | 'machine'; targetId: string } | null;
  copyFromId?: string | null;
}

/** What is missing before "צור" (the server checks again). */
export function createProblems(kind: ProfileKind, form: CreateForm): string[] {
  const out: string[] = [];
  if (!form.internalName.trim()) out.push('nameRequired');
  if (!form.targetId) out.push('targetRequired');
  if (kind === 'online' && form.serviceTypes.length === 0) out.push('serviceRequired');
  if (!form.languages.includes(form.defaultLanguage)) out.push('defaultLanguage');
  if (form.start === 'match_kiosk' && !form.kioskSource) out.push('kioskRequired');
  if (form.start === 'copy' && !form.copyFromId) out.push('copyRequired');
  return out;
}

/** The body of `POST {prefix}/profiles`. */
export function createBody(kind: ProfileKind, form: CreateForm): Record<string, unknown> {
  const start: Record<string, unknown> = { mode: form.start };
  if (form.start === 'match_kiosk' && form.kioskSource) {
    start.level = form.kioskSource.level;
    start.targetId = form.kioskSource.targetId;
  }
  if (form.start === 'copy' && form.copyFromId) start.profileId = form.copyFromId;
  const languages = [...new Set(form.languages.filter((l) => (LANGUAGES as readonly string[]).includes(l)))];
  return {
    internalName: form.internalName.trim(),
    publicTitle: form.title.trim() ? { [form.defaultLanguage]: form.title.trim() } : {},
    targetLevel: form.targetLevel,
    targetId: form.targetId,
    serviceTypes: kind === 'online' ? form.serviceTypes : [],
    languages: languages.length ? languages : ['he'],
    defaultLanguage: form.defaultLanguage,
    priority: Math.round(form.priority) || 0,
    start,
  };
}

/** The list's filters, as the server reads them. */
export function listParams(f: { companyId?: string; shopId?: string; status?: string; search?: string }): Record<string, string> {
  const out: Record<string, string> = {};
  if (f.companyId) out.companyId = f.companyId;
  if (f.shopId) out.shopId = f.shopId;
  if (f.status) out.status = f.status;
  if (f.search && f.search.trim()) out.search = f.search.trim();
  return out;
}

/** "3 / 40" — visible of selected; "—" before counts arrive. */
export function countsText(row: Pick<ProfileRow, 'counts'>): string {
  if (!row.counts) return '—';
  return `${row.counts.visible} / ${row.counts.selected}`;
}
