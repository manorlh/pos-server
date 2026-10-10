'use client';

/** One business card's editor (components/dashboard/business-cards/card-editor.tsx). */
import { useQuery } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useParams } from 'next/navigation';

import { CardEditor } from '@/components/dashboard/business-cards/card-editor';
import { NS } from '@/components/dashboard/business-cards/field-editors';
import { Skeleton } from '@/components/ui/skeleton';
import { getCard } from '@/lib/businessCardsApi';

export default function BusinessCardEditorPage() {
  const t = useTranslations(`${NS}.editor`);
  const { id } = useParams<{ id: string }>();
  const card = useQuery({
    queryKey: ['business-card', id],
    queryFn: () => getCard(id),
    enabled: !!id,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: (n, err) => n < 2 && (err as { response?: { status?: number } })?.response?.status !== 404,
  });
  if (card.isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-10 w-72" />
        <Skeleton className="h-[60vh] w-full" />
      </div>
    );
  }
  if (!card.data) {
    const status = (card.error as { response?: { status?: number } } | null)?.response?.status;
    return (
      <div className="space-y-2">
        <p className="text-sm text-muted-foreground">{status === 404 || status === 403 ? t('notFound') : t('loadFailed')}</p>
        <Link href="/dashboard/business-cards" className="text-sm underline">
          {t('back')}
        </Link>
      </div>
    );
  }
  return <CardEditor key={card.data.id} detail={card.data} />;
}
