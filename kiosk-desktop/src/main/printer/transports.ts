/**
 * Getting ESC/POS bytes to the SNBC BTP-880 (or any 80 mm ESC/POS printer), with no dialog:
 *
 *  - Windows spooler, RAW: the printer's driver queue (SNBC's driver, or "Generic / Text Only")
 *    takes the bytes as they are (winspool OpenPrinter / StartDocPrinter("RAW") / WritePrinter),
 *    through one long-lived PowerShell helper (no native module, no per-job start-up cost);
 *  - network: TCP 9100 (as the till: connect 3 s, socket 15 s, a refused connect retried 3 times,
 *    4 KB writes, 150 ms, close), with DLE EOT status (paper out / cover / offline).
 *
 * Status on the spooler comes from Win32_Printer (DetectedErrorState: 4 = no paper, 7 = door open,
 * 9 = offline…). Nothing is ever printed to a real printer by the tests.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { parseStatus, STATUS_OFFLINE, STATUS_PAPER, STATUS_PRINTER, type PrinterStatusBits } from '../../core/escpos';
import { scanOf, type UsbScan } from './usbPrinters';

export interface PrinterTarget {
  transport: 'spooler' | 'tcp' | 'none';
  /** The Windows printer (queue) name, for the spooler. */
  queueName?: string | null;
  host?: string | null;
  port?: number | null;
}

export type PrinterHealth = 'ok' | 'no_paper' | 'paper_low' | 'cover_open' | 'offline' | 'error' | 'unavailable' | 'unknown';

export interface Transport {
  send(target: PrinterTarget, bytes: Uint8Array): Promise<void>;
  status(target: PrinterTarget): Promise<{ health: PrinterHealth; detail: string | null }>;
  /** Installed Windows printers (for the technician screen). */
  list(): Promise<Array<{ name: string; port: string | null; health: PrinterHealth }>>;
  /**
   * The queues, the USB printer devices present and the USB ports (usbPrinters.ts) — for finding
   * the printer plugged in. Optional: without it the queue list stands in.
   */
  usbScan?(): Promise<UsbScan>;
  dispose(): void;
}

/* ------------------------------------------------------------------- TCP */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function tcpSend(host: string, port: number, bytes: Uint8Array): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await new Promise<void>((resolve, reject) => {
        const s = net.connect({ host, port });
        s.setTimeout(15_000);
        const connectTimer = setTimeout(() => s.destroy(new Error('connect timeout')), 3_000);
        s.once('connect', async () => {
          clearTimeout(connectTimer);
          try {
            for (let i = 0; i < bytes.length; i += 4096) {
              const chunk = bytes.subarray(i, i + 4096);
              if (!s.write(chunk)) await new Promise<void>((r) => s.once('drain', () => r()));
            }
            await sleep(150);
            s.end(() => resolve());
          } catch (e) {
            reject(e);
          }
        });
        s.once('timeout', () => s.destroy(new Error('socket timeout')));
        s.once('error', (e) => {
          clearTimeout(connectTimer);
          reject(e);
        });
      });
      return;
    } catch (e) {
      lastErr = e;
      const code = (e as { code?: string }).code;
      const retry = code === 'ECONNREFUSED' || /connect timeout/.test(String(e));
      if (!retry || attempt === 3) break;
      await sleep(1_000 + Math.random() * 2_000);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** DLE EOT 1 / 2 / 4 over TCP: one byte each, short waits (never during a job). */
export async function tcpStatus(host: string, port: number): Promise<PrinterStatusBits | null> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const answers: number[] = [];
    const done = () => {
      s.destroy();
      resolve(answers.length === 0 ? null : parseStatus(answers[0] ?? null, answers[1] ?? null, answers[2] ?? null));
    };
    const timer = setTimeout(done, 1_500);
    s.once('connect', async () => {
      for (const q of [STATUS_PRINTER, STATUS_OFFLINE, STATUS_PAPER]) {
        s.write(q);
        await sleep(150);
      }
      clearTimeout(timer);
      setTimeout(done, 200);
    });
    s.on('data', (d: Buffer) => answers.push(...d));
    s.once('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
  });
}

export function healthOfBits(b: PrinterStatusBits | null): PrinterHealth {
  if (!b || !b.valid) return 'unknown';
  if (b.paper === 'out') return 'no_paper';
  if (b.coverOpen) return 'cover_open';
  if (b.offline) return 'offline';
  if (b.error) return 'error';
  if (b.paper === 'near_end') return 'paper_low';
  return 'ok';
}

/** Win32_Printer.DetectedErrorState / WorkOffline → health. */
export function healthOfWin32(detected: number | null, workOffline: boolean, printerStatus: number | null): PrinterHealth {
  if (detected === 4) return 'no_paper';
  if (detected === 3) return 'paper_low';
  if (detected === 7) return 'cover_open';
  if (detected === 8 || detected === 10) return 'error';
  if (detected === 9 || workOffline || printerStatus === 7) return 'offline';
  if (detected === 2 || detected === 0 || detected === null) return 'ok';
  return 'unknown';
}

