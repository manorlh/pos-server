/**
 * A manager's code for one action, where who may approve is more than "allowed the code" (core/till/staff.ts `approve`): a
 * drawer action's approver must hold it within their own limit AND the drawer approval (core/till/drawer.ts
 * `mayApproveDrawer`); a release of an employee's session, USER_SESSION_RELEASE. The same roster, bcrypt only, the same
 * one-minute lock after five wrong codes. Pure: bcrypt injected, the clock a parameter.
 */

import { LOCKOUT_MS, MAX_FAILURES, findByPin, lockAt, ofShop, type BcryptCompare, type ExitLock, type RosterUser } from '../desktopExit';
import { TEXT } from './staff';

export type ApproveByOutcome = { ok: true; user: RosterUser } | { ok: false; reason: 'no_approver' | 'wrong' | 'locked'; message: string; lock: ExitLock };

export async function approveBy(input: {
  users: readonly RosterUser[];
  shopId: string | null | undefined;
  pin: string;
  /** May this user say yes to the action (their profile: the state, the limits). */
  may: (u: RosterUser) => boolean;
  /** "אין בסניף מנהל עם ההרשאה …" — said when nobody here may approve it. */
  noApprover: string;
  lock: ExitLock | null | undefined;
  nowMs: number;
  compare: BcryptCompare;
}): Promise<ApproveByOutcome> {
  const lock = lockAt(input.lock, input.nowMs);
  const lockedFor = Math.max(0, lock.lockedUntilMs - input.nowMs);
  if (lockedFor > 0) return { ok: false, reason: 'locked', message: TEXT.locked(lockedFor), lock };
  const candidates = input.users.filter((u) => u.isActive && !!u.pinHash && ofShop(u, input.shopId) && input.may(u));
  if (candidates.length === 0) return { ok: false, reason: 'no_approver', message: input.noApprover, lock };
  const user = await findByPin(candidates, String(input.pin ?? '').trim(), input.compare);
  if (user) return { ok: true, user };
  const failures = lock.failures + 1;
  const next = failures >= MAX_FAILURES ? { failures, lockedUntilMs: input.nowMs + LOCKOUT_MS } : { failures, lockedUntilMs: 0 };
  return { ok: false, reason: failures >= MAX_FAILURES ? 'locked' : 'wrong', message: failures >= MAX_FAILURES ? TEXT.locked(LOCKOUT_MS) : TEXT.managerWrong, lock: next };
}
