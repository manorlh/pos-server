/**
 * "מדפסת חלופית" — a kitchen ticket whose printer does not print, sent to another printer by a person, and "the next ones
 * too" for a while (pos-android hardware/kitchen/KitchenFailover.kt, ui/kitchen/PrinterFailoverHost.kt, KitchenPrintBanner.kt,
 * strings_discovery.xml / strings_kitchen.xml; P:/specs/bon-delivery-audit.md):
 *
 *  - the till asks — the oldest ticket that needs a person first, one at a time — once a try failed (`attempts ≥ 1`), never
 *    for a test page, never for a ticket handed to a host or printed here for another device, and not again for a ticket the
 *    person left in the queue ("השאר בתור") until it fails again;
 *  - the candidates: every printer this till reaches but the failed one (one per physical device), the kitchen's first, then
 *    the receipt printers, then the till's own; the ones not answering last;
 *  - "לשלוח לשם גם את הבאים (15 דק׳)": a temporary redirect of that printer's tickets — in memory only, ended by its time,
 *    by "בטל הפניה", or by the printer answering again (looked at every 30 s);
 *  - each move is logged to the cloud (`POST /sync/{m}/print-redirects`), shown on the dashboard's printers page;
 *  - on Android the question and the red strip show only where `unprintedBonAlert` is on (off by default); the prompt itself
 *    is `printerFailoverPrompt` (on unless false).
 *
 * Pure.
 */

import type { KitchenPrinter } from './config';
import type { KitchenJob } from './queue';
import { connectionOf, TILL_PRINTER_ID } from './routing';

export const FAILOVER_PARAM = 'printerFailoverPrompt';
export const BON_ALERT_PARAM = 'unprintedBonAlert';
export const TEMP_REDIRECT_MS = 15 * 60_000;
export const RECHECK_MS = 30_000;

/** `printerFailoverPrompt`: on unless false / 0 / off / no. */
export function failoverEnabled(raw: unknown): boolean {
  if (raw === false || raw === 0) return false;
  return !['false', '0', 'off', 'no'].includes(String(raw ?? '').trim().toLowerCase());
}

/** `unprintedBonAlert`: off unless true. */
export function bonAlertOn(raw: unknown): boolean {
  return raw === true || ['true', '1', 'yes', 'on', 'כן'].includes(String(raw ?? '').trim().toLowerCase());
}

/** Waits here and may go elsewhere: pending or failed, not handled, never another device's (relayed / over the LAN). */
export function mayRedirect(job: KitchenJob): boolean {
  return job.dismissed === 0 && (job.state === 'pending' || job.state === 'failed') && job.relayJobId === null && job.lanOrigin === 0;
}

/** The person is asked about [job] now. [answered]: what each job's last question was answered at (its attempts). */
export function shouldAsk(job: KitchenJob, enabled: boolean, answered: ReadonlyMap<string, number>): boolean {
  return enabled && job.kind !== 'test' && job.attempts >= 1 && mayRedirect(job) && (answered.get(job.id) ?? -1) < job.attempts;
}

/** One physical printer, however many entries name it. */
export function deviceKey(p: KitchenPrinter): string {
  const c = connectionOf(p) ?? p.type;
  if (c === 'network') return `net:${(p.host ?? '').trim().toLowerCase()}:${p.port ?? 9100}`;
  if (c === 'bluetooth') return p.btAddress ? `bt:${p.btAddress.toUpperCase()}` : `id:${p.id}`;
  if (c === 'usb') return 'usb';
  if (c === 'till') return 'till';
  return `id:${p.id}`;
}

export type Light = 'ok' | 'warn' | 'error' | null;

/** The printers a failed ticket may go to: kitchen first, receipt printers, the till's own last; not answering at the end. */
export function candidates(failed: KitchenPrinter, all: readonly KitchenPrinter[], health: ReadonlyMap<string, Light>): Array<{ printer: KitchenPrinter; light: Light }> {
  const group = (p: KitchenPrinter) => (p.id === TILL_PRINTER_ID || p.type === 'till' ? 2 : p.purpose === 'receipt' ? 1 : 0);
  const seen = new Set([deviceKey(failed)]);
  const out: Array<{ printer: KitchenPrinter; light: Light }> = [];
  const sorted = all.map((p, i) => ({ p, i })).sort((a, b) => group(a.p) - group(b.p) || a.i - b.i);
  for (const { p } of sorted) {
    if (p.id === failed.id || seen.has(deviceKey(p))) continue;
    seen.add(deviceKey(p));
    out.push({ printer: p, light: health.get(p.id) ?? null });
  }
  return out.map((c, i) => ({ c, i })).sort((a, b) => (a.c.light === 'error' ? 1 : 0) - (b.c.light === 'error' ? 1 : 0) || a.i - b.i).map((x) => x.c);
}

