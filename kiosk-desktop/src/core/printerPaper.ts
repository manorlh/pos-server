/**
 * The receipt printer's state for the cloud and the staff (pos-server app/services/machine_health.py
 * `apply_printer_block`, app/services/exception_alerts/status_watch.py `PRINTER_WORDS`; pos-android
 * PrinterStatusTracker): the heartbeat's `printer` block speaks the cloud's words — `ok` / `no_paper` /
 * `overheated` / `error` / `unavailable` / `unknown` — so a till with an open shift whose printer has had no
 * paper for some minutes reaches the manager as "אין נייר במדפסת", from Windows as from Android.
 *
 * The queue's look (main/printer/printQueue.ts `health()`) is the newest of: the last print that went
 * through, the last that failed, and the last status probe (`DLE EOT` on a network printer, the spooler's
 * word on a USB one) — so an empty roll is known before the next receipt fails.
 *
 * Pure.
 */

export type PrinterLook = 'ok' | 'no_paper' | 'paper_low' | 'cover_open' | 'offline' | 'error' | 'unavailable' | 'unknown';

/** The cloud's printer statuses (pos_machines.PRINTER_STATUSES). */
export type CloudPrinterStatus = 'ok' | 'no_paper' | 'overheated' | 'error' | 'unavailable' | 'unknown';

/** What the heartbeat says about a look: the status, and the words when the status alone does not tell. */
export function cloudPrinterOf(look: PrinterLook): { status: CloudPrinterStatus; message?: string } {
  switch (look) {
    case 'ok':
    case 'no_paper':
    case 'error':
    case 'unavailable':
    case 'unknown':
      return { status: look };
    // The roll is near its end: still printing — no fault, but said.
    case 'paper_low':
      return { status: 'ok', message: PAPER_LOW_TEXT };
    case 'cover_open':
      return { status: 'error', message: 'מכסה המדפסת פתוח' };
    case 'offline':
      return { status: 'error', message: 'המדפסת במצב לא מקוון' };
  }
}

export const PAPER_OUT_TEXT = 'אין נייר במדפסת הקבלות — יש להחליף גליל נייר';
export const PAPER_LOW_TEXT = 'הנייר במדפסת עומד להיגמר';

/** The staff's banner for a look: paper out (urgent) — null for every other state. */
export function paperBannerOf(look: PrinterLook): string | null {
  return look === 'no_paper' ? PAPER_OUT_TEXT : null;
}

/** One observation of the printer: when, and what it showed. */
export interface PrinterSeen {
  at: number;
  look: PrinterLook;
}

/**
 * The look now: the newest observation wins (a print that went through after the paper ran out says it is back;
 * a probe after the last print says the roll is out). A probe that could not tell (`unknown`) never overrides.
 */
export function currentLook(seen: ReadonlyArray<PrinterSeen | null | undefined>): PrinterLook {
  let best: PrinterSeen | null = null;
  for (const s of seen) {
    if (!s || s.look === 'unknown') continue;
    if (!best || s.at >= best.at) best = s;
  }
  return best ? best.look : 'unknown';
}

/** How often an idle queue asks its printer how it is. */
export const PROBE_EVERY_MS = 60_000;
