'use client';

/**
 * `PushDiagnosis` — "בדיקת התראות" (fix/pwa-push): one button sends a test notification to this
 * device (or to all of mine) and walks the way it travels, step by step, in Hebrew — the browser
 * supports it → the permission → the service worker → this device registered on the server (fixed
 * on the spot: registered again when missing, failing or made with an old key) → the server's send
 * (each push service's status code) → the worker saw it arrive here → "קיבלת?", and per platform
 * what to check when it did not show (Windows: Focus Assist, the system's and the site's settings,
 * the browser running in the background; Android: install, the app's notification channel, battery
 * saver). The rules are lib/pushDiagnosis.ts.
 */

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { useQueryClient } from '@tanstack/react-query';
import { Circle, CircleCheck, CircleMinus, CircleX, Loader2, Send, TriangleAlert } from 'lucide-react';
import { useAuth } from '@/lib/auth';
import { pushSupport } from '@/lib/pushAlerts';
import {
  browserName,
  configProblem,
  firstFailure,
  initialSteps,
  serverOutcome,
  serviceName,
  setStep,
  tipsFor,
  tipsPlatform,
  type DiagState,
  type DiagStep,
  type DiagStepId,
  type TestResult,
} from '@/lib/pushDiagnosis';
import {
  currentEndpointHash,
  ensureWorker,
  runPushTest,
  subscribeThisBrowser,
  subscriptionKeyMatches,
} from '@/lib/pushAlertsApi';
import { fetchPushStatus } from '@/lib/pushPolicyApi';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';

/** How long step 6 waits for the worker to say the test arrived here. */
const ARRIVAL_WAIT_MS = 15_000;

const STATE_ICON: Record<DiagState, typeof Circle> = {
  pending: Circle,
  running: Loader2,
  ok: CircleCheck,
  warn: TriangleAlert,
  fail: CircleX,
  skipped: CircleMinus,
};

const STATE_COLOR: Record<DiagState, string> = {
  pending: 'text-muted-foreground',
  running: 'text-primary animate-spin',
  ok: 'text-emerald-600 dark:text-emerald-400',
  warn: 'text-orange-500',
  fail: 'text-destructive',
  skipped: 'text-muted-foreground/60',
};

function httpError(err: unknown): { status?: number; detail?: { code?: string; retryAfter?: number | null; problem?: string | null } } {
  const response = (err as { response?: { status?: number; data?: { detail?: unknown } } })?.response;
  const detail = response?.data?.detail;
  return { status: response?.status, detail: detail && typeof detail === 'object' ? (detail as Record<string, never>) : undefined };
}

function standaloneNow(): boolean {
  const nav = navigator as Navigator & { standalone?: boolean };
  return window.matchMedia?.('(display-mode: standalone)').matches || nav.standalone === true;
}

