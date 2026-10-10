/**
 * The Manager Cockpit's contract for the pieces this folder exports (feat/event-live), unified
 * with the cockpit's own (components/dashboard/cockpit/types.ts) at the integration merge:
 *
 * * `CockpitScope` — the cockpit's scope keys; a page may pass null for "none" (its params);
 * * `CockpitProps` — the cockpit's `CockpitActionProps` (`{ scope, context?, onDone }`, the same
 *   context type), with `onDone` optional since the pages mount these pieces too. A cockpit
 *   sheet's props are assignable to it (checked in cockpit/event-live-slots.tsx).
 */

import type { CockpitActionContext, CockpitScope as CockpitScopeBase } from '@/components/dashboard/cockpit/types';

export type CockpitScope = { [K in keyof CockpitScopeBase]?: CockpitScopeBase[K] | null };

export interface CockpitProps {
  scope: CockpitScope;
  context?: CockpitActionContext;
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
