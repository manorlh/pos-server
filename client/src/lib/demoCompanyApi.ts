/**
 * "בניית חברת הדגמה" — pos-server /demo-company (the super admin's): the summary, and the build.
 * The shapes and the rules on them live in lib/demoCompany.ts.
 */
import { api } from './api';
import type { DemoCompanyBuildBody, DemoCompanySummary } from './demoCompany';

export type { DemoCompanyBuildBody, DemoCompanySummary } from './demoCompany';

export const DEMO_COMPANY_QUERY_KEY = ['demo-company'] as const;

export async function fetchDemoCompany(): Promise<DemoCompanySummary> {
  const { data } = await api.get<DemoCompanySummary>('/demo-company');
  return data;
}

/**
 * Builds what is missing (the first time everything). Errors: 403 (not the super admin), 409
 * `{code: 'demo_company_build_in_progress'}` while another build runs. A step that failed is in
 * `failed` of the answer, not an error: the rest was built.
 */
export async function buildDemoCompany(body: DemoCompanyBuildBody = {}): Promise<DemoCompanySummary> {
  // Builds two shops, their menus and devices: up to a minute or so on a busy server.
  const { data } = await api.post<DemoCompanySummary>('/demo-company/build', body, { timeout: 180_000 });
  return data;
}
