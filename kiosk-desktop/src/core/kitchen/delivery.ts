/**
 * One ticket onto one printer, step by step, so that "the printer took the bytes" is never mistaken for "it is on
 * paper" (the owner, 09.10.2026: a busy restaurant where bons vanish). The port of pos-android
 * hardware/kitchen/KitchenDelivery.kt:
 *
 *   1. open         — the connection. Fails: nothing sent; retried by the queue.
 *   2. status       — `DLE EOT` (prints nothing): offline, cover open, paper out, an error → nothing sent; the queue
 *                     waits with that reason ("אין נייר"). No answer: a printer that does not report — go on.
 *   3. sending      — the job is marked SENDING in the durable queue before the first byte: a death from here
 *                     leaves it "uncertain" (a person's), never printed a second time by itself.
 *   4. write        — the whole ticket. Cut short before any byte: nothing sent, retried. After some: uncertain.
 *   5. status again — paper ran out or the cover opened on it: uncertain. Ready: printed and confirmed.
 *
 * Pure over [PrinterLink]: every step's failure is tested with a fake link.
 */

import { COVER_OPEN, NO_PAPER, PRINTER_ERROR, PrinterNotReady, PrintUncertain } from './queue';

/** What a printer said about itself (`DLE EOT`). */
export interface PrinterReadiness {
  ready: boolean;
  /** Why not, as a queue code (no_paper, cover_open, printer_error); null when ready. */
  code: string | null;
  /** The roll is near its end (still prints): said, never a reason to hold the ticket. */
  paperLow: boolean;
}

/** A status byte's fixed bits (bit 1 and 4 set, bits 0 and 7 clear). */
export function isStatusByte(b: number): boolean {
  return (b & 0x93) === 0x12;
}

/** The readiness from the answers to `DLE EOT 1` / `2` / `4` (null: that one did not answer). Null: the printer does not report. */
export function readiness(printer: number | null, cause: number | null, paper: number | null): PrinterReadiness | null {
  if (printer === null || !isStatusByte(printer)) return null;
  const paperOk = paper !== null && isStatusByte(paper);
  const paperState = paperOk ? ((paper! & 0x60) !== 0 ? 'out' : (paper! & 0x0c) !== 0 ? 'near_end' : 'ok') : null;
  const offline = (printer & 0x08) !== 0;
  const causeOk = cause !== null && isStatusByte(cause);
  const code =
    paperState === 'out'
      ? NO_PAPER
      : causeOk && (cause! & 0x20) !== 0
        ? NO_PAPER
        : causeOk && (cause! & 0x04) !== 0
          ? COVER_OPEN
          : causeOk && (cause! & 0x40) !== 0
            ? PRINTER_ERROR
            : offline
              ? PRINTER_ERROR
              : null;
  return { ready: code === null, code, paperLow: paperState === 'near_end' };
}

/** One printer connection, as the steps use it. One link is one job. */
export interface PrinterLink {
  /** Connect. Throws when the printer cannot be reached (nothing was sent). */
  open(): Promise<void>;
  /** `DLE EOT`: null when the printer does not report its status. */
  status(): Promise<PrinterReadiness | null>;
  /** Send the whole ticket. A failure throws [PartialWrite] with how many bytes left (0: none). */
  write(bytes: Uint8Array): Promise<void>;
  /** Let the printer take the last bytes before its status is asked again. */
  settle(): Promise<void>;
  /** With no status to ask after: long enough for the last bytes to leave before the close. */
  drain(): Promise<void>;
  close(): void;
}

