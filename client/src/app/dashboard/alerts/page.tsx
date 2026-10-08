'use client';

/**
 * "התראות" — the alerts that go to the managers' phones (pos-server `/push/*`): what happened in
 * the scope (a till offline, a card terminal failing, a large void, the drawer opened without a
 * sale, a till barely selling, a target reached), each markable "טופל" here; what was sent to
 * my own devices (sent, held back by quiet hours / the rate limit, failed); and "הירשם להתראות
 * בטלפון" — this phone's subscription and my preferences.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BellRing, Check, ExternalLink, RotateCcw } from 'lucide-react';
import { usePageScope } from '@/lib/scope';
import { alertHref, historyTone, type AlertsFeed, type HistoryRow } from '@/lib/pushAlerts';
import { acknowledgeAlert, fetchAlertsFeed, fetchPushHistory } from '@/lib/pushAlertsApi';
import { formatShortDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Card, InsightsSurface, Muted, SectionHeader, Segmented, SkeletonCard } from '@/components/dashboard/insights/ios';
import { Button } from '@/components/ui/button';
import { PushAlertsSheet } from '@/components/dashboard/event-live/push-alerts-sheet';

const SEVERITY_COLOR = { high: '#FF3B30', medium: '#FF9500', low: '#8E8E93' } as const;
const TONE_COLOR = { sent: '#34C759', held: '#FF9500', failed: '#FF3B30' } as const;

export default function AlertsPage() {
  const t = useTranslations('phoneAlerts');
  const qc = useQueryClient();
  const { effective } = usePageScope({ maxLevel: 'machine', silent: true });
  const scope = { companyId: effective.companyId, shopId: effective.shopId, machineId: effective.machineId };
  const [show, setShow] = useState<'open' | 'all'>('open');
  const [sheet, setSheet] = useState(false);

  const feed = useQuery<AlertsFeed>({
    queryKey: ['alerts-feed', 'page', scope.companyId ?? null, scope.shopId ?? null, scope.machineId ?? null, show],
    queryFn: () => fetchAlertsFeed(scope, { open: show === 'open', days: show === 'open' ? 7 : 3, limit: 100 }),
    refetchInterval: 30_000,
  });
  const history = useQuery<HistoryRow[]>({ queryKey: ['push-history'], queryFn: () => fetchPushHistory(50), refetchInterval: 60_000 });
  const ack = useMutation({
    mutationFn: ({ id, done }: { id: string; done: boolean }) => acknowledgeAlert(id, done),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['alerts-feed'] }),
    onError: () => toast.error(t('ackFailed')),
  });

  return (
    <InsightsSurface>
      <div className="flex flex-wrap items-end justify-between gap-3 px-1">
        <div className="min-w-0 space-y-1">
          <h1 className="flex items-center gap-2 text-[28px] font-bold leading-tight tracking-tight">
            <BellRing className="size-7 text-[#FF3B30]" aria-hidden />
            {t('title')}
          </h1>
          <Muted>{t('subtitle')}</Muted>
        </div>
        <Button onClick={() => setSheet(true)}>
          <BellRing className="size-4" aria-hidden />
          {t('openSheet')}
        </Button>
      </div>
      <PushAlertsSheet scope={scope} open={sheet} onOpenChange={setSheet} />

      <div className="mt-5 space-y-3">
        <SectionHeader
          trailing={
            <Segmented
              value={show}
              onChange={(v) => setShow(v)}
              label={t('filter')}
              className="w-48"
              options={[
                { id: 'open' as const, label: t('openOnly') },
                { id: 'all' as const, label: t('all') },
              ]}
            />
          }
        >
          {t('feedTitle', { n: feed.data?.open ?? 0 })}
        </SectionHeader>
        {feed.isPending ? (
          <SkeletonCard className="h-32" />
        ) : (feed.data?.alerts ?? []).length === 0 ? (
          <Card>
            <p className="font-medium">{t('nothing')}</p>
            <Muted className="mt-1">{t('nothingHint')}</Muted>
          </Card>
        ) : (
          <Card className="divide-y p-0">
            {(feed.data?.alerts ?? []).map((a) => (
              <div key={a.id} className={cn('flex items-start gap-3 px-4 py-3', a.acknowledged && 'opacity-60')}>
                <span className="mt-1.5 size-2.5 shrink-0 rounded-full" style={{ background: SEVERITY_COLOR[a.severity] }} aria-hidden />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold">
                    {a.categoryLabel}
                    {a.machineName ? <span className="font-normal text-[#8E8E93]"> · {a.machineName}</span> : null}
                  </p>
                  <p className="text-sm">{[a.shopName, a.summary ?? a.kindLabel].filter(Boolean).join(' · ')}</p>
                  <Muted className="text-xs">
                    {formatShortDateTime(a.occurredAt)}
                    {a.acknowledged ? ` · ${t('handled')}${a.note ? ` — ${a.note}` : ''}` : ''}
                  </Muted>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Link href={alertHref(a)} aria-label={t('openAlert')} className="flex size-10 items-center justify-center rounded-lg text-[#007AFF] hover:bg-[#007AFF]/10">
                    <ExternalLink className="size-4" aria-hidden />
                  </Link>
                  {feed.data?.canAcknowledge !== false ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={ack.isPending}
                      onClick={() => ack.mutate({ id: a.id, done: !a.acknowledged })}
                    >
                      {a.acknowledged ? <RotateCcw className="size-4" aria-hidden /> : <Check className="size-4" aria-hidden />}
                      {a.acknowledged ? t('reopen') : t('ack')}
                    </Button>
                  ) : null}
                </div>
              </div>
            ))}
          </Card>
        )}

        <SectionHeader>{t('historyTitle')}</SectionHeader>
        {history.isPending ? (
          <SkeletonCard className="h-24" />
        ) : (history.data ?? []).length === 0 ? (
          <Card>
            <Muted>{t('historyEmpty')}</Muted>
          </Card>
        ) : (
          <Card className="divide-y p-0">
            {(history.data ?? []).map((h) => (
              <div key={h.id} className="flex items-start gap-3 px-4 py-3 text-sm">
                <span className="mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold text-white" style={{ background: TONE_COLOR[historyTone(h.status)] }}>
                  {h.statusLabel}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{h.title || t(`historyKind.${h.kind}`)}</p>
                  {h.body ? <p className="text-[#3C3C43] dark:text-[#EBEBF5]">{h.body}</p> : null}
                  <Muted className="text-xs">
                    {[h.at ? formatShortDateTime(h.at) : null, h.device, h.digestCount ? t('digestOf', { n: h.digestCount }) : null]
                      .filter(Boolean)
                      .join(' · ')}
                  </Muted>
                </div>
              </div>
            ))}
          </Card>
        )}
      </div>
    </InsightsSurface>
  );
}
