/**
 * "בעיות" — the API calls (pos-server app/routers/problems.py) and the hooks the screen, the
 * menu's badge and the home page share. Types and pure rules live in `lib/problems.ts`.
 */
import { useQuery } from '@tanstack/react-query';
import { api } from './api';
import { useAuth } from './auth';
import { useDashboardAccess } from './dashboardAccessApi';
import {
  PROBLEMS_REFRESH_MS,
  canSeeProblems,
  resolveRequest,
  type ProblemItem,
  type ProblemsPreferences,
  type ProblemsResponse,
} from './problems';

export interface ProblemsScope {
  companyId?: string | null;
  shopId?: string | null;
}

export async function fetchProblems(scope: ProblemsScope = {}): Promise<ProblemsResponse> {
  const params: Record<string, string> = {};
  // The narrowest only: a shop says its company.
  if (scope.shopId) params.shopId = scope.shopId;
  else if (scope.companyId) params.companyId = scope.companyId;
  const { data } = await api.get<ProblemsResponse>('/problems', { params });
  return data;
}

export async function fetchProblemsPreferences(): Promise<ProblemsPreferences> {
  const { data } = await api.get<ProblemsPreferences>('/problems/preferences');
  return data;
}

export async function saveProblemsHidden(hiddenGroups: string[]): Promise<ProblemsPreferences> {
  const { data } = await api.put<ProblemsPreferences>('/problems/preferences', { hiddenGroups });
  return data;
}

/** "טופל" on a problem that is a log row, through the route the server named for this user. */
export async function resolveProblem(item: ProblemItem): Promise<void> {
  const request = resolveRequest(item);
  if (!request) return;
  if (request.method === 'post') await api.post(request.url, request.body);
  else await api.patch(request.url, request.body);
}

export function problemsKey(scope: ProblemsScope = {}) {
  return ['problems', scope.companyId ?? null, scope.shopId ?? null] as const;
}

/** Whether this user is offered the screen (role and "הרשאות דשבורד"; the server decides again). */
export function useCanSeeProblems(): boolean {
  const role = useAuth((s) => (s.authHydrated ? s.user?.role ?? null : null));
  const access = useDashboardAccess();
  return canSeeProblems(role, access);
}

/** The open problems — the screen's (30 s), the menu badge's and the home page's (one cache entry). */
export function useProblems(scope: ProblemsScope = {}, { enabled = true, refetchMs = PROBLEMS_REFRESH_MS } = {}) {
  const allowed = useCanSeeProblems();
  return useQuery<ProblemsResponse>({
    queryKey: problemsKey(scope),
    queryFn: () => fetchProblems(scope),
    enabled: allowed && enabled,
    refetchInterval: refetchMs,
    staleTime: 15_000,
    retry: false,
  });
}
