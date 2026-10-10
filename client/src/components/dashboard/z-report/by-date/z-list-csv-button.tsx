'use client';

/**
 * "ייצוא הרשימה (CSV)": every Z the list's filters match — not only the page on screen — one row
 * per Z with both dates, its kind, where, when it was produced and its totals. The list's own
 * window: with no dates, the last 90 days (as the list); with only "from", up to today.
 */
import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { FileDown } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { downloadCsv } from '@/lib/csv';
import { businessToday } from '@/lib/format';
import { csvFileName, listWindow, zLinesCsv } from '@/lib/zByDate';
import { fetchZSummaryByDate, type ZByDateFilters } from '@/lib/zByDateApi';
import { useZKindLabel } from './z-by-date-parts';

export function ZListCsvButton({
  from,
  to,
  closedFrom,
  closedTo,
  filters,
  disabled,
  className,
}: {
  from: string;
  to: string;
  closedFrom?: string;
  closedTo?: string;
  filters: ZByDateFilters;
  disabled?: boolean;
  className?: string;
}) {
  const t = useTranslations('zByDate');
  const tc = useTranslations('common');
  const tcsv = useTranslations('zByDate.csv');
  const kindLabel = useZKindLabel();
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      const window = listWindow(from, to, businessToday());
      const data = await fetchZSummaryByDate({ ...filters, ...window, closedFrom, closedTo });
      downloadCsv(csvFileName('list', data.window), zLinesCsv(data.zs, tcsv, kindLabel));
    } catch (e) {
      toast.error(axiosErrorToToastMessage(e, tc('error')));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Button size="sm" variant="outline" className={className} disabled={disabled || busy} onClick={() => void run()}>
      <FileDown className="h-4 w-4 me-1" aria-hidden />
      {t('exportListCsv')}
    </Button>
  );
}
