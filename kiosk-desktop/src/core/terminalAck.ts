/**
 * "ackTransaction": a Nayax terminal that wants the POS to acknowledge each approved sale
 * (pos-android hardware/payment/TerminalAck.kt — the same rules on the Windows/Web kiosk).
 *
 * With the mechanism on, Agamento answers an approved sale (tranCode 1, result 0) with
 * `"ackTransaction": true`, shows "ממתין לקופה" and starts a 10-second timer; with no
 * acknowledgement by then it cancels the sale itself ("העסקה בוטלה") — what reversed the Android
 * kiosk's ₪1 sales on 07.10.2026. So:
 *
 *  - the acknowledgement goes at once, before anything is written: `ackTransaction` with the
 *    sale's vuid; statusCode 0 means the terminal took it — the sale is final;
 *  - not taken (or no answer): the terminal decides within its ten seconds — they are waited out,
 *    and the sale is asked about by its vuid: approved completes (the owner, 08.10.2026: a lookup
 *    that says approved is final), cancelled is not charged, anything else stays unknown.
 *
 * Pure: the transport and the clock are passed in.
 */

import { resolveAttempt, type CallFn } from './cardRecovery';
import { frame } from './nayax';

/** How long Agamento waits for the acknowledgement before it cancels the sale itself. */
export const TERMINAL_ACK_WINDOW_MS = 10_000;

/** How long the acknowledgement's own reply is awaited: well inside the window. */
export const ACK_REPLY_TIMEOUT_MS = 6_000;

/** After the window, before the lookup: the terminal's cancel has landed by then. */
export const ACK_SETTLE_MARGIN_MS = 3_000;

export const ACK_TRANSACTION_KEY = 'ackTransaction';

export const ackFrame = (vuid: string) => frame('ackTransaction', { vuid });

/** Whether a reply's `result` asks the POS to acknowledge the transaction. Never throws. */
export function ackRequestedBy(result: Record<string, unknown> | null | undefined): boolean {
  const v = result?.[ACK_TRANSACTION_KEY];
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.trim().toLowerCase() === 'true';
  if (typeof v === 'number') return Math.trunc(v) !== 0;
  return false;
}

/** Whether the terminal took the acknowledgement: a reply whose `statusCode` is 0. Never throws. */
export function ackAccepted(body: string | null | undefined): boolean {
  if (!body) return false;
  try {
    const o = JSON.parse(body) as Record<string, unknown>;
    if (o.error !== undefined && o.error !== null) return false;
    const r = o.result as Record<string, unknown> | undefined;
    if (!r || typeof r !== 'object') return false;
    const c = r.statusCode;
    return c === 0 || c === '0';
  } catch {
    return false;
  }
}

export type AckOutcome =
  /** No acknowledgement asked, or the terminal took it: the sale's own approval stands. */
  | { kind: 'final' }
  /** Not taken; asked after the window, and the terminal says approved: charged. */
  | { kind: 'approved'; body: string }
  /** Not taken; the terminal cancelled it (or holds no such sale): not charged. */
  | { kind: 'not_charged'; message: string }
  /** Not taken, and the terminal could not say: unknown, asked about again like any lost answer. */
  | { kind: 'unknown'; message: string };

/**
 * An approved sale's [result] for [vuid]: acknowledged at once when it asks for it; otherwise
 * nothing. Never sends a sale, a refund or a void.
 */
export async function acknowledgeApproval(
  input: { vuid: string; amountAgorot: number; result: Record<string, unknown> | null | undefined },
  call: CallFn,
  sleep: (ms: number) => Promise<void>,
): Promise<AckOutcome> {
  if (!ackRequestedBy(input.result)) return { kind: 'final' };
  const r = await call(ackFrame(input.vuid), ACK_REPLY_TIMEOUT_MS).catch((e: unknown) => ({ ok: false as const, error: String(e) }));
  if (r.ok && ackAccepted(r.body)) return { kind: 'final' };
  // Not taken: the terminal decides within its ten seconds — waited out, then asked by the vuid.
  await sleep(TERMINAL_ACK_WINDOW_MS + ACK_SETTLE_MARGIN_MS);
  const s = await resolveAttempt({ vuid: input.vuid, amountAgorot: input.amountAgorot, terminalTip: false }, call, sleep);
  if (s.kind === 'approved') return { kind: 'approved', body: s.body };
  if (s.kind === 'not_charged') return { kind: 'not_charged', message: 'העסקה בוטלה במסוף (לא אושרה מהקופה בזמן)' };
  return { kind: 'unknown', message: s.message };
}
