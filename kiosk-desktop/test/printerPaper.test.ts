/**
 * The receipt printer's state for the cloud and the staff (core/printerPaper.ts): the heartbeat's words are the cloud's
 * (pos-server status_watch.py "אין נייר במדפסת"), the queue's look is the newest observation — an idle probe included —
 * and paper out is a banner for the staff.
 */

import { describe, expect, it } from 'vitest';
import { cloudPrinterOf, currentLook, PAPER_OUT_TEXT, paperBannerOf } from '../src/core/printerPaper';
import { openDb } from '../src/main/db/sqlite';
import { migrate } from '../src/main/db/schema';
import { PrintQueue } from '../src/main/printer/printQueue';
import type { PrinterHealth, PrinterTarget, Transport } from '../src/main/printer/transports';

describe('the cloud words', () => {
  it('speaks pos_machines.PRINTER_STATUSES', () => {
    expect(cloudPrinterOf('no_paper')).toEqual({ status: 'no_paper' });
    expect(cloudPrinterOf('ok')).toEqual({ status: 'ok' });
    expect(cloudPrinterOf('paper_low')).toEqual({ status: 'ok', message: 'הנייר במדפסת עומד להיגמר' });
    expect(cloudPrinterOf('cover_open')).toEqual({ status: 'error', message: 'מכסה המדפסת פתוח' });
    expect(cloudPrinterOf('offline').status).toBe('error');
    expect(cloudPrinterOf('unavailable')).toEqual({ status: 'unavailable' });
    expect(cloudPrinterOf('unknown')).toEqual({ status: 'unknown' });
  });

  it('a banner for paper out only', () => {
    expect(paperBannerOf('no_paper')).toBe(PAPER_OUT_TEXT);
    for (const look of ['ok', 'paper_low', 'cover_open', 'error', 'unknown'] as const) expect(paperBannerOf(look)).toBeNull();
  });

  it('the newest observation wins; a probe that cannot tell never does', () => {
    expect(currentLook([])).toBe('unknown');
    expect(currentLook([{ at: 1, look: 'ok' }, { at: 2, look: 'no_paper' }])).toBe('no_paper');
    expect(currentLook([{ at: 3, look: 'ok' }, { at: 2, look: 'no_paper' }])).toBe('ok');
    expect(currentLook([{ at: 1, look: 'no_paper' }, { at: 5, look: 'unknown' }, null])).toBe('no_paper');
  });
});

class FakeTransport implements Transport {
  health: PrinterHealth = 'ok';
  asked = 0;
  async send(): Promise<void> {}
  async list(): Promise<Array<{ name: string; port: string | null; health: PrinterHealth }>> {
    return [];
  }
  dispose(): void {}
  async status(): Promise<{ health: PrinterHealth; detail: string | null }> {
    this.asked += 1;
    return { health: this.health, detail: null };
  }
}

function queue(target: PrinterTarget) {
  const db = openDb(':memory:');
  migrate(db);
  const t = new FakeTransport();
  return { q: new PrintQueue(db, t, () => target, null), t };
}

describe('the idle probe', () => {
  it('knows the roll ran out before any receipt fails, and that it is back', async () => {
    const { q, t } = queue({ transport: 'tcp', host: '192.168.1.50', port: 9100 });
    expect(q.health()).toBe('unknown');
    t.health = 'no_paper';
    let changed = 0;
    q.onChange(() => (changed += 1));
    await q.probe();
    expect(q.health()).toBe('no_paper');
    expect(changed).toBe(1);
    t.health = 'ok';
    await new Promise((r) => setTimeout(r, 2));
    await q.probe();
    expect(q.health()).toBe('ok');
  });

  it('asks nothing without a printer configured', async () => {
    const { q, t } = queue({ transport: 'none' });
    await q.probe();
    expect(t.asked).toBe(0);
    expect(q.health()).toBe('unknown');
  });

  it('a print that went through after the probe says it is fine again', async () => {
    const { q, t } = queue({ transport: 'spooler', queueName: 'BTP-880' });
    t.health = 'no_paper';
    await q.probe();
    q.lastOkAt = Date.now() + 1;
    expect(q.health()).toBe('ok');
  });
});
