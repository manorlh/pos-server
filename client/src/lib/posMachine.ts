import type { PosMachine } from '@/lib/types';

/** Normalize GET /machines rows (camelCase or snake_case, enum quirks). */
export function normalizePosMachine(raw: Record<string, unknown>): PosMachine {
  const pairingRaw = raw.pairingStatus ?? raw.pairing_status;
  let pairingStatus: PosMachine['pairingStatus'] = 'unpaired';
  if (typeof pairingRaw === 'string') {
    const p = pairingRaw.toLowerCase();
    if (p === 'paired' || p === 'assigned' || p === 'unpaired') {
      pairingStatus = p;
    }
  } else if (pairingRaw != null) {
    const s = String(pairingRaw).toLowerCase();
    if (s === 'paired' || s === 'assigned' || s === 'unpaired') {
      pairingStatus = s;
    }
  }

  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    machineCode: String(raw.machineCode ?? raw.machine_code ?? ''),
    merchantId: (raw.merchantId ?? raw.merchant_id) as string | undefined,
    shopId: (raw.shopId ?? raw.shop_id) as string | undefined,
    pairingStatus,
    mqttClientId: (raw.mqttClientId ?? raw.mqtt_client_id) as string | undefined,
    deviceInfo: (raw.deviceInfo ?? raw.device_info) as Record<string, unknown> | undefined,
    isActive: Boolean(raw.isActive ?? raw.is_active ?? true),
    lastHeartbeatAt: (raw.lastHeartbeatAt ?? raw.last_heartbeat_at) as string | undefined,
    lastSyncAt: (raw.lastSyncAt ?? raw.last_sync_at) as string | undefined,
    lastCatalogChangeAt: (raw.lastCatalogChangeAt ?? raw.last_catalog_change_at) as string | undefined,
    catalogPullStale: Boolean(raw.catalogPullStale ?? raw.catalog_pull_stale ?? false),
    createdAt: String(raw.createdAt ?? raw.created_at ?? ''),
    updatedAt: String(raw.updatedAt ?? raw.updated_at ?? ''),
  };
}
