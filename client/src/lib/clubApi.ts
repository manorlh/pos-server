/**
 * "מועדון לקוחות" — the club's API (server/app/routers/club.py).
 *
 * Dashboard (company managers and up, per company; through the signed-in `api`):
 * the club, its public page, the versioned documents (terms / privacy / consent texts),
 * the QR sources and the members (phones masked; the full number only with a reason).
 *
 * Public (`/join/[token]`, no login): plain `fetch` to NEXT_PUBLIC_API_URL with no auth
 * headers and no cookies, a timeout on every call (no endless spinner), and the
 * server's structured errors turned into `PublicApiError`.
 */
import { api } from './api';
import type { JoinPageConfig, RegisterBody } from './clubSignup';

export type { JoinPageConfig } from './clubSignup';

// ── Dashboard ─────────────────────────────────────────────────────────────────

export interface ClubLanding {
  isPublished: boolean;
  businessName: string | null;
  logoUrl: string | null;
  headline: string | null;
  intro: string | null;
  benefits: string[];
  emailEnabled: boolean;
  birthdayEnabled: boolean;
  lastNameEnabled: boolean;
  signupBenefitEnabled: boolean;
  signupBenefitTitle: string | null;
  signupBenefitValidDays: number | null;
  successMessage: string | null;
  updatedAt: string | null;
}

export const CLUB_DOC_KINDS = ['terms', 'privacy', 'marketing_sms', 'marketing_email'] as const;
export type ClubDocKind = (typeof CLUB_DOC_KINDS)[number];

export interface ClubDocument {
  id: string;
  kind: ClubDocKind | string;
  version: number;
  status: 'draft' | 'active' | 'archived' | string;
  title: string;
  body: string;
  url: string | null;
  publishedAt: string | null;
  createdAt: string | null;
}

export const CLUB_SOURCE_KINDS = ['receipt', 'till', 'kiosk', 'poster', 'link'] as const;
export type ClubSourceKind = (typeof CLUB_SOURCE_KINDS)[number];

export interface ClubSource {
  id: string;
  token: string;
  url: string;
  label: string | null;
  sourceKind: ClubSourceKind | string;
  shopId: string | null;
  shopName: string | null;
  isActive: boolean;
  createdAt: string | null;
  signups: number;
}

export interface ClubOverview {
  companyName: string;
  club: { id: string; name: string; isActive: boolean } | null;
  landing?: ClubLanding | null;
  documents?: ClubDocument[];
  sources?: ClubSource[];
  counts?: Record<string, number>;
}

export const MEMBERSHIP_STATUSES = ['pending_phone_verification', 'active', 'suspended', 'closed'] as const;

export interface ClubMemberRow {
  membershipId: string;
  customerId: string;
  memberNumber: number;
  firstName: string | null;
  lastName: string | null;
  /** Masked by the server. */
  phone: string;
  phoneVerifiedAt: string | null;
  status: string;
  joinedAt: string | null;
  sourceShopId: string | null;
  sourceShopName?: string | null;
}

export interface ClubMemberDetail extends ClubMemberRow {
  email: string | null;
  birthday: string | null;
  consents: Record<string, { granted: boolean; version: number | null; at: string | null }>;
  consentHistory: Array<{ kind: string; granted: boolean; version: number | null; source: string | null; at: string | null }>;
  benefits: Array<{ id: string; title: string; status: string; kind: string; validUntil: string | null }>;
  audit: Array<{
    action: string;
    at: string | null;
    byUser: string | null;
    byUserName?: string | null;
    byMachine: string | null;
    byMachineName?: string | null;
    reason: string | null;
  }>;
  marketingSuppressed: boolean;
}

export async function fetchClub(companyId: string): Promise<ClubOverview> {
  const { data } = await api.get('/club', { params: { companyId } });
  return data;
}

/** Creates the club on first save; then renames / switches it on or off. */
export async function saveClub(companyId: string, body: { name?: string; isActive?: boolean }): Promise<ClubOverview> {
  const { data } = await api.put('/club', body, { params: { companyId } });
  return data;
}

export type ClubLandingPatch = Partial<Omit<ClubLanding, 'updatedAt'>>;

export async function saveClubLanding(companyId: string, patch: ClubLandingPatch): Promise<ClubLanding> {
  const { data } = await api.put('/club/landing', patch, { params: { companyId } });
  return data;
}

export async function createClubDocument(
  companyId: string,
  body: { kind: ClubDocKind; title: string; body: string; url?: string | null },
): Promise<ClubDocument> {
  const { data } = await api.post('/club/documents', body, { params: { companyId } });
  return data;
}

export async function publishClubDocument(id: string): Promise<ClubDocument> {
  const { data } = await api.post(`/club/documents/${encodeURIComponent(id)}/publish`);
  return data;
}

export async function createClubSource(
  companyId: string,
  body: { label?: string; sourceKind: ClubSourceKind; shopId?: string | null },
): Promise<ClubSource> {
  const { data } = await api.post('/club/sources', body, { params: { companyId } });
  return data;
}

export async function deactivateClubSource(id: string): Promise<ClubSource> {
  const { data } = await api.post(`/club/sources/${encodeURIComponent(id)}/deactivate`);
  return data;
}

export async function fetchClubMembers(
  companyId: string,
  query: { q?: string; status?: string; limit?: number; offset?: number },
): Promise<{ items: ClubMemberRow[]; total: number }> {
  const params: Record<string, string | number> = { companyId };
  if (query.q) params.q = query.q;
  if (query.status) params.status = query.status;
  if (query.limit) params.limit = query.limit;
  if (query.offset) params.offset = query.offset;
  const { data } = await api.get('/club/members', { params });
  return data;
}

