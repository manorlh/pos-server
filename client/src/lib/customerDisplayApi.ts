/** "מסך לקוח": the dashboard's calls (pos-server app/routers/customer_display.py). */
import { api } from '@/lib/api';
import type { CdDisplayRow, CdDisplaysView, CdLayer, CdLayerView, CdLevel } from '@/lib/customerDisplay';
import { layerBody } from '@/lib/customerDisplay';

export async function getCustomerDisplayLayer(level: CdLevel, entityId: string): Promise<CdLayerView> {
  const { data } = await api.get<CdLayerView>(`/customer-display/settings/${level}/${encodeURIComponent(entityId)}`);
  return data;
}

export async function putCustomerDisplayLayer(level: CdLevel, entityId: string, own: CdLayer): Promise<CdLayerView> {
  const { data } = await api.put<CdLayerView>(
    `/customer-display/settings/${level}/${encodeURIComponent(entityId)}`,
    layerBody(own),
  );
  return data;
}

export async function getCustomerDisplays(shopId: string): Promise<CdDisplaysView> {
  const { data } = await api.get<CdDisplaysView>('/customer-display/displays', { params: { shopId } });
  return data;
}

export async function bindCustomerDisplay(machineId: string, tillMachineId: string | null): Promise<CdDisplayRow> {
  const { data } = await api.put<CdDisplayRow>(`/customer-display/displays/${encodeURIComponent(machineId)}/till`, {
    tillMachineId,
  });
  return data;
}

/** The server's Hebrew `message` of a refusal (`{"detail": {"code", "message"}}`), else null. */
export function customerDisplayErrorMessage(err: unknown): string | null {
  const data = (err as { response?: { data?: { detail?: unknown } } })?.response?.data;
  const detail = data?.detail;
  if (detail && typeof detail === 'object') {
    const message = (detail as { message?: unknown }).message;
    if (typeof message === 'string' && message.trim()) return message;
  }
  return null;
}
