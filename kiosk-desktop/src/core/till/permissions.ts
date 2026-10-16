/**
 * "תפקידים והרשאות" with limits, and "כשאין הרשאה" — the Android till's PermissionService.kt and DeniedActions.kt
 * (pos-android domain/; P:/specs/denied-actions-ui.md), on the roster the cloud ships (`GET /sync/{m}/pos-users`:
 * `permissions` code → allow | approval | deny, `limits` code → {maxAmount, maxPercent}, `tillRoleKey`, and — once
 * feat/denied-actions-ui is deployed — `deniedUi` show | hide | code). Decided here, offline.
 *
 *  - three answers: allowed (the operator's own signature), an approval (a manager's code: someone allowed it alone
 *    WITHIN THEIR OWN LIMITS — and for a drawer action allowed to approve drawer actions), or denied;
 *  - an "allow" with a limit becomes an approval above it ("מעל המותר לך, דורש אישור מנהל");
 *  - "כשאין הרשאה" (`deniedActionUi` per level, the role's / the employee's `deniedUi` on the roster, most specific
 *    first): `show` — today; `hide` — the screens leave the option out; `code` — every role DENY but the untouched
 *    codes is an APPROVAL (a manager's code, recorded as an approval), never relaxed into "allowed".
 *
 * Pure. Every Hebrew line is the Android till's.
 */

import { LOCKOUT_MS, MAX_FAILURES, findByPin, lockAt, ofShop, permissionState, type BcryptCompare, type ExitLock, type RosterUser } from '../desktopExit';
import { TEXT, permLabel } from './staff';

export type PermState = 'allow' | 'approval' | 'deny';

export const MAX_AMOUNT = 'maxAmount';
export const MAX_PERCENT = 'maxPercent';

/** "כשאין הרשאה": the three answers by their wire values. */
export type DeniedActionUi = 'show' | 'hide' | 'code';

/** The till parameter (per level: company → shop → point of sale → till). */
export const DENIED_ACTION_UI_PARAM = 'deniedActionUi';
/** The older parameter, read only under `show` at the entries that always read it. */
export const PERMISSIONS_DENIED_UI_PARAM = 'permissionsDeniedUi';
export const PERMISSIONS_DENIED_UI_DISABLE = 'הצג מושבת עם הסבר';

/** `show` / `hide` / `code`, or null (blank, "inherit", a value this till does not know). */
export function deniedActionUiOf(raw: unknown): DeniedActionUi | null {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  return v === 'show' || v === 'hide' || v === 'code' ? v : null;
}

/** One till user's effective permissions as the till acts on them. */
export interface PermissionProfile {
  /** The roster user's id (`pos_users.id`), when known. */
  userId: string | null;
  state(code: string): PermState;
  /** `limits[code][key]`: the cloud's ceilings (shekels / percent). */
  limits: Readonly<Record<string, Readonly<Record<string, number>>>>;
  roleKey: string | null;
  /** The employee's own "כשאין הרשאה", else the role's (the roster's `deniedUi`); null — the level decides. */
  deniedUi: DeniedActionUi | null;
  /** Codes whose "אסור" was turned into "דורש אישור מנהל" (`code`): never relaxed into "allowed". */
  askedForCode: ReadonlySet<string>;
}

/** A roster row as the till keeps it: the user and the cloud's limits and "כשאין הרשאה" beside the permissions. */
export type ProfileUser = Pick<RosterUser, 'id' | 'role' | 'permissions'> & {
  limits?: Record<string, Record<string, number>> | null;
  tillRoleKey?: string | null;
  deniedUi?: string | null;
};

function cleanLimits(raw: unknown): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [code, inner] of Object.entries(raw as Record<string, unknown>)) {
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) continue;
    const values: Record<string, number> = {};
    for (const [k, v] of Object.entries(inner as Record<string, unknown>)) {
      const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
      if (Number.isFinite(n)) values[k] = n;
    }
    if (Object.keys(values).length > 0) out[code] = values;
  }
  return out;
}

/** The profile of a roster user (PermissionProfile.fromJson): the cloud's states and limits, else the legacy role's. */
export function profileOf(user: ProfileUser): PermissionProfile {
  return {
    userId: user.id ?? null,
    state: (code) => permissionState(user, code),
    limits: cleanLimits(user.limits),
    roleKey: typeof user.tillRoleKey === 'string' && user.tillRoleKey.trim() ? user.tillRoleKey.trim() : null,
    deniedUi: deniedActionUiOf(user.deniedUi),
    askedForCode: new Set(),
  };
}

