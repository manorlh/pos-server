'use client';

/**
 * A till anomaly card in plain Hebrew, with its numbers: the till's value against the
 * median of the other tills of its shop (or event). Static message keys only.
 */

import { useTranslations } from 'next-intl';
import { formatQuantity } from '@/lib/format';
import { agorot, type InsightCard } from '@/lib/insightsApi';

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

export interface AnomalyText {
  title: string;
  body: string;
  evidence?: string;
  where?: string;
}

export function useAnomalyText() {
  const t = useTranslations('insightsActions.anomalies');
  return (card: InsightCard): AnomalyText => {
    const p = card.params;
    const name = str(p.name);
    const where = str(p.groupName) || str(p.shopName) || undefined;
    switch (card.type) {
      case 'till_low_sales':
        return {
          title: t('lowSales.title', { name }),
          body:
            p.metric === 'documents'
              ? t('lowSales.bodyDocs', { value: formatQuantity(num(p.value)), median: formatQuantity(num(p.median)), pct: Math.round(num(p.ratioPct)), peers: num(p.peers), hours: formatQuantity(num(p.openHours)) })
              : t('lowSales.bodyNet', { value: agorot(num(p.value)), median: agorot(num(p.median)), pct: Math.round(num(p.ratioPct)), peers: num(p.peers), hours: formatQuantity(num(p.openHours)) }),
          where,
        };
      case 'till_avg_ticket':
        return {
          title: t('avgTicket.title', { name }),
          body: t(p.direction === 'high' ? 'avgTicket.bodyHigh' : 'avgTicket.bodyLow', {
            value: agorot(num(p.value)),
            median: agorot(num(p.median)),
            pct: Math.abs(Math.round(num(p.deviationPct))),
            peers: num(p.peers),
            sales: num(p.sales),
          }),
          where,
        };
      case 'till_cash': {
        const parts: string[] = [];
        if (p.shareFlag) parts.push(t('cash.share', { pct: formatQuantity(num(p.cashSharePct)), peers: formatQuantity(num(p.peersCashSharePct)) }));
        if (p.avgFlag) parts.push(t('cash.avg', { value: agorot(num(p.cashAvg)), peers: agorot(num(p.peersCashAvg)) }));
        const e = (p.evidence ?? {}) as Record<string, unknown>;
        const ev: string[] = [];
        if (num(e.refundsCount)) ev.push(t('cash.refunds', { n: num(e.refundsCount), peers: formatQuantity(num(e.peersRefundsCount)) }));
        if (num(e.voids)) ev.push(t('cash.voids', { n: num(e.voids), peers: formatQuantity(num(e.peersVoids)) }));
        if (num(e.cancels)) ev.push(t('cash.cancels', { n: num(e.cancels), peers: formatQuantity(num(e.peersCancels)) }));
        if (num(e.noSaleOpens)) ev.push(t('cash.opens', { n: num(e.noSaleOpens), peers: formatQuantity(num(e.peersNoSaleOpens)) }));
        return {
          title: t('cash.title', { name }),
          body: parts.join(' ') || t('cash.generic'),
          evidence: ev.length ? t('cash.evidence', { list: ev.join(', ') }) : undefined,
          where,
        };
      }
      default:
        return { title: name, body: card.type, where };
    }
  };
}
