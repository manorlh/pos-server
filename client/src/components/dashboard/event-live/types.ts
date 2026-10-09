/**
 * The Manager Cockpit's contract for the pieces this folder exports (feat/event-live). Defined
 * here; the cockpit unifies it with its own at merge.
 */

export interface CockpitScope {
  companyId?: string | null;
  shopId?: string | null;
  areaId?: string | null;
  machineId?: string | null;
  eventId?: string | null;
}

export interface CockpitProps {
  scope: CockpitScope;
  context?: Record<string, unknown>;
  /** Called when the piece finished what it was opened for (closed, saved…). */
  onDone?: () => void;
}

/** One line of the cockpit's attention feed (`useAlertItems`). */
export interface AlertAction {
  /** A message key the cockpit translates (namespace `phoneAlerts`). */
  labelKey: string;
  /** `ack` (handled in place by the hook), `open` (navigate to `context.href`). */
  actionId: 'ack' | 'open';
  context: Record<string, unknown>;
}

export interface AlertItem {
  id: string;
  severity: 'low' | 'medium' | 'high';
  title: string;
  body: string;
  /** ISO time the alert happened. */
  at: string;
  actions: AlertAction[];
}
