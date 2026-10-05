'use client';

/**
 * One event's producer report (docs/SPEC_EVENTS.md §3): KPIs, the insights (alerts
 * first), the timeline (15 / 30 / 60 minutes, total or per till, with each till's average
 * per hour), the tills with their weak / idle badges, items, segmentation, the shifts,
 * the exceptions and the reconciliations against the Z and the card transmissions.
 *
 * Live while the event is a draft (refreshed every minute until it ends); once confirmed
 * it is the frozen snapshot, and says so. "ייצוא לאקסל" downloads the server's workbook,
 * "הדפסה" prints this page (the controls hide, sections keep together), "אישור האירוע"
 * freezes it after the checks, "השוואה" opens the compare view.
 */

import { use, useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowRight,
  FileSpreadsheet,
  GitCompareArrows,
  Loader2,
  Lock,
  Pencil,
  Printer,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { usePageScope, useSyncScopeFromRoute } from '@/lib/scope';
import { downloadEventExcel, eventErrorMessage, fetchEventReport, type BucketMinutes, type EventReport } from '@/lib/eventsApi';
import { clockLabel, countByLevel, durationText } from '@/lib/eventReport';
import { cn } from '@/lib/utils';
import { Card, IOS, InsightsSurface, Muted, SkeletonCard } from '@/components/dashboard/insights/ios';
import { EventFormDialog } from '@/components/dashboard/events/event-form-dialog';
import { ConfirmEventDialog } from '@/components/dashboard/events/confirm-event-dialog';
import { EventInsights, EventKpis, TenderSplit } from '@/components/dashboard/events/event-overview';
import { EventTimeline } from '@/components/dashboard/events/event-timeline';
import { EventExceptions, EventShifts, EventTills } from '@/components/dashboard/events/event-tills';
import { EventItems, EventSegments } from '@/components/dashboard/events/event-items';
import { EventReconcile } from '@/components/dashboard/events/event-reconcile';
import { EventSection, ReconcileChip, StatusChip } from '@/components/dashboard/events/event-parts';
import { Button } from '@/components/ui/button';

const WRITE_ROLES = new Set(['super_admin', 'distributor', 'company_manager', 'shop_manager']);
const LIVE_REFRESH_MS = 60_000;

/** Points the scope bar at the event's shop — mounted once the event is known, so loading never resets it. */
function ScopeFromEvent({ companyId, shopId }: { companyId: string | null; shopId: string }) {
  useSyncScopeFromRoute({ companyId, shopId });
  return null;
}

function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '').trim() || 'event';
}

