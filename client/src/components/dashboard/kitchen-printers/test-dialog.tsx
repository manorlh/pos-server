'use client';

/**
 * A test print and how it went, per till: the jobs `POST /printers/{id}/test` made,
 * polled every two seconds until each is printed, failed or expired.
 *
 * Opened only on demand ("תוצאות בדיקה" on the printer's row) — never after a send: a test is
 * fire-and-forget, followed in the background by "פקודות שנשלחו" (lib/deviceCommandsStore.ts).
 */

import { useTranslations } from 'next-intl';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Clock, ListChecks, XCircle } from 'lucide-react';
import { fetchPrinterTestJobs, type KitchenPrinter, type PrintJob } from '@/lib/kitchenPrintersApi';
import { useDeviceCommandsStore } from '@/lib/deviceCommandsStore';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const FINISHED = new Set(['done', 'failed', 'expired']);

function StatusLine({ job }: { job: PrintJob }) {
  const t = useTranslations('kitchenPrinters.test');
  const icon =
    job.status === 'done' ? (
      <CheckCircle2 className="h-4 w-4 text-green-600" aria-hidden />
    ) : FINISHED.has(job.status) ? (
      <XCircle className="h-4 w-4 text-destructive" aria-hidden />
    ) : (
      <Clock className="h-4 w-4 text-muted-foreground" aria-hidden />
    );
  const label =
    job.status === 'done'
      ? t('done')
      : job.status === 'failed'
        ? t('failed')
        : job.status === 'expired'
          ? t('expired')
          : job.status === 'printing'
            ? t('printing')
            : t('pending');
  return (
    <li className="flex items-start gap-2 text-sm">
      {icon}
      <div>
        <div className="font-medium">{job.targetMachineName ?? job.targetMachineId}</div>
        <div className="text-muted-foreground">
          {label}
          {job.error ? ` — ${job.error}` : ''}
        </div>
      </div>
    </li>
  );
}

/** The job ids ("a,b") of the printer's latest test this session sent (newest first in the store), or null. */
function useLastTestJobIds(printerId: string): string | null {
  return useDeviceCommandsStore(
    (s) => s.commands.find((c) => c.kind === 'printer_test' && c.ref?.printerId === printerId)?.ref?.jobIds ?? null,
  );
}

/** "תוצאות בדיקה": the per-till results of the printer's latest test, opened on demand. */
export function TestResultsLink({ printerId, onOpen }: { printerId: string; onOpen: (jobIds: string[]) => void }) {
  const t = useTranslations('kitchenPrinters.test');
  const jobIds = useLastTestJobIds(printerId);
  if (!jobIds) return null;
  return (
    <button
      type="button"
      onClick={() => onOpen(jobIds.split(',').filter(Boolean))}
      className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-xs font-normal text-primary underline-offset-2 hover:underline"
    >
      <ListChecks className="size-3.5" aria-hidden />
      {t('results')}
    </button>
  );
}

export function TestDialog({
  printer,
  jobIds,
  onClose,
}: {
  printer: KitchenPrinter;
  jobIds: string[];
  onClose: () => void;
}) {
  const t = useTranslations('kitchenPrinters.test');
  const { data = [] } = useQuery({
    queryKey: ['kitchen-printer-test-jobs', printer.id],
    queryFn: () => fetchPrinterTestJobs(printer.id),
    refetchInterval: (query) => {
      const jobs = (query.state.data ?? []).filter((j) => jobIds.includes(j.id));
      return jobs.length > 0 && jobs.every((j) => FINISHED.has(j.status)) ? false : 2000;
    },
  });
  const jobs = data.filter((j) => jobIds.includes(j.id));

  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('title', { name: printer.name })}</DialogTitle>
          <DialogDescription>{t('hint')}</DialogDescription>
        </DialogHeader>
        {jobs.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('waiting')}</p>
        ) : (
          <ul className="space-y-2">
            {jobs.map((job) => (
              <StatusLine key={job.id} job={job} />
            ))}
          </ul>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t('close')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
