import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';

import { PublicCard } from '@/components/business-cards/public-card';
import { cardWords, type CardLang } from '@/lib/businessCards';
import { fetchPublicCard } from '@/lib/businessCardsPublic';

/**
 * The public card: the published revision only (never a draft), resolved by the server. An old
 * path (a renamed slug) answers with a permanent redirect to the live one; a paused card says so
 * neutrally; an unknown or archived one is a plain "not found".
 */
type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

function one(v: string | string[] | undefined): string | null {
  const s = Array.isArray(v) ? v[0] : v;
  return s && s.length <= 60 ? s : null;
}

function cleanToken(v: string | null): string | null {
  return v && /^[a-z0-9_-]{1,32}$/i.test(v) ? v.toLowerCase() : null;
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { slug } = await params;
  const sp = await searchParams;
  const answer = await fetchPublicCard(slug, one(sp.lang));
  if (answer.kind !== 'card') return { title: 'כרטיס ביקור', robots: { index: false, follow: false } };
  const c = answer.card;
  const title = [c.header.title?.text, c.header.orgLine?.text].filter(Boolean).join(' · ');
  const about = c.sections.find((s) => s.kind === 'about');
  const description = about && about.kind === 'about' ? about.text.text.slice(0, 200) : (c.header.role?.text ?? undefined);
  const image = c.header.cover?.url ?? c.header.avatar?.url;
  return {
    title: title || 'כרטיס ביקור',
    description,
    robots: c.indexable ? { index: true, follow: true } : { index: false, follow: false },
    alternates: { canonical: `/c/${c.slug}` },
    openGraph: { title: title || undefined, description, images: image ? [image] : undefined, locale: c.lang === 'he' ? 'he_IL' : 'en_US' },
  };
}

export default async function PublicCardPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const sp = await searchParams;
  const lang = one(sp.lang);
  const answer = await fetchPublicCard(slug, lang);
  if (answer.kind === 'redirect') {
    const q = new URLSearchParams();
    for (const key of ['lang', 'src', 'c']) {
      const v = one(sp[key]);
      if (v) q.set(key, v);
    }
    permanentRedirect(`/c/${encodeURIComponent(answer.slug)}${q.size ? `?${q.toString()}` : ''}`);
  }
  if (answer.kind === 'missing') notFound();
  if (answer.kind === 'paused' || answer.kind === 'error') {
    const l: CardLang = answer.kind === 'paused' ? answer.lang : lang === 'en' ? 'en' : 'he';
    const w = cardWords(l);
    return (
      <main lang={l} dir={l === 'he' ? 'rtl' : 'ltr'} className="flex min-h-dvh items-center justify-center bg-slate-50 p-6 text-center text-slate-800">
        <p className="max-w-sm text-lg font-medium">{answer.kind === 'paused' ? w.paused : w.unavailable}</p>
      </main>
    );
  }
  return (
    <main>
      <PublicCard model={answer.card} source={cleanToken(one(sp.src))} campaign={cleanToken(one(sp.c))} />
    </main>
  );
}
