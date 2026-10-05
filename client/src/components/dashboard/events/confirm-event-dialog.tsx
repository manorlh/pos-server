'use client';

/**
 * "אישור האירוע" ("נותן תוקף"): the checks first — the blocking one (the event has not
 * ended) needs an explicit "confirm anyway", the warnings (open shift, documents not yet
 * synced, not in a Z, not transmitted…) are shown and do not stop it — then the freeze:
 * the report is kept as it is now, the tills leave the event, the event becomes read-only.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Lock, OctagonAlert, TriangleAlert } from 'lucide-react';
import { confirmEvent, eventErrorMessage, fetchEventReadiness, type ReportEvent } from '@/lib/eventsApi';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export function ConfirmEventDialog({
  event,
  open,
  onOpenChange,
}: {
  event: ReportEvent;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        {open ? <ConfirmBody event={event} onClose={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function ConfirmBody({ event, onClose }: { event: ReportEvent; onClose: () => void }) {
  const t = useTranslations('events.confirm');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [force, setForce] = useState(false);
  const [note, setNote] = useState('');
  const readiness = useQuery({
    queryKey: ['event-readiness', event.id],
    queryFn: () => fetchEventReadiness(event.id),
    staleTime: 0,
  });
  const blocking = readiness.data?.blocking ?? [];
  const warnings = readiness.data?.warnings ?? [];
  const needsForce = blocking.some((b) => b.code === 'not_ended');
  const impossible = blocking.some((b) => b.code === 'no_tills');

  const confirm = useMutation({
    mutationFn: () => confirmEvent(event.id, { force: needsForce && force, note: note.trim() || undefined }),
    onSuccess: (report) => {
      qc.setQueryData(['event-report', event.id], report);
      void qc.invalidateQueries({ queryKey: ['events'] });
      void qc.invalidateQueries({ queryKey: ['event', event.id] });
      toast.success(t('done'));
      onClose();
    },
    onError: (err) => toast.error(eventErrorMessage(err, tc('error'))),
  });

  return (
    <div className="grid gap-4">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <Lock className="h-5 w-5 text-[#34C759]" aria-hidden />
          {t('title', { name: event.name })}
        </DialogTitle>
      </DialogHeader>
      <p className="text-sm leading-relaxed">{t('explain')}</p>

      {readiness.isLoading ? (
        <p className="text-muted-foreground text-sm">{t('checking')}</p>
      ) : readiness.isError ? (
        <p className="text-destructive text-sm">{eventErrorMessage(readiness.error, tc('error'))}</p>
      ) : (
        <div className="grid gap-2">
          {blocking.map((b) => (
            <div key={b.code} className="flex gap-2 rounded-xl bg-[#FF3B30]/10 p-3 text-sm text-[#C4251B] dark:text-[#FF6961]">
              <OctagonAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              <span>{b.text}</span>
            </div>
          ))}
          {warnings.length > 0 ? (
            <div className="grid gap-1.5 rounded-xl bg-[#FF9500]/10 p-3 text-sm">
              <span className="flex items-center gap-1.5 font-medium text-[#C93400]">
                <TriangleAlert className="h-4 w-4" aria-hidden />
                {t('warnings', { count: warnings.length })}
              </span>
              <ul className="list-disc space-y-1 ps-5">
                {warnings.map((w, i) => (
                  <li key={`${w.code}-${w.ref ?? i}`}>{w.text}</li>
                ))}
              </ul>
            </div>
          ) : blocking.length === 0 ? (
            <p className="text-sm text-[#248A3D]">{t('allGood')}</p>
          ) : null}
          {needsForce ? (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 h-4 w-4 accent-[#FF3B30]" checked={force} onChange={(e) => setForce(e.target.checked)} />
              <span>{t('forceLabel')}</span>
            </label>
          ) : null}
        </div>
      )}

      <div className="grid gap-1.5">
        <Label htmlFor="confirm-note">{t('note')}</Label>
        <Input id="confirm-note" value={note} maxLength={500} placeholder={t('notePlaceholder')} onChange={(e) => setNote(e.target.value)} />
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose}>{tc('cancel')}</Button>
        <Button
          onClick={() => confirm.mutate()}
          disabled={confirm.isPending || readiness.isLoading || impossible || (needsForce && !force)}
          className="bg-[#34C759] text-white hover:bg-[#2DB14F]"
        >
          {confirm.isPending ? tc('loading') : t('submit')}
        </Button>
      </DialogFooter>
    </div>
  );
}
