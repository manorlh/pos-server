'use client';

/**
 * "תשלום לא מוכרע" on a row of "עסקאות שלא הושלמו": the "לא הוכרע" badge and what it means, what
 * the terminal said on the latest check (approved / cancelled / not found, its uid, time, amount),
 * the latest command and where it stands, and the actions:
 *
 * - "בדוק במסוף" — the till asks the terminal (read-only);
 * - the cloud's decision — "אשר והכנס את העסקה" (the till completes the pending documents as a
 *   normal sale) or "בטל" (it voids them). A decision waits for the till ("ממתין לקופה") as long as
 *   it takes, then reads "בוצע" with who decided, when, and when the till did it. A decision
 *   against the terminal's answer, or with no check, asks an explicit confirmation that says what
 *   the terminal said (or "לא נבדק במסוף"), and is sent with `confirmMismatch`;
 * - withdrawing a command the till has not answered.
 *
 * Shown to owner / manager roles with edit on "דוחות" (the server's route rules ask the same).
 * The server: pos-server app/services/card_attempt_commands.py.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle } from 'lucide-react';
import { api } from '@/lib/api';
import { axiosErrorToToastMessage } from '@/lib/apiError';
import { actionLabelOf, isKeyReused, keyRing, phaseOfCard } from '@/lib/deviceCommands';
import { idempotencyHeaders, trackCommand } from '@/lib/deviceCommandsStore';
import { useAuth } from '@/lib/auth';
import { canAccess } from '@/lib/dashboardAccess';
import { useDashboardAccess } from '@/lib/dashboardAccessApi';
import { formatCurrency, formatDateTime } from '@/lib/format';
import {
  agorotToShekels,
  cardCommandActions,
  cardCommandPhase,
  checkVerdict,
  decisionDisagrees,
  decisionMismatchOf,
  isUnresolved,
  type CardCommandAction,
  type CheckVerdict,
  type FailedPaymentAttempt,
} from '@/lib/failedPayments';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type Decision = Exclude<CardCommandAction, 'check'>;

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
  const access = useDashboardAccess();
  const refresh = () => qc.invalidateQueries({ queryKey: ['failed-payments'] });
  const verdictText = (v: CheckVerdict) => t(`cardCommand.verdict.${v}`);

  // Fire-and-forget: the till answers later, in the background ("פקודות שנשלחו" reads it and
  // refreshes this row). One Idempotency-Key per user action (lib/deviceCommands.ts `keyRing`):
  // the same request retried (a network error, a second click) keeps its key — the server answers
  // with the first command, never makes a second; the confirmed decision after a mismatch is
  // another request (another key); once answered, the next action is new. Every safety rule stays
  // the server's (one pending command, the mismatch confirmation, who may act).
  const [keys] = useState(() => keyRing());
  const post = (action: CardCommandAction, confirmMismatch: boolean) => {
    const request = { attemptId: a.id, action, confirmMismatch };
    return api
      .post<{ id?: string; action?: string; status?: string; deliveredAt?: string | null }>(
        `/failed-payments/${a.id}/card-commands`,
        { action, confirmMismatch },
        idempotencyHeaders(keys.keyFor(request)),
      )
      .then((r) => {
        keys.forget();
        return r.data;
      })
      .catch((err) => {
        if (isKeyReused(err)) keys.forget(request);
        throw err;
      });
  };

  const send = useMutation({
    mutationFn: async ({ action, confirmMismatch }: { action: CardCommandAction; confirmMismatch: boolean }) => {
      try {
        return await post(action, confirmMismatch);
      } catch (err) {
        // The page was stale: the server holds another check's answer — ask again with its words.
        const mismatch = decisionMismatchOf(err);
        if (mismatch && action !== 'check' && !confirmMismatch) {
          const said = mismatch.label ?? verdictText(mismatch.verdict);
          const question =
            mismatch.verdict === 'not_checked'
              ? t('cardCommand.confirmNotChecked')
              : t('cardCommand.confirmMismatch', { verdict: said });
          if (window.confirm(question)) return post(action, true);
          return null;
        }
        throw err;
      }
    },
    onSuccess: (out, { action }) => {
      if (out === null) return;
      // The feedback is the small centred popup ("נשלחה פקודה: בדיקה במסוף → קופה 1"), live.
      if (!out?.id) toast.success(t('cardCommand.sentOk'));
      if (out?.id) {
        const p = phaseOfCard({ status: out.status ?? 'pending', deliveredAt: out.deliveredAt ?? null });
        trackCommand({
          kind: 'card',
          id: out.id,
          action,
          label: t.has(`cardCommand.action.${action}`) ? t(`cardCommand.action.${action}`) : actionLabelOf(action),
          machineId: a.machineId,
          machineName: a.machineName ?? null,
          phase: p.phase,
          ref: { attemptId: a.id },
        });
      }
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
  const actions = cardCommandActions(a, role, canAccess(access, 'reports', 'edit'));
  const cmd = a.cardCommand ?? null;
  const check = a.cardCheck ?? null;
  const phase = cardCommandPhase(cmd);
  const busy = send.isPending || cancel.isPending;
  const label = (key: string, fallback: string) => (t.has(key) ? t(key) : fallback);
  const actionLabel = cmd ? label(`cardCommand.action.${cmd.action}`, cmd.action) : '';
  const statusLabel = cmd ? label(`cardCommand.status.${cmd.status}`, cmd.status) : '';
  const resultLabel =
    cmd?.resultOutcome && t.has(`cardCommand.result.${cmd.resultOutcome}`) ? t(`cardCommand.result.${cmd.resultOutcome}`) : null;
  const verdict = checkVerdict(check);

  const askCheck = () => {
    if (window.confirm(t('cardCommand.confirmCheck'))) send.mutate({ action: 'check', confirmMismatch: false });
  };
  const decide = (action: Decision) => {
    const base = t(action === 'mark_approved' ? 'cardCommand.confirmApproved' : 'cardCommand.confirmNotApproved');
    const disagrees = decisionDisagrees(action, verdict);
    const warning = !disagrees
      ? null
      : verdict === 'not_checked'
        ? t('cardCommand.confirmNotChecked')
        : verdict === 'unknown'
          ? t('cardCommand.confirmUnknown')
          : t('cardCommand.confirmMismatch', { verdict: verdictText(verdict) });
    if (!window.confirm(base)) return;
    if (warning && !window.confirm(warning)) return;
    send.mutate({ action, confirmMismatch: disagrees });
  };

  const details = check?.details ?? null;
  const checkLine = check
    ? [
        details?.terminalUid ? t('cardCommand.lastCheckDetails', { uid: details.terminalUid }) : null,
        details?.at ? t('cardCommand.lastCheckAt', { at: formatDateTime(details.at) }) : null,
        typeof details?.amountAgorot === 'number'
          ? t('cardCommand.lastCheckAmount', { amount: formatCurrency(agorotToShekels(details.amountAgorot)) })
          : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';

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

      {/* What the terminal said on the latest check, whatever came after it. */}
      {check ? (
        <div className="space-y-0.5">
          <p className={cn('font-medium', verdict === 'approved' ? 'text-emerald-700 dark:text-emerald-400' : '')}>
            {t('cardCommand.lastCheck', { verdict: verdictText(verdict) })}
          </p>
          {checkLine ? <p className="text-muted-foreground" dir="auto">{checkLine}</p> : null}
        </div>
      ) : null}

      {cmd && !(check && cmd.id === check.id) ? (
        <div className="space-y-0.5">
          <p className={cn(phase === 'done' || phase === 'answered' ? 'font-medium' : 'text-muted-foreground')}>
            {phase === 'waiting'
              ? t('cardCommand.waiting', { action: actionLabel })
              : phase === 'done'
                ? t('cardCommand.done', { action: actionLabel })
                : phase === 'sent'
                  ? t('cardCommand.sent', { action: actionLabel })
                  : phase === 'delivered'
                    ? t('cardCommand.delivered', { action: actionLabel })
                    : t(phase === 'answered' ? 'cardCommand.answered' : 'cardCommand.ended', {
                        action: actionLabel,
                        status: [statusLabel, resultLabel].filter(Boolean).join(': '),
                      })}
          </p>
          {phase === 'waiting' ? <p className="text-muted-foreground">{t('cardCommand.waitingHint')}</p> : null}
          {cmd.mismatchConfirmed ? (
            <p className="text-amber-700 dark:text-amber-400">
              {t('cardCommand.mismatchConfirmed', {
                verdict: verdictText((cmd.verdictAtDecision as CheckVerdict) || 'not_checked'),
              })}
            </p>
          ) : null}
          {cmd.resultMessage ? <p className="text-muted-foreground break-words">{cmd.resultMessage}</p> : null}
          <p className="text-muted-foreground">
            {cmd.requestedAt
              ? cmd.isDecision
                ? t('cardCommand.decidedBy', { name: cmd.requestedByName ?? '—', at: formatDateTime(cmd.requestedAt) })
                : t('cardCommand.by', { name: cmd.requestedByName ?? '—', at: formatDateTime(cmd.requestedAt) })
              : null}
            {cmd.answeredAt
              ? ` · ${cmd.isDecision && cmd.status === 'done'
                  ? t('cardCommand.doneAt', { at: formatDateTime(cmd.answeredAt) })
                  : t('cardCommand.answeredAt', { at: formatDateTime(cmd.answeredAt) })}`
              : null}
          </p>
        </div>
      ) : null}

      {!(a.vuid ?? '').trim() ? <p className="text-muted-foreground">{t('cardCommand.noVuid')}</p> : null}
      {actions.check || actions.markApproved || actions.markNotApproved || actions.cancel ? (
        <div className="flex flex-wrap gap-1.5">
          {actions.check ? (
            <Button size="xs" variant="outline" disabled={busy} onClick={askCheck}>
              {t('cardCommand.check')}
            </Button>
          ) : null}
          {actions.markApproved ? (
            <Button size="xs" variant="outline" disabled={busy} onClick={() => decide('mark_approved')}>
              {t('cardCommand.markApproved')}
            </Button>
          ) : null}
          {actions.markNotApproved ? (
            <Button
              size="xs"
              variant="outline"
              className="text-destructive"
              disabled={busy}
              onClick={() => decide('mark_not_approved')}
            >
              {t('cardCommand.markNotApproved')}
            </Button>
          ) : null}
          {actions.cancel && cmd?.status === 'pending' ? (
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
