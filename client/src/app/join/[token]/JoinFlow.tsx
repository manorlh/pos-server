'use client';

/**
 * The club's public sign-up (§23–§25), in the order the spec gives: logo + business
 * name → the headline → the benefits exactly as configured (nothing when there are
 * none) → the form → the consents → "שלחו לי קוד אימות" → the code → success.
 *
 * * Consents: one required box for the terms + privacy (both readable here, at their
 *   active version), one optional box for marketing SMS with the active consent text,
 *   a separate e-mail box only when that channel exists. None is pre-ticked; joining
 *   without marketing works.
 * * The code: ONE accessible input (numeric, `autocomplete="one-time-code"`), "change
 *   number" (back to the form, fields kept — a new start voids the old code on the
 *   server), "send again" behind a visible 60 s countdown, and every state named:
 *   sending, sent, wrong (attempts left), expired, too many attempts, provider down,
 *   too many requests (with the server's wait).
 * * Privacy: the phone and the code live in this component's state only; `clientSession`
 *   (the server's anti-replay session) goes to sessionStorage — never localStorage.
 * * No endless spinner: every request times out (clubApi PUBLIC_TIMEOUT_MS) into a
 *   "try again" message. The server's `userMessage` is shown when it sends one.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { QRCodeSVG } from 'qrcode.react';
import { CheckCircle2, ChevronDown, Gift, Loader2, MessageSquareText, RotateCcw, Sparkles } from 'lucide-react';
import {
  PublicApiError,
  fetchJoinPage,
  registerJoin,
  resendJoinOtp,
  startJoinOtp,
  verifyJoinOtp,
  type JoinResult,
} from '@/lib/clubApi';
import {
  EMPTY_SIGNUP_FORM,
  buildRegisterBody,
  formatCountdown,
  formatIsraeliMobile,
  normalizeIsraeliMobile,
  planSignupError,
  resendOpensAt,
  secondsUntil,
  validateSignupForm,
  type JoinDocument,
  type JoinPageConfig,
  type SignupField,
  type SignupForm,
  type SignupPhase,
} from '@/lib/clubSignup';
import { cn } from '@/lib/utils';

const NS = 'notificationsClub.join';
const SESSION_KEY = (token: string) => `clubJoinSession:${token}`;

function readSession(token: string): string | null {
  try {
    return window.sessionStorage.getItem(SESSION_KEY(token));
  } catch {
    return null;
  }
}

function writeSession(token: string, value: string): void {
  try {
    window.sessionStorage.setItem(SESSION_KEY(token), value);
  } catch {
    /* private mode: the in-memory copy is enough */
  }
}

type Step = 'loading' | 'unavailable' | 'loadError' | 'form' | 'otp' | 'done';
type Busy = 'start' | 'resend' | 'verify' | 'register' | null;

interface Challenge {
  id: string;
  phoneE164: string;
  sentAt: number;
  expiresAt: number;
  resendAt: number;
  sendsLeft: number | null;
}

interface Verified {
  challengeId: string;
  registrationToken: string;
  phoneE164: string;
  expiresAt: number;
}

const inputCls =
  'block w-full rounded-xl border border-slate-300 bg-white px-3.5 py-3 text-base text-slate-900 shadow-sm outline-none transition placeholder:text-slate-400 focus-visible:border-sky-600 focus-visible:ring-4 focus-visible:ring-sky-600/25 aria-[invalid=true]:border-red-500 aria-[invalid=true]:ring-red-500/20';
const labelCls = 'mb-1.5 block text-sm font-medium text-slate-800';
const errorCls = 'mt-1.5 text-sm text-red-700';
const cardCls = 'rounded-3xl bg-white p-5 shadow-sm ring-1 ring-sky-900/5 sm:p-6';
const primaryBtn =
  'inline-flex w-full items-center justify-center gap-2 rounded-2xl bg-sky-700 px-5 py-3.5 text-base font-semibold text-white shadow-sm outline-none transition hover:bg-sky-800 focus-visible:ring-4 focus-visible:ring-sky-600/40 disabled:cursor-not-allowed disabled:opacity-60';
