/**
 * A card terminal the kiosk charges on. The kiosk's payment rules (docs/SPEC_CARD_RECOVERY.md,
 * SPEC_KIOSK.md §13.6) are the same for every terminal and live in payService.ts; a provider
 * only speaks its terminal's protocol:
 *
 *  - `newReference` names a charge (Nayax: the vuid) — the kiosk writes the attempt to disk with
 *    it BEFORE `sale` is called;
 *  - `sale` sends ONE charge and says approved / certainly not charged / unknown — it never
 *    retries (a re-sent sale may charge twice);
 *  - `resolve` asks the terminal what became of a charge by its reference — it never charges;
 *  - `abort` stops a charge before the card is presented (never after an answer);
 *  - `check` is a cheap "are you there" with no card.
 *
 * Providers: `nayax_lan` (nayaxProvider.ts, TweezerComm over HTTP to the pinpad); SynqPay is
 * plugged in the same way (payment/synqpay/).
 */

import type { CardBrand } from '../../core/nayax';

export type ProviderKind = 'nayax_lan' | 'synqpay' | (string & {});

export interface SaleRequest {
  amountAgorot: number;
  reference: string;
  payments: number;
  /** The terminal's progress, for the pay screen's status line. */
  onProgress?: (message: string) => void;
}

/** What the document's card leg and the receipt need of an approval. */
export interface ApprovedCard {
  brand: CardBrand;
  last4: string | null;
  authNum: string | null;
  uid: string | null;
  payments: number | null;
  firstPaymentAgorot: number | null;
  /** The amount the terminal says it charged (agorot), when it says. */
  chargedAgorot: number | null;
  /** The document's `nayaxMeta` (the card meta as the till writes it; flattened to strings on the wire). */
  meta: Record<string, unknown>;
}

export type SaleResult =
  | { answer: 'APPROVED'; card: ApprovedCard; raw: string }
  | { answer: 'DECLINED'; message: string; raw: string | null; statusCode: number | null }
  | { answer: 'UNKNOWN'; message: string; raw: string | null };

export type Resolution =
  | { kind: 'approved'; card: ApprovedCard }
  | { kind: 'not_charged'; outcome: 'not_found' | 'declined'; message: string }
  | { kind: 'unknown'; message: string };

export interface CheckResult {
  ok: boolean;
  detail: string | null;
}

export interface TransmitResult {
  outcome: 'success' | 'failed' | 'busy' | 'unknown' | 'skipped';
  batchNumber: string | null;
  statusCode: number | null;
  statusMessage: string | null;
  error: string | null;
  transactionCount: number | null;
  amountAgorot: number | null;
  raw: string | null;
}

export interface PaymentProvider {
  readonly kind: ProviderKind;
  /** The address or account shown to staff (never a secret). */
  describe(): { kind: ProviderKind; address: string | null };
  newReference(): string;
  check(timeoutMs?: number): Promise<CheckResult>;
  sale(req: SaleRequest): Promise<SaleResult>;
  resolve(attempt: { reference: string; amountAgorot: number; terminalTip: boolean }): Promise<Resolution>;
  abort(reference: string): Promise<void>;
  /** The day's batch to the acquirer (Nayax doPeriodic), when the terminal has one. */
  transmit?(): Promise<TransmitResult>;
}

/** A provider factory, by the cloud settings: null when this kind is not configured here. */
export type ProviderFactory = (settings: Record<string, unknown>, ctx: ProviderContext) => PaymentProvider | null;

export interface ProviderContext {
  machineId: string | null;
  /** A durable counter for references (Nayax vuid sequence). */
  nextSequence(name: string): number;
  /** Small durable storage (e.g. a pinned certificate). */
  getValue(key: string): string | null;
  setValue(key: string, value: string): void;
  /** Till parameters (`pinpadAllowHttp`…). */
  parameter(key: string): unknown;
  log(msg: string): void;
}
