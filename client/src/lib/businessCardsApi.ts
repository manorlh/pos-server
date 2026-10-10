/**
 * "כרטיסי ביקור" — the dashboard's calls (server/app/routers/business_cards.py), through the
 * signed-in `api`. Section `business_cards`: reads need view, everything else edit.
 */
import { api } from './api';
import type { CardDoc, CardIssue, CardLang, CardStatus, CardTemplate, CardType, Destinations, OrgDefaults } from './businessCards';

export interface CardRow {
  id: string;
  name: string;
  slug: string;
  publicPath: string;
  type: CardType;
  status: CardStatus;
  template: CardTemplate;
  title: string | null;
  companyId: string;
  companyName: string | null;
  shopId: string | null;
  shopName: string | null;
  areaId: string | null;
  areaName: string | null;
  parentCardId: string | null;
  parentName: string | null;
  ownerUserId: string | null;
  draftVersion: number;
  draftUpdatedAt: string | null;
  publishedRevision: { id: string; number: number; publishedAt: string | null } | null;
  hasUnpublishedChanges: boolean;
  publishedAt: string | null;
  pausedAt: string | null;
  archivedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  stats30d: Partial<Record<'view' | 'action' | 'share' | 'copy_link' | 'vcf' | 'enquiry', number>> | null;
}

export interface ChainParent {
  meta: { id: string; slug: string; type: CardType; name: string };
  doc: CardDoc;
  org: OrgDefaults;
  published: boolean;
}

export interface CardContext {
  card: { meta: { id: string; slug: string; type: CardType; name: string }; org: OrgDefaults };
  parents: ChainParent[];
  destinations: Destinations;
  today: string;
  publicBaseUrl: string;
}

export interface CardDetail extends CardRow {
  draft: CardDoc;
  context: CardContext;
  slugs: { slug: string; live: boolean; createdAt: string | null; retiredAt: string | null }[];
  children: { id: string; name: string; type: CardType; status: CardStatus }[];
}

/** The server's publication review answers the same issues the editor computes. */
export type CardIssueOut = CardIssue;

export interface PublishReview {
  issues: CardIssueOut[];
  blocked: boolean;
  changes: string[];
  inheritingCards: { id: string; name: string; type: CardType; status: CardStatus }[];
  unpublishedParents: { id: string; name: string }[];
}

export interface RevisionRow {
  id: string;
  number: number;
  kind: 'saved' | 'published';
  note: string | null;
  createdAt: string | null;
  publishedAt: string | null;
  createdBy: string | null;
  isLive: boolean;
  template: CardTemplate;
}

export interface CardStats {
  days: number;
  since: string;
  totals: Record<'view' | 'action' | 'share' | 'copy_link' | 'vcf' | 'enquiry', number>;
  actions: Record<string, number>;
  daily: Array<{ day: string } & Partial<Record<string, number>>>;
  method: string;
}

export interface EnquiryRow {
  id: string;
  cardId: string;
  cardName: string | null;
  name: string | null;
  phone: string | null;
  phoneDisplay: string | null;
  email: string | null;
  topic: string | null;
  message: string | null;
  lang: string | null;
  source: string | null;
  campaign: string | null;
  status: 'new' | 'handled' | 'archived';
  delivery: string;
  consentPrivacyUrl: string | null;
  consentedAt: string | null;
  handledAt: string | null;
  createdAt: string | null;
}

export interface CardListFilters {
  companyId?: string | null;
  shopId?: string | null;
  type?: string;
  status?: string;
  template?: string;
  q?: string;
  includeArchived?: boolean;
}

const clean = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== ''));

export async function listCards(f: CardListFilters): Promise<CardRow[]> {
  const { data } = await api.get<CardRow[]>('/business-cards', { params: clean({ ...f, includeArchived: f.includeArchived ? 'true' : undefined }) });
  return data;
}

export async function createCard(body: {
  type: CardType;
  companyId: string;
  shopId?: string | null;
  areaId?: string | null;
  name: string;
  template: CardTemplate;
  languages?: CardLang[];
  parentCardId?: string | null | 'auto';
  ownerUserId?: string | null;
  slug?: string;
}): Promise<CardDetail> {
  const { data } = await api.post<CardDetail>('/business-cards', clean(body as Record<string, unknown>));
  return data;
}

