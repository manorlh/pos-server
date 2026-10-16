/**
 * "תפקידים והרשאות" for till users — the pure half of the roles page
 * (docs/SPEC_ROLES_PERMISSIONS.md): the catalogue's shapes, the tri-state cycle, the
 * matrix draft and what a save sends, and the audit's one-line summaries.
 *
 * A role row keeps only what it sets itself; everything else comes from its template
 * (its built-in key, or the built-in a custom role was created from). So a save sends,
 * per role, only the cells that differ from the template — "reset to the spec's
 * defaults" is then simply an empty role, and a permission added to the catalogue later
 * reaches every role through its template.
 */

export type PermState = 'allow' | 'approval' | 'deny';

export const PERM_STATES: PermState[] = ['allow', 'approval', 'deny'];

/**
 * "כשאין הרשאה" (P:/specs/denied-actions-ui.md): what the till does with an option the role denies —
 * show (today: shown, a tap says "אין הרשאה"), hide, or code (a manager's code, as "דורש אישור מנהל").
 * Per role and per employee; null / '' = inherit (the employee → the role → the level's `deniedActionUi`).
 */
export type DeniedUi = 'show' | 'hide' | 'code';

export const DENIED_UI: DeniedUi[] = ['show', 'hide', 'code'];

export function isDeniedUi(value: unknown): value is DeniedUi {
  return typeof value === 'string' && (DENIED_UI as string[]).includes(value);
}

export interface CatalogueLimit {
  key: string;
  label: string;
  unit: 'percent' | 'amount';
  min: number;
  max: number;
}

export interface CataloguePermission {
  code: string;
  label: string;
  group: string;
  description: string;
  devices: string[];
  scope: string | null;
  limits: CatalogueLimit[];
}

export type LimitMap = Record<string, Record<string, number>>;

export interface CatalogueBuiltinRole {
  key: string;
  name: string;
  description: string;
  legacy: boolean;
  permissions: Record<string, PermState>;
  limits: LimitMap;
}

export interface PermissionCatalogue {
  states: { key: PermState; label: string }[];
  devices: { key: string; label: string }[];
  groups: { key: string; label: string }[];
  permissions: CataloguePermission[];
  builtinRoles: CatalogueBuiltinRole[];
  specRoleKeys: string[];
  /** "כשאין הרשאה": the options and the codes it never touches (absent from an older server). */
  deniedUi?: { options: { key: DeniedUi; label: string }[]; untouched: string[] };
}

export interface TillRole {
  id: string;
  companyId: string;
  builtinKey: string | null;
  baseKey: string | null;
  builtin: boolean;
  legacy: boolean;
  name: string;
  description: string | null;
  sortOrder: number;
  own: { permissions: Record<string, PermState>; limits: LimitMap };
  permissions: Record<string, PermState>;
  limits: LimitMap;
  legacyRole: 'cashier' | 'shop_manager';
  users: number;
  updatedAt: string | null;
  /** "כשאין הרשאה" — the role's own; null = as the level says. */
  deniedUi?: DeniedUi | null;
}

export interface TillRolesResponse {
  companyId: string;
  roles: TillRole[];
  canEdit: boolean;
  applied?: { resetRoles: string[]; movedUsers: number };
}

export interface TillRoleUser {
  id: string;
  shopId: string;
  shopName: string | null;
  username: string;
  firstName: string | null;
  lastName: string | null;
  isActive: boolean;
  role: 'cashier' | 'shop_manager';
  tillRoleId: string | null;
  tillRoleName: string | null;
  overrides: { states?: Record<string, PermState>; limits?: LimitMap; deniedUi?: DeniedUi } | null;
  permissions: Record<string, PermState>;
  limits: LimitMap;
  /** "כשאין הרשאה" as this employee gets it (their own, else their role's); null = as the level says. */
  deniedUi?: DeniedUi | null;
  deniedUiSource?: 'override' | 'role' | null;
}

export interface TillRoleChange {
  id: string;
  action: 'create' | 'update' | 'delete' | 'assign' | 'overrides' | 'apply_defaults' | string;
  roleId: string | null;
  roleName: string | null;
  posUserId: string | null;
  posUserName: string | null;
  oldValue: unknown;
  newValue: unknown;
  userEmail: string | null;
  userRole: string | null;
  createdAt: string | null;
}

