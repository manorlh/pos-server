'use client';

/**
 * "התחשבנות" (the production vouchers spec §14): the settlement agreements with each one's totals
 * — vouchers charged, the amount at the production price, what is invoiced and what is not — and,
 * opened, its settlement (lib/prepaidVoucherExtrasApi.ts). Only with the `prepaid_voucher_settlement`
 * section (the page hides the tab); a new agreement and every change only when the server says
 * `editable`; amounts read "—" without the prices section.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, Plus } from 'lucide-react';
import { fetchAgreements, type AgreementStatus, type SettlementAgreementSummary } from '@/lib/prepaidVoucherExtrasApi';
import { Segmented } from '@/components/dashboard/insights/ios';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Empty, Tag, dayText, money, useExtrasErrorText } from '@/components/dashboard/prepaid-vouchers/extras/extras-common';
import { AgreementDialog } from './agreement-dialog';
import { AgreementDetail } from './agreement-detail';

type StatusChoice = AgreementStatus | 'all';

export function SettlementView() {
  const t = useTranslations('prepaidVouchers.settlement');
  const errorText = useExtrasErrorText();
  const [status, setStatus] = useState<StatusChoice>('active');
  const [openId, setOpenId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const list = useQuery({
    queryKey: ['prepaid-settlement', 'agreements', status],
    queryFn: () => fetchAgreements(status === 'all' ? {} : { status }),
  });

  if (openId) return <AgreementDetail id={openId} onBack={() => setOpenId(null)} />;

  const rows = list.data?.items ?? [];
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-muted-foreground">{t('intro')}</p>
        {list.data?.editable ? (
          <Button onClick={() => setCreating(true)}><Plus className="h-4 w-4" /> {t('new')}</Button>
        ) : null}
      </div>
      <Segmented value={status} onChange={setStatus} className="w-full max-w-sm" label={t('statusLabel')}
        options={[
          { id: 'active', label: t('statusFilter.active') },
          { id: 'closed', label: t('statusFilter.closed') },
          { id: 'all', label: t('statusFilter.all') },
        ]} />
      {list.isPending ? (
        <div className="space-y-2">
          <Skeleton className="h-20 w-full rounded-xl" />
          <Skeleton className="h-20 w-full rounded-xl" />
        </div>
      ) : list.isError ? (
        <p className="text-sm text-destructive">{errorText(list.error)}</p>
      ) : rows.length === 0 ? (
        <Empty>{t('empty')}</Empty>
      ) : (
        <ul className="space-y-2">
          {rows.map((a) => <AgreementCard key={a.id} a={a} onOpen={() => setOpenId(a.id)} />)}
        </ul>
      )}
      <AgreementDialog open={creating} initial={null} onOpenChange={setCreating} onSaved={(a) => setOpenId(a.id)} />
    </div>
  );
}

/** "קייטרינג אלון · פסטיבל הקיץ · 3 סדרות" — whom the agreement covers. */
export function useScopeText() {
  const t = useTranslations('prepaidVouchers.settlement');
  return (a: Pick<SettlementAgreementSummary, 'productionName' | 'eventName' | 'batchIds'>) =>
    [
      a.productionName ? t('scopeProduction', { name: a.productionName }) : null,
      a.eventName ? t('scopeEvent', { name: a.eventName }) : null,
      a.batchIds?.length ? t('scopeBatches', { n: a.batchIds.length }) : null,
    ].filter(Boolean).join(' · ');
}

/** "1/10/2026 – פתוח" */
export function usePeriodText() {
  const t = useTranslations('prepaidVouchers.settlement');
  return (from: string | null, to: string | null) =>
    !from && !to ? t('periodAll') : `${from ? dayText(from) : t('periodOpen')} – ${to ? dayText(to) : t('periodOpen')}`;
}

function AgreementCard({ a, onOpen }: { a: SettlementAgreementSummary; onOpen: () => void }) {
  const t = useTranslations('prepaidVouchers.settlement');
  const scopeText = useScopeText();
  const periodText = usePeriodText();
  const tt = a.totals;
  return (
    <li>
      <button type="button" onClick={onOpen}
        className="flex w-full flex-wrap items-start gap-3 rounded-xl border p-3 text-start transition-colors hover:bg-muted/50">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="flex flex-wrap items-center gap-2 font-medium">
            {a.name}
            <Tag tone={a.status === 'active' ? 'primary' : 'muted'}>{t(`status.${a.status}`)}</Tag>
            <Tag>{t(`basis.${a.billingBasis}`)}</Tag>
          </p>
          <p className="text-sm text-muted-foreground">{scopeText(a)}</p>
          <p className="text-xs text-muted-foreground">{t('period')}: {periodText(a.periodFrom, a.periodTo)}</p>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-4">
          <div><dt className="text-xs text-muted-foreground">{t('chargeable')}</dt><dd className="tabular-nums">{tt.chargeable}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t('amount')}</dt><dd className="tabular-nums">{money(tt.amountAgorot)}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t('invoiced')}</dt><dd className="tabular-nums">{tt.invoiced}</dd></div>
          <div><dt className="text-xs text-muted-foreground">{t('uninvoiced')}</dt><dd className="tabular-nums">{tt.uninvoiced}</dd></div>
        </dl>
        <ChevronLeft className="mt-1 h-4 w-4 shrink-0 text-muted-foreground rtl:rotate-0 ltr:rotate-180" aria-hidden />
      </button>
    </li>
  );
}
