/**
 * "קופה עצמאית בתוך סניף" — which tills of a shop are in the shop's Z ("Z סניפי") and which
 * work on their own: an independent till makes its own Z, in its own numbering, is never
 * part of the shop Z (not listed, not waited for, not in its figures) and never leans on
 * the shop's main till ("שרת מקומי") for tables or printing. pos-server
 * `GET/PUT /shops/{id}/z-participation`.
 *
 * Pure rules for the card on the shop page: the effect of each till's checkbox, the PUT
 * body (only what changed), what blocks a save, the refusals the server sends, and the
 * summary line. No imports, so `npm test` compiles it alone. The API calls are in
 * lib/zParticipationApi.ts.
 */

/**
 * - `shop_z`      — zMode `cloud`: in the shop Z.
 * - `independent` — an independent till (zMode `till`, outside the shop and its LAN group).
 * - `own_z`       — zMode `till` but not independent: the older whole-shop "Z לכל קופה";
 *                   still in the shop's LAN group.
 */
export type ZRole = 'shop_z' | 'independent' | 'own_z';

export interface ZParticipationTill {
  machineId: string;
  posNumber: string | null;
  name: string | null;
  areaId?: string | null;
  zMode: 'cloud' | 'till';
  independent: boolean;
  role: ZRole;
  /** The cloud holds an open shift for it. */
  openShift: boolean;
  /** Closed shifts of it that no Z has taken yet. */
  awaitingZ: number;
  mainTill: boolean;
  online?: boolean;
}

export interface ZParticipationTillRef {
  machineId: string;
  posNumber?: string | null;
  name?: string | null;
}

export interface ZParticipationState {
  shopId: string;
  tills: ZParticipationTill[];
  mainTill: ZParticipationTillRef | null;
  /** The shop works over the LAN main till: its shop Z closes the tills over the LAN. */
  localMode: boolean;
  /** The super admin's alone to change. */
  canEdit: boolean;
  /** Who produces the shop's Z sequence now (also `GET /shops/{id}/shop-z-producer`). */
  shopZ?: ShopZProducerState | null;
}

/** `PUT /shops/{id}/z-participation`. `mainTillId` absent = unchanged, null = none. */
export interface ZParticipationBody {
  participants: string[];
  independent: string[];
  mainTillId?: string | null;
  /** A super admin's "העבר בכל זאת": switch although the producer has not handed over. */
  forceProducerSwitch?: boolean;
}

// ── The shop Z's one producer ("אין דבר כזה זד שממוספר מחדש") ─────────────────
//
// A shop's Z sequence has exactly one producer at a time — the cloud, or the main till
// on the LAN — and a printed Z number is final. A switch waits until the producer has
// handed over (every shop Z it printed is in the cloud); a Z the cloud cannot take as
// printed is kept as printed and listed for support, never renumbered.

export interface ShopZProducer {
  kind: 'cloud' | 'local';
  machine: ZParticipationTillRef | null;
  since?: string | null;
}

export interface ShopZHandover {
  reason: 'unsynced_shop_zs' | 'producer_offline' | 'cloud_run_live' | string;
  /** The server's Hebrew. */
  message?: string | null;
  pending?: number | null;
  to?: { kind: 'cloud' | 'local'; machine: ZParticipationTillRef | null } | null;
}

export interface ShopZConflict {
  zId: string;
  number?: number | null;
  expectedNumber?: number | null;
  detail: 'offline_z_out_of_sequence' | 'offline_z_number_taken' | 'not_shop_z_producer' | string;
  takenByZReportId?: string | null;
  machineId?: string | null;
  posNumber?: string | null;
  closedAt?: string | null;
  firstAt?: string | null;
  lastAt?: string | null;
  attempts?: number | null;
  /** The server's Hebrew. */
  message?: string | null;
}

export interface ShopZProducerState {
  producer: ShopZProducer;
  handover: ShopZHandover | null;
  conflicts: ShopZConflict[];
}

