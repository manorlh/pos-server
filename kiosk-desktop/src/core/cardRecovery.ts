/**
 * A card answer that never came is NOT "not approved" (pos-server docs/SPEC_CARD_RECOVERY.md;
 * pos-android hardware/payment/CardRecovery.kt, data/repo/CardAttemptRecovery.kt):
 *
 *  - before a sale frame leaves, an attempt is written to disk (vuid, amount, document…);
 *  - an unknown outcome is settled by asking the terminal about THE SAME vuid — never by a
 *    second charge: getTransactionByVuid first (an answered transaction is believed at once,
 *    without an abort — an abort after an approval shows "עסקה בוטלה" on the Nayax pinpad), and
 *    only when that does not settle it, abortTransaction once, then more lookups after 2, 4 and
 *    8 s (4 in all);
 *  - "not found" is believed only when the terminal is idle and said it twice, ≥ 5 s apart;
 *  - while any attempt is unresolved, the kiosk takes no card at all.
 *
 * Pure: the transport and the clock are passed in, so the rules run under test.
 */

import {
  abortFrame,
  internalStatusBusy,
  internalStatusFrame,
  lookupFrame,
  readLookupReply,
  TIMEOUTS,
  type LookupVerdict,
} from './nayax';

export type AttemptState = 'sent' | 'unknown' | 'needs_person';

/** The attempt as kept on disk, written before the frame leaves (CardAttempt). */
export interface CardAttempt {
  vuid: string;
  /** The pending document this charge pays. */
  transactionId: string;
  /** The kiosk order it belongs to. */
  orderId: string | null;
  /** What the terminal was asked for (tip included), agorot. */
  amountAgorot: number;
  method: 'card';
  kind: 'sale';
  payments: number;
  terminalTip: boolean;
  tipAgorot: number;
  startedAt: string;
  state: AttemptState;
  note: string | null;
  supersededBy: string | null;
}

/** An attempt blocks every further card charge until it is settled (or a person took it over). */
export function blocksCard(a: Pick<CardAttempt, 'state' | 'supersededBy'>): boolean {
  return a.state !== 'needs_person' && a.supersededBy === null;
}

export function cardBlocked(attempts: ReadonlyArray<Pick<CardAttempt, 'state' | 'supersededBy'>>): boolean {
  return attempts.some(blocksCard);
}

/**
 * A frame sent and its answer (or why there is none). `notSent`: the frame certainly never left —
 * the link never opened, or nothing was written — so the terminal never saw it (never "unknown").
 * Without it, a failure may have come after the frame left (a lost reply): unknown.
 */
export type CallResult = { ok: true; body: string } | { ok: false; error: string; notSent?: true };
export type CallFn = (frame: string, timeoutMs: number) => Promise<CallResult>;

export type Settlement =
  | { kind: 'approved'; body: string; recoveredByLookup: true }
  | { kind: 'not_charged'; outcome: 'not_found' | 'declined'; message: string; body: string | null }
  | { kind: 'unknown'; message: string };

export const LOOKUP_BACKOFF_MS = [2_000, 4_000, 8_000] as const;
export const NOT_FOUND_CONFIRM_MS = 5_000;

/**
 * CardStatusResolver.resolve: what happened to [attempt] on the terminal, asking only about its
 * own vuid. Never sends a sale. `waited` counts the pauses, not the requests' time.
 */
