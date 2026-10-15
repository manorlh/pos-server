/**
 * What the cash station accepts right now (P:/specs/cash-paylink.md §3, §9א — `prevent` always
 * runs first, whatever `cashChangeShortfall` says):
 *
 *  - a denomination that does not exceed what is still due is always fine (no change);
 *  - a bigger one only if its change (value − remaining) is at most `cashMaxChangeAgorot` (the
 *    "note limit relative to the amount": 200 ₪ on 15 ₪ needs 185 ₪ — refused above the limit) and
 *    the dispensers can pay that change (change.ts) — else it is inhibited before it is inserted;
 *  - "סכום מדויק בלבד": with less change on hand than `cashExactChangeBelowAgorot` (or no dispensers at
 *    all) only denominations up to the remaining amount;
 *  - a note held in escrow (single-note escrow) is accepted or returned by the same rule — so even a
 *    note that slipped in between two inhibit updates never needs change the unit cannot pay.
 *
 * Recomputed after every insertion: the remaining amount changes the answer.
 *
 * Pure.
 */

import { canPay, type Inventory } from './change';
import type { AcceptorSnap, DeviceCommand } from './device';
import type { CashSettings } from './settings';

export interface AcceptanceInput {
  remainingAgorot: number;
  inventory: Inventory;
  changeAvailableAgorot: number;
  /** The station has dispensers that pay change at all. */
  hasDispensers: boolean;
  precisePay: boolean;
  settings: Pick<CashSettings, 'coinsAccepted' | 'notesAccepted' | 'maxChangeAgorot' | 'exactChangeBelowAgorot'>;
  /** The denominations the device knows (its coin / note tables). */
  deviceCoins: readonly number[];
  deviceNotes: readonly number[];
}

export interface Acceptance {
  coins: number[];
  notes: number[];
  exactOnly: boolean;
}

export function exactOnlyNow(changeAvailableAgorot: number, hasDispensers: boolean, exactChangeBelowAgorot: number): boolean {
  return !hasDispensers || changeAvailableAgorot < exactChangeBelowAgorot;
}

/** Whether one piece of `value` may go in now. */
export function pieceAllowed(value: number, i: Omit<AcceptanceInput, 'deviceCoins' | 'deviceNotes'>, exactOnly: boolean): boolean {
  if (i.remainingAgorot <= 0) return false;
  if (value <= i.remainingAgorot) return true;
  if (exactOnly) return false;
  const change = value - i.remainingAgorot;
  if (change > i.settings.maxChangeAgorot) return false;
  return canPay(change, i.inventory, i.precisePay);
}

export function acceptanceFor(i: AcceptanceInput): Acceptance {
  const exactOnly = exactOnlyNow(i.changeAvailableAgorot, i.hasDispensers, i.settings.exactChangeBelowAgorot);
  const coins = i.settings.coinsAccepted.filter((v) => i.deviceCoins.includes(v) && pieceAllowed(v, i, exactOnly));
  const notes = i.settings.notesAccepted.filter((v) => i.deviceNotes.includes(v) && pieceAllowed(v, i, exactOnly));
  return { coins, notes, exactOnly };
}

/** A note in escrow: keep it (accept) or give it back (return). */
export function escrowDecision(valueAgorot: number, i: Omit<AcceptanceInput, 'deviceCoins' | 'deviceNotes'>): 'accept' | 'return' {
  const exactOnly = exactOnlyNow(i.changeAvailableAgorot, i.hasDispensers, i.settings.exactChangeBelowAgorot);
  const listed = i.settings.notesAccepted.includes(valueAgorot) || i.settings.coinsAccepted.includes(valueAgorot);
  return listed && pieceAllowed(valueAgorot, i, exactOnly) ? 'accept' : 'return';
}

/**
 * The device write for an acceptance: an acceptor with nothing allowed is inhibited as a whole;
 * otherwise each coin / note is inhibited unless its value is allowed. `skipAcceptors` — the
 * extended-escrow acceptor, whose acceptance runs by escrow commands (the manual: it "cannot be
 * enabled using the normal control facilities"; its individual notes still can).
 */
export function acceptanceCommand(acceptors: readonly AcceptorSnap[], a: Acceptance | null, skipAcceptors: readonly number[] = []): DeviceCommand {
  const allowed = new Set(a ? [...a.coins, ...a.notes] : []);
  return {
    op: 'acceptance',
    acceptors: acceptors.map((acc) => {
      const coins = acc.coins.map((c) => ({ index: c.index, inhibit: !allowed.has(c.valueAgorot) }));
      const any = coins.some((c) => !c.inhibit);
      return { index: acc.index, inhibit: skipAcceptors.includes(acc.index) ? acc.inhibited : !any, coins };
    }),
  };
}

/** Everything off (the unit closed to money). */
export function closedCommand(acceptors: readonly AcceptorSnap[]): DeviceCommand {
  return acceptanceCommand(acceptors, null);
}

/** The denominations a device's acceptors know. */
export function deviceDenominations(acceptors: readonly AcceptorSnap[]): { coins: number[]; notes: number[] } {
  const coins = new Set<number>();
  const notes = new Set<number>();
  for (const a of acceptors) for (const c of a.coins) if (c.valueAgorot > 0) (a.kind === 'note' ? notes : coins).add(c.valueAgorot);
  return { coins: [...coins].sort((x, y) => x - y), notes: [...notes].sort((x, y) => x - y) };
}
