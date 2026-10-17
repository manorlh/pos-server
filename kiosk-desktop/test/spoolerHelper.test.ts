/**
 * The Windows spooler path end to end, with no printer: the real PowerShell helper (main/printer/transports.ts
 * SpoolerHelper) on both of its paths — PowerShell 3+ and the PowerShell 2 one Windows 7 runs (forced with
 * R2M_PS_LEGACY=1: this PC has no PowerShell 2 engine) — taking a real receipt job, which `R2M_SPOOLER_RECORD` writes to
 * a file instead of a queue; the file read back by the fake printer's parser (test/fakePrinter.ts). And the helper's
 * script checked for anything newer than PowerShell 2.
 */

import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { centreOn, job, toMono } from '../src/core/escpos';
import { DefaultTransport, SPOOLER_HELPER_PS1 } from '../src/main/printer/transports';
import { parseEscPos } from './fakePrinter';

const saved = { record: process.env.R2M_SPOOLER_RECORD, legacy: process.env.R2M_PS_LEGACY };
afterEach(() => {
  process.env.R2M_SPOOLER_RECORD = saved.record ?? '';
  process.env.R2M_PS_LEGACY = saved.legacy ?? '';
});

describe('the spooler helper’s script runs on PowerShell 2.0', () => {
  it('uses nothing newer than PowerShell 2 outside its guarded wrappers', () => {
    // PowerShell 3+: [ordered], ::new(), .ForEach / .Where, -in / -notin, $PSItem, Get-CimInstance / *-Json (wrapped),
    // -PipelineVariable, Get-ItemPropertyValue, the null-coalescing / ternary of 7.
    const ps3 = [/\[ordered\]/i, /::new\(/, /\.(ForEach|Where)\(/, /\s-(in|notin)\s/i, /\$PSItem/i, /-PipelineVariable/i, /Get-ItemPropertyValue/i, /\?\?/, /\s\?\s.+\s:\s/];
    const lines = SPOOLER_HELPER_PS1.split('\n').filter((l) => !l.trim().startsWith('#'));
    for (const re of ps3) expect(lines.filter((l) => re.test(l)), String(re)).toEqual([]);
  });
});

describe.skipIf(process.platform !== 'win32')('a receipt through the Windows spooler path (recorded, never printed)', () => {
  it.each([
    ['PowerShell 5', ''],
    ['PowerShell 2 path (Windows 7)', '1'],
  ])('%s: the bytes and a Hebrew queue name reach the queue as they are (the name arrived garbled before); the queues and the USB look answer', async (_name, legacy) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'r2m-spool-'));
    process.env.R2M_SPOOLER_RECORD = dir;
    process.env.R2M_PS_LEGACY = legacy;
    const t = new DefaultTransport();
    try {
      const rgba = new Uint8Array(64 * 16 * 4).fill(0);
      const bytes = job(centreOn(toMono(rgba, 64, 16), 576), { cut: true });
      await t.send({ transport: 'spooler', queueName: 'R2M test queue — קבלות' }, bytes, { page: true });
      const files = readdirSync(dir);
      const prn = files.find((f) => f.endsWith('.prn'))!;
      const got = new Uint8Array(readFileSync(path.join(dir, prn)));
      expect(Buffer.from(got).equals(Buffer.from(bytes))).toBe(true);
      expect(readFileSync(path.join(dir, prn.replace('.prn', '.txt')), 'utf8')).toBe('R2M test queue — קבלות');
      const parsed = parseEscPos(got);
      expect(parsed.events.map((e) => e.op)).toEqual(['init', 'raster', 'feed', 'cut']);
      expect(parsed.pages[0].width).toBe(576);
      // The queues (every PC has some) and the USB look, on this path too.
      const queues = await t.list();
      expect(Array.isArray(queues)).toBe(true);
      const scan = await t.usbScan();
      expect(Array.isArray(scan.queues)).toBe(true);
      expect(scan.queues.map((q) => q.name).sort()).toEqual(queues.map((q) => q.name).sort());
    } finally {
      t.dispose();
    }
  }, 90_000);
});
