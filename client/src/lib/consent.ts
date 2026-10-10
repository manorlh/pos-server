/**
 * The cookie-consent gate of the public digital channels (digital menu, online ordering, business
 * cards) — plan §17.3.
 *
 * * Categories: `essential` (always on), `analytics`, `marketing`. Everything but essential is OFF
 *   until the visitor turns it on; nothing optional runs while undecided.
 * * One gate per page: every analytics / marketing call in the public modules asks it —
 *   `gate.allows('analytics')` or `gate.whenAllowed('analytics', fn)` — never storage directly.
 * * The choice is kept per business (key `r2m.consent.v1:<companyId>`): a different business on the
 *   same public domain asks again. It is asked again when the business publishes a newer cookie
 *   policy, and after `maxAgeMonths`.
 * * Each decision (grant / update / revoke) goes to `log` (the server's `POST /public/v1/consents`):
 *   a random per-business anonymous id, the policy version, the choices and the action.
 *
 * Pure: storage, clock, randomness and the log are injected, so consent.test.ts runs it in Node.
 * The browser's singleton is `lib/consentGate.ts`.
 */

export type ConsentCategory = 'essential' | 'analytics' | 'marketing';
export const CONSENT_CATEGORIES: ConsentCategory[] = ['essential', 'analytics', 'marketing'];
export const OPTIONAL_CATEGORIES: Array<Exclude<ConsentCategory, 'essential'>> = ['analytics', 'marketing'];

export interface ConsentChoices {
  essential: true;
  analytics: boolean;
  marketing: boolean;
}

export type ConsentAction = 'grant' | 'update' | 'revoke';
export type ConsentSurface = 'menu' | 'online' | 'card' | 'legal' | 'other';

export interface ConsentState {
  choices: ConsentChoices;
  /** The published cookie policy version the visitor answered (0 = none published then). */
  policyVersion: number;
  /** ISO time of the decision. */
  decidedAt: string;
  /** Random per-business id — the server keeps only a keyed hash of it. */
  anonId: string;
}

export interface ConsentLogEntry {
  companyId: string;
  anonId: string;
  choices: ConsentChoices;
  policyVersion: number;
  action: ConsentAction;
  surface: ConsentSurface;
}

export interface ConsentStorage {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}

export const CONSENT_KEY_PREFIX = 'r2m.consent.v1';
export const DEFAULT_MAX_AGE_MONTHS = 12;

export function consentStorageKey(companyId: string | null | undefined): string {
  return `${CONSENT_KEY_PREFIX}:${companyId || 'global'}`;
}

export function essentialOnly(): ConsentChoices {
  return { essential: true, analytics: false, marketing: false };
}

/** Only a literal `true` turns an optional category on. */
export function cleanChoices(raw: unknown): ConsentChoices {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { essential: true, analytics: r.analytics === true, marketing: r.marketing === true };
}

const ANON_RE = /^[A-Za-z0-9_-]{16,64}$/;

/** 22 url-safe characters (128 bits) from the given random bytes source. */
export function newAnonId(randomBytes: (n: number) => Uint8Array): string {
  const bytes = randomBytes(16);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = '';
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 6) {
      bits -= 6;
      out += alphabet[(acc >> bits) & 63];
    }
  }
  if (bits > 0) out += alphabet[(acc << (6 - bits)) & 63];
  return out;
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

/**
 * The stored decision, or null when there is none to honour: missing, unreadable, answered for an
 * older cookie policy than the one published now, or older than `maxAgeMonths`.
 */
export function readStoredConsent(
  raw: string | null,
  opts: { now: Date; policyVersion: number; maxAgeMonths?: number },
): ConsentState | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const p = parsed as Record<string, unknown>;
  const decidedAt = typeof p.decidedAt === 'string' ? new Date(p.decidedAt) : null;
  const version = typeof p.policyVersion === 'number' && Number.isInteger(p.policyVersion) ? p.policyVersion : -1;
  const anonId = typeof p.anonId === 'string' && ANON_RE.test(p.anonId) ? p.anonId : null;
  if (!decidedAt || Number.isNaN(decidedAt.getTime()) || version < 0 || !anonId) return null;
  if (version < opts.policyVersion) return null;
  if (addMonths(decidedAt, opts.maxAgeMonths ?? DEFAULT_MAX_AGE_MONTHS) <= opts.now) return null;
  return { choices: cleanChoices(p.choices), policyVersion: version, decidedAt: decidedAt.toISOString(), anonId };
}

export interface ConsentGateConfig {
  companyId: string | null;
  policyVersion: number;
  surface: ConsentSurface;
  maxAgeMonths?: number;
}

