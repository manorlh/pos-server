/**
 * "מצב סנכרון של מכשיר" — the dashboard's calls (pos-server app/routers/sync_status.py; P:/specs/
 * device-sync-status.md §5.7). "סנכרן עכשיו" is the existing `sync_now` command (`POST /device-commands`,
 * which wakes the device over Ably); its run is followed here and in the command tray.
 */
import { api } from '@/lib/api';
import { idempotencyHeaders, trackCommand } from '@/lib/deviceCommandsStore';
import { newKey } from '@/lib/deviceCommands';
import { chunkIds, type CommandView, type DeviceSyncStatus, type SyncStatusList } from '@/lib/syncStatus';

export async function fetchSyncStatus(machineId: string): Promise<DeviceSyncStatus> {
  const { data } = await api.get<DeviceSyncStatus>(`/machines/${machineId}/sync-status`);
  return data;
}

export async function fetchShopSyncStatus(shopId: string): Promise<SyncStatusList> {
  const { data } = await api.get<SyncStatusList>('/machines/sync-status', { params: { shopId } });
  return data;
}

/** Many devices, in chunks of what one read takes. */
export async function fetchSyncStatuses(machineIds: readonly string[]): Promise<DeviceSyncStatus[]> {
  const out: DeviceSyncStatus[] = [];
  for (const chunk of chunkIds(machineIds)) {
    const p = new URLSearchParams();
    for (const id of chunk) p.append('machineIds', id);
    const { data } = await api.get<SyncStatusList>(`/machines/sync-status?${p.toString()}`);
    out.push(...(data.items ?? []));
  }
  return out;
}

export async function fetchCommandViews(ids: readonly string[]): Promise<CommandView[]> {
  if (ids.length === 0) return [];
  const p = new URLSearchParams();
  for (const id of ids) p.append('ids', id);
  const { data } = await api.get<{ items: CommandView[] }>(`/device-commands/status?${p.toString()}`);
  return data.items ?? [];
}

/**
 * Send `sync_now` to one device or a whole shop and put each command in the tray (quietly — the
 * card shows the run itself). The commands as the server made them; throws when the send failed.
 */
export async function sendSyncNow(
  target: { machineIds: string[] } | { shopId: string },
  names: ReadonlyMap<string, string> = new Map(),
  /** The send's Idempotency-Key: the same key never makes a second command (a re-mounted dialog). */
  key: string = newKey(),
): Promise<CommandView[]> {
  const body = { action: 'sync_now', ...target };
  const { data } = await api.post<Array<{ id: string; machineId: string; status: string; detail?: string | null }>>(
    '/device-commands',
    body,
    idempotencyHeaders(key),
  );
  const rows = Array.isArray(data) ? data : [];
  for (const r of rows) {
    trackCommand({
      kind: 'device',
      id: r.id,
      action: 'sync_now',
      machineId: r.machineId,
      machineName: names.get(r.machineId) ?? null,
      popup: false,
    });
  }
  return rows.map((r) => ({ id: r.id, machineId: r.machineId, status: r.status, detail: r.detail ?? null }));
}
