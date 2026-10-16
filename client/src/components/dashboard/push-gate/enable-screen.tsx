'use client';

/**
 * "הפעל התראות" — the `PushGate`'s screen (pwa-push-required §2.2–2.3): one tap asks the system
 * for permission and registers this device (the alerts page's own flow, lib/pushAlertsApi.ts), a
 * test notification follows and "קיבלתי" confirms it. Starts where the device is: install first
 * on an iPhone in Safari, update iOS, a browser without push, or blocked (how to unblock).
 * The steps are lib/pushGate.ts `initialStep` / `nextStep`.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { BellRing, CircleCheck, Loader2, TriangleAlert } from 'lucide-react';
import { promptInstall } from '@/lib/installPrompt';
import { sendPushTest, subscribeThisBrowser } from '@/lib/pushAlertsApi';
import {
  deniedHelp,
  initialStep,
  installHelp,
  nextStep,
  type FlowEvent,
  type FlowStep,
  type GateFacts,
} from '@/lib/pushGate';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DeniedSteps, InstallHelpView } from './install-help';

function status(err: unknown): number | undefined {
  return (err as { response?: { status?: number } })?.response?.status;
}

export function EnableScreen({
  open,
  facts,
  publicKey,
  userId,
  startAt,
  onClose,
  onChanged,
  onConfirmed,
}: {
  open: boolean;
  facts: GateFacts;
  publicKey: string | null;
  /** The signed-in person: "wanted here" is remembered for them (lib/pushAlertsApi.ts). */
  userId?: string | null;
  /** Open at this step (the install help from the install bar); else where the device is. */
  startAt?: FlowStep;
  onClose: () => void;
  /** Registered / test sent: re-read this device's state. */
  onChanged: () => void;
  /** "קיבלתי": the flow is done on this device. */
  onConfirmed: () => void;
}) {
  const t = useTranslations('pushGate.screen');
  const [step, setStep] = useState<FlowStep>(() => startAt ?? initialStep(facts));
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = (event: FlowEvent) => setStep((s) => nextStep(s, event));

  /** The button's own tap (the system requires one): ask, register, send the test. */
  const enable = async () => {
    setNote(null);
    go('tap_enable');
    try {
      const outcome = await subscribeThisBrowser(publicKey, {}, userId);
      if (outcome === 'denied') {
        if (step === 'denied') setNote(t('stillDenied'));
        go('denied');
        return;
      }
      if (outcome === 'not_configured') {
        setNote(t('notConfigured'));
        go('failed');
        return;
      }
      onChanged();
      try {
        await sendPushTest();
      } catch (err) {
        // 429: a test was sent moments ago — it is on its way all the same.
        if (status(err) !== 429) setNote(t('testFailed'));
      }
      go('subscribed');
    } catch {
      go('failed');
    }
  };

  const resend = async () => {
    setBusy(true);
    setNote(null);
    try {
      await sendPushTest();
      go('resent');
    } catch (err) {
      setNote(status(err) === 429 ? null : t('testFailed'));
      if (status(err) === 429) go('resent');
    } finally {
      setBusy(false);
    }
  };

  const install = async () => {
    const outcome = await promptInstall();
    if (outcome !== 'unavailable') onClose();
  };

  const help = installHelp(facts);
  const required = facts.mode === 'required';
  const title =
    step === 'install'
      ? t('installTitle')
      : step === 'update_ios'
        ? t('updateTitle')
        : step === 'unsupported'
          ? t('unsupportedTitle')
          : step === 'denied'
            ? t('deniedTitle')
            : step === 'test'
              ? t('testTitle')
              : step === 'not_received'
                ? t('notReceivedTitle')
                : step === 'done'
                  ? t('doneTitle')
                  : step === 'error'
                    ? t('errorTitle')
                    : t('title');

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {step === 'done' ? (
              <CircleCheck className="size-5 text-emerald-600 dark:text-emerald-400" aria-hidden />
            ) : step === 'denied' || step === 'error' ? (
              <TriangleAlert className="size-5 text-destructive" aria-hidden />
            ) : (
              <BellRing className="size-5 text-primary" aria-hidden />
            )}
            {title}
          </DialogTitle>
          {step === 'enable' ? <DialogDescription>{t('intro')}</DialogDescription> : null}
        </DialogHeader>

        <div className="space-y-4">
          {required && step !== 'done' ? (
            <p className="rounded-lg border border-red-300 bg-red-50 p-2 text-xs text-red-900 dark:border-red-900 dark:bg-red-950/60 dark:text-red-100">
              {t('requiredNote')}
            </p>
          ) : null}

          {step === 'install' ? (
            <>
              <InstallHelpView help={help === 'none' ? 'ios_steps' : help} />
              {help === 'android_prompt' ? (
                <Button className="h-12 w-full text-base" onClick={() => void install()}>
                  {t('installButton')}
                </Button>
              ) : null}
            </>
          ) : null}

          {step === 'update_ios' ? <InstallHelpView help="ios_update" /> : null}
          {step === 'unsupported' ? <p className="text-sm">{t('unsupportedBody')}</p> : null}

          {step === 'enable' ? (
            <>
              <Button className="h-12 w-full text-base" onClick={() => void enable()}>
                <BellRing className="size-5" aria-hidden />
                {t('allow')}
              </Button>
              <p className="text-center text-xs text-muted-foreground">{t('allowHint')}</p>
            </>
          ) : null}

          {step === 'working' ? (
            <p className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-5 animate-spin" aria-hidden />
              {t('working')}
            </p>
          ) : null}

          {step === 'test' ? (
            <>
              <p className="text-sm">{t('testBody')}</p>
              <div className="grid grid-cols-2 gap-2">
                <Button className="h-12 text-base" onClick={() => { go('received'); onConfirmed(); }}>
                  {t('received')}
                </Button>
                <Button variant="outline" className="h-12 text-base" onClick={() => go('not_received')}>
                  {t('notReceived')}
                </Button>
              </div>
            </>
          ) : null}

          {step === 'not_received' ? (
            <>
              <ul className="list-disc space-y-1 ps-5 text-sm">
                <li>{t('tip1')}</li>
                <li>{t('tip2')}</li>
                <li>{t('tip3')}</li>
              </ul>
              <div className="grid grid-cols-2 gap-2">
                <Button className="h-11" disabled={busy} onClick={() => void resend()}>
                  {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                  {t('resend')}
                </Button>
                <Button variant="outline" className="h-11" onClick={() => { go('received'); onConfirmed(); }}>
                  {t('received')}
                </Button>
              </div>
            </>
          ) : null}

          {step === 'denied' ? (
            <>
              <p className="text-sm">{t('deniedBody')}</p>
              <DeniedSteps help={deniedHelp(facts.platform, facts.standalone)} />
              <Button className="h-11 w-full" onClick={() => void enable()}>
                {t('checkAgain')}
              </Button>
            </>
          ) : null}

          {step === 'error' ? (
            <>
              <p className="text-sm">{t('errorBody')}</p>
              <Button className="h-11 w-full" onClick={() => void enable()}>
                {t('retry')}
              </Button>
            </>
          ) : null}

          {step === 'done' ? <p className="text-sm">{t('doneBody')}</p> : null}

          {note ? <p className="text-sm text-destructive">{note}</p> : null}

          <Button variant="ghost" className="h-11 w-full" onClick={onClose}>
            {step === 'done' ? t('finish') : t('later')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
