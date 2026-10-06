/**
 * "נוכחות עובדים" — the dashboard's calls (server: app/routers/attendance.py,
 * docs/SPEC_ATTENDANCE.md). Read: every role but the cashier, scoped to their shops; write
 * (approve, edit, close, job titles): the till users' managers.
 */
import { api } from './api';
import type {
  AttendanceAdjustment,
  AttendanceEmployee,
  AttendanceShift,
  EmployeeRole,
  LiveResponse,
  ReportResponse,
} from './attendance';

export interface ScopeParams {
  companyId?: string | null;
  shopId?: string | null;
  roleId?: string | null;
}

function clean<T extends object>(params: T): Partial<T> {
  return Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')) as Partial<T>;
}

export async function fetchLive(params: ScopeParams): Promise<LiveResponse> {
  const { data } = await api.get<LiveResponse>('/attendance/live', { params: clean(params) });
  return data;
}

export interface ReportParams extends ScopeParams {
  from: string;
  to: string;
  posUserId?: string | null;
}

export async function fetchReport(params: ReportParams): Promise<ReportResponse> {
  const { data } = await api.get<ReportResponse>('/attendance/report', { params: clean(params) });
  return data;
}

export type ShiftDetail = Omit<AttendanceShift, 'openTables'> & {
  details: Record<string, unknown>;
  /** The employee's open tables now (an open shift only). */
  openTables: OpenTableInfo[];
  adjustments: AttendanceAdjustment[];
};

export async function fetchShift(shiftId: string): Promise<ShiftDetail> {
  const { data } = await api.get<ShiftDetail>(`/attendance/shifts/${shiftId}`);
  return data;
}

export interface OpenTableInfo {
  orderId: string;
  tableId: string;
  number?: number | null;
  name?: string | null;
  total: number;
}

export async function closeShift(
  shiftId: string,
  body: { at?: string | null; reason: string; ignoreOpenTables?: boolean },
): Promise<{ shift: AttendanceShift; adjustment: AttendanceAdjustment }> {
  const { data } = await api.post(`/attendance/shifts/${shiftId}/close`, clean(body));
  return data;
}

export interface AdjustmentsResponse {
  adjustments: AttendanceAdjustment[];
  canManage: boolean;
}

export async function fetchAdjustments(params: ScopeParams & { status?: string; posUserId?: string | null }): Promise<AdjustmentsResponse> {
  const { data } = await api.get<AdjustmentsResponse>('/attendance/adjustments', { params: clean(params) });
  return data;
}

export async function decideAdjustment(
  id: string,
  body: { decision: 'approve' | 'reject'; approvedTime?: string | null; approvedEndTime?: string | null; note?: string | null },
): Promise<AttendanceAdjustment> {
  const { data } = await api.post<AttendanceAdjustment>(`/attendance/adjustments/${id}/decision`, clean(body));
  return data;
}

export interface ManagerAdjustment {
  shopId: string;
  posUserId: string;
  kind: 'missing_in' | 'missing_out' | 'wrong_time' | 'break';
  shiftId?: string | null;
  field?: 'clock_in' | 'clock_out' | null;
  time?: string | null;
  endTime?: string | null;
  reason: string;
}

export async function createAdjustment(body: ManagerAdjustment): Promise<AttendanceAdjustment> {
  const { data } = await api.post<AttendanceAdjustment>('/attendance/adjustments', clean(body));
  return data;
}

export async function fetchRoles(includeInactive = false): Promise<{ roles: EmployeeRole[]; canEdit: boolean }> {
  const { data } = await api.get('/attendance/roles', { params: { includeInactive } });
  return data;
}

export async function addDefaultRoles(): Promise<{ roles: EmployeeRole[]; canEdit: boolean }> {
  const { data } = await api.post('/attendance/roles/defaults');
  return data;
}

export async function createRole(body: { name: string; tipWeight: number }): Promise<EmployeeRole> {
  const { data } = await api.post<EmployeeRole>('/attendance/roles', body);
  return data;
}

export async function updateRole(
  id: string,
  body: Partial<{ name: string; tipWeight: number; isActive: boolean; sortOrder: number }>,
): Promise<EmployeeRole> {
  const { data } = await api.patch<EmployeeRole>(`/attendance/roles/${id}`, body);
  return data;
}

export async function fetchEmployees(shopId: string): Promise<{ employees: AttendanceEmployee[]; canManage: boolean }> {
  const { data } = await api.get('/attendance/employees', { params: { shopId } });
  return data;
}

export async function assignRole(posUserId: string, roleId: string | null): Promise<void> {
  await api.put(`/attendance/employees/${posUserId}/role`, { roleId });
}