/** "The next ones too": a printer's tickets to another, until [until]. */
export interface TempRedirect {
  fromId: string;
  fromName: string;
  toId: string;
  toName: string;
  until: number;
}

export const activeRedirects = (rs: readonly TempRedirect[], now: number) => rs.filter((r) => r.until > now);
export const redirectFor = (id: string, rs: readonly TempRedirect[], now: number) => rs.find((r) => r.fromId === id && r.until > now) ?? null;
/** A new redirect replaces that printer's, and drops the ended ones. */
export const withRedirect = (rs: readonly TempRedirect[], r: TempRedirect, now: number) => [...activeRedirects(rs.filter((x) => x.fromId !== r.fromId), now), r];
export const clearedRedirects = (rs: readonly TempRedirect[], fromId: string) => rs.filter((r) => r.fromId !== fromId);

/** A ticket's title as the question names it ("שולחן 12", "מכירה #57", "בדיקת מדפסת", "בון"). */
export function ticketTitleOf(job: Pick<KitchenJob, 'kind' | 'ticketJson'>): string {
  if (job.kind === 'test') return FAILOVER_TEXT.testTicket;
  try {
    const t = JSON.parse(job.ticketJson) as { tableName?: string | null; orderRef?: string | null };
    if (t.tableName) return `שולחן ${t.tableName}`;
    if (t.orderRef) return `מכירה #${t.orderRef}`;
  } catch {
    /* the ticket's own trouble */
  }
  return FAILOVER_TEXT.bon;
}

const two = (n: number) => String(n).padStart(2, '0');
export const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${two(d.getHours())}:${two(d.getMinutes())}`;
};

/** The redirect log's body (PrintRedirectLog). */
export function redirectLog(o: {
  id: string;
  kind: 'kitchen' | 'receipt';
  from: { id: string; name: string };
  to: { id: string; name: string };
  ticket: string | null;
  error: string | null;
  temporaryUntil: number | null;
  user: { id: string; name: string } | null;
  at: number;
}): Record<string, unknown> {
  const own = (id: string) => (id === TILL_PRINTER_ID || id === 'local' ? null : id);
  return {
    id: o.id,
    kind: o.kind,
    fromPrinterId: own(o.from.id),
    fromName: o.from.name,
    toPrinterId: own(o.to.id),
    toName: o.to.name,
    ticket: o.ticket,
    error: o.error ? o.error.slice(0, 500) : null,
    temporaryUntil: o.temporaryUntil !== null ? new Date(o.temporaryUntil).toISOString() : null,
    posUserId: o.user?.id ?? null,
    posUserName: o.user?.name ?? null,
    occurredAt: new Date(o.at).toISOString(),
  };
}

/** Android's words. */
export const FAILOVER_TEXT = {
  title: (name: string) => `המדפסת «${name}» לא זמינה`,
  error: (e: string) => `תקלה: ${e}`,
  body: 'לשלוח את הבון ל…',
  none: 'אין מדפסת אחרת שהקופה מגיעה אליה.',
  ownPrinter: 'המדפסת של הקופה',
  light: { ok: 'תקינה', warn: 'בדרך עקיפה', error: 'לא מגיבה', none: 'לא נבדקה' },
  alsoNext: 'לשלוח לשם גם את הבאים (15 דק׳)',
  keep: 'השאר בתור',
  retry: 'נסה שוב',
  busy: 'הבון מודפס ממש עכשיו — רגע, ונסו שוב.',
  chip: (from: string, to: string, until: string) => `«${from}» נשלחת ל«${to}» עד ${until}`,
  endRedirect: 'בטל הפניה',
  testTicket: 'בדיקת מדפסת',
  bon: 'בון',
  bannerOne: 'בון לא הודפס במדפסת מטבח — לחצו לטיפול',
  bannerMany: (n: number) => `בון לא הודפס במדפסת מטבח — ${n} ממתינים`,
  queueTitle: 'תור הדפסה',
  moveOther: 'העבר למדפסת אחרת',
  pickPrinter: 'בחרו מדפסת',
  noOther: 'אין מדפסת אחרת לקופה הזו',
  moved: (name: string) => `הועבר ל${name}`,
  printAgain: 'הדפס שוב',
  sentAgain: 'נשלח שוב להדפסה',
  markHandled: 'סמן כטופל',
  handledBody: (title: string, printer: string) => `סימון כטופל: ${title} · ${printer}`,
  waiting: 'ממתינים',
  notPrinted: 'לא הודפסו',
  empty: 'אין בונים בתור',
  close: 'סגור',
} as const;
