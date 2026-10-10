/**
 * The public club sign-up page's rules (`/join/[token]`), kept pure — no DOM, no
 * network — so `npm test` runs them with node:test (clubSignup.test.ts).
 *
 * * Phone numbers mirror the server (server/app/services/notifications/phone.py:
 *   `normalize_phone` + `normalize_mobile`): every usual Israeli shape is read
 *   ("050-123-4567", "0501234567", "501234567", "972…", "+972 50…", "00972…", and the
 *   mistake "+972 050…"); only an Israeli mobile (+9725XXXXXXXX) can get a code.
 * * The form's own checks mirror server/app/services/club/registration.py
 *   (`validate_form`): first name required, e-mail shape, birthday day/month.
 * * The countdown math for "שלחו שוב" (60 s gap from the server's `resendAfterSeconds`).
 * * Which step and field an error code from the server belongs to.
 *
 * The page config types live here (not in clubApi.ts) so this file compiles alone.
 */

// ── The public page's configuration (GET /public/club/{token}) ───────────────

export interface JoinDocument {
  id: string;
  version: number;
  title: string;
  body: string;
  url: string | null;
}

export interface JoinPageConfig {
  businessName: string;
  clubName: string;
  logoUrl: string | null;
  headline: string;
  intro: string | null;
  /** Only the business's own wording; empty = nothing is shown. */
  benefits: string[];
  shopName: string | null;
  fields: { lastName: boolean; email: boolean; birthday: boolean };
  documents: {
    terms: JoinDocument | null;
    privacy: JoinDocument | null;
    marketingSms: JoinDocument | null;
    marketingEmail: JoinDocument | null;
  };
  signupBenefit: { title: string } | null;
  successMessage: string | null;
  otp: {
    codeLength: number;
    expiresInSeconds: number;
    resendAfterSeconds: number;
    maxAttempts: number;
  };
}

/** What the person typed. The phone lives in memory only — never stored. */
export interface SignupForm {
  firstName: string;
  lastName: string;
  email: string;
  birthDay: string;
  birthMonth: string;
  phone: string;
  acceptTerms: boolean;
  marketingSms: boolean;
  marketingEmail: boolean;
}

export const EMPTY_SIGNUP_FORM: SignupForm = {
  firstName: '',
  lastName: '',
  email: '',
  birthDay: '',
  birthMonth: '',
  phone: '',
  // Never pre-ticked (§23).
  acceptTerms: false,
  marketingSms: false,
  marketingEmail: false,
};

// ── Phone ────────────────────────────────────────────────────────────────────

export type PhoneErrorCode =
  | 'phone_empty'
  | 'phone_invalid'
  | 'phone_not_mobile'
  | 'phone_foreign_unsupported';

export type PhoneResult = { ok: true; e164: string } | { ok: false; code: PhoneErrorCode };

// Spaces, dashes, dots, brackets and the bidi marks a phone keyboard may paste in.
const SEPARATORS = /[\s\-.()‎‏‪-‮]/g;
const E164 = /^\+[1-9]\d{7,14}$/;
const DIGITS = /^\d+$/;

const invalid: PhoneResult = { ok: false, code: 'phone_invalid' };

/** +972 + the national number without its trunk 0 (8 digits landline, 9 mobile). */
function israeli(national: string): PhoneResult {
  if (!DIGITS.test(national) || (national.length !== 8 && national.length !== 9) || national.startsWith('0')) {
    return invalid;
  }
  return { ok: true, e164: `+972${national}` };
}

function dropTrunkZero(national: string): string {
  return national.startsWith('0') ? national.slice(1) : national;
}

/** What the person typed → E.164, exactly as the server's `normalize_phone`. */
export function normalizePhone(raw: string | null | undefined): PhoneResult {
  if (raw == null) return { ok: false, code: 'phone_empty' };
  let text = String(raw).trim().replace(SEPARATORS, '');
  if (!text) return { ok: false, code: 'phone_empty' };
  if (text.startsWith('00')) text = `+${text.slice(2)}`;
  if (text.startsWith('+')) {
    const digits = text.slice(1);
    if (!DIGITS.test(digits)) return invalid;
    // "+972 050…": the trunk 0 does not belong after the country code.
    if (digits.startsWith('972')) return israeli(dropTrunkZero(digits.slice(3)));
    const e164 = `+${digits}`;
    return E164.test(e164) ? { ok: true, e164 } : invalid;
  }
  if (!DIGITS.test(text)) return invalid;
  if (text.startsWith('972') && text.length >= 11 && text.length <= 13) {
    return israeli(dropTrunkZero(text.slice(3)));
  }
  if (text.startsWith('0')) return israeli(text.slice(1));
  if (text.length === 9 && text.startsWith('5')) return israeli(text);
  return invalid;
}

