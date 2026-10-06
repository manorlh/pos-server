'use client';

/**
 * Recovering a terminal that died holding an open shift.
 *
 * Two actions, deliberately in this order, because the second is blocked by the first:
 *
 * 1. **Close the shift from the cloud.** Its X is built from the documents the cloud
 *    already holds and marked reconstructed, unattended and uncounted. Without it the
 *    shift stays open forever — only the terminal can close it, and this one is not
 *    coming back. It issues no Z: the closed shift simply joins the shop's next Z, so
 *    the operator is pointed at the Z wizard afterwards.
 * 2. **Replace the terminal.** A pairing code that hands the machine's identity to a new
 *    device, so the register number and every document already filed against it keep
 *    pointing at the same till.
 *
 * The dialog states what the reconstruction is built from *before* it happens, not after.
 * "The cloud holds 41 documents and the terminal last reported nothing outstanding" is
 * the difference between an informed decision and a button press.
 */

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { administrativeCloseShift, createReplacementCode } from '@/lib/api';
import { useCanProduceZ, zWizardHref } from '@/lib/zAccess';
import { useAuth } from '@/lib/auth';
import { errorCodeOf, useZErrorText } from '@/components/dashboard/z-wizard/z-errors';
import { formatDateTime } from '@/lib/format';
import type { PosMachine } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function DeadTillRecovery({ m }: { m: PosMachine }) {
  const t = useTranslations('deadTill');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const router = useRouter();
  const canProduceZ = useCanProduceZ();
  const role = useAuth((st) => st.user?.role);
  // Closing a shift from the cloud files an X a Z will take: the Z producers' call.
  // Replacing the terminal hands its identity to new hardware: the distributor's.
  const canClose = canProduceZ;
  const canReplace = role === 'distributor' || role === 'super_admin';
  const errors = useZErrorText();

  const [closeOpen, setCloseOpen] = useState(false);
  const [note, setNote] = useState('');
  const [force, setForce] = useState(false);
  const [code, setCode] = useState<{ code: string; expiresAt: string | null } | null>(null);

  // Each opening starts from nothing ticked: "the terminal is unusable" is a statement
  // about this close, not a preference to carry over from the last one.
  const openClose = () => {
    setNote('');
    setForce(false);
    setCloseOpen(true);
  };

  const hasOpenShift = m.shiftStatus === 'open';
  const shiftId = m.openShiftId ?? null;

  const closeMutation = useMutation({
    mutationFn: () => administrativeCloseShift(m.id, shiftId!, { force, note: note || undefined }),
    onSuccess: (res) => {
      setCloseOpen(false);
      setNote('');
      setForce(false);
      qc.invalidateQueries({ queryKey: ['machines'] });
      qc.invalidateQueries({ queryKey: ['machine', m.id] });
      qc.invalidateQueries({ queryKey: ['shifts'] });
      qc.invalidateQueries({ queryKey: ['shift', shiftId] });
      qc.invalidateQueries({ queryKey: ['z-candidates'] });
      // The shift is closed, not reported: it waits for the shop's next Z. Say so, and
      // offer the way there.
      toast.success(res.created ? t('closed') : t('alreadyClosed'), {
        description: t('closedNext'),
        action:
          canProduceZ && m.shopId
            ? { label: t('toZWizard'), onClick: () => router.push(zWizardHref(m.shopId, m.id)) }
            : undefined,
        duration: 10_000,
      });
    },
    onError: (e) => toast.error(errors.forError(e)),
  });

  // Card sales the old terminal never transmitted die with it (docs/SHIFTS_API.md §4.9):
  // the server refuses the code until someone accepts that, having exported the list.
  const [untransmittedOpen, setUntransmittedOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  // "הוחלפה קופה" is documented with why (offline till Z §4.6.2): asked before the code.
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState('');
  const replaceMutation = useMutation({
    mutationFn: (acknowledgeUntransmitted: boolean) =>
      createReplacementCode(m.id, { acknowledgeUntransmitted, reason }),
    onSuccess: (res) => {
      setReasonOpen(false);
      setUntransmittedOpen(false);
      setCode({ code: res.code, expiresAt: res.expiresAt ?? null });
    },
    onError: (e) => {
      const detail = (e as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
      if (errorCodeOf(detail) === 'untransmitted_card_sales') {
        setReasonOpen(false);
        setAcknowledged(false);
        setUntransmittedOpen(true);
        return;
      }
      toast.error(errors.forError(e));
    },
  });

  if (!canClose && !canReplace) return null;

  return (
    <div className="flex flex-wrap gap-2">
      {canClose ? (
        <Button
          size="sm"
          variant="outline"
          disabled={!hasOpenShift || !shiftId}
          onClick={openClose}
          title={hasOpenShift ? undefined : t('noOpenShift')}
        >
          <AlertTriangle className="h-4 w-4 ms-1" />
          {t('closeFromCloud')}
        </Button>
      ) : null}
      {canReplace ? (
        <Button
          size="sm"
          variant="outline"
          // Blocked in the UI as well as on the server, so the operator is told now rather
          // than with an engineer standing at the counter holding a new terminal.
          disabled={hasOpenShift || replaceMutation.isPending}
          onClick={() => {
            setReason('');
            setReasonOpen(true);
          }}
          title={hasOpenShift ? t('closeShiftFirst') : undefined}
        >
          <RefreshCw className="h-4 w-4 ms-1" />
          {t('replaceTerminal')}
        </Button>
      ) : null}

      <Dialog open={closeOpen} onOpenChange={setCloseOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('closeTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">{t('closeExplain')}</p>
            {/* What the document will rest on, stated before it is created. */}
            <div className="bg-muted/40 space-y-1 rounded-md p-3 text-xs">
              {m.openedAt ? (
                <div>
                  {t('basisShift', {
                    since: formatDateTime(m.openedAt),
                    by: m.openedBy ?? '—',
                  })}
                </div>
              ) : null}
              <div>{t('basisLastSeen', { when: formatDateTime(m.lastHeartbeatAt) })}</div>
              <div>
                {m.pendingDocuments == null
                  ? t('basisNeverReported')
                  : t('basisPending', { count: m.pendingDocuments })}
              </div>
            </div>
            <p className="text-muted-foreground text-xs">{t('noCashCount')}</p>
            <div className="space-y-1.5">
              <Label htmlFor="dead-till-note">{t('noteLabel')}</Label>
              <Input
                id="dead-till-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder={t('notePlaceholder')}
                maxLength={500}
              />
            </div>
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
              {t('forceLabel')}
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setCloseOpen(false)}>
                {tc('cancel')}
              </Button>
              <Button
                onClick={() => closeMutation.mutate()}
                disabled={closeMutation.isPending || !shiftId}
              >
                {closeMutation.isPending ? tc('loading') : t('confirmClose')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={reasonOpen} onOpenChange={setReasonOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('replaceReasonTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">{t('replaceReasonHint')}</p>
            <div className="space-y-1.5">
              <Label htmlFor="replace-reason">{t('replaceReasonLabel')}</Label>
              <Input
                id="replace-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t('replaceReasonPlaceholder')}
                maxLength={500}
              />
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setReasonOpen(false)}>
                {tc('cancel')}
              </Button>
              <Button
                disabled={reason.trim().length < 3 || replaceMutation.isPending}
                onClick={() => replaceMutation.mutate(false)}
              >
                {replaceMutation.isPending ? tc('loading') : t('replaceReasonConfirm')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={untransmittedOpen} onOpenChange={setUntransmittedOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('untransmittedTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">{t('untransmittedExplain')}</p>
            <Link
              href={`/dashboard/machines/${m.id}#transmission`}
              className="text-xs text-primary hover:underline"
            >
              {t('untransmittedList')}
            </Link>
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(e) => setAcknowledged(e.target.checked)}
              />
              {t('untransmittedAck')}
            </label>
            <div className="flex justify-end gap-2 pt-2">
              <Button variant="outline" onClick={() => setUntransmittedOpen(false)}>
                {tc('cancel')}
              </Button>
              <Button
                variant="destructive"
                disabled={!acknowledged || replaceMutation.isPending}
                onClick={() => replaceMutation.mutate(true)}
              >
                {replaceMutation.isPending ? tc('loading') : t('untransmittedConfirm')}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={code !== null} onOpenChange={(o) => !o && setCode(null)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('replaceTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">{t('replaceExplain')}</p>
            <div className="bg-muted rounded-md py-4 text-center font-mono text-3xl tracking-widest" dir="ltr">
              {code?.code}
            </div>
            {code?.expiresAt ? (
              <p className="text-xs font-medium">{t('replaceExpires', { when: formatDateTime(code.expiresAt) })}</p>
            ) : null}
            <p className="text-muted-foreground text-xs">{t('replaceRevokes')}</p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