export async function fetchClubMember(membershipId: string): Promise<ClubMemberDetail> {
  const { data } = await api.get(`/club/members/${encodeURIComponent(membershipId)}`);
  return data;
}

/** The full number — audited. The caller shows it briefly and drops it. */
export async function revealMemberPhone(membershipId: string, reason: string): Promise<{ phone: string }> {
  const { data } = await api.post(`/club/members/${encodeURIComponent(membershipId)}/reveal-phone`, { reason });
  return data;
}

export async function setMemberStatus(
  membershipId: string,
  status: 'active' | 'suspended' | 'closed',
  reason: string,
): Promise<ClubMemberRow> {
  const { data } = await api.post(`/club/members/${encodeURIComponent(membershipId)}/status`, { status, reason });
  return data;
}

// ── Public (no login) ─────────────────────────────────────────────────────────

/** A request that took longer than this shows "try again" instead of spinning. */
export const PUBLIC_TIMEOUT_MS = 15_000;

export class PublicApiError extends Error {
  readonly status: number;
  /** The server's code, or "timeout" / "network". */
  readonly code: string;
  readonly userMessage: string | null;
  readonly retryAfterSeconds: number | null;
  readonly attemptsLeft: number | null;
  readonly field: string | null;

  constructor(init: {
    status: number;
    code: string;
    userMessage?: string | null;
    retryAfterSeconds?: number | null;
    attemptsLeft?: number | null;
    field?: string | null;
  }) {
    super(init.code);
    this.name = 'PublicApiError';
    this.status = init.status;
    this.code = init.code;
    this.userMessage = init.userMessage ?? null;
    this.retryAfterSeconds = init.retryAfterSeconds ?? null;
    this.attemptsLeft = init.attemptsLeft ?? null;
    this.field = init.field ?? null;
  }
}

function publicApiBase(): string {
  return (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000/api/v1').replace(/\/$/, '');
}

function numberOrNull(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

async function toPublicError(res: Response): Promise<PublicApiError> {
  let detail: unknown = null;
  try {
    detail = ((await res.json()) as { detail?: unknown })?.detail ?? null;
  } catch {
    /* not JSON */
  }
  const headerRetry = numberOrNull(res.headers.get('Retry-After'));
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    const d = detail as Record<string, unknown>;
    return new PublicApiError({
      status: res.status,
      code: typeof d.code === 'string' && d.code ? d.code : `http_${res.status}`,
      userMessage: typeof d.userMessage === 'string' ? d.userMessage : null,
      retryAfterSeconds: numberOrNull(d.retryAfterSeconds) ?? headerRetry,
      attemptsLeft: numberOrNull(d.attemptsLeft),
      field: typeof d.field === 'string' ? d.field : null,
    });
  }
  // The generic IP throttle answers a plain "Too many requests".
  const code = res.status === 429 ? 'too_many_requests' : res.status === 404 ? 'page_unavailable' : `http_${res.status}`;
  return new PublicApiError({ status: res.status, code, retryAfterSeconds: headerRetry });
}

async function publicRequest<T>(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUBLIC_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${publicApiBase()}${path}`, {
      method: init.method ?? 'GET',
      headers: init.body !== undefined ? { Accept: 'application/json', 'Content-Type': 'application/json' } : { Accept: 'application/json' },
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    });
  } catch (err) {
    const aborted = (err as { name?: string })?.name === 'AbortError';
    throw new PublicApiError({ status: 0, code: aborted ? 'timeout' : 'network' });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw await toPublicError(res);
  return (await res.json()) as T;
}

const tokenPath = (token: string) => `/public/club/${encodeURIComponent(token)}`;

export function fetchJoinPage(token: string): Promise<JoinPageConfig> {
  return publicRequest<JoinPageConfig>(tokenPath(token));
}

export interface OtpStarted {
  challengeId: string;
  clientSession: string;
  expiresInSeconds: number;
  resendAfterSeconds: number;
  /** How many more codes this challenge may get. */
  sendsLeft?: number;
}

export function startJoinOtp(token: string, body: { phone: string; clientSession?: string | null }): Promise<OtpStarted> {
  return publicRequest<OtpStarted>(`${tokenPath(token)}/otp/start`, {
    method: 'POST',
    body: body.clientSession ? body : { phone: body.phone },
  });
}

export interface OtpResent {
  challengeId: string;
  expiresInSeconds: number;
  resendAfterSeconds: number;
  sendsLeft: number;
}

export function resendJoinOtp(token: string, body: { challengeId: string; clientSession: string }): Promise<OtpResent> {
  return publicRequest<OtpResent>(`${tokenPath(token)}/otp/resend`, { method: 'POST', body });
}

export function verifyJoinOtp(
  token: string,
  body: { challengeId: string; clientSession: string; code: string },
): Promise<{ registrationToken: string; expiresInSeconds: number }> {
  return publicRequest(`${tokenPath(token)}/otp/verify`, { method: 'POST', body });
}

export interface JoinResult {
  status: 'registered' | 'existing_member';
  firstName: string | null;
  memberNumber: number;
  membershipStatus: string;
  /** For the member's QR; null when the membership is not active. */
  memberToken: string | null;
  benefit: { title: string; validUntil: string | null; status: string } | null;
}

export function registerJoin(token: string, body: RegisterBody): Promise<JoinResult> {
  return publicRequest<JoinResult>(`${tokenPath(token)}/register`, { method: 'POST', body });
}

export function fetchUnsubscribeInfo(token: string): Promise<{ clubName: string | null }> {
  return publicRequest(`/public/club/unsubscribe/${encodeURIComponent(token)}`);
}

export function confirmUnsubscribe(token: string): Promise<{ ok: boolean }> {
  return publicRequest(`/public/club/unsubscribe/${encodeURIComponent(token)}`, { method: 'POST' });
}