export function isIsraeliMobileE164(e164: string): boolean {
  return /^\+9725\d{8}$/.test(e164);
}

/** An SMS-capable Israeli mobile, as the server's `normalize_mobile` requires. */
export function normalizeIsraeliMobile(raw: string | null | undefined): PhoneResult {
  const result = normalizePhone(raw);
  if (!result.ok) return result;
  if (!result.e164.startsWith('+972')) return { ok: false, code: 'phone_foreign_unsupported' };
  if (!isIsraeliMobileE164(result.e164)) return { ok: false, code: 'phone_not_mobile' };
  return result;
}

/** "+972501234567" → "050-123-4567" (anything else is returned as is). */
export function formatIsraeliMobile(e164: string): string {
  if (!isIsraeliMobileE164(e164)) return e164;
  const local = `0${e164.slice(4)}`;
  return `${local.slice(0, 3)}-${local.slice(3, 6)}-${local.slice(6)}`;
}

// ── The form ─────────────────────────────────────────────────────────────────

export type SignupField =
  | 'firstName'
  | 'lastName'
  | 'email'
  | 'birthday'
  | 'phone'
  | 'acceptTerms'
  | 'code';

export type SignupFieldErrors = Partial<Record<SignupField, string>>;

const EMAIL = /^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,24}$/;

export function isValidEmail(value: string): boolean {
  return EMAIL.test(value.trim());
}

/** Day + month of a birthday (no year), as the server accepts it. 29/2 is fine. */
export function isValidBirthday(day: number, month: number): boolean {
  if (!Number.isInteger(day) || !Number.isInteger(month)) return false;
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  if (month === 2 && day > 29) return false;
  if ([4, 6, 9, 11].includes(month) && day > 30) return false;
  return true;
}

/**
 * The checks the page can make before asking for a code: error codes per field
 * (`field_required`, `field_invalid`, `terms_required`, or a phone code). Empty = OK.
 */
export function validateSignupForm(form: SignupForm, fields: JoinPageConfig['fields']): SignupFieldErrors {
  const errors: SignupFieldErrors = {};
  const first = form.firstName.trim();
  if (!first) errors.firstName = 'field_required';
  else if (first.length > 60) errors.firstName = 'field_invalid';
  if (fields.lastName && form.lastName.trim().length > 60) errors.lastName = 'field_invalid';
  if (fields.email && form.email.trim() && !isValidEmail(form.email)) errors.email = 'field_invalid';
  if (fields.birthday && (form.birthDay || form.birthMonth)) {
    const day = Number(form.birthDay);
    const month = Number(form.birthMonth);
    if (!form.birthDay || !form.birthMonth || !isValidBirthday(day, month)) errors.birthday = 'field_invalid';
  }
  const phone = normalizeIsraeliMobile(form.phone);
  if (!phone.ok) errors.phone = phone.code;
  if (!form.acceptTerms) errors.acceptTerms = 'terms_required';
  return errors;
}

export interface RegisterBody {
  challengeId: string;
  clientSession: string;
  registrationToken: string;
  firstName: string;
  lastName?: string;
  email?: string;
  birthDay?: number;
  birthMonth?: number;
  acceptTerms: boolean;
  termsVersionId: string | null;
  privacyVersionId: string | null;
  marketingSms: boolean;
  marketingSmsVersionId?: string;
  marketingEmail?: boolean;
}

/**
 * The register request: the versions the page showed, `acceptTerms: true` only when
 * ticked, the marketing choices as plain booleans, and the optional fields only when
 * the page asked for them. The phone is not sent — the server takes it from the code.
 */
export function buildRegisterBody(
  form: SignupForm,
  config: Pick<JoinPageConfig, 'fields' | 'documents'>,
  verified: { challengeId: string; clientSession: string; registrationToken: string },
): RegisterBody {
  const body: RegisterBody = {
    challengeId: verified.challengeId,
    clientSession: verified.clientSession,
    registrationToken: verified.registrationToken,
    firstName: form.firstName.trim(),
    acceptTerms: form.acceptTerms === true,
    termsVersionId: config.documents.terms?.id ?? null,
    privacyVersionId: config.documents.privacy?.id ?? null,
    marketingSms: form.marketingSms === true && !!config.documents.marketingSms,
  };
  if (body.marketingSms && config.documents.marketingSms) {
    body.marketingSmsVersionId = config.documents.marketingSms.id;
  }
  if (config.fields.lastName && form.lastName.trim()) body.lastName = form.lastName.trim();
  if (config.fields.email && form.email.trim()) {
    body.email = form.email.trim();
    if (config.documents.marketingEmail) body.marketingEmail = form.marketingEmail === true;
  }
  if (config.fields.birthday && form.birthDay && form.birthMonth) {
    body.birthDay = Number(form.birthDay);
    body.birthMonth = Number(form.birthMonth);
  }
  return body;
}

