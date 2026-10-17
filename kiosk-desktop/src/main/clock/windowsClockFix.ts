/**
 * "תיקון שעון" on Windows (core/clockTrust.ts). The app runs per user, without admin rights (the installer is
 * per-user, `perMachine: false`), and Windows lets only an administrator change the time — so:
 *
 * * already elevated (an installation run as administrator): `clockAutoFix` fixes it by itself, at most once per half
 *   hour, never under a payment;
 * * otherwise only the technician's "תיקון שעון" does, through the UAC prompt (someone at the computer approves) —
 *   the app never changes the system time silently without admin rights.
 *
 * What runs (one elevated PowerShell, Windows 7 too — PowerShell 2.0 has every part): the clock moved by the measured
 * skew relative to itself (`Set-Date -Adjust`: the moments the UAC prompt waits do not matter), then automatic time
 * on — the Windows Time service automatic and started, synchronising from time.windows.com — and a resync. A network
 * that blocks NTP keeps the server's time set here; the next beats measure again.
 *
 * Nothing here runs on its own: {@link runClockFix} takes the process runner (main/index.ts passes `execFile`, the
 * tests a fake).
 */

export interface RunOut {
  code: number | null;
  stdout: string;
  stderr: string;
}

export type Runner = (file: string, args: string[], opts?: { timeoutMs?: number }) => Promise<RunOut>;

export const NTP_PEERS = 'time.windows.com,0x9';

/** The elevated script: the adjustment (if any), then automatic time and a resync. Exit 0 / 2 (the adjustment failed). */
export function clockFixScript(adjustMs: number | null): string {
  const lines = ["$ErrorActionPreference = 'Continue'", '$code = 0'];
  if (adjustMs !== null && Number.isFinite(adjustMs) && Math.round(adjustMs) !== 0) {
    lines.push(
      `try { Set-Date -Adjust ([TimeSpan]::FromMilliseconds(${Math.round(adjustMs)})) -ErrorAction Stop | Out-Null } catch { $code = 2 }`,
    );
  }
  lines.push(
    'sc.exe config w32time start= auto | Out-Null',
    'net start w32time 2>&1 | Out-Null',
    `w32tm /config /manualpeerlist:"${NTP_PEERS}" /syncfromflags:manual /update 2>&1 | Out-Null`,
    'w32tm /resync /rediscover 2>&1 | Out-Null',
    'exit $code',
  );
  return lines.join('\r\n');
}

/** PowerShell's -EncodedCommand: UTF-16LE, base64. */
export function encodeCommand(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

const PS = 'powershell.exe';
const PS_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];

/** The command line: the script directly when elevated, else through `Start-Process -Verb RunAs` (UAC). */
export function clockFixCommand(adjustMs: number | null, elevated: boolean): { file: string; args: string[] } {
  const encoded = encodeCommand(clockFixScript(adjustMs));
  if (elevated) return { file: PS, args: [...PS_ARGS, '-EncodedCommand', encoded] };
  const inner = `'-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'`;
  const outer = `try { $p = Start-Process -FilePath powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList ${inner}; exit $p.ExitCode } catch { exit 1223 }`;
  return { file: PS, args: [...PS_ARGS, '-Command', outer] };
}

export interface FixOutcome {
  result: 'ok' | 'failed' | 'refused';
  message: string;
}

/** Runs the fix. 1223 = ERROR_CANCELLED: the UAC prompt was declined. */
export async function runClockFix(run: Runner, adjustMs: number | null, elevated: boolean): Promise<FixOutcome> {
  const { file, args } = clockFixCommand(adjustMs, elevated);
  let out: RunOut;
  try {
    out = await run(file, args, { timeoutMs: 3 * 60_000 });
  } catch (e) {
    return { result: 'failed', message: `לא הורץ: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200) };
  }
  if (out.code === 0) return { result: 'ok', message: adjustMs ? 'השעון תוקן לפי השרת והשעה האוטומטית הופעלה' : 'השעה האוטומטית הופעלה וסונכרנה' };
  if (out.code === 1223) return { result: 'refused', message: 'Windows לא אישר (בקשת ההרשאה נדחתה)' };
  if (out.code === 2) return { result: 'failed', message: 'שינוי השעה נכשל; השעה האוטומטית הופעלה' };
  return { result: 'failed', message: `התיקון נכשל (קוד ${out.code ?? '?'})` };
}

/** Whether the app runs with administrator rights (`net session` answers only an administrator). */
export async function isElevated(run: Runner): Promise<boolean> {
  try {
    const out = await run('net.exe', ['session'], { timeoutMs: 10_000 });
    return out.code === 0;
  } catch {
    return false;
  }
}
