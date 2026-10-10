/**
 * "משפטי ונגישות" — the API of server/app/routers/digital_legal.py.
 *
 * Dashboard (through the signed-in `api`): the catalogue of kinds and fields, the documents of a
 * company or shop, drafts, "נבדק" + publish, previews, the publication check and the theme check.
 *
 * Public (the `/legal/...` pages and the footer, no login): ./publicLegalApi (re-exported here).
 */
import { api } from './api';
import type { A11yReport } from './a11yRules';
import type { ContrastResult, ThemeTokens } from './contrast';
import type { DigitalProduct, LegalKind } from './legalDocs';

// ── Dashboard ─────────────────────────────────────────────────────────────────

export interface LegalFieldDef {
  key: string;
  label: string;
  type: 'text' | 'textarea' | 'email' | 'phone' | 'date' | 'number' | 'select';
  required: boolean;
  hint?: string;
  options?: string[];
  min?: number;
  max?: number;
}

export interface LegalKindDef {
  kind: LegalKind;
  title: string;
  slug: string;
  summary: string;
  fields: LegalFieldDef[];
  templateVersion: number;
  template: string;
  mustAppear: string[];
}

export interface LegalCatalog {
  kinds: LegalKindDef[];
  draftBanner: string;
  disclaimer: string;
  languages: string[];
  requiredKinds: Record<DigitalProduct, LegalKind[]>;
}

export interface LegalProblem {
  code: string;
  field?: string;
  label?: string;
}

export interface LegalDocument {
  id: string;
  kind: LegalKind;
  lang: string;
  shopId: string | null;
  companyId: string;
  version: number | null;
  status: 'draft' | 'published' | 'archived';
  title: string;
  editSeq: number;
  reviewed: boolean;
  reviewedAt: string | null;
  reviewNote: string | null;
  publishedAt: string | null;
  templateKey: string | null;
  templateVersion: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  body?: string;
  fields?: Record<string, string>;
  problems?: LegalProblem[];
  preview?: string;
}

export interface LegalKindState {
  draft: LegalDocument | null;
  published: LegalDocument | null;
  history: LegalDocument[];
  effective: LegalDocument | null;
  effectiveSource: 'shop' | 'company' | 'parent_company' | null;
}

export interface LegalOverview {
  companyId: string;
  companyName: string;
  shopId: string | null;
  shopName: string | null;
  lang: string;
  kinds: Record<LegalKind, LegalKindState>;
  draftBanner: string;
  disclaimer: string;
}

export interface PublicationCheck {
  ok: boolean;
  product: DigitalProduct;
  blocking: Array<Record<string, unknown> & { code: string }>;
  warnings: Array<Record<string, unknown> & { code: string }>;
  legal: Record<string, { required: boolean; published: boolean; version: number | null; title: string }>;
  contrast: ContrastResult;
}

type Scope = { companyId: string; shopId?: string | null };

function scopeParams({ companyId, shopId }: Scope): Record<string, string> {
  return shopId ? { companyId, shopId } : { companyId };
}

export async function fetchLegalCatalog(): Promise<LegalCatalog> {
  const { data } = await api.get('/digital-legal/catalog');
  return data;
}

export async function fetchLegalOverview(scope: Scope): Promise<LegalOverview> {
  const { data } = await api.get('/digital-legal/documents', { params: scopeParams(scope) });
  return data;
}

export async function createLegalDraft(
  scope: Scope,
  body: { kind: LegalKind; start: 'template' | 'published' | 'inherited' },
): Promise<LegalDocument & { created: boolean }> {
  const { data } = await api.post('/digital-legal/documents', body, { params: scopeParams(scope) });
  return data;
}

export async function saveLegalDraft(
  id: string,
  body: { title?: string; body?: string; fields?: Record<string, string>; editSeq: number },
): Promise<LegalDocument> {
  const { data } = await api.put(`/digital-legal/documents/${id}`, body);
  return data;
}

export async function publishLegalDraft(
  id: string,
  body: { confirmReviewed: boolean; editSeq: number; reviewNote?: string },
): Promise<LegalDocument> {
  const { data } = await api.post(`/digital-legal/documents/${id}/publish`, body);
  return data;
}

export async function discardLegalDraft(id: string): Promise<void> {
  await api.delete(`/digital-legal/documents/${id}`);
}

export async function previewLegal(body: {
  kind: LegalKind;
  title?: string;
  body: string;
  fields: Record<string, string>;
}): Promise<{ preview: string; published: string; problems: LegalProblem[] }> {
  const { data } = await api.post('/digital-legal/preview', body);
  return data;
}

export async function fetchPublicationCheck(scope: Scope, product: DigitalProduct): Promise<PublicationCheck> {
  const { data } = await api.get('/digital-legal/publication-check', { params: { ...scopeParams(scope), product } });
  return data;
}

export async function checkThemeOnServer(theme: ThemeTokens): Promise<ContrastResult> {
  const { data } = await api.post('/digital-legal/theme-check', { theme });
  return data;
}

/** For the publish routes of the menu / ordering / card editors: what the gate expects. */
export type { A11yReport };

/** The server's structured error → `{code, userMessage, problems}`. */
export function legalApiError(err: unknown): { code: string; userMessage: string | null; problems: LegalProblem[] } {
  const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    const d = detail as Record<string, unknown>;
    return {
      code: typeof d.code === 'string' ? d.code : 'error',
      userMessage: typeof d.userMessage === 'string' ? d.userMessage : null,
      problems: Array.isArray(d.problems) ? (d.problems as LegalProblem[]) : [],
    };
  }
  return { code: typeof detail === 'string' ? detail : 'error', userMessage: null, problems: [] };
}

// The public fetchers (no axios, no login) live in ./publicLegalApi.
export {
  PublicLegalError,
  fetchPublicLegalIndex,
  fetchPublicLegalPage,
  type PublicLegalIndex,
  type PublicLegalPage,
} from './publicLegalApi';
