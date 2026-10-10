'use client';

/**
 * "לוח בקרה והשוואות" — its old address. The comparisons live on the home page now
 * (`/dashboard?view=compare`: period against period, side by side, events, vouchers — and
 * this page's cashiers, hour by hour, open tables and card brands); this address keeps
 * working by sending the user there, with the scope and any other query it carried.
 * `replace`, so Back does not bounce back here.
 */

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Skeleton } from '@/components/ui/skeleton';

export default function CompareRedirectPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  useEffect(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('view', 'compare');
    router.replace(`/dashboard?${params.toString()}`);
  }, [router, searchParams]);
  return (
    <div className="space-y-4" aria-busy="true">
      <Skeleton className="h-8 w-40" />
      <Skeleton className="h-40 w-full rounded-2xl" />
    </div>
  );
}