const linkBtn =
  'rounded-md text-sm font-medium text-sky-800 underline underline-offset-4 outline-none hover:text-sky-950 focus-visible:ring-4 focus-visible:ring-sky-600/30 disabled:cursor-not-allowed disabled:text-slate-400 disabled:no-underline';

function DocText({ doc, label }: { doc: JoinDocument; label: string }) {
  const t = useTranslations(NS);
  const [open, setOpen] = useState(false);
  const id = `doc-${doc.id}`;
  return (
    <div className="mt-1">
      <button type="button" className={cn(linkBtn, 'inline-flex items-center gap-1')} aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        <ChevronDown className={cn('h-4 w-4 transition-transform', open && 'rotate-180')} aria-hidden />
        {open ? t('hideDoc', { name: label }) : t('readDoc', { name: label })}
      </button>
      {open ? (
        <div id={id} className="mt-2 max-h-64 overflow-y-auto rounded-xl bg-sky-50 p-3 text-sm leading-relaxed text-slate-700">
          <p className="mb-1 font-medium text-slate-900">{doc.title}</p>
          <p className="whitespace-pre-wrap">{doc.body}</p>
          {doc.url ? (
            <a href={doc.url} target="_blank" rel="noreferrer" className={cn(linkBtn, 'mt-2 inline-block')}>
              {t('fullDocument')}
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Checkbox({
  id,
  checked,
  onChange,
  children,
  invalid,
  describedBy,
  disabled,
}: {
  id: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  children: React.ReactNode;
  invalid?: boolean;
  describedBy?: string;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        className="mt-0.5 h-6 w-6 shrink-0 cursor-pointer rounded-md border-slate-400 accent-sky-700 outline-none focus-visible:ring-4 focus-visible:ring-sky-600/30 disabled:cursor-not-allowed"
      />
      <div className="min-w-0 flex-1 text-sm leading-relaxed text-slate-800">{children}</div>
    </div>
  );
}

function Header({ config }: { config: JoinPageConfig }) {
  return (
    <header className="mb-5 text-center">
      {config.logoUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={config.logoUrl}
          alt=""
          className="mx-auto mb-3 h-20 w-20 rounded-2xl bg-white object-contain p-1.5 shadow-sm ring-1 ring-sky-900/10"
        />
      ) : null}
      <p className="text-lg font-semibold text-sky-950">{config.businessName}</p>
      {config.shopName ? <p className="text-sm text-slate-600">{config.shopName}</p> : null}
    </header>
  );
}

export function JoinFlow({ token }: { token: string }) {
  const t = useTranslations(NS);
  const [step, setStep] = useState<Step>('loading');
  const [config, setConfig] = useState<JoinPageConfig | null>(null);
  const [loadMessage, setLoadMessage] = useState<string | null>(null);
  const [form, setForm] = useState<SignupForm>(EMPTY_SIGNUP_FORM);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<SignupField, string>>>({});
  const [general, setGeneral] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [code, setCode] = useState('');
  const [verified, setVerified] = useState<Verified | null>(null);
  const [result, setResult] = useState<JoinResult | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const sessionRef = useRef<string | null>(null);
  const lastTriedCode = useRef<string | null>(null);
  const codeRef = useRef<HTMLInputElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  // ── Messages ──────────────────────────────────────────────────────────────

  const retryText = useCallback(
    (seconds: number | null): string | null => {
      if (!seconds || seconds <= 0) return null;
      if (seconds < 60) return t('retryInSeconds', { count: seconds });
      if (seconds < 3600) return t('retryInMinutes', { count: Math.ceil(seconds / 60) });
      return t('retryInHours', { count: Math.ceil(seconds / 3600) });
    },
    [t],
  );

  const messageFor = useCallback(
    (err: unknown): { code: string; text: string; err: PublicApiError | null } => {
      const e = err instanceof PublicApiError ? err : null;
      const errCode = e?.code ?? 'network';
      const base = e?.userMessage || (t.has(`errors.${errCode}`) ? t(`errors.${errCode}`) : t('errors.generic'));
      const wait = errCode === 'too_many_requests' ? retryText(e?.retryAfterSeconds ?? null) : null;
      return { code: errCode, text: wait ? `${base} ${wait}` : base, err: e };
    },
    [retryText, t],
  );

  // ── Load the page ─────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    setStep('loading');
    try {
      const page = await fetchJoinPage(token);
      setConfig(page);
      setStep('form');
    } catch (err) {
      const m = messageFor(err);
      if (m.code === 'page_unavailable') {
        setStep('unavailable');
      } else {
        setLoadMessage(m.text);
        setStep('loadError');
      }
    }
  }, [messageFor, token]);

  useEffect(() => {
    sessionRef.current = readSession(token);
    void load();
  }, [load, token]);

  // The countdowns tick only while the code step is on screen.
  useEffect(() => {
    if (step !== 'otp') return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [step]);

  useEffect(() => {
    if (step === 'otp') codeRef.current?.focus();
  }, [step]);

  const FIELD_OF: Partial<Record<keyof SignupForm, SignupField>> = {
    firstName: 'firstName',
    lastName: 'lastName',
    email: 'email',
    birthDay: 'birthday',
    birthMonth: 'birthday',
    phone: 'phone',
    acceptTerms: 'acceptTerms',
  };

  const set = <K extends keyof SignupForm>(key: K, value: SignupForm[K]) => {
    setForm((f) => ({ ...f, [key]: value }));
    const field = FIELD_OF[key];
    if (field && fieldErrors[field]) setFieldErrors((errs) => ({ ...errs, [field]: undefined }));
  };

  const focusField = (field: SignupField) => {
    window.setTimeout(() => {
      const el = formRef.current?.querySelector<HTMLElement>(`[data-field="${field}"]`);
      el?.focus();
    }, 0);
  };

  const fieldMessage = (fieldCode: string): string =>
    t.has(`errors.${fieldCode}`) ? t(`errors.${fieldCode}`) : t('errors.field_invalid');

  // ── Errors → step / field ─────────────────────────────────────────────────

  const handleError = (err: unknown, phase: SignupPhase) => {
    const m = messageFor(err);
    const plan = planSignupError(m.code, phase, m.err?.field);
    setNotice(null);
    switch (plan.action) {
      case 'unavailable':
        setStep('unavailable');
        return;
      case 'field':
        if (plan.field === 'code') {
          const left = m.err?.attemptsLeft;
          setFieldErrors((errs) => ({
            ...errs,
            code: left != null ? `${m.text} ${t('attemptsLeft', { count: left })}` : m.text,
          }));
          codeRef.current?.focus();
          codeRef.current?.select();
          return;
        }
        setStep('form');
        if (plan.field) {
          setFieldErrors((errs) => ({ ...errs, [plan.field as SignupField]: m.text }));
          focusField(plan.field);
        } else {
          setGeneral(m.text);
        }
        return;
      case 'newCode':
        setFieldErrors((errs) => ({ ...errs, code: m.text }));
        return;
      case 'wait':
        setChallenge((c) =>
          c ? { ...c, resendAt: resendOpensAt(c.sentAt, 0, Date.now(), m.err?.retryAfterSeconds ?? 60) } : c,
        );
        setGeneral(m.text);
        return;
      case 'restart':
        setChallenge(null);
        setVerified(null);
        setCode('');
        setStep('form');
        setGeneral(m.text);
        return;
      case 'reload':
        // The terms changed since the page loaded: show the new ones, ask again. The
        // verified code is kept (the server checks the form before using it up).
        setForm((f) => ({ ...f, acceptTerms: false, marketingSms: false, marketingEmail: false }));
        setStep('form');
        setFieldErrors((errs) => ({ ...errs, acceptTerms: m.text }));
        void fetchJoinPage(token)
          .then(setConfig)
          .catch(() => undefined);
        return;
      default:
        if (plan.step === 'form' && step !== 'form' && phase === 'register') setStep('form');
        setGeneral(m.text);
    }
  };

  // ── Actions ───────────────────────────────────────────────────────────────

  const register = async (v: Verified) => {
    if (!config || !sessionRef.current) return;
    setBusy('register');
    setGeneral(null);
    try {
      const out = await registerJoin(
        token,
        buildRegisterBody(form, config, {
          challengeId: v.challengeId,
          clientSession: sessionRef.current,
          registrationToken: v.registrationToken,
        }),
      );
      setResult(out);
      setVerified(null);
      setChallenge(null);
      setCode('');
      setStep('done');
    } catch (err) {
      handleError(err, 'register');
    } finally {
      setBusy(null);
    }
  };

  const start = async (phoneE164: string) => {
    setBusy('start');
    setGeneral(null);
    setNotice(null);
    try {
      const started = await startJoinOtp(token, { phone: phoneE164, clientSession: sessionRef.current });
      sessionRef.current = started.clientSession;
      writeSession(token, started.clientSession);
      const sentAt = Date.now();
      setNow(sentAt);
      setChallenge({
        id: started.challengeId,
        phoneE164,
        sentAt,
        expiresAt: sentAt + started.expiresInSeconds * 1000,
        resendAt: resendOpensAt(sentAt, started.resendAfterSeconds),
        sendsLeft: started.sendsLeft ?? null,
      });
      setVerified(null);
      setCode('');
      lastTriedCode.current = null;
      setFieldErrors({});
      setStep('otp');
    } catch (err) {
      handleError(err, 'start');
    } finally {
      setBusy(null);
    }
  };

  const submitForm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!config || busy) return;
    setGeneral(null);
    const errors = validateSignupForm(form, config.fields);
    if (Object.keys(errors).length) {
      const messages: Partial<Record<SignupField, string>> = {};
      for (const [field, errCode] of Object.entries(errors) as Array<[SignupField, string]>) {
        messages[field] = fieldMessage(errCode);
      }
      setFieldErrors(messages);
      const order: SignupField[] = ['firstName', 'lastName', 'email', 'birthday', 'phone', 'acceptTerms'];
      const first = order.find((f) => messages[f]);
      if (first) focusField(first);
      return;
    }
    setFieldErrors({});
    const phone = normalizeIsraeliMobile(form.phone);
    if (!phone.ok) return;
    // Already verified this number (a field was fixed after the code): register directly.
    if (verified && verified.phoneE164 === phone.e164 && Date.now() < verified.expiresAt) {
      void register(verified);
      return;
    }
    void start(phone.e164);
  };

  const resend = async () => {
    if (!challenge || !sessionRef.current || busy) return;
    setBusy('resend');
    setGeneral(null);
    setNotice(null);
    try {
      const out = await resendJoinOtp(token, { challengeId: challenge.id, clientSession: sessionRef.current });
      const sentAt = Date.now();
      setNow(sentAt);
      setChallenge({
        ...challenge,
        id: out.challengeId,
        sentAt,
        expiresAt: sentAt + out.expiresInSeconds * 1000,
        resendAt: resendOpensAt(sentAt, out.resendAfterSeconds),
        sendsLeft: out.sendsLeft,
      });
      setCode('');
      lastTriedCode.current = null;
      setFieldErrors((errs) => ({ ...errs, code: undefined }));
      setNotice(t('codeResent'));
      codeRef.current?.focus();
    } catch (err) {
      handleError(err, 'resend');
    } finally {
      setBusy(null);
    }
  };

  const verify = async (value: string) => {
    if (!challenge || !sessionRef.current || busy) return;
    lastTriedCode.current = value;
    setBusy('verify');
    setGeneral(null);
    setFieldErrors((errs) => ({ ...errs, code: undefined }));
    let v: Verified | null = null;
    try {
      const out = await verifyJoinOtp(token, { challengeId: challenge.id, clientSession: sessionRef.current, code: value });
      v = {
        challengeId: challenge.id,
        registrationToken: out.registrationToken,
        phoneE164: challenge.phoneE164,
        expiresAt: Date.now() + out.expiresInSeconds * 1000,
      };
      setVerified(v);
    } catch (err) {
      handleError(err, 'verify');
    } finally {
      setBusy(null);
    }
    if (v) await register(v);
  };

  const changeNumber = () => {
    // Back to the form with everything kept but the code; a new start voids the old one.
    setChallenge(null);
    setVerified(null);
    setCode('');
    setGeneral(null);
    setNotice(null);
    setFieldErrors({});
    setStep('form');
    focusField('phone');
  };

  const codeLength = config?.otp.codeLength ?? 6;
  const resendLeft = challenge ? secondsUntil(challenge.resendAt, now) : 0;
  const codeExpired = !!challenge && now >= challenge.expiresAt;
  const sendsExhausted = challenge?.sendsLeft === 0;

  const benefits = useMemo(() => (config?.benefits ?? []).filter((b) => b.trim()), [config]);

  // ── Render ────────────────────────────────────────────────────────────────

  if (step === 'loading') {
    return (
      <div className={cn(cardCls, 'flex items-center justify-center gap-2 py-16 text-slate-600')} role="status">
        <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
        {t('loading')}
      </div>
    );
  }

  if (step === 'unavailable') {
    return (
      <div className={cn(cardCls, 'py-12 text-center')}>
        <p className="text-lg font-semibold">{t('unavailableTitle')}</p>
        <p className="mt-2 text-sm text-slate-600">{t('unavailableBody')}</p>
      </div>
    );
  }

  if (step === 'loadError' || !config) {
    return (
      <div className={cn(cardCls, 'space-y-4 py-10 text-center')} role="alert">
        <p className="text-base font-medium">{loadMessage ?? t('errors.generic')}</p>
        <button type="button" className={primaryBtn} onClick={() => void load()}>
          <RotateCcw className="h-4 w-4" aria-hidden />
          {t('retry')}
        </button>
      </div>
    );
  }

  if (step === 'done' && result) {
    const existing = result.status === 'existing_member';
    return (
      <div className="space-y-4">
        <Header config={config} />
        <section className={cn(cardCls, 'space-y-4 text-center')} aria-live="polite">
          <CheckCircle2 className="mx-auto h-12 w-12 text-emerald-600" aria-hidden />
          <h1 className="text-2xl font-bold text-sky-950">{existing ? t('existingTitle') : t('successTitle')}</h1>
          {result.firstName ? <p className="text-slate-700">{t('hello', { name: result.firstName })}</p> : null}
          <div className="rounded-2xl bg-sky-50 p-4">
            <p className="text-sm text-slate-600">{t('memberNumber')}</p>
            <p className="text-3xl font-bold tabular-nums tracking-wide text-sky-900" dir="ltr">
              {result.memberNumber}
            </p>
          </div>
          {result.memberToken ? (
            <div className="space-y-2">
              <div className="mx-auto w-fit rounded-2xl bg-white p-3 ring-1 ring-sky-900/10">
                <QRCodeSVG value={result.memberToken} size={176} level="M" aria-label={t('memberQr')} />
              </div>
              <p className="text-sm text-slate-600">{t('memberQrHint')}</p>
            </div>
          ) : (
            <p className="text-sm text-slate-600">{t('memberNotActive')}</p>
          )}
          {result.benefit ? (
            <div className="flex items-start gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4 text-start">
              <Gift className="mt-0.5 h-5 w-5 shrink-0 text-amber-700" aria-hidden />
              <div>
                <p className="font-semibold text-amber-950">{result.benefit.title}</p>
                {result.benefit.validUntil ? (
                  <p className="text-sm text-amber-900">
                    {t('benefitValidUntil', { date: new Date(result.benefit.validUntil).toLocaleDateString('he-IL') })}
                  </p>
                ) : null}
              </div>
            </div>
          ) : null}
          {config.successMessage ? <p className="whitespace-pre-wrap text-slate-700">{config.successMessage}</p> : null}
        </section>
      </div>
    );
  }

  const docs = config.documents;
  const generalBox = general ? (
    <p role="alert" className="rounded-2xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
      {general}
    </p>
  ) : null;

  if (step === 'otp' && challenge) {
    return (
      <div className="space-y-4">
        <Header config={config} />
        <section className={cn(cardCls, 'space-y-5')}>
          <div className="space-y-1 text-center">
            <MessageSquareText className="mx-auto h-9 w-9 text-sky-700" aria-hidden />
            <h1 className="text-xl font-bold text-sky-950">{t('otpTitle')}</h1>
            <p className="text-sm text-slate-600" aria-live="polite">
              {t('codeSentTo')}{' '}
              <span dir="ltr" className="font-semibold text-slate-900">
                {formatIsraeliMobile(challenge.phoneE164)}
              </span>
            </p>
          </div>

          {generalBox}
          {notice ? (
            <p role="status" className="rounded-2xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
              {notice}
            </p>
          ) : null}

          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (code.length === codeLength) void verify(code);
              else setFieldErrors((errs) => ({ ...errs, code: t('errors.codeLength', { count: codeLength }) }));
            }}
            className="space-y-4"
            noValidate
          >
            <div>
              <label htmlFor="otp-code" className={labelCls}>
                {t('codeLabel', { count: codeLength })}
              </label>
              <input
                ref={codeRef}
                id="otp-code"
                name="one-time-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                maxLength={codeLength}
                dir="ltr"
                value={code}
                disabled={busy === 'verify' || busy === 'register'}
                aria-invalid={!!fieldErrors.code || undefined}
                aria-describedby={fieldErrors.code ? 'otp-code-error' : 'otp-code-hint'}
                onChange={(e) => {
                  const digits = e.target.value.replace(/\D/g, '').slice(0, codeLength);
                  setCode(digits);
                  if (fieldErrors.code) setFieldErrors((errs) => ({ ...errs, code: undefined }));
                  // A full code is checked at once (pasted, typed or autofilled) — once.
                  if (digits.length === codeLength && digits !== lastTriedCode.current && !codeExpired) {
                    void verify(digits);
                  }
                }}
                className={cn(inputCls, 'text-center font-mono text-2xl tracking-[0.5em]')}
              />
              {fieldErrors.code ? (
                <p id="otp-code-error" className={errorCls} role="alert">
                  {fieldErrors.code}
                </p>
              ) : codeExpired ? (
                <p id="otp-code-hint" className={errorCls} role="alert">
                  {t('errors.code_expired')}
                </p>
              ) : (
                <p id="otp-code-hint" className="mt-1.5 text-sm text-slate-600">
                  {t('codeValidFor', { time: formatCountdown(secondsUntil(challenge.expiresAt, now)) })}
                </p>
              )}
            </div>

            <div className="sticky bottom-0 -mx-5 bg-gradient-to-t from-white via-white to-white/0 px-5 pb-[env(safe-area-inset-bottom)] pt-3 sm:static sm:mx-0 sm:bg-none sm:p-0">
              <button type="submit" className={primaryBtn} disabled={!!busy || code.length !== codeLength || codeExpired}>
                {busy === 'verify' || busy === 'register' ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : null}
                {busy === 'verify' ? t('verifying') : busy === 'register' ? t('registering') : t('verify')}
              </button>
            </div>
          </form>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
            <button type="button" className={linkBtn} onClick={changeNumber} disabled={busy === 'verify' || busy === 'register'}>
              {t('changeNumber')}
            </button>
            <div className="text-sm" aria-live="polite">
              {sendsExhausted ? (
                <span className="text-slate-600">{t('noMoreResends')}</span>
              ) : resendLeft > 0 ? (
                <span className="text-slate-600">{t('resendIn', { time: formatCountdown(resendLeft) })}</span>
              ) : (
                <button type="button" className={linkBtn} onClick={() => void resend()} disabled={!!busy}>
                  {busy === 'resend' ? t('sending') : t('resend')}
                </button>
              )}
            </div>
          </div>
        </section>
      </div>
    );
  }

  // ── The form ──────────────────────────────────────────────────────────────

  const err = (field: SignupField) => fieldErrors[field];
  const described = (field: SignupField, hint?: string) =>
    [err(field) ? `${field}-error` : null, hint ?? null].filter(Boolean).join(' ') || undefined;

  return (
    <div className="space-y-4">
      <Header config={config} />

      <section className={cn(cardCls, 'space-y-3 text-center')}>
        <h1 className="text-2xl font-bold text-sky-950">{config.headline || t('defaultHeadline')}</h1>
        {config.intro ? <p className="whitespace-pre-wrap text-slate-700">{config.intro}</p> : null}
        {benefits.length > 0 ? (
          <ul className="space-y-2 text-start">
            {benefits.map((b, i) => (
              <li key={i} className="flex items-start gap-2 rounded-2xl bg-sky-50 px-3 py-2.5 text-slate-800">
                <Sparkles className="mt-0.5 h-4 w-4 shrink-0 text-sky-700" aria-hidden />
                <span>{b}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {config.signupBenefit ? (
          <p className="flex items-center justify-center gap-2 rounded-2xl border border-amber-300 bg-amber-50 px-3 py-2.5 text-sm font-medium text-amber-950">
            <Gift className="h-4 w-4 shrink-0" aria-hidden />
            {t('signupBenefit', { title: config.signupBenefit.title })}
          </p>
        ) : null}
      </section>

      <form ref={formRef} onSubmit={submitForm} noValidate className={cn(cardCls, 'space-y-5')}>
        {generalBox}

        <div>
          <label htmlFor="firstName" className={labelCls}>
            {t('firstName')} <span className="text-red-700">*</span>
          </label>
          <input
            id="firstName"
            data-field="firstName"
            className={inputCls}
            value={form.firstName}
            onChange={(e) => set('firstName', e.target.value)}
            autoComplete="given-name"
            maxLength={60}
            required
            aria-required="true"
            aria-invalid={!!err('firstName') || undefined}
            aria-describedby={described('firstName')}
          />
          {err('firstName') ? (
            <p id="firstName-error" className={errorCls}>
              {err('firstName')}
            </p>
          ) : null}
        </div>

        {config.fields.lastName ? (
          <div>
            <label htmlFor="lastName" className={labelCls}>
              {t('lastName')} <span className="font-normal text-slate-500">{t('optional')}</span>
            </label>
            <input
              id="lastName"
              data-field="lastName"
              className={inputCls}
              value={form.lastName}
              onChange={(e) => set('lastName', e.target.value)}
              autoComplete="family-name"
              maxLength={60}
              aria-invalid={!!err('lastName') || undefined}
              aria-describedby={described('lastName')}
            />
            {err('lastName') ? (
              <p id="lastName-error" className={errorCls}>
                {err('lastName')}
              </p>
            ) : null}
          </div>
        ) : null}

        {config.fields.email ? (
          <div>
            <label htmlFor="email" className={labelCls}>
              {t('email')} <span className="font-normal text-slate-500">{t('optional')}</span>
            </label>
            <input
              id="email"
              data-field="email"
              type="email"
              inputMode="email"
              dir="ltr"
              className={inputCls}
              value={form.email}
              onChange={(e) => set('email', e.target.value)}
              autoComplete="email"
              maxLength={254}
              aria-invalid={!!err('email') || undefined}
              aria-describedby={described('email')}
            />
            {err('email') ? (
              <p id="email-error" className={errorCls}>
                {err('email')}
              </p>
            ) : null}
          </div>
        ) : null}

        {config.fields.birthday ? (
          <fieldset aria-describedby={described('birthday', 'birthday-hint')}>
            <legend className={labelCls}>
              {t('birthday')} <span className="font-normal text-slate-500">{t('optional')}</span>
            </legend>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="birthDay" className="mb-1 block text-xs text-slate-600">
                  {t('day')}
                </label>
                <select
                  id="birthDay"
                  data-field="birthday"
                  className={inputCls}
                  value={form.birthDay}
                  onChange={(e) => set('birthDay', e.target.value)}
                  autoComplete="bday-day"
                  aria-invalid={!!err('birthday') || undefined}
                >
                  <option value="">—</option>
                  {Array.from({ length: 31 }, (_, i) => String(i + 1)).map((d) => (
                    <option key={d} value={d}>
                      {d}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="birthMonth" className="mb-1 block text-xs text-slate-600">
                  {t('month')}
                </label>
                <select
                  id="birthMonth"
                  className={inputCls}
                  value={form.birthMonth}
                  onChange={(e) => set('birthMonth', e.target.value)}
                  autoComplete="bday-month"
                  aria-invalid={!!err('birthday') || undefined}
                >
                  <option value="">—</option>
                  {Array.from({ length: 12 }, (_, i) => String(i + 1)).map((m) => (
                    <option key={m} value={m}>
                      {t(`months.${m}`)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <p id="birthday-hint" className="mt-1.5 text-xs text-slate-500">
              {t('birthdayHint')}
            </p>
            {err('birthday') ? (
              <p id="birthday-error" className={errorCls}>
                {err('birthday')}
              </p>
            ) : null}
          </fieldset>
        ) : null}

        <div>
          <label htmlFor="phone" className={labelCls}>
            {t('phone')} <span className="text-red-700">*</span>
          </label>
          <input
            id="phone"
            data-field="phone"
            type="tel"
            inputMode="tel"
            autoComplete="tel"
            dir="ltr"
            className={cn(inputCls, 'text-start')}
            value={form.phone}
            onChange={(e) => set('phone', e.target.value)}
            maxLength={20}
            required
            aria-required="true"
            aria-invalid={!!err('phone') || undefined}
            aria-describedby={described('phone', 'phone-hint')}
          />
          <p id="phone-hint" className="mt-1.5 text-xs text-slate-500">
            {t('phoneHint')}
          </p>
          {err('phone') ? (
            <p id="phone-error" className={errorCls}>
              {err('phone')}
            </p>
          ) : null}
        </div>

        <fieldset className="space-y-4 rounded-2xl bg-slate-50 p-4">
          <legend className="sr-only">{t('consentsLegend')}</legend>
          {docs.terms && docs.privacy ? (
            <div>
              <Checkbox
                id="acceptTerms"
                checked={form.acceptTerms}
                onChange={(v) => set('acceptTerms', v)}
                invalid={!!err('acceptTerms')}
                describedBy={err('acceptTerms') ? 'acceptTerms-error' : undefined}
              >
                <label htmlFor="acceptTerms" data-field="acceptTerms" className="cursor-pointer">
                  {t('acceptTerms', { terms: docs.terms.title, privacy: docs.privacy.title })}{' '}
                  <span className="text-red-700">*</span>
                </label>
                <DocText doc={docs.terms} label={docs.terms.title} />
                <DocText doc={docs.privacy} label={docs.privacy.title} />
              </Checkbox>
              {err('acceptTerms') ? (
                <p id="acceptTerms-error" className={errorCls}>
                  {err('acceptTerms')}
                </p>
              ) : null}
            </div>
          ) : null}

          {docs.marketingSms ? (
            <Checkbox id="marketingSms" checked={form.marketingSms} onChange={(v) => set('marketingSms', v)}>
              <label htmlFor="marketingSms" className="cursor-pointer whitespace-pre-wrap">
                {docs.marketingSms.body}
              </label>
              <p className="mt-1 text-xs text-slate-500">{t('marketingOptional')}</p>
              {docs.marketingSms.url ? (
                <a href={docs.marketingSms.url} target="_blank" rel="noreferrer" className={cn(linkBtn, 'text-xs')}>
                  {t('fullDocument')}
                </a>
              ) : null}
            </Checkbox>
          ) : null}

          {docs.marketingEmail && config.fields.email ? (
            <Checkbox
              id="marketingEmail"
              checked={form.marketingEmail}
              onChange={(v) => set('marketingEmail', v)}
              disabled={!form.email.trim()}
              describedBy="marketingEmail-hint"
            >
              <label htmlFor="marketingEmail" className="cursor-pointer whitespace-pre-wrap">
                {docs.marketingEmail.body}
              </label>
              <p id="marketingEmail-hint" className="mt-1 text-xs text-slate-500">
                {form.email.trim() ? t('marketingOptional') : t('marketingEmailNeedsEmail')}
              </p>
            </Checkbox>
          ) : null}
        </fieldset>

        <div className="sticky bottom-0 -mx-5 bg-gradient-to-t from-white via-white to-white/0 px-5 pb-[env(safe-area-inset-bottom)] pt-3 sm:static sm:mx-0 sm:bg-none sm:p-0">
          <button type="submit" className={primaryBtn} disabled={!!busy}>
            {busy ? <Loader2 className="h-5 w-5 animate-spin" aria-hidden /> : null}
            {busy === 'start' ? t('sending') : busy === 'register' ? t('registering') : verified ? t('finish') : t('sendCode')}
          </button>
        </div>
        <p className="text-center text-xs text-slate-500">{t('smsNotice')}</p>
      </form>
    </div>
  );
}
