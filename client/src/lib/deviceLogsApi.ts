/**
 * "שליחת לוגים לענן" — the dashboard's calls (pos-server app/routers/device_logs.py). Sending a
 * request is fire-and-forget through lib/deviceCommandsStore.ts `sendDeviceLogsRequest`.
 */
import { api } from '@/lib/api';
import {
  listParams,
  logFileName,
  type DeviceLogList,
  type DeviceLogUpload,
  type LogFilters,
  type LogLines,
  type MachineLogs,
} from '@/lib/deviceLogs';

export async function fetchMachineLogs(machineId: string): Promise<MachineLogs> {
  const { data } = await api.get<MachineLogs>(`/device-logs/machines/${machineId}`);
  return data;
}

export async function fetchDeviceLogs(filters: LogFilters): Promise<DeviceLogList> {
  const { data } = await api.get<DeviceLogList>('/device-logs', { params: listParams(filters) });
  return data;
}

/** "צפה": the first 2000 lines, or (with a query) the matching lines of the whole log. */
export async function fetchLogLines(id: string, query?: string | null): Promise<LogLines> {
  const q = (query ?? '').trim();
  const { data } = await api.get<LogLines>(`/device-logs/${id}/lines`, { params: q ? { q } : {} });
  return data;
}

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** "הורד": the log as .txt (inflated by the server) or the .log.gz exactly as the device sent it. */
export async function downloadDeviceLog(
  u: Pick<DeviceLogUpload, 'id' | 'machineName' | 'machineId' | 'receivedAt'>,
  kind: 'txt' | 'gz',
): Promise<void> {
  const { data } = await api.get<Blob>(`/device-logs/${u.id}/download`, {
    params: { format: kind },
    responseType: 'blob',
  });
  saveBlob(data, logFileName(u, kind));
}
