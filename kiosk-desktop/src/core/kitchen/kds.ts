/**
 * "תצורת עבודה ו-KDS" as a Windows till reads it — the port of pos-android domain/KdsWorkflow.kt
 * (`KdsWorkflowConfig.of`) and the parts of ui/kds/KdsOutbox.kt / KdsBridge.kt a counter sale needs
 * (pos-server docs/SPEC_KDS.md):
 *
 *  - `kdsEnabled`: a paid sale is reported to the cloud's kitchen engine (`POST /sync/{m}/kds/release`, source
 *    `quick`, its id from the document — one release however often it is sent);
 *  - the tickets still print as they always did unless the KDS is the only target ("KDS only"): then they wait HELD
 *    and print by themselves when the KDS did not get the order in time (`workflowPrinterFallback`, on by default),
 *    or are shown to a person (off).
 *
 * Off (the default) is exactly the till as it was: no call, tickets as before. Pure.
 */

export interface KdsWorkflow {
  enabled: boolean;
  targets: string[];
  printerFallback: boolean;
  /** The till reports its orders to the cloud's kitchen engine. */
  reportsOrders: boolean;
  /** The kitchen tickets print as they always did. */
  printsTickets: boolean;
  /** KDS only, and the KDS cannot be reached: print on the printers, flagged. */
  printsOnFallback: boolean;
}

const TARGETS = ['printer', 'kds', 'kds_view', 'expo', 'pickup_screen'];
const KDS_TARGETS = new Set(['kds', 'kds_view']);

function flag(v: unknown, dflt: boolean): boolean {
  if (typeof v === 'boolean') return v;
  const s = typeof v === 'string' ? v.trim().toLowerCase() : typeof v === 'number' ? String(v) : '';
  if (['true', '1', 'yes', 'on', 'כן'].includes(s)) return true;
  if (['false', '0', 'no', 'off', 'לא'].includes(s)) return false;
  return dflt;
}

function csv(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v !== 'string') return [];
  return v
    .split(',')
    .map((x) => x.trim().replace(/^[[\]"\s]+|[[\]"\s]+$/g, ''))
    .filter(Boolean);
}

export function kdsWorkflowOf(params: Record<string, unknown>): KdsWorkflow {
  const enabled = flag(params.kdsEnabled, false);
  if (!enabled) return { enabled: false, targets: ['printer'], printerFallback: true, reportsOrders: false, printsTickets: true, printsOnFallback: false };
  const t = csv(params.workflowTargets).filter((x) => TARGETS.includes(x));
  const targets = t.length > 0 ? [...new Set(t)] : ['printer'];
  const printerFallback = flag(params.workflowPrinterFallback, true);
  const printsTickets = targets.includes('printer') || !targets.some((x) => KDS_TARGETS.has(x));
  return { enabled, targets, printerFallback, reportsOrders: true, printsTickets, printsOnFallback: printerFallback && !printsTickets };
}

/** The KDS got the order: taken (true), refused / not taken (false), not answered (null) — KdsOutbox.taken. */
export function kdsTaken(body: Record<string, unknown>, reply: { kind: 'ok'; body: unknown } | { kind: 'refused' } | { kind: 'offline' }): boolean | null {
  if (reply.kind === 'offline') return null;
  if (reply.kind === 'refused') return false;
  const b = reply.body && typeof reply.body === 'object' ? (reply.body as Record<string, unknown>) : {};
  const items = Array.isArray(body.items) && body.items.length > 0;
  const accepted = !('accepted' in b) || b.accepted !== false;
  return accepted && !(items && b.noTasks === true);
}

/** A KDS-only shop's fallback hold of a release ("hold:kds:<releaseId>"). */
export function kdsHoldOf(releaseId: string): string {
  return `hold:kds:${releaseId}`;
}

/** Not delivered in this long with the fallback on: printed on the printers (KdsOutbox.FALLBACK_AFTER_MS). */
export const KDS_FALLBACK_AFTER_MS = 8_000;
/** With the fallback off: shown to a person after this long (KdsOutbox.VISIBLE_AFTER_MS). */
export const KDS_VISIBLE_AFTER_MS = 45_000;
