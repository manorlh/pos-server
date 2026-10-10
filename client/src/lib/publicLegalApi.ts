/**
 * The public side of "משפטי ונגישות" (server/app/routers/digital_legal.py `public_router`): the
 * published legal pages of a business and its cookie-policy version, for the `/legal/...` pages and
 * `PublicPageShell`. Plain `fetch` — no axios, no login, no credentials — with a timeout; only
 * published versions ever come back.
 */
import type { LegalKind } from './legalDocs';

export const PUBLIC_LEGAL_TIMEOUT_MS = 12_000;

export interface PublicLegalIndex {
  businessName: string;
  lang: string;
  documents: Partial<Record<LegalKind, { title: string; slug: string; version: number; publishedAt: string | null }>>;
  cookiePolicyVersion: number;
}

export interface PublicLegalPage {
  kind: LegalKind;
  slug: string;
  lang: string;
  title: string;
  body: string;
  version: number;
  publishedAt: string | null;
  source: 'shop' | 'company' | 'parent_company';
  businessName: string;
}

export class PublicLegalError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string) {
    super(code);
    this.name = 'PublicLegalError';
    this.status = status;
    this.code = code;
  }
}

function publicBase(): string {
  return (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000/api/v1').replace(/\/$/, '');
}

async function publicGet<T>(path: string, params: Record<string, string | null | undefined>): Promise<T> {
  const query = Object.entries(params)
    .filter(([, v]) => v)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v as string)}`)
    .join('&');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUBLIC_LEGAL_TIMEOUT_MS);
  try {
    const res = await fetch(`${publicBase()}${path}${query ? `?${query}` : ''}`, {
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      signal: controller.signal,
    });
    if (!res.ok) {
      let code = `http_${res.status}`;
      try {
        const body = (await res.json()) as { detail?: { code?: string } };
        if (typeof body?.detail?.code === 'string') code = body.detail.code;
      } catch {
        /* not JSON */
      }
      throw new PublicLegalError(res.status, code);
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof PublicLegalError) throw err;
    throw new PublicLegalError(0, controller.signal.aborted ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
}

export function fetchPublicLegalIndex(companyId: string, shopId?: string | null, lang = 'he'): Promise<PublicLegalIndex> {
  return publicGet(`/public/v1/legal/${encodeURIComponent(companyId)}`, { shopId, lang });
}

export function fetchPublicLegalPage(
  companyId: string,
  kind: LegalKind,
  shopId?: string | null,
  lang = 'he',
): Promise<PublicLegalPage> {
  return publicGet(`/public/v1/legal/${encodeURIComponent(companyId)}/${kind}`, { shopId, lang });
}
