/**
 * The public card's calls (server/app/routers/business_cards.py `public_router`): no sign-in,
 * no cookies (`credentials: 'omit'`), a timeout on every call. Used by `/c/[slug]` (the page's
 * server render and the visitor's browser).
 */
import type { CardLang, PublicCardModel } from './businessCards';

export const PUBLIC_CARD_TIMEOUT_MS = 12_000;

export function publicCardApiBase(): string {
  return (process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000/api/v1').replace(/\/$/, '');
}

/** The server render may reach the API on an internal address (falls back to the public one). */
function serverApiBase(): string {
  return (process.env.API_INTERNAL_URL || publicCardApiBase()).replace(/\/$/, '');
}

export type PublicCardAnswer =
  | { kind: 'card'; card: PublicCardModel & { revision?: { number: number | null; publishedAt: string | null }; publicUrl?: string } }
  | { kind: 'redirect'; slug: string }
  | { kind: 'paused'; lang: CardLang; dir: 'rtl' | 'ltr' }
  | { kind: 'missing' }
  | { kind: 'error' };

/**
 * The published card. Cached by Next for 30 s per URL (slug + language — one card of one
 * tenant), so a publication shows within half a minute and no two cards share an entry.
 */
export async function fetchPublicCard(slug: string, lang?: string | null): Promise<PublicCardAnswer> {
  const q = lang === 'he' || lang === 'en' ? `?lang=${lang}` : '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUBLIC_CARD_TIMEOUT_MS);
  try {
    const res = await fetch(`${serverApiBase()}/public/cards/${encodeURIComponent(slug)}${q}`, {
      headers: { Accept: 'application/json' },
      credentials: 'omit',
      next: { revalidate: 30 },
      signal: controller.signal,
    });
    if (res.status === 404) return { kind: 'missing' };
    if (!res.ok) return { kind: 'error' };
    return (await res.json()) as PublicCardAnswer;
  } catch {
    return { kind: 'error' };
  } finally {
    clearTimeout(timer);
  }
}

/** First-party, cookie-free counting: a +1, nothing that identifies the visitor. Fire and forget. */
export function sendCardEvent(slug: string, body: { type: 'view' | 'action' | 'share' | 'copy_link'; action?: string }): void {
  try {
    void fetch(`${publicCardApiBase()}/public/cards/${encodeURIComponent(slug)}/events`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
      keepalive: true,
    }).catch(() => {});
  } catch {
    // Measurement never gets in the visitor's way.
  }
}

export function vcardUrl(slug: string, lang: CardLang): string {
  return `${publicCardApiBase()}/public/cards/${encodeURIComponent(slug)}/vcard?lang=${lang}`;
}

export type EnquiryAnswer =
  | { kind: 'saved'; duplicate: boolean }
  | { kind: 'invalid'; fields: Record<string, string> }
  | { kind: 'rate_limited' }
  | { kind: 'failed' };

/** Posts the enquiry. "saved" only when the server says it stored it (201 / 200 duplicate). */
export async function postEnquiry(slug: string, body: Record<string, unknown>): Promise<EnquiryAnswer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUBLIC_CARD_TIMEOUT_MS);
  try {
    const res = await fetch(`${publicCardApiBase()}/public/cards/${encodeURIComponent(slug)}/enquiries`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
      credentials: 'omit',
      cache: 'no-store',
      signal: controller.signal,
    });
    const data = (await res.json().catch(() => null)) as { status?: string; duplicate?: boolean; detail?: { code?: string; fields?: Record<string, string> } } | null;
    if ((res.status === 201 || res.status === 200) && data?.status === 'saved') return { kind: 'saved', duplicate: !!data.duplicate };
    if (res.status === 422 && data?.detail?.fields) return { kind: 'invalid', fields: data.detail.fields };
    if (res.status === 429) return { kind: 'rate_limited' };
    return { kind: 'failed' };
  } catch {
    return { kind: 'failed' };
  } finally {
    clearTimeout(timer);
  }
}
