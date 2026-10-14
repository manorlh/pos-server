/**
 * "הדפסה בקופה אחרת" (P:/specs/bill-print-other-till.md; pos-server app/services/remote_print.py): a bill or
 * a receipt printed on another till's printer. Pure helpers for the printers page (the receipt printer of type
 * "ענן", the parameters card) and the table card ("הדפס חשבון" on another till, §7).
 */
import type { ActionStatus, ActionView } from './liveTables';

/** The till parameters (§7א), in the order the printers page shows them. */
export const REMOTE_PRINT_KEYS = [
  'remotePrintEnabled',
  'remotePrintDocuments',
  'remotePrintFallback',
  'remotePrintTimeoutSec',
  'remotePrintNotice',
  'remotePrintHosts',
  'remotePrintFromDashboard',
  // §9ב: the drawer of the printer there — never (default) / ask / auto.
  'remotePrintDrawer',
] as const;

/** The tills a till may send documents to: their ids, separated by commas; empty — any host configured. */
export const REMOTE_PRINT_HOSTS_KEY = 'remotePrintHosts';

/** `remotePrintHosts`' value as ids (trimmed, lower-case, unique, in order). */
export function parseHostIds(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  const out: string[] = [];
  for (const part of value.split(/[,;\n]/)) {
    const id = part.trim().toLowerCase();
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

/** Ids back as the parameter's value: in the order of `order` (the shop's tills), then any other kept. */
export function serializeHostIds(ids: Iterable<string>, order: string[]): string {
  const wanted = new Set([...ids].map((id) => id.trim().toLowerCase()).filter(Boolean));
  const known = order.map((id) => id.toLowerCase()).filter((id) => wanted.has(id));
  const rest = [...wanted].filter((id) => !known.includes(id));
  return [...known, ...rest].join(',');
}

/** One till toggled in or out of the list. */
export function toggleHost(value: unknown, id: string, on: boolean, order: string[]): string {
  const ids = new Set(parseHostIds(value));
  if (on) ids.add(id.toLowerCase());
  else ids.delete(id.toLowerCase());
  return serializeHostIds(ids, order);
}

/** A till a receipt printer of type "ענן" may be hosted by: its build prints relayed documents. */
export function hostOffered(machine: { documentRelay?: boolean | null }): boolean {
  return machine.documentRelay === true;
}

/**
 * What the table card says for "הדפס חשבון" sent to print on another till ([printOnName]), from the
 * command's generic view: "נשלח להדפסה ב<קופה>…", then "הודפס ב<קופה>" (the till's answer says
 * `printed`), "לא הודפס ב<קופה> — הודפס בקופה שמחזיקה את השולחן" (`fallback: local`), or "נשלח להדפסה
 * ב<קופה>" when it did not wait for the answer; a refusal `print_target_unavailable` names that till.
 */
export function billPrintOnView(view: ActionView, status: ActionStatus | null, printOnName: string | null): ActionView {
  if (!printOnName) return view;
  const till = { till: printOnName };
  if (view.phase === 'sending' && view.key === 'sending') return { ...view, key: 'sendingPrintOn', values: till };
  if (view.phase === 'done') {
    const result = status?.result ?? {};
    if (result.printed === true) return { ...view, key: 'done.print-bill-printed', values: till };
    if (result.fallback === 'local') return { ...view, key: 'done.print-bill-local', values: till };
    return { ...view, key: 'done.print-bill-sent', values: till };
  }
  if (view.phase === 'refused' && status?.reason === 'print_target_unavailable') {
    return { ...view, key: 'refused.print_target_unavailable', values: till };
  }
  return view;
}