/** "מפיק ה-Z הסניפי: …" — a message key under `independentTill.producer` and its values. */
export function producerViewOf(p: ShopZProducer | null | undefined): {
  key: 'local' | 'localNoTill' | 'cloud';
  values: Record<string, string>;
} {
  if (p?.kind === 'local') {
    const till = p.machine ? formatTillNumbers([p.machine]) : '';
    return till ? { key: 'local', values: { till } } : { key: 'localNoTill', values: {} };
  }
  return { key: 'cloud', values: {} };
}

/** A conflict's numbers: "Z מס׳ {number} (הענן ציפה ל-{expectedNumber})", or the number alone. */
export function conflictNumbersOf(c: ShopZConflict): {
  key: 'numbers' | 'numberOnly' | 'none';
  values: Record<string, string>;
} {
  if (c.number == null) return { key: 'none', values: {} };
  if (c.expectedNumber == null) return { key: 'numberOnly', values: { number: String(c.number) } };
  return { key: 'numbers', values: { number: String(c.number), expected: String(c.expectedNumber) } };
}

/** A switch refused because the shop Z's producer has not handed over yet. */
export interface ProducerBusy {
  message: string | null;
  /** A super admin may switch anyway (`forceProducerSwitch: true`). */
  canForce: boolean;
  reason: string | null;
}

/**
 * Reads 409 `shop_z_producer_busy` in both shapes: `{detail: "shop_z_producer_busy",
 * message, canForce, reason}` and `{detail: {code, message, canForce, reason}}`.
 */
export function producerBusyOf(err: unknown): ProducerBusy | null {
  const data = (err as { response?: { data?: unknown } } | null)?.response?.data;
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const src =
    d.detail === 'shop_z_producer_busy'
      ? d
      : d.detail && typeof d.detail === 'object' && (d.detail as Record<string, unknown>).code === 'shop_z_producer_busy'
        ? (d.detail as Record<string, unknown>)
        : null;
  if (!src) return null;
  return {
    message: typeof src.message === 'string' && src.message.trim() ? src.message : null,
    canForce: src.canForce === true,
    reason: typeof src.reason === 'string' ? src.reason : null,
  };
}

/** The choice for each till, by machine id, as the card edits it. */
export type ZChoices = Record<string, ZRole>;

/** Absent or unknown reads from the flags: independent, else by the Z mode. */
export function roleOf(t: Pick<ZParticipationTill, 'role' | 'independent' | 'zMode'>): ZRole {
  if (t.role === 'shop_z' || t.role === 'independent' || t.role === 'own_z') return t.role;
  if (t.independent) return 'independent';
  return t.zMode === 'till' ? 'own_z' : 'shop_z';
}

/** The tills by register number (1, 2 … 10), the unnumbered last by name. */
export function sortTills<T extends { posNumber?: string | null; name?: string | null }>(tills: T[]): T[] {
  const num = (t: T) => {
    const n = Number(t.posNumber);
    return t.posNumber != null && t.posNumber !== '' && Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
  };
  return [...tills].sort((a, b) => num(a) - num(b) || (a.name ?? '').localeCompare(b.name ?? ''));
}

export function initialChoices(state: Pick<ZParticipationState, 'tills'>): ZChoices {
  const out: ZChoices = {};
  for (const t of state.tills) out[t.machineId] = roleOf(t);
  return out;
}

/**
 * The checkbox: ticked = in the shop Z. Unticked = an independent till — except a till
 * that was in "Z לכל קופה" to begin with, which goes back to that (it is changed only
 * when the user changes it).
 */
export function choiceForTick(initial: ZRole, ticked: boolean): ZRole {
  if (ticked) return 'shop_z';
  return initial === 'own_z' ? 'own_z' : 'independent';
}

/** What a till's checkbox means for it, as the card labels it. */
export type ZEffect = 'shopZ' | 'independent' | 'ownZ';

export function effectOf(choice: ZRole): ZEffect {
  if (choice === 'shop_z') return 'shopZ';
  if (choice === 'independent') return 'independent';
  return 'ownZ';
}

/** Why a till cannot change sides now — the server refuses a switch over an unfinished shift. */
export type SwitchBlock = 'open_shift' | 'awaiting_z';

