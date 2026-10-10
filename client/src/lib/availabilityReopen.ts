/**
 * "פתיחת פריטים אוטומטית אחרי Z" and "חסימה קבועה" (pos-server docs/SPEC_AVAILABILITY.md).
 *
 * The rule itself — which locks a Z reopens — is the server's
 * (app/services/availability_reopen.py). What lives here is what the dashboard shows and
 * sends: the setting at one level with what it inherits, the PATCH for a choice, and how a
 * lock and a logged run read.
 */

export const AUTO_REOPEN_MODES = ['off', 'day', 'all'] as const;
export type AutoReopenMode = (typeof AUTO_REOPEN_MODES)[number];
/** Nothing set at any level: nothing is reopened. */
export const AUTO_REOPEN_DEFAULT: AutoReopenMode = 'off';

/** The form's choice at one level: a mode, or "inherit" (nothing set here). */
export type AutoReopenChoice = AutoReopenMode | 'inherit';
/** "Ignore stock" at one level: on, off, or inherit. */
export type IgnoreStockChoice = 'on' | 'off' | 'inherit';

export const SETTING_MODE = 'autoReopenAfterZ';
export const SETTING_IGNORE_STOCK = 'autoReopenIgnoreStock';

export function parseAutoReopenMode(value: unknown): AutoReopenMode | null {
  return typeof value === 'string' && (AUTO_REOPEN_MODES as readonly string[]).includes(value)
    ? (value as AutoReopenMode)
    : null;
}

/** The layer's own value as the form shows it. */
export function choiceOf(own: unknown): AutoReopenChoice {
  return parseAutoReopenMode(own) ?? 'inherit';
}

export function ignoreStockChoiceOf(own: unknown): IgnoreStockChoice {
  return own === true ? 'on' : own === false ? 'off' : 'inherit';
}

/**
 * What the level ends up with: its own value, else what it inherits, else the default —
 * and where that came from.
 */
export function effectiveMode(
  choice: AutoReopenChoice,
  inherited: unknown,
): { mode: AutoReopenMode; from: 'own' | 'inherited' | 'default' } {
  if (choice !== 'inherit') return { mode: choice, from: 'own' };
  const up = parseAutoReopenMode(inherited);
  return up ? { mode: up, from: 'inherited' } : { mode: AUTO_REOPEN_DEFAULT, from: 'default' };
}

export function effectiveIgnoreStock(choice: IgnoreStockChoice, inherited: unknown): boolean {
  if (choice === 'on') return true;
  if (choice === 'off') return false;
  return inherited === true;
}

/**
 * The PATCH body for a level: only the keys that changed, `null` for "inherit" (the server
 * removes the key from this layer). Empty when nothing changed.
 */
export function autoReopenPatch(
  stored: { autoReopenAfterZ?: unknown; autoReopenIgnoreStock?: unknown },
  choice: AutoReopenChoice,
  ignoreStock: IgnoreStockChoice,
): { autoReopenAfterZ?: AutoReopenMode | null; autoReopenIgnoreStock?: boolean | null } {
  const out: { autoReopenAfterZ?: AutoReopenMode | null; autoReopenIgnoreStock?: boolean | null } = {};
  if (choice !== choiceOf(stored.autoReopenAfterZ)) {
    out.autoReopenAfterZ = choice === 'inherit' ? null : choice;
  }
  if (ignoreStock !== ignoreStockChoiceOf(stored.autoReopenIgnoreStock)) {
    out.autoReopenIgnoreStock = ignoreStock === 'inherit' ? null : ignoreStock === 'on';
  }
  return out;
}

/** The levels a Z reopens; a company's lock and the product's own flag are never reopened. */
export const REOPENABLE_LEVELS = ['shop', 'area', 'machine'] as const;

export function isReopenableLevel(level: string): boolean {
  return (REOPENABLE_LEVELS as readonly string[]).includes(level);
}

/**
 * How a level's own lock reads: `null` when the level sets no lock (or one no Z reopens);
 * else temporary or permanent ("חסימה קבועה").
 */
export function lockKind(
  level: string,
  node: { value: boolean | null; permanent?: boolean },
): 'temporary' | 'permanent' | null {
  if (node.value !== false || !isReopenableLevel(level)) return null;
  return node.permanent ? 'permanent' : 'temporary';
}

// ── The log: `GET /availability/reopens` ─────────────────────────────────────

export interface AvailabilityReopenItem {
  kind: 'product' | 'category';
  itemId: string;
  name: string | null;
  /** `kept_stock`: tracks stock and had none, so it stayed closed. */
  outcome: 'reopened' | 'kept_stock';
  blockedAt: string | null;
}

export interface AvailabilityReopenRun {
  zReportId: string;
  zNumber: number | null;
  zOrigin: string | null;
  level: 'shop' | 'area' | 'machine';
  targetId: string;
  targetName: string;
  closedAt: string;
  mode: 'day' | 'all';
  ignoreStock: boolean;
  reopenedCount: number;
  keptCount: number;
  items: AvailabilityReopenItem[];
}

/** The names of a run's items, reopened first, each group by name. */
export function runItemNames(run: AvailabilityReopenRun): { reopened: string[]; kept: string[] } {
  const name = (i: AvailabilityReopenItem) => i.name ?? i.itemId.slice(0, 8);
  const sorted = (xs: AvailabilityReopenItem[]) => xs.map(name).sort((a, b) => a.localeCompare(b, 'he'));
  return {
    reopened: sorted(run.items.filter((i) => i.outcome === 'reopened')),
    kept: sorted(run.items.filter((i) => i.outcome === 'kept_stock')),
  };
}
