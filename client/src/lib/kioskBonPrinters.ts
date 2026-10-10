/**
 * The kiosk's "מדפסת בונים" choices (pos-server docs/SPEC_KIOSK.md §16.9): each till's own
 * printer by name — "המדפסת המובנית — 2 · בר (F20/55F)", "מדפסת USB — 1 · קופה (P18)" — then
 * the shop's other kitchen printers. A till's printer that has no printer entry yet is a
 * `local:` choice: picking it makes (or reuses) the hosted entry behind it, so the owner never
 * meets a "cloud printer". Pure, pinned by kioskBonPrinters.test.ts.
 */

export type LocalConnection = 'till' | 'usb' | 'bluetooth';

/** A kitchen printer of the shop, as the printers page lists it. */
export interface BonKitchenPrinter {
  id: string;
  name: string;
  isActive: boolean;
}

/** A till's local printer (`GET /shops/{id}/till-local-printers`). */
export interface BonTillLocalPrinter {
  key: string;
  machineId: string;
  machineName: string;
  deviceModel: string | null;
  connection: LocalConnection;
  deviceName: string | null;
  /** The hosted printer entry behind it, once made. */
  printerId: string | null;
  printerActive: boolean | null;
  online?: boolean;
}

export interface BonPrinterChoice {
  /** A printer id, or `local:<machineId>:<connection>` before its entry exists. */
  value: string;
  label: string;
  /** Picking it first makes (or switches on) the hosted entry behind it. */
  local?: { machineId: string; connection: LocalConnection };
}

export interface BonChoiceLabels {
  /** "המדפסת המובנית — 2 · בר (F20/55F)". */
  local: (connection: LocalConnection, till: string, model: string | null, device: string | null) => string;
  /** "<name> (לא פעילה)". */
  inactive: (label: string) => string;
  /** A printer the config names that the shop no longer has. */
  unknown: string;
  placeholder: string;
}

/** The select's "nothing chosen yet". */
export const NONE_VALUE = '__none__';
const LOCAL_PREFIX = 'local:';
const CONNECTIONS: LocalConnection[] = ['till', 'usb', 'bluetooth'];

export function localValue(machineId: string, connection: LocalConnection): string {
  return `${LOCAL_PREFIX}${machineId}:${connection}`;
}

export function parseLocalValue(value: string | null | undefined): { machineId: string; connection: LocalConnection } | null {
  if (!value || !value.startsWith(LOCAL_PREFIX)) return null;
  const rest = value.slice(LOCAL_PREFIX.length);
  const at = rest.lastIndexOf(':');
  if (at <= 0) return null;
  const connection = rest.slice(at + 1) as LocalConnection;
  if (!CONNECTIONS.includes(connection)) return null;
  return { machineId: rest.slice(0, at), connection };
}

/**
 * The choices for [current]: the placeholder while nothing is chosen, a printer the shop no
 * longer has, the tills' own printers (their entries shown once, under the till's name), then
 * every other kitchen printer.
 */
export function bonPrinterChoices(
  kitchen: BonKitchenPrinter[],
  local: BonTillLocalPrinter[],
  current: string | null,
  labels: BonChoiceLabels,
): BonPrinterChoice[] {
  const byId = new Map(kitchen.map((p) => [p.id, p]));
  const behind = new Set(local.map((l) => l.printerId).filter((id): id is string => !!id));
  const out: BonPrinterChoice[] = [];
  if (!current) out.push({ value: NONE_VALUE, label: labels.placeholder });
  else if (!byId.has(current) && !behind.has(current)) out.push({ value: current, label: labels.unknown });
  for (const l of local) {
    const label = labels.local(l.connection, l.machineName, l.deviceModel, l.deviceName);
    const make = { machineId: l.machineId, connection: l.connection };
    if (!l.printerId) {
      out.push({ value: localValue(l.machineId, l.connection), label, local: make });
      continue;
    }
    const active = byId.get(l.printerId)?.isActive ?? l.printerActive ?? true;
    out.push(active ? { value: l.printerId, label } : { value: l.printerId, label: labels.inactive(label), local: make });
  }
  for (const p of kitchen) {
    if (behind.has(p.id)) continue;
    out.push({ value: p.id, label: p.isActive ? p.name : labels.inactive(p.name) });
  }
  return out;
}

/** What picking [value] does: set it, or first make the till's printer entry. */
export function choiceOf(choices: BonPrinterChoice[], value: string): BonPrinterChoice | undefined {
  return choices.find((c) => c.value === value);
}