export function switchBlockOf(t: Pick<ZParticipationTill, 'openShift' | 'awaitingZ'>): SwitchBlock | null {
  if (t.openShift) return 'open_shift';
  if ((t.awaitingZ ?? 0) > 0) return 'awaiting_z';
  return null;
}

function mainIdOf(state: Pick<ZParticipationState, 'mainTill'>): string | null {
  return state.mainTill?.machineId ?? null;
}

/**
 * The PUT body: only the tills whose side changed, and `mainTillId` only when it changed
 * (null = no main till). Null when nothing changed.
 */
export function buildParticipationBody(
  state: Pick<ZParticipationState, 'tills' | 'mainTill'>,
  choices: ZChoices,
  mainTillId: string | null,
): ZParticipationBody | null {
  const participants: string[] = [];
  const independent: string[] = [];
  for (const t of sortTills(state.tills)) {
    const was = roleOf(t);
    const now = choices[t.machineId] ?? was;
    if (now === was) continue;
    if (now === 'shop_z') participants.push(t.machineId);
    else if (now === 'independent') independent.push(t.machineId);
  }
  const body: ZParticipationBody = { participants, independent };
  const mainChanged = (mainTillId || null) !== mainIdOf(state);
  if (mainChanged) body.mainTillId = mainTillId || null;
  return participants.length || independent.length || mainChanged ? body : null;
}

export type ParticipationIssue =
  | { kind: 'main_not_participating'; machineId: string }
  | { kind: 'blocked'; machineId: string; reason: SwitchBlock };

/**
 * What stops a save: the main till must be one of the ticked tills, and a till with an
 * open shift (or closed shifts awaiting a Z) cannot change sides — the server would
 * refuse the whole save.
 */
export function validateParticipation(
  state: Pick<ZParticipationState, 'tills'>,
  choices: ZChoices,
  mainTillId: string | null,
): ParticipationIssue[] {
  const issues: ParticipationIssue[] = [];
  if (mainTillId) {
    const known = state.tills.some((t) => t.machineId === mainTillId);
    if (!known || choices[mainTillId] !== 'shop_z') {
      issues.push({ kind: 'main_not_participating', machineId: mainTillId });
    }
  }
  for (const t of sortTills(state.tills)) {
    const now = choices[t.machineId] ?? roleOf(t);
    if (now === roleOf(t)) continue;
    const reason = switchBlockOf(t);
    if (reason) issues.push({ kind: 'blocked', machineId: t.machineId, reason });
  }
  return issues;
}

/** The tills a main till may be picked from: the ticked ones, by number. */
export function mainTillOptions<T extends ZParticipationTill>(tills: T[], choices: ZChoices): T[] {
  return sortTills(tills.filter((t) => (choices[t.machineId] ?? roleOf(t)) === 'shop_z'));
}

/**
 * Register numbers as a reader writes them: a run of three or more as a range
 * ("1–5"), the rest by comma ("1–3, 5, 7"). A till with no number goes by its name.
 */
export function formatTillNumbers(tills: { posNumber?: string | null; name?: string | null }[]): string {
  const nums: number[] = [];
  const others: string[] = [];
  for (const t of tills) {
    const n = Number(t.posNumber);
    if (t.posNumber != null && t.posNumber !== '' && Number.isInteger(n)) nums.push(n);
    else others.push(t.name ?? t.posNumber ?? '?');
  }
  const sorted = [...new Set(nums)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    if (j - i >= 2) parts.push(`${sorted[i]}–${sorted[j]}`);
    else for (let k = i; k <= j; k++) parts.push(String(sorted[k]));
    i = j + 1;
  }
  return [...parts, ...others].join(', ');
}

/** One sentence of the summary: a message key under `independentTill.summary` and its values. */
export interface SummarySegment {
  key:
    | 'shopZMain'
    | 'shopZOneMain'
    | 'shopZNoMain'
    | 'shopZOneNoMain'
    | 'noShopZ'
    | 'independentMany'
    | 'independentOne'
    | 'ownZMany'
    | 'ownZOne';
  values: Record<string, string>;
}

/**
 * "קופות 1–5 בזד הסניפי, נשענות על קופה 1 כשרת מקומי · קופה 6 עצמאית" — as segments the
 * card translates and joins with " · ".
 */
