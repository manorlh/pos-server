'use client';

/**
 * One message: what was sent, every attempt and delivery report, and the authorised
 * actions — resend (a NEW explicit message, with a reason; never for an OTP), cancel a
 * waiting one, and reveal the full number (company managers and up, a reason, audited,
 * shown for a few seconds only).
 */

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Ban, Eye, Send } from 'lucide-react';
import {
  CANCELLABLE_STATES,
  RESENDABLE_STATES,
  cancelNotification,
  fetchNotification,
  resendNotification,
  revealRecipient,
} from '@/lib/notificationsApi';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { StateBadge } from './state-badge';
import { Field, NC, ReasonDialog, SideDrawer, TransientReveal, formatWhen, useNcErrorText } from './shared';

type Pending = 'resend' | 'cancel' | 'reveal' | null;

export function NotificationDrawer({
  id,
  onClose,
  canReveal,
}: {
  id: string | null;
  onClose: () => void;
  canReveal: boolean;
}) {
  const t = useTranslations(`${NC}.notifications`);
  const errorText = useNcErrorText();
  const qc = useQueryClient();
  const [dialog, setDialog] = useState<Pending>(null);
  // The revealed number lives here only, and only for a few seconds.
  const [revealed, setRevealed] = useState<string | null>(null);
  const hideRevealed = useCallback(() => setRevealed(null), []);

  const detail = useQuery({
    queryKey: ['notification', id],
    queryFn: () => fetchNotification(id as string),
    enabled: !!id,
  });
  const n = detail.data;

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['notification', id] });
    void qc.invalidateQueries({ queryKey: ['notifications-log'] });
    void qc.invalidateQueries({ queryKey: ['notifications-overview'] });
  };

  const resend = useMutation({
    mutationFn: (reason: string) => resendNotification(id as string, reason),
    onSuccess: () => {
      setDialog(null);
      toast.success(t('drawer.resent'));
      refresh();
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const cancel = useMutation({
    mutationFn: (reason: string) => cancelNotification(id as string, reason),
    onSuccess: () => {
      setDialog(null);
      toast.success(t('drawer.cancelled'));
      refresh();
    },
    onError: (err) => toast.error(errorText(err)),
  });
  const reveal = useMutation({
    mutationFn: (reason: string) => revealRecipient(id as string, reason),
    onSuccess: (data) => {
      setDialog(null);
      setRevealed(data.recipient);
    },
    onError: (err) => toast.error(errorText(err)),
  });

  const close = (open: boolean) => {
    if (!open) {
      setRevealed(null);
      onClose();
    }
  };

  const canResend = !!n && RESENDABLE_STATES.includes(n.state) && n.category !== 'authentication';
  const canCancel = !!n && CANCELLABLE_STATES.includes(n.state);

  return (
    <>
      <SideDrawer
        open={!!id}
        onOpenChange={close}
        title={t('drawer.title')}
        description={n ? `${t.has(`events.${n.eventType}`) ? t(`events.${n.eventType}`) : n.eventType} · ${formatWhen(n.createdAt)}` : undefined}
        footer={
          n ? (
            <>
              {canCancel ? (
                <Button variant="destructive" onClick={() => setDialog('cancel')}>
                  <Ban aria-hidden />
                  {t('drawer.cancel')}
                </Button>
              ) : null}
              {canResend ? (
                <Button variant="outline" onClick={() => setDialog('resend')}>
                  <Send aria-hidden />
                  {t('drawer.resend')}
                </Button>
              ) : null}
            </>
          ) : null
        }
      >
        {detail.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-6 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : detail.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {errorText(detail.error)}
          </p>
        ) : n ? (
          <>
            <div className="space-y-2">
              <Field label={t('cols.state')}>
                <StateBadge row={n} />
                {n.stateReason ? <span className="ms-2 text-xs text-muted-foreground">{n.stateReason}</span> : null}
              </Field>
              {n.state === 'provider_accepted' ? (
                <p className="rounded-md bg-sky-500/10 px-2 py-1 text-xs text-sky-900 dark:text-sky-200">
                  {t('acceptedIsNotDelivered')}
                </p>
              ) : null}
              <Field label={t('cols.recipient')}>
                <span className="flex flex-wrap items-center gap-2">
                  <span dir="ltr" className="font-mono">
                    {n.recipient}
                  </span>
                  {canReveal && !revealed ? (
                    <Button size="sm" variant="ghost" onClick={() => setDialog('reveal')}>
                      <Eye aria-hidden />
                      {t('drawer.reveal')}
                    </Button>
                  ) : null}
                </span>
              </Field>
              {revealed ? <TransientReveal value={revealed} onHide={hideRevealed} /> : null}
              <Field label={t('cols.shop')}>{n.shopName ?? '—'}</Field>
              <Field label={t('drawer.context')}>{n.contextLabel ?? n.aggregateRef ?? '—'}</Field>
              <Field label={t('cols.category')}>
                {t.has(`categories.${n.category}`) ? t(`categories.${n.category}`) : n.category}
              </Field>
              <Field label={t('drawer.mode')}>{n.providerMode ?? '—'}</Field>
              <Field label={t('cols.providerRef')}>
                <span dir="ltr" className="font-mono text-xs">
                  {n.providerRef ?? '—'}
                </span>
              </Field>
              <Field label={t('drawer.acceptedAt')}>{formatWhen(n.acceptedAt) || '—'}</Field>
              <Field label={t('drawer.deliveredAt')}>{formatWhen(n.deliveredAt) || '—'}</Field>
              <Field label={t('drawer.expiresAt')}>{formatWhen(n.expiresAt) || '—'}</Field>
              {n.resendOf ? <Field label={t('drawer.resendOf')}>{n.resendReason ?? ''}</Field> : null}
            </div>

            {n.text ? (
              <div className="space-y-1">
                <p className="text-xs font-medium text-muted-foreground">{t('drawer.text')}</p>
                <p className="whitespace-pre-wrap rounded-lg border bg-muted/30 p-3 text-sm">{n.text}</p>
              </div>
            ) : null}

            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">{t('drawer.attempts')}</p>
              {n.attemptsDetail.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('drawer.noAttempts')}</p>
              ) : (
                <ol className="space-y-1">
                  {n.attemptsDetail.map((a) => (
                    <li key={a.sequence} className="rounded-md border px-2 py-1.5 text-xs">
                      <div className="flex flex-wrap gap-x-3">
                        <span className="font-medium">#{a.sequence}</span>
                        <span>{formatWhen(a.startedAt)}</span>
                        <span>{a.mode}</span>
                        <span>{a.outcome ?? '…'}</span>
                        {a.httpStatus ? <span dir="ltr">HTTP {a.httpStatus}</span> : null}
                      </div>
                      {a.providerStatus || a.providerMessage || a.errorClass ? (
                        <div className="mt-0.5 text-muted-foreground">
                          {[a.errorClass, a.providerStatus, a.providerMessage].filter(Boolean).join(' · ')}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ol>
              )}
            </div>

            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground">{t('drawer.deliveryReports')}</p>
              {n.deliveryEvents.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t('drawer.noReports')}</p>
              ) : (
                <ol className="space-y-1">
                  {n.deliveryEvents.map((e, i) => (
                    <li key={`${e.receivedAt}-${i}`} className="rounded-md border px-2 py-1.5 text-xs">
                      <span className="font-medium">{e.mappedState ? t(`states.${e.mappedState}`) : e.rawStatus}</span>
                      <span className="ms-2 text-muted-foreground">
                        {formatWhen(e.eventAt ?? e.receivedAt)}
                        {e.rawStatus ? ` · ${e.rawStatus}` : ''}
                        {!e.applied ? ` · ${t('drawer.notApplied')}` : ''}
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </div>

            {n.category === 'authentication' ? (
              <p className="text-xs text-muted-foreground">{t('drawer.otpNoResend')}</p>
            ) : null}
          </>
        ) : null}
      </SideDrawer>

      <ReasonDialog
        open={dialog === 'resend'}
        onOpenChange={(open) => !open && setDialog(null)}
        title={t('drawer.resendTitle')}
        description={t('drawer.resendHint')}
        confirmLabel={t('drawer.resend')}
        onConfirm={(reason) => resend.mutate(reason)}
        pending={resend.isPending}
      />
      <ReasonDialog
        open={dialog === 'cancel'}
        onOpenChange={(open) => !open && setDialog(null)}
        title={t('drawer.cancelTitle')}
        description={t('drawer.cancelHint')}
        confirmLabel={t('drawer.cancel')}
        onConfirm={(reason) => cancel.mutate(reason)}
        pending={cancel.isPending}
        destructive
        required={false}
      />
      <ReasonDialog
        open={dialog === 'reveal'}
        onOpenChange={(open) => !open && setDialog(null)}
        title={t('drawer.revealTitle')}
        description={t('drawer.revealHint')}
        confirmLabel={t('drawer.reveal')}
        onConfirm={(reason) => reveal.mutate(reason)}
        pending={reveal.isPending}
      />
    </>
  );
}
