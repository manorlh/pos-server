'use client';

import { useTranslations } from 'next-intl';
import { zNumberOf, type ZNumberSource } from '@/lib/tillZ';
import type { ZReport, ZReportDetail } from '@/lib/types';

/**
 * A Z's number as a list shows it: the shop's number for a cloud Z, "קופה 2 · Z 12" for
 * a Z the till produced itself (it has no shop number), and an em dash — never a 0 or
 * "#null" — when there is none.
 */
export function useZNumberLabel() {
  const t = useTranslations('zReports');
  return (z: ZNumberSource): string => {
    const n = zNumberOf(z);
    if (n.kind === 'till') {
      return n.number != null
        ? t('tillZNumber', { till: n.till, number: n.number })
        : t('tillZNoNumber', { till: n.till });
    }
    return n.number != null ? String(n.number) : '—';
  };
}

/** A Z's title, as its page and its print show it. */
export function useZTitle() {
  const t = useTranslations('zReports');
  return (z: ZNumberSource): string => {
    const n = zNumberOf(z);
    if (n.kind === 'till') {
      return n.number != null
        ? t('detailsTill', { till: n.till, number: n.number })
        : t('detailsTillNoNumber', { till: n.till });
    }
    return n.number != null ? t('detailsNumbered', { number: n.number }) : t('details');
  };
}

/**
 * A Z detail as a number source: a till Z's register number is on its one section (the
 * list row may not carry it).
 */
export function zNumberSourceOf(z: ZReportDetail): ZNumberSource {
  const section = z.origin === 'till' ? (z.perMachine[0] ?? null) : null;
  return {
    ...z,
    posNumber: z.posNumber ?? section?.posNumber ?? null,
    machineName: z.machineName ?? section?.machineName ?? null,
    machineId: z.machineId ?? section?.machineId ?? null,
  };
}

/**
 * Who produced the Z: "הופק ע״י …", or — for a till Z made for a dashboard request with
 * nobody at the till — "הופק מרחוק". Nothing when the server does not say.
 */
export function ZProducedBy({ z, className }: { z: ZReport; className?: string }) {
  const t = useTranslations('zReports');
  const text = producedByText(z, t);
  return text ? <p className={className}>{text}</p> : null;
}

/** The same line as plain text, for the print. */
export function useZProducedBy() {
  const t = useTranslations('zReports');
  return (z: ZReport) => producedByText(z, t);
}

function producedByText(
  z: ZReport,
  t: ReturnType<typeof useTranslations<'zReports'>>,
): string | null {
  const remote = z.origin === 'till' && z.unattended;
  if (z.createdByName) {
    return remote
      ? t('producedRemotelyBy', { name: z.createdByName })
      : t('producedBy', { name: z.createdByName });
  }
  return remote ? t('producedRemotely') : null;
}
