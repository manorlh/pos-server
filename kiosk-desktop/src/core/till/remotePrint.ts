/**
 * Another till's drawer, and this till as another till's host (P:/specs/bill-print-other-till.md §9ב–§9ג, §10 — pos-android
 * domain/RemotePrintPolicy.kt, hardware/printer/RemoteDocumentPrint.kt `remoteDrawerDestinationsOf`, `remoteFailureOf`).
 * Pure: the parameters, the cloud's `drawerHosts`, a job's answer — and a document's picture as the printer's dots.
 */

import { gunzipSync } from 'node:zlib';
import type { MonoBitmap } from '../escpos';

/** The capability a till reports on its heartbeat when it relays, prints and hosts documents (§10.1). */
export const DOCUMENT_RELAY = 'document_relay_v1';

export interface RemotePrintSettings {
  enabled: boolean;
  timeoutSec: number;
  /** The tills this one may send to (machine id or name); empty — any host the cloud set. */
  hosts: string[];
}

export const REMOTE_TIMEOUT = { DEFAULT: 20, MIN: 5, MAX: 120 } as const;

function flag(raw: unknown, d: boolean): boolean {
  const v = (raw === undefined || raw === null ? '' : String(raw)).trim().toLowerCase();
  if (v === '') return d;
  if (['true', '1', 'yes', 'on', 'כן', 'פעיל'].includes(v)) return true;
  if (['false', '0', 'no', 'off', 'לא', 'כבוי'].includes(v)) return false;
  return d;
}