export default function EventReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const t = useTranslations('events.page');
  const te = useTranslations('events');
  const router = useRouter();
  const role = useAuth((s) => s.user?.role);
  const canWrite = !!role && WRITE_ROLES.has(role);
  usePageScope({ maxLevel: 'shop', silent: true });

  const [bucket, setBucket] = useState<BucketMinutes>(30);
  const [editOpen, setEditOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [exporting, setExporting] = useState(false);

  const query = useQuery<EventReport>({
    queryKey: ['event-report', id],
    queryFn: () => fetchEventReport(id),
    refetchInterval: (q) => {
      const data = q.state.data;
      if (!data || data.frozen) return false;
      return Date.parse(data.event.endsAt) > Date.now() ? LIVE_REFRESH_MS : false;
    },
  });
  const report = query.data;
  const event = report?.event;

  // A print that started here leaves the report layout on until the dialog closes.
  useEffect(() => {
    const clear = () => {
      if (document.documentElement.dataset.print === 'report') delete document.documentElement.dataset.print;
    };
    window.addEventListener('afterprint', clear);
    return () => window.removeEventListener('afterprint', clear);
  }, []);

  const onExcel = async () => {
    if (!report) return;
    setExporting(true);
    try {
      await downloadEventExcel(id, bucket, `${safeFileName(`דוח אירוע - ${report.event.name}`)} - ${report.event.startDate}.xlsx`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('excelFailed'));
    } finally {
      setExporting(false);
    }
  };

  const onPrint = () => {
    document.documentElement.dataset.print = 'report';
    const previous = document.title;
    if (report) document.title = safeFileName(`${report.event.name} ${report.event.startDate}`);
    window.setTimeout(() => {
      window.print();
      document.title = previous;
    }, 50);
  };

  if (query.isLoading) {
    return (
      <InsightsSurface>
        <div className="space-y-3">
          <SkeletonCard className="h-20" />
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <SkeletonCard key={i} className="h-[104px]" />
            ))}
          </div>
          <SkeletonCard className="h-72" />
        </div>
      </InsightsSurface>
    );
  }
  if (query.isError || !report || !event) {
    return (
      <InsightsSurface>
        <Card className="flex items-center justify-between gap-3">
          <Muted>{eventErrorMessage(query.error, t('loadError'))}</Muted>
          <div className="flex gap-3">
            <button type="button" onClick={() => void query.refetch()} className="text-[15px] text-[#007AFF]">
              {te('retry')}
            </button>
            <Link href="/dashboard/events" className="text-[15px] text-[#007AFF]">
              {t('back')}
            </Link>
          </div>
        </Card>
      </InsightsSurface>
    );
  }

  const tz = report.timezone;
  const draft = event.status === 'draft';
  const live = draft && Date.parse(event.endsAt) > Date.now();
  const levels = countByLevel(report.insights);

  return (
    <InsightsSurface className="print:mx-0 print:rounded-none print:bg-white print:p-0">
      <ScopeFromEvent companyId={event.companyId} shopId={event.shopId} />
      {/* Title */}
      <div className="flex flex-wrap items-end justify-between gap-3 px-1">
        <div className="min-w-0 space-y-1">
          <Link href="/dashboard/events" className="flex items-center gap-1 text-[15px] text-[#007AFF] print:hidden">
            <ArrowRight className="h-4 w-4" aria-hidden />
            {t('back')}
          </Link>
          <p className="truncate text-[13px] font-semibold uppercase tracking-wide text-[#8E8E93]">
            {[event.shopName, event.producerName ? te('producer', { name: event.producerName }) : null].filter(Boolean).join(' · ')}
          </p>
          <h1 className="flex flex-wrap items-center gap-3 text-[34px] font-bold leading-tight tracking-tight">
            {event.name}
            <StatusChip status={event.status} />
          </h1>
          <p className="text-[15px] text-[#3C3C43] dark:text-[#EBEBF5]">
            {clockLabel(event.startsAt, tz, true)} – {clockLabel(event.endsAt, tz, true)} · {durationText(event.durationMinutes)} ·{' '}
            {te('tills', { count: event.machines.length })}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 print:hidden">
          <Button variant="outline" size="sm" onClick={() => void query.refetch()} disabled={query.isFetching || report.frozen} aria-label={t('refresh')}>
            <RefreshCw className={cn('h-4 w-4', query.isFetching && 'animate-spin')} aria-hidden />
          </Button>
          <Button variant="outline" size="sm" onClick={onExcel} disabled={exporting}>
            {exporting ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <FileSpreadsheet className="h-4 w-4" aria-hidden />}
            {t('excel')}
          </Button>
          <Button variant="outline" size="sm" onClick={onPrint}>
            <Printer className="h-4 w-4" aria-hidden />
            {t('print')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => router.push(`/dashboard/events?compare=${event.id}`)}>
            <GitCompareArrows className="h-4 w-4" aria-hidden />
            {t('compare')}
          </Button>
          {canWrite && draft ? (
            <>
              <Button variant="outline" size="sm" onClick={() => setEditOpen(true)}>
                <Pencil className="h-4 w-4" aria-hidden />
                {t('edit')}
              </Button>
              <Button size="sm" className="bg-[#34C759] text-white hover:bg-[#2DB14F]" onClick={() => setConfirmOpen(true)}>
                <ShieldCheck className="h-4 w-4" aria-hidden />
                {t('confirm')}
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {/* State banner */}
      <div className="mt-4">
        {report.frozen ? (
          <Card className="flex items-start gap-3">
            <Lock className="mt-0.5 h-5 w-5 shrink-0" style={{ color: IOS.green }} aria-hidden />
            <div className="text-[14px]">
              <p className="font-semibold">
                {t('frozen', { at: clockLabel(event.confirmedAt, tz, true), by: event.confirmedBy ?? '—' })}
              </p>
              <p className="text-[#8E8E93]">{event.confirmNote ? `${t('note')}: ${event.confirmNote} · ` : ''}{t('frozenHint')}</p>
            </div>
          </Card>
        ) : (
          <Card className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-[14px]">
              <p className="font-semibold">{live ? t('liveTitle') : t('draftTitle')}</p>
              <p className="text-[#8E8E93]">
                {t('generatedAt', { at: clockLabel(report.generatedAt, tz, true) })} · {live ? t('liveHint') : t('draftHint')}
              </p>
            </div>
            <div className="flex flex-wrap gap-2 text-[13px]">
              <span className="font-semibold" style={{ color: IOS.red }}>{t('alertsCount', { count: levels.alert })}</span>
              <span className="font-semibold" style={{ color: IOS.orange }}>{t('warningsCount', { count: levels.warning })}</span>
            </div>
          </Card>
        )}
      </div>

      <EventSection id="kpis" title={t('sections.kpis')}>
        <div className="space-y-3">
          <EventKpis report={report} />
          <TenderSplit report={report} />
        </div>
      </EventSection>

      <EventSection id="insights" title={t('sections.insights')}>
        <EventInsights insights={report.insights} />
      </EventSection>

      <EventSection id="timeline" title={t('sections.timeline')}>
        <EventTimeline report={report} bucket={bucket} onBucket={setBucket} />
      </EventSection>

      <EventSection id="tills" title={t('sections.tills')}>
        <EventTills report={report} />
      </EventSection>

      <EventSection id="items" title={t('sections.items')}>
        <EventItems report={report} />
      </EventSection>

      <EventSection id="segments" title={t('sections.segments')}>
        <EventSegments report={report} />
      </EventSection>

      <EventSection
        id="reconcile"
        title={t('sections.reconcile')}
        trailing={
          <span className="flex items-center gap-2">
            <ReconcileChip status={report.reconciliation.z.status} />
            <ReconcileChip status={report.reconciliation.transmissions.status} />
          </span>
        }
      >
        <EventReconcile report={report} />
      </EventSection>

      <EventSection id="shifts" title={t('sections.shifts')}>
        <EventShifts report={report} />
      </EventSection>

      <EventSection id="exceptions" title={t('sections.exceptions')}>
        <EventExceptions report={report} />
      </EventSection>

      <p className="mt-6 px-4 text-[12px] leading-relaxed text-[#8E8E93]">
        {t('footnote', {
          tz,
          weak: report.thresholds.weakTillPct,
          tip: report.thresholds.highTipPct,
          idle: report.thresholds.idleGapMinutes,
        })}
      </p>

      {canWrite && draft ? (
        <>
          <EventFormDialog
            open={editOpen}
            onOpenChange={setEditOpen}
            shopId={event.shopId}
            shopName={event.shopName ?? ''}
            event={event}
          />
          <ConfirmEventDialog event={event} open={confirmOpen} onOpenChange={setConfirmOpen} />
        </>
      ) : null}
    </InsightsSurface>
  );
}