export async function getCard(id: string): Promise<CardDetail> {
  const { data } = await api.get<CardDetail>(`/business-cards/${id}`);
  return data;
}

export async function updateCardMeta(id: string, body: { name?: string; parentCardId?: string | null; ownerUserId?: string | null }): Promise<CardDetail> {
  const { data } = await api.patch<CardDetail>(`/business-cards/${id}`, body);
  return data;
}

export async function putDraft(id: string, draft: CardDoc, expectedVersion: number): Promise<{ draftVersion: number; draftUpdatedAt: string | null; draft: CardDoc; card: CardRow }> {
  const { data } = await api.put(`/business-cards/${id}/draft`, { draft, expectedVersion });
  return data;
}

export async function saveCheckpoint(id: string, expectedVersion: number, note?: string): Promise<{ card: CardRow; revision: { number: number } }> {
  const { data } = await api.post(`/business-cards/${id}/save`, { expectedVersion, note });
  return data;
}

export async function publishReview(id: string): Promise<PublishReview> {
  const { data } = await api.get<PublishReview>(`/business-cards/${id}/publish-review`);
  return data;
}

export async function publishCard(id: string, expectedVersion: number, note?: string): Promise<{ card: CardRow; revision: { number: number } }> {
  const { data } = await api.post(`/business-cards/${id}/publish`, { expectedVersion, note });
  return data;
}

export async function setCardState(id: string, action: 'pause' | 'resume' | 'archive' | 'restore'): Promise<CardRow> {
  const { data } = await api.post<CardRow>(`/business-cards/${id}/${action}`);
  return data;
}

export async function duplicateCard(id: string, name?: string): Promise<CardRow> {
  const { data } = await api.post<CardRow>(`/business-cards/${id}/duplicate`, clean({ name }));
  return data;
}

export async function renameSlug(id: string, slug: string): Promise<{ card: CardRow; slugs: CardDetail['slugs'] }> {
  const { data } = await api.put(`/business-cards/${id}/slug`, { slug });
  return data;
}

export async function slugAvailable(slug: string): Promise<{ valid: boolean; available: boolean }> {
  const { data } = await api.get('/business-cards/slug-available', { params: { slug } });
  return data;
}

export async function listRevisions(id: string): Promise<RevisionRow[]> {
  const { data } = await api.get<RevisionRow[]>(`/business-cards/${id}/revisions`);
  return data;
}

export async function publishRevision(id: string, revisionId: string): Promise<{ card: CardRow; revision: { number: number } }> {
  const { data } = await api.post(`/business-cards/${id}/revisions/${revisionId}/publish`, {});
  return data;
}

export async function restoreRevision(id: string, revisionId: string, expectedVersion: number): Promise<CardDetail> {
  const { data } = await api.post<CardDetail>(`/business-cards/${id}/revisions/${revisionId}/restore`, { expectedVersion });
  return data;
}

export async function cardStats(id: string, days: number): Promise<CardStats> {
  const { data } = await api.get<CardStats>(`/business-cards/${id}/stats`, { params: { days } });
  return data;
}

export async function previewVcard(id: string, draft: CardDoc, lang: CardLang): Promise<string> {
  const { data } = await api.post<{ vcard: string }>(`/business-cards/${id}/preview-vcard`, { draft, lang });
  return data.vcard;
}

export async function uploadCardMedia(file: File): Promise<{ url: string; kind: 'image' | 'pdf'; bytes: number }> {
  const form = new FormData();
  form.append('file', file);
  const { data } = await api.post('/business-cards/media', form, { headers: { 'Content-Type': undefined } });
  return data;
}

export async function listEnquiries(f: { cardId?: string; status?: string; q?: string }): Promise<{ items: EnquiryRow[]; counts: Record<string, number> }> {
  const { data } = await api.get('/business-cards/enquiries', { params: clean(f) });
  return data;
}

export async function updateEnquiry(id: string, status: EnquiryRow['status']): Promise<EnquiryRow> {
  const { data } = await api.patch<EnquiryRow>(`/business-cards/enquiries/${id}`, { status });
  return data;
}