// ── Countdown ────────────────────────────────────────────────────────────────

/** Whole seconds left until [targetMs] (rounded up, never negative). */
export function secondsUntil(targetMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((targetMs - nowMs) / 1000));
}

/** 75 → "1:15", 9 → "0:09". */
export function formatCountdown(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/**
 * When "שלחו שוב" opens: the server's gap after a send, or — when the server said
 * `resend_too_soon` — its `retryAfterSeconds` from now, whichever is later.
 */
export function resendOpensAt(
  sentAtMs: number,
  resendAfterSeconds: number,
  nowMs?: number,
  retryAfterSeconds?: number | null,
): number {
  const byGap = sentAtMs + Math.max(0, resendAfterSeconds) * 1000;
  if (retryAfterSeconds && retryAfterSeconds > 0 && nowMs !== undefined) {
    return Math.max(byGap, nowMs + retryAfterSeconds * 1000);
  }
  return byGap;
}

// ── Errors → where they show ─────────────────────────────────────────────────

export type SignupPhase = 'page' | 'start' | 'resend' | 'verify' | 'register';

/**
 * * `field`   — next to a field (`field` says which), on `step`.
 * * `wait`    — a resend asked too early: the countdown follows `retryAfterSeconds`.
 * * `newCode` — the code expired: ask for another (same challenge).
 * * `restart` — the challenge is gone: back to the form (fields kept), send again.
 * * `later`   — too many requests / the provider is down: a general message, try later.
 * * `reload`  — the terms changed since the page loaded: reload them, accept again.
 * * `retry`   — timeout, network or an unknown answer: a general message, try again.
 * * `unavailable` — the page itself is not available.
 */
export type SignupErrorAction =
  | 'field'
  | 'wait'
  | 'newCode'
  | 'restart'
  | 'later'
  | 'reload'
  | 'retry'
  | 'unavailable';

export interface SignupErrorPlan {
  code: string;
  step: 'form' | 'otp';
  field: SignupField | null;
  action: SignupErrorAction;
}

const REGISTER_FIELDS: Record<string, SignupField> = {
  firstName: 'firstName',
  lastName: 'lastName',
  email: 'email',
  birthday: 'birthday',
  acceptTerms: 'acceptTerms',
};

const RESTART_CODES = new Set([
  'challenge_invalid',
  'challenge_used',
  'too_many_attempts',
  'too_many_sends',
  'registration_invalid',
  'registration_expired',
]);

/** Which step, field and recovery an error code from the server (or the network) means. */
export function planSignupError(code: string, phase: SignupPhase, serverField?: string | null): SignupErrorPlan {
  const onOtp = phase === 'resend' || phase === 'verify';
  const step: 'form' | 'otp' = onOtp ? 'otp' : 'form';
  if (code === 'page_unavailable') return { code, step: 'form', field: null, action: 'unavailable' };
  if (code.startsWith('phone_')) return { code, step: 'form', field: 'phone', action: 'field' };
  if (code === 'wrong_code') return { code, step: 'otp', field: 'code', action: 'field' };
  if (code === 'code_expired') return { code, step: 'otp', field: 'code', action: 'newCode' };
  if (code === 'resend_too_soon') return { code, step: 'otp', field: null, action: 'wait' };
  if (RESTART_CODES.has(code)) return { code, step: 'form', field: null, action: 'restart' };
  if (code === 'too_many_requests' || code === 'provider_unavailable') {
    return { code, step, field: null, action: 'later' };
  }
  if (code === 'terms_required') return { code, step: 'form', field: 'acceptTerms', action: 'field' };
  if (code === 'terms_version_stale') return { code, step: 'form', field: 'acceptTerms', action: 'reload' };
  if (code === 'field_required' || code === 'field_invalid') {
    const field = serverField ? (REGISTER_FIELDS[serverField] ?? null) : null;
    return { code, step: 'form', field, action: field ? 'field' : 'retry' };
  }
  return { code, step, field: null, action: 'retry' };
}

/** The error codes that have their own fallback text on the page (else a generic one). */
export const KNOWN_SIGNUP_ERRORS = [
  'page_unavailable',
  'phone_empty',
  'phone_invalid',
  'phone_not_mobile',
  'phone_foreign_unsupported',
  'too_many_requests',
  'provider_unavailable',
  'challenge_invalid',
  'code_expired',
  'too_many_attempts',
  'wrong_code',
  'challenge_used',
  'resend_too_soon',
  'too_many_sends',
  'registration_invalid',
  'registration_expired',
  'field_required',
  'field_invalid',
  'terms_required',
  'terms_version_stale',
  'timeout',
  'network',
] as const;
