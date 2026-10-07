/**
 * A kiosk's shift and Z by its Z mode — the rules the dashboard applies (pos-server
 * app/services/kiosk_z.py, docs/SPEC_KIOSK.md §25).
 *
 * The owner: a kiosk in the shop Z is offered "סגירת משמרת" (its shift goes into the shop's
 * next Z), one with its own Z ("Z עצמאי", or the shop's "Z לכל קופה") is offered "הפקת Z" —
 * never both, and never "הפקת Z" for a shop-Z kiosk. The mode is per device: the shop's,
 * overridden per machine on the "קופות בזד הסניפי" card (or the kiosk's own switch).
 *
 * Kept free of React and of the `@/` alias so `npm test` can compile and run it on its own.
 */

export type KioskZKind = 'shop' | 'independent' | 'own';
export type KioskZAction = 'close_shift' | 'till_z';

export type KioskJobState =
  | 'queued'
  | 'sent'
  | 'waiting_payment'
  | 'waiting_customer'
  | 'closing'
  | 'producing'
  | 'closed'
  | 'done'
  | 'nothing'
  | 'failed'
  | 'expired'
  | 'cancelled';

/** The last close (`shiftClose`) or Z (`tillZRequest`) asked of a kiosk, as its summary carries it. */
export interface KioskJob {
  id: string;
  state: KioskJobState;
  status?: string;
  pending: boolean;
  errorCode?: string | null;
  /** Why it failed, in Hebrew. */
  detail?: string | null;
  /** The cloud's own line. */
  message?: string | null;
  shiftId?: string | null;
  zReportId?: string | null;
  zNumber?: number | null;
  force?: boolean;
  /** `kiosk`, or `controller`: the controlling till that asked prints the Z. */
  printOn?: 'kiosk' | 'controller';
  printOnMachineId?: string | null;
  requestedAt?: string | null;
  finishedAt?: string | null;
}

/** What of a kiosk's summary these rules read. */
export interface KioskZFacts {
  zKind?: KioskZKind | null;
  zMode?: 'till' | 'cloud' | null;
  independentTill?: boolean | null;
  shiftOpen?: boolean | null;
  shiftClose?: KioskJob | null;
  tillZRequest?: KioskJob | null;
}

const PENDING: ReadonlySet<KioskJobState> = new Set<KioskJobState>([
  'queued',
  'sent',
  'waiting_payment',
  'waiting_customer',
  'closing',
  'producing',
]);

export function isPendingState(state: KioskJobState | string | null | undefined): boolean {
  return !!state && PENDING.has(state as KioskJobState);
}

/** The cloud's `zKind`; an older server's `zMode` (and independent flag) alone. */
export function kioskZKindOf(k: KioskZFacts): KioskZKind {
  if (k.zKind === 'shop' || k.zKind === 'independent' || k.zKind === 'own') return k.zKind;
  if (k.independentTill) return 'independent';
  return k.zMode === 'till' ? 'own' : 'shop';
}

export function makesOwnZ(kind: KioskZKind): boolean {
  return kind !== 'shop';
}

/** The one shift / Z action of a kiosk of [kind]. */
export function kioskZActionOf(kind: KioskZKind): KioskZAction {
  return kind === 'shop' ? 'close_shift' : 'till_z';
}

export type KioskZBlock = 'no_open_shift' | 'in_progress' | 'no_write';

export interface KioskZOffer {
  kind: KioskZKind;
  action: KioskZAction;
  enabled: boolean;
  block: KioskZBlock | null;
}

/** What the kiosk's detail offers now: its one action, and why it cannot be pressed. */
export function kioskZOffer(k: KioskZFacts, canWrite: boolean): KioskZOffer {
  const kind = kioskZKindOf(k);
  const action = kioskZActionOf(kind);
  const job = action === 'close_shift' ? k.shiftClose : k.tillZRequest;
  let block: KioskZBlock | null = null;
  if (!canWrite) block = 'no_write';
  else if (job && isPendingState(job.state)) block = 'in_progress';
  else if (action === 'close_shift' && k.shiftOpen === false) block = 'no_open_shift';
  return { kind, action, enabled: block === null, block };
}

/** The last close / Z of the kiosk's own action, to show beside it. */
export function kioskLastJob(k: KioskZFacts): KioskJob | null {
  return (kioskZActionOf(kioskZKindOf(k)) === 'close_shift' ? k.shiftClose : k.tillZRequest) ?? null;
}

export type JobTone = 'ok' | 'wait' | 'bad' | 'muted';

export function jobTone(state: KioskJobState | string): JobTone {
  if (state === 'closed' || state === 'done' || state === 'nothing') return 'ok';
  if (state === 'failed' || state === 'expired') return 'bad';
  if (state === 'cancelled') return 'muted';
  return 'wait';
}

/**
 * The kiosk's own "Z עצמאי" switch (the same rule as the shop's card): the super admin's
 * alone, and only with no open shift and no closed shift waiting for a Z — a shift is never
 * stranded between the shop's run and the kiosk's. `own` ("Z לכל קופה") is the shop's mode:
 * the switch makes it independent, like the card.
 */
export function zSwitchOf(
  kind: KioskZKind,
  t: { canEdit: boolean; openShift?: boolean | null; awaitingZ?: number | null } | null,
): { target: 'independent' | 'shop'; allowed: boolean; block: 'not_super_admin' | 'open_shift' | 'awaiting_z' | 'unknown' | null } {
  const target = kind === 'independent' ? 'shop' : 'independent';
  if (!t) return { target, allowed: false, block: 'unknown' };
  if (!t.canEdit) return { target, allowed: false, block: 'not_super_admin' };
  if (t.openShift) return { target, allowed: false, block: 'open_shift' };
  if ((t.awaitingZ ?? 0) > 0) return { target, allowed: false, block: 'awaiting_z' };
  return { target, allowed: true, block: null };
}

/** The PUT z-participation body that changes this one kiosk only. */
export function zSwitchBody(machineId: string, target: 'independent' | 'shop'): {
  participants: string[];
  independent: string[];
} {
  return target === 'independent'
    ? { participants: [], independent: [machineId] }
    : { participants: [machineId], independent: [] };
}