/** allow → approval → deny → allow: one tap per step on a matrix cell. */
export function nextState(state: PermState): PermState {
  const i = PERM_STATES.indexOf(state);
  return PERM_STATES[(i + 1) % PERM_STATES.length];
}

export function isPermState(value: unknown): value is PermState {
  return typeof value === 'string' && (PERM_STATES as string[]).includes(value);
}

/**
 * The one kind of device a permission is for, when it is for one only — "Windows" for
 * `DESKTOP_EXIT` (יציאה לשולחן העבודה): the matrix says so under its name. Null otherwise.
 */
export function onlyDeviceLabel(
  permission: Pick<CataloguePermission, 'devices'>,
  catalogue: Pick<PermissionCatalogue, 'devices'>,
): string | null {
  if (permission.devices.length !== 1) return null;
  return catalogue.devices.find((d) => d.key === permission.devices[0])?.label ?? null;
}

/** The catalogue's permissions under their groups, in the catalogue's order. */
export function groupPermissions(
  catalogue: Pick<PermissionCatalogue, 'groups' | 'permissions'>,
): { key: string; label: string; permissions: CataloguePermission[] }[] {
  return catalogue.groups
    .map((g) => ({ ...g, permissions: catalogue.permissions.filter((p) => p.group === g.key) }))
    .filter((g) => g.permissions.length > 0);
}

/** The built-in whose defaults fill what `role` does not set itself. */
export function templateKeyOf(role: Pick<TillRole, 'builtinKey' | 'baseKey'>, catalogue: PermissionCatalogue): string {
  const keys = new Set(catalogue.builtinRoles.map((r) => r.key));
  if (role.builtinKey && keys.has(role.builtinKey)) return role.builtinKey;
  if (role.baseKey && keys.has(role.baseKey)) return role.baseKey;
  return 'cashier';
}

export function templateOf(
  role: Pick<TillRole, 'builtinKey' | 'baseKey'>,
  catalogue: PermissionCatalogue,
): CatalogueBuiltinRole | undefined {
  const key = templateKeyOf(role, catalogue);
  return catalogue.builtinRoles.find((r) => r.key === key);
}

export interface MatrixDraft {
  /** roleId → code → state, as the editor shows it now. */
  states: Record<string, Record<string, PermState>>;
  /** roleId → code → limit key → value (null: no limit). */
  limits: Record<string, Record<string, Record<string, number | null>>>;
  /** roleId → "כשאין הרשאה" (null: as the level says), the matrix's first row. */
  deniedUi?: Record<string, DeniedUi | null>;
}

/** The editor's starting point: every role's effective matrix. */
export function draftFromRoles(roles: TillRole[]): MatrixDraft {
  const states: MatrixDraft['states'] = {};
  const limits: MatrixDraft['limits'] = {};
  const deniedUi: Record<string, DeniedUi | null> = {};
  for (const r of roles) {
    states[r.id] = { ...r.permissions };
    limits[r.id] = {};
    for (const [code, values] of Object.entries(r.limits ?? {})) limits[r.id][code] = { ...values };
    deniedUi[r.id] = r.deniedUi ?? null;
  }
  return { states, limits, deniedUi };
}

/** "כשאין הרשאה" for one role in the draft (null: as the level says). */
export function setDeniedUi(draft: MatrixDraft, roleId: string, value: DeniedUi | null): MatrixDraft {
  return { ...draft, deniedUi: { ...(draft.deniedUi ?? {}), [roleId]: value } };
}

/** Did the draft change this role's "כשאין הרשאה"? */
export function deniedUiChanged(role: TillRole, draft: MatrixDraft): boolean {
  if (!draft.deniedUi || !(role.id in draft.deniedUi)) return false;
  return (draft.deniedUi[role.id] ?? null) !== (role.deniedUi ?? null);
}

export function setCell(draft: MatrixDraft, roleId: string, code: string, state: PermState): MatrixDraft {
  return { ...draft, states: { ...draft.states, [roleId]: { ...(draft.states[roleId] ?? {}), [code]: state } } };
}