export interface ConsentGateDeps {
  storage: ConsentStorage;
  now?: () => Date;
  randomBytes: (n: number) => Uint8Array;
  /** Sends a decision to the server's log; failures must not undo the visitor's choice. */
  log?: (entry: ConsentLogEntry) => void;
}

export interface ConsentGate {
  /** Re-reads the stored choice for this business / policy version. */
  configure(config: ConsentGateConfig): void;
  config(): ConsentGateConfig;
  /** The decision, or null while undecided (then only `essential` is allowed). */
  current(): ConsentState | null;
  allows(category: ConsentCategory): boolean;
  /** Undecided, or the published policy changed since the decision: the banner asks. */
  needsDecision(): boolean;
  decide(choices: Partial<ConsentChoices>): ConsentState;
  acceptAll(): ConsentState;
  rejectOptional(): ConsentState;
  /** Withdraws every optional category (a new logged decision, not a deletion of the log). */
  revoke(): ConsentState;
  /** Runs `fn` now if allowed, else the first time the category is granted. Returns a cancel. */
  whenAllowed(category: ConsentCategory, fn: () => void): () => void;
  subscribe(listener: () => void): () => void;
  /** "הגדרות עוגיות": asks the banner to open its settings (the footer's link). */
  openSettings(): void;
  onOpenSettings(listener: () => void): () => void;
}

export function createConsentGate(deps: ConsentGateDeps, initial?: ConsentGateConfig): ConsentGate {
  const now = deps.now ?? (() => new Date());
  let cfg: ConsentGateConfig = initial ?? { companyId: null, policyVersion: 0, surface: 'other' };
  let state: ConsentState | null = null;
  const listeners = new Set<() => void>();
  const openers = new Set<() => void>();

  const emit = () => {
    for (const l of [...listeners]) l();
  };

  const load = () => {
    let raw: string | null = null;
    try {
      raw = deps.storage.get(consentStorageKey(cfg.companyId));
    } catch {
      raw = null;
    }
    state = readStoredConsent(raw, { now: now(), policyVersion: cfg.policyVersion, maxAgeMonths: cfg.maxAgeMonths });
  };

  const save = (choices: ConsentChoices, action: ConsentAction): ConsentState => {
    const next: ConsentState = {
      choices,
      policyVersion: cfg.policyVersion,
      decidedAt: now().toISOString(),
      anonId: state?.anonId ?? newAnonId(deps.randomBytes),
    };
    state = next;
    try {
      deps.storage.set(consentStorageKey(cfg.companyId), JSON.stringify(next));
    } catch {
      /* private mode: the choice holds for this page */
    }
    if (cfg.companyId && deps.log) {
      try {
        deps.log({
          companyId: cfg.companyId,
          anonId: next.anonId,
          choices: next.choices,
          policyVersion: next.policyVersion,
          action,
          surface: cfg.surface,
        });
      } catch {
        /* the log never undoes the visitor's choice */
      }
    }
    emit();
    return next;
  };

  load();

  const gate: ConsentGate = {
    configure(next) {
      cfg = { ...next };
      load();
      emit();
    },
    config: () => cfg,
    current: () => state,
    allows(category) {
      if (category === 'essential') return true;
      return state?.choices[category] === true;
    },
    needsDecision: () => state === null,
    decide(choices) {
      const action: ConsentAction = state ? 'update' : 'grant';
      return save(cleanChoices({ ...(state?.choices ?? essentialOnly()), ...choices }), action);
    },
    acceptAll: () => save({ essential: true, analytics: true, marketing: true }, state ? 'update' : 'grant'),
    rejectOptional: () => save(essentialOnly(), state ? 'update' : 'grant'),
    revoke: () => save(essentialOnly(), 'revoke'),
    whenAllowed(category, fn) {
      if (gate.allows(category)) {
        fn();
        return () => {};
      }
      const listener = () => {
        if (gate.allows(category)) {
          listeners.delete(listener);
          fn();
        }
      };
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    openSettings() {
      for (const o of [...openers]) o();
    },
    onOpenSettings(listener) {
      openers.add(listener);
      return () => openers.delete(listener);
    },
  };
  return gate;
}

/** A Map-backed storage (tests, private mode, server rendering). */
export function memoryStorage(): ConsentStorage {
  const m = new Map<string, string>();
  return {
    get: (k) => (m.has(k) ? (m.get(k) as string) : null),
    set: (k, v) => void m.set(k, v),
    remove: (k) => void m.delete(k),
  };
}
