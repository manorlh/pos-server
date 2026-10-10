'use client';

/**
 * The card's enquiry form — the same form on the public card and in the editor's preview. What
 * happens on submit is the caller's: the public card posts it (and says "נשמר" only when the
 * server answers that the enquiry is stored); the preview only validates and says nothing was sent.
 *
 * Accessible: visible labels, required marks in text, errors tied to their fields
 * (aria-invalid / aria-describedby), an error summary that takes focus, a polite live region for
 * the result. A hidden honeypot field catches bots without a CAPTCHA.
 */
import { useId, useRef, useState, type FormEvent } from 'react';

import {
  cardWords,
  isEmail,
  normalizePhone,
  type CardLang,
  type EnquiryFieldKey,
  type PublicEnquiry,
} from '@/lib/businessCards';

export interface EnquiryValues {
  submissionId: string;
  name: string;
  phone: string;
  email: string;
  topic: string;
  message: string;
  consent: boolean;
  /** The honeypot: always empty for a person. */
  website: string;
}

export type EnquiryResult =
  | { kind: 'saved'; duplicate: boolean }
  | { kind: 'simulated' }
  | { kind: 'invalid'; fields: Record<string, string> }
  | { kind: 'rate_limited' }
  | { kind: 'failed' };

type Errors = Partial<Record<EnquiryFieldKey | 'contact' | 'consent', string>>;

