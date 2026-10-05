/**
 * "תפריט דמה" — pos-server /demo-menu (docs/SPEC_TRAINING_MODE.md): the templates, what is
 * loaded for a shop, loading one, and removing exactly what a load created.
 *
 * The shapes and the rules on them live in lib/trainingMode.ts.
 */
import { api } from './api';
import type {
  DemoMenuLoad,
  DemoMenuLoadBody,
  DemoMenuRemovePreview,
  DemoMenuRemoveResult,
  DemoMenuStatus,
  DemoTemplate,
} from './trainingMode';

export type {
  DemoMenuLoad,
  DemoMenuLoadBody,
  DemoMenuRemovePreview,
  DemoMenuRemoveResult,
  DemoMenuStatus,
  DemoTemplate,
  DemoTemplateCounts,
} from './trainingMode';

export async function fetchDemoTemplates(): Promise<DemoTemplate[]> {
  const { data } = await api.get<{ templates: DemoTemplate[] }>('/demo-menu/templates');
  return Array.isArray(data?.templates) ? data.templates : [];
}

export async function fetchDemoMenuStatus(companyId: string, shopId: string | null): Promise<DemoMenuStatus> {
  const { data } = await api.get<DemoMenuStatus>('/demo-menu/status', {
    params: shopId ? { companyId, shopId } : { companyId },
  });
  return data;
}

/** Errors: 409 `{code: 'demo_menu_loaded', loadId}`, 422 `{code: 'unknown_template'}`, 403. */
export async function loadDemoMenu(body: DemoMenuLoadBody): Promise<DemoMenuLoad> {
  const { data } = await api.post<DemoMenuLoad>('/demo-menu/load', body);
  return data;
}

export async function fetchDemoRemovePreview(loadId: string): Promise<DemoMenuRemovePreview> {
  const { data } = await api.get<DemoMenuRemovePreview>(`/demo-menu/loads/${loadId}/remove-preview`);
  return data;
}

export async function removeDemoMenu(loadId: string): Promise<DemoMenuRemoveResult> {
  const { data } = await api.post<DemoMenuRemoveResult>(`/demo-menu/loads/${loadId}/remove`);
  return data;
}