export function PushDiagnosis({
  publicKey,
  configured,
  problem,
  onChanged,
}: {
  publicKey: string | null;
  configured: boolean;
  problem?: string | null;
  /** The device was registered again / the test went out: re-read the devices list. */
  onChanged?: () => void;
}) {
  const t = useTranslations('phoneAlerts.diag');
  const userId = useAuth((s) => s.user?.id ?? null);
  const qc = useQueryClient();
  const [steps, setSteps] = useState<DiagStep[]>(initialSteps);
  const [running, setRunning] = useState(false);
  const [started, setStarted] = useState(false);
  const [allDevices, setAllDevices] = useState(false);
  const [results, setResults] = useState<TestResult[] | null>(null);
  const [answer, setAnswer] = useState<'yes' | 'no' | null>(null);
  const [arrived, setArrived] = useState(false);
  const arrivedIds = useRef(new Set<string>());
  const testId = useRef<string | null>(null);
  const [env, setEnv] = useState<{ ua: string; touch: number; standalone: boolean } | null>(null);

  // The worker tells the open pages a push arrived (public/sw.js `tellPages`).
  useEffect(() => {
    setEnv({ ua: navigator.userAgent, touch: navigator.maxTouchPoints ?? 0, standalone: standaloneNow() });
    if (!('serviceWorker' in navigator)) return;
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; kind?: string; testId?: string | null } | null;
      if (!data || data.type !== 'r2m-push' || data.kind !== 'test' || !data.testId) return;
      arrivedIds.current.add(data.testId);
      if (data.testId === testId.current) setArrived(true);
    };
    navigator.serviceWorker.addEventListener('message', onMessage);
    navigator.serviceWorker.startMessages?.();
    return () => navigator.serviceWorker.removeEventListener('message', onMessage);
  }, []);

  const browser = env ? (browserName(env.ua) ?? t('theBrowser')) : t('theBrowser');
  const platform = env ? tipsPlatform(env.ua, env.touch) : 'other';

  const run = async () => {
    let s = initialSteps();
    const update = (id: DiagStepId, patch: Omit<DiagStep, 'id'>) => {
      s = setStep(s, id, patch);
      setSteps(s);
    };
    setStarted(true);
    setRunning(true);
    setResults(null);
    setAnswer(null);
    setArrived(false);
    testId.current = null;
    setSteps(s);
    try {
      // 1. The browser.
      const ua = navigator.userAgent;
      const standalone = standaloneNow();
      const support = pushSupport({
        hasServiceWorker: 'serviceWorker' in navigator,
        hasPushManager: 'PushManager' in window,
        hasNotification: 'Notification' in window,
        permission: null,
        userAgent: ua,
        standalone,
      });
      if (support === 'ios_needs_install') return update('support', { state: 'fail', note: 'iosInstall' });
      if (support !== 'ok') return update('support', { state: 'fail', note: 'unsupported' });
      update('support', { state: 'ok', note: 'ok', values: { browser: browserName(ua) ?? t('theBrowser') } });

      // 2. The permission — asked here, from the button's own tap, when not decided yet.
      update('permission', { state: 'running' });
      let permission = Notification.permission;
      if (permission === 'default') permission = await Notification.requestPermission();
      if (permission === 'denied') {
        const where = tipsPlatform(ua) === 'android' && standalone ? 'deniedAndroidApp' : tipsPlatform(ua) === 'ios' ? 'deniedIos' : 'denied';
        return update('permission', { state: 'fail', note: where });
      }
      if (permission !== 'granted') return update('permission', { state: 'fail', note: 'dismissed' });
      update('permission', { state: 'ok', note: 'granted' });

      // 3. The service worker.
      update('worker', { state: 'running' });
      try {
        const reg = await ensureWorker();
        update('worker', { state: 'ok', note: 'active', values: { scope: new URL(reg.scope).pathname } });
      } catch (err) {
        return update('worker', { state: 'fail', note: (err as Error)?.message === 'sw_timeout' ? 'timeout' : 'failed' });
      }

      // 4. This device on the server — registered again on the spot when it is not right.
      update('subscription', { state: 'running' });
      const blocking = configProblem(problem);
      if (!configured || !publicKey) {
        return update('subscription', { state: 'fail', note: blocking?.note === 'unreadableKey' ? 'serverKeyUnreadable' : 'serverNotConfigured' });
      }
      let hash = await currentEndpointHash().catch(() => null);
      let status = await fetchPushStatus(hash);
      const keyOk = await subscriptionKeyMatches(publicKey).catch(() => true);
      const failing = !!status.thisDevice?.failing;
      if (!hash || !status.thisDeviceRegistered || !keyOk || failing) {
        const note = !hash || !status.thisDeviceRegistered ? 'created' : !keyOk ? 'keyRenewed' : 'renewedFailing';
        const lastError = status.thisDevice?.lastError ?? '';
        try {
          const outcome = await subscribeThisBrowser(publicKey, {}, userId);
          if (outcome !== 'subscribed') return update('subscription', { state: 'fail', note: 'notSaved' });
        } catch (err) {
          return update('subscription', { state: 'fail', note: 'failed', values: { error: (err as Error)?.message || String(err) } });
        }
        hash = await currentEndpointHash().catch(() => null);
        status = await fetchPushStatus(hash);
        if (!status.thisDeviceRegistered) return update('subscription', { state: 'fail', note: 'notSaved' });
        update('subscription', {
          state: 'ok',
          note,
          values: { error: lastError.slice(0, 80) || '—', label: status.thisDevice?.label || t('results.device') },
        });
        onChanged?.();
      } else {
        update('subscription', { state: 'ok', note: 'exists', values: { label: status.thisDevice?.label || t('results.device') } });
      }

      // 5. The server's send.
      update('server', { state: 'running' });
      let mine: TestResult | null = null;
      try {
        const res = await runPushTest(allDevices ? 'all' : 'this', hash);
        testId.current = res.testId;
        if (arrivedIds.current.has(res.testId)) setArrived(true);
        setResults(res.results);
        mine = res.results.find((r) => r.thisDevice) ?? null;
        void qc.invalidateQueries({ queryKey: ['push-devices'] });
        void qc.invalidateQueries({ queryKey: ['push-history'] });
      } catch (err) {
        const { status: code, detail } = httpError(err);
        if (code === 429) return update('server', { state: 'warn', note: 'tooSoon', values: { seconds: detail?.retryAfter ?? 30 } });
        if (code === 409) return update('server', { state: 'fail', note: 'notConfigured' });
        if (code === 422 && detail?.code === 'device_not_registered') return update('server', { state: 'fail', note: 'notRegistered' });
        return update('server', { state: 'fail', note: code ? 'httpError' : 'offline', values: { status: code ?? '—' } });
      }
      if (!mine) {
        update('server', { state: 'ok', note: 'sentOthers' });
        return update('arrived', { state: 'skipped', note: 'otherDevices' });
      }
      const outcome = serverOutcome(mine);
      const values = { status: mine.status ?? '—', service: serviceName(mine.service), error: mine.error ?? '' };
      if (outcome.fixable) {
        // Gone / refused: register again now; the next test (in 30 s) goes to the new registration.
        await subscribeThisBrowser(publicKey, {}, userId).catch(() => undefined);
        onChanged?.();
      }
      update('server', { state: outcome.state, note: outcome.note, values });
      if (outcome.state === 'fail') return;

      // 6. Arrived here (the worker says so).
      update('arrived', { state: 'running', note: 'waiting' });
      const deadline = Date.now() + ARRIVAL_WAIT_MS;
      while (Date.now() < deadline && !arrivedIds.current.has(testId.current ?? '')) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (arrivedIds.current.has(testId.current ?? '')) {
        setArrived(true);
        update('arrived', { state: 'ok', note: 'shown' });
      } else {
        update('arrived', { state: 'warn', note: 'notYet' });
      }
    } catch (err) {
      const id = s.find((x) => x.state === 'running')?.id ?? 'support';
      update(id, { state: 'fail', note: 'unexpected', values: { error: (err as Error)?.message || String(err) } });
    } finally {
      setRunning(false);
    }
  };

  const stoppedAt = firstFailure(steps);
  const serverStep = steps.find((x) => x.id === 'server');
  const askReceived = started && !running && !stoppedAt && serverStep?.state === 'ok';
  const tips = tipsFor(platform, { standalone: env?.standalone ?? false, arrived });

  return (
    <section className="space-y-3 rounded-2xl border p-4" aria-live="polite">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 font-semibold">
          <Send className="size-4" aria-hidden />
          {t('title')}
        </h3>
        <p className="text-xs text-muted-foreground">{t('hint')}</p>
      </div>
      {problem && configProblem(problem) && !configProblem(problem)?.blocking ? (
        <p className="rounded-lg bg-orange-50 p-2 text-xs text-orange-900 dark:bg-orange-950 dark:text-orange-200">
          {t(`config.${configProblem(problem)?.note}`)}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button onClick={() => void run()} disabled={running}>
          {running ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Send className="size-4" aria-hidden />}
          {t('send')}
        </Button>
        <label className="flex items-center gap-2 text-sm">
          <Switch checked={allDevices} onCheckedChange={setAllDevices} disabled={running} aria-label={t('allDevices')} />
          {t('allDevices')}
        </label>
      </div>

      {started ? (
        <ol className="space-y-2">
          {steps.map((step, i) => {
            const Icon = STATE_ICON[step.state];
            return (
              <li key={step.id} className="flex items-start gap-2 text-sm">
                <Icon className={cn('mt-0.5 size-4 shrink-0', STATE_COLOR[step.state])} aria-hidden />
                <span className="min-w-0">
                  <span className={cn('block font-medium', step.state === 'skipped' && 'text-muted-foreground')}>
                    {i + 1}. {t(`${step.id}.title`)}
                    <span className="sr-only"> — {t(`state.${step.state}`)}</span>
                  </span>
                  {step.note ? (
                    <span className="block text-xs text-muted-foreground">
                      {t(`${step.id}.${step.note}`, { browser, scope: '/', label: '', error: '', status: '—', service: '', seconds: 30, ...step.values })}
                    </span>
                  ) : null}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}

      {results && results.length > 1 ? (
        <div className="space-y-1">
          <p className="text-xs font-semibold">{t('results.title')}</p>
          <ul className="divide-y rounded-lg border text-xs">
            {results.map((r) => {
              const out = serverOutcome(r);
              const Icon = STATE_ICON[out.state];
              return (
                <li key={r.deviceId} className="flex items-center gap-2 px-2 py-1.5">
                  <Icon className={cn('size-3.5 shrink-0', STATE_COLOR[out.state])} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">
                    {r.label ?? t('results.device')}
                    {r.thisDevice ? <span className="text-muted-foreground"> · {t('results.thisDevice')}</span> : null}
                  </span>
                  <span className="shrink-0 text-muted-foreground" dir="ltr">
                    {serviceName(r.service)} · {r.status ?? r.error ?? '—'}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}

      {askReceived ? (
        <div className="space-y-2 rounded-xl bg-muted/50 p-3">
          <p className="text-sm font-semibold">{t('question')}</p>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant={answer === 'yes' ? 'default' : 'outline'} onClick={() => setAnswer('yes')}>
              {t('yes')}
            </Button>
            <Button size="sm" variant={answer === 'no' ? 'default' : 'outline'} onClick={() => setAnswer('no')}>
              {t('no')}
            </Button>
          </div>
          {answer === 'yes' ? <p className="text-sm text-emerald-700 dark:text-emerald-400">{t('success')}</p> : null}
        </div>
      ) : null}

      {answer === 'no' || (started && !running && (stoppedAt === 'server' || steps.find((x) => x.id === 'arrived')?.state === 'warn')) ? (
        <div className="space-y-1">
          <p className="text-xs font-semibold">{t('tipsTitle')}</p>
          <ul className="list-disc space-y-1 ps-5 text-xs text-muted-foreground">
            {tips.map((tip) => (
              <li key={tip}>{t(`tips.${tip}`, { browser })}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
