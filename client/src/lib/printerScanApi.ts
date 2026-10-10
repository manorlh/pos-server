/**
 * Printing beyond the printer list — pos-server app/routers/printer_discovery.py,
 * printer_zones.py, print_redirects.py (docs/SPEC_PRINT_BY_ZONE.md):
 *
 * - "חיפוש ברשת": a till of the shop scans its LAN for printers;
 * - "הפניה לפי אזור שולחנות": per table zone, what goes to one printer prints on another;
 * - "מדפסת חלופית": the tickets / receipts the employees sent elsewhere when a printer was down.
 */
import { api } from './api';
import { zoneRowsToMap, type PrinterScanStatus, type ZoneRedirectRow } from './printRouting';

export { scanRunning, scanResultUsable, orderScanResults, scanErrorKey, zoneRowsProblem, zoneRowsDirty } from './printRouting';
export type { PrinterScanStatus, ZoneRedirectRow } from './printRouting';

// ── "חיפוש ברשת" ─────────────────────────────────────────────────────────────

/** escpos — answered the ESC/POS status query; other — LPD / IPP only; unknown — a raw port that did not answer. */
export type DiscoveredKind = 'escpos' | 'other' | 'unknown';

export interface DiscoveredPrinter {
  host: string;
  port: number;
  name: string | null;
  model: string | null;
  kind: DiscoveredKind;
  responseMs: number | null;
  paper: 'ok' | 'near_end' | 'out' | null;
  offline: boolean | null;
  otherPorts: number[];
  services: string[];
  /** The shop's printer at this address (as the shop is now), if any. */
  configuredPrinterId: string | null;
  configuredPrinterName: string | null;
}

export interface PrinterScan {
  id: string;
  status: PrinterScanStatus;
  source: 'dashboard' | 'till';
  machineId: string | null;
  machineName: string | null;
  subnet: string | null;
  lanAddress: string | null;
  /** not_on_lan | cancelled | not_picked_up | no_report | the till's words */
  error: string | null;
  durationMs: number | null;
  createdAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  expiresAt: string | null;
  printers: DiscoveredPrinter[] | null;
}

export interface ScanTill {
  machineId: string;
  name: string;
  online: boolean;
  isPrintHost: boolean;
  lastSeenAt: string | null;
}

export interface PrinterScanState {
  shopId: string;
  /** The newest scan, whatever its state. */
  request: PrinterScan | null;
  /** The newest finished scan with results. */
  last: PrinterScan | null;
  /** The till a new scan would go to; null: none online. */
  scanner: ScanTill | null;
  tills: ScanTill[];
}

export async function fetchPrinterScan(shopId: string): Promise<PrinterScanState> {
  const { data } = await api.get<PrinterScanState>(`/shops/${shopId}/printer-scan`);
  return data;
}

/** Ask a till of the shop to scan (409 `no_till_online`). A scan under way is returned as is. */
export async function startPrinterScan(shopId: string, machineId?: string | null): Promise<PrinterScanState> {
  const { data } = await api.post<PrinterScanState>(`/shops/${shopId}/printer-scan`, machineId ? { machineId } : {});
  return data;
}

// ── "הפניה לפי אזור שולחנות" ─────────────────────────────────────────────────

export interface ZoneRedirectZone {
  id: string;
  name: string;
  areaId: string | null;
  areaName: string | null;
  redirects: ZoneRedirectRow[];
}

export interface ZoneRedirectsPage {
  shopId: string;
  zones: ZoneRedirectZone[];
  printers: { id: string; name: string; isActive: boolean }[];
}

export async function fetchZoneRedirects(shopId: string): Promise<ZoneRedirectsPage> {
  const { data } = await api.get<ZoneRedirectsPage>(`/shops/${shopId}/printer-zone-redirects`);
  return data;
}

/** One zone's redirect, whole ({} clears it). */
export async function saveZoneRedirects(
  shopId: string,
  zoneId: string,
  rows: ZoneRedirectRow[],
): Promise<ZoneRedirectsPage> {
  const { data } = await api.put<ZoneRedirectsPage>(`/shops/${shopId}/printer-zone-redirects/${zoneId}`, {
    redirects: zoneRowsToMap(rows),
  });
  return data;
}

// ── "מדפסת חלופית" ────────────────────────────────────────────────────────────

export interface PrintRedirect {
  id: string;
  kind: 'kitchen' | 'receipt';
  machineId: string | null;
  machineName: string | null;
  fromPrinterId: string | null;
  fromName: string | null;
  toPrinterId: string | null;
  toName: string | null;
  ticket: string | null;
  error: string | null;
  /** "The next ones too": until then. */
  temporaryUntil: string | null;
  posUserName: string | null;
  occurredAt: string | null;
}

export async function fetchPrintRedirects(shopId: string, days = 7): Promise<PrintRedirect[]> {
  const { data } = await api.get<{ redirects: PrintRedirect[] }>(`/shops/${shopId}/print-redirects`, {
    params: { days },
  });
  return data.redirects ?? [];
}
