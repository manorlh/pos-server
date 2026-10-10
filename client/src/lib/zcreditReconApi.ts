/**
 * "התאמת אשראי מול Z-Credit" (docs/SPEC_ZCREDIT.md "חלק ג׳") — the dashboard's calls. Types and
 * rules in `lib/zcreditRecon.ts`. Read-only toward Z-Credit.
 */
import { api } from './api';
import type {
  ReconAttention,
  ReconCategory,
  ReconItem,
  ReconProblem,
  ReconRun,
  ReconRunDetail,
  ReconTerminals,
} from './zcreditRecon';

export async function fetchReconTerminals(shopId?: string | null): Promise<ReconTerminals> {
  const { data } = await api.get<ReconTerminals>('/zcredit-reconciliation/terminals', {
    params: shopId ? { shopId } : undefined,
  });
  return data;
}

export async function fetchReconRuns(params: {
  from: string;
  to: string;
  terminalKey?: string | null;
  shopId?: string | null;
  history?: boolean;
}): Promise<ReconRun[]> {
  const { data } = await api.get<{ runs: ReconRun[] }>('/zcredit-reconciliation/runs', {
    params: {
      from: params.from,
      to: params.to,
      terminalKey: params.terminalKey || undefined,
      shopId: params.shopId || undefined,
      history: params.history || undefined,
    },
  });
  return data.runs;
}

export async function fetchReconRun(runId: string, params: { categories?: ReconCategory[]; openOnly?: boolean } = {}): Promise<ReconRunDetail> {
  const { data } = await api.get<ReconRunDetail>(`/zcredit-reconciliation/runs/${runId}`, {
    params: {
      category: params.categories?.length ? params.categories : undefined,
      openOnly: params.openOnly || undefined,
    },
  });
  return data;
}

export async function runReconNow(body: { date: string; terminalKey?: string | null; shopId?: string | null }): Promise<{ runs: ReconRun[]; problems: ReconProblem[] }> {
  const { data } = await api.post<{ runs: ReconRun[]; problems: ReconProblem[] }>('/zcredit-reconciliation/run', {
    date: body.date,
    terminalKey: body.terminalKey || null,
    shopId: body.shopId || null,
  });
  return data;
}

export async function markReconHandled(itemId: string, note: string | null): Promise<ReconItem> {
  const { data } = await api.post<ReconItem>(`/zcredit-reconciliation/items/${itemId}/handle`, { note: note || null });
  return data;
}

export async function reopenReconItem(itemId: string): Promise<ReconItem> {
  const { data } = await api.post<ReconItem>(`/zcredit-reconciliation/items/${itemId}/reopen`);
  return data;
}

export async function fetchReconAttention(shopId?: string | null): Promise<ReconAttention> {
  const { data } = await api.get<ReconAttention>('/zcredit-reconciliation/attention', {
    params: shopId ? { shopId } : undefined,
  });
  return data;
}
