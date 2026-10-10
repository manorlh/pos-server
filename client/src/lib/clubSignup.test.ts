/**
 * Run with `npm test`. The public club sign-up page's rules (lib/clubSignup.ts) — the
 * phone cases mirror server/tests (phone.py): the page must agree with the server.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_SIGNUP_FORM,
  buildRegisterBody,
  formatCountdown,
  formatIsraeliMobile,
  isValidBirthday,
  isValidEmail,
  normalizeIsraeliMobile,
  normalizePhone,
  planSignupError,
  resendOpensAt,
  secondsUntil,
  validateSignupForm,
  type JoinPageConfig,
  type SignupForm,
} from './clubSignup';

const e164 = (raw: string) => {
  const r = normalizeIsraeliMobile(raw);
  return r.ok ? r.e164 : r.code;
};

describe('normalizeIsraeliMobile', () => {
  it('reads every usual Israeli mobile shape', () => {
    for (const raw of [
      '0501234567',
      '050-123-4567',
      '050 123 4567',
      '(050) 123.4567',
      '501234567',
      '972501234567',
      '9720501234567',
      '+972501234567',
      '+972 50 123 4567',
      '+972 050-123-4567',
      '00972501234567',
      '‎050-123-4567‏',
    ]) {
      assert.equal(e164(raw), '+972501234567', raw);
    }
  });

  it('says why a number cannot get a code', () => {
    assert.equal(e164(''), 'phone_empty');
    assert.equal(e164('   '), 'phone_empty');
    assert.equal(e164('abc'), 'phone_invalid');
    assert.equal(e164('12345'), 'phone_invalid');
    // Nine digits read as a landline (8 national digits), like the server does.
    assert.equal(e164('050123456'), 'phone_not_mobile');
    assert.equal(e164('05012345678'), 'phone_invalid');
    assert.equal(e164('+972 0'), 'phone_invalid');
    // A landline is a valid number, but not one an SMS reaches.
    assert.equal(e164('03-1234567'), 'phone_not_mobile');
    assert.equal(e164('+97231234567'), 'phone_not_mobile');
    // Foreign numbers are understood, and refused for now (server P0).
    assert.equal(e164('+447911123456'), 'phone_foreign_unsupported');
    assert.equal(e164('0044 7911 123456'), 'phone_foreign_unsupported');
  });

  it('keeps normalizePhone and the mobile rule apart', () => {
    assert.deepEqual(normalizePhone('031234567'), { ok: true, e164: '+97231234567' });
    assert.deepEqual(normalizePhone(null), { ok: false, code: 'phone_empty' });
    assert.deepEqual(normalizePhone('+12'), { ok: false, code: 'phone_invalid' });
  });

  it('formats a mobile for the screen', () => {
    assert.equal(formatIsraeliMobile('+972501234567'), '050-123-4567');
    assert.equal(formatIsraeliMobile('+447911123456'), '+447911123456');
  });
});

describe('form checks', () => {
  const fields = { lastName: true, email: true, birthday: true };
  const good: SignupForm = { ...EMPTY_SIGNUP_FORM, firstName: 'דנה', phone: '0501234567', acceptTerms: true };

  it('never starts with a ticked consent', () => {
    assert.equal(EMPTY_SIGNUP_FORM.acceptTerms, false);
    assert.equal(EMPTY_SIGNUP_FORM.marketingSms, false);
    assert.equal(EMPTY_SIGNUP_FORM.marketingEmail, false);
  });

  it('accepts the minimum: first name, phone and the terms', () => {
    assert.deepEqual(validateSignupForm(good, fields), {});
  });

  it('puts each problem on its own field', () => {
    const errors = validateSignupForm(
      { ...EMPTY_SIGNUP_FORM, email: 'not-an-email', birthDay: '31', birthMonth: '4', phone: '03-1234567' },
      fields,
    );
    assert.deepEqual(errors, {
      firstName: 'field_required',
      email: 'field_invalid',
      birthday: 'field_invalid',
      phone: 'phone_not_mobile',
      acceptTerms: 'terms_required',
    });
  });

  it('ignores the optional fields the page does not ask for', () => {
    const errors = validateSignupForm(
      { ...good, email: 'bad', birthDay: '40', birthMonth: '1' },
      { lastName: false, email: false, birthday: false },
    );
    assert.deepEqual(errors, {});
  });

  it('needs both day and month of a birthday', () => {
    assert.equal(validateSignupForm({ ...good, birthDay: '5' }, fields).birthday, 'field_invalid');
    assert.deepEqual(validateSignupForm({ ...good, birthDay: '29', birthMonth: '2' }, fields), {});
  });

  it('checks e-mail and birthday like the server', () => {
    assert.equal(isValidEmail('dana@example.co.il'), true);
    assert.equal(isValidEmail('dana@example'), false);
    assert.equal(isValidEmail('da na@example.com'), false);
    assert.equal(isValidBirthday(29, 2), true);
    assert.equal(isValidBirthday(30, 2), false);
    assert.equal(isValidBirthday(31, 6), false);
    assert.equal(isValidBirthday(31, 12), true);
    assert.equal(isValidBirthday(0, 1), false);
    assert.equal(isValidBirthday(1, 13), false);
  });
});

describe('buildRegisterBody', () => {
  const doc = (id: string) => ({ id, version: 1, title: id, body: `${id} text`, url: null });
  const config: Pick<JoinPageConfig, 'fields' | 'documents'> = {
    fields: { lastName: false, email: false, birthday: true },
    documents: { terms: doc('t1'), privacy: doc('p1'), marketingSms: doc('m1'), marketingEmail: null },
  };
  const verified = { challengeId: 'c', clientSession: 's'.repeat(24), registrationToken: 'r' };

  it('joins without marketing — the box left unticked is a plain false', () => {
    const body = buildRegisterBody(
      { ...EMPTY_SIGNUP_FORM, firstName: ' דנה ', phone: '0501234567', acceptTerms: true },
      config,
      verified,
    );
    assert.deepEqual(body, {
      challengeId: 'c',
      clientSession: 's'.repeat(24),
      registrationToken: 'r',
      firstName: 'דנה',
      acceptTerms: true,
      termsVersionId: 't1',
      privacyVersionId: 'p1',
      marketingSms: false,
    });
    // The phone never goes with the form: the server takes it from the verified code.
    assert.equal('phone' in body, false);
  });

  it('sends the marketing version only with the opt-in, and the fields the page asked for', () => {
    const body = buildRegisterBody(
      {
        ...EMPTY_SIGNUP_FORM,
        firstName: 'דנה',
        lastName: 'כהן',
        email: 'd@e.com',
        birthDay: '7',
        birthMonth: '3',
        acceptTerms: true,
        marketingSms: true,
        marketingEmail: true,
      },
      config,
      verified,
    );
    assert.equal(body.marketingSms, true);
    assert.equal(body.marketingSmsVersionId, 'm1');
    assert.equal(body.lastName, undefined);
    assert.equal(body.email, undefined);
    assert.equal(body.marketingEmail, undefined);
    assert.equal(body.birthDay, 7);
    assert.equal(body.birthMonth, 3);
  });

  it('never claims acceptance that was not ticked, nor marketing without its text', () => {
    const body = buildRegisterBody(
      { ...EMPTY_SIGNUP_FORM, firstName: 'דנה', marketingSms: true },
      { ...config, documents: { ...config.documents, marketingSms: null } },
      verified,
    );
    assert.equal(body.acceptTerms, false);
    assert.equal(body.marketingSms, false);
    assert.equal(body.marketingSmsVersionId, undefined);
  });
});

describe('countdown', () => {
  it('counts whole seconds up, never below zero', () => {
    assert.equal(secondsUntil(10_000, 0), 10);
    assert.equal(secondsUntil(10_000, 9_001), 1);
    assert.equal(secondsUntil(10_000, 10_000), 0);
    assert.equal(secondsUntil(10_000, 20_000), 0);
  });

  it('formats m:ss', () => {
    assert.equal(formatCountdown(60), '1:00');
    assert.equal(formatCountdown(59), '0:59');
    assert.equal(formatCountdown(9), '0:09');
    assert.equal(formatCountdown(-3), '0:00');
  });

  it('opens the resend after the gap, or later when the server says so', () => {
    assert.equal(resendOpensAt(1_000, 60), 61_000);
    assert.equal(resendOpensAt(1_000, 60, 5_000, 90), 95_000);
    assert.equal(resendOpensAt(1_000, 60, 5_000, 10), 61_000);
  });
});

describe('planSignupError', () => {
  it('puts phone problems next to the phone on the form', () => {
    assert.deepEqual(planSignupError('phone_not_mobile', 'start'), {
      code: 'phone_not_mobile',
      step: 'form',
      field: 'phone',
      action: 'field',
    });
  });

  it('keeps a wrong code on the code field, an expired one asks for another', () => {
    assert.equal(planSignupError('wrong_code', 'verify').field, 'code');
    assert.equal(planSignupError('code_expired', 'verify').action, 'newCode');
    assert.equal(planSignupError('resend_too_soon', 'resend').action, 'wait');
  });

  it('sends a dead challenge back to the form to start again', () => {
    for (const code of ['too_many_attempts', 'challenge_invalid', 'challenge_used', 'too_many_sends', 'registration_expired']) {
      const plan = planSignupError(code, 'verify');
      assert.equal(plan.action, 'restart', code);
      assert.equal(plan.step, 'form', code);
    }
  });

  it('keeps "try later" on the step it happened', () => {
    assert.equal(planSignupError('too_many_requests', 'start').step, 'form');
    assert.equal(planSignupError('provider_unavailable', 'resend').step, 'otp');
    assert.equal(planSignupError('provider_unavailable', 'resend').action, 'later');
  });

  it('maps the register field errors to their fields', () => {
    assert.deepEqual(planSignupError('field_invalid', 'register', 'email'), {
      code: 'field_invalid',
      step: 'form',
      field: 'email',
      action: 'field',
    });
    assert.equal(planSignupError('terms_required', 'register').field, 'acceptTerms');
    assert.equal(planSignupError('terms_version_stale', 'register').action, 'reload');
    assert.equal(planSignupError('field_invalid', 'register', 'nope').action, 'retry');
  });

  it('treats a timeout or an unknown code as "try again"', () => {
    assert.equal(planSignupError('timeout', 'start').action, 'retry');
    assert.equal(planSignupError('weird', 'verify').step, 'otp');
    assert.equal(planSignupError('page_unavailable', 'page').action, 'unavailable');
  });
});