/* --------------------------------------------------------------- spooler */

/** The helper: C# over winspool.drv, commands as JSON lines on stdin, answers on stdout. */
export const SPOOLER_HELPER_PS1 = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class R2mRaw {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public class DOCINFO { public string pDocName; public string pOutputFile; public string pDataType; }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool OpenPrinter(string name, out IntPtr h, IntPtr d);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)] public static extern int StartDocPrinter(IntPtr h, int level, [In] DOCINFO di);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)] public static extern bool WritePrinter(IntPtr h, byte[] buf, int len, out int written);
  public static string Send(string printer, byte[] data, string docName) {
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero)) return "open:" + Marshal.GetLastWin32Error();
    try {
      var di = new DOCINFO { pDocName = docName, pDataType = "RAW" };
      if (StartDocPrinter(h, 1, di) == 0) return "startdoc:" + Marshal.GetLastWin32Error();
      try {
        if (!StartPagePrinter(h)) return "startpage:" + Marshal.GetLastWin32Error();
        int written;
        bool ok = WritePrinter(h, data, data.Length, out written);
        EndPagePrinter(h);
        if (!ok || written != data.Length) return "write:" + Marshal.GetLastWin32Error();
      } finally { EndDocPrinter(h); }
      return "";
    } finally { ClosePrinter(h); }
  }
}
"@
[Console]::Out.WriteLine('{"ready":true}')
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  try {
    $cmd = $line | ConvertFrom-Json
    if ($cmd.op -eq 'send') {
      $err = [R2mRaw]::Send($cmd.printer, [Convert]::FromBase64String($cmd.data), 'R2M Kiosk')
      if ($err -eq '') { $out = @{ id = $cmd.id; ok = $true } } else { $out = @{ id = $cmd.id; ok = $false; error = $err } }
    } elseif ($cmd.op -eq 'list') {
      $ps = @(Get-CimInstance Win32_Printer | ForEach-Object { @{ name = $_.Name; port = $_.PortName; detected = $_.DetectedErrorState; offline = [bool]$_.WorkOffline; status = $_.PrinterStatus } })
      $out = @{ id = $cmd.id; ok = $true; printers = $ps }
    } elseif ($cmd.op -eq 'usb') {
      $qs = @(Get-CimInstance Win32_Printer | ForEach-Object { @{ name = $_.Name; port = $_.PortName; driver = $_.DriverName; detected = $_.DetectedErrorState; offline = [bool]$_.WorkOffline; status = $_.PrinterStatus } })
      $ds = $null
      try { $ds = @(Get-CimInstance Win32_PnPEntity -Filter "PNPDeviceID LIKE 'USB%'" | Where-Object { $_.Service -eq 'usbprint' -or $_.PNPDeviceID -like 'USBPRINT\*' -or $_.PNPDeviceID -match '^USB\\VID_(1504|04B8|0519|1D90|2730|0DD4|154F|0D3A|0619)&' } | ForEach-Object { @{ name = $_.Name; id = $_.PNPDeviceID; error = $_.ConfigManagerErrorCode; service = $_.Service; cls = $_.PNPClass } }) } catch { $ds = $null }
      $pts = $null
      try {
        $base = 'HKLM:\SYSTEM\CurrentControlSet\Control\DeviceClasses\{28d78fad-5a12-11d1-ae5b-0000f803a8c2}'
        $pts = @()
        if (Test-Path -LiteralPath $base) {
          foreach ($k in @(Get-ChildItem -LiteralPath $base -ErrorAction Stop)) {
            $dp = Get-ItemProperty -LiteralPath (Join-Path $k.PSPath '#\Device Parameters') -ErrorAction SilentlyContinue
            if ($dp -and $null -ne $dp.'Port Number') {
              $bn = 'USB'
              if ($dp.'Base Name') { $bn = [string]$dp.'Base Name' }
              $cp = Get-ItemProperty -LiteralPath (Join-Path $k.PSPath '#\Control') -ErrorAction SilentlyContinue
              $pts += @{ port = ('{0}{1:000}' -f $bn, [int]$dp.'Port Number'); linked = [bool]($cp -and $cp.Linked -eq 1); description = $dp.'Port Description' }
            }
          }
        }
      } catch { $pts = $null }
      $out = @{ id = $cmd.id; ok = $true; queues = $qs; devices = $ds; ports = $pts }
    } else { $out = @{ id = $cmd.id; ok = $false; error = 'unknown op' } }
  } catch { $out = @{ id = $cmd.id; ok = $false; error = $_.Exception.Message } }
  [Console]::Out.WriteLine(($out | ConvertTo-Json -Compress -Depth 4))
}
`;

interface Pending {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

/** The long-lived PowerShell helper (Windows only). */
export class SpoolerHelper {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private ready: Promise<void> | null = null;
  private buf = '';
  private pending = new Map<string, Pending>();

  constructor(private readonly log: (m: string) => void = () => undefined) {}

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      const encoded = Buffer.from(SPOOLER_HELPER_PS1, 'utf16le').toString('base64');
      const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true });
      this.proc = proc;
      let started = false;
      const fail = (e: Error) => {
        this.ready = null;
        this.proc = null;
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(e);
        }
        this.pending.clear();
        if (!started) reject(e);
      };
      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk: string) => {
        this.buf += chunk;
        let nl: number;
        while ((nl = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, nl).trim();
          this.buf = this.buf.slice(nl + 1);
          if (!line) continue;
          let msg: Record<string, unknown>;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
          }
          if (msg.ready) {
            started = true;
            resolve();
            continue;
          }
          const p = this.pending.get(String(msg.id));
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(String(msg.id));
            p.resolve(msg);
          }
        }
      });
      proc.stderr.on('data', (d) => this.log(`spooler helper: ${String(d).trim()}`));
      proc.on('error', (e) => fail(e));
      proc.on('exit', (code) => fail(new Error(`spooler helper exited (${code})`)));
    });
    return this.ready;
  }

  async call(op: Record<string, unknown>, timeoutMs = 20_000): Promise<Record<string, unknown>> {
    await this.start();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('spooler helper timeout'));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.proc!.stdin.write(`${JSON.stringify({ ...op, id })}\n`);
    });
  }

  dispose() {
    this.proc?.kill();
    this.proc = null;
    this.ready = null;
  }
}

export class DefaultTransport implements Transport {
  private helper: SpoolerHelper;

  constructor(private readonly log: (m: string) => void = () => undefined) {
    this.helper = new SpoolerHelper(log);
  }

  async send(target: PrinterTarget, bytes: Uint8Array): Promise<void> {
    if (target.transport === 'tcp') {
      if (!target.host) throw new Error('no printer address');
      return tcpSend(target.host, target.port ?? 9100, bytes);
    }
    if (target.transport === 'spooler') {
      if (process.platform !== 'win32') throw new Error('the Windows spooler is only on Windows');
      if (!target.queueName) throw new Error('no printer queue chosen');
      const r = await this.helper.call({ op: 'send', printer: target.queueName, data: Buffer.from(bytes).toString('base64') });
      if (r.ok !== true) throw new Error(`spooler: ${String(r.error ?? 'failed')}`);
      return;
    }
    throw new Error('no printer configured');
  }

  async status(target: PrinterTarget): Promise<{ health: PrinterHealth; detail: string | null }> {
    if (target.transport === 'tcp' && target.host) {
      const bits = await tcpStatus(target.host, target.port ?? 9100);
      return { health: bits ? healthOfBits(bits) : 'unavailable', detail: null };
    }
    if (target.transport === 'spooler' && target.queueName && process.platform === 'win32') {
      const list = await this.list().catch(() => []);
      const p = list.find((x) => x.name === target.queueName);
      return p ? { health: p.health, detail: p.port } : { health: 'unavailable', detail: 'התור לא נמצא' };
    }
    return { health: 'unavailable', detail: null };
  }

  async list(): Promise<Array<{ name: string; port: string | null; health: PrinterHealth }>> {
    if (process.platform !== 'win32') return [];
    const r = await this.helper.call({ op: 'list' });
    const printers = Array.isArray(r.printers) ? (r.printers as Array<Record<string, unknown>>) : r.printers ? [r.printers as Record<string, unknown>] : [];
    return printers.map((p) => ({
      name: String(p.name ?? ''),
      port: (p.port as string) ?? null,
      health: healthOfWin32(typeof p.detected === 'number' ? p.detected : null, p.offline === true, typeof p.status === 'number' ? p.status : null),
    }));
  }

  /** The queues, the USB printer devices present and the USB ports (the helper's `usb` op; usbPrinters.ts). */
  async usbScan(): Promise<UsbScan> {
    if (process.platform !== 'win32') return { queues: [], devices: null, ports: null, at: Date.now() };
    const r = await this.helper.call({ op: 'usb' }, 15_000);
    if (r.ok !== true) throw new Error(`spooler: ${String(r.error ?? 'usb scan failed')}`);
    return scanOf(r, (q) => healthOfWin32(typeof q.detected === 'number' ? q.detected : null, q.offline === true, typeof q.status === 'number' ? q.status : null), Date.now());
  }

  dispose() {
    this.helper.dispose();
  }
}

/**
 * The BTP-880's queue among the installed printers by name: SNBC / BTP first, then a Generic / Text
 * Only queue. "אוטומטי" asks for the USB printer plugged in first (usbPrinters.ts resolvePrinterTarget).
 */
export function guessQueue(names: readonly string[]): string | null {
  return names.find((n) => /btp|snbc/i.test(n)) ?? names.find((n) => /generic.*text only/i.test(n)) ?? null;
}
