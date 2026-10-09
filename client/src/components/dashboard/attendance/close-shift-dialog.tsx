'use client';

/**
 * "סגירה ע״י מנהל": a manager ends an employee's open shift — one who left without clocking
 * out. A reason is mandatory; the time defaults to now. Over the employee's open tables the
 * server answers 409 `open_tables` (under "חסימת סיום משמרת עם שולחנות פתוחים"): the tables
 * are listed and the manager may confirm. Recorded with the old and the new times (and as an
 * exception, "שינוי נוכחות ידני").
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { toast } from 'sonner';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { closeShift, type OpenTableInfo } from '@/lib/attendanceApi';
import { isoToLocalInput, localInputToIso, type AttendanceShift } from '@/lib/attendance';
import { formatCurrency } from '@/lib/format';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DateTimePicker } from '@/components/ui/date-picker';
import { Label } from '@/components/ui/label';

export type ClosableShift = Pick<AttendanceShift, 'id' | 'posUserName'>;

export function CloseShiftDialog({
  shift,
  onClose,
}: {
  shift: ClosableShift | null;
  onClose: () => void;
}) {
  const t = useTranslations('attendance');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [at, setAt] = useState(() => isoToLocalInput(new Date().toISOString()));
  const [tables, setTables] = useState<OpenTableInfo[] | null>(null);

  const reset = () => {
    setReason('');
    setAt(isoToLocalInput(new Date().toISOString()));
    setTables(null);
  };

  const close = useMutation({
    mutationFn: (ignoreOpenTables: boolean) =>
      closeShift(shift!.id, { reason: reason.trim(), at: localInputToIso(at), ignoreOpenTables }),
    onSuccess: () => {
      toast.success(t('close.done'));
      qc.invalidateQueries({ queryKey: ['attendance'] });
      reset();
      onClose();
    },
    onError: (err) => {
      if (isAxiosError(err) && err.response?.status === 409) {
        const detail = err.response.data?.detail as { code?: string; tables?: OpenTableInfo[] } | undefined;
        if (detail?.code === 'open_tables') {
          setTables(detail.tables ?? []);
          return;
        }
      }
      toast.error(axiosErrorToToastMessage(err, t('close.failed')));
    },
  });

  return (
    <Dialog
      open={shift !== null}
      onOpenChange={(open) => {
        if (!open) {
          reset();
          onClose();
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('close.title', { name: shift?.posUserName ?? '' })}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <p className="text-muted-foreground text-sm">{t('close.hint')}</p>
          <div className="space-y-1">
            <Label className="text-xs">{t('close.at')}</Label>
            <DateTimePicker value={at} onChange={(e) => setAt(e.target.value)} dir="ltr" />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">{t('close.reason')}</Label>
            <textarea
              className="border-input bg-background min-h-20 w-full rounded-md border px-3 py-2 text-sm"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('close.reasonPlaceholder')}
            />
          </div>
          {tables ? (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950">
              <p className="font-medium">{t('close.openTables')}</p>
              <ul className="mt-1 space-y-0.5">
                {tables.map((tb) => (
                  <li key={tb.orderId} className="tabular-nums">
                    {t('close.table', { number: tb.number ?? tb.name ?? '—' })} · {formatCurrency(tb.total)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => { reset(); onClose(); }}>
            {tc('cancel')}
          </Button>
          <Button
            variant="destructive"
            disabled={!reason.trim() || !at || close.isPending}
            onClick={() => close.mutate(tables !== null)}
          >
            {tables !== null ? t('close.confirmAnyway') : t('close.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
