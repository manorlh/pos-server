/**
 * "יומן חריגות" (`/exception-log`) and "התראות SMS על חריגות" (`/exception-alerts`) — the
 * API calls. Types and pure helpers live in `lib/exceptionAlerts.ts`.
 */
import { api } from './api';
import type {
  AlertRule,
  LogEntry,
  LogFilters,
  LogKind,
  LogList,
  LogSummary,
  ProviderInfo,
  RuleBody,
  RulesResponse,
  Severity,
  SmsDispatch,
} from './exceptionAlerts';

function clean(params: object): Record<string, string | number> {
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') out[k] = v;
  return out;
}

// ── The log ──────────────────────────────────────────────────────────────────

export async function fetchLogKinds(): Promise<{ kinds: LogKind[]; severities: { key: Severity; label: string }[] }> {
  const { data } = await api.get('/exception-log/kinds');
  return data;
}

export async function fetchLog(filters: LogFilters, page = 1, pageSize = 50): Promise<LogList> {
  const { data } = await api.get<LogList>('/exception-log', { params: clean({ ...filters, page, pageSize }) });
  return data;
}

export async function fetchLogSummary(filters: LogFilters): Promise<LogSummary> {
  // The summary counts both open and handled; the list's own filters are not its.
  const { acknowledged: _a, code: _c, ruleId: _r, ...rest } = filters;
  void _a;
  void _c;
  void _r;
  const { data } = await api.get<LogSummary>('/exception-log/summary', { params: clean(rest) });
  return data;
}

export async function fetchLogEntryByCode(code: string): Promise<LogEntry> {
  const { data } = await api.get<LogEntry>(`/exception-log/by-code/${encodeURIComponent(code)}`);
  return data;
}

export async function acknowledgeLogEntry(id: string, acknowledged: boolean, note?: string | null): Promise<LogEntry> {
  const { data } = await api.patch<LogEntry>(`/exception-log/${id}`, { acknowledged, note: note ?? null });
  return data;
}

// ── SMS alert rules ──────────────────────────────────────────────────────────

export async function fetchAlertProvider(companyId: string): Promise<ProviderInfo> {
  const { data } = await api.get<ProviderInfo>('/exception-alerts/provider', { params: { companyId } });
  return data;
}

export async function fetchAlertRules(companyId: string, shopId?: string | null): Promise<RulesResponse> {
  const { data } = await api.get<RulesResponse>('/exception-alerts/rules', { params: clean({ companyId, shopId }) });
  return data;
}

export async function createAlertRule(companyId: string, body: RuleBody): Promise<AlertRule> {
  const { data } = await api.post<AlertRule>('/exception-alerts/rules', { ...body, companyId });
  return data;
}

export async function updateAlertRule(id: string, body: Partial<RuleBody>): Promise<AlertRule> {
  const { data } = await api.put<AlertRule>(`/exception-alerts/rules/${id}`, body);
  return data;
}

export async function deleteAlertRule(id: string): Promise<void> {
  await api.delete(`/exception-alerts/rules/${id}`);
}

export interface TestResult {
  provider: ProviderInfo;
  dryRun: boolean;
  dispatches: SmsDispatch[];
}

export async function sendAlertTest(id: string): Promise<TestResult> {
  const { data } = await api.post<TestResult>(`/exception-alerts/rules/${id}/test`);
  return data;
}

export async function fetchRuleDispatches(ruleId: string, limit = 30): Promise<SmsDispatch[]> {
  const { data } = await api.get<{ dispatches: SmsDispatch[] }>('/exception-alerts/dispatches', {
    params: { ruleId, limit },
  });
  return data.dispatches;
}

export interface RuleChange {
  id: string;
  action: 'create' | 'update' | 'delete' | 'test';
  oldValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  userEmail: string | null;
  userRole: string | null;
  at: string | null;
}

export async function fetchRuleChanges(ruleId: string): Promise<RuleChange[]> {
  const { data } = await api.get<{ changes: RuleChange[] }>(`/exception-alerts/rules/${ruleId}/changes`);
  return data.changes;
}

export interface AlertUser {
  id: string;
  name: string;
  email: string;
  role: string;
  shopId: string | null;
}

export async function fetchAlertUsers(companyId: string): Promise<AlertUser[]> {
  const { data } = await api.get<{ users: AlertUser[] }>('/exception-alerts/users', { params: { companyId } });
  return data.users;
}