export function summarySegments(
  state: Pick<ZParticipationState, 'tills'>,
  choices: ZChoices,
  mainTillId: string | null,
): SummarySegment[] {
  const of = (role: ZRole) => sortTills(state.tills.filter((t) => (choices[t.machineId] ?? roleOf(t)) === role));
  const shopZ = of('shop_z');
  const independent = of('independent');
  const ownZ = of('own_z');
  const out: SummarySegment[] = [];
  const main = mainTillId ? shopZ.find((t) => t.machineId === mainTillId) : undefined;
  const mainLabel = main ? formatTillNumbers([main]) : '';
  if (shopZ.length === 0) {
    if (ownZ.length === 0) out.push({ key: 'noShopZ', values: {} });
  } else if (shopZ.length === 1) {
    out.push(
      main
        ? { key: 'shopZOneMain', values: { tills: formatTillNumbers(shopZ), main: mainLabel } }
        : { key: 'shopZOneNoMain', values: { tills: formatTillNumbers(shopZ) } },
    );
  } else {
    out.push(
      main
        ? { key: 'shopZMain', values: { tills: formatTillNumbers(shopZ), main: mainLabel } }
        : { key: 'shopZNoMain', values: { tills: formatTillNumbers(shopZ) } },
    );
  }
  if (ownZ.length > 0) {
    out.push({ key: ownZ.length === 1 ? 'ownZOne' : 'ownZMany', values: { tills: formatTillNumbers(ownZ) } });
  }
  if (independent.length > 0) {
    out.push({
      key: independent.length === 1 ? 'independentOne' : 'independentMany',
      values: { tills: formatTillNumbers(independent) },
    });
  }
  return out;
}

/**
 * A Z of the shop (or of an area of it) rather than of one till — what a "נסגר ללא חיבור"
 * Z produced on the main till is. From `scope` when the server sends it, else the origin.
 */
export function isShopZ(z: {
  scope?: { kind?: string | null } | null;
  origin?: string | null;
  legacy?: boolean | null;
}): boolean {
  const kind = z.scope?.kind;
  if (kind) return kind === 'shop' || kind === 'area';
  return z.origin !== 'till' && !z.legacy;
}

/** A refusal of the PUT (or of the main till's): its code, the server's Hebrew text, the till. */
export interface ParticipationRefusal {
  code: string;
  message: string | null;
  machineId: string | null;
  posNumber: string | null;
}

/**
 * Reads `{detail: code, message, machineId, posNumber}` (this API) and `{detail: {code,
 * message}}` (the main till's) alike. Null when the error carries no code (a network error).
 */
export function refusalOf(err: unknown): ParticipationRefusal | null {
  const data = (err as { response?: { data?: unknown } } | null)?.response?.data;
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  if (typeof d.detail === 'string') {
    return {
      code: d.detail,
      message: str(d.message),
      machineId: str(d.machineId),
      posNumber: str(d.posNumber) ?? (typeof d.posNumber === 'number' ? String(d.posNumber) : null),
    };
  }
  if (d.detail && typeof d.detail === 'object' && !Array.isArray(d.detail)) {
    const inner = d.detail as Record<string, unknown>;
    const code = str(inner.code);
    if (!code) return null;
    return {
      code,
      message: str(inner.message),
      machineId: str(inner.machineId),
      posNumber: str(inner.posNumber),
    };
  }
  return null;
}

/** The refusal codes the card has a text of its own for (under `independentTill.errors`). */
export const KNOWN_REFUSALS = [
  'super_admin_only',
  'independent_switch_open_shift',
  'independent_switch_unreported_shifts',
  'independent_switch_z_in_progress',
  'machine_not_in_shop',
  'main_till_not_participating',
  'till_in_both_lists',
  'main_till_independent',
  'shop_z_producer_busy',
] as const;

export type KnownRefusal = (typeof KNOWN_REFUSALS)[number];

export function isKnownRefusal(code: string): code is KnownRefusal {
  return (KNOWN_REFUSALS as readonly string[]).includes(code);
}
