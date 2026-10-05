'use client';

/**
 * One till, in full enough to decide what to do next: its state, today's and the open
 * shift's takings, versions, card terminal, transmission, and the way into its pages.
 *
 * The body is one component; the page puts it in a side panel on a wide screen and in
 * a bottom sheet on a phone, so the two can never show different things.
 */

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { formatDistanceToNow } from 'date-fns';
import { he } from 'date-fns/locale';
import { Clock, Monitor, Receipt } from 'lucide-react';
import { formatCurrency, formatDateTime } from '@/lib/format';
import type { TillNode } from '@/lib/overview';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { MachineStatusLabel } from '@/components/dashboard/machine-status';
import { DeviceModelBadge } from '@/components/dashboard/machines/device-model';
import { TerminalSummary } from '@/components/dashboard/machines/card-terminal';
import { TransmissionSummary } from '@/components/dashboard/machines/card-transmission';
import { MachineShiftChip } from '@/components/dashboard/machines/machine-row';
import { RegisterPill, UpdateChip } from '@/components/dashboard/overview/overview-tree';

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 py-1">
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 text-end">{children}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1 rounded-lg border bg-muted/20 px-3 py-2 text-sm">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}

/** The heading line: register pill, name, model. The page wraps it in its own title element. */
export function TillDetailsTitle({ till }: { till: TillNode }) {
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1.5">
      <RegisterPill n={till.registerNumber} />
      <span className="truncate">{till.sales.name}</span>
      {till.live ? <DeviceModelBadge m={till.live} /> : null}
    </span>
  );
}

export function TillDetails({
  till,
  shopId,
  companyId,
}: {
  till: TillNode;
  shopId: string;
  companyId: string;
}) {
  const t = useTranslations('dashboard.overview.details');
  const m = till.live;
  const id = till.sales.id;
  const scopeQuery = new URLSearchParams({ company: companyId, shop: shopId, machine: id }).toString();
  const rollout = till.rollout;

  return (
    <div className="space-y-3">
      {!m ? <p className="text-xs text-muted-foreground">{t('noLive')}</p> : null}

      {m ? (
        <Section title={t('status')}>
          <Row label={t('status')}>
            <MachineStatusLabel m={m} />
          </Row>
          <Row label={t('lastSeen')}>
            {m.lastHeartbeatAt
              ? formatDistanceToNow(new Date(m.lastHeartbeatAt), { addSuffix: true, locale: he })
              : '—'}
          </Row>
        </Section>
      ) : null}

      <Section title={t('salesToday')}>
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-xl font-bold tabular-nums">{formatCurrency(till.sales.salesToday)}</span>
          <span className="text-xs text-muted-foreground">
            {t('documentsToday', { count: till.sales.documentsToday })}
          </span>
        </div>
      </Section>

      <Section title={t('shift')}>
        {m && m.shiftStatus === 'open' ? (
          <>
            <div className="py-1">
              <MachineShiftChip m={m} />
            </div>
            {m.openedBy ? <Row label={t('openedBy')}>{m.openedBy}</Row> : null}
            {m.openedAt ? <Row label={t('openedAt')}>{formatDateTime(m.openedAt)}</Row> : null}
            {till.sales.openShiftSales != null ? (
              <Row label={t('shiftSales')}>
                <span className="font-semibold tabular-nums">{formatCurrency(till.sales.openShiftSales)}</span>
                {till.sales.openShiftDocuments != null ? (
                  <span className="block text-xs text-muted-foreground">
                    {t('documentsToday', { count: till.sales.openShiftDocuments })}
                  </span>
                ) : null}
              </Row>
            ) : null}
          </>
        ) : m ? (
          <div className="py-1">
            <MachineShiftChip m={m} />
          </div>
        ) : (
          <p className="py-1 text-muted-foreground">{till.sales.openShiftId ? '—' : t('noShift')}</p>
        )}
      </Section>

      <Section title={t('versions')}>
        <Row label={t('currentVersion')}>
          <span dir="ltr">{rollout?.currentVersion ?? t('notReported')}</span>
        </Row>
        <Row label={t('targetVersion')}>
          <span dir="ltr">{rollout?.targetVersion ?? t('noTarget')}</span>
        </Row>
        {rollout?.releaseId ? (
          <Row label={t('updateStatus')}>
            <UpdateChip row={rollout} />
          </Row>
        ) : null}
      </Section>

      {m ? (
        <Section title={t('terminal')}>
          <TerminalSummary m={m} />
        </Section>
      ) : null}

      {m ? (
        <Section title={t('transmission')}>
          <TransmissionSummary m={m} />
        </Section>
      ) : null}

      <div className="grid grid-cols-3 gap-2">
        <Link
          href={`/dashboard/machines/${id}`}
          className={cn(buttonVariants({ variant: 'default' }), 'h-auto min-h-11 flex-col gap-0.5 py-1.5 text-xs')}
        >
          <Monitor aria-hidden />
          {t('links.machine')}
        </Link>
        <Link
          href={`/dashboard/transactions?${scopeQuery}`}
          className={cn(buttonVariants({ variant: 'outline' }), 'h-auto min-h-11 flex-col gap-0.5 py-1.5 text-xs')}
        >
          <Receipt aria-hidden />
          {t('links.transactions')}
        </Link>
        <Link
          href={`/dashboard/shifts?${scopeQuery}`}
          className={cn(buttonVariants({ variant: 'outline' }), 'h-auto min-h-11 flex-col gap-0.5 py-1.5 text-xs')}
        >
          <Clock aria-hidden />
          {t('links.shifts')}
        </Link>
      </div>
    </div>
  );
}
