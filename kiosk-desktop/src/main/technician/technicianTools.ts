/**
 * The technician's look at the Windows PC (core/technicianSetup.ts has the rules): "מידע רשת" (the adapters, their
 * gateway and DNS, the Wi-Fi's name and signal), "חיבור לכתובת" / "API הענן" (timed HTTP), "חיפוש מדפסות ברשת" (the LAN's
 * port 9100, asked for its status — nothing printed), and "המחשב" (the machine's own facts). Read only: nothing here
 * changes a setting of Windows or of a device. Every process and socket is a dependency, so the rules are tested without
 * them (test/technicianSetup.test.ts).
 */

import { execFile } from 'node:child_process';
import os from 'node:os';
import { connectionKind, parseAdapterJson, parseNetshWlan, type AdapterFacts } from '../../core/technicianSetup';
import { subnetHosts } from '../../core/pinpadRelocation';
import { healthOfBits, tcpStatus, type PrinterHealth } from '../printer/transports';
import { localPrivateIpv4, sweepPort } from '../payment/pinpadRelocator';
import type { FetchFn } from '../sync/api';

export type Exec = (file: string, args: string[], timeoutMs: number) => Promise<string>;

export const execText: Exec = (file, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout ?? '')));
  });

export interface NetworkFacts {
  connection: 'wifi' | 'ethernet' | 'other' | 'none';
  ssid: string | null;
  signal: number | null;
  adapters: AdapterFacts[];
}

const ADAPTERS_PS =
  "Get-WmiObject Win32_NetworkAdapterConfiguration -Filter 'IPEnabled=True' | Select-Object Description,IPAddress,DefaultIPGateway,DNSServerSearchOrder | ConvertTo-Json -Compress";

/** `wmic nicconfig … /format:list` (Windows 7's PowerShell 2 has no ConvertTo-Json): `Key={"a","b"}` blocks. */
export function parseWmicList(text: string): AdapterFacts[] {
  const out: Record<string, unknown>[] = [];
  let cur: Record<string, unknown> = {};
  const flush = () => {
    if (Object.keys(cur).length > 0) out.push(cur);
    cur = {};
  };
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Za-z]+)=(.*)$/.exec(line.trim());
    if (!m) {
      if (!line.trim()) flush();
      continue;
    }
    if (m[1] === 'Description' && 'Description' in cur) flush();
    const v = m[2].trim();
    cur[m[1]] = v.startsWith('{') ? [...v.matchAll(/"([^"]*)"/g)].map((x) => x[1]) : v;
  }
  flush();
  return parseAdapterJson(JSON.stringify(out));
}

export async function networkFacts(exec: Exec = execText): Promise<NetworkFacts> {
  let adapters = parseAdapterJson(await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ADAPTERS_PS], 8_000));
  if (adapters.length === 0) adapters = parseWmicList(await exec('wmic', ['nicconfig', 'where', 'IPEnabled=true', 'get', 'Description,IPAddress,DefaultIPGateway,DNSServerSearchOrder', '/format:list'], 8_000));
  const wlan = parseNetshWlan(await exec('netsh', ['wlan', 'show', 'interfaces'], 5_000));
  const connection = connectionKind(adapters);
  return { connection, ssid: connection === 'wifi' ? (wlan?.ssid ?? null) : null, signal: connection === 'wifi' ? (wlan?.signal ?? null) : null, adapters };
}

/** One timed request: `ok` 2xx, `code` the status (null: no answer), `error` why not. */
export interface HttpCheck {
  url: string;
  ok: boolean;
  code: number | null;
  ms: number;
  error: string | null;
  body?: unknown;
}

export async function timedGet(fetchFn: FetchFn, url: string, token: string | null, timeoutMs = 8_000, now: () => number = Date.now): Promise<HttpCheck> {
  const t0 = now();
  try {
    const res = await fetchFn(url, {
      method: 'GET',
      headers: { Accept: 'application/json', 'User-Agent': 'R2M-Kiosk-Windows', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const ms = Math.max(0, now() - t0);
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { url, ok: res.ok, code: res.status, ms, error: null, body };
  } catch (e) {
    const err = e as { name?: string; message?: string; cause?: { code?: string } };
    return { url, ok: false, code: null, ms: Math.max(0, now() - t0), error: err?.cause?.code ?? (err?.name === 'TimeoutError' ? 'timeout' : (err?.message ?? String(e))) };
  }
}

/** The server's origin ("https://host[:port]") for its `/health` — the API is under `/api/v1`. */
export function originOf(serverUrl: string): string | null {
  try {
    const u = new URL(serverUrl);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

export interface FoundPrinter {
  host: string;
  port: number;
  health: PrinterHealth;
}

export interface PrinterScanDeps {
  localIpv4(): string | null;
  sweep(hosts: string[], port: number): Promise<string[]>;
  status(host: string, port: number): Promise<PrinterHealth>;
}

export const realPrinterScan: PrinterScanDeps = {
  localIpv4: localPrivateIpv4,
  sweep: sweepPort,
  status: async (host, port) => healthOfBits(await tcpStatus(host, port)),
};

/**
 * "חיפוש מדפסות ברשת": the PC's own /24, port 9100 (a connect only), then each that answered asked its status (DLE EOT —
 * read only, nothing printed). Off the LAN: `not_on_lan`.
 */
export async function scanLanPrinters(d: PrinterScanDeps = realPrinterScan, port = 9100): Promise<{ ok: true; subnet: string; printers: FoundPrinter[] } | { ok: false; error: 'not_on_lan' }> {
  const ip = d.localIpv4();
  const hosts = subnetHosts(ip).filter((h) => h !== ip);
  if (!ip || hosts.length === 0) return { ok: false, error: 'not_on_lan' };
  const open = await d.sweep(hosts, port);
  const printers: FoundPrinter[] = [];
  for (const host of open) printers.push({ host, port, health: await d.status(host, port).catch(() => 'unknown' as PrinterHealth) });
  printers.sort((a, b) => Number(a.host.split('.').pop()) - Number(b.host.split('.').pop()));
  return { ok: true, subnet: `${ip.split('.').slice(0, 3).join('.')}.0/24`, printers };
}

export interface MachineFacts {
  hostname: string;
  os: string;
  cpu: string;
  memoryGb: number;
  uptimeMin: number;
}

export function machineFacts(): MachineFacts {
  return {
    hostname: os.hostname(),
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model?.trim() ?? '—',
    memoryGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    uptimeMin: Math.round(os.uptime() / 60),
  };
}
