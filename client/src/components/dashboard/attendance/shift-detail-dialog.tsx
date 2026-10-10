'use client';

/**
 * One attendance shift: its times (official, device and cloud), breaks, who closed it and
 * why, the flags — and its audit trail: every correction and manager action with the old
 * and the new times, who and when. A manager corrects from here (a time, a break) or closes
 * an open shift.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { createAdjustment, fetchShift } from '@/lib/attendanceApi';
import { actionLog, formatHours, isoToLocalInput, localInputToIso, verifiedByKey } from '@/lib/attendance';
import { formatDateTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DateTimePicker } from '@/components/ui/date-picker';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { PickSelect } from './attendance-filters';
import { CloseShiftDialog, type ClosableShift } from './close-shift-dialog';

type Fix = 'clock_in' | 'clock_out' | 'break';

export function ShiftDetailDialog({
  shiftId,
  canManage,
  onClose,
}: {
  shiftId: string | null;
  canManage: boolean;
  onClose: () => void;
}) {
  const t = useTranslations('attendance');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [fix, setFix] = useState<Fix>('clock_in');
  const [time, setTime] = useState('');
  const [end, setEnd] = useState('');
  const [reason, setReason] = useState('');
  const [closing, setClosing] = useState<ClosableShift | null>(null);

  const detail = useQuery({
    queryKey: ['attendance', 'shift', shiftId],
    queryFn: () => fetchShift(shiftId!),
    enabled: !!shiftId,
  });
  const s = detail.data;

  const save = useMutation({
    mutationFn: () =>
      createAdjustment({
        shopId: s!.shopId,
        posUserId: s!.posUserId,
        shiftId: s!.id,
        kind: fix === 'break' ? 'break' : 'wrong_time',
        field: fix === 'break' ? null : fix,
        time: localInputToIso(time),
        endTime: fix === 'break' ? localInputToIso(end) : null,
        reason: reason.trim(),
      }),
    onSuccess: () => {
      toast.success(t('detail.saved'));
      setTime('');
      setEnd('');
      setReason('');
      qc.invalidateQueries({ queryKey: ['attendance'] });
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, t('detail.saveFailed'))),
  });

  return (
    <>
      <Dialog open={shiftId !== null && closing === null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t('detail.title', { name: s?.posUserName ?? '' })}</DialogTitle>
          </DialogHeader>
          {!s ? (
            <Skeleton className="h-40" />
          ) : (
            <div className="max-h-[70vh] space-y-4 overflow-y-auto text-sm">
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label={t('col.in')} value={formatDateTime(s.clockInAt)}
                  sub={t('detail.deviceServer', { device: formatDateTime(s.clockInDeviceAt), server: formatDateTime(s.clockInServerAt) })} />
                <Field label={t('col.out')} value={s.clockOutAt ? formatDateTime(s.clockOutAt) : t('status.working')}
                  sub={s.clockOutAt ? t('detail.deviceServer', { device: formatDateTime(s.clockOutDeviceAt), server: formatDateTime(s.clockOutServerAt) }) : undefined} />
                <Field label={t('col.hours')} value={formatHours(s.workedSeconds)} />
                <Field label={t('col.breakTime')} value={`${formatHours(s.breakSeconds)} (${s.breaks.length})`} />
                {s.closedBy ? (
                  <Field label={t('detail.closedBy')} value={s.closedBy === 'manager' ? t('detail.closedByManager', { name: s.closedByName ?? '' }) : t('detail.closedBySelf')}
                    sub={s.closeReason ?? undefined} />
                ) : null}
                {s.roleName ? <Field label={t('col.role')} value={s.roleName} /> : null}
              </div>
              {s.flags.length ? (
                <div className="flex flex-wrap gap-1">
                  {s.flags.map((f) => <Badge key={f} variant="outline">{t(`flags.${f}`)}</Badge>)}
                  {s.clockSkewSeconds ? (
                    <Badge variant="outline">{t('detail.skew', { minutes: Math.round(Math.abs(s.clockSkewSeconds) / 60) })}</Badge>
                  ) : null}
                </div>
              ) : null}
              {s.breaks.length ? (
                <div>
                  <p className="mb-1 font-medium">{t('detail.breaks')}</p>
                  <ul className="space-y-0.5 tabular-nums">
                    {s.breaks.map((b) => (
                      <li key={b.id}>{formatDateTime(b.startAt)} – {b.endAt ? formatDateTime(b.endAt) : t('status.on_break')}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {(() => {
                // "קוד עובד בכל פעולה": how each till action was confirmed (never the code itself).
                const log = actionLog(s.details);
                if (!log.length) return null;
                return (
                  <div>
                    <p className="mb-1 font-medium">{t('detail.actionLog')}</p>
                    <ul className="space-y-0.5">
                      {log.map((e) => (
                        <li key={e.id}>
                          <span className="tabular-nums">
                            {t('detail.actionLine', {
                              action: t(`actions.${e.type}`),
                              at: e.at ? formatDateTime(e.at) : '—',
                              origin: e.origin === 'clock' || e.origin === 'session' ? t(`origin.${e.origin}`) : '—',
                              verified: t(`verifiedBy.${verifiedByKey(e)}`),
                            })}
                          </span>
                          {e.onBehalf ? (
                            <span className="text-muted-foreground">
                              {' · '}{t('detail.onBehalfBy', { name: e.onBehalf.name ?? '—' })}
                              {e.onBehalf.verified ? null : <> {t('detail.onBehalfUnverified')}</>}
                            </span>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  </div>
                );
              })()}

              <div>
                <p className="mb-1 font-medium">{t('detail.audit')}</p>
                {s.adjustments.length === 0 ? (
                  <p className="text-muted-foreground">{t('detail.noAudit')}</p>
                ) : (
                  <ul className="space-y-2">
                    {s.adjustments.map((a) => (
                      <li key={a.id} className="rounded-md border p-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="secondary">{t(`kind.${a.kind}`)}</Badge>
                          <Badge variant="outline">{t(`adjStatus.${a.status}`)}</Badge>
                          <span className="text-muted-foreground text-xs">
                            {t('detail.requestedBy', { name: a.requestedByName ?? '—', at: formatDateTime(a.requestedAt) })}
                          </span>
                        </div>
                        <p className="mt-1 tabular-nums">
                          {formatDateTime(a.originalTime)} → {formatDateTime(a.approvedTime ?? a.requestedTime)}
                        </p>
                        {a.reason ? <p className="text-muted-foreground">{a.reason}</p> : null}
                        {a.decidedByName ? (
                          <p className="text-muted-foreground text-xs">
                            {t('detail.decidedBy', { name: a.decidedByName, at: formatDateTime(a.decidedAt) })}
                            {a.decisionNote ? ` · ${a.decisionNote}` : ''}
                          </p>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {canManage ? (
                <div className="space-y-2 rounded-md border p-3">
                  <p className="font-medium">{t('detail.fixTitle')}</p>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <PickSelect
                      label={t('detail.fixWhat')}
                      value={fix}
                      onChange={(v) => setFix((v || 'clock_in') as Fix)}
                      options={[
                        { value: 'clock_in', label: t('col.in') },
                        { value: 'clock_out', label: t('col.out') },
                        { value: 'break', label: t('detail.addBreak') },
                      ]}
                    />
                    <div className="space-y-1">
                      <Label className="text-xs">{fix === 'break' ? t('detail.breakFrom') : t('detail.newTime')}</Label>
                      <DateTimePicker dir="ltr" value={time}
                        onChange={(e) => setTime(e.target.value)}
                        placeholder={isoToLocalInput(fix === 'clock_out' ? s.clockOutAt : s.clockInAt)} />
                    </div>
                    {fix === 'break' ? (
                      <div className="space-y-1">
                        <Label className="text-xs">{t('detail.breakTo')}</Label>
                        <DateTimePicker dir="ltr" value={end} onChange={(e) => setEnd(e.target.value)} />
                      </div>
                    ) : null}
                  </div>
                  <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('detail.reason')} />
                  <div className="flex flex-wrap justify-end gap-2">
                    {!s.clockOutAt ? (
                      <Button variant="destructive" size="sm" onClick={() => setClosing(s)}>{t('close.action')}</Button>
                    ) : null}
                    <Button size="sm" disabled={!time || !reason.trim() || (fix === 'break' && !end) || save.isPending}
                      onClick={() => save.mutate()}>
                      {t('detail.save')}
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={onClose}>{tc('cancel')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <CloseShiftDialog shift={closing} onClose={() => setClosing(null)} />
    </>
  );
}

function Field({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="tabular-nums font-medium">{value}</p>
      {sub ? <p className="text-muted-foreground text-xs">{sub}</p> : null}
    </div>
  );
}
