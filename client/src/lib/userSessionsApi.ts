/**
 * "עובד מחובר בקופה אחת בלבד" — who is signed in at which device of a shop, and a manager's
 * release (server: app/routers/user_sessions.py, docs/SPEC_EXCLUSIVE_LOGIN.md; v2:
 * P:/specs/exclusive-login-v2.md). The release needs the dashboard permission
 * "שחרור עובד מחובר במכשיר" (`user_sessions_release`): the server says `canRelease`. §8: each row
 * carries the employee's open tables, and a release may hand them on (`exclusiveReleaseTables = ask`).
 */
import { api } from './api';
import type { OpenTable, ReleaseOutcome, ReleaseTables, TableTransfer } from './exclusiveLogin';
import { releaseOutcomeOf } from './exclusiveLogin';

export interface UserSession {
  id: string;
  posUserId: string;
  posUserName?: string | null;
  username?: string | null;
  machineId: string;
  machineName?: string | null;
  posNumber?: string | null;
  startedAt?: string | null;
  lastSeenAt?: string | null;
  /** Its device stopped reporting (three missed heartbeats): "לא מדווח", safe to release. */
  silent?: boolean;
  silentSince?: string | null;
  /** Auto release is on there and the stale minutes passed: the next claim elsewhere takes it. */
  stale: boolean;
  /** `exclusiveUserLoginAutoRelease` for that device: off (only a manager releases) | minutes. */
  autoRelease?: 'off' | 'minutes';
  staleMinutes: number;
  /** §8: the employee's open tables, and what a release does with them (the holder device's parameter). */
  openTables?: number;
  tables?: OpenTable[];
  releaseTables?: ReleaseTables;
}

export interface UserSessionsResponse {
  /** `exclusiveUserLogin` as it stands for the shop itself. */
  exclusive: boolean;
  sessions: UserSession[];
  /** This user may release one ("שחרור עובד מחובר במכשיר"). An older server says nothing: no button. */
  canRelease?: boolean;
  /** Whom to hand tables to, when a release would ask (else null). */
  waiters?: { posUserId: string; name: string | null; onShift?: boolean }[] | null;
}

export async function fetchUserSessions(shopId: string): Promise<UserSessionsResponse> {
  const { data } = await api.get<UserSessionsResponse>(`/shops/${shopId}/user-sessions`);
  return data;
}

export async function releaseUserSession(shopId: string, sessionId: string, transfers: TableTransfer[] = []): Promise<ReleaseOutcome> {
  const { data } = await api.post(`/shops/${shopId}/user-sessions/${sessionId}/release`, { transfers });
  return releaseOutcomeOf(data);
}
