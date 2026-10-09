/**
 * The cockpit's ("הניהול שלי") rules, pure so they can be tested on their own: who may see a
 * quick action, an attention item or a card (its `gate`), and the order of the attention feed.
 *
 * A gate names the sections that open it (any of them, at the level) — the same grant the
 * server enforces on the routes the action calls (lib/dashboardAccess.ts) — and, when the
 * server also checks the role, the roles. A manager sees only what they may do.
 *
 * No React, no path aliases: `npm test` compiles this file on its own.
 */

import { canAccess, type AccessLevel, type DashboardAccess, type SectionId } from './dashboardAccess';

export interface CockpitGate {
  /** Any of these sections, at `level`. Empty: everyone signed in. */
  sections: SectionId[];
  level: AccessLevel;
  /** When the server also checks the role (the machine-admin roles for till messages…). */
  roles?: string[];
  /** Only on these days of the week (0 = Sunday … 6 = Saturday) — Saturday's stock update. */
  weekdays?: number[];
}

export const OPEN_GATE: CockpitGate = { sections: [], level: 'view' };

/** The roles that administer tills (the till-messages endpoints admit exactly these). */
export const MACHINE_ADMIN_ROLES = ['super_admin', 'distributor', 'company_manager', 'shop_manager'];

export function gateAllows(
  gate: CockpitGate,
  access: DashboardAccess,
  role: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (gate.roles && (!role || !gate.roles.includes(role))) return false;
  if (gate.weekdays && !gate.weekdays.includes(now.getDay())) return false;
  if (gate.sections.length === 0) return true;
  return gate.sections.some((section) => canAccess(access, section, gate.level));
}

/**
 * The first of `variants` (in order) whose gate the user passes, or undefined — one action whose
 * sheet depends on what the user holds (`CockpitAction.variants`).
 */
export function pickVariant<T extends { gate: CockpitGate }>(
  variants: readonly T[],
  access: DashboardAccess,
  role: string | null | undefined,
  now: Date = new Date(),
): T | undefined {
  return variants.find((v) => gateAllows(v.gate, access, role, now));
}

/**
 * "הודעה לקופות" — one button, the sheet by what the user holds (the coordinator, 09.10.2026):
 *
 * * `full`: "הודעות לקופות" at edit — the till messages' own sheet, full screen allowed
 *   (`POST /till-messages`, that section only);
 * * `banner`: only "פעולות מהירות" at edit — a banner through the quick actions
 *   (`POST /insights/quick-actions/messages`; full screen refused there without till_messages).
 *
 * Both routes also check the machine-admin roles. The button's gate is the union (`button`).
 */
export const TILL_MESSAGE_GATES: Record<'full' | 'banner' | 'button', CockpitGate> = {
  full: { sections: ['till_messages'], level: 'edit', roles: MACHINE_ADMIN_ROLES },
  banner: { sections: ['quick_actions'], level: 'edit', roles: MACHINE_ADMIN_ROLES },
  button: { sections: ['till_messages', 'quick_actions'], level: 'edit', roles: MACHINE_ADMIN_ROLES },
};

/** Those of `entries` the user may use — and, for an action, that has its sheet registered. */
export function allowedEntries<T extends { gate: CockpitGate }>(
  entries: readonly T[],
  access: DashboardAccess,
  role: string | null | undefined,
  now: Date = new Date(),
): T[] {
  return entries.filter((e) => gateAllows(e.gate, access, role, now));
}

export type AttentionSeverity = 'critical' | 'warning' | 'info';

const SEVERITY_ORDER: Record<AttentionSeverity, number> = { critical: 0, warning: 1, info: 2 };

/** The feed's order: the loudest first, then the newest, then by id (stable). */
export function sortAttention<T extends { id: string; severity: AttentionSeverity; at?: string | null }>(items: readonly T[]): T[] {
  return [...items].sort(
    (a, b) =>
      SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
      (b.at ?? '').localeCompare(a.at ?? '') ||
      a.id.localeCompare(b.id),
  );
}
