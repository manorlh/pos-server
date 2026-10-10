/**
 * Run with `npm test`. The cookie-consent gate (lib/consent.ts): nothing optional before a choice,
 * one choice per business, asked again on a newer policy or after the retention period, every
 * decision logged, revocation turns everything optional off.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  cleanChoices,
  consentStorageKey,
  createConsentGate,
  memoryStorage,
  newAnonId,
  readStoredConsent,
  type ConsentLogEntry,
} from './consent';

const bytes = (seed: number) => (n: number) => Uint8Array.from({ length: n }, (_, i) => (seed * 31 + i * 7) & 255);

function setup(opts: { policyVersion?: number; companyId?: string | null; now?: Date } = {}) {
  const storage = memoryStorage();
  const log: ConsentLogEntry[] = [];
  let now = opts.now ?? new Date('2026-10-10T10:00:00Z');
  const gate = createConsentGate(
    { storage, randomBytes: bytes(1), log: (e) => log.push(e), now: () => now },
    { companyId: opts.companyId === undefined ? 'company-a' : opts.companyId, policyVersion: opts.policyVersion ?? 1, surface: 'menu' },
  );
  return { gate, storage, log, setNow: (d: Date) => (now = d) };
}

describe('consent gate', () => {
  it('allows only essential while undecided', () => {
    const { gate } = setup();
    assert.equal(gate.current(), null);
    assert.equal(gate.needsDecision(), true);
    assert.equal(gate.allows('essential'), true);
    assert.equal(gate.allows('analytics'), false);
    assert.equal(gate.allows('marketing'), false);
  });

  it('whenAllowed waits for the grant and runs once', () => {
    const { gate } = setup();
    let runs = 0;
    gate.whenAllowed('analytics', () => runs++);
    gate.rejectOptional();
    assert.equal(runs, 0);
    gate.decide({ analytics: true });
    assert.equal(runs, 1);
    gate.decide({ marketing: true });
    assert.equal(runs, 1);
    gate.whenAllowed('analytics', () => runs++);
    assert.equal(runs, 2, 'already allowed: runs at once');
  });

  it('logs every decision with the anonymous id, policy version and action', () => {
    const { gate, log } = setup({ policyVersion: 3 });
    gate.acceptAll();
    gate.decide({ marketing: false });
    gate.revoke();
    assert.deepEqual(log.map((e) => e.action), ['grant', 'update', 'revoke']);
    assert.ok(log.every((e) => e.companyId === 'company-a' && e.policyVersion === 3 && e.surface === 'menu'));
    assert.equal(new Set(log.map((e) => e.anonId)).size, 1, 'one visitor id across decisions');
    assert.deepEqual(log[2].choices, { essential: true, analytics: false, marketing: false });
    assert.equal(gate.allows('analytics'), false);
  });

  it('no business → no log (nothing to attribute the consent to)', () => {
    const { gate, log } = setup({ companyId: null });
    gate.acceptAll();
    assert.equal(log.length, 0);
    assert.equal(gate.allows('analytics'), true);
  });

  it('keeps one choice per business', () => {
    const { gate } = setup();
    gate.acceptAll();
    gate.configure({ companyId: 'company-b', policyVersion: 1, surface: 'menu' });
    assert.equal(gate.current(), null, 'another business asks again');
    gate.configure({ companyId: 'company-a', policyVersion: 1, surface: 'menu' });
    assert.equal(gate.allows('analytics'), true);
  });

  it('asks again when a newer cookie policy is published, not for an older one', () => {
    const { gate } = setup({ policyVersion: 2 });
    gate.acceptAll();
    gate.configure({ companyId: 'company-a', policyVersion: 1, surface: 'menu' });
    assert.notEqual(gate.current(), null);
    gate.configure({ companyId: 'company-a', policyVersion: 3, surface: 'menu' });
    assert.equal(gate.current(), null);
    assert.equal(gate.allows('analytics'), false);
  });

  it('asks again after the retention period', () => {
    const { gate, setNow } = setup();
    gate.acceptAll();
    setNow(new Date('2027-10-10T10:00:01Z'));
    gate.configure({ companyId: 'company-a', policyVersion: 1, surface: 'menu' });
    assert.equal(gate.current(), null);
  });

  it('openSettings reaches the banner; subscribers hear every change', () => {
    const { gate } = setup();
    let opened = 0;
    let changes = 0;
    const off = gate.onOpenSettings(() => opened++);
    gate.subscribe(() => changes++);
    gate.openSettings();
    off();
    gate.openSettings();
    gate.acceptAll();
    assert.equal(opened, 1);
    assert.equal(changes, 1);
  });

  it('a storage that throws (private mode) still holds the choice for the page', () => {
    const broken = { get: () => { throw new Error('blocked'); }, set: () => { throw new Error('blocked'); }, remove: () => undefined };
    const gate = createConsentGate({ storage: broken, randomBytes: bytes(2) }, { companyId: 'c', policyVersion: 0, surface: 'card' });
    gate.decide({ analytics: true });
    assert.equal(gate.allows('analytics'), true);
  });
});

describe('consent helpers', () => {
  it('only a literal true turns a category on; essential is always on', () => {
    assert.deepEqual(cleanChoices({ analytics: 'yes', marketing: 1, essential: false }), {
      essential: true,
      analytics: false,
      marketing: false,
    });
  });

  it('the anonymous id is 22 url-safe characters the server accepts', () => {
    const id = newAnonId(bytes(9));
    assert.match(id, /^[A-Za-z0-9_-]{22}$/);
  });

  it('a damaged stored value is no decision', () => {
    const opts = { now: new Date('2026-10-10T00:00:00Z'), policyVersion: 0 };
    assert.equal(readStoredConsent('{', opts), null);
    assert.equal(readStoredConsent(JSON.stringify({ choices: {}, policyVersion: 1, decidedAt: 'x', anonId: 'a'.repeat(22) }), opts), null);
    assert.equal(readStoredConsent(JSON.stringify({ choices: {}, policyVersion: 1, decidedAt: '2026-10-01T00:00:00Z', anonId: 'short' }), opts), null);
  });

  it('keys storage per business', () => {
    assert.equal(consentStorageKey('abc'), 'r2m.consent.v1:abc');
    assert.equal(consentStorageKey(null), 'r2m.consent.v1:global');
  });
});
