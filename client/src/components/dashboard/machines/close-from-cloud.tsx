'use client';

/**
 * "סגירת משמרת מהענן" (pos-server app/services/local_server_switch.py, P:/specs/local-server-switch.md
 * §2ג): a till the cloud has not heard for 5 minutes — its open shift closed from the documents the
 * cloud already holds, no Z, a cash count typed by hand if someone counted the drawer, marked
 * "נסגרה מהענן — הקופה לא הייתה זמינה". The same people as "סגירת משמרת מרחוק"; a till heard more
 * recently is refused (409 `till_online`) — the ordinary remote close is for it.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CloudOff } from 'lucide-react';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { formatDateTime } from '@/lib/format';
import { closeFromCloudBlock, parseCountedCash } from '@/lib/lanMode';
import { closeShiftFromCloud, fetchCloseFromCloud } from '@/lib/localServerApi';
import { refusalOf } from '@/lib/zParticipation';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';

/** The device page's button: only for a silent till with an open shift (the server decides again). */
export function CloseFromCloudButton({
  machineId,
  lastHeartbeatAt,
  hasOpenShift,
  removed,
  display,
  nowMs,
}: {
  machineId: string;
  lastHeartbeatAt: string | null | undefined;
  hasOpenShift: boolean;
  removed?: boolean;
  display?: boolean;
  nowMs: number;
}) {
  const t = useTranslations('localServer.closeFromCloud');
  const [open, setOpen] = useState(false);
  if (closeFromCloudBlock({ lastHeartbeatAt, hasOpenShift, removed, display }, nowMs) !== null) return null;
  return (
    <>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        <CloudOff className="h-4 w-4" aria-hidden />
        {t('open')}
      </Button>
      {open ? <CloseFromCloudDialog machineId={machineId} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function CloseFromCloudDialog({ machineId, onClose }: { machineId: string; onClose: () => void }) {
  const t = useTranslations('localServer.closeFromCloud');
  const tw = useTranslations('localServer.wizard');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ['close-from-cloud', machineId], queryFn: () => fetchCloseFromCloud(machineId) });
  const [cash, setCash] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const parsed = parseCountedCash(cash);
  const close = useMutation({
    mutationFn: () =>
      closeShiftFromCloud(machineId, {
        countedCash: typeof parsed === 'number' ? parsed : null,
        reason: reason.trim() || null,
      }),
    onSuccess: () => {
      toast.success(t('done'));
      void qc.invalidateQueries({ queryKey: ['machine', machineId] });
      void qc.invalidateQueries({ queryKey: ['shifts'] });
      void qc.invalidateQueries({ queryKey: ['machines'] });
      onClose();
    },
    onError: (err: unknown) => {
      setError(refusalOf(err)?.message ?? axiosErrorToToastMessage(err, tc('error')));
      void query.refetch();
    },
  });
  const s = query.data;
  const minutes = s?.silentSeconds !== null && s?.silentSeconds !== undefined ? Math.floor(s.silentSeconds / 60) : null;
  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next && !close.isPending) onClose();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('intro')}</DialogDescription>
        </DialogHeader>
        {query.isLoading || !s ? (
          <Skeleton className="h-28 w-full" />
        ) : (
          <div className="space-y-3 text-sm">
            <div className="space-y-1 rounded-md border p-3">
              <p>
                {s.lastHeartbeatAt
                  ? t('lastHeard', { at: formatDateTime(s.lastHeartbeatAt), minutes: String(minutes ?? 0) })
                  : tw('neverHeard')}
              </p>
              <p>
                {s.openShift
                  ? s.openShift.sequenceNumber
                    ? tw('openShift', { n: String(s.openShift.sequenceNumber), at: formatDateTime(s.openShift.openedAt) })
                    : tw('openShiftNumberless', { at: formatDateTime(s.openShift.openedAt) })
                  : s.reportedOpenShiftId
                    ? tw('reportedNotInCloud')
                    : tw('noOpenShift')}
              </p>
              <p>
                {s.pendingDocuments === null || s.pendingDocuments === undefined
                  ? tw('pendingUnknown')
                  : tw('pending', { n: s.pendingDocuments })}
              </p>
            </div>
            <p className="text-xs text-muted-foreground">{t('documentsHint')}</p>
            {!s.canCloseFromCloud && s.openShift ? (
              <p className="text-amber-700 dark:text-amber-400">{t('blocked_heard_recently')}</p>
            ) : null}
            <div className="space-y-1">
              <label htmlFor="cloud-close-cash" className="text-xs font-medium">
                {t('countedCash')}
              </label>
              <Input
                id="cloud-close-cash"
                inputMode="decimal"
                className="w-40"
                value={cash}
                aria-invalid={parsed === 'invalid'}
                onChange={(e) => setCash(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t('countedCashHint')}</p>
            </div>
            <div className="space-y-1">
              <label htmlFor="cloud-close-reason" className="text-xs font-medium">
                {t('reason')}
              </label>
              <Input
                id="cloud-close-reason"
                maxLength={300}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            <p className="text-xs">{t('label', { label: s.label })}</p>
            {error ? (
              <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-destructive">
                {error}
              </p>
            ) : null}
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" disabled={close.isPending} onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={!s || !s.canCloseFromCloud || parsed === 'invalid' || close.isPending}
            onClick={() => close.mutate()}
          >
            {close.isPending ? t('closing') : t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