/** A write that failed after [written] bytes had left (0: none did). */
export class PartialWrite extends Error {
  constructor(
    readonly written: number,
    cause: unknown,
  ) {
    super(`write failed after ${written} bytes: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'PartialWrite';
  }
}

export interface DirectOutcome {
  /** The printer said it was ready before and after. */
  confirmed: boolean;
  paperLow: boolean;
}

/**
 * The five steps for one ticket. [onSending] marks the job SENDING in the durable queue (step 3). Throws:
 * [PrinterNotReady] / any error before a byte left (retryable — nothing printed), [PrintUncertain] (may be on paper).
 */
export async function printDirect(link: PrinterLink, bytes: Uint8Array, where: string, onSending: () => void | Promise<void>): Promise<DirectOutcome> {
  await link.open();
  try {
    let before: PrinterReadiness | null = null;
    try {
      before = await link.status();
    } catch {
      // A printer that drops the line on a status query: as not reporting — a dead connection is found by the write.
      before = null;
    }
    if (before !== null && !before.ready) throw new PrinterNotReady(before.code ?? PRINTER_ERROR, where);
    await onSending();
    try {
      await link.write(bytes);
    } catch (e) {
      const written = e instanceof PartialWrite ? e.written : 0;
      if (written <= 0) throw new Error(`${where} — ${e instanceof Error ? e.message : 'write failed'}`);
      throw new PrintUncertain(`${where} — cut short after ${written} of ${bytes.length} bytes`);
    }
    if (before === null) {
      await link.drain();
      return { confirmed: false, paperLow: false };
    }
    await link.settle();
    let after: PrinterReadiness | null = null;
    try {
      after = await link.status();
    } catch {
      after = null;
    }
    if (after === null) return { confirmed: false, paperLow: before.paperLow };
    if (!after.ready && (after.code === NO_PAPER || after.code === COVER_OPEN)) throw new PrintUncertain(`${where} — ${after.code} right after the ticket: it may be cut short`);
    return { confirmed: after.ready, paperLow: after.paperLow || before.paperLow };
  } finally {
    try {
      link.close();
    } catch {
      /* closed */
    }
  }
}

/**
 * Which printers never answer the status read, in memory: one silent twice running is not asked before its next
 * tickets (each ask waits out a timeout) and is asked again after ten minutes; one that answered once is always asked
 * (PrinterStatusMemory, per printer).
 */
export class PrinterStatusMemory {
  private silent = new Map<string, { times: number; since: number }>();
  private reports = new Set<string>();
  static readonly SILENT_TO_SKIP = 2;
  static readonly RECHECK_MS = 10 * 60_000;

  shouldAsk(printer: string, now: number): boolean {
    if (this.reports.has(printer)) return true;
    const s = this.silent.get(printer);
    if (!s) return true;
    return s.times < PrinterStatusMemory.SILENT_TO_SKIP || now - s.since < 0 || now - s.since >= PrinterStatusMemory.RECHECK_MS;
  }

  answered(printer: string, answered: boolean, now: number): void {
    if (answered) {
      this.reports.add(printer);
      this.silent.delete(printer);
    } else {
      const s = this.silent.get(printer);
      this.silent.set(printer, { times: (s?.times ?? 0) + 1, since: now });
    }
  }
}

/** [inner] whose status read before the ticket goes by [memory]: a printer known not to report is not asked. */
export function rememberingLink(inner: PrinterLink, memory: PrinterStatusMemory, printer: string, now: () => number = Date.now): PrinterLink {
  let asked = false;
  let skip = false;
  return {
    open: () => inner.open(),
    async status() {
      if (asked) return skip ? null : inner.status();
      asked = true;
      if (!memory.shouldAsk(printer, now())) {
        skip = true;
        return null;
      }
      const answer = await inner.status();
      memory.answered(printer, answer !== null, now());
      return answer;
    },
    write: (b) => inner.write(b),
    settle: () => inner.settle(),
    drain: () => inner.drain(),
    close: () => inner.close(),
  };
}

/** [inner] without its status read (till parameter `kitchenPrinterStatusCheck` false): sent, unconfirmed. */
export function writeOnlyLink(inner: PrinterLink): PrinterLink {
  return { ...inner, open: () => inner.open(), status: async () => null, write: (b) => inner.write(b), settle: () => inner.settle(), drain: () => inner.drain(), close: () => inner.close() };
}