export function setLimit(
  draft: MatrixDraft,
  roleId: string,
  code: string,
  key: string,
  value: number | null,
): MatrixDraft {
  const role = draft.limits[roleId] ?? {};
  return {
    ...draft,
    limits: { ...draft.limits, [roleId]: { ...role, [code]: { ...(role[code] ?? {}), [key]: value } } },
  };
}

/** Parse what was typed into a limit box: blank → no limit; otherwise a number in range or `undefined` (invalid). */
export function parseLimit(text: string, limit: Pick<CatalogueLimit, 'min' | 'max'>): number | null | undefined {
  const t = text.trim();
  if (t === '') return null;
  const n = Number(t.replace(',', '.'));
  if (!Number.isFinite(n) || n < limit.min || n > limit.max) return undefined;
  return n;
}

export interface MatrixSaveRole {
  id: string;
  permissions: Record<string, PermState>;
  limits: Record<string, Record<string, number | null>>;
  /** Sent only when changed: show | hide | code, or null to inherit again. */
  deniedUi?: DeniedUi | null;
}

/**
 * What a save sends for each role the draft changed: the role's own values — only the
 * cells that differ from its template. Roles whose effective matrix did not change are
 * left out.
 */
export function matrixPayload(
  roles: TillRole[],
  draft: MatrixDraft,
  catalogue: PermissionCatalogue,
): MatrixSaveRole[] {
  const out: MatrixSaveRole[] = [];
  for (const role of roles) {
    if (!roleChanged(role, draft)) continue;
    const template = templateOf(role, catalogue);
    const permissions: Record<string, PermState> = {};
    for (const p of catalogue.permissions) {
      const state = draft.states[role.id]?.[p.code] ?? role.permissions[p.code];
      const base = template?.permissions[p.code];
      if (state && state !== base) permissions[p.code] = state;
    }
    const limits: Record<string, Record<string, number | null>> = {};
    for (const p of catalogue.permissions) {
      for (const lim of p.limits) {
        const drafted = draft.limits[role.id]?.[p.code];
        const value = drafted && lim.key in drafted ? drafted[lim.key] : role.limits?.[p.code]?.[lim.key];
        const base = template?.limits?.[p.code]?.[lim.key];
        const normalized = value === undefined ? null : value;
        const baseNormalized = base === undefined ? null : base;
        if (normalized !== baseNormalized) {
          // A null that differs from a template's number says "no limit here" — kept as an
          // explicit value is not expressible (null = inherit), so it is sent as the max.
          limits[p.code] = { ...(limits[p.code] ?? {}), [lim.key]: normalized ?? lim.max };
        }
      }
    }
    const item: MatrixSaveRole = { id: role.id, permissions, limits };
    if (deniedUiChanged(role, draft)) item.deniedUi = draft.deniedUi?.[role.id] ?? null;
    out.push(item);
  }
  return out;
}

/** Does the draft show this role differently from what the server has? */
export function roleChanged(role: TillRole, draft: MatrixDraft): boolean {
  if (deniedUiChanged(role, draft)) return true;
  const states = draft.states[role.id] ?? {};
  for (const [code, state] of Object.entries(states)) {
    if (role.permissions[code] !== state) return true;
  }
  const limits = draft.limits[role.id] ?? {};
  for (const [code, values] of Object.entries(limits)) {
    for (const [key, value] of Object.entries(values)) {
      const server = role.limits?.[code]?.[key];
      if ((server === undefined ? null : server) !== value) return true;
    }
  }
  return false;
}

/** How many cells (states and limits) the draft changed, for the save bar. */
export function changedCells(roles: TillRole[], draft: MatrixDraft): number {
  let n = 0;
  for (const role of roles) {
    if (deniedUiChanged(role, draft)) n += 1;
    for (const [code, state] of Object.entries(draft.states[role.id] ?? {})) {
      if (role.permissions[code] !== state) n += 1;
    }
    for (const [code, values] of Object.entries(draft.limits[role.id] ?? {})) {
      for (const [key, value] of Object.entries(values)) {
        const server = role.limits?.[code]?.[key];
        if ((server === undefined ? null : server) !== value) n += 1;
      }
    }
  }
  return n;
}

