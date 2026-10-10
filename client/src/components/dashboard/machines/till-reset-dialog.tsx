'use client';

/**
 * "איפוס נתוני קופה (תמיכה)" on a till's page — support alone (pos-server
 * docs/SPEC_OFFLINE_TILL_Z.md §4.7). The owner: "איפוס זדים קורה רק מהענן ובאמצעות סופר אדמין
 * בתמיכה" — the till has no reset of its own. Before sending: what the till still holds
 * unsynced, the Zs it keeps, and that no counter moves. The command goes to the till on its
 * heartbeat; the till carries it out under its guards or refuses, and reports.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eraser, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatDateTime } from '@/lib/format';
import {
  keptZRanges,
  TILL_RESET_KINDS,
  tillResetBlock,
  type TillResetKind,
  type TillResetPreview,
  type TillResetRecord,
} from '@/lib/tillReset';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

async function fetchPreview(machineId: string): Promise<TillResetPreview> {
  const { data } = await api.get<TillResetPreview>(`/machines/${machineId}/till-reset`);
  return data;
}

async function order(machineId: string, kind: TillResetKind, reason: string): Promise<TillResetRecord> {
  const { data } = await api.post<TillResetRecord>(`/machines/${machineId}/till-reset`, {
    kind,
    reason: reason.trim(),
  });
  return data;
}

export function TillResetButton({ machineId, className }: { machineId: string; className?: string }) {
  const t = useTranslations('tillReset');
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="sm" variant="outline" className={className} onClick={() => setOpen(true)}>
        <Eraser className="h-4 w-4 me-1" aria-hidden />
        {t('button')}
      </Button>
      {open ? <TillResetDialog machineId={machineId} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function TillResetDialog({ machineId, onClose }: { machineId: string; onClose: () => void }) {
  const t = useTranslations('tillReset');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const preview = useQuery({ queryKey: ['till-reset', machineId], queryFn: () => fetchPreview(machineId) });
  const [kind, setKind] = useState<TillResetKind | null>(null);
  const [reason, setReason] = useState('');
  const [sent, setSent] = useState<TillResetRecord | null>(null);
  const run = useMutation({
    mutationFn: () => order(machineId, kind!, reason),
    onSuccess: (record) => {
      setSent(record);
      void qc.invalidateQueries({ queryKey: ['machine', machineId] });
      void qc.invalidateQueries({ queryKey: ['machines'] });
      toast.success(t('sent'));
    },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, tc('error'))),
  });

  const p = preview.data;
  const block = p ? tillResetBlock(p, kind, reason) : 'kind';
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

        {sent ? (
          <div className="space-y-2 text-sm">
            <p className="font-medium">{t('sentBody', { kind: sent.kindText })}</p>
            <Link href="/dashboard/exceptions" className={buttonVariants({ size: 'sm', variant: 'outline' })}>
              {t('viewRecord')}
            </Link>
          </div>
        ) : p ? (
          <div className="space-y-3 text-sm">
            <p>
              {t('lastSeen', { at: p.lastHeartbeatAt ? formatDateTime(p.lastHeartbeatAt) : t('never') })}
            </p>
            {p.pending ? (
              <p className="text-destructive">
                {t('pending', { kind: p.pending.kindText, by: p.pending.by, at: formatDateTime(p.pending.requestedAt) })}
              </p>
            ) : null}
            <div className="rounded-md border p-2 space-y-1">
              <p className="font-medium">{t('unsyncedTitle')}</p>
              <p>
                {t('unsynced', {
                  outbox: p.unsynced.outbox ?? 0,
                  zs: p.unsynced.offlineTillZs ?? 0,
                })}
              </p>
              {(p.unsynced.outbox ?? 0) > 0 ? <p className="text-amber-700 dark:text-amber-300">{t('willRefuse')}</p> : null}
            </div>
            <div className="rounded-md border p-2 space-y-1">
              <p className="font-medium">{t('keptTitle')}</p>
              <p>
                {p.keptZs.numbers.length > 0
                  ? t('keptZs', { days: p.keptZs.days, numbers: keptZRanges(p.keptZs.numbers) })
                  : t('keptNone', { days: p.keptZs.days })}
              </p>
              {p.keptZs.awaitingOnTill > 0 ? <p>{t('keptAwaiting', { count: p.keptZs.awaitingOnTill })}</p> : null}
              <p>{t('countersStay', { z: p.counters.lastTillZNumber })}</p>
            </div>
            <fieldset className="space-y-1">
              <legend className="font-medium">{t('kind')}</legend>
              {TILL_RESET_KINDS.map((k) => (
                <label key={k} className="flex items-start gap-2">
                  <input
                    type="radio"
                    name="till-reset-kind"
                    className="mt-1"
                    checked={kind === k}
                    onChange={() => setKind(k)}
                  />
                  <span>
                    {t(`kinds.${k}`)}
                    <span className="block text-xs text-muted-foreground">{t(`kindHints.${k}`)}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <textarea
              className="w-full rounded-md border bg-background p-2 text-sm"
              rows={2}
              maxLength={500}
              placeholder={t('reasonPlaceholder')}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">{t('audit')}</p>
          </div>
        ) : null}

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {sent ? t('close') : tc('cancel')}
          </Button>
          {!sent ? (
            <Button
              variant="destructive"
              disabled={!p || block !== null || run.isPending}
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
