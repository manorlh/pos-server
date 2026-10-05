'use client';

/**
 * Printing several Zs at one sitting — the ones ticked on the list, or a range of one
 * shop — in Z-number order, in either view:
 *
 * * till view: the server's 80 mm print documents on one roll, a cut line and a page
 *   break between them (`printTillReceipts`);
 * * A4 view: each Z's A4 document (`ZPrintDocument`) on pages of its own, printed from
 *   the dashboard page as the single Z page prints.
 *
 * The order, the scoping and the 200 cap are the server's (`GET /z-reports/print-documents`),
 * so a sequence never prints a Z the user could not open on its own.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  fetchZPrintDocuments,
  fetchZReport,
  type ZPrintDocumentsParams,
} from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import type { ZReportDetail } from '@/lib/types';
import { ZPrintDocument } from '@/components/dashboard/z-report/z-print-document';
import { printTillReceipts, zPrintTitle } from '@/components/dashboard/z-report/z-till-receipt';
import type { ZPrintView } from '@/components/dashboard/z-report/z-print-view-toggle';

export type ZSequenceTarget = { ids: string[] } | { range: Omit<ZPrintDocumentsParams, 'ids'> };

/** The server's cap on one print request (`PRINT_DOCUMENTS_MAX`). */
export const Z_PRINT_MAX = 200;

/** `fn` over `items`, at most `limit` at a time, results in the items' order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

function isTooMany(err: unknown): boolean {
  const detail = (err as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  return typeof detail === 'string' && detail.startsWith('too_many_z_reports');
}

interface A4Batch {
  docs: ZReportDetail[];
  printedAt: string;
  title: string;
}

export function useZSequencePrint() {
  const t = useTranslations('zReports.tillPrint');
  const [busy, setBusy] = useState(false);
  const [a4, setA4] = useState<A4Batch | null>(null);

  // Once the A4 documents have rendered, open the dialog; clear them when it closes.
  useEffect(() => {
    if (!a4) return;
    const parentTitle = document.title;
    document.title = a4.title;
    const after = () => setA4(null);
    window.addEventListener('afterprint', after);
    const timer = window.setTimeout(() => window.print(), 150);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('afterprint', after);
      document.title = parentTitle;
    };
  }, [a4]);

  const run = useCallback(
    async (target: ZSequenceTarget, view: ZPrintView, pdf = false): Promise<boolean> => {
      setBusy(true);
      try {
        const list = await fetchZPrintDocuments('ids' in target ? { ids: target.ids } : target.range);
        if (list.items.length === 0) {
          toast.info(t('rangeEmpty'));
          return false;
        }
        const title = zPrintTitle(list.items.map((i) => i.number));
        if (pdf) toast.info(t('pdfHint'));
        if (view === 'till') {
          await printTillReceipts(
            list.items.map((i) => i.document),
            title,
          );
          return true;
        }
        const loading = toast.loading(t('preparing', { count: list.items.length }));
        try {
          const docs = await mapLimit(
            list.items.map((i) => i.id),
            4,
            fetchZReport,
          );
          setA4({ docs, printedAt: new Date().toISOString(), title });
        } finally {
          toast.dismiss(loading);
        }
        return true;
      } catch (e) {
        toast.error(isTooMany(e) ? t('tooMany', { max: Z_PRINT_MAX }) : axiosErrorToToastMessage(e, t('loadError')));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [t],
  );

  return { run, busy, a4 };
}

/**
 * The A4 documents of a sequence, hidden on screen, one per printed page. The page that
 * hosts it hides its own content in print (`print:hidden`).
 */
export function ZA4Batch({ batch }: { batch: A4Batch | null }) {
  if (!batch) return null;
  return (
    <div className="hidden print:block">
      {batch.docs.map((z, i) => (
        <div key={z.id} style={i < batch.docs.length - 1 ? { breakAfter: 'page' } : undefined}>
          <ZPrintDocument z={z} printedAt={batch.printedAt} />
        </div>
      ))}
    </div>
  );
}