/** Counts per state, for a role's column header ("12 מותר · 5 באישור · 3 אסור"). */
export function countStates(states: Record<string, PermState>): Record<PermState, number> {
  const out: Record<PermState, number> = { allow: 0, approval: 0, deny: 0 };
  for (const s of Object.values(states)) if (isPermState(s)) out[s] += 1;
  return out;
}

/** Roles in the order the matrix shows them; legacy roles last, and only when asked or in use. */
export function visibleRoles(roles: TillRole[], showLegacy: boolean): TillRole[] {
  return [...roles]
    .filter((r) => !r.legacy || showLegacy || r.users > 0)
    .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, 'he'));
}

/** A user's overrides as the editor keeps them: code → state ('' = as the role). */
export function overridesDraft(user: Pick<TillRoleUser, 'overrides'>): Record<string, PermState | ''> {
  const out: Record<string, PermState | ''> = {};
  for (const [code, state] of Object.entries(user.overrides?.states ?? {})) if (isPermState(state)) out[code] = state;
  return out;
}

/** A user's own "כשאין הרשאה" as the editor keeps it ('' = as the role). */
export function overridesDeniedUi(user: Pick<TillRoleUser, 'overrides'>): DeniedUi | '' {
  const value = user.overrides?.deniedUi;
  return isDeniedUi(value) ? value : '';
}

export function overridesPayload(
  draft: Record<string, PermState | ''>,
  deniedUi: DeniedUi | '' = '',
): { states: Record<string, PermState>; deniedUi?: DeniedUi } | null {
  const states: Record<string, PermState> = {};
  for (const [code, state] of Object.entries(draft)) if (state) states[code] = state;
  if (deniedUi) return { states, deniedUi };
  return Object.keys(states).length ? { states } : null;
}

/** How many personal exceptions a user has (their states, and their own "כשאין הרשאה"). */
export function overridesCount(user: Pick<TillRoleUser, 'overrides'>): number {
  return Object.keys(user.overrides?.states ?? {}).length + (overridesDeniedUi(user) ? 1 : 0);
}

/**
 * The audit's line for a "כשאין הרשאה" change ("כשאין הרשאה: כמו בהגדרה → להסתיר"), or null when it did not
 * move. Reads role snapshots and user overrides alike (`deniedUi` in either).
 */
export function describeDeniedUiChange(
  oldValue: unknown,
  newValue: unknown,
  label: (value: DeniedUi | null) => string,
  title: string,
): string | null {
  const pick = (v: unknown): DeniedUi | null => {
    const d = v && typeof v === 'object' ? (v as { deniedUi?: unknown }).deniedUi : undefined;
    return isDeniedUi(d) ? d : null;
  };
  const before = pick(oldValue);
  const after = pick(newValue);
  if (before === after) return null;
  return `${title}: ${label(before)} → ${label(after)}`;
}

/**
 * One line per audit entry's state changes: "זיכוי: באישור → מותר". `labels` names codes,
 * `stateLabel` the states. Reads `{permissions}` snapshots (role edits) and
 * `{states}` ones (user overrides).
 */
export function describeStateChanges(
  oldValue: unknown,
  newValue: unknown,
  labels: Record<string, string>,
  stateLabel: (s: PermState) => string,
): string[] {
  const pick = (v: unknown): Record<string, PermState> => {
    if (!v || typeof v !== 'object') return {};
    const o = v as { permissions?: unknown; states?: unknown };
    const m = (o.permissions ?? o.states) as Record<string, unknown> | undefined;
    const out: Record<string, PermState> = {};
    if (m && typeof m === 'object') for (const [k, s] of Object.entries(m)) if (isPermState(s)) out[k] = s;
    return out;
  };
  const before = pick(oldValue);
  const after = pick(newValue);
  const codes = Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).sort();
  const lines: string[] = [];
  for (const code of codes) {
    if (before[code] === after[code]) continue;
    const from = before[code] ? stateLabel(before[code]) : '—';
    const to = after[code] ? stateLabel(after[code]) : '—';
    lines.push(`${labels[code] ?? code}: ${from} → ${to}`);
  }
  return lines;
}
