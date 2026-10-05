/**
 * "עובד מחובר בקופה אחת בלבד" — who is signed in at which till of a shop, and a manager's
 * release (server: app/routers/user_sessions.py, docs/SPEC_EXCLUSIVE_LOGIN.md).
 */
import { api } from './api';

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
  /** Its till has not been heard from for the stale minutes: the next claim elsewhere takes it. */
  stale: boolean;
  staleMinutes: number;
}

export interface UserSessionsResponse {
  /** `exclusiveUserLogin` as it stands for the shop itself. */
  exclusive: boolean;
  sessions: UserSession[];
}

export async function fetchUserSessions(shopId: string): Promise<UserSessionsResponse> {
  const { data } = await api.get<UserSessionsResponse>(`/shops/${shopId}/user-sessions`);
  return data;
}

export async function releaseUserSession(shopId: string, sessionId: string): Promise<void> {
  await api.post(`/shops/${shopId}/user-sessions/${sessionId}/release`);
}
