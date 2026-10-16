/**
 * "התראות בנייד שחובה להפעיל" (P:/specs/pwa-push-required.md) — the policy's types and the pure
 * rules of its editors (pos-server app/services/push_policy.py, app/routers/push_policy.py):
 *
 * * `required` — off | reminder | required, per level: company → dashboard template / role →
 *   user; `null` = inherit;
 * * `notify` — per alert category: stays on screen until touched (`requireInteraction`: always /
 *   critical only / never) and the vibration, per the same levels, field by field.
 *
 * Pure (no React, no network, relative imports only) so `npm test` runs it with node:test.
 */

export type PushMode = 'off' | 'reminder' | 'required';
export const PUSH_MODES: PushMode[] = ['off', 'reminder', 'required'];

export type Interaction = 'always' | 'critical' | 'never';
export const INTERACTIONS: Interaction[] = ['always', 'critical', 'never'];

export type VibratePreset = 'default' | 'short' | 'double' | 'long' | 'urgent';
export const VIBRATE_PRESETS: VibratePreset[] = ['default', 'short', 'double', 'long', 'urgent'];

export interface NotifyRule {
  requireInteraction?: Interaction;
  vibrate?: VibratePreset;
}

export type FullNotifyRule = Required<NotifyRule>;

/** One level's own settings: what it does not set is inherited. */
export interface PushPolicy {
  required: PushMode | null;
  notify: Record<string, NotifyRule>;
}

export interface PolicyCatalogue {
  modes: PushMode[];
  interactions: Interaction[];
  vibratePresets: VibratePreset[];
  categories: { key: string; label: string; default: FullNotifyRule }[];
  roles: string[];
}

/** Where the effective `required` came from. */
export type RequiredSource = 'user' | 'template' | 'role' | 'company' | 'default';

export type HealthTone = 'green' | 'yellow' | 'red';

/** "התראות בנייד" on the users list. */
export interface PushHealth {
  devices: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  tone: HealthTone;
  /** The effective requirement (only on the users list). */
  required?: PushMode;
}

/** `GET /push/status`. */
export interface PushStatus {
  required: PushMode;
  source: RequiredSource;
  default: PushMode;
  devices: number;
  lastSuccessAt: string | null;
  tone: HealthTone;
  thisDeviceRegistered: boolean;
  thisDevice: {
    lastSuccessAt: string | null;
    lastFailureAt: string | null;
    failing: boolean;
    /** fix/pwa-push ("בדיקת התראות"): which device, and why its last message failed ("http_410…"). */
    id?: string;
    label?: string | null;
    lastError?: string | null;
    failureCount?: number;
    service?: string;
  } | null;
  configured: boolean;
  publicKey: string | null;
  /** What is wrong with the server's keys, as a code (lib/pushDiagnosis.ts `configProblem`). */
  problem?: string | null;
}

export interface CompanyPushPolicy {
  companyId: string;
  policy: PushPolicy;
  inherited: { required: PushMode | null; notify: Record<string, FullNotifyRule> };
  catalogue: PolicyCatalogue;
  canEdit: boolean;
}

export interface PlatformPushPolicy {
  templates: Record<string, PushPolicy>;
  roles: Record<string, PushPolicy>;
  templateList: { id: string; name: string; builtin: boolean }[];
  catalogue: PolicyCatalogue;
}

export interface UserPushPolicy {
  userId: string;
  policy: PushPolicy;
  resolved: { required: PushMode; source: RequiredSource; default: PushMode };
  /** What applies when the user's own is "inherit". */
  inherited: { required: PushMode; source: RequiredSource; default: PushMode };
  health: PushHealth;
  catalogue: PolicyCatalogue;
}

export const EMPTY_POLICY: PushPolicy = { required: null, notify: {} };

function isMode(v: unknown): v is PushMode {
  return typeof v === 'string' && (PUSH_MODES as string[]).includes(v);
}

/** A policy read forgivingly: unknown values read as inherited. */
export function parsePolicy(raw: unknown): PushPolicy {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const notify: Record<string, NotifyRule> = {};
  const rawNotify = src.notify && typeof src.notify === 'object' ? (src.notify as Record<string, unknown>) : {};
  for (const [cat, rule] of Object.entries(rawNotify)) {
    if (!rule || typeof rule !== 'object') continue;
    const r = rule as Record<string, unknown>;
    const own: NotifyRule = {};
    if (typeof r.requireInteraction === 'string' && (INTERACTIONS as string[]).includes(r.requireInteraction)) {
      own.requireInteraction = r.requireInteraction as Interaction;
    }
    if (typeof r.vibrate === 'string' && (VIBRATE_PRESETS as string[]).includes(r.vibrate)) {
      own.vibrate = r.vibrate as VibratePreset;
    }
    if (Object.keys(own).length) notify[cat] = own;
  }
  return { required: isMode(src.required) ? src.required : null, notify };
}

export function setRequired(policy: PushPolicy, mode: PushMode | null): PushPolicy {
  return { ...policy, required: mode };
}

/** Set (or, with null, inherit again) one field of one category; an emptied category is dropped. */
export function setNotify<K extends keyof NotifyRule>(
  policy: PushPolicy,
  category: string,
  field: K,
  value: NotifyRule[K] | null,
): PushPolicy {
  const rule: NotifyRule = { ...(policy.notify[category] ?? {}) };
  if (value === null || value === undefined) delete rule[field];
  else rule[field] = value;
  const notify = { ...policy.notify };
  if (Object.keys(rule).length) notify[category] = rule;
  else delete notify[category];
  return { ...policy, notify };
}

/** What a category does at this level: its own fields over what it inherits. */
export function effectiveRule(inherited: FullNotifyRule, own: NotifyRule | undefined): FullNotifyRule {
  return { ...inherited, ...(own ?? {}) };
}

/** The body of a PUT: only what the level sets. */
export function policyBody(policy: PushPolicy): { required: PushMode | null; notify: Record<string, NotifyRule> } {
  const notify: Record<string, NotifyRule> = {};
  for (const [cat, rule] of Object.entries(policy.notify)) {
    const own: NotifyRule = {};
    if (rule.requireInteraction) own.requireInteraction = rule.requireInteraction;
    if (rule.vibrate) own.vibrate = rule.vibrate;
    if (Object.keys(own).length) notify[cat] = own;
  }
  return { required: policy.required, notify };
}

/** Whether two policies say the same (to enable "שמור" only on a change). */
export function samePolicy(a: PushPolicy, b: PushPolicy): boolean {
  return JSON.stringify(policyBody(a)) === JSON.stringify(policyBody(b));
}

/** The users list's sort: who must have notifications and has none first. */
export function healthRank(h: PushHealth | null | undefined): number {
  if (!h) return 9;
  const need = h.required === 'required' ? 0 : h.required === 'reminder' ? 1 : 2;
  const tone = h.tone === 'red' ? 0 : h.tone === 'yellow' ? 1 : 2;
  return need * 3 + tone;
}

/** This device receives: registered on the server, not failing since its last success. */
export function deviceReady(status: Pick<PushStatus, 'thisDeviceRegistered' | 'thisDevice'> | null | undefined): boolean {
  return !!status?.thisDeviceRegistered && !status.thisDevice?.failing;
}
