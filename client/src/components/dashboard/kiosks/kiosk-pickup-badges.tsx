'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { parsePickupQuery, pickupDateText } from '@/lib/kioskPickupSearch';
import { cn } from '@/lib/utils';

/**
 * Beside a document in a list: the kiosk order it paid ("הזמנת קיוסק A-17 · 09.10.2026" — the
 * same number comes back every day, so its business date), and, when the search could be a pickup
 * number ("17", "A-17"), why it found this one — the pickup number or the document number (or
 * amount) — so a "17" that found document 20000017 and kiosk order 17 reads as two kinds of hits.
 */
export function KioskPickupBadges({
  pickup,
  matchedBy,
  query,
  className,
}: {
  pickup?: { label: string; businessDate: string | null } | null;
  matchedBy?: ReadonlyArray<'document' | 'pickup'> | null;
  /** The search as typed: the reasons are shown only when it may be a pickup number. */
  query?: string | null;
  className?: string;
}) {
  const t = useTranslations('kiosks.pickupSearch');
  const ambiguous = !!query && parsePickupQuery(query) !== null;
  const byPickup = ambiguous && !!matchedBy?.includes('pickup');
  const byDocument = ambiguous && !!matchedBy?.includes('document');
  if (!pickup && !byPickup && !byDocument) return null;
  return (
    <span className={cn('inline-flex flex-wrap items-center gap-1 font-sans', className)}>
      {pickup ? (
        <Badge variant={byPickup ? 'default' : 'outline'} title={t('orderTitle')}>
          {t('order')}
          <bdi dir="ltr" className="ms-1 font-bold tabular-nums">{pickup.label}</bdi>
          {pickup.businessDate ? <span className="ms-1 opacity-80">· {pickupDateText(pickup.businessDate)}</span> : null}
        </Badge>
      ) : null}
      {byPickup ? <span className="text-[11px] text-muted-foreground">{t('byPickup')}</span> : null}
      {byDocument ? <span className="text-[11px] text-muted-foreground">{t('byDocument')}</span> : null}
    </span>
  );
}
