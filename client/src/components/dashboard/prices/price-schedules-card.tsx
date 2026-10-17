'use client';

/**
 * "שינויים מתוזמנים" — a shop's bulk price changes with a start or an end (`GET /shops/{id}/price-schedules`):
 * pending ones can be cancelled, applied ones with an end can be put back now (`POST /price-schedules/{id}/cancel`).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarClock } from 'lucide-react';
import { api } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { scheduleAction, scheduleStatusLabel } from '@/lib/bulkPrice';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { PRICE_SCHEDULES_KEY } from './bulk-price-dialog';
import type { PriceSchedule } from './types';

const BADGE: Record<string, 'default' | 'secondary' | 'destructive' | 'outline'> = {
  pending: 'secondary',
  applied: 'default',
  reverted: 'outline',
  cancelled: 'outline',
  failed: 'destructive',
};

function when(iso: string | null | undefined): string {
  return iso ? new Date(iso).toLocaleString('he-IL', { dateStyle: 'short', timeStyle: 'short' }) : '—';
}

export function PriceSchedulesCard({ shopId }: { shopId: string }) {
  const qc = useQueryClient();
  const query = useQuery<{ schedules: PriceSchedule[] }>({
    queryKey: [PRICE_SCHEDULES_KEY, shopId],
    queryFn: () => api.get(`/shops/${shopId}/price-schedules`).then((r) => r.data),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api.post(`/price-schedules/${id}/cancel`).then((r) => r.data as PriceSchedule),
    onSuccess: (s) => {
      toast.success(s.status === 'reverted' ? 'המחירים הוחזרו' : 'השינוי בוטל');
      qc.invalidateQueries({ queryKey: [PRICE_SCHEDULES_KEY, shopId] });
      qc.invalidateQueries({ queryKey: ['product-prices'] });
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, 'הפעולה נכשלה')),
  });
  const rows = query.data?.schedules ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <CalendarClock className="h-4 w-4" aria-hidden />
          שינויים מתוזמנים
        </CardTitle>
      </CardHeader>
      <CardContent>
        {query.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : query.isError ? (
          <p className="text-sm text-destructive">{axiosErrorToToastMessage(query.error, 'הטעינה נכשלה')}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">אין שינויי מחיר מתוזמנים בסניף.</p>
        ) : (
          <ul className="divide-y">
            {rows.map((s) => {
              const action = scheduleAction(s.status, s.endsAt);
              return (
                <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
                  <Badge variant={BADGE[s.status] ?? 'outline'}>{scheduleStatusLabel(s.status)}</Badge>
                  <span className="font-medium">{s.label || 'שינוי מחירים'}</span>
                  <span className="text-muted-foreground">{s.itemCount} מחירים</span>
                  <span className="text-muted-foreground tabular-nums">
                    {when(s.startsAt)}
                    {s.endsAt ? ` עד ${when(s.endsAt)}` : ''}
                  </span>
                  {s.createdBy ? <span className="text-xs text-muted-foreground">ע״י {s.createdBy}</span> : null}
                  {s.error ? <span className="text-xs text-destructive">{s.error}</span> : null}
                  {action ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="ms-auto"
                      disabled={cancel.isPending}
                      onClick={() => {
                        const q = action === 'cancel' ? 'לבטל את השינוי המתוזמן?' : 'להחזיר עכשיו את המחירים שלפני השינוי?';
                        if (window.confirm(q)) cancel.mutate(s.id);
                      }}
                    >
                      {action === 'cancel' ? 'ביטול' : 'החזר עכשיו'}
                    </Button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
