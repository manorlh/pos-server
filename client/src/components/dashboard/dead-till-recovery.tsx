'use client';

/**
 * Recovering a terminal that died holding an open trading day.
 *
 * Two actions, deliberately in this order, because the second is blocked by the first:
 *
 * 1. **Close the day from the cloud.** A Z built from the documents the cloud already
 *    holds, marked as reconstructed. Without it the day stays open forever — nothing but
 *    the terminal itself can issue a Z, and this one is not coming back.
 * 2. **Replace the terminal.** A pairing code that hands the machine's identity to a new
 *    device, so the register number and every document already filed against it keep
 *    pointing at the same till.
 *
 * The dialog states what the reconstruction is built from *before* it happens, not after.
 * "The cloud holds 41 documents and the terminal last reported nothing outstanding" is
 * the difference between an informed decision and a button press.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { createReplacementCode, reconstructCloseTradingDay } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import type { PosMachine } from '@/lib/types';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function DeadTillRecovery({ m }: { m: PosMachine }) {
  const t = useTranslations('deadTill');
  const tc = useTranslations('common');
  const qc = useQueryClient();

  const [closeOpen, setCloseOpen] = useState(false);
  const [note, setNote] = useState('');
  const [force, setForce] = useState(false);
  const [code, setCode] = useState<string | null>(null);

  const hasOpenDay = m.tradingDayStatus === 'open';

  const closeMutation = useMutation({
    mutationFn: () => reconstructCloseTradingDay(m.id, { force, note: note || undefined }),
    onSuccess: (res) => {
      setCloseOpen(false);
      setNote('');
      setForce(false);
      qc.invalidateQueries({ queryKey: ['machines'] });
      toast.success(
        res.created
          ? t('closed', { number: res.shopSequenceNumber ?? '—' })
          : t('alreadyClosed'),
      );
    },
    onError: (e) => toast.error(axiosErrorToToastMessage(e, tc('error'))),
  });

  const replaceMutation = useMutation({
    mutationFn: () => createReplacementCode(m.id),
    onSuccess: (res) => setCode(res.code),
    onError: (e) => toast.error(axiosErrorToToastMessage(e, tc('error'))),
  });

  return (
    <div className="flex flex-wrap gap-2">
      <Button
        size="sm"
        variant="outline"
        disabled={!hasOpenDay}
        onClick={() => setCloseOpen(true)}
        title={hasOpenDay ? undefined : t('noOpenDay')}
      >
        <AlertTriangle className="h-4 w-4 ms-1" />
        {t('closeFromCloud')}
      </Button>
      <Button
        size="sm"
        variant="outline"
        // Blocked in the UI as well as on the server, so the operator is told now rather
        // than with an engineer standing at the counter holding a new terminal.
        disabled={hasOpenDay || replaceMutation.isPending}
        onClick={() => replaceMutation.mutate()}
        title={hasOpenDay ? t('closeDayFirst') : undefined}
      >
        <RefreshCw className="h-4 w-4 ms-1" />
        {t('replaceTerminal')}
      </Button>

      <Dialog open={closeOpen} onOpenChange={setCloseOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('closeTitle')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            <p className="text-muted-foreground">{t('closeExplain')}</p>
            {/* What the document will rest on, stated before it is created. */}
            <div className="bg-muted/40 space-y-1 rounded-md p-3 text-xs">
              <div>{t('basisLastSeen', { when: m.lastHeartbeatAt ?? '—' })}</div>
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
              <Button onClick={() => closeMutation.mutate()} disabled={closeMutation.isPending}>
                {closeMutation.isPending ? tc('loading') : t('confirmClose')}
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
            <div className="bg-muted rounded-md py-4 text-center font-mono text-3xl tracking-widest">
              {code}
            </div>
            <p className="text-muted-foreground text-xs">{t('replaceRevokes')}</p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