export function limitOf(p: Pick<PermissionProfile, 'limits'>, code: string, key: string): number | null {
  const v = p.limits[code]?.[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/**
 * [code]'s own limits cover this amount (₪) / percent — its limits alone, whatever its state. A limit not set covers
 * anything (no `maxAmount` on OTH: "ללא הגבלה", the default).
 */
export function withinLimits(p: Pick<PermissionProfile, 'limits'>, code: string, amount?: number | null, percent?: number | null): boolean {
  const maxAmount = limitOf(p, code, MAX_AMOUNT);
  if (amount !== null && amount !== undefined && maxAmount !== null && Math.abs(amount) > maxAmount + 1e-9) return false;
  const maxPercent = limitOf(p, code, MAX_PERCENT);
  if (percent !== null && percent !== undefined && maxPercent !== null && percent > maxPercent + 1e-9) return false;
  return true;
}

/** May do [code] alone at this amount / percent: allowed, and within its limits. */
export function covers(p: PermissionProfile, code: string, amount?: number | null, percent?: number | null): boolean {
  return p.state(code) === 'allow' && withinLimits(p, code, amount, percent);
}

export type ApprovalWhy = 'role' | 'over_limit' | 'setting';
export type DenyWhy = 'role' | 'not_signed_in' | 'setting';

export type Decision =
  | { kind: 'allowed'; code: string }
  | { kind: 'approval'; code: string; why: ApprovalWhy; amount: number | null; percent: number | null }
  | { kind: 'denied'; code: string; why: DenyWhy };

/**
 * PermissionService.decide: what [profile] may do about [code].
 *  - `amount` — the money at stake (₪), held to `maxAmount`; `percent` — a discount's rate, held to `maxPercent`;
 *  - `forceApproval` — a setting asks a second person even when the role allows it; never turns a denial into an approval;
 *  - `relaxApproval` — a setting waives the second person (OTH with `othRequiresManager` off); never turns a denial into an
 *    allowance, and never relaxes a denial asked as a code ("כשאין הרשאה").
 */
export function decide(
  profile: PermissionProfile | null,
  code: string,
  opts: { amount?: number | null; percent?: number | null; forceApproval?: boolean; relaxApproval?: boolean } = {},
): Decision {
  if (!profile) return { kind: 'denied', code, why: 'not_signed_in' };
  const amount = opts.amount ?? null;
  const percent = opts.percent ?? null;
  const st = profile.state(code);
  if (st === 'deny') return { kind: 'denied', code, why: 'role' };
  if (st === 'approval') {
    if (opts.relaxApproval && !opts.forceApproval && !profile.askedForCode.has(code)) return { kind: 'allowed', code };
    return { kind: 'approval', code, why: 'role', amount, percent };
  }
  if (!covers(profile, code, amount, percent)) {
    return opts.relaxApproval ? { kind: 'allowed', code } : { kind: 'approval', code, why: 'over_limit', amount, percent };
  }
  if (opts.forceApproval) return { kind: 'approval', code, why: 'setting', amount, percent };
  return { kind: 'allowed', code };
}

/** True when [profile] may act alone on [code] (the old `mayActAlone`). */
export function mayActAlone(profile: PermissionProfile | null, code: string): boolean {
  return decide(profile, code).kind === 'allowed';
}

/** Drawer and cash actions: an approver must also be allowed to approve drawer actions. */
export function isDrawerCode(code: string): boolean {
  return code.startsWith('CASH_DRAWER.') && code !== 'CASH_DRAWER.APPROVE_OPEN';
}

/**
 * May [approver] say yes to [code] for somebody else, at this amount / percent? Allowed it alone within their OWN limits,
 * and — a drawer or cash action — allowed to approve drawer actions (PermissionService.mayApprove). Their role's profile,
 * never a turned one: an approver must hold "מותר".
 */
export function mayApprove(approver: PermissionProfile, code: string, amount?: number | null, percent?: number | null): boolean {
  if (!covers(approver, code, amount, percent)) return false;
  if (isDrawerCode(code) && approver.state('CASH_DRAWER.APPROVE_OPEN') !== 'allow') return false;
  return true;
}

/** "המגבלה של המאשר/ת לא מכסה את הסכום או האחוז הזה" (perm_approver_over_limit). */
export const APPROVER_OVER_LIMIT = 'המגבלה של המאשר/ת לא מכסה את הסכום או האחוז הזה';

/**
 * Who may approve [code] at this amount / percent here (approversFor): active, of this shop, with a PIN, and allowed it
 * alone within their own limits ([mayApprove]). The roster's order.
 */
export function approversFor(users: readonly (RosterUser & ProfileUser)[], shopId: string | null | undefined, code: string, amount?: number | null, percent?: number | null, excluding?: string | null): RosterUser[] {
  return users.filter((u) => u.isActive && !!u.pinHash && ofShop(u, shopId) && u.id !== excluding && mayApprove(profileOf(u), code, amount, percent));
}

export type ApprovalOutcome = { ok: true; user: RosterUser } | { ok: false; reason: 'no_approver' | 'over_limit' | 'wrong' | 'locked'; message: string; lock: ExitLock };

/**
 * A manager's code for [code] at [amount] / [percent]: bcrypt against the users who may approve it — the Android prompt
 * offers only approvers whose own ceiling covers the sum or the rate. A code of someone allowed the action but not this
 * much is refused with "המגבלה של המאשר/ת לא מכסה…" (and counts as no wrong try). Five wrong codes lock it for a minute.
 */
export async function approveWithin(input: {
  users: readonly (RosterUser & ProfileUser)[];
  shopId: string | null | undefined;
  code: string;
  pin: string;
  lock: ExitLock | null | undefined;
  nowMs: number;
  compare: BcryptCompare;
  amount?: number | null;
  percent?: number | null;
}): Promise<ApprovalOutcome> {
  const lock = lockAt(input.lock, input.nowMs);
  const lockedFor = Math.max(0, lock.lockedUntilMs - input.nowMs);
  if (lockedFor > 0) return { ok: false, reason: 'locked', message: TEXT.locked(lockedFor), lock };
  const pin = String(input.pin ?? '').trim();
  const candidates = approversFor(input.users, input.shopId, input.code, input.amount, input.percent);
  if (candidates.length > 0) {
    const user = await findByPin(candidates, pin, input.compare);
    if (user) return { ok: true, user };
  }
  // Allowed it, but not this much: said so (the grant is not stretched over a bigger sum).
  const capped = input.users.filter((u) => u.isActive && !!u.pinHash && ofShop(u, input.shopId) && profileOf(u).state(input.code) === 'allow' && !candidates.includes(u));
  if (capped.length > 0 && (await findByPin(capped, pin, input.compare))) return { ok: false, reason: 'over_limit', message: APPROVER_OVER_LIMIT, lock };
  if (candidates.length === 0) return { ok: false, reason: 'no_approver', message: TEXT.noApprover(input.code), lock };
  const failures = lock.failures + 1;
  const next = failures >= MAX_FAILURES ? { failures, lockedUntilMs: input.nowMs + LOCKOUT_MS } : { failures, lockedUntilMs: 0 };
  return { ok: false, reason: failures >= MAX_FAILURES ? 'locked' : 'wrong', message: failures >= MAX_FAILURES ? TEXT.locked(LOCKOUT_MS) : TEXT.managerWrong, lock: next };
}

/** The prompt's line for a denial: "אין לך הרשאה: הוצאת מזומן". */
export function deniedText(code: string, why: DenyWhy): string {
  if (why === 'not_signed_in') return 'יש להתחבר לקופה';
  if (why === 'setting') return `${permLabel(code)} — חסום בהגדרות הקופה`;
  return `אין לך הרשאה: ${permLabel(code)}`;
}

/** The prompt's line for an approval: why a manager is asked. */
export function approvalText(d: Extract<Decision, { kind: 'approval' }>): string {
  if (d.why === 'over_limit') return `${permLabel(d.code)} — מעל המותר לך, דורש אישור מנהל`;
  if (d.why === 'setting') return `${permLabel(d.code)} — באישור מנהל לפי הגדרות הקופה`;
  return `${permLabel(d.code)} — דורש אישור מנהל`;
}

/* ------------------------------------------------------------- "כשאין הרשאה" */

/** The older `permissionsDeniedUi`: "הסתר" (the default) or "הצג מושבת עם הסבר". */
export type LegacyDeniedUi = 'hide' | 'disable';

export interface DeniedUiSettings {
  level: DeniedActionUi;
  legacy: LegacyDeniedUi;
}

export const DENIED_UI_DEFAULT: DeniedUiSettings = { level: 'show', legacy: 'hide' };

/** From the till's parameters. */
export function deniedUiSettingsOf(params: Record<string, unknown>): DeniedUiSettings {
  const legacyRaw = params[PERMISSIONS_DENIED_UI_PARAM];
  return {
    level: deniedActionUiOf(params[DENIED_ACTION_UI_PARAM]) ?? 'show',
    legacy: typeof legacyRaw === 'string' && legacyRaw.trim() === PERMISSIONS_DENIED_UI_DISABLE ? 'disable' : 'hide',
  };
}

/**
 * Codes "כשאין הרשאה" never touches — rules and capabilities, not options. The cloud's
 * `till_permissions.DENIED_UI_UNTOUCHED` (and Android `DeniedActions.UNTOUCHED`), one to one: the five, and every
 * `APPROVE_REMOTE.*`.
 */
export const DENIED_UI_UNTOUCHED: readonly string[] = ['MULTI_DEVICE_LOGIN', 'CASH_DRAWER.APPROVE_OPEN', 'CASH_DRAWER.OPEN_ON_CASH_SALE', 'DESKTOP_EXIT', 'SELL_RESTRICTED_ITEMS'];

export function untouched(code: string): boolean {
  return DENIED_UI_UNTOUCHED.includes(code) || code.startsWith('APPROVE_REMOTE.');
}

/** Never hidden wherever they appear (spec §4): what is needed to finish a flow under way, or to get out. */
export const NEVER_HIDDEN: readonly string[] = ['CARD_UNRESOLVED', 'SHIFT_OPEN', 'TRANSMIT', 'ATTENDANCE_MANAGE', 'KIOSK_UNLOCK', 'KIOSK_TILL_MODE'];

/** What an entry is, for [shows]. */
export type EntryKind = 'option' | 'legacy' | 'safety';

/** The answer for whoever [profile] is: theirs (employee → role), else the level's. */
export function deniedMode(profile: Pick<PermissionProfile, 'deniedUi'> | null, settings: DeniedUiSettings): DeniedActionUi {
  return profile?.deniedUi ?? settings.level;
}

/**
 * The profile the till acts on for its operator: under `code` every DENY (but the untouched) is APPROVAL — a manager's
 * code, recorded as an approval; otherwise [profile] itself. Never ALLOW.
 */
export function acting(profile: PermissionProfile, mode: DeniedActionUi, codes: readonly string[]): PermissionProfile {
  if (mode !== 'code') return profile;
  const asked = new Set(codes.filter((c) => profile.state(c) === 'deny' && !untouched(c)));
  if (asked.size === 0) return profile;
  const base = profile.state;
  return {
    ...profile,
    state: (c) => (asked.has(c) ? 'approval' : base(c)),
    askedForCode: new Set([...profile.askedForCode, ...asked]),
  };
}

/** [acting] under the profile's own answer, for every code it may be asked about. */
export function actingProfile(profile: PermissionProfile | null, settings: DeniedUiSettings, codes: readonly string[]): PermissionProfile | null {
  return profile ? acting(profile, deniedMode(profile, settings), codes) : null;
}

/**
 * Whether the entry for [code] is shown to [profile] (the operator's ROLE profile — not [acting]'s). Only a role's DENY is
 * ever hidden; "מותר" and "דורש אישור מנהל" are always shown. [elevated]: the till holds an approval for it. Nobody signed
 * in: as today (LEGACY entries per `permissionsDeniedUi`, the rest shown).
 */
export function shows(profile: PermissionProfile | null, code: string, settings: DeniedUiSettings, kind: EntryKind = 'option', elevated = false): boolean {
  if (!profile) return kind !== 'legacy' || settings.legacy === 'disable';
  if (elevated || kind === 'safety') return true;
  if (profile.state(code) !== 'deny' || untouched(code)) return true;
  const mode = deniedMode(profile, settings);
  if (mode === 'code') return true;
  if (mode === 'hide') return NEVER_HIDDEN.includes(code);
  return kind !== 'legacy' || settings.legacy === 'disable' || NEVER_HIDDEN.includes(code);
}

/** The `permissionsDeniedUi` answer an entry that always read it should use now: HIDE under `hide`, else the parameter. */
export function legacyUi(profile: PermissionProfile | null, settings: DeniedUiSettings): LegacyDeniedUi {
  return profile && deniedMode(profile, settings) === 'hide' ? 'hide' : settings.legacy;
}

/** "הסר" on a line: LINE_VOID is asked only of a sale line not yet in the kitchen — a line coming back goes without it. */
export function lineRemoveShown(voidShown: boolean, refund: boolean, sentQuantity: number): boolean {
  return voidShown || refund || sentQuantity > 0;
}

/** A line's discount chips: all where shown; else only "ללא" on a line that has one, none on one that has not. */
export function lineDiscountPercents(all: readonly number[], discountShown: boolean, hasDiscount: boolean): number[] {
  if (discountShown) return [...all];
  if (hasDiscount) return all.filter((p) => p === 0);
  return [];
}

/** "הנחה לחשבון": offered where shown; one already on the bill stays, to be seen and taken off. */
export function basketDiscountShown(discountShown: boolean, discountSet: boolean): boolean {
  return discountShown || discountSet;
}