export async function resolveAttempt(
  attempt: Pick<CardAttempt, 'vuid' | 'amountAgorot' | 'terminalTip'>,
  call: CallFn,
  sleep: (ms: number) => Promise<void>,
): Promise<Settlement> {
  let last: Settlement = { kind: 'unknown', message: 'המסוף לא ענה על בירור העסקה' };
  let waited = 0;
  let firstNotFound: number | null = null;
  let aborted = false;
  const abortOnce = async () => {
    if (aborted) return;
    aborted = true;
    await call(abortFrame(attempt.vuid), TIMEOUTS.abort).catch(() => undefined);
  };

  for (let i = 0; i <= LOOKUP_BACKOFF_MS.length; i++) {
    if (i > 0) {
      // Only once the first lookup did not settle it: a card still awaited must not go through
      // after we stopped waiting for it.
      await abortOnce();
      const pause = LOOKUP_BACKOFF_MS[i - 1];
      await sleep(pause);
      waited += pause;
    }
    const r = await call(lookupFrame(attempt.vuid), TIMEOUTS.lookup).catch((e: unknown) => ({ ok: false as const, error: String(e) }));
    const v: LookupVerdict = r.ok
      ? readLookupReply(r.body, attempt.vuid, attempt.amountAgorot, attempt.terminalTip)
      : { kind: 'unknown', message: `אין תשובה מהמסוף: ${r.error}` };
    if (v.kind === 'approved') return { kind: 'approved', body: r.ok ? r.body : '', recoveredByLookup: true };
    if (v.kind === 'declined') return { kind: 'not_charged', outcome: 'declined', message: 'העסקה נדחתה במסוף', body: r.ok ? r.body : null };
    if (v.kind === 'not_found') {
      const status = await call(internalStatusFrame(), TIMEOUTS.internalStatus).catch(() => ({ ok: false as const, error: 'x' }));
      // A status call that fails counts as "not busy" (as on the till).
      if (status.ok && internalStatusBusy(status.body)) {
        last = { kind: 'unknown', message: 'המסוף עדיין מעבד עסקה' };
        continue;
      }
      if (firstNotFound !== null && waited - firstNotFound >= NOT_FOUND_CONFIRM_MS) {
        return { kind: 'not_charged', outcome: 'not_found', message: 'העסקה לא נמצאה במסוף', body: r.ok ? r.body : null };
      }
      if (firstNotFound === null) firstNotFound = waited;
      last = { kind: 'unknown', message: 'העסקה לא נמצאה במסוף — לא אומת פעם שנייה' };
    } else {
      last = { kind: 'unknown', message: v.message };
    }
  }
  await abortOnce();
  return last;
}

/**
 * What the kiosk does with a sale's first answer (settleOwnedAnswer): approved completes,
 * certainly-not-charged voids (a new vuid may go), anything else is resolved by vuid.
 */
export type FirstAnswer = 'complete' | 'void' | 'resolve';

export function firstAnswerAction(answer: 'APPROVED' | 'DECLINED' | 'UNKNOWN'): FirstAnswer {
  return answer === 'APPROVED' ? 'complete' : answer === 'DECLINED' ? 'void' : 'resolve';
}

/**
 * May the kiosk send a sale now? Never while another frame is out, while an earlier attempt is
 * unresolved, or for less than one agora.
 */
export function maySendSale(input: { frameInFlight: boolean; attempts: ReadonlyArray<Pick<CardAttempt, 'state' | 'supersededBy'>>; amountAgorot: number }): { ok: true } | { ok: false; reason: 'in_flight' | 'unresolved' | 'amount' } {
  if (input.frameInFlight) return { ok: false, reason: 'in_flight' };
  if (cardBlocked(input.attempts)) return { ok: false, reason: 'unresolved' };
  if (!Number.isInteger(input.amountAgorot) || input.amountAgorot < 1) return { ok: false, reason: 'amount' };
  return { ok: true };
}

/**
 * The customer's "ביטול" on the pay screen: before the frame left, just drop it; after it left
 * and before it was answered, abort and wait for the sale's own reply (up to the grace); once
 * answered — never an abort (an abort after an approval changes nothing but prints "בוטלה").
 */
export type CancelAction = 'drop' | 'abort_and_wait' | 'none';

export function cancelAction(state: { sent: boolean; answered: boolean }): CancelAction {
  if (!state.sent) return 'drop';
  if (state.answered) return 'none';
  return 'abort_and_wait';
}

/** The meta written on a document voided after a lookup (lookupMeta; explicit nulls kept). */
export function lookupVoidMeta(a: Pick<CardAttempt, 'vuid' | 'amountAgorot'>, outcome: 'not_found' | 'declined' | 'marked_not_approved', message: string | null, nowIso: string): Record<string, unknown> {
  return {
    vuid: a.vuid,
    outcome,
    resolvedBy: 'getTransactionByVuid',
    requestedAmount: a.amountAgorot,
    kind: 'sale',
    message,
    supersededBy: null,
    resolvedAt: nowIso,
  };
}
