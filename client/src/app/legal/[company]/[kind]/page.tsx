import { notFound } from 'next/navigation';
import { isLegalKind } from '@/lib/legalDocs';
import { LegalPage } from './LegalPage';

/** A business's published legal page: accessibility statement, privacy, terms or cookie policy. */
export default async function PublicLegalRoute({
  params,
  searchParams,
}: {
  params: Promise<{ company: string; kind: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { company, kind } = await params;
  const query = await searchParams;
  if (!isLegalKind(kind)) notFound();
  const shop = typeof query.shop === 'string' ? query.shop : null;
  const lang = query.lang === 'en' ? 'en' : 'he';
  return <LegalPage companyId={company} kind={kind} shopId={shop} lang={lang} />;
}
