/**
 * Document numbers, exactly as the till (pos-server docs/SPEC_DOCUMENT_PREFIX.md;
 * pos-android domain/DocumentNumbers.kt, data/repo/SaleRepository.kt):
 *
 *  - printed number = the till's prefix (1–3 digits) followed at once by the number padded to 7
 *    digits — no dash: prefix 2, document 57 → "20000057"; above 9,999,999 the only form with a
 *    dash, "2-12345678", so it is never read as a padded number; no prefix → the bare number;
 *  - a separate series per document type: 320, 330 and 400 (−400 shares 400's);
 *  - each counter is saved BEFORE the number is used and never goes down:
 *    seed = max(stored ?? max(legacy, ledger of all), ledger of the series), raised by the cloud's
 *    `highestTransactionNumbers` at pairing; a rolled-back write leaves a gap, never a repeat.
 */

export const NUMBER_WIDTH = 7;
export const SEPARATOR = '-';
export const SERIES = [320, 330, 400] as const;
export type Series = (typeof SERIES)[number];

const PREFIX_RE = /^[0-9]{1,3}$/;

function clean(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t && PREFIX_RE.test(t) ? t : null;
}

/** The prefix in force: the cloud's `documentPrefix`, else the till's number (when 1–3 digits). */
export function prefixFor(cloudPrefix: string | null | undefined, posNumber: string | null | undefined): string | null {
  return clean(cloudPrefix) ?? clean(posNumber);
}

/** DocumentNumbers.format. */
export function formatDocNumber(prefix: string | null | undefined, number: string | number): string {
  const raw = String(number);
  const p = prefix?.trim() || null;
  const n = raw.trim();
  if (!p || !n || !/^\d+$/.test(n)) return raw;
  const value = n.replace(/^0+/, '') || '0';
  if (value.length > NUMBER_WIDTH) return `${p}${SEPARATOR}${value}`;
  return p + value.padStart(NUMBER_WIDTH, '0');
}

/** The series a document type numbers in. */
export function seriesOf(documentType: number): number {
  if (documentType === -400) return 400;
  return Math.abs(documentType);
}

/** The settings key of a series' counter (the till's `documentSequence.<series>`). */
export const counterKey = (series: number) => `documentSequence.${series}`;
export const LEGACY_COUNTER_KEY = 'documentSequence';

/** seriesCounterSeed: where a series' counter starts on this device. */
export function seriesCounterSeed(stored: number | null, legacy: number, ledgerAll: number, ledgerSeries: number): number {
  return Math.max(stored ?? Math.max(legacy, ledgerAll), ledgerSeries);
}

/** raisedDocumentCounter: a counter only ever goes up. */
export function raised(current: number, atLeast: number | null | undefined): number {
  return atLeast !== null && atLeast !== undefined && Number.isFinite(atLeast) && atLeast > current ? Math.trunc(atLeast) : current;
}

/** The store behind the counters: read and write one integer per key, durably. */
export interface CounterStore {
  read(key: string): number | null;
  /** Must be on disk when it returns. */
  write(key: string, value: number): void;
  /** MAX(number) of the ledger: all series, or one. */
  ledgerMax(series?: number): number;
}

/**
 * The document counters of one device. `next` writes the new value before returning it; call it
 * inside the same DB transaction that inserts the document (the in-memory value moved first, so
 * a rollback is a gap, never a repeat).
 */
export class DocumentCounters {
  private readonly current = new Map<number, number>();

  constructor(private readonly store: CounterStore) {}

  /** primeSequence: at start and after a pairing purge. */
  prime(): void {
    const legacy = this.store.read(LEGACY_COUNTER_KEY) ?? 0;
    const ledgerAll = this.store.ledgerMax();
    for (const s of SERIES) {
      const stored = this.store.read(counterKey(s));
      const seed = seriesCounterSeed(stored, legacy, ledgerAll, this.store.ledgerMax(s));
      this.current.set(s, seed);
      if (stored === null || seed > stored) this.store.write(counterKey(s), seed);
    }
  }

  /** The last number used in a series (0 = none yet). */
  last(series: number): number {
    if (!this.current.has(series)) this.prime();
    return this.current.get(series) ?? 0;
  }

  /** The next number of `documentType`'s series, saved before it is handed out. */
  next(documentType: number): number {
    const s = seriesOf(documentType);
    const n = this.last(s) + 1;
    this.current.set(s, n);
    this.store.write(counterKey(s), n);
    return n;
  }

  /** The cloud's highest numbers per series (`highestTransactionNumbers`): only ever up. */
  raise(atLeast: Partial<Record<string, number>>, highestAll?: number | null): void {
    const targets = new Map<number, number>();
    for (const s of SERIES) {
      const v = atLeast[String(s)];
      if (typeof v === 'number' && v > 0) targets.set(s, v);
      else if (highestAll && highestAll > 0 && Object.keys(atLeast).length === 0) targets.set(s, highestAll);
    }
    for (const [s, h] of targets) {
      const cur = this.last(s);
      const r = raised(cur, h);
      if (r > cur) {
        this.current.set(s, r);
        this.store.write(counterKey(s), r);
      }
    }
  }

  /** `documentCounters` for the heartbeat. */
  report(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const s of SERIES) out[String(s)] = this.last(s);
    return out;
  }
}
