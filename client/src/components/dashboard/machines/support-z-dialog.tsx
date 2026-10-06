'use client';

/**
 * "הפקת Z מהענן (תמיכה)" on a till's page — support alone (pos-server
 * docs/SPEC_OFFLINE_TILL_Z.md §4.6). For a till destroyed, lost or permanently broken: it
 * closes the till's shifts and produces its Z from the documents the cloud holds. Nothing
 * is typed but the reason. Before confirming it says what will be closed, the documents and
 * totals, the Z number, the numbers the device printed and never sent, and when the till
 * was last seen; after, where the record and the Z are.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudCog, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatCurrency, formatDateTime } from '@/lib/format';
import {
  numberRanges,
  SUPPORT_Z_REASONS,
  supportZBlock,
  type SupportZPreview,
  type SupportZReason,
  type SupportZRecord,
} from '@/lib/supportZ';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

async function fetchPreview(machineId: string): Promise<SupportZPreview> {
  const { data } = await api.get<SupportZPreview>(`/machines/${machineId}/support-z`);
  return data;
}

async function produce(machineId: string, reason: SupportZReason, note: string): Promise<SupportZRecord> {
  const { data } = await api.post<SupportZRecord>(`/machines/${machineId}/support-z`, {
    reason,
    ...(note.trim() ? { note: note.trim() } : {}),
  });
  return data;
}

export function SupportZButton({ machineId, className }: { machineId: string; className?: string }) {
  const t = useTranslations('supportZ');
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" className={className} onClick={() => setOpen(true)}>
        <CloudCog className="h-4 w-4 me-1" aria-hidden />
        {t('button')}
      </Button>
      {open ? <SupportZDialog machineId={machineId} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function SupportZDialog({ machineId, onClose }: { machineId: string; onClose: () => void }) {
  const t = useTranslations('supportZ');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const preview = useQuery({ queryKey: ['support-z', machineId], queryFn: () => fetchPreview(machineId) });
  const [reason, setReason] = useState<SupportZReason | null>(null);
  const [note, setNote] = useState('');
  const [done, setDone] = useState<SupportZRecord | null>(null);
  const run = useMutation({
    mutationFn: () => produce(machineId, reason!, note),
    onSuccess: (record) => {
      setDone(record);
      void qc.invalidateQueries({ queryKey: ['machine', machineId] });
      void qc.invalidateQueries({ queryKey: ['machines'] });
      toast.success(t('done'));
    },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, tc('error'))),
  });

  const p = preview.data;
  const block = p ? supportZBlock(p) : null;
  return (
    <Dialog open onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        {preview.isLoading ? <Loader2 className="animate-spin mx-auto" aria-hidden /> : null}
        {preview.isError ? (
          <p className="text-sm text-destructive">{axiosErrorToToastMessage(preview.error, tc('error'))}</p>
        ) : null}

        {done ? (
          <div className="space-y-2 text-sm">
            <p className="font-medium">
              {done.zNumber != null ? t('resultTill', { number: done.zNumber }) : t('resultShop')}
            </p>
            {done.skippedNumbers.length > 0 ? (
              <p className="text-amber-700 dark:text-amber-300">
                {t('skipped', { numbers: numberRanges(done.skippedNumbers) })}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2 pt-1">
              {done.zReportId ? (
                <Link href={`/dashboard/z-reports/${done.zReportId}`} className={buttonVariants({ size: 'sm' })}>
                  {t('viewZ')}
                </Link>
              ) : null}
              <Link href="/dashboard/exceptions" className={buttonVariants({ size: 'sm', variant: 'outline' })}>
                {t('viewRecord')}
              </Link>
            </div>
          </div>
        ) : p ? (
          <div className="space-y-3 text-sm">
            <p>
              {t('lastSeen', { at: p.lastHeartbeatAt ? formatDateTime(p.lastHeartbeatAt) : t('never') })}
            </p>
            {block === 'online' ? <p className="text-destructive">{t('blockOnline')}</p> : null}
            {block === 'nothing' ? <p className="text-muted-foreground">{t('blockNothing')}</p> : null}
            <div className="rounded-md border p-2 space-y-1">
              <p className="font-medium">
                {t('shifts', {
                  count: p.shifts.length,
                  close: p.shifts.filter((s) => s.willClose).length,
                })}
              </p>
              <ul className="text-xs text-muted-foreground">
                {p.shifts.map((s) => (
                  <li key={s.id}>
                    {t('shiftLine', {
                      seq: s.sequenceNumber ?? '—',
                      state: s.willClose ? t('willClose') : t('closed'),
                      at: formatDateTime(s.openedAt),
                    })}
                  </li>
                ))}
              </ul>
              {p.documents ? (
                <p>
                  {t('documents', {
                    count: p.documents.count,
                    total: formatCurrency(p.documents.totalSales),
                    cash: formatCurrency(p.documents.totalCash),
                    card: formatCurrency(p.documents.totalCard),
                  })}
                </p>
              ) : null}
            </div>
            <p className="font-medium">
              {p.zMode.kind === 'till'
                ? p.zNumber != null
                  ? t('zNumber', { number: p.zNumber })
                  : t('zNone')
                : p.zMode.local
                  ? t('shopLocal')
                  : t('shopCloud')}
            </p>
            {p.skippedNumbers.length > 0 ? (
              <p className="text-amber-700 dark:text-amber-300">
                {t('skipped', { numbers: numberRanges(p.skippedNumbers) })}
              </p>
            ) : null}
            {p.documentCounters.gaps.map((g) => (
              <p key={g.series} className="text-amber-700 dark:text-amber-300">
                {t('counterGap', { series: g.series, from: g.from, to: g.to })}
              </p>
            ))}
            <fieldset className="space-y-1">
              <legend className="font-medium">{t('reason')}</legend>
              {SUPPORT_Z_REASONS.map((r) => (
                <label key={r} className="flex items-center gap-2">
                  <input type="radio" name="support-z-reason" checked={reason === r} onChange={() => setReason(r)} />
                  {t(`reasons.${r}`)}
                </label>
              ))}
            </fieldset>
            <textarea
              className="w-full rounded-md border bg-background p-2 text-sm"
              rows={2}
              maxLength={500}
              placeholder={t('notePlaceholder')}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t('audit')}</p>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {done ? t('close') : tc('cancel')}
          </Button>
          {!done ? (
            <Button
              variant="destructive"
              disabled={!p || block !== null || reason === null || run.isPending}
              onClick={() => run.mutate()}
            >
              {run.isPending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {t('confirm')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