/** A list parameter as the parameters pull keeps it ("[a,b]"), a JSON array, or "a,b". */
export function parameterList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((x) => String(x).trim()).filter((x) => x && x !== 'null');
  const text = (raw === undefined || raw === null ? '' : String(raw)).trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!text.trim()) return [];
  return text
    .split(/[,;\n]/)
    .map((x) => x.trim().replace(/^["']|["']$/g, '').trim())
    .filter((x) => x && x !== 'null');
}

export function remotePrintSettingsOf(params: Record<string, unknown>): RemotePrintSettings {
  const n = Number(String(params.remotePrintTimeoutSec ?? '').trim());
  const timeoutSec = Number.isFinite(n) && String(params.remotePrintTimeoutSec ?? '').trim() !== '' ? Math.min(REMOTE_TIMEOUT.MAX, Math.max(REMOTE_TIMEOUT.MIN, Math.trunc(n))) : REMOTE_TIMEOUT.DEFAULT;
  return { enabled: flag(params.remotePrintEnabled, true), timeoutSec, hosts: parameterList(params.remotePrintHosts) };
}

/** `machineId` (named `name`) is a host this till may send to: the list is empty, or names it. */
export function hostAllowed(s: RemotePrintSettings, machineId: string | null, name: string | null): boolean {
  if (s.hosts.length === 0) return true;
  const keys = new Set([machineId, name].filter((x): x is string => !!x && !!x.trim()).map((x) => x.trim().toLowerCase()));
  return s.hosts.some((h) => keys.has(h.trim().toLowerCase()));
}

/** One till whose drawer may be opened from here (`GET /sync/{m}/printers` → `drawerHosts`, §10.9). */
export interface DrawerHost {
  machineId: string;
  name: string | null;
  label: string;
  /** Its receipt printer of type cloud with the drawer — the job names it; null: the till's own. */
  printerId: string | null;
}

export function parseDrawerHosts(body: unknown): DrawerHost[] | null {
  if (!body || typeof body !== 'object') return null;
  const arr = (body as { drawerHosts?: unknown }).drawerHosts;
  if (!Array.isArray(arr)) return [];
  const out: DrawerHost[] = [];
  for (const o of arr) {
    if (!o || typeof o !== 'object') continue;
    const r = o as Record<string, unknown>;
    const id = typeof r.machineId === 'string' ? r.machineId.trim() : '';
    if (!id) continue;
    const name = typeof r.name === 'string' && r.name.trim() ? r.name : null;
    const label = typeof r.label === 'string' && r.label.trim() ? r.label : (name ?? id);
    out.push({ machineId: id, name, label, printerId: typeof r.printerId === 'string' && r.printerId.trim() ? r.printerId : null });
  }
  return out;
}

/** "פתיחת מגירה ב<קופה>" (§9ג): never this till, none while `remotePrintEnabled` is off, within `remotePrintHosts`, one per till. */
export function drawerHostsHere(hosts: readonly DrawerHost[], s: RemotePrintSettings, myMachineId: string | null): DrawerHost[] {
  if (!s.enabled) return [];
  const seen = new Set<string>();
  return hosts.filter((h) => {
    if (h.machineId === myMachineId || seen.has(h.machineId) || !hostAllowed(s, h.machineId, h.label ?? h.name)) return false;
    seen.add(h.machineId);
    return true;
  });
}

const NOT_ALLOWED = new Set([
  'remote_print_off',
  'document_not_remote',
  'host_not_allowed',
  'printer_not_document',
  'printer_inactive',
  'printer_has_no_host',
  'host_not_found',
  'host_is_sender',
  'target_not_printer_host',
  'drawer_remote_off',
]);

/** Why another till's drawer did not open, in words (the host's code, or the cloud's refusal) — Android remote_print_why_*. */
export function remoteWhy(reason: string | null | undefined): string {
  const r = (reason ?? '').trim().toLowerCase();
  if (r.startsWith('no_drawer') || r === 'printer_has_no_drawer' || r === 'host_has_no_drawer') return 'אין מגירה במדפסת שם';
  if (r.startsWith('busy_payment')) return 'הקופה ההיא באמצע תשלום';
  if (r.startsWith('no_paper') || r.includes('paper')) return 'אין נייר במדפסת';
  if (r.startsWith('cover_open') || r.includes('cover')) return 'מכסה המדפסת פתוח';
  if (r.startsWith('no_printer')) return 'אין שם מדפסת';
  if (r === 'timeout' || r === 'expired') return 'לא הודפס בזמן';
  if (r === 'not_sent') return 'הקופה לא הושגה';
  if (r === 'host_needs_update') return 'בקופה ההיא נדרש עדכון גרסה';
  if (r === 'too_large' || r === 'document_too_large') return 'המסמך גדול מדי';
  if (NOT_ALLOWED.has(r)) return 'ההגדרות לא מאפשרות להדפיס שם';
  if (r.startsWith('printer_error')) return 'תקלה במדפסת';
  return 'תקלה';
}

export const REMOTE_TEXT = {
  dest: (label: string) => `המגירה ב${label}`,
  which: 'באיזו קופה לפתוח את המגירה?',
  opened: (label: string) => `המגירה נפתחה ב${label}`,
  failed: (label: string, why: string) => `המגירה לא נפתחה ב${label}: ${why}`,
  none: 'אין קופה עם מגירה שאפשר לפתוח מכאן',
  menu: (label: string) => `פתיחת מגירה ב${label}`,
  menuAny: 'פתיחת מגירה בקופה אחרת',
  /** On the host: "המגירה נפתחה מ<קופה> (<עובד>)". */
  hostOpened: (source: string, by: string | null) => (by ? `המגירה נפתחה מ${source} (${by})` : `המגירה נפתחה מ${source}`),
} as const;

/** A job past its `expiresAt`, or older than the sender's `timeoutSec`: the sender moved on (never opened / printed). */
export function jobExpired(job: { createdAt?: string | null; expiresAt?: string | null; timeoutSec?: number | null }, nowMs: number): boolean {
  const exp = job.expiresAt ? Date.parse(job.expiresAt) : NaN;
  if (Number.isFinite(exp) && nowMs > exp) return true;
  const created = job.createdAt ? Date.parse(job.createdAt) : NaN;
  if (Number.isFinite(created) && typeof job.timeoutSec === 'number' && job.timeoutSec > 0 && nowMs > created + job.timeoutSec * 1000) return true;
  return false;
}

/**
 * A document's `raster_gzip` picture (§10.3): rows of ceil(widthDots / 8) bytes, the leftmost dot in the top bit, 1 = print,
 * gzip — exactly that size, or null.
 */
export function rasterOfGzip(b64: string, widthDots: number, heightDots: number): MonoBitmap | null {
  if (!Number.isInteger(widthDots) || !Number.isInteger(heightDots) || widthDots < 8 || widthDots > 1024 || heightDots < 1 || heightDots > 30000) return null;
  let raw: Buffer;
  try {
    raw = gunzipSync(Buffer.from(b64, 'base64'));
  } catch {
    return null;
  }
  const rowBytes = Math.ceil(widthDots / 8);
  if (raw.length !== rowBytes * heightDots) return null;
  return { width: widthDots, height: heightDots, rowBytes, data: new Uint8Array(raw) };
}
