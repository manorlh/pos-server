'use client';

/**
 * Who may assign tills to an event ("שיוך קופות מהיר לאירוע"): what the server checks on
 * `PUT /report-events/{id}` and `POST /report-events/{id}/tills` — "דוחות" at edit and a managing
 * role (app/services/report_events/crud.py `WRITE_ROLES`). The shop's own access the server checks
 * per event; this only hides the buttons from who could never use them.
 */

import { useAuth } from '@/lib/auth';
import { MACHINE_ADMIN_ROLES, gateAllows, type CockpitGate } from '@/lib/cockpitGates';
import { useDashboardAccess } from '@/lib/dashboardAccessApi';

export const EVENT_TILLS_GATE: CockpitGate = { sections: ['reports'], level: 'edit', roles: MACHINE_ADMIN_ROLES };

export function useCanAssignEventTills(): boolean {
  const access = useDashboardAccess();
  const role = useAuth((s) => s.user?.role);
  return gateAllows(EVENT_TILLS_GATE, access, role);
}
