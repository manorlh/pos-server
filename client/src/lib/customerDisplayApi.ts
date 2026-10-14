/** "מסך לקוח": the dashboard's calls (pos-server app/routers/customer_display.py). */
import { api } from '@/lib/api';
import type { CdDisplayRow, CdDisplaysView, CdLayer, CdLayerView, CdLevel, CdMediaFile, CdPresenceFile } from '@/lib/customerDisplay';
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

/**
 * A slideshow file for the layer being edited (P:/specs/customer-display-transitions.md §3א): answered
 * at once with `status: "processing"`; compressed in the background (videos at [videoQuality]).
 */
export async function uploadCustomerDisplayMedia(level: CdLevel, entityId: string, file: File, videoQuality?: string): Promise<CdMediaFile> {
  const form = new FormData();
  form.append('file', file);
  const { data } = await api.post<CdMediaFile>('/customer-display/media', form, {
    params: { level, entityId, ...(videoQuality ? { videoQuality } : {}) },
    headers: { 'Content-Type': undefined },
  });
  return data;
}

/** The files' state (polled while one is "בעיבוד…"). */
export async function getCustomerDisplayMedia(ids: readonly string[]): Promise<CdMediaFile[]> {
  if (!ids.length) return [];
  const { data } = await api.get<{ files: CdMediaFile[] }>('/customer-display/media', { params: { ids: ids.join(',') } });
  return data.files;
}

/** "העלה מחדש": the file again, for one the server deleted; its playlists follow once it is ready. */
export async function reuploadCustomerDisplayMedia(
  mediaId: string,
  level: CdLevel,
  entityId: string,
  file: File,
  videoQuality?: string,
): Promise<CdMediaFile> {
  const form = new FormData();
  form.append('file', file);
  const { data } = await api.post<CdMediaFile>(`/customer-display/media/${encodeURIComponent(mediaId)}/reupload`, form, {
    params: { level, entityId, ...(videoQuality ? { videoQuality } : {}) },
    headers: { 'Content-Type': undefined },
  });
  return data;
}

/** Per file of the layer's playlist: "קיים ב-X מתוך Y מכשירים", and who lacks it. */
export async function getCustomerDisplayMediaPresence(level: CdLevel, entityId: string): Promise<CdPresenceFile[]> {
  const { data } = await api.get<{ files: CdPresenceFile[] }>(`/customer-display/media-presence/${level}/${encodeURIComponent(entityId)}`);
  return data.files;
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
