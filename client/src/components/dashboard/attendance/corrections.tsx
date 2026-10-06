'use client';

/**
 * "תיקוני נוכחות": the employees' requests from the tills ("בקשת תיקון נוכחות") and the
 * managers' own corrections and closes — pending first. A manager approves (as asked),
 * edits (approves another time) or rejects, with a note; every decision is kept with the
 * old and the new times (the audit, also an exception "שינוי נוכחות ידני"). A manager may
 * also add a whole missing shift ("משמרת חסרה") for an employee who never clocked in.
 */

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Check, Pencil, Plus, X } from 'lucide-react';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { createAdjustment, decideAdjustment, fetchAdjustments, fetchEmployees } from '@/lib/attendanceApi';
import {
  adjustmentTimes,
  isoToLocalInput,
  localInputToIso,
  type AdjustmentStatus,
  type AttendanceAdjustment,
} from '@/lib/attendance';
import { formatDateTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { AttendanceFilters, EMPTY_ATTENDANCE_SCOPE, PickSelect, scopeParams, type AttendanceScope } from './attendance-filters';

const STATUSES: AdjustmentStatus[] = ['pending', 'approved', 'rejected'];

const STATUS_TONE: Record<AdjustmentStatus, string> = {
  pending: 'bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200',
  approved: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200',
  rejected: 'bg-slate-200 text-slate-900 dark:bg-slate-800 dark:text-slate-200',
};

export function Corrections() {
  const t = useTranslations('attendance');
  const qc = useQueryClient();
  const [scope, setScope] = useState<AttendanceScope>(EMPTY_ATTENDANCE_SCOPE);
  const [status, setStatus] = useState<string>('pending');
  const [deciding, setDeciding] = useState<{ adj: AttendanceAdjustment; edit: boolean } | null>(null);
  const [adding, setAdding] = useState(false);

  const query = useQuery({
    queryKey: ['attendance', 'adjustments', scopeParams(scope), scope.posUserId, status],
    queryFn: () => fetchAdjustments({ ...scopeParams(scope), posUserId: scope.posUserId || null, status: status || undefined }),
  });
  const canManage = query.data?.canManage === true;
  const rows = query.data?.adjustments ?? [];

  const quick = useMutation({
    mutationFn: ({ id, decision }: { id: string; decision: 'approve' | 'reject' }) => decideAdjustment(id, { decision }),
    onSuccess: (_, v) => {
      toast.success(v.decision === 'approve' ? t('corrections.approved') : t('corrections.rejected'));
      qc.invalidateQueries({ queryKey: ['attendance'] });
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, t('corrections.failed'))),
  });

  return (
    <div className="space-y-4">
      <Card className="print:hidden">
        <CardContent className="space-y-3 pt-4">
          <AttendanceFilters value={scope} onChange={setScope} withEmployee />
          <div className="flex flex-wrap items-end gap-3">
            <div className="w-48">
              <PickSelect
                label={t('corrections.status')}
                value={status}
                onChange={setStatus}
                options={STATUSES.map((s) => ({ value: s, label: t(`adjStatus.${s}`) }))}
                anyLabel={t('corrections.allStatuses')}
              />
            </div>
            {canManage ? (
              <Button variant="outline" className="ms-auto" onClick={() => setAdding(true)}>
                <Plus className="size-4" />
                {t('corrections.addMissing')}
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>

      {query.isLoading ? (
        <Skeleton className="h-40" />
      ) : query.isError ? (
        <p className="text-destructive text-sm">{t('errors.load')}</p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border bg-card p-6 text-center text-sm">{t('corrections.empty')}</p>
      ) : (
        <div className="space-y-2">
          {rows.map((a) => {
            const times = adjustmentTimes(a);
            return (
              <Card key={a.id}>
                <CardContent className="flex flex-wrap items-start gap-3 pt-4">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{a.posUserName ?? '—'}</span>
                      {a.shopName ? <span className="text-muted-foreground text-xs">{a.shopName}</span> : null}
                      <Badge variant="secondary">{t(`kind.${a.kind}`)}</Badge>
                      {a.field ? <Badge variant="outline">{t(`field.${a.field}`)}</Badge> : null}
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[a.status]}`}>
                        {t(`adjStatus.${a.status}`)}
                      </span>
                    </div>
                    <p className="tabular-nums text-sm">
                      {t('corrections.times', {
                        before: times.before ? formatDateTime(times.before) : t('corrections.none'),
                        after: times.after ? formatDateTime(times.after) : '—',
                      })}
                      {a.requestedEndTime ? ` – ${formatDateTime(a.approvedEndTime ?? a.requestedEndTime)}` : ''}
                    </p>
                    {a.reason ? <p className="text-sm">{t('corrections.reason', { reason: a.reason })}</p> : null}
                    <p className="text-muted-foreground text-xs">
                      {t('corrections.requested', {
                        name: a.requestedByName ?? '—',
                        at: formatDateTime(a.requestedAt),
                        source: t(`source.${a.source}`),
                      })}
                      {a.decidedByName
                        ? ` · ${t('corrections.decided', { name: a.decidedByName, at: formatDateTime(a.decidedAt) })}`
                        : ''}
                      {a.decisionNote ? ` · ${a.decisionNote}` : ''}
                    </p>
                  </div>
                  {canManage && a.status === 'pending' ? (
                    <div className="flex flex-wrap gap-2">
                      <Button size="sm" onClick={() => quick.mutate({ id: a.id, decision: 'approve' })} disabled={quick.isPending}>
                        <Check className="size-4" />
                        {t('corrections.approve')}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => setDeciding({ adj: a, edit: true })}>
                        <Pencil className="size-4" />
                        {t('corrections.edit')}
                      </Button>
                      <Button size="sm" variant="destructive" onClick={() => setDeciding({ adj: a, edit: false })}>
                        <X className="size-4" />
                        {t('corrections.reject')}
                      </Button>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <DecisionDialog value={deciding} onClose={() => setDeciding(null)} />
      <MissingShiftDialog open={adding} scope={scope} onClose={() => setAdding(false)} />
    </div>
  );
}

/** Edit (approve with other times) or reject, with a note. */
function DecisionDialog({
  value,
  onClose,
}: {
  value: { adj: AttendanceAdjustment; edit: boolean } | null;
  onClose: () => void;
}) {
  const t = useTranslations('attendance');
  return (
    <Dialog open={value !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {value?.edit ? t('corrections.editTitle') : t('corrections.rejectTitle')} · {value?.adj.posUserName ?? ''}
          </DialogTitle>
        </DialogHeader>
        {value ? <DecisionForm key={`${value.adj.id}:${value.edit}`} adj={value.adj} edit={value.edit} onClose={onClose} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function DecisionForm({ adj, edit, onClose }: { adj: AttendanceAdjustment; edit: boolean; onClose: () => void }) {
  const t = useTranslations('attendance');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [time, setTime] = useState(() => isoToLocalInput(adj.requestedTime));
  const [end, setEnd] = useState(() => isoToLocalInput(adj.requestedEndTime));
  const [note, setNote] = useState('');
  const decide = useMutation({
    mutationFn: () =>
      decideAdjustment(adj.id, edit
        ? { decision: 'approve', approvedTime: localInputToIso(time), approvedEndTime: localInputToIso(end), note: note || null }
        : { decision: 'reject', note: note || null }),
    onSuccess: () => {
      toast.success(edit ? t('corrections.approved') : t('corrections.rejected'));
      qc.invalidateQueries({ queryKey: ['attendance'] });
      onClose();
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, t('corrections.failed'))),
  });
  return (
    <>
      <div className="space-y-3">
        {edit ? (
          <>
            <div className="space-y-1">
              <Label className="text-xs">{t('corrections.approvedTime')}</Label>
              <Input type="datetime-local" dir="ltr" value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
            {adj.requestedEndTime || adj.kind === 'break' ? (
              <div className="space-y-1">
                <Label className="text-xs">{t('corrections.approvedEndTime')}</Label>
                <Input type="datetime-local" dir="ltr" value={end} onChange={(e) => setEnd(e.target.value)} />
              </div>
            ) : null}
          </>
        ) : null}
        <div className="space-y-1">
          <Label className="text-xs">{t('corrections.note')}</Label>
          <textarea
            className="border-input bg-background min-h-20 w-full rounded-md border px-3 py-2 text-sm"
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </div>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>{tc('cancel')}</Button>
        <Button
          variant={edit ? 'default' : 'destructive'}
          disabled={decide.isPending || (edit && !time)}
          onClick={() => decide.mutate()}
        >
          {edit ? t('corrections.approveEdited') : t('corrections.reject')}
        </Button>
      </DialogFooter>
    </>
  );
}

/** "משמרת חסרה": an employee who never clocked in — the whole shift, with a reason. */
function MissingShiftDialog({ open, scope, onClose }: { open: boolean; scope: AttendanceScope; onClose: () => void }) {
  const t = useTranslations('attendance');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [posUserId, setPosUserId] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [reason, setReason] = useState('');
  const employees = useQuery({
    queryKey: ['attendance-employees', scope.shopId],
    queryFn: () => fetchEmployees(scope.shopId),
    enabled: open && !!scope.shopId,
  });
  const save = useMutation({
    mutationFn: () =>
      createAdjustment({
        shopId: scope.shopId,
        posUserId,
        kind: 'missing_in',
        time: localInputToIso(start),
        endTime: localInputToIso(end),
        reason: reason.trim(),
      }),
    onSuccess: () => {
      toast.success(t('corrections.missingAdded'));
      qc.invalidateQueries({ queryKey: ['attendance'] });
      setPosUserId('');
      setStart('');
      setEnd('');
      setReason('');
      onClose();
    },
    onError: (err) => toast.error(axiosErrorToToastMessage(err, t('corrections.failed'))),
  });
  return (
    <Dialog open={open} onOpenChange={(o) => (!o ? onClose() : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('corrections.addMissing')}</DialogTitle>
        </DialogHeader>
        {!scope.shopId ? (
          <p className="text-muted-foreground text-sm">{t('filters.chooseShopFirst')}</p>
        ) : (
          <div className="space-y-3">
            <PickSelect
              label={t('filters.employee')}
              value={posUserId}
              onChange={setPosUserId}
              options={(employees.data?.employees ?? []).map((e) => ({ value: e.id, label: e.name || e.username }))}
            />
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label className="text-xs">{t('col.in')}</Label>
                <Input type="datetime-local" dir="ltr" value={start} onChange={(e) => setStart(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">{t('col.out')}</Label>
                <Input type="datetime-local" dir="ltr" value={end} onChange={(e) => setEnd(e.target.value)} />
              </div>
            </div>
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder={t('detail.reason')} />
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{tc('cancel')}</Button>
          <Button
            disabled={!scope.shopId || !posUserId || !start || !end || !reason.trim() || save.isPending}
            onClick={() => save.mutate()}
          >
            {tc('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
