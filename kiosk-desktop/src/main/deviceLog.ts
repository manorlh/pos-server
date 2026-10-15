/**
 * The app's rolling log on the disk (P:/specs/device-logs-api.md §5, as the Android till keeps it): every
 * console line of the main process, time-stamped, appended to `<dataDir>/logs/app-0.log`; at 1 MB the files
 * shift (app-0 → app-1 … app-3, the oldest dropped) — 4 × 1 MB. Survives a restart and a crash. Never blocks:
 * a failed write is dropped.
 *
 * `collect(fromMs, toMs)` reads back the lines of a window (oldest first) for "בקש לוגים".
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';

const FILES = 4;
const MAX_BYTES = 1024 * 1024;
const STAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) /;

export class RollingLog {
  private installed = false;

  constructor(private readonly dir: string, private readonly now: () => number = Date.now) {}

  private file(i: number): string {
    return path.join(this.dir, `app-${i}.log`);
  }

  write(level: string, text: string): void {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      const f = this.file(0);
      if (existsSync(f) && statSync(f).size > MAX_BYTES) this.rotate();
      const stamp = new Date(this.now()).toISOString();
      const lines = text.split(/\r?\n/).map((l) => `${stamp} ${level} ${l}`);
      appendFileSync(f, `${lines.join('\n')}\n`);
    } catch {
      // never blocks the app over its log
    }
  }

  private rotate() {
    const last = this.file(FILES - 1);
    if (existsSync(last)) rmSync(last, { force: true });
    for (let i = FILES - 2; i >= 0; i--) if (existsSync(this.file(i))) renameSync(this.file(i), this.file(i + 1));
  }

  /** console.log / info / warn / error also into the file (once). */
  install(): void {
    if (this.installed) return;
    this.installed = true;
    for (const [name, level] of [
      ['log', 'I'],
      ['info', 'I'],
      ['warn', 'W'],
      ['error', 'E'],
    ] as const) {
      const original = console[name].bind(console);
      console[name] = (...args: unknown[]) => {
        original(...args);
        this.write(level, format(...args));
      };
    }
  }

  /** The lines between [fromMs] and [toMs], oldest first (a line with no stamp follows the one before it). */
  collect(fromMs: number, toMs: number): string[] {
    const out: string[] = [];
    for (let i = FILES - 1; i >= 0; i--) {
      const f = this.file(i);
      if (!existsSync(f)) continue;
      let keep = false;
      let text = '';
      try {
        text = readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line) continue;
        const m = STAMP.exec(line);
        if (m) {
          const at = Date.parse(m[1]);
          keep = at >= fromMs && at <= toMs;
        }
        if (keep) out.push(line);
      }
    }
    return out;
  }
}
