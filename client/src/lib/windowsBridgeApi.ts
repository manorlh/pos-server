/**
 * "התקנת גשר ל-Windows" (docs/SPEC_KIOSK.md §28): the newest Windows release the cloud holds,
 * downloaded under the bridge's name (`R2M-POS-Windows-bridge-setup.exe`) — the installer reads
 * its own name and starts R2M POS for Windows as the bridge (a tray program for the browser kiosk /
 * KDS / board on that PC). The server's side: app/routers/app_releases.py.
 */

import { api } from './api';

export interface WindowsInstallerInfo {
  available: boolean;
  versionName?: string;
  sizeBytes?: number;
  sha256?: string;
  fileName?: string;
}

export const BRIDGE_INSTALLER_NAME = 'R2M-POS-Windows-bridge-setup.exe';

export async function fetchNewestWindowsInstaller(): Promise<WindowsInstallerInfo> {
  const { data } = await api.get<WindowsInstallerInfo>('/app-releases/windows/latest');
  return data;
}

/** Saves the installer in the browser's downloads, under the bridge's name. */
export async function downloadBridgeInstaller(): Promise<void> {
  const { data } = await api.get<Blob>('/app-releases/windows/latest/download', { params: { flavor: 'bridge' }, responseType: 'blob' });
  const url = URL.createObjectURL(data);
  const a = document.createElement('a');
  a.href = url;
  a.download = BRIDGE_INSTALLER_NAME;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5_000);
}

/** "118.4 MB". */
export function sizeText(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '';
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;
}
