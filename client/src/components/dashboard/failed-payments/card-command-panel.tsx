'use client';

/**
 * "תשלום לא מוכרע" on a row of "עסקאות שלא הושלמו": the "לא הוכרע" badge and what it means, the
 * latest command a manager sent the till about it (who, when, what the till answered), and the
 * actions — "בדוק במסוף", "סמן כאושר", "סמן כלא אושר" (each confirmed), or withdrawing a command
 * the till has not answered. The server: pos-server app/services/card_attempt_commands.py.
 */

import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { useAuth } from '@/lib/auth';
import { formatDateTime } from '@/lib/format';
import {
  cardCommandActions,
  cardCommandPhase,
  isUnresolved,
  type CardCommandAction,
  type FailedPaymentAttempt,
} from '@/lib/failedPayments';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function UnresolvedBadge({ a }: { a: Pick<FailedPaymentAttempt, 'outcome'> }) {
  const t = useTranslations('failedPayments');
  if (!isUnresolved(a)) return null;
  return (
    <Badge variant="destructive" className="ms-1">
      {t('unresolvedBadge')}
    </Badge>
  );
}

export function CardCommandPanel({ a, compact = false }: { a: FailedPaymentAttempt; compact?: boolean }) {
  const t = useTranslations('failedPayments');
  const tc = useTranslations('common');
  const qc = useQueryClient();
  const role = useAuth((s) => s.user?.role ?? null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['failed-payments'] });

  const send = useMutation({
    mutationFn: (action: CardCommandAction) =>
      api.post(`/failed-payments/${a.id}/card-commands`, { action }).then((r) => r.data),
    onSuccess: () => {
      toast.success(t('cardCommand.sentOk'));
      void refresh();
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });
  const cancel = useMutation({
    mutationFn: (commandId: string) => api.post(`/failed-payments/card-commands/${commandId}/cancel`).then((r) => r.data),
    onSuccess: () => {
      toast.success(t('cardCommand.cancelledOk'));
      void refresh();
    },
    onError: (err: unknown) => toast.error(axiosErrorToToastMessage(err, tc('error'))),
  });

  if (!isUnresolved(a)) return null;
  const actions = cardCommandActions(a, role);
  const cmd = a.cardCommand ?? null;
  const phase = cardCommandPhase(cmd);
  const busy = send.isPending || cancel.isPending;
  const actionLabel = cmd ? (t.has(`cardCommand.action.${cmd.action}`) ? t(`cardCommand.action.${cmd.action}`) : cmd.action) : '';
  const statusLabel = cmd ? (t.has(`cardCommand.status.${cmd.status}`) ? t(`cardCommand.status.${cmd.status}`) : cmd.status) : '';
  const resultLabel =
    cmd?.resultOutcome && t.has(`cardCommand.result.${cmd.resultOutcome}`) ? t(`cardCommand.result.${cmd.resultOutcome}`) : null;

  const ask = (action: CardCommandAction, confirmKey: string) => {
    if (window.confirm(t(`cardCommand.${confirmKey}`))) send.mutate(action);
  };

  return (
    <div
      className={cn(
        'space-y-2 rounded-md border border-red-300 bg-red-50 p-2 text-xs dark:border-red-900 dark:bg-red-950',
        compact && 'p-1.5',
      )}
    >
      <p className="flex gap-1.5 font-medium text-red-800 dark:text-red-300">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" aria-hidden />
        {t('unresolvedExplain')}
      </p>
      {cmd ? (
        <div className="space-y-0.5">
          <p className={cn(phase === 'answered' ? 'font-medium' : 'text-muted-foreground')}>
            {phase === 'sent'
              ? t('cardCommand.sent', { action: actionLabel })
              : phase === 'delivered'
                ? t('cardCommand.delivered', { action: actionLabel })
                : t(phase === 'answered' ? 'cardCommand.answered' : 'cardCommand.ended', {
                    action: actionLabel,
                    status: [statusLabel, resultLabel].filter(Boolean).join(': '),
                  })}
          </p>
          {cmd.resultMessage ? <p className="text-muted-foreground break-words">{cmd.resultMessage}</p> : null}
          <p className="text-muted-foreground">
            {cmd.requestedAt
              ? t('cardCommand.by', { name: cmd.requestedByName ?? '—', at: formatDateTime(cmd.requestedAt) })
              : null}
            {cmd.answeredAt ? ` · ${t('cardCommand.answeredAt', { at: formatDateTime(cmd.answeredAt) })}` : null}
          </p>
        </div>
      ) : null}
      {!(a.vuid ?? '').trim() ? <p className="text-muted-foreground">{t('cardCommand.noVuid')}</p> : null}
      {actions.check || actions.markApproved || actions.markNotApproved || actions.cancel ? (
        <div className="flex flex-wrap gap-1.5">
          {actions.check ? (
            <Button size="xs" variant="outline" disabled={busy} onClick={() => ask('check', 'confirmCheck')}>
              {t('cardCommand.check')}
            </Button>
          ) : null}
          {actions.markApproved ? (
            <Button size="xs" variant="outline" disabled={busy} onClick={() => ask('mark_approved', 'confirmApproved')}>
              {t('cardCommand.markApproved')}
            </Button>
          ) : null}
          {actions.markNotApproved ? (
            <Button
              size="xs"
              variant="outline"
              className="text-destructive"
              disabled={busy}
              onClick={() => ask('mark_not_approved', 'confirmNotApproved')}
            >
              {t('cardCommand.markNotApproved')}
            </Button>
          ) : null}
          {actions.cancel && cmd ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                if (window.confirm(t('cardCommand.confirmCancel'))) cancel.mutate(cmd.id);
              }}
            >
              {t('cardCommand.cancel')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