function newId(): string {
  return typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** The client's copy of the server's checks (the server decides). */
export function validateEnquiry(cfg: PublicEnquiry, v: EnquiryValues, lang: CardLang): Errors {
  const w = cardWords(lang);
  const errors: Errors = {};
  const val: Record<EnquiryFieldKey, string> = { name: v.name, phone: v.phone, email: v.email, topic: v.topic, message: v.message };
  for (const key of ['name', 'phone', 'email', 'topic', 'message'] as EnquiryFieldKey[]) {
    if (cfg.fields[key] === 'required' && !val[key].trim()) errors[key] = w.errRequired;
  }
  const phone = v.phone.trim();
  const email = v.email.trim();
  if (cfg.fields.phone !== 'off' && phone && !normalizePhone(phone)) errors.phone = w.errPhone;
  if (cfg.fields.email !== 'off' && email && !isEmail(email)) errors.email = w.errEmail;
  if (!errors.phone && !errors.email && !phone && !email) errors.contact = w.errContact;
  if (!v.consent) errors.consent = w.errConsent;
  return errors;
}

export function EnquiryForm({
  enquiry,
  lang,
  onSubmit,
}: {
  enquiry: PublicEnquiry;
  lang: CardLang;
  onSubmit: (values: EnquiryValues) => Promise<EnquiryResult>;
}) {
  const w = cardWords(lang);
  const uid = useId();
  const [values, setValues] = useState<EnquiryValues>(() => ({
    submissionId: newId(),
    name: '',
    phone: '',
    email: '',
    topic: '',
    message: '',
    consent: false,
    website: '',
  }));
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ tone: 'ok' | 'error' | 'info'; text: string } | null>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  const f = enquiry.fields;

  const set = <K extends keyof EnquiryValues>(key: K, value: EnquiryValues[K]) => setValues((v) => ({ ...v, [key]: value }));
  const id = (k: string) => `${uid}-${k}`;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    const found = validateEnquiry(enquiry, values, lang);
    setErrors(found);
    if (Object.keys(found).length) {
      setStatus({ tone: 'error', text: w.fixErrors });
      requestAnimationFrame(() => summaryRef.current?.focus());
      return;
    }
    setBusy(true);
    setStatus({ tone: 'info', text: w.sending });
    try {
      const result = await onSubmit(values);
      if (result.kind === 'saved') {
        setStatus({ tone: 'ok', text: result.duplicate ? w.duplicate : w.saved });
        setValues({ submissionId: newId(), name: '', phone: '', email: '', topic: '', message: '', consent: false, website: '' });
      } else if (result.kind === 'simulated') {
        setStatus({ tone: 'info', text: w.simEnquiry });
      } else if (result.kind === 'invalid') {
        const mapped: Errors = {};
        for (const [k, why] of Object.entries(result.fields)) {
          const key = k as keyof Errors;
          mapped[key] = why === 'invalid' ? (k === 'email' ? w.errEmail : k === 'phone' ? w.errPhone : w.errRequired) : k === 'consent' ? w.errConsent : k === 'contact' ? w.errContact : w.errRequired;
        }
        setErrors(mapped);
        setStatus({ tone: 'error', text: w.fixErrors });
      } else if (result.kind === 'rate_limited') {
        setStatus({ tone: 'error', text: w.rateLimited });
      } else {
        // Not stored (network, server): say so — never "saved" — and keep what was typed.
        setStatus({ tone: 'error', text: w.notSaved });
      }
    } finally {
      setBusy(false);
    }
  };

  const input =
    'mt-1 block w-full rounded-[calc(var(--bc-radius)*0.6)] border px-3 py-2.5 text-[1em] outline-none focus-visible:outline-3 focus-visible:outline-offset-1 focus-visible:outline-[color:var(--bc-accent)]';
  const inputStyle = { background: 'var(--bc-bg)', color: 'var(--bc-text)', borderColor: 'color-mix(in srgb, var(--bc-text) 35%, transparent)' };
  const label = (k: EnquiryFieldKey, text: string) => (
    <label htmlFor={id(k)} className="text-[0.92em] font-semibold">
      {text} <span className="font-normal text-[color:var(--bc-muted)]">({f[k] === 'required' ? w.required : w.optional})</span>
    </label>
  );
  const err = (k: keyof Errors) =>
    errors[k] ? (
      <p id={id(`${k}-err`)} className="mt-1 text-[0.88em] font-semibold" style={{ color: 'var(--bc-text)' }}>
        <span aria-hidden>⚠ </span>
        {errors[k]}
      </p>
    ) : null;
  const aria = (k: keyof Errors) => ({
    'aria-invalid': errors[k] || (errors.contact && (k === 'phone' || k === 'email')) ? true : undefined,
    'aria-describedby': errors[k] ? id(`${k}-err`) : errors.contact && (k === 'phone' || k === 'email') ? id('contact-err') : undefined,
    'aria-required': f[k as EnquiryFieldKey] === 'required' ? true : undefined,
  });
  const privacyLabel = w.consent.split('{privacy}');

  return (
    <form onSubmit={submit} noValidate className="relative grid gap-3">
      {status?.tone === 'error' && Object.keys(errors).length ? (
        <div ref={summaryRef} tabIndex={-1} role="alert" className="rounded-[calc(var(--bc-radius)*0.6)] border-2 p-3 text-[0.92em] font-semibold" style={{ borderColor: 'var(--bc-accent)' }}>
          {w.fixErrors}
        </div>
      ) : null}
      {f.name !== 'off' ? (
        <div>
          {label('name', w.name)}
          <input id={id('name')} className={input} style={inputStyle} autoComplete="name" maxLength={120} value={values.name} onChange={(e) => set('name', e.target.value)} {...aria('name')} />
          {err('name')}
        </div>
      ) : null}
      {f.phone !== 'off' ? (
        <div>
          {label('phone', w.phone)}
          <input
            id={id('phone')}
            type="tel"
            inputMode="tel"
            dir="ltr"
            className={`${input} text-start`}
            style={inputStyle}
            autoComplete="tel"
            maxLength={30}
            value={values.phone}
            onChange={(e) => set('phone', e.target.value)}
            {...aria('phone')}
          />
          {err('phone')}
        </div>
      ) : null}
      {f.email !== 'off' ? (
        <div>
          {label('email', w.email)}
          <input
            id={id('email')}
            type="email"
            dir="ltr"
            className={`${input} text-start`}
            style={inputStyle}
            autoComplete="email"
            maxLength={254}
            value={values.email}
            onChange={(e) => set('email', e.target.value)}
            {...aria('email')}
          />
          {err('email')}
        </div>
      ) : null}
      {errors.contact ? (
        <p id={id('contact-err')} className="text-[0.88em] font-semibold">
          <span aria-hidden>⚠ </span>
          {errors.contact}
        </p>
      ) : null}
      {f.topic !== 'off' ? (
        <div>
          {label('topic', w.topic)}
          {enquiry.topics.length ? (
            <select id={id('topic')} className={input} style={inputStyle} value={values.topic} onChange={(e) => set('topic', e.target.value)} {...aria('topic')}>
              <option value="">{w.chooseTopic}</option>
              {enquiry.topics.map((t) => (
                <option key={t.text} value={t.text} lang={t.lang}>
                  {t.text}
                </option>
              ))}
            </select>
          ) : (
            <input id={id('topic')} className={input} style={inputStyle} maxLength={120} value={values.topic} onChange={(e) => set('topic', e.target.value)} {...aria('topic')} />
          )}
          {err('topic')}
        </div>
      ) : null}
      {f.message !== 'off' ? (
        <div>
          {label('message', w.message)}
          <textarea id={id('message')} rows={4} className={input} style={inputStyle} maxLength={2000} value={values.message} onChange={(e) => set('message', e.target.value)} {...aria('message')} />
          {err('message')}
        </div>
      ) : null}
      {/* Honeypot: hidden from people and assistive technology; bots fill it. */}
      <div aria-hidden className="sr-only">
        <label htmlFor={id('website')}>Website</label>
        <input id={id('website')} tabIndex={-1} autoComplete="off" value={values.website} onChange={(e) => set('website', e.target.value)} />
      </div>
      <div className="flex items-start gap-2">
        <input
          id={id('consent')}
          type="checkbox"
          className="mt-1 size-5 shrink-0 accent-[color:var(--bc-primary)]"
          checked={values.consent}
          onChange={(e) => set('consent', e.target.checked)}
          aria-invalid={errors.consent ? true : undefined}
          aria-describedby={errors.consent ? id('consent-err') : undefined}
          aria-required
        />
        <div>
          <label htmlFor={id('consent')} className="text-[0.92em]">
            {privacyLabel[0]}
            {enquiry.privacyUrl ? (
              <a href={enquiry.privacyUrl} target="_blank" rel="noopener noreferrer" className="font-semibold underline underline-offset-4">
                {w.consentDoc}
              </a>
            ) : (
              w.consentDoc
            )}
            {privacyLabel[1] ?? ''} <span className="text-[color:var(--bc-muted)]">({w.required})</span>
          </label>
          {err('consent')}
        </div>
      </div>
      <button
        type="submit"
        disabled={busy}
        className="min-h-11 rounded-[var(--bc-radius)] px-4 py-2.5 font-semibold disabled:opacity-70 focus-visible:outline-3 focus-visible:outline-offset-2 focus-visible:outline-[color:var(--bc-accent)]"
        style={{ background: 'var(--bc-primary)', color: 'var(--bc-on-primary)' }}
      >
        {busy ? w.sending : w.submit}
      </button>
      <p aria-live="polite" role="status" className="min-h-[1.25em] text-[0.92em] font-semibold">
        {status && status.tone !== 'error' ? status.text : status?.tone === 'error' && !Object.keys(errors).length ? status.text : ''}
      </p>
    </form>
  );
}
