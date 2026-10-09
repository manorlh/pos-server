'use client';

/**
 * Marketing SMS opt-out (§29): open the link, press one button, done — no password, no
 * code. Service messages (a ready order, a sign-up code) are not affected.
 */

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CheckCircle2, Loader2, RotateCcw } from 'lucide-react';
import { PublicApiError, confirmUnsubscribe, fetchUnsubscribeInfo } from '@/lib/clubApi';
import { cn } from '@/lib/utils';

const NS = 'notificationsClub.join';
const cardCls = 'rounded-3xl bg-white p-6 text-center shadow-sm ring-1 ring-sky-900/5';
const primaryBtn =
  'inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-sky-700 px-5 py-3.5 text-base font-semibold text-white shadow-sm outline-none transition hover:bg-sky-800 focus-visible:ring-4 focus-visible:ring-sky-600/40 disabled:cursor-not-allowed disabled:opacity-60';

type State = 'loading' | 'ready' | 'invalid' | 'error' | 'done';

export function UnsubscribeFlow({ token }: { token: string }) {
  const t = useTranslations(NS);
  const [state, setState] = useState<State>('loading');
  const [clubName, setClubName] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const text = useCallback(
    (err: unknown) => {
      const e = err instanceof PublicApiError ? err : null;
      const code = e?.code ?? 'network';
      return e?.userMessage || (t.has(`errors.${code}`) ? t(`errors.${code}`) : t('errors.generic'));
    },
    [t],
  );

  const load = useCallback(async () => {
    setState('loading');
    try {
      const info = await fetchUnsubscribeInfo(token);
      setClubName(info.clubName);
      setState('ready');
    } catch (err) {
      const e = err instanceof PublicApiError ? err : null;
      if (e?.status === 404) {
        setState('invalid');
      } else {
        setMessage(text(err));
        setState('error');
      }
    }
  }, [text, token]);

  useEffect(() => {
    void load();
  }, [load]);

  const confirm = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await confirmUnsubscribe(token);
      setState('done');
    } catch (err) {
      const e = err instanceof PublicApiError ? err : null;
      if (e?.status === 404) setState('invalid');
      else setMessage(text(err));
    } finally {
      setBusy(false);
    }
  };

  if (state === 'loading') {
    return (
      <div className={cn(cardCls, 'flex items-center justify-center gap-2 py-16 text-slate-600')} role="status">
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
        {t('loading')}
      </div>
    );
  }
  if (state === 'invalid') {
    return (
      <div className={cardCls}>
        <p className="text-lg font-semibold">{t('unsubscribe.invalidTitle')}</p>
        <p className="mt-2 text-sm text-slate-600">{t('unsubscribe.invalidBody')}</p>
      </div>
    );
  }
  if (state === 'error') {
    return (
      <div className={cn(cardCls, 'space-y-4')} role="alert">
        <p>{message}</p>
        <button type="button" className={primaryBtn} onClick={() => void load()}>
          <RotateCcw className="h-4 w-4" aria-hidden />
          {t('retry')}
        </button>
      </div>
    );
  }
  if (state === 'done') {
    return (
      <div className={cn(cardCls, 'space-y-3')} aria-live="polite">
        <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-600" aria-hidden />
        <h1 className="text-xl font-bold text-sky-950">{t('unsubscribe.doneTitle')}</h1>
        <p className="text-sm text-slate-600">{t('unsubscribe.doneBody')}</p>
      </div>
    );
  }
  return (
    <div className={cn(cardCls, 'space-y-4')}>
      <h1 className="text-xl font-bold text-sky-950">{t('unsubscribe.title')}</h1>
      <p className="text-slate-700">
        {clubName ? t('unsubscribe.bodyNamed', { club: clubName }) : t('unsubscribe.body')}
      </p>
      <p className="text-sm text-slate-500">{t('unsubscribe.serviceNote')}</p>
      {message ? (
        <p role="alert" className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
          {message}
        </p>
      ) : null}
      <button type="button" className={primaryBtn} disabled={busy} onClick={() => void confirm()}>
        {busy ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : null}
        {t('unsubscribe.button')}
      </button>
    </div>
  );
}
