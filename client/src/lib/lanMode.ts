/**
 * The shop's local network (pos-server docs/SPEC_LAN_MODE.md): the main till card's switch
 * "רשת מקומית", its row per system, its "סנכרון רשת מקומית" row, and a device's "לא משמש
 * כשרת מקומי". Pure — `npm test` compiles it alone; the calls are in lib/lanServerApi.ts.
 */

/** A system of the shop, as the card lists it. */
export type LanSystem = 'tables' | 'print' | 'shop_z' | 'kds' | 'kiosk';

/**
 * `lan` — through the main till; `other_host` — on the LAN, through another till; `no_host` —
 * on the LAN, nobody to serve it; `cloud` — through the cloud; `off` — not in use; `soon` —
 * not on the LAN yet; `partial` — part of it; `none` — no such device in the shop.
 */
export type LanHealthState = 'lan' | 'other_host' | 'no_host' | 'cloud' | 'off' | 'soon' | 'partial' | 'none';

export interface LanTillRef {
  machineId: string;
  posNumber?: string | null;
  name?: string | null;
}

export interface LanHealthRow {
  system: LanSystem | string;
  state: LanHealthState | string;
  host: LanTillRef | null;
}

/** "סנכרון רשת מקומית": the local server and what its cloud copy still lacks. */
export interface LanSyncState {
  state: 'synced' | 'syncing' | 'lagging' | 'offline' | 'unknown' | 'none' | string;
  host: LanTillRef | null;
  pending: number;
  oldestAgeSeconds: number | null;
  /** Online and a change older than a minute: the owner's real-time rule is broken. */
  alert: boolean;
  reportedAt?: string | null;
  systems?: Record<string, { pending: number; oldestAt: string | null }>;
}

export type Tone = 'ok' | 'warn' | 'bad' | 'muted';

export const LAN_SYSTEMS: readonly LanSystem[] = ['tables', 'print', 'shop_z', 'kds', 'kiosk'];

/** A row's tone: green through the main till, amber elsewhere on the LAN, grey otherwise. */
export function healthTone(state: string): Tone {
  if (state === 'lan') return 'ok';
  if (state === 'other_host' || state === 'partial') return 'warn';
  if (state === 'no_host') return 'bad';
  return 'muted';
}

/** The rows in the card's order, a system the server did not send shown as unknown. */
export function healthRows(rows: LanHealthRow[] | null | undefined): LanHealthRow[] {
  const by = new Map((rows ?? []).map((r) => [r.system, r]));
  return LAN_SYSTEMS.map((s) => by.get(s) ?? { system: s, state: 'none', host: null });
}

/** The sync row's tone: green synced, amber on its way or offline, red past a minute online. */
export function syncTone(s: Pick<LanSyncState, 'state' | 'alert'> | null | undefined): Tone {
  if (!s) return 'muted';
  if (s.alert || s.state === 'lagging') return 'bad';
  if (s.state === 'synced') return 'ok';
  if (s.state === 'syncing' || s.state === 'offline') return 'warn';
  return 'muted';
}

/** "לפני 2 דק׳" — whole minutes past a minute, seconds below. */
export function ageText(seconds: number | null | undefined): { key: 'seconds' | 'minutes'; values: { n: string } } | null {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return null;
  if (seconds < 60) return { key: 'seconds', values: { n: String(Math.round(seconds)) } };
  return { key: 'minutes', values: { n: String(Math.floor(seconds / 60)) } };
}

/** Whether the switch may be turned on now: it needs a main till. */
export function localNetworkBlock(state: { mainTill: LanTillRef | null; localNetwork: boolean }): 'needs_main_till' | null {
  return !state.localNetwork && !state.mainTill ? 'needs_main_till' : null;
}

/**
 * The switch as the card shows it: `on` (and the shop is in local mode), `inactive` (on, but
 * no main till to lean on — the shop works through the cloud), `off`.
 */
export function localNetworkView(state: { localNetwork: boolean; localMode: boolean }): 'on' | 'inactive' | 'off' {
  if (!state.localNetwork) return 'off';
  return state.localMode ? 'on' : 'inactive';
}

// ── A device: "לא משמש כשרת מקומי" ─────────────────────────────────────────────

export interface MachineLanServer {
  machineId: string;
  lanServerExcluded: boolean;
  lanServerExcludedReason: 'set' | 'kds_screen' | null;
  lanServerExcludedAuto: boolean;
  lanServerExcludedSuggested: boolean;
  lanServerExcludedChosen: boolean;
  isMainTill: boolean;
  /** False for a display device or an independent till: outside the LAN group already. */
  applies: boolean;
  canEdit: boolean;
}

/** Why the machine page's switch cannot change now, or null. */
export function machineSwitchBlock(m: MachineLanServer): 'read_only' | 'kds_screen' | 'main_till' | 'not_applicable' | null {
  if (!m.applies) return 'not_applicable';
  if (!m.canEdit) return 'read_only';
  if (m.lanServerExcludedAuto) return 'kds_screen';
  if (m.isMainTill && !m.lanServerExcluded) return 'main_till';
  return null;
}

/** The hint under the switch: suggested and never chosen. */
export function machineSuggests(m: MachineLanServer): boolean {
  return m.lanServerExcludedSuggested && !m.lanServerExcludedChosen && !m.lanServerExcluded;
}
